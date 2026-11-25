package epigraph.sync.core.replica

import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal object CoreReplicaPayloadHasher {
    fun canonicalJson(element: JsonElement): String = when (element) {
        JsonNull -> "null"
        is JsonObject -> element.entries
            .sortedBy { it.key }
            .joinToString(prefix = "{", postfix = "}") { (key, value) ->
                "${JsonPrimitive(key)}:${canonicalJson(value)}"
            }
        is JsonArray -> element.joinToString(prefix = "[", postfix = "]") { canonicalJson(it) }
        is JsonPrimitive -> element.toString()
    }

    fun parse(payload: String): JsonElement = Json.parseToJsonElement(payload)

    fun sha256(payload: String): String {
        val bytes = MessageDigest.getInstance(SHA_256).digest(payload.toByteArray(Charsets.UTF_8))
        // A per-byte String.format was most of this hash's cost, paid several times per record.
        val out = CharArray(bytes.size * 2)
        bytes.forEachIndexed { index, byte ->
            val value = byte.toInt() and 0xff
            out[index * 2] = HEX_DIGITS[value ushr 4]
            out[index * 2 + 1] = HEX_DIGITS[value and 0x0f]
        }
        return String(out)
    }

    private val HEX_DIGITS = "0123456789abcdef".toCharArray()

    fun inbox(event: CoreReplicaInboxEvent): String = hashFields(
        event.globalEventId.toString(),
        event.scopeId,
        event.entityType,
        event.entityId,
        event.operation,
    )

    fun tombstone(tombstone: CoreConfirmedTombstone): String = hashFields(
        tombstone.key.scopeId,
        tombstone.key.entityType,
        tombstone.key.entityId,
        tombstone.serverVersion.toString(),
        tombstone.lamport.toString(),
        tombstone.deletedAtMs.toString(),
        tombstone.reasonCode,
    )

    private fun hashFields(vararg values: String?): String = buildString {
        values.forEach { value ->
            if (value == null) {
                append("-1:")
            } else {
                append(value.toByteArray(Charsets.UTF_8).size).append(':').append(value)
            }
            append(';')
        }
    }.let(::sha256)

    private const val SHA_256 = "SHA-256"
}
