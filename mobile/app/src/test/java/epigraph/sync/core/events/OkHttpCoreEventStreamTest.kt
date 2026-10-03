package epigraph.sync.core.events

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.replay.CoreReplayCoverage
import epigraph.sync.core.replay.CoreReplaySession
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class OkHttpCoreEventStreamTest {
    @Test
    fun `opens exact scoped v1 stream and advances cursor only after durable apply`() = runTest {
        val interceptor = RecordingInterceptor { request ->
            assertEquals("/v1/events", request.url.encodedPath)
            assertEquals("books:global", request.url.queryParameter("scopeId"))
            assertEquals("Bearer one-use-token", request.header("Authorization"))
            assertEquals("1", request.header(EpigraphCoreWireProtocol.CLIENT_PROTOCOL_HEADER))
            assertEquals("0.1.0", request.header(EpigraphCoreWireProtocol.CLIENT_VERSION_HEADER))
            assertEquals("1", request.header(EpigraphCoreWireProtocol.LEGACY_CLIENT_PROTOCOL_HEADER))
            assertEquals("0.1.0", request.header(EpigraphCoreWireProtocol.LEGACY_CLIENT_VERSION_HEADER))
            assertEquals("7", request.header("Last-Event-ID"))
            assertEquals("text/event-stream", request.header("Accept"))
            response(request, 200, changeEvent(8) + changeEvent(11), "text/event-stream")
        }
        val session = CoreReplaySession.afterSnapshot(
            snapshotVersion = 7,
            coverage = CoreReplayCoverage.Filtered("books:global"),
        )
        val persisted = mutableListOf<Pair<Long, Long>>()

        val outcome = stream(interceptor).collect("one-use-token", session) { change, cursor ->
            persisted += change.serverVersion to cursor.lastGlobalEventId
        }

        val reconnect = assertInstanceOf(CoreEventStreamOutcome.Reconnect::class.java, outcome)
        assertEquals(CoreReconnectReason.END_OF_STREAM, reconnect.reason)
        assertEquals(11L, reconnect.checkpoint.lastGlobalEventId)
        assertEquals(listOf(8L to 8L, 11L to 11L), persisted)
        assertEquals(11L, session.checkpoint.lastGlobalEventId)
        assertFalse(stream(interceptor).toString().contains("one-use-token"))
    }

    @Test
    fun `failed durable transaction reconnects from old cursor`() = runTest {
        val interceptor = RecordingInterceptor { request ->
            response(request, 200, changeEvent(8), "text/event-stream")
        }
        val session = CoreReplaySession.afterSnapshot(7, CoreReplayCoverage.AllGrantedScopes)

        val outcome = stream(interceptor).collect("secret", session) { _, _ ->
            throw IllegalStateException("transaction rolled back")
        }

        val reconnect = assertInstanceOf(CoreEventStreamOutcome.Reconnect::class.java, outcome)
        assertEquals(CoreReconnectReason.APPLY_FAILURE, reconnect.reason)
        assertEquals(7L, reconnect.checkpoint.lastGlobalEventId)
        assertEquals(7L, session.checkpoint.lastGlobalEventId)
    }

    @Test
    fun `409 replay window expiry and replay required event request full bootstrap`() = runTest {
        val expired = RecordingInterceptor { request ->
            response(
                request,
                409,
                """{"error":{"code":"REPLAY_WINDOW_EXPIRED","message":"expired","retryable":false,"requiredAction":"full_bootstrap"}}""",
                "application/json",
            )
        }
        val first = CoreReplaySession.afterSnapshot(3, CoreReplayCoverage.AllGrantedScopes)
        val httpOutcome = stream(expired).collect("secret", first) { _, _ -> error("unused") }
        val httpBootstrap =
            assertInstanceOf(CoreEventStreamOutcome.FullBootstrap::class.java, httpOutcome)
        assertEquals("REPLAY_WINDOW_EXPIRED", httpBootstrap.reasonCode)
        assertEquals(3L, httpBootstrap.checkpoint.lastGlobalEventId)

        val requested = RecordingInterceptor { request ->
            response(
                request,
                200,
                "event: replay_required\n" +
                    "data: {\"reasonCode\":\"CURSOR_TOO_OLD\",\"requiredAction\":\"full_bootstrap\"}\n\n",
                "text/event-stream",
            )
        }
        val second = CoreReplaySession.afterSnapshot(3, CoreReplayCoverage.AllGrantedScopes)
        val eventOutcome = stream(requested).collect("secret", second) { _, _ -> error("unused") }
        val eventBootstrap =
            assertInstanceOf(CoreEventStreamOutcome.FullBootstrap::class.java, eventOutcome)
        assertEquals("CURSOR_TOO_OLD", eventBootstrap.reasonCode)
    }

    @Test
    fun `redirect is not followed and token is not sent to target`() = runTest {
        val requests = CopyOnWriteArrayList<Request>()
        val interceptor = Interceptor { chain ->
            requests += chain.request()
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(302)
                .message("Found")
                .header("Location", "https://attacker.invalid/collect")
                .body("".toResponseBody())
                .build()
        }
        val session = CoreReplaySession.afterSnapshot(0, CoreReplayCoverage.AllGrantedScopes)

        val outcome = stream(interceptor).collect("do-not-forward", session) { _, _ -> error("unused") }

        assertInstanceOf(CoreEventStreamOutcome.HttpFailure::class.java, outcome)
        assertEquals(1, requests.size)
        assertTrue(requests.single().url.host == "core.local")
    }

    private fun stream(interceptor: Interceptor) = OkHttpCoreEventStream(
        client = OkHttpClient.Builder().addInterceptor(interceptor).build(),
        baseUrl = "https://core.local/".toHttpUrl(),
        clientVersion = "0.1.0",
        ioDispatcher = Dispatchers.Unconfined,
        json = kotlinx.serialization.json.Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        },
        preserveInterceptorsForTests = true,
    )

    private class RecordingInterceptor(
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
        fun response(
            request: Request,
            code: Int,
            body: String,
            mediaType: String,
        ): Response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("test")
            .body(body.toResponseBody(mediaType.toMediaType()))
            .build()

        fun changeEvent(version: Long): String =
            "id: $version\n" +
                "event: change\n" +
                "data: {\"serverVersion\":$version,\"scopeId\":\"books:global\"," +
                "\"entityType\":\"book.progress\",\"entityId\":\"book-1\",\"op\":\"merge\"," +
                "\"lamport\":$version,\"patch\":{},\"appliedAtMs\":123}\n\n"
    }
}
