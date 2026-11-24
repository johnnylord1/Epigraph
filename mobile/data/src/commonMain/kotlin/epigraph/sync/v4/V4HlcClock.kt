package epigraph.sync.v4

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import kotlin.math.max

/**
 * Hybrid Logical Clock (HLC) matching `desktop/src-tauri/src/syncd/v4/hlc.rs`.
 */
@Serializable
data class V4Hlc(
    val tsMs: Long,
    val counter: Long = 0L,
    val deviceId: String,
) : Comparable<V4Hlc> {
    override fun compareTo(other: V4Hlc): Int {
        val tsCmp = tsMs.compareTo(other.tsMs)
        if (tsCmp != 0) return tsCmp
        val counterCmp = counter.compareTo(other.counter)
        if (counterCmp != 0) return counterCmp
        return deviceId.compareTo(other.deviceId)
    }
}

/**
 * Thread-safe monotonic HLC generator calibrated against the Core server clock so offline edits
 * from a phone with clock drift still reconcile cleanly upon reconnecting to LAN.
 */
class V4HlcClock(
    private val deviceId: String,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
    initialLastTsMs: Long = 0L,
    initialLastCounter: Long = 0L,
    initialClockOffsetMs: Long = 0L,
) {
    private val lock = Any()
    private var lastTsMs: Long = initialLastTsMs
    private var lastCounter: Long = initialLastCounter
    private var clockOffsetMs: Long = initialClockOffsetMs

    fun calibrateServerTime(serverTimeMs: Long) {
        if (serverTimeMs <= 0L) return
        synchronized(lock) {
            clockOffsetMs = serverTimeMs - wallClockMs()
        }
    }

    fun currentOffsetMs(): Long = synchronized(lock) { clockOffsetMs }

    fun next(): V4Hlc = synchronized(lock) {
        val physicalMs = max(1L, wallClockMs() + clockOffsetMs)
        if (physicalMs > lastTsMs) {
            lastTsMs = physicalMs
            lastCounter = 0L
        } else {
            lastCounter += 1L
        }
        V4Hlc(tsMs = lastTsMs, counter = lastCounter, deviceId = deviceId)
    }

    fun observe(remote: V4Hlc): V4Hlc = synchronized(lock) {
        val physicalMs = max(1L, wallClockMs() + clockOffsetMs)
        val maxTs = max(physicalMs, max(lastTsMs, remote.tsMs))
        lastCounter = when {
            maxTs == lastTsMs && maxTs == remote.tsMs -> max(lastCounter, remote.counter) + 1L
            maxTs == lastTsMs -> lastCounter + 1L
            maxTs == remote.tsMs -> remote.counter + 1L
            else -> 0L
        }
        lastTsMs = maxTs
        V4Hlc(tsMs = lastTsMs, counter = lastCounter, deviceId = deviceId)
    }

    fun snapshotState(): Triple<Long, Long, Long> = synchronized(lock) {
        Triple(lastTsMs, lastCounter, clockOffsetMs)
    }
}

/**
 * Canonical portable URL and key normalization matching Rust `v4/hlc.rs` byte-for-byte.
 * Strips host/scheme and transient query params like `?style=list` or `utm_*`.
 */
object V4PortableUrl {
    private val TRANSIENT_QUERY_PARAMS = setOf(
        "style",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "fbclid",
        "gclid",
        "ref",
    )

    fun normalizePortableUrl(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return ""

        val parsed = runCatching {
            val candidate = if (trimmed.contains("://")) {
                trimmed
            } else if (trimmed.startsWith("/")) {
                "https://epigraph.invalid$trimmed"
            } else {
                "https://epigraph.invalid/$trimmed"
            }
            URI(candidate)
        }.getOrNull() ?: return normalizePathSegments(trimmed)

        val path = normalizePathSegments(parsed.rawPath ?: "/")
        val rawQuery = parsed.rawQuery
        if (rawQuery.isNullOrEmpty()) return path

        val keptParams = rawQuery.split('&')
            .filter { it.isNotEmpty() }
            .mapNotNull { pair ->
                val idx = pair.indexOf('=')
                val rawKey = if (idx >= 0) pair.substring(0, idx) else pair
                val rawVal = if (idx >= 0) pair.substring(idx + 1) else ""
                val key = decodeQueryComponent(rawKey)
                val value = decodeQueryComponent(rawVal)
                if (key.lowercase() in TRANSIENT_QUERY_PARAMS) {
                    null
                } else {
                    key to value
                }
            }
            .sortedWith(compareBy<Pair<String, String>>({ it.first }, { it.second }))

        if (keptParams.isEmpty()) return path
        val encoded = keptParams.joinToString("&") { (k, v) ->
            "${encodeQueryComponent(k)}=${encodeQueryComponent(v)}"
        }
        return "$path?$encoded"
    }

    fun canonicalWorkKey(sourceOrPluginId: String, rawUrl: String): String =
        "${sourceOrPluginId.trim()}:${normalizePortableUrl(rawUrl)}"

    fun canonicalChapterKey(workKey: String, rawChapterUrl: String): String =
        "${workKey.trim()}|${normalizePortableUrl(rawChapterUrl)}"

    private fun normalizePathSegments(rawPath: String): String {
        val withoutFragment = rawPath.substringBefore('#')
        val out = StringBuilder(withoutFragment.length + 1)
        var prevSlash = false
        for (ch in withoutFragment) {
            if (ch == '/') {
                if (!prevSlash) {
                    out.append('/')
                    prevSlash = true
                }
            } else {
                out.append(ch)
                prevSlash = false
            }
        }
        if (out.isEmpty() || out[0] != '/') {
            out.insert(0, '/')
        }
        while (out.length > 1 && out[out.length - 1] == '/') {
            out.deleteCharAt(out.length - 1)
        }
        return out.toString()
    }

    private fun decodeQueryComponent(raw: String): String =
        runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrDefault(raw)

    private fun encodeQueryComponent(raw: String): String =
        URLEncoder.encode(raw, "UTF-8")
}
