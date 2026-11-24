package epigraph.sync.v4

import eu.kanade.tachiyomi.network.await
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

sealed interface V4SseMessage {
    data class Hello(val serverSeq: Long, val serverTimeMs: Long) : V4SseMessage
    data class Delta(val record: V4WireRecord) : V4SseMessage
    data class BulkCommitted(val recordCount: Int, val serverSeq: Long, val serverTimeMs: Long) : V4SseMessage
    data class CatchupRequired(val serverSeq: Long?, val serverTimeMs: Long) : V4SseMessage
    data class Clock(val serverTimeMs: Long, val lastSeq: Long) : V4SseMessage
    data class ReplayExpired(val statusCode: Int) : V4SseMessage
}

@Serializable
private data class HelloDto(val serverSeq: Long = 0L, val serverTimeMs: Long = 0L)

@Serializable
private data class BulkCommittedDto(
    val recordCount: Int = 0,
    val serverSeq: Long = 0L,
    val serverTimeMs: Long = 0L,
)

@Serializable
private data class CatchupDto(val serverSeq: Long? = null, val serverTimeMs: Long = 0L)

@Serializable
private data class ClockDto(val serverTimeMs: Long = 0L, val lastSeq: Long = 0L)

/**
 * Lightweight Server-Sent Events stream client for `/v4/events`.
 * Delivers realtime deltas (< 100 ms LAN latency) without polling.
 */
class V4SseClient(
    baseClient: OkHttpClient,
    private val baseUrl: HttpUrl,
    private val clientVersion: String,
    private val hlcClock: V4HlcClock? = null,
    private val json: Json = V4CoreHttpClient.DEFAULT_JSON,
) {
    private val sseClient = baseClient.newBuilder()
        .readTimeout(35, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    suspend fun stream(
        accessToken: String,
        sinceSeq: Long,
        onEvent: suspend (V4SseMessage) -> Unit,
    ) = withContext(Dispatchers.IO) {
        val url = baseUrl.newBuilder()
            .addPathSegments("v4/events")
            .addQueryParameter("sinceSeq", sinceSeq.toString())
            .addQueryParameter("includeOwn", "true")
            .build()
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $accessToken")
            .header("X-Epigraph-Client-Version", clientVersion)
            .header("X-Epigraph-Client-Protocol-Version", "4")
            .header("Accept", "text/event-stream")
            .header("Last-Event-ID", sinceSeq.toString())
            .get()
            .build()

        val call = sseClient.newCall(req)
        val cancelSocket = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            call.await().use { response ->
                if (response.code == 410) {
                    onEvent(V4SseMessage.ReplayExpired(410))
                    return@withContext
                }
                if (!response.isSuccessful) {
                    throw IllegalStateException("V4 SSE stream rejected with HTTP ${response.code}")
                }
                val reader = BufferedReader(InputStreamReader(response.body.byteStream(), Charsets.UTF_8))
                var eventType = "message"
                val dataBuf = StringBuilder()

                while (isActive) {
                    val line = reader.readLine() ?: break
                    when {
                        line.isEmpty() -> {
                            if (dataBuf.isNotEmpty()) {
                                dispatchEvent(eventType, dataBuf.toString().trimEnd('\n'), onEvent)
                                dataBuf.setLength(0)
                            }
                            eventType = "message"
                        }
                        line.startsWith(":") -> Unit // keep-alive comment
                        line.startsWith("event:") -> eventType = line.removePrefix("event:").trim()
                        line.startsWith("data:") -> {
                            if (dataBuf.isNotEmpty()) dataBuf.append('\n')
                            dataBuf.append(line.removePrefix("data:").trimStart())
                        }
                    }
                }
            }
        } finally {
            cancelSocket.cancel()
            call.cancel()
        }
    }

    private suspend fun dispatchEvent(
        eventType: String,
        data: String,
        onEvent: suspend (V4SseMessage) -> Unit,
    ) {
        when (eventType) {
            "hello" -> {
                val dto = json.decodeFromString<HelloDto>(data)
                hlcClock?.calibrateServerTime(dto.serverTimeMs)
                onEvent(V4SseMessage.Hello(dto.serverSeq, dto.serverTimeMs))
            }
            "delta" -> {
                val record = json.decodeFromString<V4WireRecord>(data)
                hlcClock?.observe(record.hlc)
                onEvent(V4SseMessage.Delta(record))
            }
            "bulk_committed" -> {
                val dto = json.decodeFromString<BulkCommittedDto>(data)
                hlcClock?.calibrateServerTime(dto.serverTimeMs)
                onEvent(V4SseMessage.BulkCommitted(dto.recordCount, dto.serverSeq, dto.serverTimeMs))
            }
            "catchup_required" -> {
                val dto = json.decodeFromString<CatchupDto>(data)
                hlcClock?.calibrateServerTime(dto.serverTimeMs)
                onEvent(V4SseMessage.CatchupRequired(dto.serverSeq, dto.serverTimeMs))
            }
            "clock" -> {
                val dto = json.decodeFromString<ClockDto>(data)
                hlcClock?.calibrateServerTime(dto.serverTimeMs)
                onEvent(V4SseMessage.Clock(dto.serverTimeMs, dto.lastSeq))
            }
        }
    }
}
