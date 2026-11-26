package epigraph.sync.v4

import com.sun.net.httpserver.HttpServer
import epigraph.sync.core.http.CoreHttpResult
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.util.zip.GZIPOutputStream

class V4CoreHttpClientTest {
    @Test
    fun `snapshot decodes a gzipped Core response`() = runTest {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v4/snapshot") { exchange ->
            val body = ByteArrayOutputStream()
            GZIPOutputStream(body).use {
                it.write(
                    """{"profileId":"main","serverSeq":7,"minReplayableSeq":0,"serverTimeMs":1000,"recordCount":0,"records":[]}"""
                        .toByteArray(),
                )
            }
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.responseHeaders.add("Content-Encoding", "gzip")
            exchange.sendResponseHeaders(200, body.size().toLong())
            exchange.responseBody.use { body.writeTo(it) }
        }
        server.start()
        try {
            val url = "http://127.0.0.1:${server.address.port}/".toHttpUrl()
            val http = V4CoreHttpClient(OkHttpClient(), url, "0.1.0")
            val response = http.snapshot("fixture") as CoreHttpResult.Success
            assertEquals(7L, response.value?.serverSeq)
        } finally {
            server.stop(0)
        }
    }

    private val emptySnapshot =
        """{"profileId":"main","serverSeq":7,"minReplayableSeq":0,"serverTimeMs":1000,"recordCount":0,"records":[]}"""

    /** Pre-paging Core payload: no `supportsPagedSnapshot`/`maxSnapshotPageItems`. */
    private val oldCapabilities =
        """{"profileId":"main","deviceId":"android-1","serverSeq":7,"minReplayableSeq":0,"serverTimeMs":1000}"""

    private fun interceptedClient(body: String, seen: MutableList<HttpUrl>): OkHttpClient =
        OkHttpClient.Builder().addInterceptor { chain ->
            seen += chain.request().url
            Response.Builder()
                .request(chain.request())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(body.toResponseBody("application/json".toMediaType()))
                .build()
        }.build()

    @Test
    fun `snapshot sends afterSeq and limit only when paging`() = runTest {
        val seen = mutableListOf<HttpUrl>()
        val http = V4CoreHttpClient(interceptedClient(emptySnapshot, seen), "https://127.0.0.1:4777/".toHttpUrl(), "0.1.0")

        http.snapshot("tok", afterSeq = 4_000L, limit = 5_000L)
        http.snapshot("tok")

        assertEquals("4000", seen[0].queryParameter("afterSeq"))
        assertEquals("5000", seen[0].queryParameter("limit"))
        assertEquals(null, seen[1].queryParameter("afterSeq"))
        assertEquals(null, seen[1].queryParameter("limit"))
    }

    @Test
    fun `responses from older Cores without paging fields decode with safe defaults`() = runTest {
        val url = "https://127.0.0.1:4777/".toHttpUrl()

        val snapshot = V4CoreHttpClient(interceptedClient(emptySnapshot, mutableListOf()), url, "0.1.0")
            .snapshot("tok") as CoreHttpResult.Success
        assertEquals(false, snapshot.value?.hasMore)
        assertEquals(0L, snapshot.value?.nextAfterSeq)

        val capabilities = V4CoreHttpClient(interceptedClient(oldCapabilities, mutableListOf()), url, "0.1.0")
            .capabilities("tok") as CoreHttpResult.Success
        assertEquals(false, capabilities.value.supportsPagedSnapshot)
        assertEquals(0, capabilities.value.maxSnapshotPageItems)
    }
}
