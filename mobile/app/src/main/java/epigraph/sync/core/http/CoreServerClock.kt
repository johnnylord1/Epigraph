package epigraph.sync.core.http

import java.util.concurrent.atomic.AtomicLong

/**
 * How far the paired Core's wall clock runs ahead of this phone's, learned from the
 * `X-Epigraph-Server-Time-Ms` header of each Core response.
 *
 * The Core settles concurrent edits by their wall-clock time, so a phone whose clock runs behind
 * would lose an edit it made after the desktop's. Outbox rows are stamped with this offset applied
 * when they are written, never when they are sent: a resend must carry the same clock, or the Core
 * would refuse it as a reused mutation id.
 */
class CoreServerClock(
    initialOffsetMs: Long = 0L,
    private val persist: (Long) -> Unit = {},
    private val wallClock: () -> Long = System::currentTimeMillis,
) {
    private val offset = AtomicLong(initialOffsetMs)

    fun offsetMs(): Long = offset.get()

    /** This phone's wall clock moved onto the Core's. */
    fun nowMs(): Long = wallClock() + offsetMs()

    /** [epochMillis] read from this phone's clock, moved onto the Core's; never negative. */
    fun toCoreTime(epochMillis: Long): Long {
        val shifted = epochMillis + offsetMs()
        return if (shifted < 0L) 0L else shifted
    }

    /**
     * Learns from one response: the Core read [serverTimeMs] while the request was between
     * [sentAtMs] and [receivedAtMs] on this phone's clock. A slow round trip says too little and
     * is ignored; an offset that still fits the sample (within [TOLERANCE_MS]) is kept, so the
     * stamps do not wander with network jitter.
     */
    fun observe(serverTimeMs: Long, sentAtMs: Long, receivedAtMs: Long) {
        if (serverTimeMs <= 0L || sentAtMs <= 0L || receivedAtMs < sentAtMs) return
        if (receivedAtMs - sentAtMs > MAX_ROUND_TRIP_MS) return
        val lowest = serverTimeMs - receivedAtMs
        val highest = serverTimeMs - sentAtMs
        val current = offset.get()
        if (current in (lowest - TOLERANCE_MS)..(highest + TOLERANCE_MS)) return
        val learned = lowest + (highest - lowest) / 2
        if (offset.compareAndSet(current, learned)) {
            runCatching { persist(learned) }
        }
    }

    fun observeHeader(value: String?, sentAtMs: Long, receivedAtMs: Long) {
        val serverTimeMs = value?.trim()?.toLongOrNull() ?: return
        observe(serverTimeMs, sentAtMs, receivedAtMs)
    }

    companion object {
        const val HEADER = "X-Epigraph-Server-Time-Ms"
        const val MAX_ROUND_TRIP_MS = 3_000L
        const val TOLERANCE_MS = 250L
    }
}
