package epigraph.sync.core.http

import epigraph.sync.core.protocol.CoreTrackerCredential
import epigraph.sync.core.protocol.CoreTrackerCredentialDelete
import epigraph.sync.core.protocol.CoreTrackerCredentialList
import epigraph.sync.core.protocol.CoreTrackerCredentialWrite
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
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
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreTrackerCredentialHttpTest {
    private val requests = mutableListOf<Pair<Request, String?>>()

    @Test
    fun `lists credentials with the device token`() = runTest {
        val result = client(200, LIST).trackerCredentials("token")

        val (request, _) = requests.single()
        assertEquals("GET", request.method)
        assertEquals("/v1/tracker-credentials", request.url.encodedPath)
        assertEquals("Bearer token", request.header("Authorization"))
        val list = (result as CoreHttpResult.Success<CoreTrackerCredentialList>).value
        assertEquals(3L, list.credentials.single().revision)
        assertEquals("opaque", list.credentials.single().token)
    }

    @Test
    fun `writes are compare-and-set and a stale revision is a 409`() = runTest {
        val result = client(409, """{"error":{"code":"REVISION_CONFLICT","message":"stale"}}""")
            .putTrackerCredential("token", "anilist", CoreTrackerCredentialWrite(2, "device-a", "", "", "opaque"))

        val (request, body) = requests.single()
        assertEquals("PUT", request.method)
        assertEquals("/v1/tracker-credentials/anilist", request.url.encodedPath)
        val sent = Json.parseToJsonElement(body!!).jsonObject
        assertEquals(2L, sent.getValue("baseRevision").jsonPrimitive.long)
        assertEquals("opaque", sent.getValue("token").jsonPrimitive.content)
        assertEquals(409, (result as CoreHttpResult.Failure).statusCode)
    }

    @Test
    fun `logout sends a delete with the base revision`() = runTest {
        val result = client(200, """{"trackerKey":"anilist","revision":4,"deleted":true}""")
            .deleteTrackerCredential("token", "anilist", CoreTrackerCredentialDelete(3, "device-a"))

        val (request, body) = requests.single()
        assertEquals("DELETE", request.method)
        assertTrue(body!!.contains("\"baseRevision\":3"))
        assertInstanceOf(CoreHttpResult.Success::class.java, result)
        assertTrue((result as CoreHttpResult.Success<CoreTrackerCredential>).value.deleted)
    }

    @Test
    fun `tracker keys cannot escape the credential path`() {
        val client = client(200, "{}")
        listOf("../sessions", "AniList", "", "a/b").forEach { key ->
            assertThrows(IllegalArgumentException::class.java) {
                kotlinx.coroutines.runBlocking {
                    client.putTrackerCredential("token", key, CoreTrackerCredentialWrite(0, "device-a", "", "", "x"))
                }
            }
        }
        assertTrue(requests.isEmpty())
    }

    private fun client(code: Int, responseBody: String) = EpigraphCoreHttpClient(
        client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val sent = request.body?.let { body -> Buffer().also(body::writeTo).readUtf8() }
            requests += request to sent
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message("status")
                .body(responseBody.toResponseBody(JSON_MEDIA_TYPE))
                .build()
        }).build(),
        baseUrl = "https://core.local/".toHttpUrl(),
        clientVersion = "0.1.0",
        json = Json { ignoreUnknownKeys = true },
        preserveInterceptorsForTests = true,
    )

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val LIST = """
            {
              "schemaVersion": 1,
              "credentials": [
                { "trackerKey": "anilist", "revision": 3, "token": "opaque", "futureField": true }
              ]
            }
        """.trimIndent()
    }
}
