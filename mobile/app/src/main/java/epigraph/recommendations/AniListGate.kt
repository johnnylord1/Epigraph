package epigraph.recommendations

import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.network.await
import eu.kanade.tachiyomi.network.jsonMime
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Desktop `anilistGate.ts`: one queue for every AniList request Discover makes. AniList allows a few
 * dozen requests a minute (30 while degraded) and answers more with 429s. The feeds, the score
 * lookups and the comic origin lookup each fired their own burst, used up the minute in a few seconds
 * and starved one another. The gate starts requests by priority and never more than the minute
 * allows, and asks again once after a 429. Waiting for the minute counts against the caller's budget,
 * not against the request timeout.
 */
class AniListGate(private val now: () -> Long = System::currentTimeMillis) {
    /** Earlier starts first: what fills the rows, then lookups. */
    enum class Priority { FEED, LOOKUP }

    private sealed interface Answer {
        class Body(val text: String) : Answer
        data object RateLimited : Answer
    }

    private class Ticket(val priority: Int, val seq: Long)

    /** The fewest requests AniList said were left this minute, and how many started since it said so. */
    private class Remaining(val value: Int, val at: Long, var startedAfter: Int)

    private val mutex = Mutex()
    private val started = ArrayDeque<Long>()
    private val waiting = mutableListOf<Ticket>()
    private var perMinute = DEFAULT_PER_MINUTE
    private var remaining: Remaining? = null
    private var blockedUntil = 0L
    private var inFlight = 0
    private var seq = 0L

    /** Runs [block] once AniList's minute allows it. */
    suspend fun <T> schedule(priority: Priority, block: suspend () -> T): T {
        val ticket = mutex.withLock {
            Ticket(priority.ordinal, seq++).also { ticket ->
                val index = waiting.indexOfFirst { it.priority > ticket.priority }
                if (index < 0) waiting += ticket else waiting.add(index, ticket)
            }
        }
        try {
            while (true) {
                val wait = mutex.withLock { tryStart(ticket) }
                if (wait == 0L) break
                delay(wait)
            }
        } catch (e: Throwable) {
            withContext(NonCancellable) { mutex.withLock { waiting.remove(ticket) } }
            throw e
        }
        try {
            return block()
        } finally {
            withContext(NonCancellable) { mutex.withLock { inFlight -= 1 } }
        }
    }

    /** What AniList's rate limit headers said; a 429's `Retry-After` holds every request back. */
    suspend fun observe(code: Int, limit: Int?, left: Int?, retryAfterSeconds: Int?) {
        mutex.withLock { observeLocked(code, limit, left, retryAfterSeconds) }
    }

    private fun observeLocked(code: Int, limit: Int?, left: Int?, retryAfterSeconds: Int?) {
        val time = now()
        if (limit != null && limit > 0) perMinute = limit
        val current = remaining
        // Responses arrive out of order; the lowest count is the one closest to the truth.
        if (left != null && (current == null || left <= current.value - current.startedAfter)) {
            remaining = Remaining(left, time, 0)
        }
        if (code == 429) blockedUntil = maxOf(blockedUntil, time + (retryAfterSeconds?.times(1_000L) ?: WINDOW_MS))
    }

    /**
     * Posts [payload] to AniList through the gate. Null when it failed, timed out or was still rate
     * limited after one more try.
     */
    suspend fun post(
        client: OkHttpClient,
        payload: String,
        priority: Priority,
        timeoutMs: Long = REQUEST_TIMEOUT_MS,
    ): String? {
        repeat(1 + RETRIES_AFTER_RATE_LIMIT) {
            val answer = schedule(priority) {
                runCatching {
                    withTimeoutOrNull(timeoutMs) {
                        client.newCall(POST(ANILIST_URL, body = payload.toRequestBody(jsonMime))).await().use { response ->
                            observe(
                                response.code,
                                response.header("X-RateLimit-Limit")?.toIntOrNull(),
                                response.header("X-RateLimit-Remaining")?.toIntOrNull(),
                                response.header("Retry-After")?.toIntOrNull(),
                            )
                            when {
                                response.code == 429 -> Answer.RateLimited
                                response.isSuccessful -> Answer.Body(response.body.string())
                                else -> null
                            }
                        }
                    }
                }.getOrNull()
            }
            if (answer !is Answer.RateLimited) return (answer as? Answer.Body)?.text
        }
        return null
    }

    /** Waits for [ticket]'s turn: 0 when it may start now (and is counted as started). */
    private fun tryStart(ticket: Ticket): Long {
        val time = now()
        val wait = waitMs(time)
        if (waiting.firstOrNull() !== ticket || inFlight >= MAX_IN_FLIGHT) return maxOf(wait, TURN_POLL_MS)
        if (wait > 0) return wait
        waiting.removeAt(0)
        started.addLast(time)
        remaining?.let { it.startedAfter += 1 }
        inFlight += 1
        return 0
    }

    private fun waitMs(time: Long): Long {
        while (started.isNotEmpty() && started.first() <= time - WINDOW_MS) started.removeFirst()
        remaining?.let { if (it.at <= time - WINDOW_MS) remaining = null }
        if (time < blockedUntil) return blockedUntil - time
        val windowLeft = perMinute - RESERVED_PER_MINUTE - started.size
        val header = remaining
        val headerLeft = header?.let { it.value - RESERVED_PER_MINUTE - it.startedAfter } ?: Int.MAX_VALUE
        if (windowLeft > 0 && headerLeft > 0) return 0
        val windowFrees = if (windowLeft > 0) 0 else started.first() + WINDOW_MS - time
        val headerFrees = if (headerLeft > 0 || header == null) 0 else header.at + WINDOW_MS - time
        return maxOf(1, windowFrees, headerFrees)
    }

    companion object {
        /** The one gate every Discover request to AniList goes through. */
        val shared = AniListGate()

        private const val ANILIST_URL = "https://graphql.anilist.co"
        internal const val WINDOW_MS = 60_000L
        internal const val DEFAULT_PER_MINUTE = 30

        // Left unused each minute for requests made outside the gate (the trackers).
        internal const val RESERVED_PER_MINUTE = 1
        internal const val MAX_IN_FLIGHT = 4
        private const val RETRIES_AFTER_RATE_LIMIT = 1
        private const val REQUEST_TIMEOUT_MS = 8_000L
        private const val TURN_POLL_MS = 100L
    }
}
