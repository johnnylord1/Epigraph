package epigraph.sync.core.outbox

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.protocol.CoreMutationDisposition
import epigraph.sync.core.protocol.CoreMutationInput
import epigraph.sync.core.protocol.CoreMutationReceiptPolicy
import epigraph.sync.core.protocol.CoreMutationResult
import epigraph.sync.core.protocol.CoreMutationsRequest
import epigraph.sync.core.protocol.CoreMutationsResponse
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
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
    /** Waits until the writes acknowledged so far are confirmed locally too. */
    suspend fun awaitConfirmations() = store.awaitConfirmations()

    /**
     * The next batch, claimed and adapted while the previous one was on the network. Its rows stay
     * leased until a drain with the same authorization sends them or [releasePrepared] frees them.
     */
    private val prepared = AtomicReference<Prepared?>(null)

    /** Frees the rows of a batch prepared ahead, for a caller that stops draining. */
    suspend fun releasePrepared() {
        prepared.getAndSet(null)?.releaseNow()
    }

    suspend fun drain(
        authorization: CoreOutboxAuthorization,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreOutboxDrainReport {
        require(nowEpochMillis >= 0) { "drain timestamp must be epoch milliseconds" }
        val ahead = prepared.getAndSet(null)
        val current = if (ahead != null && ahead.authorization === authorization && ahead.capabilities == capabilities) {
            ahead
        } else {
            ahead?.releaseNow()
            prepare(authorization, capabilities, nowEpochMillis)
        }
        // The last batch of a backlog settles everything before returning: the caller counts the
        // outbox next, and a row still settling in the background would read as left behind.
        if (current.ready.isEmpty()) {
            store.awaitAcknowledgements()
            return current.report(Settlement())
        }
        if (!current.full) {
            val settled = send(current)
            store.awaitAcknowledgements()
            return current.report(settled)
        }

        // A full batch means more rows wait. Claiming and adapting them is local work that would
        // otherwise idle while this request is on the network, so it runs alongside it.
        return coroutineScope {
            val next = async { prepare(authorization, capabilities, nowEpochMillis) }
            // ATOMIC: once claimed, a send always starts, so a cancellation still releases its rows.
            val first = async(start = CoroutineStart.ATOMIC) { runCatching { send(current) } }
            val upcoming = next.awaitOrNull()
            if (upcoming == null || !canOverlap(current, upcoming)) {
                val settled = first.await().getOrElse { failure ->
                    withContext(NonCancellable) { upcoming?.releaseNow() }
                    throw failure
                }
                when {
                    upcoming == null || upcoming.claimed == 0 -> Unit
                    // The caller stops after a batch that settles nothing, so the rows must not stay leased.
                    settled.acknowledged + settled.blocked == 0 -> upcoming.releaseNow()
                    else -> prepared.getAndSet(upcoming)?.releaseNow()
                }
                return@coroutineScope current.report(settled)
            }

            // Both batches hold only order-free records with no record in common, so the Core may
            // apply them in either order: the second goes out without waiting for the first answer.
            val second = async(start = CoroutineStart.ATOMIC) { runCatching { send(upcoming) } }
            val following = if (upcoming.full) async { prepare(authorization, capabilities, nowEpochMillis) } else null
            val firstSettled = first.await()
            val secondSettled = second.await()
            val failure = firstSettled.exceptionOrNull() ?: secondSettled.exceptionOrNull()
            if (failure != null) {
                withContext(NonCancellable) { following?.awaitOrNull()?.releaseNow() }
                throw failure
            }
            val a = firstSettled.getOrThrow()
            val b = secondSettled.getOrThrow()
            val after = following?.awaitOrNull()
            when {
                // The second batch was the last one: settle everything before the caller counts.
                following == null -> store.awaitAcknowledgements()
                after == null || after.claimed == 0 -> Unit
                a.acknowledged + a.blocked + b.acknowledged + b.blocked == 0 -> after.releaseNow()
                else -> prepared.getAndSet(after)?.releaseNow()
            }
            current.report(a) + upcoming.report(b)
        }
    }

    /**
     * Two batches may be on the network together only when their order cannot matter: each holds
     * reader-state records that depend on nothing but their entry (sent and answered before them, in
     * outbox order), and no record appears in both. Anything else goes out one batch at a time.
     */
    private fun canOverlap(current: Prepared, upcoming: Prepared): Boolean {
        if (current.ready.isEmpty() || upcoming.ready.isEmpty()) return false
        if (current.authorization !== upcoming.authorization) return false
        val orderFree = { claim: ReadyClaim -> claim.mutation.entityType in ORDER_FREE_ENTITY_TYPES }
        if (!current.ready.all(orderFree) || !upcoming.ready.all(orderFree)) return false
        val keys = current.ready.mapTo(HashSet()) { it.mutation.recordKey() }
        return upcoming.ready.none { it.mutation.recordKey() in keys }
    }

    private suspend fun Deferred<Prepared>.awaitOrNull(): Prepared? = try {
        await()
    } catch (cancelled: CancellationException) {
        if (!currentCoroutineContext().isActive) throw cancelled
        null
    } catch (_: Throwable) {
        // A failed claim leaves nothing leased; the next drain claims again.
        null
    }

    private suspend fun prepare(
        authorization: CoreOutboxAuthorization,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): Prepared {
        val limit = if (capabilities.supportsGzipRequestBodiesV1) config.gzipClaimLimit else config.claimLimit
        val claimed = store.claimReadyForScopes(
            nowEpochMillis = nowEpochMillis,
            leaseDurationMillis = config.leaseDurationMillis,
            limit = limit,
            scopeIds = authorization.grantedScopes,
        )
        fun prepared(ready: List<ReadyClaim> = emptyList(), retries: Int = 0, blocked: Int = 0) = Prepared(
            authorization = authorization,
            capabilities = capabilities,
            nowEpochMillis = nowEpochMillis,
            claimed = claimed.size,
            full = claimed.size.toLong() >= limit,
            ready = ready,
            preSubmitRetries = retries,
            blocked = blocked,
        )
        if (claimed.isEmpty()) return prepared()

        val ordered = claimed.sortedBy { it.sequence }
        if (ordered.hasDuplicateClaims()) {
            ordered.forEach { it.release("invalid_claim_set", nowEpochMillis) }
            return prepared(retries = ordered.size)
        }

        val ready = mutableListOf<ReadyClaim>()
        var blocked = 0
        var preSubmitRetries = 0
        val eligible = ordered.filter { claim ->
            val inScope = claim.record.scopeId in authorization.grantedScopes
            if (!inScope) {
                claim.release("scope_paused", nowEpochMillis)
                preSubmitRetries += 1
            }
            inScope
        }
        val lamportValues = try {
            lamports.nextLamports(eligible.size).also {
                check(it.size == eligible.size) { "Lamport source returned ${it.size} of ${eligible.size} values" }
            }
        } catch (cancelled: CancellationException) {
            releaseAfterCancellation(emptyList(), eligible, nowEpochMillis)
            throw cancelled
        } catch (_: Throwable) {
            // Storage/allocator failures are transient. Never strand the rows as a permanent
            // capability block merely because the durable Lamport source is unavailable.
            eligible.forEach { it.release("lamport_source_failure", nowEpochMillis) }
            preSubmitRetries += eligible.size
            emptyList()
        }
        var previousLamport: Long? = null
        for ((claim, lamport) in eligible.zip(lamportValues)) {
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

        return prepared(ready, preSubmitRetries, blocked)
    }

    private suspend fun send(prepared: Prepared): Settlement {
        val gzipBody = prepared.capabilities.supportsGzipRequestBodiesV1
        val ready = prepared.ready
        val authorization = prepared.authorization
        val nowEpochMillis = prepared.nowEpochMillis
        val batch = submit(ready, authorization, nowEpochMillis, releaseOnRejectedRequest = ready.size == 1, gzipBody)
        return if (batch.rejectedRequest) {
            // The Core refused the request as a whole (malformed or oversized), so nothing in it was
            // applied. Resend each mutation alone: one bad command must not hold back every command
            // that shared its batch. The bad one stays pending with backoff, never dropped.
            isolate(ready, authorization, nowEpochMillis, gzipBody)
        } else {
            batch
        }
    }

    /** Claimed rows ready to send, plus what claiming them already settled. */
    private class Prepared(
        val authorization: CoreOutboxAuthorization,
        val capabilities: CoreCapabilities,
        val nowEpochMillis: Long,
        val claimed: Int,
        /** The claim reached its limit, so more rows are probably ready. */
        val full: Boolean,
        val ready: List<ReadyClaim>,
        val preSubmitRetries: Int,
        val blocked: Int,
    ) {
        fun report(settled: Settlement) = CoreOutboxDrainReport(
            claimed,
            settled.submitted,
            settled.acknowledged,
            preSubmitRetries + settled.retries,
            blocked + settled.blocked,
        )
    }

    /** Frees rows that were never sent, ready again at once: nothing failed. */
    private suspend fun Prepared.releaseNow() = withContext(NonCancellable) {
        ready.forEach {
            store.markFailed(it.claim.record.identity(), "drain_not_sent", nowEpochMillis)
        }
    }

    private suspend fun isolate(
        ready: List<ReadyClaim>,
        authorization: CoreOutboxAuthorization,
        nowEpochMillis: Long,
        gzipBody: Boolean,
    ): Settlement {
        var total = Settlement()
        ready.forEachIndexed { index, item ->
            try {
                total += submit(listOf(item), authorization, nowEpochMillis, releaseOnRejectedRequest = true, gzipBody)
            } catch (cancelled: CancellationException) {
                withContext(NonCancellable) {
                    ready.drop(index + 1).forEach { it.claim.release("drain_cancelled", nowEpochMillis) }
                }
                throw cancelled
            }
        }
        return total
    }

    /**
     * Submits [ready] as one request and settles every row. A request the Core rejects as a whole
     * leaves the rows leased when [releaseOnRejectedRequest] is false, so the caller can isolate them.
     */
    private suspend fun submit(
        ready: List<ReadyClaim>,
        authorization: CoreOutboxAuthorization,
        nowEpochMillis: Long,
        releaseOnRejectedRequest: Boolean,
        gzipBody: Boolean,
    ): Settlement {
        val requestId = runCatching { requestIds.nextRequestId() }.getOrNull()
        if (requestId == null || !requestId.isCanonicalProtocolIdentifier()) {
            ready.forEach { it.claim.release("invalid_request_id", nowEpochMillis) }
            return Settlement(retries = ready.size)
        }
        val request = CoreMutationsRequest(requestId, ready.map(ReadyClaim::mutation))
        val response = try {
            authorization.useAccessToken { gateway.submit(it, request, gzipBody) }
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable) {
                ready.forEach { it.claim.release("transport_cancelled", nowEpochMillis) }
            }
            throw cancelled
        } catch (_: Throwable) {
            ready.forEach { it.claim.release("core_transport_failure", nowEpochMillis) }
            return Settlement(submitted = ready.size, retries = ready.size)
        }

        val body = when (response) {
            is CoreHttpResult.Failure -> {
                if (response.statusCode in REJECTED_REQUEST_STATUSES && !releaseOnRejectedRequest) {
                    return Settlement(rejectedRequest = true)
                }
                val errorCode = "core_http_${response.statusCode}"
                ready.forEach { it.claim.release(errorCode, nowEpochMillis) }
                return Settlement(submitted = ready.size, retries = ready.size)
            }
            is CoreHttpResult.Success -> response.value
        }
        if (!body.matches(request)) {
            ready.forEach { it.claim.release("invalid_core_response", nowEpochMillis) }
            return Settlement(submitted = ready.size, retries = ready.size)
        }

        val decisions = try {
            CoreMutationReceiptPolicy.reconcile(
                requestedMutationIds = ready.map { it.mutation.clientMutationId },
                response = body,
            )
        } catch (_: IllegalArgumentException) {
            ready.forEach { it.claim.release("invalid_core_response", nowEpochMillis) }
            return Settlement(submitted = ready.size, retries = ready.size)
        }
        val readyById = ready.associateBy { it.mutation.clientMutationId }
        val resultById = body.results.associateBy { it.clientMutationId }
        val acknowledged = mutableListOf<CoreOutboxAcknowledgedRecord>()
        var retries = 0
        var blocked = 0
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
                        acknowledged += CoreOutboxAcknowledgedRecord(
                            item.claim.record,
                            result,
                            authorization.originServerId,
                            item.mutation.patch,
                        )
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
        // Settling a large response takes about as long as the request; the next one goes out meanwhile.
        store.acknowledgeAllInBackground(acknowledged, nowEpochMillis)
        return Settlement(ready.size, acknowledged.size, retries, blocked)
    }

    private data class Settlement(
        val submitted: Int = 0,
        val acknowledged: Int = 0,
        val retries: Int = 0,
        val blocked: Int = 0,
        val rejectedRequest: Boolean = false,
    ) {
        operator fun plus(other: Settlement) = Settlement(
            submitted + other.submitted,
            acknowledged + other.acknowledged,
            retries + other.retries,
            blocked + other.blocked,
        )
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

private fun CoreMutationInput.recordKey() = Triple(scopeId, entityType, entityId)

private operator fun CoreOutboxDrainReport.plus(other: CoreOutboxDrainReport) = CoreOutboxDrainReport(
    claimed + other.claimed,
    submitted + other.submitted,
    acknowledged + other.acknowledged,
    retryScheduled + other.retryScheduled,
    blocked + other.blocked,
)

/**
 * Reader state the Core applies per record, resolving only its entry. Entries, categories and
 * assignments refer to one another, so they always go out in outbox order.
 */
private val ORDER_FREE_ENTITY_TYPES = setOf(
    EpigraphCoreEntityType.COMIC_CHAPTER_STATE,
    EpigraphCoreEntityType.COMIC_HISTORY,
    EpigraphCoreEntityType.NOVEL_CHAPTER,
    EpigraphCoreEntityType.NOVEL_PROGRESS,
    EpigraphCoreEntityType.NOVEL_HISTORY,
    EpigraphCoreEntityType.BOOK_PROGRESS,
)

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

/** Request-level refusals: the Core applied nothing, and resending the same batch fails the same way. */
private val REJECTED_REQUEST_STATUSES = setOf(400, 413, 422)

private const val MAX_PROTOCOL_IDENTIFIER_LENGTH = 512
private const val MAX_ERROR_CODE_LENGTH = 256
