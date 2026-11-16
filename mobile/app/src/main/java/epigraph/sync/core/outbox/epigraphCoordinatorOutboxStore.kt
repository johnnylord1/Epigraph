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
     * Confirms applied writes from the records Core returned with them, in one transaction. Core
     * returns the same record it appends to its change feed, so the replica need not wait for this
     * device's own changes to come back over the network; a later echo of them is a no-op.
     */
    private val confirmOwnWrites: (suspend (List<CoreConfirmedRecord>) -> Unit)? = null,
    /**
     * Where acknowledged writes are confirmed locally. Null confirms them inline. Production confirms
     * them here, one response after another, while the next batch is on the network: the outbox rows
     * are settled already, and projecting thousands of records took as long as sending them.
     */
    private val confirmationScope: CoroutineScope? = null,
) : CoreOutboxStore {
    private val unsentFolded = AtomicBoolean(false)
    private val confirmationOrder = Mutex()
    private var confirmationTail: Job? = null

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
        return coordinator.claimReady(
            nowEpochMillis = nowEpochMillis,
            leaseDurationMillis = leaseDurationMillis,
            limit = limit,
        ).map { row ->
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
        return coordinator.claimReadyForScopes(
            nowEpochMillis = nowEpochMillis,
            leaseDurationMillis = leaseDurationMillis,
            limit = limit,
            scopeIds = scopeIds,
        ).map { row ->
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
        coordinator.acknowledgeAll(
            acknowledged.map { (record, result) -> acknowledgement(record, result, receivedAtEpochMillis) },
        )
        val confirmed = if (confirmOwnWrites != null) acknowledged.mapNotNull(::confirmedRecord) else emptyList()
        // A superseded write is not echoed back; the newer value it lost to replaces the local edit.
        val superseded = acknowledged
            .filter { (_, result) -> result.status == CoreMutationResultStatus.SUPERSEDED }
            .map { (record, result) -> CoreReplicaKey(record.scopeId, record.entityType, result.entityId) }
        if (confirmed.isEmpty() && superseded.isEmpty()) return
        val scope = confirmationScope
        if (scope == null) {
            confirmLocally(confirmed, superseded)
            return
        }
        confirmationOrder.withLock {
            // Responses are confirmed in the order Core applied them.
            val previous = confirmationTail
            confirmationTail = scope.launch {
                previous?.join()
                confirmLocally(confirmed, superseded)
            }
        }
    }

    override suspend fun awaitConfirmations() {
        confirmationOrder.withLock { confirmationTail }?.join()
    }

    private suspend fun confirmLocally(confirmed: List<CoreConfirmedRecord>, superseded: List<CoreReplicaKey>) {
        confirmOwnWrites?.let { confirm ->
            // Short transactions, so the next batch's claim and acknowledgement are not held up.
            confirmed.chunked(CONFIRMATION_CHUNK).forEach { chunk ->
                try {
                    confirm(chunk)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // The change feed still delivers these writes and settles them the old way.
                }
            }
        }
        superseded.forEach { key -> projectHeldRecord?.invoke(key) }
    }

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
        coordinator.markFailed(
            deviceId = DeviceId(identity.deviceId),
            clientMutationId = ClientMutationId(identity.clientMutationId),
            errorCode = errorCode,
            nextAttemptAtEpochMillis = nextAttemptAtEpochMillis,
        )
    }

    private companion object {
        const val CONFIRMATION_CHUNK = 100
    }
}
