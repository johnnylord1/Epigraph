package eu.kanade.tachiyomi.data.backup.restore.restorers

import yokai.util.koin.get
import android.content.Context
import eu.kanade.tachiyomi.core.preference.AndroidPreferenceStore
import eu.kanade.tachiyomi.core.preference.Preference
import eu.kanade.tachiyomi.core.preference.PreferenceStore
import eu.kanade.tachiyomi.data.backup.BackupPreferencePolicy
import eu.kanade.tachiyomi.data.backup.CategoryPreferenceBackup
import eu.kanade.tachiyomi.data.backup.BackupSecretPolicy
import eu.kanade.tachiyomi.core.preference.getEnum
import eu.kanade.tachiyomi.data.backup.create.BackupCreatorJob
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.BackupSourcePreferences
import eu.kanade.tachiyomi.data.backup.models.BooleanPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.FloatPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.LongPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import eu.kanade.tachiyomi.data.library.LibraryUpdateJob
import eu.kanade.tachiyomi.data.preference.PreferenceKeys
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.extension.ExtensionUpdateJob
import eu.kanade.tachiyomi.source.sourcePreferences
import eu.kanade.tachiyomi.ui.library.LibrarySort
import yokai.domain.base.BasePreferences
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.interactor.GetCategories
import yokai.domain.ui.settings.ReaderPreferences

class PreferenceBackupRestorer(
    private val context: Context,
    private val preferenceStore: PreferenceStore = get(),
    private val preferencesHelper: PreferencesHelper = get(),
    private val getCategories: GetCategories = get(),
) {
    /**
     * Restores the app preferences, with their category ids moved to the restored categories.
     * Returns the settings whose categories the backup could not tell; they keep this device's
     * values.
     */
    suspend fun restoreAppPreferences(
        preferences: List<BackupPreference>,
        backupCategories: List<BackupCategory>,
        onComplete: () -> Unit,
    ): Set<CategoryPreferenceBackup.Setting> {
        val deviceCategories = CategoryLibrary.entries.associateWith { library ->
            getCategories.await(library).mapNotNull { category -> category.id?.let { category.name to it } }.toMap()
        }
        val remapped = CategoryPreferenceBackup.remap(preferences, backupCategories) { library, name ->
            deviceCategories[library]?.get(name)
        }
        val restorable = BackupPreferencePolicy.restorableAppPreferences(remapped.preferences) { key ->
            // The languages default to the device language until they are first changed.
            if (key == PreferenceKeys.enabledLanguages) {
                preferencesHelper.enabledLanguages().get()
            } else {
                preferenceStore.getStringSet(key).get()
            }
        }
        restorePreferences(restorable, preferenceStore)

        ExtensionUpdateJob.setupTask(context)
        LibraryUpdateJob.setupTask(context)
        BackupCreatorJob.setupTask(context)

        onComplete()
        return remapped.unresolved
    }

    fun restoreSourcePreferences(preferences: List<BackupSourcePreferences>, onComplete: () -> Unit) {
        preferences.forEach {
            val sourcePrefs = AndroidPreferenceStore(context, sourcePreferences(it.sourceKey))
            restorePreferences(it.prefs, sourcePrefs)
        }
    }

    private fun restorePreferences(
        toRestore: List<BackupPreference>,
        preferenceStore: PreferenceStore,
    ) {
        val prefs = preferenceStore.getAll()
        toRestore.forEach { (key, value) ->
            // A backup file is untrusted input: it must never plant credentials or app state.
            if (Preference.isAppState(key) || BackupSecretPolicy.isSecret(key)) return@forEach
            if (BackupPreferencePolicy.isDeviceOnly(key)) return@forEach

            // j2k fork differences
            if (key == "library_sorting_mode" && value is StringPreferenceValue &&
                prefs[key] is Int?
            ) {
                val intValue = LibrarySort.deserialize(value.value)
                preferenceStore.getInt(key).set(intValue.mainValue)
                return@forEach
            }
            // end j2k fork differences

            // << Yokai-J2K compat
            if (key == "extension_installer" && value is IntPreferenceValue) {
                val enum = BasePreferences.ExtensionInstaller.migrate(value.value)
                preferenceStore.getEnum(key, enum).set(enum)
                return@forEach
            }

            if (key == PreferenceKeys.pagerCutoutBehavior && value is IntPreferenceValue) {
                val enum = ReaderPreferences.CutoutBehaviour.migrate(value.value)
                preferenceStore.getEnum(key, enum).set(enum)
                return@forEach
            }

            if (key == "landscape_cutout_behavior" && value is IntPreferenceValue) {
                val enum = ReaderPreferences.LandscapeCutoutBehaviour.migrate(value.value)
                preferenceStore.getEnum(key, enum).set(enum)
                return@forEach
            }
            // >> Yokai-J2K compat

            when (value) {
                is IntPreferenceValue -> {
                    if (prefs[key] is Int?) {
                        preferenceStore.getInt(key).set(value.value)
                    }
                }
                is LongPreferenceValue -> {
                    if (prefs[key] is Long?) {
                        preferenceStore.getLong(key).set(value.value)
                    }
                }
                is FloatPreferenceValue -> {
                    if (prefs[key] is Float?) {
                        preferenceStore.getFloat(key).set(value.value)
                    }
                }
                is StringPreferenceValue -> {
                    if (prefs[key] is String?) {
                        preferenceStore.getString(key).set(value.value)
                    }
                }
                is BooleanPreferenceValue -> {
                    if (prefs[key] is Boolean?) {
                        preferenceStore.getBoolean(key).set(value.value)
                    }
                }
                is StringSetPreferenceValue -> {
                    if (prefs[key] is Set<*>?) {
                        preferenceStore.getStringSet(key).set(value.value)
                    }
                }
            }
        }
    }
}
