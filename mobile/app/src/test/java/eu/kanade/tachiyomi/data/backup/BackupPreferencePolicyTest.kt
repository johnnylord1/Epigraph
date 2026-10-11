package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.BooleanPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
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
    fun `source languages and hidden sources are added to this device's sets`() {
        val backup = listOf(
            BackupPreference("source_languages", StringSetPreferenceValue(setOf("en"))),
            BackupPreference("hidden_catalogues", StringSetPreferenceValue(setOf("1"))),
            BackupPreference("cover_colors", StringSetPreferenceValue(setOf("x"))),
        )
        val device = mapOf(
            "source_languages" to setOf("all", "pt-BR"),
            "hidden_catalogues" to setOf("2"),
            "cover_colors" to setOf("y"),
        )

        val restored = BackupPreferencePolicy.restorableAppPreferences(backup) { device.getValue(it) }
            .associate { it.key to (it.value as StringSetPreferenceValue).value }

        assertEquals(setOf("all", "pt-BR", "en"), restored["source_languages"])
        assertEquals(setOf("2", "1"), restored["hidden_catalogues"])
        assertEquals(setOf("x"), restored["cover_colors"])
    }
}
