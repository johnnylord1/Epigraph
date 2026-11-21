package epigraph.contract

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Rules for syncing comic extension source preferences (`comic.source_preference`), such as a
 * preferred mirror. They match the desktop Syncd rules (`source_preferences.rs`): the same entity
 * IDs, limits and never-synced keys, so a value one device sends is one the other accepts.
 *
 * Credentials, sessions and values an extension caches for itself are never synced. Key matching
 * is by substring, so a few harmless keys are also left out: never syncing a secret matters more.
 */
object SourcePreferenceRules {
    const val ENTITY_TYPE = "comic.source_preference"
    private const val ENTITY_PREFIX = "$ENTITY_TYPE::"

    const val MAX_KEY_BYTES = 128
    const val MAX_STRING_BYTES = 4_096
    const val MAX_SET_ENTRIES = 64
    const val MAX_SET_ENTRY_BYTES = 512
    const val MAX_RECORD_BYTES = 16 * 1_024

    const val VALUE_TYPE_BOOLEAN = "boolean"
    const val VALUE_TYPE_STRING = "string"
    const val VALUE_TYPE_STRING_SET = "string_set"

    private val SECRET_KEY_FRAGMENTS = listOf(
        "password", "passwd", "passcode", "token", "cookie", "apikey", "secret", "login", "signin",
        "session", "auth", "credential", "privatekey", "accesskey", "username", "email", "account",
    )

    private val CACHE_KEY_FRAGMENTS = listOf(
        "fetchedmirrors", "cache", "fetched", "lastupdate", "lastcheck", "lastfetch", "lastsync",
        "timestamp", "expir", "useragent", "uuid", "deviceid", "private",
    )

    private val SECRET_VALUE_FRAGMENTS = listOf(
        "token=", "apikey=", "api_key=", "password=", "passwd=", "access_token", "bearer ",
        "authorization:",
    )

    fun entityIdFor(sourceId: String, key: String): String = "$ENTITY_PREFIX$sourceId::$key"

    /** `(sourceId, key)` of `comic.source_preference::<sourceId>::<key>`, when well formed. */
    fun parseEntityId(entityId: String): Pair<String, String>? {
        if (!entityId.startsWith(ENTITY_PREFIX)) return null
        val rest = entityId.removePrefix(ENTITY_PREFIX)
        val separator = rest.indexOf("::")
        if (separator < 0) return null
        val sourceId = rest.substring(0, separator)
        val key = rest.substring(separator + 2)
        return (sourceId to key).takeIf { isValidSourceId(sourceId) && isValidKey(key) }
    }

    /** A Tachiyomi source ID: a signed 64-bit integer in decimal. */
    fun isValidSourceId(sourceId: String): Boolean {
        val digits = sourceId.removePrefix("-")
        return digits.isNotEmpty() &&
            digits.length <= 19 &&
            digits.all { it in '0'..'9' } &&
            sourceId.toLongOrNull() != null
    }

    private fun isValidKey(key: String): Boolean =
        key.isNotEmpty() &&
            key.utf8Size() <= MAX_KEY_BYTES &&
            key.trim() == key &&
            key.none(Char::isISOControl)

    private fun normalizedKey(key: String): String =
        key.filterNot { it == '_' || it == '-' || it == '.' || it == ' ' }.lowercase()

    /** Whether a key may be synced: well formed, and naming no credential, session or cache. */
    fun isSyncableKey(key: String): Boolean {
        if (!isValidKey(key) || key.startsWith("__")) return false
        val normalized = normalizedKey(key)
        return (SECRET_KEY_FRAGMENTS + CACHE_KEY_FRAGMENTS).none { normalized.contains(it) }
    }

    /** Whether a string carries a secret: URL credentials or an inline token, key or password. */
    fun valueLooksSecret(value: String): Boolean {
        val lower = value.asciiLowercase()
        if (SECRET_VALUE_FRAGMENTS.any { lower.contains(it) }) return true
        return lower.split("://").drop(1).any { afterScheme ->
            val authority = afterScheme.split('/', '?', '#').first()
            authority.contains('@')
        }
    }

    /** Whether a value can be stored in a full-state record for [sourceId] and [key]. */
    fun isSyncable(sourceId: String, key: String, value: SourcePreferenceValue): Boolean =
        isValidSourceId(sourceId) && isSyncableKey(key) && value.isSyncable()

    /**
     * Whether a preference an installed extension offers can hold [value]: the type must match,
     * and list choices must be among the values the extension lists (an older extension that does
     * not list a mirror never stores it). A list without known values accepts nothing.
     */
    fun accepts(
        offeredValueType: String,
        entryValues: List<String>?,
        value: SourcePreferenceValue,
    ): Boolean {
        if (offeredValueType != value.valueType) return false
        return when (value) {
            is SourcePreferenceValue.Flag -> true
            is SourcePreferenceValue.Text -> entryValues == null || value.value in entryValues
            is SourcePreferenceValue.TextSet -> entryValues != null && entryValues.containsAll(value.values)
        }
    }

    /**
     * The value of a stored full-state record for [entityId], when the record is still valid
     * (the same checks the desktop applies before it accepts one).
     */
    fun recordValue(entityId: String, record: Map<String, JsonElement>): SourcePreferenceValue? {
        val (sourceId, key) = parseEntityId(entityId) ?: return null
        fun text(field: String): String? =
            (record[field] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (text("preferenceId") != entityId) return null
        if (text("sourceId") != sourceId || text("key") != key) return null
        if (!isSyncableKey(key)) return null
        val raw = record["value"] ?: return null
        val value = SourcePreferenceValue.fromTyped(text("valueType").orEmpty(), raw) ?: return null
        if (value is SourcePreferenceValue.TextSet && (raw as JsonArray).size != value.values.size) return null
        return value.takeIf { it.isSyncable() }
    }

    private fun String.utf8Size(): Int = encodeToByteArray().size

    private fun String.asciiLowercase(): String =
        map { if (it in 'A'..'Z') it + ('a' - 'A') else it }.joinToString("")

    internal fun stringFits(value: String): Boolean =
        value.utf8Size() <= MAX_STRING_BYTES && !valueLooksSecret(value)

    internal fun setEntryFits(value: String): Boolean =
        value.utf8Size() <= MAX_SET_ENTRY_BYTES && !valueLooksSecret(value)
}

/** A syncable source preference value: only simple types, never anything an extension caches. */
sealed interface SourcePreferenceValue {
    val valueType: String

    fun toJson(): JsonElement

    /** A stable text for comparing values (sets are sorted). Only compared on one device. */
    fun fingerprint(): String = "$valueType:${toJson()}"

    /** Whether the value fits the size limits and does not look like a secret. */
    fun isSyncable(): kotlin.Boolean

    data class Flag(val value: kotlin.Boolean) : SourcePreferenceValue {
        override val valueType: String get() = SourcePreferenceRules.VALUE_TYPE_BOOLEAN
        override fun toJson(): JsonElement = JsonPrimitive(value)
        override fun isSyncable(): kotlin.Boolean = true
    }

    data class Text(val value: String) : SourcePreferenceValue {
        override val valueType: String get() = SourcePreferenceRules.VALUE_TYPE_STRING
        override fun toJson(): JsonElement = JsonPrimitive(value)
        override fun isSyncable(): kotlin.Boolean = SourcePreferenceRules.stringFits(value)
    }

    /** Kept sorted, so equal sets have equal fingerprints. */
    class TextSet(values: Collection<String>) : SourcePreferenceValue {
        val values: List<String> = values.toSortedSet().toList()
        override val valueType: String get() = SourcePreferenceRules.VALUE_TYPE_STRING_SET
        override fun toJson(): JsonElement = JsonArray(values.map(::JsonPrimitive))
        override fun isSyncable(): kotlin.Boolean =
            values.size <= SourcePreferenceRules.MAX_SET_ENTRIES &&
                values.all(SourcePreferenceRules::setEntryFits)

        override fun equals(other: Any?): kotlin.Boolean = other is TextSet && other.values == values
        override fun hashCode(): Int = values.hashCode()
        override fun toString(): String = "TextSet($values)"
    }

    companion object {
        /** The value of a record or command, when it has the declared type. */
        fun fromTyped(valueType: String, value: JsonElement): SourcePreferenceValue? = when (valueType) {
            SourcePreferenceRules.VALUE_TYPE_BOOLEAN ->
                (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull?.let(::Flag)
            SourcePreferenceRules.VALUE_TYPE_STRING ->
                (value as? JsonPrimitive)?.takeIf { it.isString }?.content?.let(::Text)
            SourcePreferenceRules.VALUE_TYPE_STRING_SET -> (value as? JsonArray)?.let { array ->
                val entries = array.map { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content }
                if (entries.any { it == null }) null else TextSet(entries.filterNotNull())
            }
            else -> null
        }
    }
}
