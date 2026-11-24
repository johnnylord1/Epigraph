package epigraph.sync.core.sourceprefs

import co.touchlab.kermit.Logger
import epigraph.contract.SourcePreferenceRules
import epigraph.contract.SourcePreferenceValue
import epigraph.novel.plugin.NovelPluginManager
import epigraph.sync.OfferedSourcePreference
import epigraph.sync.SourcePreferenceStore
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * The settings of installed LNReader novel plugins (`pluginSettings`), as the plugin details
 * screen shows them. Values are read from and written to the plugin's own `storage`, where the
 * plugin's `storage.get` finds them; writing reloads the plugin so it picks the value up.
 *
 * Only declared settings are offered, and only values the plugin stored (a plugin still on its
 * default is not compared). A missing type is a text field, as in LNReader.
 */
class AndroidNovelPluginSettingStore(
    private val plugins: NovelPluginManager,
) : SourcePreferenceStore {

    override suspend fun installedSources(): Map<String, List<OfferedSourcePreference>> {
        plugins.ensureInstalledPluginsLoaded()
        return plugins.installedPluginsFlow.value.associate { plugin ->
            plugin.id to try {
                declaredSettings(plugin.id)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                Logger.w(error) { "Could not read the settings of novel plugin ${plugin.id}" }
                emptyList()
            }
        }
    }

    override suspend fun write(sourceId: String, key: String, value: SourcePreferenceValue): Boolean {
        val declared = plugins.loadPluginSettings(sourceId) ?: return false
        if (declared[key] !is JsonObject) return false
        plugins.writePluginSetting(sourceId, key, value.toJson())
        return true
    }

    override suspend fun reset(sourceId: String, key: String): Boolean {
        val declared = plugins.loadPluginSettings(sourceId) ?: return false
        if (declared[key] !is JsonObject) return false
        plugins.deletePluginSetting(sourceId, key)
        return true
    }

    private suspend fun declaredSettings(pluginId: String): List<OfferedSourcePreference> =
        plugins.loadPluginSettings(pluginId).orEmpty().mapNotNull { (key, element) ->
            val setting = element as? JsonObject ?: return@mapNotNull null
            val stored = plugins.readPluginSetting(pluginId, key)
            offeredSetting(key, setting, stored)
        }

    internal companion object {
        /** The offered form of one `pluginSettings` entry and the value the plugin stored for it. */
        fun offeredSetting(key: String, setting: JsonObject, stored: JsonElement?): OfferedSourcePreference {
            val options = (setting["options"] as? JsonArray)?.mapNotNull { option ->
                ((option as? JsonObject)?.get("value") as? JsonPrimitive)?.takeIf { it.isString }?.content
            }
            return when ((setting["type"] as? JsonPrimitive)?.contentOrNull) {
                "Switch" -> OfferedSourcePreference(
                    key = key,
                    valueType = SourcePreferenceRules.VALUE_TYPE_BOOLEAN,
                    entryValues = null,
                    current = (stored as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
                        ?.let(SourcePreferenceValue::Flag),
                )
                "Select" -> OfferedSourcePreference(
                    key = key,
                    valueType = SourcePreferenceRules.VALUE_TYPE_STRING,
                    entryValues = options.orEmpty(),
                    current = stored.asText(),
                )
                "CheckboxGroup" -> OfferedSourcePreference(
                    key = key,
                    valueType = SourcePreferenceRules.VALUE_TYPE_STRING_SET,
                    entryValues = options.orEmpty(),
                    current = (stored as? JsonArray)?.let { array ->
                        val entries = array.map { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content }
                        if (entries.any { it == null }) null else SourcePreferenceValue.TextSet(entries.filterNotNull())
                    },
                )
                else -> OfferedSourcePreference(
                    key = key,
                    valueType = SourcePreferenceRules.VALUE_TYPE_STRING,
                    entryValues = null,
                    current = stored.asText(),
                )
            }
        }

        private fun JsonElement?.asText(): SourcePreferenceValue? =
            (this as? JsonPrimitive)?.takeIf { it.isString }?.content?.let(SourcePreferenceValue::Text)
    }
}
