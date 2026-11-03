package epigraph.sync.core.outbox

import epigraph.contract.EpigraphEntityId
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncScopeId
import epigraph.sync.EpigraphMutationAcknowledgement
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.core.protocol.CoreMutationResult
import epigraph.sync.core.protocol.CoreMutationResultStatus
import epigraph.sync.core.replica.CoreReplicaKey
import epigraph.sync.core.replica.CoreReplicaPayloadHasher
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException

/** Production bridge to the SQLDelight coordinator; it does not bypass outbox transactions. */
class EpigraphCoordinatorOutboxStore(
    private val coordinator: EpigraphMutationCoordinator,
    private val json: Json = Json,
    /** Projects the confirmed record already held for an entity whose local write lost. */
    private val projectHeldRecord: (suspend (CoreReplicaKey) -> Unit)? = null,
) : CoreOutboxStore {
    private val unsentFolded = AtomicBoolean(false)

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
        // A superseded write is not echoed back; the newer value it lost to replaces the local edit.
        acknowledged.forEach { (record, result) ->
            if (result.status == CoreMutationResultStatus.SUPERSEDED) {
                projectHeldRecord?.invoke(CoreReplicaKey(record.scopeId, record.entityType, result.entityId))
            }
        }
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
}
