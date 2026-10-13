package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.BooleanPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.LongPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class BackupPreferencePolicyTest {

    private val noDeviceSets: (String) -> Set<String> = { emptySet() }

    private val foreignBackup = listOf(
        BackupPreference("trusted_extensions", StringSetPreferenceValue(setOf("eu.kanade.tachiyomi.extension.en.a:2:abc"))),
        BackupPreference("dark_theme", StringPreferenceValue("LIME")),
        BackupPreference("night_mode", IntPreferenceValue(2)),
        BackupPreference("pref_theme_dark_amoled_key", BooleanPreferenceValue(true)),
        BackupPreference("source_languages", StringSetPreferenceValue(setOf("en", "pt-BR"))),
        BackupPreference("backup_interval", IntPreferenceValue(12)),
    )

    @Test
    fun `a backup from another fork keeps this app's theme and extension trust`() {
        val restored = BackupPreferencePolicy.restorableAppPreferences(foreignBackup, noDeviceSets).map { it.key }

        assertEquals(listOf("source_languages", "backup_interval"), restored)
    }

    @Test
    fun `an Epigraph backup restores its theme but never extension trust`() {
        val origin = BackupPreference(
            BackupPreferencePolicy.ORIGIN_KEY,
            StringPreferenceValue(BackupPreferencePolicy.ORIGIN_VALUE),
        )

        val restored = BackupPreferencePolicy.restorableAppPreferences(foreignBackup + origin, noDeviceSets).map { it.key }

        assertEquals(
            listOf("dark_theme", "night_mode", "pref_theme_dark_amoled_key", "source_languages", "backup_interval"),
            restored,
        )
    }

    @Test
    fun `a forged origin with another value does not count as an Epigraph backup`() {
        val forged = BackupPreference(BackupPreferencePolicy.ORIGIN_KEY, StringPreferenceValue("j2k"))

        val restored = BackupPreferencePolicy.restorableAppPreferences(foreignBackup + forged, noDeviceSets).map { it.key }

        assertEquals(listOf("source_languages", "backup_interval"), restored)
    }

    @Test
    fun `Mihon's Long chapter filters and sort become the Int this app reads`() {
        val mihon = listOf(
            BackupPreference("default_chapter_filter_by_read", LongPreferenceValue(2)),
            BackupPreference("default_chapter_sort_by_source_or_number", LongPreferenceValue(0x100)),
            BackupPreference("last_library_suggestion", LongPreferenceValue(1_000)),
        )

        val restored = BackupPreferencePolicy.restorableAppPreferences(mihon, noDeviceSets)

        assertEquals(
            listOf(IntPreferenceValue(2), IntPreferenceValue(0x100), LongPreferenceValue(1_000)),
            restored.map { it.value },
        )
    }

    @Test
    fun `source languages and hidden sources are added to this device's sets`() {
        val backup = listOf(
            BackupPreference("source_languages", StringSetPreferenceValue(setOf("en"))),
            BackupPreference("hidden_catalogues", StringSetPreferenceValue(setOf("1"))),
            BackupPreference("collapsed_dynamic_categories", StringSetPreferenceValue(setOf("x"))),
        )
        val device = mapOf(
            "source_languages" to setOf("all", "pt-BR"),
            "hidden_catalogues" to setOf("2"),
            "collapsed_dynamic_categories" to setOf("y"),
        )

        val restored = BackupPreferencePolicy.restorableAppPreferences(backup) { device.getValue(it) }
            .associate { it.key to (it.value as StringSetPreferenceValue).value }

        assertEquals(setOf("all", "pt-BR", "en"), restored["source_languages"])
        assertEquals(setOf("2", "1"), restored["hidden_catalogues"])
        assertEquals(setOf("x"), restored["collapsed_dynamic_categories"])
    }

    @Test
    fun `settings keyed by entry id and this install's timestamps stay on the device`() {
        val backup = listOf(
            BackupPreference("cover_ratio", StringSetPreferenceValue(setOf("12|0.7"))),
            BackupPreference("cover_colors", StringSetPreferenceValue(setOf("12|-1|-16777216"))),
            BackupPreference("theme_manga_details_overrides", StringSetPreferenceValue(setOf("12|true"))),
            BackupPreference("last_unlock", LongPreferenceValue(Long.MAX_VALUE)),
            BackupPreference("last_ext_check", LongPreferenceValue(1)),
            BackupPreference("last_app_check", LongPreferenceValue(1)),
            BackupPreference("ext_updates_count", IntPreferenceValue(3)),
            BackupPreference("library_update_last_timestamp", LongPreferenceValue(1)),
            BackupPreference(BackupPreferencePolicy.ORIGIN_KEY, StringPreferenceValue(BackupPreferencePolicy.ORIGIN_VALUE)),
            BackupPreference("backup_interval", IntPreferenceValue(12)),
        )

        val restored = BackupPreferencePolicy.restorableAppPreferences(backup, noDeviceSets).map { it.key }

        assertEquals(listOf("backup_interval"), restored)
        backup.dropLast(1).forEach { assertEquals(true, BackupPreferencePolicy.isDeviceOnly(it.key), it.key) }
    }
}
