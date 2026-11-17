package epigraph.sync.core.outbox

import epigraph.contract.EpigraphEntityId
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncScopeId
import epigraph.sync.EpigraphMutationAcknowledgement
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.core.protocol.CoreMutationOperation
import epigraph.sync.core.protocol.CoreMutationResult
import epigraph.sync.core.protocol.CoreMutationResultStatus
import epigraph.sync.core.replica.CoreConfirmedRecord
import epigraph.sync.core.replica.CoreReplicaKey
import epigraph.sync.core.replica.CoreReplicaPayloadHasher
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Production bridge to the SQLDelight coordinator; it does not bypass outbox transactions. */
class EpigraphCoordinatorOutboxStore(
    private val coordinator: EpigraphMutationCoordinator,
    private val json: Json = Json,
    /** Projects the confirmed record already held for an entity whose local write lost. */
    private val projectHeldRecord: (suspend (CoreReplicaKey) -> Unit)? = null,
    /**
     * Confirms applied writes from the records Core returned with them, in the transaction that
     * settles their outbox rows. Core
     * returns the same record it appends to its change feed, so the replica need not wait for this
     * device's own changes to come back over the network; a later echo of them is a no-op.
     */
    private val confirmOwnWrites: (suspend (List<CoreConfirmedRecord>) -> Unit)? = null,
    /**
     * Where [acknowledgeAllInBackground] settles and confirms responses. Null settles them inline.
     * Production settles them here, one response after another, while the next batch is on the
     * network: projecting thousands of records took as long as sending them.
     */
    private val confirmationScope: CoroutineScope? = null,
    /**
     * Backfill commands kept in memory (see [CoreStagedOutbox]). Claimed only when no durable
     * row is ready, so a batch never mixes the two and a local edit is never held behind them.
     */
    private val staged: CoreStagedOutbox? = null,
) : CoreOutboxStore {
    private val unsentFolded = AtomicBoolean(false)
    private val confirmationOrder = Mutex()
    private var acknowledgementTail: Job? = null
    private val acknowledgementFailure = AtomicReference<Throwable?>(null)

    /** Queues written before folding existed still hold one row per page turn; fold them once. */
    private suspend fun foldUnsentOnce() {
        if (unsentFolded.compareAndSet(false, true)) {
            try {
                coordinator.foldUnsentMutations()
            } catch (error: CancellationException) {
                unsentFolded.set(false)
                throw error
            } catch (_: Exception) {
                // Folding only saves requests; an unfolded queue still drains correctly.
                unsentFolded.set(false)
            }
        }
    }

    override suspend fun claimReady(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
    ): List<ClaimedCoreOutboxRecord> {
        foldUnsentOnce()
        stagedWithoutDurable(nowEpochMillis, limit, scopeIds = null)?.let { return it }
        return coordinator.claimReady(
            nowEpochMillis = nowEpochMillis,
            leaseDurationMillis = leaseDurationMillis,
            limit = limit,
        ).ifEmpty { return staged?.claim(limit, scopeIds = null).orEmpty() }.map { row ->
            ClaimedCoreOutboxRecord(
                sequence = row.sequence,
                // claimReady returns the selected row image, then increments it while taking the lease.
                attemptCount = Math.addExact(row.attempt_count, 1),
                record = CoreOutboxRecord(
                    deviceId = row.device_id,
                    clientMutationId = row.client_mutation_id,
                    scopeId = row.scope_id,
                    entityType = row.entity_type,
                    entityId = row.entity_id,
                    operation = row.operation,
                    payloadJson = row.payload_json,
                    createdAtEpochMillis = row.created_at,
                ),
            )
        }
    }

    override suspend fun claimReadyForScopes(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
        scopeIds: Set<String>,
    ): List<ClaimedCoreOutboxRecord> {
        foldUnsentOnce()
        stagedWithoutDurable(nowEpochMillis, limit, scopeIds)?.let { return it }
        return coordinator.claimReadyForScopes(
            nowEpochMillis = nowEpochMillis,
            leaseDurationMillis = leaseDurationMillis,
            limit = limit,
            scopeIds = scopeIds,
        ).ifEmpty { return staged?.claim(limit, scopeIds).orEmpty() }.map { row ->
            ClaimedCoreOutboxRecord(
                sequence = row.sequence,
                attemptCount = Math.addExact(row.attempt_count, 1),
                record = CoreOutboxRecord(
                    deviceId = row.device_id,
                    clientMutationId = row.client_mutation_id,
                    scopeId = row.scope_id,
                    entityType = row.entity_type,
                    entityId = row.entity_id,
                    operation = row.operation,
                    payloadJson = row.payload_json,
                    createdAtEpochMillis = row.created_at,
                ),
            )
        }
    }

    /**
     * Staged rows when no durable row is ready. While the progress backfill stages, its write
     * transactions follow each other; a claim that opened its own one waited behind each of them
     * for rows it would not find, so it reads first and leaves the outbox alone.
     */
    private suspend fun stagedWithoutDurable(
        nowEpochMillis: Long,
        limit: Long,
        scopeIds: Set<String>?,
    ): List<ClaimedCoreOutboxRecord>? {
        val queue = staged ?: return null
        if (!queue.hasReady() || coordinator.mayHaveReadyMutations(nowEpochMillis)) return null
        return queue.claim(limit, scopeIds).ifEmpty { null }
    }

    override suspend fun acknowledge(
        record: CoreOutboxRecord,
        result: CoreMutationResult,
        receivedAtEpochMillis: Long,
    ) = acknowledgeAll(listOf(CoreOutboxAcknowledgedRecord(record, result)), receivedAtEpochMillis)

    override suspend fun acknowledgeAll(
        acknowledged: List<CoreOutboxAcknowledgedRecord>,
        receivedAtEpochMillis: Long,
    ) {
        if (acknowledged.isEmpty()) return
        val stagedRows = staged
            ?.let { queue -> acknowledged.filter { queue.isLeased(it.record.identity()) } }
            .orEmpty()
        if (stagedRows.isNotEmpty()) {
            acknowledgeStaged(stagedRows)
            if (stagedRows.size == acknowledged.size) return
            return acknowledgeAll(acknowledged - stagedRows.toSet(), receivedAtEpochMillis)
        }
        val confirm = confirmOwnWrites
        if (confirm == null) {
            coordinator.acknowledgeAll(
                acknowledged.map { (record, result) -> acknowledgement(record, result, receivedAtEpochMillis) },
            )
        } else {
            // Short transactions, so the next batch's claim is not held up behind a whole response.
            acknowledged.chunked(CONFIRMATION_CHUNK).forEach { chunk ->
                val acknowledgements = chunk.map { (record, result) ->
                    acknowledgement(record, result, receivedAtEpochMillis)
                }
                val confirmed = chunk.mapNotNull(::confirmedRecord)
                try {
                    coordinator.acknowledgeAndConfirm(acknowledgements) {
                        if (confirmed.isNotEmpty()) confirm(confirmed)
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // Settle the rows without the confirmation; the change feed still delivers
                    // these writes and settles their waits the old way.
                    coordinator.acknowledgeAll(acknowledgements)
                }
            }
        }
        // A superseded write is not echoed back; the newer value it lost to replaces the local edit.
        acknowledged
            .filter { (_, result) -> result.status == CoreMutationResultStatus.SUPERSEDED }
            .forEach { (record, result) ->
                projectHeldRecord?.invoke(CoreReplicaKey(record.scopeId, record.entityType, result.entityId))
            }
    }

    /**
     * A staged command has no outbox row, receipt or wait to settle: confirming the record Core
     * returned into the replica is all that is left, and what keeps the next backfill from
     * sending it again.
     */
    private suspend fun acknowledgeStaged(acknowledged: List<CoreOutboxAcknowledgedRecord>) {
        val queue = checkNotNull(staged)
        val confirm = confirmOwnWrites
        acknowledged.chunked(CONFIRMATION_CHUNK).forEach { chunk ->
            val confirmed = chunk.mapNotNull(::confirmedRecord)
            try {
                if (confirm != null && confirmed.isNotEmpty()) confirm(confirmed)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // Core holds these writes; the change feed delivers them to the replica.
            }
            chunk.forEach { queue.settle(it.record.identity()) }
        }
        acknowledged
            .filter { (_, result) -> result.status == CoreMutationResultStatus.SUPERSEDED }
            .forEach { (record, result) ->
                projectHeldRecord?.invoke(CoreReplicaKey(record.scopeId, record.entityType, result.entityId))
            }
    }

    override suspend fun acknowledgeAllInBackground(
        acknowledged: List<CoreOutboxAcknowledgedRecord>,
        receivedAtEpochMillis: Long,
    ) {
        val scope = confirmationScope
        if (scope == null || acknowledged.isEmpty()) return acknowledgeAll(acknowledged, receivedAtEpochMillis)
        confirmationOrder.withLock {
            // Settled in the order Core answered, each after the one before it.
            val previous = acknowledgementTail
            acknowledgementTail = scope.launch {
                previous?.join()
                try {
                    acknowledgeAll(acknowledged, receivedAtEpochMillis)
                } catch (error: CancellationException) {
                    acknowledgementFailure.compareAndSet(null, error)
                    throw error
                } catch (error: Exception) {
                    // The rows stay leased and pending; the next await reports it and a later
                    // drain resends them after the lease, which Core dedupes.
                    acknowledgementFailure.compareAndSet(null, error)
                }
            }
        }
    }

    override suspend fun awaitAcknowledgements() {
        confirmationOrder.withLock { acknowledgementTail }?.join()
        acknowledgementFailure.getAndSet(null)?.let { throw it }
    }

    override suspend fun awaitConfirmations() = awaitAcknowledgements()

    private fun confirmedRecord(acknowledged: CoreOutboxAcknowledgedRecord): CoreConfirmedRecord? {
        val (_, result, originServerId, sentPatch) = acknowledged
        if (result.status != CoreMutationResultStatus.APPLIED) return null
        // A delete is confirmed by its tombstone, which the change feed carries.
        if (result.op != CoreMutationOperation.MERGE) return null
        val serverVersion = result.appliedServerVersion ?: return null
        val lamport = result.appliedLamport ?: return null
        val confirmedRecord = result.record?.takeUnless { it is JsonNull } ?: return null
        return CoreConfirmedRecord(
            // The identity Core wrote to its change feed, so a later echo lands on the same row.
            key = CoreReplicaKey(result.scopeId, result.entityType, result.canonicalEntityId ?: result.entityId),
            serverVersion = serverVersion,
            lamport = lamport,
            record = confirmedRecord,
            originServerId = originServerId,
            echoesLocalState = sentPatch != null && confirmedRecord == sentPatch,
        )
    }

    private fun acknowledgement(
        record: CoreOutboxRecord,
        result: CoreMutationResult,
        receivedAtEpochMillis: Long,
    ): EpigraphMutationAcknowledgement {
        val serverVersion = requireNotNull(result.appliedServerVersion) {
            "accepted Core result must include a server version"
        }
        return EpigraphMutationAcknowledgement(
            deviceId = DeviceId(record.deviceId),
            clientMutationId = ClientMutationId(record.clientMutationId),
            scopeId = SyncScopeId(record.scopeId),
            entityType = record.entityType,
            // The adapter may project a local command onto a canonical transport identity
            // (for example book.progress::<bookId>). Reconciliation follows the identity
            // acknowledged by Core, not the pre-adaptation local row identity.
            entityId = EpigraphEntityId(result.entityId),
            canonicalEntityId = result.canonicalEntityId?.let(::EpigraphEntityId),
            resultStatus = result.status.name,
            requiredServerVersion = serverVersion,
            appliedLamport = result.appliedLamport,
            eventClockJson = result.eventClock?.let { json.encodeToString(it) },
            canonicalRecordSha256 = result.record?.let {
                CoreReplicaPayloadHasher.sha256(CoreReplicaPayloadHasher.canonicalJson(it))
            },
            receivedAtEpochMillis = receivedAtEpochMillis,
        )
    }

    override suspend fun markFailed(
        identity: CoreOutboxIdentity,
        errorCode: String,
        nextAttemptAtEpochMillis: Long,
    ) {
        val queue = staged
        if (queue != null && queue.isLeased(identity)) {
            // Claimed but never sent: claim it again. Anything else goes to the durable outbox,
            // which keeps the retry schedule and the block.
            if (errorCode == NOT_SENT) queue.release(identity) else queue.fail(identity)
            return
        }
        coordinator.markFailed(
            deviceId = DeviceId(identity.deviceId),
            clientMutationId = ClientMutationId(identity.clientMutationId),
            errorCode = errorCode,
            nextAttemptAtEpochMillis = nextAttemptAtEpochMillis,
        )
    }

    private companion object {
        const val CONFIRMATION_CHUNK = 500
        const val NOT_SENT = "drain_not_sent"
    }
}

private fun CoreOutboxRecord.identity() = CoreOutboxIdentity(deviceId, clientMutationId)
