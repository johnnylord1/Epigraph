package epigraph.sync.v4

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest

/**
 * One entity as a bridge sees it locally, before any HLC is stamped on it. Exports stamp drafts
 * with fresh clocks; digests hash them. Because no clock lives here, a digest never changes when
 * only the HLC would.
 */
internal data class V4ItemDraft(
    val domain: String,
    val entityType: String,
    val entityKey: String,
    val payload: JsonElement = JsonNull,
    val deleted: Boolean = false,
) {
    val key: V4DigestKey get() = V4DigestKey(domain, entityType, entityKey)
}

internal data class V4DigestKey(val domain: String, val entityType: String, val entityKey: String)

/** A stored baseline digest. A deleted row records that the key was tombstoned on the Core. */
internal data class V4StoredDigest(val digest: String, val deleted: Boolean)

internal fun List<V4ItemDraft>.stamp(clock: V4HlcClock): List<V4OutgoingItem> = map { draft ->
    V4OutgoingItem(
        domain = draft.domain,
        entityType = draft.entityType,
        entityKey = draft.entityKey,
        deleted = draft.deleted,
        hlc = clock.next(),
        payload = draft.payload,
    )
}

/** Canonical JSON digest shared by every bridge: SHA-256 over sorted keys, HLC excluded. */
internal object V4LocalDigest {
    fun of(draft: V4ItemDraft): String {
        val canonical = canonicalJson(
            JsonObject(
                mapOf(
                    "domain" to JsonPrimitive(draft.domain),
                    "entityType" to JsonPrimitive(draft.entityType),
                    "entityKey" to JsonPrimitive(draft.entityKey),
                    "deleted" to JsonPrimitive(draft.deleted),
                    "payload" to draft.payload,
                ),
            ),
        )
        return MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    fun canonicalJson(element: JsonElement): String = buildString { appendCanonical(element) }

    private fun StringBuilder.appendCanonical(element: JsonElement) {
        when (element) {
            is JsonObject -> {
                append('{')
                element.keys.sorted().forEachIndexed { index, key ->
                    if (index > 0) append(',')
                    append(JsonPrimitive(key).toString())
                    append(':')
                    appendCanonical(element.getValue(key))
                }
                append('}')
            }
            is JsonArray -> {
                append('[')
                element.forEachIndexed { index, item ->
                    if (index > 0) append(',')
                    appendCanonical(item)
                }
                append(']')
            }
            is JsonPrimitive -> append(element.toString())
        }
    }
}
