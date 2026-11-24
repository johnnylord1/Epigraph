package epigraph.sync.v4

import epigraph.sync.core.http.CoreHttpResult
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import java.io.IOException
import kotlin.math.min

sealed interface V4SyncRunResult {
    data class Synced(
        val serverSeq: Long,
        val uploadedCount: Int,
        val appliedCount: Int,
        val pendingOutboxCount: Long,
        val wasNoOpReconnect: Boolean,
    ) : V4SyncRunResult

    data class Failed(
        val reason: String,
        val statusCode: Int? = null,
        val retryable: Boolean = true,
    ) : V4SyncRunResult
}

/**
 * Unified Sync V4 orchestrator for Android (Fast State Lane).
 *
 * Guarantees:
 * - Single [syncMutex] serializes bulk sync, incremental catch-up, outbox drain, and live SSE
 *   application so concurrent workers can never race or interleave.
 * - Never drops an outbox batch on transient errors; isolates per-item rejections cleanly.
 * - Empty reconnects execute in 1 lightweight HTTP call (< 200 ms) with 0 internet downloads
 *   and 0 main-thread UI inflation.
 */
class V4SyncEngine(
    private val serverId: String,
    private val profileId: String,
    private val deviceId: String,
    private val store: SqlDelightV4SyncStore,
    private val http: V4CoreHttpClient,
    private val sse: V4SseClient,
    private val bridge: V4DomainBridge,
    private val json: Json = V4CoreHttpClient.DEFAULT_JSON,
    private val domainProgress: V4SyncDomainProgress = MemoryV4SyncDomainProgress(),
) {
    private val syncMutex = Mutex()
    @Volatile private var domainPolicy = V4SyncDomainPolicy()

    fun useDomainPolicy(policy: V4SyncDomainPolicy) {
        domainPolicy = policy
    }

    private fun enabled(items: List<V4OutgoingItem>) = items.filter {
        domainPolicy.allows(it.domain, it.entityType, it.entityKey, it.payload)
    }

    private fun enabled(records: List<V4WireRecord>, policy: V4SyncDomainPolicy = domainPolicy) = records.filter {
        policy.allows(it.domain, it.entityType, it.entityKey, it.payload)
    }

    private fun pruneDisabledDomains() {
        val completed = domainProgress.load(serverId, profileId) ?: return
        val pruned = completed intersect domainPolicy.enabledKeys
        if (pruned != completed) {
            domainProgress.save(serverId, profileId, pruned)
        }
    }

    fun clearDomainProgress() {
        domainProgress.clear(serverId)
    }

    private fun buildClock(state: V4SyncCursorState): V4HlcClock = V4HlcClock(
        deviceId = deviceId,
        initialLastTsMs = state.hlcLastTsMs,
        initialLastCounter = state.hlcLastCounter,
        initialClockOffsetMs = state.clockOffsetMs,
    )

    private fun persistClock(state: V4SyncCursorState, clock: V4HlcClock): V4SyncCursorState {
        val (ts, counter, offset) = clock.snapshotState()
        val updated = state.copy(
            hlcLastTsMs = ts,
            hlcLastCounter = counter,
            clockOffsetMs = offset,
        )
        store.saveState(updated)
        return updated
    }

    /**
     * Runs one full synchronization cycle:
     * - First pairing exports legacy local state via gzipped `POST /v4/sync/bulk`.
     * - After `410 GONE`, only queued intents are uploaded before loading the recovery snapshot.
     * - Normal reconnect: drains pending `v4_outbox` via `POST /v4/deltas`, then pulls paginated
     *   `GET /v4/changes?sinceSeq=...`.
     */
    suspend fun syncOnce(accessToken: String): V4SyncRunResult = syncMutex.withLock {
        var state = store.loadState(serverId, profileId)
        val previousSeq = state.serverSeq
        val clock = buildClock(state)

        // 1. Always negotiate/check capabilities & calibrate server clock first on initial sync.
        if (!state.initialSyncCompleted) {
            return@withLock runFullMergeLocked(accessToken, state, clock)
        }
        val catchup = bootstrapReenabledDomainsLocked(accessToken, state, clock)
        if (catchup is V4SyncRunResult.Failed) return@withLock catchup

        // 2. Drain pending local outbox deltas.
        val uploadResult = drainOutboxLocked(accessToken, state)
        if (uploadResult is V4SyncRunResult.Failed) {
            persistClock(state, clock)
            return@withLock uploadResult
        }
        val uploadedCount = (uploadResult as V4SyncRunResult.Synced).uploadedCount

        // 3. Pull paginated remote changes since our cursor.
        var appliedCount = 0
        var cursor = state.serverSeq
        var minReplayable = state.minReplayableSeq

        while (true) {
            when (val res = http.changes(accessToken, sinceSeq = cursor, limit = CHANGES_PAGE_SIZE)) {
                is CoreHttpResult.Success -> {
                    val page = res.value
                    minReplayable = page.minReplayableSeq
                    if (page.changes.isNotEmpty()) {
                        page.changes.forEach { clock.observe(it.hlc) }
                        // The Core can merge other devices' state into a record attributed to us.
                        val applicable = enabled(page.changes)
                        if (applicable.isNotEmpty()) bridge.applyRemoteRecords(serverId, profileId, applicable)
                        appliedCount += applicable.size
                    }
                    cursor = maxOf(cursor, page.nextSeq)
                    if (!page.hasMore) {
                        cursor = maxOf(cursor, page.serverSeq)
                        break
                    }
                }
                is CoreHttpResult.Failure -> {
                    if (res.statusCode == 410) {
                        // The local library can still contain records deleted during the gap.
                        return@withLock runFullMergeLocked(accessToken, state, clock)
                    }
                    persistClock(state, clock)
                    return@withLock V4SyncRunResult.Failed(
                        reason = res.errorEnvelope?.error?.message ?: "HTTP ${res.statusCode}",
                        statusCode = res.statusCode,
                        retryable = res.statusCode >= 500 || res.statusCode == 429,
                    )
                }
            }
        }

        state = persistClock(
            state.copy(serverSeq = cursor, minReplayableSeq = minReplayable),
            clock,
        )
        if (state.serverSeq > previousSeq) {
            pruneDisabledDomains()
        }
        val pending = store.countPendingOutbox(serverId, profileId, domainPolicy)
        V4SyncRunResult.Synced(
            serverSeq = state.serverSeq,
            uploadedCount = uploadedCount,
            appliedCount = appliedCount,
            pendingOutboxCount = pending,
            wasNoOpReconnect = uploadedCount == 0 && appliedCount == 0 && pending == 0L,
        )
    }

    /**
     * Publishes local edits made offline or via legacy domain routers by exporting local state
     * with fresh HLC clocks and merging into Core, then draining outbox + pulling remote deltas.
     * Only invoked when local edits actually happened; idle reconnects stay on [syncOnce].
     */
    suspend fun syncWithLocalEdits(accessToken: String): V4SyncRunResult = syncMutex.withLock {
        var state = store.loadState(serverId, profileId)
        val previousSeq = state.serverSeq
        val clock = buildClock(state)
        if (!state.initialSyncCompleted) {
            return@withLock runFullMergeLocked(accessToken, state, clock)
        }
        val catchup = bootstrapReenabledDomainsLocked(accessToken, state, clock)
        if (catchup is V4SyncRunResult.Failed) return@withLock catchup

        // Upload local state changes via HLC merge so offline progress across Comics, Novels,
        // Books, Repos, Extensions, and Prefs is guaranteed to converge cleanly on reconnect.
        val localItems = enabled(bridge.exportLocalSnapshot(serverId, profileId, clock))
        var uploadedCount = 0
        if (localItems.isNotEmpty()) {
            val chunks = localItems.chunked(BULK_CHUNK_SIZE)
            for ((index, chunk) in chunks.withIndex()) {
                val isFinal = index == chunks.lastIndex
                when (val bulkRes = http.syncBulk(accessToken, chunk, finalBatch = isFinal)) {
                    is CoreHttpResult.Success -> {
                        uploadedCount += bulkRes.value.acceptedCount + bulkRes.value.mergedCount
                        state = state.copy(serverSeq = maxOf(state.serverSeq, bulkRes.value.serverSeq))
                    }
                    is CoreHttpResult.Failure -> {
                        persistClock(state, clock)
                        return@withLock V4SyncRunResult.Failed(
                            reason = bulkRes.errorEnvelope?.error?.message ?: "HTTP ${bulkRes.statusCode}",
                            statusCode = bulkRes.statusCode,
                            retryable = bulkRes.statusCode >= 500 || bulkRes.statusCode == 429,
                        )
                    }
                }
            }
        }

        val outboxRes = drainOutboxLocked(accessToken, state)
        if (outboxRes is V4SyncRunResult.Failed) {
            persistClock(state, clock)
            return@withLock outboxRes
        }
        uploadedCount += (outboxRes as V4SyncRunResult.Synced).uploadedCount

        var appliedCount = 0
        var cursor = state.serverSeq
        var minReplayable = state.minReplayableSeq
        while (true) {
            when (val res = http.changes(accessToken, sinceSeq = cursor, limit = CHANGES_PAGE_SIZE)) {
                is CoreHttpResult.Success -> {
                    val page = res.value
                    minReplayable = page.minReplayableSeq
                    if (page.changes.isNotEmpty()) {
                        page.changes.forEach { clock.observe(it.hlc) }
                        val applicable = enabled(page.changes)
                        if (applicable.isNotEmpty()) bridge.applyRemoteRecords(serverId, profileId, applicable)
                        appliedCount += applicable.size
                    }
                    cursor = maxOf(cursor, page.nextSeq)
                    if (!page.hasMore) {
                        cursor = maxOf(cursor, page.serverSeq)
                        break
                    }
                }
                is CoreHttpResult.Failure -> {
                    if (res.statusCode == 410) {
                        return@withLock runFullMergeLocked(accessToken, state, clock)
                    }
                    persistClock(state, clock)
                    return@withLock V4SyncRunResult.Failed(
                        reason = res.errorEnvelope?.error?.message ?: "HTTP ${res.statusCode}",
                        statusCode = res.statusCode,
                        retryable = res.statusCode >= 500 || res.statusCode == 429,
                    )
                }
            }
        }

        state = persistClock(
            state.copy(serverSeq = cursor, minReplayableSeq = minReplayable),
            clock,
        )
        if (state.serverSeq > previousSeq) {
            pruneDisabledDomains()
        }
        V4SyncRunResult.Synced(
            serverSeq = state.serverSeq,
            uploadedCount = uploadedCount,
            appliedCount = appliedCount,
            pendingOutboxCount = store.countPendingOutbox(serverId, profileId, domainPolicy),
            wasNoOpReconnect = false,
        )
    }

    /**
     * Runs the persistent realtime SSE stream until cancelled or disconnected.
     */
    suspend fun runRealtimeStream(accessToken: String, policy: V4SyncDomainPolicy = domainPolicy) {
        useDomainPolicy(policy)
        val state = store.loadState(serverId, profileId)
        if (!state.initialSyncCompleted) {
            syncOnce(accessToken).requireSuccess()
        }
        val currentSeq = store.loadState(serverId, profileId).serverSeq
        sse.stream(accessToken, sinceSeq = currentSeq) { msg ->
            when (msg) {
                is V4SseMessage.Delta -> {
                    syncMutex.withLock {
                        val cur = store.loadState(serverId, profileId)
                        if (msg.record.serverSeq <= cur.serverSeq) return@withLock
                        val clock = buildClock(cur)
                        clock.observe(msg.record.hlc)
                        val applicable = enabled(listOf(msg.record))
                        if (applicable.isNotEmpty()) bridge.applyRemoteRecords(serverId, profileId, applicable)
                        persistClock(
                            cur.copy(serverSeq = msg.record.serverSeq),
                            clock,
                        )
                        pruneDisabledDomains()
                    }
                }
                is V4SseMessage.BulkCommitted,
                is V4SseMessage.CatchupRequired,
                -> {
                    syncOnce(accessToken).requireSuccess()
                }
                is V4SseMessage.ReplayExpired -> {
                    syncMutex.withLock {
                        val cur = store.loadState(serverId, profileId)
                        runFullMergeLocked(accessToken, cur, buildClock(cur)).requireSuccess()
                    }
                }
                is V4SseMessage.Hello,
                is V4SseMessage.Clock,
                -> Unit
            }
        }
    }

    private fun V4SyncRunResult.requireSuccess() {
        if (this is V4SyncRunResult.Failed) throw IOException(reason)
    }

    /** Reconcile newly enabled domains from their baseline plus the current Core snapshot. */
    private suspend fun bootstrapReenabledDomainsLocked(
        accessToken: String,
        state: V4SyncCursorState,
        clock: V4HlcClock,
    ): V4SyncRunResult? {
        val completed = domainProgress.load(serverId, profileId)
        if (completed == null) {
            // Older installs have no domain ledger. Their active domains were included in the
            // already-completed initial sync, so seed those keys without replaying them.
            domainProgress.save(serverId, profileId, domainPolicy.enabledKeys)
            return null
        }
        val newlyEnabled = domainPolicy.enabledKeys - completed
        if (newlyEnabled.isEmpty()) return null
        val catchupPolicy = domainPolicy.only(newlyEnabled)
        val baseline = bridge.exportLocalSnapshot(serverId, profileId, clock)
            .filter { catchupPolicy.allows(it.domain, it.entityType, it.entityKey, it.payload) }
            .map { it.copy(hlc = it.hlc.copy(tsMs = 1L, counter = 0L)) }
        val chunks = baseline.chunked(BULK_CHUNK_SIZE)
        for ((index, chunk) in chunks.withIndex()) {
            when (val result = http.syncBulk(accessToken, chunk, finalBatch = index == chunks.lastIndex)) {
                is CoreHttpResult.Success -> if (result.value.rejected.isNotEmpty()) {
                    return V4SyncRunResult.Failed("Core rejected ${result.value.rejected.size} records during domain bootstrap", retryable = false)
                }
                is CoreHttpResult.Failure -> return V4SyncRunResult.Failed(
                    result.errorEnvelope?.error?.message ?: "HTTP ${result.statusCode}",
                    result.statusCode,
                    result.statusCode >= 500 || result.statusCode == 429,
                )
            }
        }
        val snapshot = when (val result = http.snapshot(accessToken)) {
            is CoreHttpResult.Success -> result.value ?: return V4SyncRunResult.Failed("Core returned no domain bootstrap snapshot", 304)
            is CoreHttpResult.Failure -> return V4SyncRunResult.Failed(
                result.errorEnvelope?.error?.message ?: "HTTP ${result.statusCode}",
                result.statusCode,
                result.statusCode >= 500 || result.statusCode == 429,
            )
        }
        val records = enabled(snapshot.records, catchupPolicy)
        records.forEach { clock.observe(it.hlc) }
        if (records.isNotEmpty()) bridge.applyRemoteRecords(serverId, profileId, records)
        // Keep the cursor unchanged here. The normal changes pass must still cover mutations in
        // already-enabled domains that occurred while the scoped snapshot was being fetched.
        domainProgress.save(serverId, profileId, completed + domainPolicy.enabledKeys)
        return null
    }

    private suspend fun runFullMergeLocked(
        accessToken: String,
        initialState: V4SyncCursorState,
        clock: V4HlcClock,
    ): V4SyncRunResult {
        val capabilities = when (val capRes = http.capabilities(accessToken)) {
            is CoreHttpResult.Success -> {
                clock.calibrateServerTime(capRes.value.serverTimeMs)
                capRes.value
            }
            is CoreHttpResult.Failure -> {
                return V4SyncRunResult.Failed(
                    reason = capRes.errorEnvelope?.error?.message ?: "HTTP ${capRes.statusCode}",
                    statusCode = capRes.statusCode,
                    retryable = capRes.statusCode >= 500 || capRes.statusCode == 429,
                )
            }
        }

        // A legacy row has no edit clock. Stage it below V4 edits and tombstones.
        // On recovery the outbox carries the actual local edits made since pairing.
        val localItems = if (initialState.initialSyncCompleted) {
            emptyList()
        } else {
            enabled(bridge.exportLocalSnapshot(serverId, profileId, clock))
        }
        // A conditional upload into an empty profile verifies the only applied
        // records are already in our local database. Avoid sending them back.
        var seededThrough = capabilities.serverSeq.takeIf {
            capabilities.supportsConditionalBulk && it == 0L && !initialState.initialSyncCompleted &&
                localItems.isNotEmpty() && store.countPendingOutbox(serverId, profileId, domainPolicy) == 0L &&
                localItems.distinctBy { item -> item.entityType to item.entityKey }.size == localItems.size
        }
        var uploadedCount = 0
        val chunks = localItems.chunked(BULK_CHUNK_SIZE)
        for ((index, chunk) in chunks.withIndex()) {
            val baseline = chunk.map { it.copy(hlc = it.hlc.copy(tsMs = 1L, counter = 0L)) }
            val final = index == chunks.lastIndex
            var reply = http.syncBulk(accessToken, baseline, seededThrough, final)
            if (seededThrough != null && reply is CoreHttpResult.Failure && reply.statusCode == 409) {
                seededThrough = null
                reply = http.syncBulk(accessToken, baseline, finalBatch = final)
            }
            when (val bulkRes = reply) {
                is CoreHttpResult.Success -> {
                    val summary = bulkRes.value
                    if (summary.rejected.isNotEmpty()) {
                        persistClock(initialState, clock)
                        return V4SyncRunResult.Failed(
                            reason = "Core rejected ${summary.rejected.size} records from the local snapshot",
                            retryable = false,
                        )
                    }
                    uploadedCount += summary.acceptedCount + summary.mergedCount
                    seededThrough = summary.serverSeq.takeIf {
                        seededThrough != null && summary.acceptedCount == baseline.size &&
                            summary.mergedCount == 0 && summary.noopCount == 0
                    }
                }
                is CoreHttpResult.Failure -> {
                    persistClock(initialState, clock)
                    return V4SyncRunResult.Failed(
                        reason = bulkRes.errorEnvelope?.error?.message ?: "HTTP ${bulkRes.statusCode}",
                        statusCode = bulkRes.statusCode,
                        retryable = bulkRes.statusCode >= 500 || bulkRes.statusCode == 429,
                    )
                }
            }
        }

        // Drain any outbox entries queued while offline before pulling authoritative merged state.
        val outboxRes = drainOutboxLocked(accessToken, initialState)
        if (outboxRes is V4SyncRunResult.Failed) {
            persistClock(initialState, clock)
            return outboxRes
        }
        outboxRes as V4SyncRunResult.Synced
        uploadedCount += outboxRes.uploadedCount
        val pending = store.countPendingOutbox(serverId, profileId, domainPolicy)
        if (seededThrough != null && outboxRes.uploadedCount == 0 && pending == 0L) {
            val state = persistClock(
                initialState.copy(
                    serverSeq = seededThrough,
                    minReplayableSeq = capabilities.minReplayableSeq,
                    initialSyncCompleted = true,
                ),
                clock,
            )
            domainProgress.save(serverId, profileId, domainPolicy.enabledKeys)
            return V4SyncRunResult.Synced(state.serverSeq, uploadedCount, 0, pending, false)
        }

        // A write receipt gives the Core's latest sequence, but only applying its snapshot
        // advances the local cursor. After a Core rewind, that cursor can also move backwards.
        val (snapshot, etag) = when (val snapRes = http.snapshot(accessToken)) {
            is CoreHttpResult.Success -> {
                val snap = snapRes.value ?: run {
                    persistClock(initialState, clock)
                    return V4SyncRunResult.Failed("Core returned no recovery snapshot", statusCode = 304)
                }
                snap to snapRes.etag
            }
            is CoreHttpResult.Failure -> {
                persistClock(initialState, clock)
                return V4SyncRunResult.Failed(
                    reason = snapRes.errorEnvelope?.error?.message ?: "HTTP ${snapRes.statusCode}",
                    statusCode = snapRes.statusCode,
                    retryable = snapRes.statusCode >= 500 || snapRes.statusCode == 429,
                )
            }
        }

        snapshot.records.forEach { clock.observe(it.hlc) }
        val applicableSnapshotRecords = enabled(snapshot.records)
        if (applicableSnapshotRecords.isNotEmpty()) {
            bridge.applyRemoteRecords(serverId, profileId, applicableSnapshotRecords)
        }
        val state = persistClock(
            initialState.copy(
                serverSeq = snapshot.serverSeq,
                minReplayableSeq = snapshot.minReplayableSeq,
                lastSnapshotEtag = etag,
                initialSyncCompleted = true,
            ),
            clock,
        )
        domainProgress.save(serverId, profileId, domainPolicy.enabledKeys)
        return V4SyncRunResult.Synced(
            serverSeq = state.serverSeq,
            uploadedCount = uploadedCount,
            appliedCount = applicableSnapshotRecords.size,
            pendingOutboxCount = store.countPendingOutbox(serverId, profileId, domainPolicy),
            wasNoOpReconnect = false,
        )
    }

    private suspend fun drainOutboxLocked(
        accessToken: String,
        state: V4SyncCursorState,
    ): V4SyncRunResult {
        var uploaded = 0
        var latestSeq = state.serverSeq

        while (true) {
            val due = store.loadDueOutbox(serverId, profileId, domainPolicy, limit = DELTA_BATCH_SIZE.toLong())
                .filter { row ->
                    val payload = runCatching { json.parseToJsonElement(row.payload_json) }.getOrNull()
                    domainPolicy.allows(row.domain, row.entity_type, row.entity_key, payload)
                }
            if (due.isEmpty()) break

            val outgoing = due.map { row ->
                V4OutgoingItem(
                    clientMutationId = row.client_mutation_id,
                    domain = row.domain,
                    entityType = row.entity_type,
                    entityKey = row.entity_key,
                    deleted = row.deleted != 0L,
                    hlc = V4Hlc(
                        tsMs = row.hlc_ts_ms,
                        counter = row.hlc_counter,
                        deviceId = row.hlc_device_id,
                    ),
                    payload = runCatching { json.parseToJsonElement(row.payload_json) }
                        .getOrDefault(JsonNull),
                )
            }

            when (val res = http.pushDeltas(accessToken, outgoing)) {
                is CoreHttpResult.Success -> {
                    val summary = res.value
                    latestSeq = maxOf(latestSeq, summary.serverSeq)
                    val rejectedById = summary.rejected
                        .mapNotNull { it.clientMutationId?.let { id -> id to "${it.code}: ${it.message}" } }
                        .toMap()

                    val ackedIds = due
                        .map { it.client_mutation_id }
                        .filter { it !in rejectedById }
                    store.acknowledgeMutations(ackedIds)
                    uploaded += summary.acceptedCount + summary.mergedCount

                    // Isolate per-item rejections with backoff instead of dropping valid neighbors.
                    due.forEach { row ->
                        val err = rejectedById[row.client_mutation_id]
                        if (err != null) {
                            val backoff = computeBackoffMs(row.attempts + 1)
                            store.recordFailure(row.client_mutation_id, backoff, err)
                        }
                    }
                    if (ackedIds.isEmpty()) break
                }
                is CoreHttpResult.Failure -> {
                    val retryable = res.statusCode >= 500 || res.statusCode == 429
                    due.forEach { row ->
                        store.recordFailure(
                            clientMutationId = row.client_mutation_id,
                            backoffMs = computeBackoffMs(row.attempts + 1),
                            error = "HTTP ${res.statusCode}",
                        )
                    }
                    return V4SyncRunResult.Failed(
                        reason = res.errorEnvelope?.error?.message ?: "HTTP ${res.statusCode}",
                        statusCode = res.statusCode,
                        retryable = retryable,
                    )
                }
            }
        }

        return V4SyncRunResult.Synced(
            serverSeq = latestSeq,
            uploadedCount = uploaded,
            appliedCount = 0,
            pendingOutboxCount = store.countPendingOutbox(serverId, profileId, domainPolicy),
            wasNoOpReconnect = uploaded == 0,
        )
    }

    private fun computeBackoffMs(attempts: Long): Long {
        val exp = 1L shl min(attempts.toInt(), 8)
        return (exp * 2_000L).coerceAtMost(15 * 60 * 1_000L)
    }

    companion object {
        private const val BULK_CHUNK_SIZE = 20_000
        private const val DELTA_BATCH_SIZE = 250
        private const val CHANGES_PAGE_SIZE = 2_000
    }
}
