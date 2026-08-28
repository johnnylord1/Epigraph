package epigraph.sync.core.http

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreMutationInput
import epigraph.sync.core.protocol.CoreMutationResultStatus
import epigraph.sync.core.protocol.CoreMutationsRequest
import epigraph.sync.core.protocol.CoreMutationsResponse
import epigraph.sync.core.protocol.SuwayomiGraphqlRequest
import epigraph.sync.core.protocol.SuwayomiGraphqlResponse
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.protocol.SuwayomiContentOperation
import epigraph.sync.core.protocol.SuwayomiContentRequest
import epigraph.sync.core.protocol.SuwayomiContentResponse
import epigraph.sync.core.protocol.SuwayomiMutationOperation
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EpigraphCoreHttpClientTest {
    @Test
    fun `capabilities sends negotiation headers without bearer`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            assertEquals("/v1/capabilities", request.url.encodedPath)
            assertEquals("0.1.0", request.header(EpigraphCoreWireProtocol.CLIENT_VERSION_HEADER))
            assertEquals("1", request.header(EpigraphCoreWireProtocol.CLIENT_PROTOCOL_HEADER))
            assertEquals("0.1.0", request.header(EpigraphCoreWireProtocol.LEGACY_CLIENT_VERSION_HEADER))
            assertEquals("1", request.header(EpigraphCoreWireProtocol.LEGACY_CLIENT_PROTOCOL_HEADER))
            assertNull(request.header(EpigraphCoreWireProtocol.AUTHORIZATION_HEADER))
            response(request, 200, CAPABILITIES_JSON)
        }
        val client = coreClient(fake)

        val result = client.capabilities()

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val capabilities = (result as CoreHttpResult.Success<CoreCapabilities>).value
        assertEquals(1, capabilities.serverProtocolVersion)
        assertEquals(42L, capabilities.currentServerVersion)
    }

    @Test
    fun `snapshot and changes encode scope and authenticate each protected call`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            when (request.url.encodedPath) {
                "/v1/snapshot" -> response(request, 200, SNAPSHOT_JSON)
                "/v1/changes" -> response(request, 200, CHANGES_JSON)
                else -> error("unexpected path ${request.url.encodedPath}")
            }
        }
        val client = coreClient(fake)

        client.snapshot("one-time-token", "novels:profile:main profile")
        client.changes("one-time-token", 7, "novels:profile:main profile")
        client.changes("one-time-token", 42)

        val snapshotRequest = fake.requests[0]
        assertEquals("Bearer one-time-token", snapshotRequest.header("Authorization"))
        assertEquals("novels:profile:main profile", snapshotRequest.url.queryParameter("scopeId"))
        assertTrue(snapshotRequest.url.encodedQuery!!.contains("scopeId=novels%3Aprofile%3Amain%20profile"))

        val scopedChanges = fake.requests[1]
        assertEquals("7", scopedChanges.url.queryParameter("sinceVersion"))
        assertEquals("novels:profile:main profile", scopedChanges.url.queryParameter("scopeId"))

        val globalChanges = fake.requests[2]
        assertEquals("42", globalChanges.url.queryParameter("sinceVersion"))
        assertFalse(globalChanges.url.queryParameterNames.contains("scopeId"))
    }

    @Test
    fun `mutation request is flat JSON and HTTP 200 rejections stay successful responses`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            assertEquals("POST", request.method)
            assertEquals("/v1/mutations", request.url.encodedPath)
            val body = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
            val root = Json.parseToJsonElement(body).toString()
            assertTrue(root.contains("\"entityType\":\"comic.entry\""))
            assertFalse(root.contains("payload"))
            response(request, 200, MUTATION_RESPONSE_JSON)
        }
        val client = coreClient(fake)
        val mutation = CoreMutationInput(
            entityType = "comic.entry",
            clientMutationId = "mutation-1",
            scopeId = "comics:profile:main",
            entityId = "comic-1",
            lamport = 1,
            patch = buildJsonObject { put("title", "Example") },
        )

        val result = client.mutations(
            "token",
            CoreMutationsRequest("request-1", listOf(mutation)),
        )

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val response = (result as CoreHttpResult.Success<CoreMutationsResponse>).value
        assertEquals(CoreMutationResultStatus.REJECTED, response.results.single().status)
        assertEquals("UNSUPPORTED_ENTITY_TYPE", response.results.single().error?.code)
    }

    @Test
    fun `suwayomi graphql uses the profile scoped Core proxy and never changes the payload`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            assertEquals("/v1/suwayomi/api/graphql", request.url.encodedPath)
            assertEquals("comics:profile:main", request.url.queryParameter("scopeId"))
            assertEquals("Bearer comics-token", request.header("Authorization"))
            assertEquals("application/json", request.header("Content-Type")?.substringBefore(';'))
            val body = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
            val root = Json.parseToJsonElement(body).jsonObject
            assertEquals(
                "query GetLibrary { mangas { nodes { id title } } }",
                root.getValue("query").jsonPrimitive.content,
            )
            assertEquals(
                "main",
                root.getValue("variables").jsonObject.getValue("profile").jsonPrimitive.content,
            )
            response(request, 200, SUWAYOMI_GRAPHQL_JSON)
        }
        val client = coreClient(fake)

        val result = client.suwayomiGraphql(
            accessToken = "comics-token",
            profileId = "main",
            request = SuwayomiGraphqlRequest(
                query = "query GetLibrary { mangas { nodes { id title } } }",
                variables = buildJsonObject { put("profile", "main") },
                operationName = "GetLibrary",
            ),
        )

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val payload = (result as CoreHttpResult.Success<SuwayomiGraphqlResponse>).value
        assertFalse(payload.hasErrors)
        assertEquals("mangas", payload.data?.keys?.single())
    }

    @Test
    fun `suwayomi catalog encodes the bounded page and manga arguments`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            assertEquals("/v1/suwayomi/catalog", request.url.encodedPath)
            assertEquals("comics:profile:main", request.url.queryParameter("scopeId"))
            assertEquals("chapters", request.url.queryParameter("operation"))
            assertEquals("42", request.url.queryParameter("mangaId"))
            assertEquals("50", request.url.queryParameter("pageSize"))
            assertEquals("100", request.url.queryParameter("offset"))
            assertEquals("Bearer comics-token", request.header("Authorization"))
            response(request, 200, SUWAYOMI_CATALOG_JSON)
        }
        val client = coreClient(fake)

        val result = client.suwayomiCatalog(
            accessToken = "comics-token",
            profileId = "main",
            operation = SuwayomiCatalogOperation.CHAPTERS,
            pageSize = 50,
            offset = 100,
            mangaId = 42,
        )

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val payload = (result as CoreHttpResult.Success<SuwayomiCatalogResponse>).value
        assertEquals("comics:profile:main", payload.scopeId)
        assertEquals(100, payload.page.offset)
        assertTrue(payload.page.hasNextPage)
        assertEquals(321, payload.page.totalCount)
        assertEquals("chapters", payload.operation)
    }

    @Test
    fun `suwayomi content uses the typed profile scoped boundary`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            assertEquals("/v1/suwayomi/content", request.url.encodedPath)
            assertEquals("comics:profile:main", request.url.queryParameter("scopeId"))
            assertEquals("Bearer comics-token", request.header("Authorization"))
            val body = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
            val root = Json.parseToJsonElement(body).jsonObject
            assertEquals("FetchManga", root.getValue("operation").jsonPrimitive.content)
            assertEquals("42", root.getValue("id").jsonPrimitive.content)
            response(
                request,
                200,
                """{"schemaVersion":1,"scopeId":"comics:profile:main","operation":"FetchManga","fetchedAtMs":1,"data":{"fetchManga":{"manga":{"id":42}}}}""",
            )
        }
        val client = coreClient(fake)

        val result = client.suwayomiContent(
            accessToken = "comics-token",
            profileId = "main",
            request = SuwayomiContentRequest(SuwayomiContentOperation.FETCH_MANGA, 42),
        )

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val payload = (result as CoreHttpResult.Success<SuwayomiContentResponse>).value
        assertEquals(SuwayomiContentOperation.FETCH_MANGA, payload.operation)
        assertEquals("42", payload.data["fetchManga"]!!.jsonObject["manga"]!!.jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `suwayomi command uses the typed mutation boundary`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            assertEquals("/v1/suwayomi/commands", request.url.encodedPath)
            assertEquals("comics:profile:main", request.url.queryParameter("scopeId"))
            assertEquals("Bearer comics-token", request.header("Authorization"))
            val payload = Json.parseToJsonElement(request.bodyText()).jsonObject
            assertEquals("UpdateManga", payload.getValue("operation").jsonPrimitive.content)
            assertEquals(42, payload.getValue("variables").jsonObject.getValue("id").jsonPrimitive.content.toInt())
            response(request, 200, SUWAYOMI_COMMAND_JSON)
        }
        val client = coreClient(fake)

        val result = client.suwayomiCommand(
            accessToken = "comics-token",
            profileId = "main",
            request = SuwayomiCommandRequest(
                operation = SuwayomiMutationOperation.UPDATE_MANGA,
                variables = buildJsonObject { put("id", 42); put("inLibrary", true) },
            ),
        )

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val payload = (result as CoreHttpResult.Success<SuwayomiCommandResponse>).value
        assertEquals("comics:profile:main", payload.scopeId)
        assertEquals(SuwayomiMutationOperation.UPDATE_MANGA, payload.operation)
        assertEquals("updateManga", payload.data.keys.single())
    }

    @Test
    fun `suwayomi catalog rejects invalid operation arguments before making a request`() {
        val client = coreClient(Interceptor { error("request must not be sent") })

        assertThrows(IllegalArgumentException::class.java) {
            kotlinx.coroutines.runBlocking {
                client.suwayomiCatalog(
                    accessToken = "token",
                    profileId = "main",
                    operation = SuwayomiCatalogOperation.LIBRARY,
                    mangaId = 42,
                )
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            kotlinx.coroutines.runBlocking {
                client.suwayomiCatalog(
                    accessToken = "token",
                    profileId = "main",
                    operation = SuwayomiCatalogOperation.CHAPTERS,
                    mangaId = null,
                )
            }
        }
    }

    @Test
    fun `suwayomi thumbnail uses the authenticated profile proxy and returns bounded bytes`() = runTest {
        val fake = FakeCoreInterceptor { request ->
            assertEquals("/v1/suwayomi/api/v1/manga/42/thumbnail", request.url.encodedPath)
            assertEquals("comics:profile:main", request.url.queryParameter("scopeId"))
            assertEquals("Bearer comics-token", request.header("Authorization"))
            response(request, 200, "cover-bytes")
        }
        val client = coreClient(fake)

        val result = client.suwayomiThumbnail("comics-token", "main", 42)

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        assertEquals("cover-bytes", String((result as CoreHttpResult.Success<ByteArray>).value))
    }

    @Test
    fun `suwayomi thumbnail accepts large real-world covers but preserves a hard limit`() = runTest {
        val largeCover = ByteArray(8_571_192)
        val acceptedClient = coreClient(
            FakeCoreInterceptor { request -> binaryResponse(request, largeCover) },
        )

        val accepted = acceptedClient.suwayomiThumbnail("comics-token", "main", 709)

        assertInstanceOf(CoreHttpResult.Success::class.java, accepted)
        assertEquals(largeCover.size, (accepted as CoreHttpResult.Success<ByteArray>).value.size)

        val oversizedCover = ByteArray(16 * 1024 * 1024 + 1)
        val rejectingClient = coreClient(
            FakeCoreInterceptor { request -> binaryResponse(request, oversizedCover) },
        )

        val rejected = rejectingClient.suwayomiThumbnail("comics-token", "main", 710)

        assertInstanceOf(CoreHttpResult.Failure::class.java, rejected)
        assertEquals(413, (rejected as CoreHttpResult.Failure).statusCode)
    }

    @Test
    fun `non-success response decodes syncd error envelope including replay recovery`() = runTest {
        val fake = FakeCoreInterceptor { request -> response(request, 409, REPLAY_ERROR_JSON) }
        val client = coreClient(fake)

        val result = client.changes("token", 1)

        assertInstanceOf(CoreHttpResult.Failure::class.java, result)
        val failure = result as CoreHttpResult.Failure
        assertEquals(409, failure.statusCode)
        assertEquals("REPLAY_WINDOW_EXPIRED", failure.errorEnvelope?.error?.code)
        assertEquals("full_bootstrap", failure.errorEnvelope?.error?.requiredAction)
        assertTrue(failure.isReplayWindowExpired)
        assertFalse(failure.isRangeNotSatisfiable)
    }

    @Test
    fun `rejects oversized JSON before decoding it`() = runTest {
        val fake = FakeCoreInterceptor { request -> response(request, 200, CAPABILITIES_JSON) }
        val client = coreClient(fake, maxJsonResponseBytes = 32)

        val result = client.capabilities()

        assertInstanceOf(CoreHttpResult.Failure::class.java, result)
        assertEquals(413, (result as CoreHttpResult.Failure).statusCode)
        assertNull(result.errorEnvelope)
    }

    @Test
    fun `models range rejection without treating it as a successful asset response`() = runTest {
        val fake = FakeCoreInterceptor { request -> response(request, 416, RANGE_ERROR_JSON) }
        val client = coreClient(fake)

        val result = client.snapshot("token", "books:global")

        val failure = result as CoreHttpResult.Failure
        assertTrue(failure.isRangeNotSatisfiable)
        assertEquals("RANGE_NOT_SATISFIABLE", failure.errorEnvelope?.error?.code)
    }

    @Test
    fun `rejects insecure or non-origin base URLs and invalid protected inputs`() {
        val okHttp = OkHttpClient()
        assertThrows(IllegalArgumentException::class.java) {
            EpigraphCoreHttpClient(okHttp, "http://core.local/".toHttpUrl(), "0.1.0")
        }
        assertThrows(IllegalArgumentException::class.java) {
            EpigraphCoreHttpClient(okHttp, "https://core.local/prefix/".toHttpUrl(), "0.1.0")
        }
        val client = EpigraphCoreHttpClient(okHttp, "https://core.local/".toHttpUrl(), "0.1.0")
        assertThrows(IllegalArgumentException::class.java) {
            kotlinx.coroutines.runBlocking { client.changes(" token ", 0) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            kotlinx.coroutines.runBlocking { client.changes("token", -1) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            kotlinx.coroutines.runBlocking {
                client.suwayomiGraphql(
                    "token",
                    " main",
                    SuwayomiGraphqlRequest("query { __typename }")
                )
            }
        }
    }

    private fun coreClient(
        interceptor: Interceptor,
        maxJsonResponseBytes: Long = 16L * 1024L * 1024L,
    ): EpigraphCoreHttpClient = EpigraphCoreHttpClient(
        client = OkHttpClient.Builder().addInterceptor(interceptor).build(),
        baseUrl = "https://core.local:8443/".toHttpUrl(),
        clientVersion = "0.1.0",
        json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        },
        preserveInterceptorsForTests = true,
        maxJsonResponseBytes = maxJsonResponseBytes,
    )

    private fun Request.bodyText(): String {
        val buffer = Buffer()
        body?.writeTo(buffer)
        return buffer.readUtf8()
    }

    private class FakeCoreInterceptor(
        private val responder: (Request) -> Response,
    ) : Interceptor {
        val requests = CopyOnWriteArrayList<Request>()

        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request()
            requests += request
            return responder(request)
        }
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()

        fun response(request: Request, code: Int, body: String): Response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("test")
            .body(body.toResponseBody(JSON))
            .build()

        fun binaryResponse(request: Request, body: ByteArray): Response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("test")
            .body(body.toResponseBody("image/gif".toMediaType()))
            .build()

        val CAPABILITIES_JSON = """
            {
              "serverProtocolVersion": 1,
              "minClientVersion": "0.1.0",
              "supportedScopes": ["books:global"],
              "supportsSseReplay": true,
              "supportsManualIpFallback": true,
              "supportsOwnerTransfer": true,
              "supportsSnapshot": true,
              "supportsAssets": true,
              "supportsNovelChapterAssets": true,
              "supportsNovelPluginSync": true,
              "supportsSuwayomiProxy": true,
              "supportsSuwayomiWebsocketProxy": true,
              "suwayomiProxyPathTemplate": "/v1/suwayomi/{path}",
              "snapshotSchemaVersion": 1,
              "snapshotEntityTypes": ["book.entry"],
              "tlsCertSha256": "${"a".repeat(64)}",
              "mdnsServiceName": "_epigraph-syncd._tcp.local.",
              "currentServerVersion": 42,
              "minReplayableServerVersion": 7
            }
        """.trimIndent()

        val SNAPSHOT_JSON = """
            {
              "schemaVersion": 1,
              "scopeId": "novels:profile:main profile",
              "snapshotVersion": 42,
              "minReplayableServerVersion": 7,
              "entities": [],
              "tombstones": []
            }
        """.trimIndent()

        val CHANGES_JSON = """
            {
              "currentServerVersion": 42,
              "minReplayableServerVersion": 7,
              "changes": []
            }
        """.trimIndent()

        val MUTATION_RESPONSE_JSON = """
            {
              "requestId": "request-1",
              "currentServerVersion": 42,
              "results": [{
                "clientMutationId": "mutation-1",
                "entityType": "comic.entry",
                "entityId": "comic-1",
                "scopeId": "comics:profile:main",
                "op": "merge",
                "status": "rejected",
                "error": {
                  "code": "UNSUPPORTED_ENTITY_TYPE",
                  "message": "Unsupported entity type.",
                  "retryable": false
                }
              }]
            }
        """.trimIndent()

        val REPLAY_ERROR_JSON = """
            {
              "error": {
                "code": "REPLAY_WINDOW_EXPIRED",
                "message": "Replay window expired.",
                "retryable": true,
                "currentServerVersion": 42,
                "minReplayableServerVersion": 7,
                "requiredAction": "full_bootstrap"
              }
            }
        """.trimIndent()

        val SUWAYOMI_GRAPHQL_JSON = """
            {
              "data": {
                "mangas": {
                  "nodes": [{ "id": 1, "title": "Epigraph" }]
                }
              }
            }
        """.trimIndent()

        val SUWAYOMI_CATALOG_JSON = """
            {
              "schemaVersion": 1,
              "scopeId": "comics:profile:main",
              "operation": "chapters",
              "generatedAtMs": 123,
              "page": {
                "offset": 100,
                "pageSize": 50,
                "hasNextPage": true,
                "totalCount": 321
              },
              "data": {
                "chapters": {
                  "nodes": [{ "id": 7, "name": "Chapter 1" }]
                }
              }
            }
        """.trimIndent()

        val SUWAYOMI_COMMAND_JSON = """
            {
              "schemaVersion": 1,
              "scopeId": "comics:profile:main",
              "operation": "UpdateManga",
              "appliedAtMs": 123,
              "data": {
                "updateManga": { "manga": { "id": 42, "inLibrary": true } }
              }
            }
        """.trimIndent()

        val RANGE_ERROR_JSON = """
            {
              "error": {
                "code": "RANGE_NOT_SATISFIABLE",
                "message": "Requested range is invalid.",
                "retryable": false
              }
            }
        """.trimIndent()
    }
}
