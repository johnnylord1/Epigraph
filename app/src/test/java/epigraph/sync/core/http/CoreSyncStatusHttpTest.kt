package epigraph.sync.core.http

import epigraph.sync.core.protocol.CoreSyncStatus
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Test

class CoreSyncStatusHttpTest {
    @Test
    fun `requests scoped projection readiness`() = runTest {
        val client = EpigraphCoreHttpClient(
            client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
                val request = chain.request()
                assertEquals("/v1/sync/status", request.url.encodedPath)
                assertEquals("comics:profile:profile-a", request.url.queryParameter("scopeId"))
                assertEquals("Bearer token", request.header("Authorization"))
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("ok")
                    .body(STATUS.toResponseBody(JSON_MEDIA_TYPE))
                    .build()
            }).build(),
            baseUrl = "https://core.local/".toHttpUrl(),
            clientVersion = "0.1.0",
            json = Json { ignoreUnknownKeys = true },
            preserveInterceptorsForTests = true,
        )

        val result = client.syncStatus("token", "comics:profile:profile-a")

        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        val status = (result as CoreHttpResult.Success<CoreSyncStatus>).value
        assertEquals("suwayomi-confirmed-v1", status.comicAuthorityMode)
        assertEquals(2, status.suwayomiProjectionPending)
        assertEquals(false, status.ready)
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val STATUS = """
            {
              "scopeId": "comics:profile:profile-a",
              "currentServerVersion": 44,
              "minReplayableServerVersion": 10,
              "comicAuthorityMode": "suwayomi-confirmed-v1",
              "suwayomiProjectionPending": 2,
              "suwayomiProjectionBlocked": 0,
              "suwayomiProjectionInFlight": 0,
              "ready": false
            }
        """.trimIndent()
    }
}
