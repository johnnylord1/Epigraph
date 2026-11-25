package epigraph.sync.core.outbox

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreMutationResult
import epigraph.sync.core.protocol.CoreMutationsRequest
import epigraph.sync.core.protocol.CoreMutationsResponse
import java.util.UUID
import kotlinx.serialization.json.JsonObject

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

    /** Settles the acknowledged rows of one Core response; stores that can do it in one transaction. */
    suspend fun acknowledgeAll(
        acknowledged: List<CoreOutboxAcknowledgedRecord>,
        receivedAtEpochMillis: Long,
    ) {
        acknowledged.forEach { acknowledge(it.record, it.result, receivedAtEpochMillis) }
    }

    /**
     * Settles like [acknowledgeAll], but a store may do it in the background while the next batch
     * is on the network. The rows stay leased, so no claim takes them again, and pending, so nothing
     * reports them synced, until they are settled. [awaitAcknowledgements] waits for that and
     * rethrows a failure; a row left unsettled is resent after its lease, and Core dedupes it.
     */
    suspend fun acknowledgeAllInBackground(
        acknowledged: List<CoreOutboxAcknowledgedRecord>,
        receivedAtEpochMillis: Long,
    ) = acknowledgeAll(acknowledged, receivedAtEpochMillis)

    /** Waits for every settlement [acknowledgeAllInBackground] started, rethrowing a failure. */
    suspend fun awaitAcknowledgements() {}

    /**
     * Waits until every acknowledged write is confirmed locally too. A store may confirm them in the
     * background, while the next batch is on the network; the outbox rows are settled already.
     */
    suspend fun awaitConfirmations() {}

    /** Releases the lease but deliberately keeps the row pending/error. */
    suspend fun markFailed(
        identity: CoreOutboxIdentity,
        errorCode: String,
        nextAttemptAtEpochMillis: Long,
    )
}

data class CoreOutboxAcknowledgedRecord(
    val record: CoreOutboxRecord,
    val result: CoreMutationResult,
    /** The paired Core that acknowledged it, so its record can be confirmed as that Core's state. */
    val originServerId: String? = null,
    /** The patch this device sent, to tell an echo of local state from a merged record. */
    val sentPatch: JsonObject? = null,
)

/** This port must return a durable, strictly increasing value; wall-clock time is forbidden. */
fun interface CoreLamportSource {
    suspend fun nextLamport(): Long

    /**
     * Reserves [count] strictly increasing values. Durable sources should override this to
     * reserve the whole range in one write instead of one transaction per mutation.
     */
    suspend fun nextLamports(count: Int): List<Long> = List(count) { nextLamport() }
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

    /** [gzipBody] is set only for a Core that advertises `supportsGzipRequestBodiesV1`. */
    suspend fun submit(
        accessToken: String,
        request: CoreMutationsRequest,
        gzipBody: Boolean,
    ): CoreHttpResult<CoreMutationsResponse> = submit(accessToken, request)
}

class EpigraphCoreMutationGateway(
    private val client: EpigraphCoreHttpClient,
) : CoreMutationGateway {
    override suspend fun submit(
        accessToken: String,
        request: CoreMutationsRequest,
    ): CoreHttpResult<CoreMutationsResponse> = client.mutations(accessToken, request)

    override suspend fun submit(
        accessToken: String,
        request: CoreMutationsRequest,
        gzipBody: Boolean,
    ): CoreHttpResult<CoreMutationsResponse> = client.mutations(accessToken, request, gzipBody)
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
    val originServerId: String? = null,
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
    // Per-request costs (claim, acknowledge, network round trip) dominate small batches. The Core
    // body limit is 2 MiB; an oversized request is isolated mutation by mutation, never dropped.
    val claimLimit: Long = 250,
    // A Core that takes gzip bodies also takes 16 MiB of inflated JSON per request, and on a slow
    // Wi-Fi every round trip a first sync saves is worth more than a smaller batch.
    val gzipClaimLimit: Long = 1_000,
    val leaseDurationMillis: Long = 60_000,
) {
    init {
        require(claimLimit > 0)
        require(gzipClaimLimit > 0)
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

private fun String.isCanonicalProtocolIdentifier(): Boolean =
    isNotBlank() && this == trim() && length <= MAX_PROTOCOL_IDENTIFIER_LENGTH && none(Char::isISOControl)

private const val MAX_PROTOCOL_IDENTIFIER_LENGTH = 512
