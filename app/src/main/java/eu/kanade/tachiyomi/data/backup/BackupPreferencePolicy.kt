package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.LongPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import eu.kanade.tachiyomi.data.preference.PreferenceKeys

/**
 * Which app preferences a backup may carry and restore, beyond the secrets in [BackupSecretPolicy].
 */
object BackupPreferencePolicy {
    /**
     * Written into every Epigraph backup. Backups from Mihon, J2K and other forks lack it, so
     * restore can tell them apart and keep this app's own look.
     */
    const val ORIGIN_KEY = "epigraph_backup_origin"
    const val ORIGIN_VALUE = "epigraph"

    /**
     * Keys that describe this device and never enter or leave a backup. The trusted extension
     * list names APK hashes of the extensions installed here: restoring another device's or
     * another fork's list would distrust the extensions installed here, and a backup file must
     * never be able to mark an extension as trusted.
     */
    fun isDeviceOnly(key: String): Boolean = key in DEVICE_ONLY_KEYS

    /**
     * Theme keys. Other forks use the same names for themes that do not match Epigraph's
     * surfaces, so these are restored only from Epigraph backups.
     */
    fun isAppearance(key: String): Boolean = key in APPEARANCE_KEYS

    /**
     * The app preferences of a backup that restore may write, before secret and app state checks.
     * The repository preferences of older forks are left out: restore adds those repositories to
     * the repository list ([ExtensionRepoBackup]) instead.
     * Source languages, hidden and pinned sources are added to this device's own sets
     * ([deviceSet] gives their current value) instead of replacing them: a backup that enabled
     * only English must not hide the Portuguese sources installed here.
     * Mihon writes the default chapter filters and sort as Long; they become the Int this app
     * reads, with the same flag values, instead of being discarded as an unreadable type.
     */
    fun restorableAppPreferences(
        preferences: List<BackupPreference>,
        deviceSet: (String) -> Set<String>,
    ): List<BackupPreference> {
        val fromEpigraph = preferences.any {
            it.key == ORIGIN_KEY && (it.value as? StringPreferenceValue)?.value == ORIGIN_VALUE
        }
        return preferences
            .filter { (key) ->
                !isDeviceOnly(key) && key !in ExtensionRepoBackup.LEGACY_KEYS && (fromEpigraph || !isAppearance(key))
            }
            .map { preference ->
                val value = preference.value
                if (preference.key in MERGED_KEYS && value is StringSetPreferenceValue) {
                    preference.copy(value = StringSetPreferenceValue(deviceSet(preference.key) + value.value))
                } else if (preference.key in LONG_IN_MIHON_KEYS && value is LongPreferenceValue) {
                    preference.copy(value = IntPreferenceValue(value.value.toInt()))
                } else {
                    preference
                }
            }
    }

    private val DEVICE_ONLY_KEYS = setOf(
        ORIGIN_KEY,
        "trusted_extensions",
    )

    private val MERGED_KEYS = setOf(
        PreferenceKeys.enabledLanguages,
        "hidden_catalogues",
        "pinned_catalogues",
    )

    private val LONG_IN_MIHON_KEYS = setOf(
        PreferenceKeys.defaultChapterFilterByRead,
        PreferenceKeys.defaultChapterFilterByDownloaded,
        PreferenceKeys.defaultChapterFilterByBookmarked,
        PreferenceKeys.defaultChapterSortBySourceOrNumber,
        PreferenceKeys.defaultChapterSortByAscendingOrDescending,
    )

    private val APPEARANCE_KEYS = setOf(
        PreferenceKeys.nightMode,
        PreferenceKeys.lightTheme,
        PreferenceKeys.darkTheme,
        PreferenceKeys.themeDarkAmoled,
        PreferenceKeys.themeMangaDetails,
        PreferenceKeys.themeMangaDetailsOverrides,
    )
}
