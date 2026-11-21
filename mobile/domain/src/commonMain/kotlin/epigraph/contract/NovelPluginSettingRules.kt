package epigraph.contract

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * Rules for syncing LNReader novel plugin settings (`novel.plugin_setting`), the options a plugin
 * declares in `pluginSettings`, such as WTR-LAB's preferred translation. They match the desktop
 * Syncd rules (`novel_plugin_settings.rs`). Values, limits and the keys that never travel
 * (credentials, sessions, caches) are those of [SourcePreferenceRules]; only the owner differs: an
 * LNReader plugin ID instead of a numeric source ID.
 */
object NovelPluginSettingRules {
    const val ENTITY_TYPE = "novel.plugin_setting"
    private const val ENTITY_PREFIX = "$ENTITY_TYPE::"
    const val MAX_PLUGIN_ID_BYTES = 128

    fun entityIdFor(pluginId: String, key: String): String = "$ENTITY_PREFIX$pluginId::$key"

    /** An LNReader plugin ID: printable, trimmed, at most 128 bytes and without `::`. */
    fun isValidPluginId(pluginId: String): Boolean =
        pluginId.isNotEmpty() &&
            pluginId.encodeToByteArray().size <= MAX_PLUGIN_ID_BYTES &&
            pluginId.trim() == pluginId &&
            !pluginId.contains("::") &&
            pluginId.none(Char::isISOControl)

    /** `(pluginId, key)` of `novel.plugin_setting::<pluginId>::<key>`, when well formed. */
    fun parseEntityId(entityId: String): Pair<String, String>? {
        if (!entityId.startsWith(ENTITY_PREFIX)) return null
        val rest = entityId.removePrefix(ENTITY_PREFIX)
        val separator = rest.indexOf("::")
        if (separator < 0) return null
        val pluginId = rest.substring(0, separator)
        val key = rest.substring(separator + 2)
        return (pluginId to key).takeIf {
            isValidPluginId(pluginId) && key.isNotEmpty() && !key.contains("::") &&
                key.encodeToByteArray().size <= SourcePreferenceRules.MAX_KEY_BYTES &&
                key.trim() == key && key.none(Char::isISOControl)
        }
    }

    /** Whether a plugin setting may travel at all: a valid plugin and a key naming no secret or cache. */
    fun isSyncableSetting(pluginId: String, key: String): Boolean =
        isValidPluginId(pluginId) && !key.contains("::") && SourcePreferenceRules.isSyncableKey(key)

    /** Whether a value can be stored in a full-state record for [pluginId] and [key]. */
    fun isSyncable(pluginId: String, key: String, value: SourcePreferenceValue): Boolean =
        isSyncableSetting(pluginId, key) && value.isSyncable()

    /** The value of a stored full-state record for [entityId], when the record is still valid. */
    fun recordValue(entityId: String, record: Map<String, JsonElement>): SourcePreferenceValue? {
        val (pluginId, key) = parseEntityId(entityId) ?: return null
        fun text(field: String): String? =
            (record[field] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (text("settingId") != entityId) return null
        if (text("pluginId") != pluginId || text("key") != key) return null
        if (!isSyncableSetting(pluginId, key)) return null
        val raw = record["value"] ?: return null
        val value = SourcePreferenceValue.fromTyped(text("valueType").orEmpty(), raw) ?: return null
        if (value is SourcePreferenceValue.TextSet &&
            (raw as kotlinx.serialization.json.JsonArray).size != value.values.size
        ) {
            return null
        }
        return value.takeIf { it.isSyncable() }
    }
}
