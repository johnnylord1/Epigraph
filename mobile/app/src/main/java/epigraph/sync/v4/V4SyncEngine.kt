package epigraph.sync.v4

import co.touchlab.kermit.Logger
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreErrorEnvelope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
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

/** Outcome of gathering a snapshot, possibly across several pages. */
private sealed interface SnapshotGather {
    /** [head] is the first page: its `serverSeq` and `minReplayableSeq` are the watermark. */
    class Gathered(
        val head: V4SnapshotResponse,
        val records: List<V4WireRecord>,
        val etag: String?,
    ) : SnapshotGather

    class Failed(val failure: V4SyncRunResult.Failed) : SnapshotGather
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
internal class V4SyncEngine(
    private val serverId: String,
    private val profileId: String,
    private val deviceId: String,
    private val store: SqlDelightV4SyncStore,
    private val http: V4CoreHttpClient,
    private val sse: V4SseClient,
    private val bridge: V4DomainBridge,
    private val json: Json = V4CoreHttpClient.DEFAULT_JSON,
    private val domainProgress: V4SyncDomainProgress = MemoryV4SyncDomainProgress(),
    /** Monotonic counter bumped by each local edit; a baseline update skips its write if this changes mid-apply. */
    private val localEditGeneration: () -> Long = { 0L },
) {
    private val logger = Logger.withTag("EpigraphSyncV4")
    private val syncMutex = Mutex()

    private fun msSince(startNs: Long): Long = (System.nanoTime() - startNs) / 1_000_000L
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
        if (invalidated.get()) return state
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
    private val invalidated = AtomicBoolean(false)

    /** Marks this engine as stale so it will not write state or outbox updates after handover/cleanup. */
    fun invalidate() {
        invalidated.set(true)
    }

    /**
     * Invalidates this engine and waits for any pass already holding [syncMutex] to finish, so no
     * write of the stale pass can land after the caller moves or clears its rows.
     */
    suspend fun invalidateAndAwaitIdle() {
        invalidated.set(true)
        syncMutex.withLock { }
    }

    suspend fun syncOnce(accessToken: String): V4SyncRunResult = syncMutex.withLock {
        if (invalidated.get()) {
            return@withLock V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
        }
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
                        if (applicable.isNotEmpty()) applyRemoteRecordsWithBaseline(applicable)
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

        if (invalidated.get()) {
            return@withLock V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
        }
        state = persistClock(
            state.copy(serverSeq = cursor, minReplayableSeq = minReplayable),
            clock,
        )
        if (state.serverSeq > previousSeq) {
            pruneDisabledDomains()
        }
        // A full baseline scan is only needed when none exists yet. Applies keep it current after that.
        if (!store.hasDigests(serverId, profileId)) refreshBaselineLocked(0L)
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
        if (invalidated.get()) {
            return@withLock V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
        }
        var state = store.loadState(serverId, profileId)
        val previousSeq = state.serverSeq
        val clock = buildClock(state)
        if (!state.initialSyncCompleted) {
            return@withLock runFullMergeLocked(accessToken, state, clock)
        }
        val catchup = bootstrapReenabledDomainsLocked(accessToken, state, clock)
        if (catchup is V4SyncRunResult.Failed) return@withLock catchup

        // Upload only items whose digest differs from the recorded baseline, so offline progress
        // across all domains converges without re-sending unchanged state with fresh clocks.
        var mark = System.nanoTime()
        val stored = store.loadDigests(serverId, profileId)
        val loadMs = msSince(mark)
        mark = System.nanoTime()
        // One library build yields both the digests and the stamped export.
        val pass = bridge.exportAndDigest(serverId, profileId, clock)
        val current = pass.digests
            .filter { domainPolicy.allows(it.key.domain, it.key.entityType, it.key.entityKey, null) }
        val exported = enabled(pass.outgoing)
            .associateBy { V4DigestKey(it.domain, it.entityType, it.entityKey) }
        val exportMs = msSince(mark)
        val vanished = vanishedKeys(stored, current)
        // Comic relation retractions already enqueue and mark their tombstones during export.
        val tombstones = vanished.filter { !store.isEntityMapTombstoned(serverId, profileId, it) }
        // Without any recorded digests, existing remote state must not be outranked: use the baseline clock.
        val baselineMode = stored.isEmpty()
        val outgoing = buildList {
            for (item in current) {
                if (stored[item.key]?.digest == item.digest) continue
                val stamped = exported[item.key] ?: continue
                add(if (baselineMode) stamped.copy(hlc = stamped.hlc.copy(tsMs = 1L, counter = 0L)) else stamped)
            }
            for (key in tombstones) {
                add(
                    V4OutgoingItem(
                        domain = key.domain,
                        entityType = key.entityType,
                        entityKey = key.entityKey,
                        deleted = true,
                        hlc = if (baselineMode) V4Hlc(tsMs = 1L, counter = 0L, deviceId = deviceId) else clock.next(),
                    ),
                )
            }
        }
        mark = System.nanoTime()
        var uploadedCount = 0
        val chunks = outgoing.chunked(BULK_CHUNK_SIZE)
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
        val uploadMs = msSince(mark)
        mark = System.nanoTime()
        // Digests advance only after every chunk is accepted; a failed pass re-uploads its changes.
        store.saveDigests(serverId, profileId, nextDigestRows(stored, current, vanished))
        val saveMs = msSince(mark)
        mark = System.nanoTime()

        val outboxRes = drainOutboxLocked(accessToken, state)
        if (outboxRes is V4SyncRunResult.Failed) {
            persistClock(state, clock)
            return@withLock outboxRes
        }
        uploadedCount += (outboxRes as V4SyncRunResult.Synced).uploadedCount
        val drainMs = msSince(mark)
        mark = System.nanoTime()

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
                        if (applicable.isNotEmpty()) applyRemoteRecordsWithBaseline(applicable)
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

        if (invalidated.get()) {
            return@withLock V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
        }
        state = persistClock(
            state.copy(serverSeq = cursor, minReplayableSeq = minReplayable),
            clock,
        )
        if (state.serverSeq > previousSeq) {
            pruneDisabledDomains()
        }
        // No full baseline scan here: the digests above plus the per-apply updates already cover this pass.
        val pullMs = msSince(mark)
        logger.i {
            "local-edit pass: load ${loadMs} ms, digest+export ${exportMs} ms, upload ${uploadMs} ms, " +
                "saveDigests ${saveMs} ms, drain ${drainMs} ms, changes pull ${pullMs} ms; " +
                "uploaded $uploadedCount, outgoing ${outgoing.size}, applied $appliedCount"
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
     * Rebuilds the digest baseline from the current local state, but only while no local edit has
     * happened since [expectedGeneration], both before and after the digests are built.
     */
    suspend fun refreshBaseline(expectedGeneration: Long) {
        syncMutex.withLock { refreshBaselineLocked(expectedGeneration) }
    }

    private suspend fun refreshBaselineLocked(expectedGeneration: Long) {
        if (invalidated.get() || localEditGeneration() != expectedGeneration) return
        val stored = store.loadDigests(serverId, profileId)
        val current = bridge.digestSnapshot(serverId, profileId)
            .filter { domainPolicy.allows(it.key.domain, it.key.entityType, it.key.entityKey, null) }
        if (invalidated.get() || localEditGeneration() != expectedGeneration) return
        store.saveDigests(serverId, profileId, nextDigestRows(stored, current, vanishedKeys(stored, current)))
    }

    /**
     * Applies remote records and keeps the digest baseline current for the entities they touch.
     * Their digests are read before and after the apply, and only the entries the apply changed are
     * written. An entity with an unpushed local edit keeps its older digest, so the next pass still
     * uploads it, and remote state is never sent back with a fresh clock. A local edit that starts
     * during the apply skips the write, which leaves those keys stale until the next pass.
     */
    private suspend fun applyRemoteRecordsWithBaseline(records: List<V4WireRecord>) {
        val generation = localEditGeneration()
        val beforeStart = System.nanoTime()
        val before = affectedDigests(records)
        val applyStart = System.nanoTime()
        bridge.applyRemoteRecords(serverId, profileId, records)
        val afterStart = System.nanoTime()
        val after = affectedDigests(records)
        var rowCount = 0
        if (!invalidated.get() && localEditGeneration() == generation) {
            val rows = HashMap<V4DigestKey, V4StoredDigest>()
            for ((key, item) in after) {
                val prior = before[key]
                if (prior == null || prior.digest != item.digest || prior.deleted != item.deleted) {
                    rows[key] = V4StoredDigest(item.digest, item.deleted)
                }
            }
            for (key in before.keys) {
                if (key !in after) rows[key] = V4StoredDigest(digest = "", deleted = true)
            }
            if (rows.isNotEmpty()) store.saveDigests(serverId, profileId, rows)
            rowCount = rows.size
        }
        val applyMs = (afterStart - applyStart) / 1_000_000L
        val baselineMs = msSince(beforeStart) - applyMs
        logger.i {
            "realtime apply: ${records.size} records, apply ${applyMs} ms, " +
                "baseline-update ${baselineMs} ms, $rowCount digest rows"
        }
    }

    /** Digests of the entities [records] can touch, limited to enabled domains. */
    private suspend fun affectedDigests(records: List<V4WireRecord>): Map<V4DigestKey, V4DigestedItem> =
        bridge.digestAffected(serverId, profileId, records)
            .filter { domainPolicy.allows(it.key.domain, it.key.entityType, it.key.entityKey, null) }
            .associateBy { it.key }

    /** Recorded live keys (in enabled domains) that are absent from [current]. */
    private fun vanishedKeys(
        stored: Map<V4DigestKey, V4StoredDigest>,
        current: List<V4DigestedItem>,
    ): Set<V4DigestKey> {
        val present = current.mapTo(HashSet()) { it.key }
        return stored.filter { (key, row) ->
            !row.deleted && key !in present && domainPolicy.allows(key.domain, key.entityType, key.entityKey, null)
        }.keys
    }

    /**
     * Rows to upsert so the baseline records [current] plus [vanished] tombstones. Only rows that
     * differ from [stored] are returned: rewriting every unchanged digest would cost a full-table
     * write (over 100k rows on a large library) on every pass. Rows for disabled domains stay.
     */
    private fun nextDigestRows(
        stored: Map<V4DigestKey, V4StoredDigest>,
        current: List<V4DigestedItem>,
        vanished: Set<V4DigestKey>,
    ): Map<V4DigestKey, V4StoredDigest> {
        val rows = HashMap<V4DigestKey, V4StoredDigest>()
        for (item in current) {
            val next = V4StoredDigest(item.digest, item.deleted)
            if (stored[item.key] != next) rows[item.key] = next
        }
        for (key in vanished) rows[key] = V4StoredDigest(digest = "", deleted = true)
        return rows
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
            if (invalidated.get()) throw IOException("Engine invalidated")
            when (msg) {
                is V4SseMessage.Delta -> {
                    syncMutex.withLock {
                        if (invalidated.get()) throw IOException("Engine invalidated")
                        val cur = store.loadState(serverId, profileId)
                        if (msg.record.serverSeq <= cur.serverSeq) return@withLock
                        val clock = buildClock(cur)
                        clock.observe(msg.record.hlc)
                        val applicable = enabled(listOf(msg.record))
                        if (applicable.isNotEmpty()) applyRemoteRecordsWithBaseline(applicable)
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
                        if (invalidated.get()) throw IOException("Engine invalidated")
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
        val capabilities = when (val capRes = http.capabilities(accessToken)) {
            is CoreHttpResult.Success -> capRes.value
            is CoreHttpResult.Failure -> return V4SyncRunResult.Failed(
                reason = capRes.errorEnvelope?.error?.message ?: "HTTP ${capRes.statusCode}",
                statusCode = capRes.statusCode,
                retryable = capRes.statusCode >= 500 || capRes.statusCode == 429,
            )
        }
        val gathered = when (val g = gatherSnapshot(
            accessToken,
            snapshotPageLimit(capabilities),
            "Core returned no domain bootstrap snapshot",
        )) {
            is SnapshotGather.Failed -> return g.failure
            is SnapshotGather.Gathered -> g
        }
        val records = enabled(gathered.records, catchupPolicy)
        records.forEach { clock.observe(it.hlc) }
        if (records.isNotEmpty()) applyRemoteRecordsWithBaseline(records)
        // Keep the cursor unchanged here. The normal changes pass must still cover mutations in
        // already-enabled domains that occurred while the scoped snapshot was being fetched.
        domainProgress.save(serverId, profileId, completed + domainPolicy.enabledKeys)
        refreshBaselineLocked(0L)
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

        // Captured before the export: a local edit made during the merge must keep its baseline gap.
        val mergeGeneration = localEditGeneration()
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
            refreshBaselineLocked(mergeGeneration)
            return V4SyncRunResult.Synced(state.serverSeq, uploadedCount, 0, pending, false)
        }

        // A write receipt gives the Core's latest sequence, but only applying its snapshot
        // advances the local cursor. After a Core rewind, that cursor can also move backwards.
        val gathered = when (val g = gatherSnapshot(
            accessToken,
            snapshotPageLimit(capabilities),
            "Core returned no recovery snapshot",
        )) {
            is SnapshotGather.Failed -> {
                persistClock(initialState, clock)
                return g.failure
            }
            is SnapshotGather.Gathered -> g
        }

        gathered.records.forEach { clock.observe(it.hlc) }
        val applicableSnapshotRecords = enabled(gathered.records)
        if (applicableSnapshotRecords.isNotEmpty()) {
            applyRemoteRecordsWithBaseline(applicableSnapshotRecords)
        }
        val state = persistClock(
            initialState.copy(
                serverSeq = gathered.head.serverSeq,
                minReplayableSeq = gathered.head.minReplayableSeq,
                lastSnapshotEtag = gathered.etag,
                initialSyncCompleted = true,
            ),
            clock,
        )
        domainProgress.save(serverId, profileId, domainPolicy.enabledKeys)
        refreshBaselineLocked(mergeGeneration)
        return V4SyncRunResult.Synced(
            serverSeq = state.serverSeq,
            uploadedCount = uploadedCount,
            appliedCount = applicableSnapshotRecords.size,
            pendingOutboxCount = store.countPendingOutbox(serverId, profileId, domainPolicy),
            wasNoOpReconnect = false,
        )
    }

    /** Page size for snapshot paging, or null when the Core only serves the single full snapshot. */
    private fun snapshotPageLimit(capabilities: V4CapabilitiesResponse): Long? {
        if (!capabilities.supportsPagedSnapshot) return null
        return (capabilities.maxSnapshotPageItems.takeIf { it > 0 } ?: DEFAULT_SNAPSHOT_PAGE_ITEMS).toLong()
    }

    /**
     * Gathers every page of the snapshot before anything is applied, so a failed page leaves the
     * local state and cursor untouched. With [pageLimit] null the classic single request is used.
     */
    private suspend fun gatherSnapshot(
        accessToken: String,
        pageLimit: Long?,
        missingReason: String,
    ): SnapshotGather {
        if (pageLimit == null) {
            return when (val res = http.snapshot(accessToken)) {
                is CoreHttpResult.Success -> {
                    val snap = res.value
                        ?: return SnapshotGather.Failed(V4SyncRunResult.Failed(missingReason, statusCode = 304))
                    SnapshotGather.Gathered(snap, snap.records, res.etag)
                }
                is CoreHttpResult.Failure -> SnapshotGather.Failed(snapshotFailure(res.errorEnvelope, res.statusCode))
            }
        }

        var head: V4SnapshotResponse? = null
        var etag: String? = null
        var afterSeq: Long? = null
        val records = ArrayList<V4WireRecord>()
        while (true) {
            when (val res = http.snapshot(accessToken, afterSeq = afterSeq, limit = pageLimit)) {
                is CoreHttpResult.Failure -> return SnapshotGather.Failed(snapshotFailure(res.errorEnvelope, res.statusCode))
                is CoreHttpResult.Success -> {
                    // A 304 is only meaningful on the first page; later pages send no If-None-Match.
                    val page = res.value ?: return SnapshotGather.Failed(
                        V4SyncRunResult.Failed(
                            if (head == null) missingReason else "Core returned no snapshot page after seq ${afterSeq ?: 0L}",
                            statusCode = 304,
                        ),
                    )
                    val first = head ?: page.also {
                        head = it
                        etag = res.etag
                    }
                    records.addAll(page.records)
                    if (!page.hasMore) return SnapshotGather.Gathered(first, records, etag)
                    val previous = afterSeq ?: 0L
                    if (page.nextAfterSeq <= previous) {
                        return SnapshotGather.Failed(
                            V4SyncRunResult.Failed("Core snapshot page did not advance past seq $previous"),
                        )
                    }
                    afterSeq = page.nextAfterSeq
                }
            }
        }
    }

    private fun snapshotFailure(envelope: CoreErrorEnvelope?, statusCode: Int) = V4SyncRunResult.Failed(
        reason = envelope?.error?.message ?: "HTTP $statusCode",
        statusCode = statusCode,
        retryable = statusCode >= 500 || statusCode == 429,
    )

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

                    if (invalidated.get()) {
                        return V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
                    }
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
        private const val DEFAULT_SNAPSHOT_PAGE_ITEMS = 5_000
    }
}
