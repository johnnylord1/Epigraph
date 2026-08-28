package epigraph.sync.core.outbox

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreMutationDisposition
import epigraph.sync.core.protocol.CoreMutationInput
import epigraph.sync.core.protocol.CoreMutationReceiptPolicy
import epigraph.sync.core.protocol.CoreMutationResult
import epigraph.sync.core.protocol.CoreMutationsRequest
import epigraph.sync.core.protocol.CoreMutationsResponse
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

data class ClaimedCoreOutboxRecord(
    val sequence: Long,
    val attemptCount: Long,
    val record: CoreOutboxRecord,
) {
    init {
        require(sequence >= 0) { "outbox sequence must not be negative" }
        require(attemptCount > 0) { "a claimed row must have a positive attempt count" }
    }
}

/** Durable outbox boundary. Claiming must lease rows in ascending sequence order. */
interface CoreOutboxStore {
    suspend fun claimReady(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
    ): List<ClaimedCoreOutboxRecord>

    suspend fun claimReadyForScopes(
        nowEpochMillis: Long,
        leaseDurationMillis: Long,
        limit: Long,
        scopeIds: Set<String>,
    ): List<ClaimedCoreOutboxRecord> = claimReady(
        nowEpochMillis,
        leaseDurationMillis,
        limit,
    ).filter { it.record.scopeId in scopeIds }

    suspend fun acknowledge(
        record: CoreOutboxRecord,
        result: CoreMutationResult,
        receivedAtEpochMillis: Long,
    )

    /** Releases the lease but deliberately keeps the row pending/error. */
    suspend fun markFailed(
        identity: CoreOutboxIdentity,
        errorCode: String,
        nextAttemptAtEpochMillis: Long,
    )
}

/** This port must return a durable, strictly increasing value; wall-clock time is forbidden. */
fun interface CoreLamportSource {
    suspend fun nextLamport(): Long
}

fun interface CoreRequestIdSource {
    fun nextRequestId(): String
}

class UuidCoreRequestIdSource : CoreRequestIdSource {
    override fun nextRequestId(): String = UUID.randomUUID().toString()
}

fun interface CoreMutationGateway {
    suspend fun submit(
        accessToken: String,
        request: CoreMutationsRequest,
    ): CoreHttpResult<CoreMutationsResponse>
}

class EpigraphCoreMutationGateway(
    private val client: EpigraphCoreHttpClient,
) : CoreMutationGateway {
    override suspend fun submit(
        accessToken: String,
        request: CoreMutationsRequest,
    ): CoreHttpResult<CoreMutationsResponse> = client.mutations(accessToken, request)
}

/** Supplies a short-lived token copy and owns wiping it after the request. */
interface CoreAccessTokenLease {
    suspend fun <T> use(block: suspend (String) -> T): T
}

class CredentialCoreAccessTokenLease(
    private val credentials: CoreCredentialSession,
) : CoreAccessTokenLease {
    override suspend fun <T> use(block: suspend (String) -> T): T =
        credentials.withAccessTokenString(block)

    override fun toString(): String = "CredentialCoreAccessTokenLease(accessToken=<redacted>)"
}

/** Authorization is explicit per drain and never renders the bearer token. */
class CoreOutboxAuthorization(
    val authenticatedDeviceId: String,
    grantedScopes: Set<String>,
    private val tokenLease: CoreAccessTokenLease,
) {
    val grantedScopes: Set<String> = grantedScopes.toSet()

    init {
        require(authenticatedDeviceId.isCanonicalProtocolIdentifier()) {
            "authenticatedDeviceId must be a canonical protocol identifier"
        }
        require(this.grantedScopes.isNotEmpty()) { "at least one granted scope is required" }
        require(this.grantedScopes.all { it.isCanonicalProtocolIdentifier() }) {
            "granted scopes must be canonical protocol identifiers"
        }
    }

    internal suspend fun <T> useAccessToken(block: suspend (String) -> T): T = tokenLease.use(block)

    override fun toString(): String =
        "CoreOutboxAuthorization(authenticatedDeviceId=$authenticatedDeviceId, " +
            "grantedScopes=$grantedScopes, accessToken=<redacted>)"
}

fun interface CoreOutboxRetryPlanner {
    fun nextAttemptAt(
        nowEpochMillis: Long,
        attemptCount: Long,
        errorCode: String,
    ): Long
}

/** Capped deterministic backoff; attempt count comes from the durable outbox, not memory. */
class ExponentialCoreOutboxRetryPlanner(
    private val initialDelayMillis: Long = 5_000,
    private val maximumDelayMillis: Long = 15 * 60_000,
) : CoreOutboxRetryPlanner {
    init {
        require(initialDelayMillis > 0)
        require(maximumDelayMillis >= initialDelayMillis)
    }

    override fun nextAttemptAt(
        nowEpochMillis: Long,
        attemptCount: Long,
        errorCode: String,
    ): Long {
        require(nowEpochMillis >= 0)
        require(attemptCount > 0)
        val shift = (attemptCount - 1).coerceAtMost(30).toInt()
        val multiplier = 1L shl shift
        val delay = if (initialDelayMillis > maximumDelayMillis / multiplier) {
            maximumDelayMillis
        } else {
            (initialDelayMillis * multiplier).coerceAtMost(maximumDelayMillis)
        }
        return if (nowEpochMillis > Long.MAX_VALUE - delay) Long.MAX_VALUE else nowEpochMillis + delay
    }
}

data class CoreOutboxDrainConfig(
    val claimLimit: Long = 50,
    val leaseDurationMillis: Long = 60_000,
) {
    init {
        require(claimLimit > 0)
        require(leaseDurationMillis > 0)
    }
}

data class CoreOutboxDrainReport(
    val claimed: Int,
    val submitted: Int,
    val acknowledged: Int,
    val retryScheduled: Int,
    val blocked: Int,
)

/**
 * One ordered, fail-closed outbox pass against the existing legacy-compatible Syncd wire protocol v1.
 *
 * The endpoint is non-atomic: every response is matched by clientMutationId and settled
 * independently. A transport/protocol failure releases every still-leased ready row.
 */
class CoreOutboxDrainer(
    private val store: CoreOutboxStore,
    private val adapter: CoreV1OutboxAdapter,
    private val gateway: CoreMutationGateway,
    private val lamports: CoreLamportSource,
    private val requestIds: CoreRequestIdSource,
    private val retryPlanner: CoreOutboxRetryPlanner = ExponentialCoreOutboxRetryPlanner(),
    private val config: CoreOutboxDrainConfig = CoreOutboxDrainConfig(),
) {
    suspend fun drain(
        authorization: CoreOutboxAuthorization,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreOutboxDrainReport {
        require(nowEpochMillis >= 0) { "drain timestamp must be epoch milliseconds" }
        val claimed = store.claimReadyForScopes(
            nowEpochMillis = nowEpochMillis,
            leaseDurationMillis = config.leaseDurationMillis,
            limit = config.claimLimit,
            scopeIds = authorization.grantedScopes,
        )
        if (claimed.isEmpty()) return CoreOutboxDrainReport(0, 0, 0, 0, 0)

        val ordered = claimed.sortedBy { it.sequence }
        if (ordered.hasDuplicateClaims()) {
            ordered.forEach { it.release("invalid_claim_set", nowEpochMillis) }
            return CoreOutboxDrainReport(ordered.size, 0, 0, ordered.size, 0)
        }

        val ready = mutableListOf<ReadyClaim>()
        var blocked = 0
        var preSubmitRetries = 0
        var previousLamport: Long? = null
        for (claim in ordered) {
            if (claim.record.scopeId !in authorization.grantedScopes) {
                claim.release("scope_paused", nowEpochMillis)
                preSubmitRetries += 1
                continue
            }

            val lamport = try {
                lamports.nextLamport()
            } catch (cancelled: CancellationException) {
                releaseAfterCancellation(ready, ordered.dropWhile { it !== claim }, nowEpochMillis)
                throw cancelled
            } catch (_: Throwable) {
                // Storage/allocator failures are transient. Never strand the row as a permanent
                // capability block merely because the durable Lamport source is unavailable.
                claim.release("lamport_source_failure", nowEpochMillis)
                preSubmitRetries += 1
                continue
            }
            if (lamport < 0 || previousLamport?.let { lamport <= it } == true) {
                claim.block("lamport_not_monotonic")
                blocked += 1
                continue
            }
            previousLamport = lamport

            val adaptation = try {
                adapter.adapt(
                    record = claim.record,
                    authenticatedDeviceId = authorization.authenticatedDeviceId,
                    capabilities = capabilities,
                    lamport = lamport,
                    eventLogical = claim.sequence,
                )
            } catch (_: Throwable) {
                claim.block("outbox_adaptation_failure")
                blocked += 1
                continue
            }
            when (adaptation) {
                is CoreOutboxAdaptation.Ready -> ready += ReadyClaim(claim, adaptation.mutation)
                is CoreOutboxAdaptation.Blocked -> {
                    claim.block(adaptation.errorCode)
                    blocked += 1
                }
            }
        }

        if (ready.isEmpty()) {
            return CoreOutboxDrainReport(ordered.size, 0, 0, preSubmitRetries, blocked)
        }

        val requestId = runCatching { requestIds.nextRequestId() }.getOrNull()
        if (requestId == null || !requestId.isCanonicalProtocolIdentifier()) {
            ready.forEach { it.claim.release("invalid_request_id", nowEpochMillis) }
            return CoreOutboxDrainReport(ordered.size, 0, 0, preSubmitRetries + ready.size, blocked)
        }
        val request = CoreMutationsRequest(requestId, ready.map(ReadyClaim::mutation))
        val response = try {
            authorization.useAccessToken { gateway.submit(it, request) }
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) {
                ready.forEach { it.claim.release("transport_cancelled", nowEpochMillis) }
            }
            throw cancelled
        } catch (_: Throwable) {
            ready.forEach { it.claim.release("core_transport_failure", nowEpochMillis) }
            return CoreOutboxDrainReport(ordered.size, ready.size, 0, preSubmitRetries + ready.size, blocked)
        }

        val body = when (response) {
            is CoreHttpResult.Failure -> {
                val errorCode = "core_http_${response.statusCode}"
                ready.forEach { it.claim.release(errorCode, nowEpochMillis) }
                return CoreOutboxDrainReport(
                    ordered.size,
                    ready.size,
                    0,
                    preSubmitRetries + ready.size,
                    blocked,
                )
            }
            is CoreHttpResult.Success -> response.value
        }
        if (!body.matches(request)) {
            ready.forEach { it.claim.release("invalid_core_response", nowEpochMillis) }
            return CoreOutboxDrainReport(ordered.size, ready.size, 0, preSubmitRetries + ready.size, blocked)
        }

        val decisions = try {
            CoreMutationReceiptPolicy.reconcile(
                requestedMutationIds = ready.map { it.mutation.clientMutationId },
                response = body,
            )
        } catch (_: IllegalArgumentException) {
            ready.forEach { it.claim.release("invalid_core_response", nowEpochMillis) }
            return CoreOutboxDrainReport(ordered.size, ready.size, 0, preSubmitRetries + ready.size, blocked)
        }
        val readyById = ready.associateBy { it.mutation.clientMutationId }
        val resultById = body.results.associateBy { it.clientMutationId }
        var acknowledged = 0
        var retries = preSubmitRetries
        decisions.forEach { decision ->
            val item = readyById.getValue(decision.clientMutationId)
            when (decision.disposition) {
                CoreMutationDisposition.ACKNOWLEDGE -> {
                    val result = resultById.getValue(decision.clientMutationId)
                    if (
                        !result.matches(item.mutation) ||
                        !decision.canonicalEntityId.isValidOptionalIdentifier() ||
                        result.appliedServerVersion == null ||
                        result.appliedServerVersion < 0 ||
                        result.appliedLamport?.let { it < 0 } == true
                    ) {
                        item.claim.release("invalid_core_result", nowEpochMillis)
                        retries += 1
                    } else {
                        store.acknowledge(
                            record = item.claim.record,
                            result = result,
                            receivedAtEpochMillis = nowEpochMillis,
                        )
                        acknowledged += 1
                    }
                }

                CoreMutationDisposition.RETRY -> {
                    item.claim.release(decision.errorCode.safeErrorCode("core_retry"), nowEpochMillis)
                    retries += 1
                }

                CoreMutationDisposition.BLOCK -> {
                    item.claim.block(decision.errorCode.safeErrorCode("core_rejected"))
                    blocked += 1
                }
            }
        }
        return CoreOutboxDrainReport(ordered.size, ready.size, acknowledged, retries, blocked)
    }

    private suspend fun ClaimedCoreOutboxRecord.release(errorCode: String, nowEpochMillis: Long) {
        store.markFailed(
            identity = record.identity(),
            errorCode = errorCode.safeErrorCode("outbox_retry"),
            nextAttemptAtEpochMillis = retryPlanner.nextAttemptAt(
                nowEpochMillis,
                attemptCount,
                errorCode,
            ),
        )
    }

    private suspend fun ClaimedCoreOutboxRecord.block(errorCode: String) {
        store.markFailed(
            identity = record.identity(),
            errorCode = "blocked:${errorCode.safeErrorCode("unknown")}".take(MAX_ERROR_CODE_LENGTH),
            nextAttemptAtEpochMillis = Long.MAX_VALUE,
        )
    }

    private suspend fun releaseAfterCancellation(
        ready: List<ReadyClaim>,
        remaining: List<ClaimedCoreOutboxRecord>,
        nowEpochMillis: Long,
    ) = withContext(NonCancellable) {
        ready.forEach { it.claim.release("drain_cancelled", nowEpochMillis) }
        remaining.forEach { it.release("drain_cancelled", nowEpochMillis) }
    }

    private data class ReadyClaim(
        val claim: ClaimedCoreOutboxRecord,
        val mutation: CoreMutationInput,
    )
}

private fun List<ClaimedCoreOutboxRecord>.hasDuplicateClaims(): Boolean =
    map { it.sequence }.distinct().size != size ||
        map { it.record.identity() }.distinct().size != size

private fun CoreOutboxRecord.identity() = CoreOutboxIdentity(deviceId, clientMutationId)

private fun CoreMutationsResponse.matches(request: CoreMutationsRequest): Boolean {
    if (requestId != request.requestId) return false
    val requestedIds = request.mutations.map { it.clientMutationId }.toSet()
    return results.all { it.clientMutationId in requestedIds }
}

private fun CoreMutationResult.matches(input: CoreMutationInput): Boolean =
    clientMutationId == input.clientMutationId &&
        entityType == input.entityType &&
        entityId == input.entityId &&
        scopeId == input.scopeId &&
        op == input.op

private fun String?.isValidOptionalIdentifier(): Boolean = this == null || isCanonicalProtocolIdentifier()

private fun String.isCanonicalProtocolIdentifier(): Boolean =
    isNotBlank() && this == trim() && length <= MAX_PROTOCOL_IDENTIFIER_LENGTH && none(Char::isISOControl)

private fun String?.safeErrorCode(fallback: String): String {
    val candidate = this?.takeIf {
        it.isNotBlank() && it == it.trim() && it.length <= MAX_ERROR_CODE_LENGTH &&
            it.all { character -> character.isLetterOrDigit() || character in "._:-" }
    }
    return candidate ?: fallback
}

private const val MAX_PROTOCOL_IDENTIFIER_LENGTH = 512
private const val MAX_ERROR_CODE_LENGTH = 256
