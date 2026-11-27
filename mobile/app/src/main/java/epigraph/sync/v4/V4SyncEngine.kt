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
import java.util.concurrent.atomic.AtomicLong
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

/** Unlocked library reads a local-edit pass may make before it reads under the lock. */
private const val MAX_UNLOCKED_LOCAL_READS = 3

private sealed interface LocalPassStep {
    /** The unlocked read raced a locked section or a local edit, so it must be redone. */
    object Retry : LocalPassStep

    class Done(val result: V4SyncRunResult) : LocalPassStep
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

    /** Advances each time a locked section ends. An unlocked read that sees a change here may be stale. */
    private val lockEpoch = AtomicLong(0L)

    private suspend fun <T> locked(block: suspend () -> T): T = syncMutex.withLock {
        try {
            block()
        } finally {
            lockEpoch.incrementAndGet()
        }
    }

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

    suspend fun syncOnce(accessToken: String): V4SyncRunResult = locked {
        if (invalidated.get()) {
            return@locked V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
        }
        var state = store.loadState(serverId, profileId)
        val previousSeq = state.serverSeq
        val clock = buildClock(state)

        // 1. Always negotiate/check capabilities & calibrate server clock first on initial sync.
        if (!state.initialSyncCompleted) {
            return@locked runFullMergeLocked(accessToken, state, clock)
        }
        val phaseStartNs = System.nanoTime()
        val catchup = bootstrapReenabledDomainsLocked(accessToken, state, clock)
        if (catchup is V4SyncRunResult.Failed) return@locked catchup
        val bootstrapMs = (System.nanoTime() - phaseStartNs) / 1_000_000

        // 2. Drain pending local outbox deltas.
        val drainStartNs = System.nanoTime()
        val uploadResult = drainOutboxLocked(accessToken, state)
        if (uploadResult is V4SyncRunResult.Failed) {
            persistClock(state, clock)
            return@locked uploadResult
        }
        val uploadedCount = (uploadResult as V4SyncRunResult.Synced).uploadedCount
        val drainMs = (System.nanoTime() - drainStartNs) / 1_000_000

        // 3. Pull paginated remote changes since our cursor.
        val changesStartNs = System.nanoTime()
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
                        return@locked runFullMergeLocked(accessToken, state, clock)
                    }
                    persistClock(state, clock)
                    return@locked V4SyncRunResult.Failed(
                        reason = res.errorEnvelope?.error?.message ?: "HTTP ${res.statusCode}",
                        statusCode = res.statusCode,
                        retryable = res.statusCode >= 500 || res.statusCode == 429,
                    )
                }
            }
        }

        val changesMs = (System.nanoTime() - changesStartNs) / 1_000_000
        if (invalidated.get()) {
            return@locked V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
        }
        val tailStartNs = System.nanoTime()
        state = persistClock(
            state.copy(serverSeq = cursor, minReplayableSeq = minReplayable),
            clock,
        )
        if (state.serverSeq > previousSeq) {
            pruneDisabledDomains()
        }
        val tailMs = (System.nanoTime() - tailStartNs) / 1_000_000
        // A full baseline scan is only needed when none exists yet. Applies keep it current after that.
        val baselineStartNs = System.nanoTime()
        val hasDigests = store.hasDigests(serverId, profileId)
        if (!hasDigests) refreshBaselineLocked(0L)
        logger.i {
            "v4 syncOnce tail: persist+prune ${tailMs} ms, hasDigests=$hasDigests " +
                "baseline ${(System.nanoTime() - baselineStartNs) / 1_000_000} ms"
        }
        val pendingStartNs = System.nanoTime()
        val pending = store.countPendingOutbox(serverId, profileId, domainPolicy)
        logger.i {
            "v4 syncOnce phases: bootstrap ${bootstrapMs} ms, drain ${drainMs} ms, " +
                "changes ${changesMs} ms, pendingCount ${(System.nanoTime() - pendingStartNs) / 1_000_000} ms, " +
                "uploaded=$uploadedCount applied=$appliedCount"
        }
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
    suspend fun syncWithLocalEdits(
        accessToken: String,
        plan: () -> V4LocalPlan = { V4LocalPlan(localEditGeneration(), scope = null) },
    ): V4SyncRunResult {
        // Bootstrap of newly enabled domains and first-sync handling run under the lock, before any read.
        val early = locked<V4SyncRunResult?> {
            if (invalidated.get()) {
                return@locked V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
            }
            val state = store.loadState(serverId, profileId)
            if (!state.initialSyncCompleted) {
                return@locked runFullMergeLocked(accessToken, state, buildClock(state))
            }
            val clock = buildClock(state)
            val catchup = bootstrapReenabledDomainsLocked(accessToken, state, clock)
            if (catchup is V4SyncRunResult.Failed) return@locked catchup
            persistClock(state, clock)
            null
        }
        if (early != null) return early

        // The library read runs outside the lock. A read is kept only when no locked section ran and no
        // local edit was recorded while it ran; otherwise it is redone. After the unlocked attempts the
        // read runs under the lock, so a busy device still converges.
        var attempt = 0
        while (true) {
            attempt++
            val unlocked = attempt <= MAX_UNLOCKED_LOCAL_READS
            val epochBefore = lockEpoch.get()
            // The plan's generation is read before its scope. Every mark at or below that generation is already
            // in the library, so the read covers it. A mark recorded later is left pending by the commit.
            val planNow = plan()
            val preRead = if (unlocked) bridge.readLocalScoped(serverId, profileId, planNow.scope) else null
            val step = locked<LocalPassStep> {
                if (invalidated.get()) {
                    return@locked LocalPassStep.Done(V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false))
                }
                if (preRead != null && (lockEpoch.get() != epochBefore || localEditGeneration() != planNow.generation)) {
                    return@locked LocalPassStep.Retry
                }
                val read = preRead ?: bridge.readLocalScoped(serverId, profileId, planNow.scope)
                LocalPassStep.Done(commitLocalPassLocked(accessToken, read))
            }
            when (step) {
                LocalPassStep.Retry -> continue
                is LocalPassStep.Done -> return step.result
            }
        }
    }

    /** Stamps and uploads [read], then drains the outbox and pulls remote changes. Runs under [syncMutex]. */
    private suspend fun commitLocalPassLocked(accessToken: String, read: V4LocalRead): V4SyncRunResult {
        var state = store.loadState(serverId, profileId)
        val previousSeq = state.serverSeq
        val clock = buildClock(state)

        // Upload only items whose digest differs from the recorded baseline, so offline progress
        // across all domains converges without re-sending unchanged state with fresh clocks.
        var mark = System.nanoTime()
        // Stamps the read state (retractions and tombstones are written here, under the lock).
        // Digests come from the same state that is exported, so an edit between read and commit cannot
        // make the upload diff disagree with the outgoing items.
        val pass = read.commit(clock)
        val exportMs = msSince(mark)
        mark = System.nanoTime()
        // A scoped commit reads the stored digests it covers in its own transaction. Otherwise the whole
        // profile baseline is loaded here, under the lock.
        val stored = pass.stored ?: store.loadDigests(serverId, profileId)
        val loadMs = msSince(mark)
        val outgoingAll = pass.outgoing
        val current = pass.digests
            .filter { domainPolicy.allows(it.key.domain, it.key.entityType, it.key.entityKey, null) }
        val exported = enabled(outgoingAll)
            .associateBy { V4DigestKey(it.domain, it.entityType, it.entityKey) }
        // A partial stored map only holds the scope's rows, and vanishedKeys reads live rows only.
        val vanished = vanishedKeys(stored, current)
        // Comic relation retractions already enqueue and mark their tombstones during export.
        val tombstones = vanished.filter { !store.isEntityMapTombstoned(serverId, profileId, it) }
        // Without any recorded digests, existing remote state must not be outranked: use the baseline clock.
        // This is a whole-table check, so it holds for a scoped pass too.
        val baselineMode = !store.hasDigests(serverId, profileId)
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
                    // The cursor stays at its pre-upload value. Another device can commit a record while this
                    // pass reads or uploads, and that record's seq is below our upload's seq, so advancing
                    // the cursor here would skip it. Our own echoes are harmless to re-apply.
                    uploadedCount += bulkRes.value.acceptedCount + bulkRes.value.mergedCount
                }
                is CoreHttpResult.Failure -> {
                    persistClock(state, clock)
                    return V4SyncRunResult.Failed(
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
            return outboxRes
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
                        return runFullMergeLocked(accessToken, state, clock)
                    }
                    persistClock(state, clock)
                    return V4SyncRunResult.Failed(
                        reason = res.errorEnvelope?.error?.message ?: "HTTP ${res.statusCode}",
                        statusCode = res.statusCode,
                        retryable = res.statusCode >= 500 || res.statusCode == 429,
                    )
                }
            }
        }

        if (invalidated.get()) {
            return V4SyncRunResult.Failed(reason = "Engine invalidated", retryable = false)
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
        return V4SyncRunResult.Synced(
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
        locked { refreshBaselineLocked(expectedGeneration) }
    }

    /** Returns false when a local edit (or invalidation) refused the refresh, so nothing was written. */
    private suspend fun refreshBaselineLocked(expectedGeneration: Long): Boolean {
        if (invalidated.get() || localEditGeneration() != expectedGeneration) return false
        val stored = store.loadDigests(serverId, profileId)
        val current = bridge.digestSnapshot(serverId, profileId)
            .filter { domainPolicy.allows(it.key.domain, it.key.entityType, it.key.entityKey, null) }
        if (invalidated.get() || localEditGeneration() != expectedGeneration) return false
        store.saveDigests(serverId, profileId, nextDigestRows(stored, current, vanishedKeys(stored, current)))
        return true
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

    /**
     * Applies records without updating the digest baseline. Used by the first sync, which builds the
     * whole baseline once at the end instead of digesting every touched entity on every chunk.
     */
    private suspend fun applyRemoteRecordsOnly(records: List<V4WireRecord>) {
        bridge.applyRemoteRecords(serverId, profileId, records)
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
                    locked {
                        if (invalidated.get()) throw IOException("Engine invalidated")
                        val cur = store.loadState(serverId, profileId)
                        if (msg.record.serverSeq <= cur.serverSeq) return@locked
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
                    locked {
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
        // Receipts are "clean" when every uploaded record was a new write and the sequence advanced
        // exactly by the accepted count. Only then can the Core's extra records be fetched alone.
        var cleanUpload = localItems.isNotEmpty()
        var receiptHead = capabilities.serverSeq
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
                    if (summary.acceptedCount != baseline.size || summary.mergedCount != 0 ||
                        summary.noopCount != 0 || summary.deduplicatedCount != 0 ||
                        summary.serverSeq != receiptHead + summary.acceptedCount
                    ) {
                        cleanUpload = false
                    }
                    receiptHead = summary.serverSeq
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
            // The baseline goes first: if it is refused, the flag stays unset and the merge is redone.
            if (!refreshBaselineLocked(mergeGeneration)) return staleBaselineFailure()
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

        // Clean receipts and nothing left to drain: the phone's records are already on the Core in
        // the expected order, so only the Core's other records need to come down.
        if (cleanUpload && outboxRes.uploadedCount == 0 && pending == 0L) {
            val uploadedKeys = localItems.mapTo(HashSet(localItems.size)) {
                V4DigestKey(it.domain, it.entityType, it.entityKey)
            }
            // Receipts cover (preHead, receiptHead]; the cursor moves to the receipt head, so later
            // Core writes are still pulled by the next changes pass.
            when (val gather = applyChangesExcept(accessToken, uploadedKeys, preHead = capabilities.serverSeq, clock = clock)) {
                is ChangeGather.Gathered -> {
                    if (!refreshBaselineLocked(mergeGeneration)) return staleBaselineFailure()
                    val state = persistClock(
                        initialState.copy(
                            serverSeq = receiptHead,
                            minReplayableSeq = gather.minReplayableSeq,
                            initialSyncCompleted = true,
                        ),
                        clock,
                    )
                    domainProgress.save(serverId, profileId, domainPolicy.enabledKeys)
                    return V4SyncRunResult.Synced(
                        serverSeq = state.serverSeq,
                        uploadedCount = uploadedCount,
                        appliedCount = gather.appliedCount,
                        pendingOutboxCount = store.countPendingOutbox(serverId, profileId, domainPolicy),
                        wasNoOpReconnect = false,
                    )
                }
                // The feed ends before the pre-upload head (a Core rewind): the snapshot path decides.
                is ChangeGather.Replayed -> Unit
                is ChangeGather.Failed -> {
                    persistClock(initialState, clock)
                    return gather.failure
                }
            }
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
            applyRemoteRecordsOnly(applicableSnapshotRecords)
        }
        if (!refreshBaselineLocked(mergeGeneration)) return staleBaselineFailure()
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
        return V4SyncRunResult.Synced(
            serverSeq = state.serverSeq,
            uploadedCount = uploadedCount,
            appliedCount = applicableSnapshotRecords.size,
            pendingOutboxCount = store.countPendingOutbox(serverId, profileId, domainPolicy),
            wasNoOpReconnect = false,
        )
    }

    private fun staleBaselineFailure(): V4SyncRunResult.Failed = V4SyncRunResult.Failed(
        reason = "Local edits changed during the first sync; it will be retried",
        retryable = true,
    )

    private sealed interface ChangeGather {
        class Gathered(val minReplayableSeq: Long, val appliedCount: Int) : ChangeGather
        object Replayed : ChangeGather
        class Failed(val failure: V4SyncRunResult.Failed) : ChangeGather
    }

    /**
     * Pulls only the Core's records that existed before our upload ([preHead] and below), skipping
     * entities the phone just uploaded: those already hold the phone's accepted version. Records after
     * [preHead] are either our own receipts or newer writes, and the next changes pass covers those.
     */
    private suspend fun applyChangesExcept(
        accessToken: String,
        uploadedKeys: Set<V4DigestKey>,
        preHead: Long,
        clock: V4HlcClock,
    ): ChangeGather {
        var cursor = 0L
        var minReplayable = 0L
        var applied = 0
        while (cursor < preHead) {
            when (val res = http.changes(accessToken, sinceSeq = cursor, limit = CHANGES_PAGE_SIZE)) {
                is CoreHttpResult.Success -> {
                    val page = res.value
                    minReplayable = page.minReplayableSeq
                    val existing = page.changes.filter { it.serverSeq <= preHead }
                    existing.forEach { clock.observe(it.hlc) }
                    val records = enabled(existing).filter {
                        V4DigestKey(it.domain, it.entityType, it.entityKey) !in uploadedKeys
                    }
                    if (records.isNotEmpty()) applyRemoteRecordsOnly(records)
                    applied += records.size
                    cursor = maxOf(cursor, page.nextSeq)
                    // The feed ended before the pre-upload head: the Core rewound, so the snapshot decides.
                    if (!page.hasMore && cursor < preHead) return ChangeGather.Replayed
                }
                is CoreHttpResult.Failure -> {
                    if (res.statusCode == 410) return ChangeGather.Replayed
                    return ChangeGather.Failed(
                        V4SyncRunResult.Failed(
                            reason = res.errorEnvelope?.error?.message ?: "HTTP ${res.statusCode}",
                            statusCode = res.statusCode,
                            retryable = res.statusCode >= 500 || res.statusCode == 429,
                        ),
                    )
                }
            }
        }
        return ChangeGather.Gathered(minReplayable, applied)
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
