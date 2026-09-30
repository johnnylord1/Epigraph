package epigraph.novel.reader.security

import epigraph.novel.security.NovelNetworkPolicy
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Fetches remote chapter images on behalf of the sandboxed novel WebView.
 *
 * The WebView itself never touches the network. [NovelHtmlSanitizer] rewrites absolute HTTPS
 * image sources to [NovelHtmlSanitizer.REMOTE_IMAGE_SCHEME] and the viewer routes those requests
 * here, where each one:
 * - is HTTPS only, including redirects (HTTPS to HTTP is never followed);
 * - cannot reach private, loopback or link-local addresses, checked by DNS on every connection;
 * - carries no cookies, credentials or referrer;
 * - has a deadline, a byte limit and a raster image content type (SVG is refused);
 * - is cancelled with [cancelAll] when the reader closes.
 */
class NovelRemoteImageBroker(
    networkPolicy: NovelNetworkPolicy = NovelNetworkPolicy(),
    private val maxBytes: Long = MAX_IMAGE_BYTES,
    baseClient: OkHttpClient = OkHttpClient(),
) {
    private val client = baseClient.newBuilder()
        .cookieJar(NoCookies)
        .cache(null)
        .dns(networkPolicy.publicOnlyDns(baseClient.dns))
        .followRedirects(true)
        .followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        .build()

    /** Returns the image for a broker URL produced by the sanitizer, or null when refused. */
    fun load(brokerUrl: String): Image? {
        val target = NovelHtmlSanitizer.decodeRemoteImageUrl(brokerUrl) ?: return null
        val url = target.toHttpUrlOrNull()?.takeIf(HttpUrl::isHttps) ?: return null
        return runCatching {
            client.newCall(Request.Builder().url(url).header("Accept", ACCEPT).build()).execute().use { response ->
                if (!response.isSuccessful || !response.request.url.isHttps) return null
                val mimeType = response.header("Content-Type")
                    ?.substringBefore(';')
                    ?.trim()
                    ?.lowercase()
                    ?.takeIf { it in RASTER_TYPES }
                    ?: return null
                val body = response.body
                if (body.contentLength() > maxBytes) return null
                val output = ByteArrayOutputStream()
                body.byteStream().use { input ->
                    val buffer = ByteArray(16 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (output.size().toLong() + read > maxBytes) return null
                        output.write(buffer, 0, read)
                    }
                }
                Image(mimeType, output.toByteArray())
            }
        }.getOrNull()
    }

    fun cancelAll() {
        client.dispatcher.cancelAll()
    }

    class Image(val mimeType: String, val bytes: ByteArray)

    private object NoCookies : CookieJar {
        override fun loadForRequest(url: HttpUrl): List<Cookie> = emptyList()
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = Unit
    }

    companion object {
        const val MAX_IMAGE_BYTES = 8L * 1024 * 1024
        private const val ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8"
        private val RASTER_TYPES = setOf(
            "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/avif", "image/bmp",
        )
    }
}
