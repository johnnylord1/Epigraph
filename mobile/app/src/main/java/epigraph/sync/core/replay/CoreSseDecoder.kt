package epigraph.sync.core.replay

import epigraph.sync.core.protocol.CoreChangeEnvelope
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * Incremental, transport-independent decoder for the SSE event types emitted by syncd v1.
 * The caller remains responsible for HTTP, TLS pinning, cancellation and reconnect backoff.
 */
class CoreSseDecoder(
    private val json: Json = DEFAULT_JSON,
) {
    private val pending = StringBuilder()
    private var pendingCarriageReturn = false

    fun feed(chunk: String): List<CoreSseEvent> {
        appendNormalized(chunk)
        val events = mutableListOf<CoreSseEvent>()
        while (true) {
            val frameEnd = pending.indexOf("\n\n")
            if (frameEnd < 0) break
            val frame = pending.substring(0, frameEnd)
            pending.delete(0, frameEnd + 2)
            decodeFrameOrNull(frame)?.let(events::add)
        }
        return events
    }

    /**
     * Signals EOF. syncd events always terminate with a blank line, so retaining a partial frame
     * would silently lose a change and is treated as a protocol error.
     */
    fun finish() {
        if (pendingCarriageReturn) {
            pending.append('\n')
            pendingCarriageReturn = false
        }
        if (pending.isNotBlank()) {
            throw CoreSseProtocolException("SSE stream ended with a truncated event")
        }
        pending.clear()
    }

    private fun appendNormalized(chunk: String) {
        for (character in chunk) {
            if (pendingCarriageReturn) {
                pending.append('\n')
                pendingCarriageReturn = false
                if (character == '\n') continue
            }
            if (character == '\r') {
                pendingCarriageReturn = true
            } else {
                pending.append(character)
            }
        }
    }

    private fun decodeFrameOrNull(frame: String): CoreSseEvent? {
        var eventName: String? = null
        var eventId: String? = null
        val data = mutableListOf<String>()

        frame.lineSequence().forEach { line ->
            if (line.isEmpty() || line.startsWith(':')) return@forEach
            val separator = line.indexOf(':')
            val field = if (separator < 0) line else line.substring(0, separator)
            val rawValue = if (separator < 0) "" else line.substring(separator + 1)
            val value = rawValue.removePrefix(" ")
            when (field) {
                "event" -> eventName = value
                "id" -> {
                    if ('\u0000' in value) {
                        throw CoreSseProtocolException("SSE event id contains a null character")
                    }
                    eventId = value
                }
                "data" -> data += value
            }
        }

        // Comment-only keep-alives do not dispatch an event under the SSE specification.
        if (eventName == null && eventId == null && data.isEmpty()) return null
        val payload = data.joinToString("\n")
        return when (eventName ?: "message") {
            "change" -> decodeChange(eventId, payload)
            "ping" -> CoreSseEvent.Ping
            "replay_required" -> CoreSseEvent.ReplayRequired(
                decodeJson("replay_required", payload),
            )
            "catalog_revision" -> CoreSseEvent.CatalogRevision(decodeJson("catalog_revision", payload))
            else -> throw CoreSseProtocolException("Unsupported syncd SSE event: ${eventName ?: "message"}")
        }
    }

    private fun decodeChange(eventId: String?, payload: String): CoreSseEvent.Change {
        val globalEventId = eventId?.toLongOrNull()
            ?: throw CoreSseProtocolException("syncd change event has no valid global id")
        if (globalEventId < 0) {
            throw CoreSseProtocolException("syncd change event id must not be negative")
        }
        val envelope = decodeJson<CoreChangeEnvelope>("change", payload)
        if (envelope.serverVersion != globalEventId) {
            throw CoreSseProtocolException(
                "SSE event id $globalEventId does not match change serverVersion ${envelope.serverVersion}",
            )
        }
        return CoreSseEvent.Change(globalEventId, envelope)
    }

    private inline fun <reified T> decodeJson(eventName: String, payload: String): T {
        if (payload.isEmpty()) {
            throw CoreSseProtocolException("syncd $eventName event has no data")
        }
        return try {
            json.decodeFromString<T>(payload)
        } catch (error: SerializationException) {
            throw CoreSseProtocolException("Invalid syncd $eventName payload", error)
        }
    }

    private companion object {
        val DEFAULT_JSON = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
}
