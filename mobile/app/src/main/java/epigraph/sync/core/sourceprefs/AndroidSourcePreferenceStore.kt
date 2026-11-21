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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.preference.R as preferenceR

/**
 * The settings of installed comic extensions, read from the screen each extension builds.
 *
 * Only settings shown as a switch, a list, a multi-choice list or a text field are offered; the
 * screen is built against a store that ignores writes, so reading never changes a setting.
 * Values are read from and written to the source's own shared preferences, as the extension
 * details screen does.
 */
class AndroidSourcePreferenceStore(
    context: Context,
    private val extensions: ExtensionManager,
) : SourcePreferenceStore {
    private val appContext = context.applicationContext

    override suspend fun installedSources(): Map<String, List<OfferedSourcePreference>> {
        // Before the extensions load, an empty map would read as "nothing installed".
        if (!extensions.isInitialized.value) error("extensions are not loaded yet")
        val sources = configurableSources()
        return withContext(Dispatchers.Main) {
            sources.mapNotNull { source ->
                try {
                    source.id.toString() to offeredPreferences(source)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    // One broken extension screen must not stop the others from syncing.
                    Logger.w { "Source preferences of ${source.id} could not be read: ${failure.javaClass.simpleName}" }
                    null
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

    private fun configurableSources(): List<ConfigurableSource> =
        extensions.installedExtensionsFlow.value
            .filterNot { it.isNovel }
            .flatMap { it.sources }
            .filterIsInstance<ConfigurableSource>()
            .distinctBy { it.id }

    @SuppressLint("RestrictedApi")
    private fun offeredPreferences(source: ConfigurableSource): List<OfferedSourcePreference> {
        val themed = ContextThemeWrapper(appContext, preferenceR.style.PreferenceThemeOverlay)
        val manager = PreferenceManager(themed)
        manager.preferenceDataStore = ReadOnlyPreferenceDataStore
        val screen = manager.createPreferenceScreen(themed)
        source.setupPreferenceScreen(screen)
        val stored = source.sourcePreferences()
        return screen.leaves().mapNotNull { offered(it, stored) }.distinctBy { it.key }
    }

    private fun offered(preference: Preference, stored: SharedPreferences): OfferedSourcePreference? {
        val key = preference.key?.takeIf(SourcePreferenceRules::isSyncableKey) ?: return null
        val raw = if (stored.contains(key)) stored.all[key] else null
        return when (preference) {
            is TwoStatePreference -> OfferedSourcePreference(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_BOOLEAN,
                entryValues = null,
                current = (raw as? Boolean)?.let(SourcePreferenceValue::Flag),
            )
            is ListPreference -> OfferedSourcePreference(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_STRING,
                entryValues = preference.entryValues?.map(CharSequence::toString).orEmpty(),
                current = (raw as? String)?.let(SourcePreferenceValue::Text),
            )
            is MultiSelectListPreference -> OfferedSourcePreference(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_STRING_SET,
                entryValues = preference.entryValues?.map(CharSequence::toString).orEmpty(),
                current = (raw as? Set<*>)
                    ?.takeIf { set -> set.all { it is String } }
                    ?.let { set -> SourcePreferenceValue.TextSet(set.map { it as String }) },
            )
            is EditTextPreference -> OfferedSourcePreference(
                key = key,
                valueType = SourcePreferenceRules.VALUE_TYPE_STRING,
                entryValues = null,
                current = (raw as? String)?.let(SourcePreferenceValue::Text),
            )
            // Anything else (custom widgets, plain links) is not a simple setting.
            else -> null
        }
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
