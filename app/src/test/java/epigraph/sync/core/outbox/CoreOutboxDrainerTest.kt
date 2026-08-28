package epigraph.sync.core.outbox

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import epigraph.contract.operationWireName
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreErrorDetail
import epigraph.sync.core.protocol.CoreMutationResult
import epigraph.sync.core.protocol.CoreMutationResultStatus
import epigraph.sync.core.protocol.CoreMutationsRequest
import epigraph.sync.core.protocol.CoreMutationsResponse
import java.io.IOException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreOutboxDrainerTest {
    private val json = Json {
        classDiscriminator = "operation"
        encodeDefaults = true
        ignoreUnknownKeys = false
    }

    @Test
    fun `claims in sequence order and reconciles non atomic results by mutation id`() = runTest {
        val claims = listOf(claim(4), claim(1), claim(3), claim(2))
        val store = FakeStore(claims)
        val gateway = FakeGateway { token, request ->
            assertEquals(SECRET, token)
            assertEquals(listOf("mutation-1", "mutation-2", "mutation-3", "mutation-4"), request.ids())
            assertEquals(listOf(10L, 11L, 12L, 13L), request.mutations.map { it.lamport })
            assertEquals(listOf(1L, 2L, 3L, 4L), request.mutations.map { it.eventClock?.logical })
            assertTrue(request.mutations.all { it.eventClock?.physicalMs == NOW - 1 })
            CoreHttpResult.Success(
                response(
                    request,
                    result(request, 2, retryable = true),
                    result(request, 1, canonicalEntityId = "canonical-book-1"),
                    result(request, 3, retryable = false),
                    // mutation-4 is deliberately omitted and must be retried.
                ),
            )
        }
        val report = drainer(store, gateway, lamports(10, 11, 12, 13)).drain(
            authorization(),
            capabilities(),
            NOW,
        )

        assertEquals(CoreOutboxDrainReport(4, 4, 1, 2, 1), report)
        assertEquals(listOf("mutation-1"), store.acknowledged.map { it.first.clientMutationId })
        assertEquals("canonical-book-1", store.acknowledged.single().second.canonicalEntityId)
        assertEquals(
            setOf("mutation-2", "mutation-3", "mutation-4"),
            store.failed.map { it.identity.clientMutationId }.toSet(),
        )
        assertTrue(store.failed.single { it.identity.clientMutationId == "mutation-3" }.nextAttemptAt == Long.MAX_VALUE)
        assertTrue(
            store.failed.single { it.identity.clientMutationId == "mutation-3" }
                .errorCode.startsWith("blocked:"),
        )
        assertEquals(
            NOW + RETRY_DELAY,
            store.failed.single { it.identity.clientMutationId == "mutation-2" }.nextAttemptAt,
        )
        assertEquals(
            NOW + RETRY_DELAY,
            store.failed.single { it.identity.clientMutationId == "mutation-4" }.nextAttemptAt,
        )
    }

    @Test
    fun `blocked adaptation remains pending and only ready rows enter request`() = runTest {
        val unsupported = claim(
            sequence = 1,
            entityType = EpigraphCoreEntityType.COMIC_REPOSITORY,
            scopeId = COMIC_SCOPE,
        )
        val ready = claim(2)
        val store = FakeStore(listOf(unsupported, ready))
        val gateway = FakeGateway { _, request ->
            assertEquals(listOf("mutation-2"), request.ids())
            CoreHttpResult.Success(response(request, result(request, 1)))
        }
        val report = drainer(store, gateway, lamports(1, 2)).drain(
            authorization(scopes = setOf(BOOK_SCOPE, COMIC_SCOPE)),
            capabilities(EpigraphCoreEntityType.COMIC_REPOSITORY),
            NOW,
        )

        assertEquals(CoreOutboxDrainReport(2, 1, 1, 0, 1), report)
        assertEquals("mutation-2", store.acknowledged.single().first.clientMutationId)
        val failure = store.failed.single()
        assertEquals("mutation-1", failure.identity.clientMutationId)
        assertEquals(Long.MAX_VALUE, failure.nextAttemptAt)
        assertTrue(failure.errorCode.contains("entity_not_supported_by_core_v1"))
    }

    @Test
    fun `scope not granted is left unclaimed before token or transport is used`() = runTest {
        val store = FakeStore(listOf(claim(1)))
        var tokenUsed = false
        var gatewayUsed = false
        val authorization = authorization(
            scopes = setOf("novels:profile:main"),
            tokenLease = object : CoreAccessTokenLease {
                override suspend fun <T> use(block: suspend (String) -> T): T {
                    tokenUsed = true
                    return block(SECRET)
                }
            },
        )
        val report = drainer(
            store,
            FakeGateway { _, _ ->
                gatewayUsed = true
                throw AssertionError("gateway must not be used")
            },
            lamports(1),
        ).drain(authorization, capabilities(), NOW)

        assertEquals(CoreOutboxDrainReport(0, 0, 0, 0, 0), report)
        assertFalse(tokenUsed)
        assertFalse(gatewayUsed)
        assertTrue(store.failed.isEmpty())
        assertFalse(authorization.toString().contains(SECRET))
        assertTrue(authorization.toString().contains("<redacted>"))
    }

    @Test
    fun `transport exception releases every submitted row without acknowledging`() = runTest {
        val store = FakeStore(listOf(claim(1), claim(2)))
        val report = drainer(
            store,
            FakeGateway { _, _ -> throw IOException("secret endpoint details") },
            lamports(1, 2),
        ).drain(authorization(), capabilities(), NOW)

        assertEquals(CoreOutboxDrainReport(2, 2, 0, 2, 0), report)
        assertTrue(store.acknowledged.isEmpty())
        assertEquals(setOf("mutation-1", "mutation-2"), store.failed.map { it.identity.clientMutationId }.toSet())
        assertTrue(store.failed.all { it.errorCode == "core_transport_failure" })
        assertTrue(store.failed.none { it.errorCode.contains("secret") })
    }

    @Test
    fun `http failure releases complete batch for retry`() = runTest {
        val store = FakeStore(listOf(claim(1), claim(2)))
        val report = drainer(
            store,
            FakeGateway { _, _ -> CoreHttpResult.Failure(statusCode = 503, errorEnvelope = null) },
            lamports(1, 2),
        ).drain(authorization(), capabilities(), NOW)

        assertEquals(CoreOutboxDrainReport(2, 2, 0, 2, 0), report)
        assertTrue(store.acknowledged.isEmpty())
        assertTrue(store.failed.all { it.errorCode == "core_http_503" })
        assertTrue(store.failed.all { it.nextAttemptAt == NOW + RETRY_DELAY })
    }

    @Test
    fun `mismatched response request id releases complete batch`() = runTest {
        val store = FakeStore(listOf(claim(1), claim(2)))
        val gateway = FakeGateway { _, request ->
            CoreHttpResult.Success(
                response(request, result(request, 1), result(request, 2)).copy(requestId = "another-request"),
            )
        }
        val report = drainer(store, gateway, lamports(1, 2)).drain(
            authorization(),
            capabilities(),
            NOW,
        )

        assertEquals(CoreOutboxDrainReport(2, 2, 0, 2, 0), report)
        assertTrue(store.acknowledged.isEmpty())
        assertTrue(store.failed.all { it.errorCode == "invalid_core_response" })
    }

    @Test
    fun `invalid request id fails closed without contacting Core`() = runTest {
        val store = FakeStore(listOf(claim(1)))
        var gatewayUsed = false
        val drainer = CoreOutboxDrainer(
            store = store,
            adapter = CoreV1OutboxAdapter(json),
            gateway = FakeGateway { _, _ ->
                gatewayUsed = true
                throw AssertionError("gateway must not be used")
            },
            lamports = lamports(1),
            requestIds = CoreRequestIdSource { " bad-request " },
            retryPlanner = retryPlanner(),
        )
        val report = drainer.drain(authorization(), capabilities(), NOW)

        assertFalse(gatewayUsed)
        assertEquals(CoreOutboxDrainReport(1, 0, 0, 1, 0), report)
        assertEquals("invalid_request_id", store.failed.single().errorCode)
    }

    @Test
    fun `applied result with mismatched entity is retried and not acknowledged`() = runTest {
        val store = FakeStore(listOf(claim(1)))
        val gateway = FakeGateway { _, request ->
            val result = result(request, 1).copy(entityId = "different-entity")
            CoreHttpResult.Success(response(request, result))
        }
        val report = drainer(store, gateway, lamports(1)).drain(
            authorization(),
            capabilities(),
            NOW,
        )

        assertEquals(CoreOutboxDrainReport(1, 1, 0, 1, 0), report)
        assertTrue(store.acknowledged.isEmpty())
        assertEquals("invalid_core_result", store.failed.single().errorCode)
    }

    @Test
    fun `accepted result without replica version is retried and not acknowledged`() = runTest {
        val store = FakeStore(listOf(claim(1)))
        val gateway = FakeGateway { _, request ->
            CoreHttpResult.Success(response(request, result(request, 1).copy(appliedServerVersion = null)))
        }

        val report = drainer(store, gateway, lamports(1)).drain(authorization(), capabilities(), NOW)

        assertEquals(CoreOutboxDrainReport(1, 1, 0, 1, 0), report)
        assertTrue(store.acknowledged.isEmpty())
        assertEquals("invalid_core_result", store.failed.single().errorCode)
    }

    @Test
    fun `transient lamport source failure retries row instead of permanently blocking it`() = runTest {
        val store = FakeStore(listOf(claim(1)))
        var gatewayUsed = false
        val report = drainer(
            store,
            FakeGateway { _, _ ->
                gatewayUsed = true
                throw AssertionError("gateway must not receive a row without a Lamport value")
            },
            CoreLamportSource { throw IOException("database temporarily unavailable") },
        ).drain(authorization(), capabilities(), NOW)

        assertFalse(gatewayUsed)
        assertEquals(CoreOutboxDrainReport(1, 0, 0, 1, 0), report)
        val failure = store.failed.single()
        assertEquals("lamport_source_failure", failure.errorCode)
        assertEquals(NOW + RETRY_DELAY, failure.nextAttemptAt)
        assertFalse(failure.errorCode.startsWith("blocked:"))
    }

    private fun drainer(
        store: FakeStore,
        gateway: CoreMutationGateway,
        lamports: CoreLamportSource,
    ) = CoreOutboxDrainer(
        store = store,
        adapter = CoreV1OutboxAdapter(json),
        gateway = gateway,
        lamports = lamports,
        requestIds = CoreRequestIdSource { "request-1" },
        retryPlanner = retryPlanner(),
    )

    private fun retryPlanner() = CoreOutboxRetryPlanner { now, _, _ -> now + RETRY_DELAY }

    private fun lamports(vararg values: Long): CoreLamportSource {
        val queue = ArrayDeque(values.toList())
        return CoreLamportSource { queue.removeFirst() }
    }

    private fun authorization(
        scopes: Set<String> = setOf(BOOK_SCOPE),
        tokenLease: CoreAccessTokenLease = object : CoreAccessTokenLease {
            override suspend fun <T> use(block: suspend (String) -> T): T = block(SECRET)
        },
    ) = CoreOutboxAuthorization(DEVICE_ID, scopes, tokenLease)

    private fun claim(
        sequence: Long,
        entityType: String = EpigraphCoreEntityType.BOOK_CATEGORY,
        scopeId: String = BOOK_SCOPE,
    ): ClaimedCoreOutboxRecord {
        val mutationId = "mutation-$sequence"
        val entityId = EpigraphEntityId("entity-$sequence")
        val command = SyncCommand.DeleteEntity(entityId)
        val envelope = SyncCommandEnvelope(
            protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
            deviceId = DeviceId(DEVICE_ID),
            clientMutationId = ClientMutationId(mutationId),
            scopeId = SyncScopeId(scopeId),
            entityType = SyncEntityType(entityType),
            command = command,
        )
        return ClaimedCoreOutboxRecord(
            sequence = sequence,
            attemptCount = 1,
            record = CoreOutboxRecord(
                deviceId = DEVICE_ID,
                clientMutationId = mutationId,
                scopeId = scopeId,
                entityType = entityType,
                entityId = entityId.value,
                operation = command.operationWireName(),
                payloadJson = json.encodeToString(envelope),
                createdAtEpochMillis = NOW - 1,
            ),
        )
    }

    private fun capabilities(vararg extraEntityTypes: String) = CoreCapabilities(
        serverProtocolVersion = EpigraphCoreWireProtocol.CURRENT_VERSION,
        minClientVersion = "0.1.0",
        supportedScopes = listOf(BOOK_SCOPE, "novels:profile:<paired-profile>"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = true,
        supportsSnapshot = true,
        supportsAssets = true,
        supportsNovelChapterAssets = true,
        supportsNovelPluginSync = true,
        supportsSuwayomiProxy = true,
        supportsCausalMutationsV3 = true,
        supportsSuwayomiWebsocketProxy = true,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION,
        snapshotEntityTypes = setOf(EpigraphCoreEntityType.BOOK_CATEGORY) + extraEntityTypes,
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
    )

    private fun result(
        request: CoreMutationsRequest,
        position: Int,
        retryable: Boolean? = null,
        canonicalEntityId: String? = null,
    ): CoreMutationResult {
        val mutation = request.mutations[position - 1]
        return CoreMutationResult(
            clientMutationId = mutation.clientMutationId,
            entityType = mutation.entityType,
            entityId = mutation.entityId,
            canonicalEntityId = canonicalEntityId,
            scopeId = mutation.scopeId,
            op = mutation.op,
            status = if (retryable == null) CoreMutationResultStatus.APPLIED else CoreMutationResultStatus.REJECTED,
            appliedServerVersion = if (retryable == null) position.toLong() else null,
            appliedLamport = if (retryable == null) mutation.lamport else null,
            record = null,
            error = retryable?.let {
                CoreErrorDetail(code = if (it) "BUSY" else "INVALID_MUTATION", message = "not logged", retryable = it)
            },
        )
    }

    private fun response(
        request: CoreMutationsRequest,
        vararg results: CoreMutationResult,
    ) = CoreMutationsResponse(
        requestId = request.requestId,
        currentServerVersion = 10,
        results = results.toList(),
    )

    private fun CoreMutationsRequest.ids() = mutations.map { it.clientMutationId }

    private class FakeGateway(
        private val block: suspend (String, CoreMutationsRequest) -> CoreHttpResult<CoreMutationsResponse>,
    ) : CoreMutationGateway {
        override suspend fun submit(
            accessToken: String,
            request: CoreMutationsRequest,
        ): CoreHttpResult<CoreMutationsResponse> = block(accessToken, request)
    }

    private class FakeStore(
        private val claims: List<ClaimedCoreOutboxRecord>,
    ) : CoreOutboxStore {
        val acknowledged = mutableListOf<Pair<CoreOutboxRecord, CoreMutationResult>>()
        val failed = mutableListOf<Failure>()

        override suspend fun claimReady(
            nowEpochMillis: Long,
            leaseDurationMillis: Long,
            limit: Long,
        ): List<ClaimedCoreOutboxRecord> = claims.take(limit.toInt())

        override suspend fun acknowledge(
            record: CoreOutboxRecord,
            result: CoreMutationResult,
            receivedAtEpochMillis: Long,
        ) {
            acknowledged += record to result
        }

        override suspend fun markFailed(
            identity: CoreOutboxIdentity,
            errorCode: String,
            nextAttemptAtEpochMillis: Long,
        ) {
            failed += Failure(identity, errorCode, nextAttemptAtEpochMillis)
        }
    }

    private data class Failure(
        val identity: CoreOutboxIdentity,
        val errorCode: String,
        val nextAttemptAt: Long,
    )

    private companion object {
        const val DEVICE_ID = "android-phone"
        const val BOOK_SCOPE = "books:global"
        const val COMIC_SCOPE = "comics:profile:main"
        const val SECRET = "secret-token-never-render"
        const val NOW = 1_000L
        const val RETRY_DELAY = 100L
    }
}
