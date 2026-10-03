package epigraph.sync.core.outbox

import epigraph.contract.EpigraphEntityId
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncScopeId
import epigraph.sync.EpigraphMutationAcknowledgement
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.core.protocol.CoreMutationResult
import epigraph.sync.core.replica.CoreReplicaPayloadHasher
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Production bridge to the SQLDelight coordinator; it does not bypass outbox transactions. */
class EpigraphCoordinatorOutboxStore(
    private val coordinator: EpigraphMutationCoordinator,
    private val json: Json = Json,
) : CoreOutboxStore {
    override suspend fun claimReady(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
    ): List<ClaimedCoreOutboxRecord> = coordinator.claimReady(
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

    override suspend fun claimReadyForScopes(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
        scopeIds: Set<String>,
    ): List<ClaimedCoreOutboxRecord> = coordinator.claimReadyForScopes(
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

    override suspend fun acknowledge(
        record: CoreOutboxRecord,
        result: CoreMutationResult,
        receivedAtEpochMillis: Long,
    ) {
        val serverVersion = requireNotNull(result.appliedServerVersion) {
            "accepted Core result must include a server version"
        }
        coordinator.acknowledge(
            EpigraphMutationAcknowledgement(
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
            ),
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
