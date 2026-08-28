package epigraph.sync

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphIdentityRules
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncScopeId
import epigraph.contract.operationWireName
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import tachiyomi.data.Aethon_sync_outbox
import yokai.data.Database
import yokai.data.DatabaseHandler

/**
 * The only supported entry point for a local mutation that must be synchronized.
 *
 * [domainMutation] and the outbox insert share the same SQLDelight transaction: either both are
 * durable, or neither is. Remote replay deliberately uses a different method so it cannot echo an
 * incoming event back into the outbox.
 */
class EpigraphMutationCoordinator(
    private val databaseHandler: DatabaseHandler,
    private val json: Json = Json {
        classDiscriminator = "operation"
        encodeDefaults = true
        ignoreUnknownKeys = false
    },
    /** Best-effort notification used by Android to wake the Core worker immediately. */
    private val onLocalMutationEnqueued: (() -> Unit)? = null,
) {
    /** Read-only access for sync-aware domain routers; never writes an outbox row. */
    suspend fun <T> readLocal(query: Database.() -> T): T = databaseHandler.await {
        query()
    }

    suspend fun <T> mutateLocal(
        envelope: SyncCommandEnvelope,
        createdAtEpochMillis: Long,
        domainMutation: suspend Database.() -> T,
    ): T {
        require(createdAtEpochMillis >= 0) { "mutation timestamp must be epoch milliseconds" }
        return mutateLocalBatch(createdAtEpochMillis) {
            LocalMutationResult(domainMutation(), listOf(envelope))
        }
    }

    /**
     * Runs reads, domain writes, diff calculation, and zero or more outbox inserts atomically.
     * Envelopes are intentionally produced inside [domainMutation] so callers never compare stale
     * state outside the transaction (for example favorite + category assignment changes).
     */
    suspend fun <T> mutateLocalBatch(
        createdAtEpochMillis: Long,
        domainMutation: suspend Database.() -> LocalMutationResult<T>,
    ): T {
        require(createdAtEpochMillis >= 0) { "mutation timestamp must be epoch milliseconds" }

        val transactionResult = databaseHandler.await(inTransaction = true) {
            val mutation = domainMutation()
            val idempotencyKeys = mutation.envelopes.map { it.deviceId.value to it.clientMutationId.value } +
                mutation.suwayomiMutations.map { "suwayomi" to it.operationId }
            require(idempotencyKeys.distinct().size == idempotencyKeys.size) {
                "a local mutation batch must not contain duplicate idempotency keys"
            }

            mutation.envelopes.forEach { envelope ->
                aethon_syncQueries.enqueueMutation(
                    clientMutationId = envelope.clientMutationId.value,
                    deviceId = envelope.deviceId.value,
                    scopeId = envelope.scopeId.value,
                    entityType = envelope.entityType.value,
                    entityId = envelope.command.entityId.value,
                    operation = envelope.command.operationWireName(),
                    payloadJson = json.encodeToString(envelope),
                    createdAt = createdAtEpochMillis,
                    nextAttemptAt = createdAtEpochMillis,
                )
            }
            mutation.suwayomiMutations.forEach { intent ->
                aethon_suwayomi_mutation_queueQueries.enqueue(
                    operationId = intent.operationId,
                    profileId = intent.profileId,
                    operationName = intent.operationName,
                    variablesJson = intent.variablesJson,
                    entityId = intent.entityId,
                    createdAt = intent.createdAtEpochMillis,
                    nextAttemptAt = intent.createdAtEpochMillis,
                )
            }
            mutation.value to (mutation.envelopes.isNotEmpty() || mutation.suwayomiMutations.isNotEmpty())
        }
        // The domain write and outbox insert are already durable. A scheduler failure must not
        // turn a successful local mutation into an error or cause the caller to retry it twice.
        if (transactionResult.second) {
            runCatching { onLocalMutationEnqueued?.invoke() }
        }
        return transactionResult.first
    }

    suspend fun applyRemoteEvent(
        scopeId: SyncScopeId,
        eventId: String,
        serverRevision: Long,
        payloadSha256: String,
        cursor: String,
        schemaVersion: Long,
        appliedAtEpochMillis: Long,
        domainMutation: suspend Database.() -> Unit,
    ): Boolean {
        require(eventId.isNotBlank()) { "event ID must not be blank" }
        require(serverRevision >= 0) { "server revision must not be negative" }
        require(schemaVersion > 0) { "schema version must be positive" }
        require(appliedAtEpochMillis >= 0) { "event timestamp must be epoch milliseconds" }
        val canonicalPayloadHash = EpigraphIdentityRules.canonicalSha256(payloadSha256)

        return databaseHandler.await(inTransaction = true) {
            if (aethon_syncQueries.isInboxEventApplied(scopeId.value, eventId).executeAsOne()) {
                return@await false
            }

            domainMutation()
            aethon_syncQueries.recordInboxEvent(
                scopeId = scopeId.value,
                eventId = eventId,
                serverRevision = serverRevision,
                payloadSha256 = canonicalPayloadHash,
                appliedAt = appliedAtEpochMillis,
            )
            aethon_syncQueries.upsertCheckpoint(
                scopeId = scopeId.value,
                cursor = cursor,
                schemaVersion = schemaVersion,
                snapshotAt = null,
                updatedAt = appliedAtEpochMillis,
            )
            true
        }
    }

    suspend fun acknowledge(acknowledgement: EpigraphMutationAcknowledgement) {
        databaseHandler.await(inTransaction = true) {
            aethon_syncQueries.upsertReceipt(
                deviceId = acknowledgement.deviceId.value,
                clientMutationId = acknowledgement.clientMutationId.value,
                canonicalEntityId = acknowledgement.canonicalEntityId?.value,
                receivedAt = acknowledgement.receivedAtEpochMillis,
            )
            aethon_syncQueries.upsertReplicaWait(
                deviceId = acknowledgement.deviceId.value,
                clientMutationId = acknowledgement.clientMutationId.value,
                scopeId = acknowledgement.scopeId.value,
                entityType = acknowledgement.entityType,
                entityId = acknowledgement.entityId.value,
                canonicalEntityId = acknowledgement.canonicalEntityId?.value,
                resultStatus = acknowledgement.resultStatus,
                requiredServerVersion = acknowledgement.requiredServerVersion,
                appliedLamport = acknowledgement.appliedLamport,
                eventClockJson = acknowledgement.eventClockJson,
                canonicalRecordSha256 = acknowledgement.canonicalRecordSha256,
                receivedAt = acknowledgement.receivedAtEpochMillis,
            )
            aethon_syncQueries.deleteAcknowledgedMutation(
                acknowledgement.deviceId.value,
                acknowledgement.clientMutationId.value,
            )
        }
    }

    /**
     * Releases an in-flight row after a transport or capability failure.
     * The row stays in the outbox, so the UI cannot report a synchronized state.
     */
    suspend fun markFailed(
        deviceId: DeviceId,
        clientMutationId: ClientMutationId,
        errorCode: String,
        nextAttemptAtEpochMillis: Long,
    ) {
        require(errorCode.isNotBlank()) { "error code must not be blank" }
        require(errorCode.length <= 256) { "error code is too long" }
        require(errorCode.none(Char::isISOControl)) { "error code must not contain control characters" }
        require(nextAttemptAtEpochMillis >= 0) { "next attempt timestamp must be epoch milliseconds" }

        databaseHandler.await(inTransaction = true) {
            aethon_syncQueries.markMutationFailed(
                nextAttemptAt = nextAttemptAtEpochMillis,
                lastError = errorCode,
                deviceId = deviceId.value,
                clientMutationId = clientMutationId.value,
            )
        }
    }

    suspend fun pendingCount(): Long = databaseHandler.await {
        aethon_syncQueries.pendingMutationCount().executeAsOne()
    }

    suspend fun pendingCount(scopeIds: Set<String>): Long {
        if (scopeIds.isEmpty()) return 0
        return databaseHandler.await {
            aethon_syncQueries.pendingMutationCountForScopes(scopeIds).executeAsOne()
        }
    }

    suspend fun unsettledCount(): Long = databaseHandler.await {
        aethon_syncQueries.unsettledMutationCount().executeAsOne()
    }

    suspend fun unsettledCount(scopeIds: Set<String>): Long {
        if (scopeIds.isEmpty()) return 0
        return databaseHandler.await {
            aethon_syncQueries.unsettledMutationCountForScopes(scopeIds).executeAsOne()
        }
    }

    suspend fun claimReady(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
    ): List<Aethon_sync_outbox> {
        require(nowEpochMillis >= 0) { "claim timestamp must be epoch milliseconds" }
        require(leaseDurationMillis > 0) { "lease duration must be positive" }
        require(limit > 0) { "claim limit must be positive" }
        require(nowEpochMillis <= Long.MAX_VALUE - leaseDurationMillis) { "lease timestamp overflow" }
        val leaseUntil = nowEpochMillis + leaseDurationMillis

        return databaseHandler.await(inTransaction = true) {
            aethon_syncQueries.recoverExpiredMutations(nowEpochMillis)
            aethon_syncQueries.selectReadyMutations(nowEpochMillis, limit).executeAsList().also { rows ->
                rows.forEach { row ->
                    aethon_syncQueries.markMutationInFlight(
                        inFlightAt = nowEpochMillis,
                        leaseUntil = leaseUntil,
                        deviceId = row.device_id,
                        clientMutationId = row.client_mutation_id,
                    )
                }
            }
        }
    }

    suspend fun claimReadyForScopes(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
        scopeIds: Set<String>,
    ): List<Aethon_sync_outbox> {
        require(scopeIds.isNotEmpty()) { "at least one active scope is required" }
        require(scopeIds.none(String::isBlank)) { "active scopes must not be blank" }
        require(nowEpochMillis >= 0) { "claim timestamp must be epoch milliseconds" }
        require(leaseDurationMillis > 0) { "lease duration must be positive" }
        require(limit > 0) { "claim limit must be positive" }
        require(nowEpochMillis <= Long.MAX_VALUE - leaseDurationMillis) { "lease timestamp overflow" }
        val leaseUntil = nowEpochMillis + leaseDurationMillis

        return databaseHandler.await(inTransaction = true) {
            aethon_syncQueries.recoverExpiredMutations(nowEpochMillis)
            aethon_syncQueries.selectReadyMutationsForScopes(
                scopeIds,
                nowEpochMillis,
                limit,
            ).executeAsList().also { rows ->
                rows.forEach { row ->
                    aethon_syncQueries.markMutationInFlight(
                        inFlightAt = nowEpochMillis,
                        leaseUntil = leaseUntil,
                        deviceId = row.device_id,
                        clientMutationId = row.client_mutation_id,
                    )
                }
            }
        }
    }
}

data class LocalMutationResult<T>(
    val value: T,
    val envelopes: List<SyncCommandEnvelope>,
    val suwayomiMutations: List<SuwayomiMutationIntent> = emptyList(),
)

data class EpigraphMutationAcknowledgement(
    val deviceId: DeviceId,
    val clientMutationId: ClientMutationId,
    val scopeId: SyncScopeId,
    val entityType: String,
    val entityId: EpigraphEntityId,
    val canonicalEntityId: EpigraphEntityId?,
    val resultStatus: String,
    val requiredServerVersion: Long,
    val appliedLamport: Long?,
    val eventClockJson: String?,
    val canonicalRecordSha256: String?,
    val receivedAtEpochMillis: Long,
) {
    init {
        require(entityType.isNotBlank()) { "receipt entity type must not be blank" }
        require(resultStatus == "APPLIED" || resultStatus == "SUPERSEDED") {
            "receipt result must be accepted"
        }
        require(requiredServerVersion >= 0) { "receipt server version must not be negative" }
        require(appliedLamport == null || appliedLamport >= 0) { "receipt Lamport value must not be negative" }
        canonicalRecordSha256?.let { hash ->
            require(hash == EpigraphIdentityRules.canonicalSha256(hash)) {
                "receipt record hash must be canonical SHA-256"
            }
        }
        require(receivedAtEpochMillis >= 0) { "receipt timestamp must be epoch milliseconds" }
    }
}
