package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.outbox.CoreOutboxAuthorization
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreErrorDetail
import epigraph.sync.core.protocol.CoreErrorEnvelope
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.protocol.SuwayomiMutationOperation
import epigraph.sync.core.work.CoreOutboxSyncConnection
import epigraph.sync.core.work.SuwayomiCommandChannel
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SuwayomiCategoryCreateHookTest {

    private data class Bound(val localCategoryId: Long, val name: String, val entityId: String, val order: Long)

    private val bound = mutableListOf<Bound>()
    private val binder = CreatedComicCategoryBinder { id, name, entity, order -> bound += Bound(id, name, entity, order) }

    @Test
    fun `creates and binds each unpublished category`() = runTest {
        val channel = FakeChannel(answers = mutableListOf(created(42, "Reading", 3), created(43, "Done", 4)))

        hook("Reading", "Done").onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(listOf("Reading", "Done"), channel.requests.map { it.variables.getValue("name").jsonPrimitive.content })
        assertTrue(channel.requests.all { it.operation == SuwayomiMutationOperation.CREATE_CATEGORY })
        assertEquals(
            listOf(
                Bound(1, "Reading", "suwayomi:server:desk:profile:main:category:42", 3),
                Bound(2, "Done", "suwayomi:server:desk:profile:main:category:43", 4),
            ),
            bound,
        )
    }

    @Test
    fun `does nothing without the capability or the canonical projection`() = runTest {
        val channel = FakeChannel()

        hook("Reading").onNegotiated(capabilities(create = false), FakeConnection(channel))
        hook("Reading").onNegotiated(capabilities().copy(supportsCausalMutationsV3 = false), FakeConnection(channel))
        hook("Reading").onNegotiated(capabilities(), FakeConnection(null))

        assertTrue(channel.requests.isEmpty())
        assertTrue(bound.isEmpty())
    }

    @Test
    fun `does nothing for a legacy unbound session`() = runTest {
        val channel = FakeChannel(serverId = LEGACY_UNBOUND_SERVER_ID)

        hook("Reading").onNegotiated(capabilities(), FakeConnection(channel))

        assertTrue(channel.requests.isEmpty())
    }

    @Test
    fun `skips names Suwayomi cannot hold and still sends valid ones`() = runTest {
        val channel = FakeChannel(answers = mutableListOf(created(42, "Valid", 1)))

        hook("", "a".repeat(257), "Bad\u0000Name", " Padded", "Default", "dEfAuLt", "Valid")
            .onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(listOf("Valid"), channel.requests.map { it.variables.getValue("name").jsonPrimitive.content })
        assertEquals(listOf(7L), bound.map { it.localCategoryId })
    }

    @Test
    fun `accepts a multibyte name at exactly 256 bytes`() {
        assertTrue(SuwayomiCategoryCreateHook.isPublishableName("é".repeat(128)))
        assertTrue(!SuwayomiCategoryCreateHook.isPublishableName("é".repeat(128) + "a"))
    }

    @Test
    fun `stops when the Core is unavailable`() = runTest {
        val channel = FakeChannel(answers = mutableListOf(CoreHttpResult.Failure(503, null), created(43, "Done", 4)))

        hook("Reading", "Done").onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(1, channel.requests.size)
        assertTrue(bound.isEmpty())
    }

    @Test
    fun `stops on auth or throttling failures`() = runTest {
        for (status in listOf(401, 403, 429, 500)) {
            val channel = FakeChannel(answers = mutableListOf(CoreHttpResult.Failure(status, null), created(43, "Done", 4)))

            hook("Reading", "Done").onNegotiated(capabilities(), FakeConnection(channel))

            assertEquals(1, channel.requests.size, "status $status")
        }
        assertTrue(bound.isEmpty())
    }

    @Test
    fun `a rejected name does not block the categories after it`() = runTest {
        val graphQlError = CoreHttpResult.Failure(
            503,
            CoreErrorEnvelope(CoreErrorDetail("SUWAYOMI_CATALOG_QUERY_FAILED", "x", retryable = false)),
        )
        val channel = FakeChannel(
            answers = mutableListOf(CoreHttpResult.Failure(400, null), graphQlError, created(44, "Third", 2)),
        )

        hook("First", "Second", "Third").onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(3, channel.requests.size)
        assertEquals(listOf(Bound(3, "Third", "suwayomi:server:desk:profile:main:category:44", 2)), bound)
    }

    @Test
    fun `ignores answers that do not confirm the requested category`() = runTest {
        val channel = FakeChannel(
            answers = mutableListOf(
                created(42, "Other", 1),
                created(0, "Second", 1),
                created(Int.MAX_VALUE.toLong() + 1, "Third", 1),
                CoreHttpResult.Success(response(buildJsonObject { put("createCategory", "oops") })),
                CoreHttpResult.Success(
                    response(
                        buildJsonObject {
                            putJsonObject("createCategory") {
                                putJsonObject("category") {
                                    put("id", "45")
                                    put("name", "Fifth")
                                }
                            }
                        },
                    ),
                ),
                CoreHttpResult.Success(response(createdData(46, "Sixth", 1), SuwayomiMutationOperation.UPDATE_CATEGORY)),
                created(47, "Seventh", 9),
            ),
        )

        hook("First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh")
            .onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(7, channel.requests.size)
        assertEquals(listOf(Bound(7, "Seventh", "suwayomi:server:desk:profile:main:category:47", 9)), bound)
    }

    @Test
    fun `a missing order binds with order zero`() = runTest {
        val data = buildJsonObject {
            putJsonObject("createCategory") {
                putJsonObject("category") {
                    put("id", 42)
                    put("name", "Reading")
                }
            }
        }
        val channel = FakeChannel(answers = mutableListOf(CoreHttpResult.Success(response(data))))

        hook("Reading").onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(listOf(0L), bound.map { it.order })
    }

    @Test
    fun `respects the per-session limit`() = runTest {
        val channel = FakeChannel(answers = mutableListOf(created(42, "Reading", 1), created(43, "Done", 2)))

        SuwayomiCategoryCreateHook(source("Reading", "Done"), binder, maxPerSession = 1)
            .onNegotiated(capabilities(), FakeConnection(channel))

        assertEquals(1, channel.requests.size)
    }

    private fun hook(vararg names: String) = SuwayomiCategoryCreateHook(source(*names), binder)

    private fun source(vararg names: String) = UnpublishedComicCategorySource {
        names.mapIndexed { index, name -> UnpublishedComicCategory(index + 1L, name) }
    }

    private fun capabilities(create: Boolean = true) = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("comics:profile:main"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = false,
        supportsSnapshot = true,
        supportsAssets = false,
        supportsNovelChapterAssets = false,
        supportsNovelPluginSync = false,
        supportsSuwayomiProxy = true,
        supportsSuwayomiWebsocketProxy = false,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = 1,
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
        supportsCausalMutationsV3 = true,
        snapshotEntityTypes = setOf(
            "comic.entry",
            "comic.category",
            "comic.category_assignment",
            "comic.chapter_state",
            "comic.history",
        ),
        supportsSuwayomiCategoryCreate = create,
    )

    private class FakeConnection(private val channel: SuwayomiCommandChannel?) : CoreOutboxSyncConnection {
        override val openedOrigin: String = "https://core.local"
        override suspend fun capabilities(): CoreHttpResult<CoreCapabilities> = error("unused")
        override suspend fun drainSuwayomi(nowEpochMillis: Long, canonicalProjectionEnabled: Boolean) =
            error("unused")
        override suspend fun drain(
            authorization: CoreOutboxAuthorization,
            capabilities: CoreCapabilities,
            nowEpochMillis: Long,
        ): CoreOutboxDrainReport = error("unused")
        override fun suwayomiCommands(): SuwayomiCommandChannel? = channel
    }

    private class FakeChannel(
        override val serverId: String = "desk",
        override val profileId: String = "main",
        private val answers: MutableList<CoreHttpResult<SuwayomiCommandResponse>> = mutableListOf(),
    ) : SuwayomiCommandChannel {
        val requests = mutableListOf<SuwayomiCommandRequest>()

        override suspend fun command(request: SuwayomiCommandRequest): CoreHttpResult<SuwayomiCommandResponse> {
            requests += request
            return answers.removeAt(0)
        }
    }

    private companion object {
        fun createdData(id: Long, name: String, order: Long) = buildJsonObject {
            putJsonObject("createCategory") {
                putJsonObject("category") {
                    put("id", id)
                    put("name", name)
                    put("order", order)
                }
                put("created", true)
            }
        }

        fun response(
            data: JsonObject,
            operation: SuwayomiMutationOperation = SuwayomiMutationOperation.CREATE_CATEGORY,
        ) = SuwayomiCommandResponse(
            schemaVersion = 1,
            scopeId = "comics:profile:main",
            operation = operation,
            appliedAtMs = 1,
            data = data,
        )

        fun created(id: Long, name: String, order: Long): CoreHttpResult<SuwayomiCommandResponse> =
            CoreHttpResult.Success(response(createdData(id, name, order)))
    }
}
