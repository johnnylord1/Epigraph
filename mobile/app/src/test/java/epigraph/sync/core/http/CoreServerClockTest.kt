package epigraph.sync.core.http

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
import org.junit.jupiter.api.Test

class CoreServerClockTest {
    @Test
    fun `a phone running behind learns the Core offset from one quick answer`() {
        val persisted = mutableListOf<Long>()
        val clock = CoreServerClock(persist = { persisted += it }, wallClock = { 1_000_000 })

        // The Core read 1_027_540 while the request was in flight between 1_000_000 and 1_000_080.
        clock.observe(serverTimeMs = 1_027_540, sentAtMs = 1_000_000, receivedAtMs = 1_000_080)

        assertEquals(27_500, clock.offsetMs())
        assertEquals(1_027_500, clock.nowMs())
        assertEquals(listOf(27_500L), persisted)
    }

    @Test
    fun `an offset that still fits a later answer is kept, so stamps do not wander`() {
        val persisted = mutableListOf<Long>()
        val clock = CoreServerClock(initialOffsetMs = 27_500, persist = { persisted += it })

        clock.observe(serverTimeMs = 2_027_700, sentAtMs = 2_000_000, receivedAtMs = 2_000_060)

        assertEquals(27_500, clock.offsetMs())
        assertEquals(emptyList<Long>(), persisted)
    }

    @Test
    fun `a slow or inconsistent answer teaches nothing`() {
        val clock = CoreServerClock(initialOffsetMs = 5)

        clock.observe(serverTimeMs = 9_000_000, sentAtMs = 1_000_000, receivedAtMs = 1_000_000 + 3_001)
        clock.observe(serverTimeMs = 9_000_000, sentAtMs = 1_000_100, receivedAtMs = 1_000_000)
        clock.observe(serverTimeMs = 0, sentAtMs = 1_000_000, receivedAtMs = 1_000_010)
        clock.observeHeader("not-a-number", sentAtMs = 1_000_000, receivedAtMs = 1_000_010)
        clock.observeHeader(null, sentAtMs = 1_000_000, receivedAtMs = 1_000_010)

        assertEquals(5, clock.offsetMs())
    }

    @Test
    fun `a phone clock ahead is moved back but never before the epoch`() {
        val clock = CoreServerClock(initialOffsetMs = -60_000)

        assertEquals(40_000, clock.toCoreTime(100_000))
        assertEquals(0, clock.toCoreTime(10_000))
    }

    @Test
    fun `the Core client learns the offset from the server time header`() = runTest {
        val clock = CoreServerClock()
        val client = EpigraphCoreHttpClient(
            client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("ok")
                    .header(CoreServerClock.HEADER, "1027540")
                    .sentRequestAtMillis(1_000_000)
                    .receivedResponseAtMillis(1_000_080)
                    .body("{}".toResponseBody("application/json".toMediaType()))
                    .build()
            }).build(),
            baseUrl = "https://core.local/".toHttpUrl(),
            clientVersion = "0.1.0",
            json = Json { ignoreUnknownKeys = true },
            preserveInterceptorsForTests = true,
            serverClock = clock,
        )

        client.capabilities()

        assertEquals(27_500, clock.offsetMs())
    }
}
