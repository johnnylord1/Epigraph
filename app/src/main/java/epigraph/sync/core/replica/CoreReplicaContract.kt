package epigraph.sync.core.replica

import epigraph.sync.core.replay.CoreReplayCheckpoint
import epigraph.sync.core.replay.CoreReplayCoverage
import kotlinx.serialization.json.JsonElement
import yokai.data.Database

data class CoreReplicaKey(
    val scopeId: String,
    val entityType: String,
    val entityId: String,
)

data class CoreConfirmedRecord(
    val key: CoreReplicaKey,
    val serverVersion: Long,
    val lamport: Long,
    val record: JsonElement,
    /** Authenticated transport origin; diagnostic/projection context, never part of entity identity. */
    val originServerId: String? = null,
)

/** A deletion explicitly supplied by Core. Absence from a change page is never a tombstone. */
data class CoreConfirmedTombstone(
    val key: CoreReplicaKey,
    val serverVersion: Long,
    val lamport: Long,
    val deletedAtMs: Long,
    val reasonCode: String?,
)

data class CoreReplicaInboxEvent(
    val globalEventId: Long,
    val scopeId: String,
    val entityType: String,
    val entityId: String,
    val operation: String,
)

/**
 * Materializes the confirmed Core mirror into the app's domain tables.
 *
 * The replica tables are intentionally transport-neutral, but a successful sync must also be
 * visible to Library/Reader. Implementations are invoked by the SQLDelight transaction before it
 * commits; they must never enqueue a new outbox mutation for an incoming record.
 */
interface CoreReplicaProjection {
    suspend fun replaceScope(
        database: Database,
        scopeId: String,
        previousRecords: List<CoreConfirmedRecord>,
        previousTombstones: List<CoreConfirmedTombstone>,
        records: List<CoreConfirmedRecord>,
        tombstones: List<CoreConfirmedTombstone>,
    ) = Unit

    suspend fun upsert(
        database: Database,
        record: CoreConfirmedRecord,
    ) = Unit

    suspend fun delete(
        database: Database,
        tombstone: CoreConfirmedTombstone,
        previousRecord: CoreConfirmedRecord?,
    ) = Unit
}

/**
 * SQLDelight-facing transaction boundary for the confirmed Core replica.
 *
 * Implementations must publish every mutation made through [CoreReplicaTransaction] atomically.
 * In particular, a thrown block rolls back entity, tombstone, inbox and checkpoint writes.
 */
interface CoreReplicaStore {
    suspend fun <T> transaction(block: suspend CoreReplicaTransaction.() -> T): T
}

/** Reads the last durable cursor without exposing the confirmed rows to the transport layer. */
interface CoreReplicaCheckpointReader {
    suspend fun latestCheckpoint(coverage: CoreReplayCoverage): CoreReplayCheckpoint?
}

/** Invalidates replay cursors when a new Core is paired, forcing a fresh authoritative snapshot. */
fun interface CoreReplicaCheckpointResetter {
    suspend fun reset()
}

/** Read-only access to records already authenticated and committed by the replica transaction. */
fun interface CoreReplicaRecordReader {
    suspend fun confirmedRecords(
        scopeId: String,
        entityTypes: Set<String>,
    ): List<CoreConfirmedRecord>
}

interface CoreReplicaTransaction {
    /**
     * Reads the cursor inside the same SQLDelight transaction that will mutate the replica.
     * Implementations that do not persist checkpoints may return null; this keeps lightweight
     * protocol fakes source-compatible while production stores can reject stale snapshots.
     */
    suspend fun latestCheckpoint(coverage: CoreReplayCoverage): CoreReplayCheckpoint? = null

    /**
     * Replaces the complete confirmed replica for [scopeId]. This may remove confirmed records that
     * are absent from an authoritative snapshot, but must never read, replace or delete the outbox.
     */
    suspend fun replaceConfirmedScope(
        scopeId: String,
        records: List<CoreConfirmedRecord>,
        tombstones: List<CoreConfirmedTombstone>,
    )

    /** Projects an authoritative replacement into user-visible domain tables. */
    suspend fun projectScope(
        scopeId: String,
        records: List<CoreConfirmedRecord>,
        tombstones: List<CoreConfirmedTombstone>,
    ) = Unit

    suspend fun hasAppliedInboxEvent(globalEventId: Long): Boolean

    suspend fun upsertConfirmed(record: CoreConfirmedRecord)

    /** Projects a confirmed merge after its replica row has been written. */
    suspend fun projectConfirmed(record: CoreConfirmedRecord) = Unit

    suspend fun deleteConfirmed(tombstone: CoreConfirmedTombstone)

    /** Projects a confirmed delete. The prior record is optional for tombstones. */
    suspend fun projectDeleted(
        tombstone: CoreConfirmedTombstone,
        previousRecord: CoreConfirmedRecord? = null,
    ) = Unit

    suspend fun recordAppliedInboxEvent(event: CoreReplicaInboxEvent)

    /** Written last in the transaction and becomes visible only when that transaction commits. */
    suspend fun saveCheckpoint(checkpoint: CoreReplayCheckpoint)
}

sealed interface CoreReplicaApplyResult {
    data class SnapshotApplied(
        val scopeId: String,
        val checkpoint: CoreReplayCheckpoint,
    ) : CoreReplicaApplyResult

    data class ChangeApplied(val checkpoint: CoreReplayCheckpoint) : CoreReplicaApplyResult

    data class ChangeAlreadyApplied(val checkpoint: CoreReplayCheckpoint) : CoreReplicaApplyResult

    data class ChangesApplied(
        val appliedCount: Int,
        val alreadyAppliedCount: Int,
        val checkpoint: CoreReplayCheckpoint,
    ) : CoreReplicaApplyResult
}

class CoreReplicaProtocolException(message: String) : IllegalArgumentException(message)
