package epigraph.sync.core.sourceprefs

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.view.ContextThemeWrapper
import androidx.preference.EditTextPreference
import androidx.preference.ListPreference
import androidx.preference.MultiSelectListPreference
import androidx.preference.Preference
import androidx.preference.PreferenceDataStore
import androidx.preference.PreferenceGroup
import androidx.preference.PreferenceManager
import androidx.preference.TwoStatePreference
import co.touchlab.kermit.Logger
import epigraph.contract.SourcePreferenceRules
import epigraph.contract.SourcePreferenceValue
import epigraph.sync.OfferedSourcePreference
import epigraph.sync.SourcePreferenceStore
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.sourcePreferences
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.preference.R as preferenceR

/**
 * The settings of installed comic extensions, read from the screen each extension builds.
 *
 * Only settings shown as a switch, a list, a multi-choice list or a text field are offered; the
 * screen is built against a store that ignores writes, so reading never changes a setting.
 * The offered schema is cached per `(source.id, extension.versionCode)` so subsequent syncs read
 * values directly from SharedPreferences on [Dispatchers.IO] without touching [Dispatchers.Main].
 */
class AndroidSourcePreferenceStore(
    context: Context,
    private val extensions: ExtensionManager,
) : SourcePreferenceStore {
    private val appContext = context.applicationContext
    private val schemaCache = ConcurrentHashMap<Pair<Long, Long>, List<PreferenceSchema>>()

    private data class PreferenceSchema(
        val key: String,
        val valueType: String,
        val entryValues: List<String>?,
    )

    private data class VersionedSource(
        val source: ConfigurableSource,
        val versionCode: Long,
    )

    override suspend fun installedSources(): Map<String, List<OfferedSourcePreference>> {
        // Before the extensions load, an empty map would read as "nothing installed".
        if (!extensions.isInitialized.value) error("extensions are not loaded yet")
        val sources = versionedConfigurableSources()
        val uncached = sources.filter { !schemaCache.containsKey(it.source.id to it.versionCode) }
        if (uncached.isNotEmpty()) {
            withContext(Dispatchers.Main) {
                for (entry in uncached) {
                    try {
                        schemaCache[entry.source.id to entry.versionCode] = inspectSchema(entry.source)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (failure: Throwable) {
                        // One broken extension screen must not stop the others from syncing.
                        Logger.w { "Source preferences of ${entry.source.id} could not be read: ${failure.javaClass.simpleName}" }
                    }
                }
            }
        }
        return withContext(Dispatchers.IO) {
            sources.mapNotNull { entry ->
                val schema = schemaCache[entry.source.id to entry.versionCode] ?: return@mapNotNull null
                val stored = entry.source.sourcePreferences().all
                entry.source.id.toString() to schema.map { descriptor ->
                    OfferedSourcePreference(
                        key = descriptor.key,
                        valueType = descriptor.valueType,
                        entryValues = descriptor.entryValues,
                        current = currentValue(descriptor.valueType, stored[descriptor.key]),
                    )
                }
            }.toMap()
        }
    }

    override suspend fun write(sourceId: String, key: String, value: SourcePreferenceValue): Boolean {
        val id = sourceId.toLongOrNull() ?: return false
        val source = configurableSources().firstOrNull { it.id == id } ?: return false
        val editor = source.sourcePreferences().edit()
        when (value) {
            is SourcePreferenceValue.Flag -> editor.putBoolean(key, value.value)
            is SourcePreferenceValue.Text -> editor.putString(key, value.value)
            is SourcePreferenceValue.TextSet -> editor.putStringSet(key, value.values.toSet())
        }
        return withContext(Dispatchers.IO) { editor.commit() }
    }

    override suspend fun reset(sourceId: String, key: String): Boolean {
        val id = sourceId.toLongOrNull() ?: return false
        val source = configurableSources().firstOrNull { it.id == id } ?: return false
        return withContext(Dispatchers.IO) { source.sourcePreferences().edit().remove(key).commit() }
    }

    private fun versionedConfigurableSources(): List<VersionedSource> =
        extensions.installedExtensionsFlow.value
            .filterNot { it.isNovel }
            .flatMap { ext ->
                ext.sources.filterIsInstance<ConfigurableSource>().map { VersionedSource(it, ext.versionCode) }
            }
            .distinctBy { it.source.id }

    private fun configurableSources(): List<ConfigurableSource> =
        versionedConfigurableSources().map { it.source }

    @SuppressLint("RestrictedApi")
    private fun inspectSchema(source: ConfigurableSource): List<PreferenceSchema> {
        val themed = ContextThemeWrapper(appContext, preferenceR.style.PreferenceThemeOverlay)
        val manager = PreferenceManager(themed)
        manager.preferenceDataStore = ReadOnlyPreferenceDataStore
        val screen = manager.createPreferenceScreen(themed)
        source.setupPreferenceScreen(screen)
        return screen.leaves().mapNotNull(::describe).distinctBy { it.key }
    }

    private fun describe(preference: Preference): PreferenceSchema? {
        val key = preference.key?.takeIf(SourcePreferenceRules::isSyncableKey) ?: return null
        return when (preference) {
            is TwoStatePreference -> PreferenceSchema(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_BOOLEAN,
                entryValues = null,
            )
            is ListPreference -> PreferenceSchema(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_STRING,
                entryValues = preference.entryValues?.map(CharSequence::toString).orEmpty(),
            )
            is MultiSelectListPreference -> PreferenceSchema(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_STRING_SET,
                entryValues = preference.entryValues?.map(CharSequence::toString).orEmpty(),
            )
            is EditTextPreference -> PreferenceSchema(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_STRING,
                entryValues = null,
            )
            // Anything else (custom widgets, plain links) is not a simple setting.
            else -> null
        }
    }

    private fun currentValue(valueType: String, raw: Any?): SourcePreferenceValue? = when (valueType) {
        SourcePreferenceRules.VALUE_TYPE_BOOLEAN -> (raw as? Boolean)?.let(SourcePreferenceValue::Flag)
        SourcePreferenceRules.VALUE_TYPE_STRING -> (raw as? String)?.let(SourcePreferenceValue::Text)
        SourcePreferenceRules.VALUE_TYPE_STRING_SET -> (raw as? Set<*>)
            ?.takeIf { set -> set.all { it is String } }
            ?.let { set -> SourcePreferenceValue.TextSet(set.map { it as String }) }
        else -> null
    }

    private fun PreferenceGroup.leaves(): List<Preference> =
        (0 until preferenceCount).flatMap { index ->
            when (val child = getPreference(index)) {
                is PreferenceGroup -> child.leaves()
                else -> listOf(child)
            }
        }
}

/** Lets an extension build its screen without any of its default values being stored. */
private object ReadOnlyPreferenceDataStore : PreferenceDataStore() {
    override fun putString(key: String?, value: String?) = Unit
    override fun putStringSet(key: String?, values: MutableSet<String>?) = Unit
    override fun putInt(key: String?, value: Int) = Unit
    override fun putLong(key: String?, value: Long) = Unit
    override fun putFloat(key: String?, value: Float) = Unit
    override fun putBoolean(key: String?, value: Boolean) = Unit
    override fun getString(key: String?, defValue: String?): String? = defValue
    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
    override fun getInt(key: String?, defValue: Int): Int = defValue
    override fun getLong(key: String?, defValue: Long): Long = defValue
    override fun getFloat(key: String?, defValue: Float): Float = defValue
    override fun getBoolean(key: String?, defValue: Boolean): Boolean = defValue
}
