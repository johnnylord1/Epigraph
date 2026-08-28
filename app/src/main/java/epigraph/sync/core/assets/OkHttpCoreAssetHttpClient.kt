package epigraph.sync.core.assets

import eu.kanade.tachiyomi.network.await
import java.io.InputStream
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source

/** Streaming asset transport using the same pinned TLS client as the JSON Core API. */
class OkHttpCoreAssetHttpClient(
    client: OkHttpClient,
    private val baseUrl: HttpUrl,
) : CoreAssetHttpClient {
    private val client = client.newBuilder()
        .apply {
            interceptors().clear()
            networkInterceptors().clear()
        }
        .cache(null)
        .cookieJar(CookieJar.NO_COOKIES)
        .authenticator(Authenticator.NONE)
        .proxyAuthenticator(Authenticator.NONE)
        .eventListener(EventListener.NONE)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    init {
        require(baseUrl.isHttps && baseUrl.encodedPath == "/" && baseUrl.query == null && baseUrl.fragment == null) {
            "Epigraph Core asset URL must be an HTTPS origin"
        }
    }

    override suspend fun execute(
        request: CoreAssetHttpRequest,
        uploadBody: CoreAssetUploadBody?,
    ): CoreAssetHttpResponse {
        require((request.method == CoreAssetMethod.PUT) == (uploadBody != null)) {
            "Only PUT asset requests may provide an upload body"
        }
        val url = requireNotNull(baseUrl.resolve(request.pathAndQuery)) {
            "Epigraph Core asset path is invalid"
        }
        val builder = Request.Builder().url(url)
        request.headers().forEach(builder::header)
        when (request.method) {
            CoreAssetMethod.HEAD -> builder.head()
            CoreAssetMethod.GET -> builder.get()
            CoreAssetMethod.PUT -> builder.put(StreamingAssetRequestBody(request, requireNotNull(uploadBody)))
        }

        val response = client.newCall(builder.build()).await()
        val headers = response.headers.names().associateWith { name -> response.header(name).orEmpty() }
        val body = if (request.method == CoreAssetMethod.GET && response.body.contentLength() != 0L) {
            OkHttpAssetResponseBody(response.body.byteStream(), response::close)
        } else {
            response.close()
            null
        }
        return CoreAssetHttpResponse(response.code, headers, body)
    }

    private class StreamingAssetRequestBody(
        private val request: CoreAssetHttpRequest,
        private val body: CoreAssetUploadBody,
    ) : RequestBody() {
        override fun contentType() = OCTET_STREAM
        override fun contentLength(): Long = requireNotNull(request.contentLength)

        override fun writeTo(sink: BufferedSink) {
            body.openStream().use { input ->
                input.source().use(sink::writeAll)
            }
        }
    }

    private class OkHttpAssetResponseBody(
        private val input: InputStream,
        private val closeResponse: () -> Unit,
    ) : CoreAssetResponseBody {
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int = input.read(buffer, offset, length)

        override fun close() {
            try {
                input.close()
            } finally {
                closeResponse()
            }
        }
    }

    private companion object {
        val OCTET_STREAM = "application/octet-stream".toMediaType()
    }
}
