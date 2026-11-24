package epigraph.sync.v4

import com.sun.net.httpserver.HttpServer
import epigraph.sync.core.http.CoreHttpResult
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
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
}
