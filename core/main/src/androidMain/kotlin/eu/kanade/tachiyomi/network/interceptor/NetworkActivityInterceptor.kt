package eu.kanade.tachiyomi.network.interceptor

import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer

/**
 * Records when the app last talked to a server, so long jobs can tell a slow source still
 * answering from one stuck waiting on something that will never come (e.g. a captcha WebView).
 */
object NetworkActivity {

    /** Longer than the client's call timeout: a request running past it is stuck in an interceptor. */
    private const val STUCK_REQUEST_MS = 150_000L

    private val inFlight = AtomicInteger(0)

    @Volatile
    private var lastActivityAt = System.currentTimeMillis()

    /** Milliseconds since a request started, got its response or read body bytes; 0 while one is waiting. */
    fun idleMillis(): Long {
        val idle = System.currentTimeMillis() - lastActivityAt
        return if (inFlight.get() > 0 && idle < STUCK_REQUEST_MS) 0 else idle
    }

    internal fun started() {
        inFlight.incrementAndGet()
        touch()
    }

    internal fun ended() {
        touch()
        inFlight.decrementAndGet()
    }

    internal fun touch() {
        lastActivityAt = System.currentTimeMillis()
    }
}

class NetworkActivityInterceptor : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        NetworkActivity.started()
        val response = try {
            chain.proceed(chain.request())
        } finally {
            NetworkActivity.ended()
        }
        // A protocol switch (web socket) hands over the raw connection instead of a body.
        if (response.code == 101) return response
        // The body is read after this returns; a large page on a slow network is still activity.
        return response.newBuilder().body(ActivityResponseBody(response.body)).build()
    }

    private class ActivityResponseBody(private val delegate: ResponseBody) : ResponseBody() {

        private val source by lazy {
            object : ForwardingSource(delegate.source()) {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    return super.read(sink, byteCount).also { NetworkActivity.touch() }
                }
            }.buffer()
        }

        override fun contentType(): MediaType? = delegate.contentType()

        override fun contentLength(): Long = delegate.contentLength()

        override fun source(): BufferedSource = source

        override fun close() = delegate.close()
    }
}
