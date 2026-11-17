package epigraph.sync.core.outbox

import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.operationWireName
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.LocalMutationResult

/**
 * Commands that publish state this device already holds (the reading-progress backfill), kept in
 * memory and sent by the regular drain instead of going through the durable outbox first.
 *
 * Queueing, claiming, settling and deleting a durable row cost several single-row writes per
 * command on the one SQLite writer, which made a first sync of thousands of read chapters take a
 * minute. A staged command is sent as it is and, once Core acknowledges it, confirmed into the
 * replica with no outbox bookkeeping. These commands carry no local edit: the state they publish
 * stays in the domain tables, so a command lost with the process is found again by the next
 * backfill (the replica does not hold it yet). A command that fails to send is not retried here;
 * [takeUnsent] hands it to the durable outbox at the end of the run, so it is never dropped.
 */
class CoreStagedOutbox {
    data class Row(
        /** Unique among claims, outbox rows included: sent as the event clock's logical value. */
        val sequence: Long,
        val record: CoreOutboxRecord,
    )

    private val lock = Any()
    private val ready = ArrayDeque<Row>()
    private val leased = HashMap<CoreOutboxIdentity, Row>()
    private val failed = ArrayList<Row>()

    /** Entities with a staged command not settled yet, so a later backfill pass does not stage them twice. */
    private val entities = HashSet<Triple<String, String, String>>()

    private var nextSequence = SEQUENCE_BASE

    /** Stages the records whose entity has no staged command yet; returns how many were staged. */
    fun stage(records: List<CoreOutboxRecord>): Int = synchronized(lock) {
        var staged = 0
        records.forEach { record ->
            if (entities.add(record.entityKey())) {
                ready.addLast(Row(nextSequence++, record))
                staged += 1
            }
        }
        staged
    }

    /** Stages commands as the outbox would store them, each dated when its change happened. */
    fun stage(coordinator: EpigraphMutationCoordinator, dated: List<Pair<SyncCommandEnvelope, Long>>): Int =
        stage(
            dated.map { (envelope, createdAt) ->
                CoreOutboxRecord(
                    deviceId = envelope.deviceId.value,
                    clientMutationId = envelope.clientMutationId.value,
                    scopeId = envelope.scopeId.value,
                    entityType = envelope.entityType.value,
                    entityId = envelope.command.entityId.value,
                    operation = envelope.command.operationWireName(),
                    payloadJson = coordinator.encodeQueued(envelope),
                    createdAtEpochMillis = createdAt,
                )
            },
        )

    /**
     * Moves every command Core has not acknowledged to the durable outbox, which retries it on
     * its own schedule. Run it once no drain is running. Returns how many it moved.
     */
    suspend fun flushTo(coordinator: EpigraphMutationCoordinator, nowEpochMillis: Long): Int {
        val rows = takeUnsent()
        if (rows.isEmpty()) return 0
        try {
            rows.chunked(FLUSH_CHUNK).forEach { chunk ->
                val envelopes = chunk.map { coordinator.decodeQueued(it.record.payloadJson) to it.record.createdAtEpochMillis }
                coordinator.mutateLocalBatch(nowEpochMillis) {
                    LocalMutationResult(
                        value = Unit,
                        envelopes = envelopes.map { it.first },
                        envelopeCreatedAt = envelopes.associate { (envelope, at) -> envelope.clientMutationId to at },
                    )
                }
            }
        } catch (error: Throwable) {
            // Rows of chunks already committed are queued twice at worst; Core dedupes them.
            restore(rows)
            throw error
        }
        return rows.size
    }

    /** Whether [entityKey] (scope, type, id) has a staged command not settled yet. */
    fun holds(scopeId: String, entityType: String, entityId: String): Boolean = synchronized(lock) {
        Triple(scopeId, entityType, entityId) in entities
    }

    /** Whether a staged command waits to be claimed. */
    fun hasReady(): Boolean = synchronized(lock) { ready.isNotEmpty() }

    fun claim(limit: Long, scopeIds: Set<String>?): List<ClaimedCoreOutboxRecord> = synchronized(lock) {
        if (limit <= 0 || ready.isEmpty()) return emptyList()
        val claimed = ArrayList<ClaimedCoreOutboxRecord>()
        val skipped = ArrayList<Row>()
        while (claimed.size < limit && ready.isNotEmpty()) {
            val row = ready.removeFirst()
            if (scopeIds != null && row.record.scopeId !in scopeIds) {
                skipped += row
                continue
            }
            leased[row.record.identity()] = row
            claimed += ClaimedCoreOutboxRecord(row.sequence, attemptCount = 1, record = row.record)
        }
        skipped.asReversed().forEach(ready::addFirst)
        claimed
    }

    fun isLeased(identity: CoreOutboxIdentity): Boolean = synchronized(lock) { identity in leased }

    /** Core acknowledged the command: it no longer counts as pending. */
    fun settle(identity: CoreOutboxIdentity) = synchronized(lock) {
        leased.remove(identity)?.let { entities.remove(it.record.entityKey()) }
    }

    /** Returns a command claimed but never sent, ready to be claimed again. */
    fun release(identity: CoreOutboxIdentity) = synchronized(lock) {
        leased.remove(identity)?.let(ready::addFirst)
    }

    /** Parks a command that failed to send until [takeUnsent] moves it to the durable outbox. */
    fun fail(identity: CoreOutboxIdentity) = synchronized(lock) {
        leased.remove(identity)?.let(failed::add)
    }

    /**
     * Removes and returns every command not acknowledged yet, for the durable outbox. Call it only
     * once no drain is running: a command still leased then was cancelled mid-flight, and Core
     * dedupes it by its mutation id if it did arrive.
     */
    fun takeUnsent(): List<Row> = synchronized(lock) {
        val rows = failed + leased.values + ready
        failed.clear()
        leased.clear()
        ready.clear()
        entities.clear()
        rows
    }

    /** Puts back rows [takeUnsent] returned when the durable outbox could not take them. */
    fun restore(rows: List<Row>) = synchronized(lock) {
        rows.forEach { row ->
            if (entities.add(row.record.entityKey())) failed += row
        }
    }

    /** Commands not acknowledged yet, in flight included. */
    fun count(scopeIds: Set<String>? = null): Long = synchronized(lock) {
        if (scopeIds == null) return (ready.size + leased.size + failed.size).toLong()
        (ready.count { it.record.scopeId in scopeIds } +
            leased.values.count { it.record.scopeId in scopeIds } +
            failed.count { it.record.scopeId in scopeIds }).toLong()
    }

    private fun CoreOutboxRecord.identity() = CoreOutboxIdentity(deviceId, clientMutationId)

    private fun CoreOutboxRecord.entityKey() = Triple(scopeId, entityType, entityId)

    private companion object {
        /** Above any outbox row's sequence, so a staged claim never shares one with a durable claim. */
        const val SEQUENCE_BASE = 1L shl 40
        const val FLUSH_CHUNK = 500
    }
}
