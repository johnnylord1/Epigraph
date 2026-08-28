package epigraph.books.reader

import eu.kanade.tachiyomi.core.preference.Preference
import eu.kanade.tachiyomi.core.preference.PreferenceStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BookReaderPreferencesTest {
    @Test
    fun `legacy migration preserves book settings and runs once`() {
        val preferences = BookReaderPreferences(MemoryPreferenceStore())
        val legacyValues = mutableMapOf<String, Any>(
            "epub_font_scale" to 1.5f,
            "epub_font_family" to "monospace",
            "pdf_two_page" to true,
            "pdf_night_mode" to true,
            "tts_rate" to 1.25f,
        )
        val legacy = legacyValues.asLegacyPreferences()

        preferences.migrateLegacy(legacy)

        assertEquals(1.5f, preferences.epubFontScale.get())
        assertEquals("monospace", preferences.epubFontFamily.get())
        assertTrue(preferences.pdfTwoPage.get())
        assertTrue(preferences.invertedColors.get())
        assertEquals(1.25f, preferences.ttsRate.get())
        assertTrue(preferences.legacyMigrationComplete.get())

        legacyValues["epub_font_scale"] = 0.8f
        legacyValues["pdf_two_page"] = false
        preferences.migrateLegacy(legacyValues.asLegacyPreferences())

        assertEquals(1.5f, preferences.epubFontScale.get())
        assertTrue(preferences.pdfTwoPage.get())
        assertFalse(preferences.customBrightness.get())
    }

    @Test
    fun `reader reset restores defaults without deleting migration state`() {
        val preferences = BookReaderPreferences(MemoryPreferenceStore())
        preferences.epubTheme.set("oled")
        preferences.pdfTwoPage.set(true)
        preferences.invertedColors.set(true)
        preferences.legacyMigrationComplete.set(true)

        preferences.resetReaderSettingsToDefaults()

        assertEquals("system", preferences.epubTheme.get())
        assertFalse(preferences.pdfTwoPage.get())
        assertFalse(preferences.invertedColors.get())
        assertTrue(preferences.legacyMigrationComplete.get())
    }
}

private fun Map<String, Any>.asLegacyPreferences() = object : LegacyBookReaderPreferences {
    override fun float(key: String) = this@asLegacyPreferences[key] as? Float
    override fun int(key: String) = this@asLegacyPreferences[key] as? Int
    override fun string(key: String) = this@asLegacyPreferences[key] as? String
    override fun boolean(key: String) = this@asLegacyPreferences[key] as? Boolean
}

private class MemoryPreferenceStore : PreferenceStore {
    private val values = mutableMapOf<String, Any?>()

    override fun getString(key: String, defaultValue: String) = preference(key, defaultValue)
    override fun getLong(key: String, defaultValue: Long) = preference(key, defaultValue)
    override fun getInt(key: String, defaultValue: Int) = preference(key, defaultValue)
    override fun getFloat(key: String, defaultValue: Float) = preference(key, defaultValue)
    override fun getBoolean(key: String, defaultValue: Boolean) = preference(key, defaultValue)
    override fun getStringSet(key: String, defaultValue: Set<String>) = preference(key, defaultValue)
    override fun <T> getObject(key: String, defaultValue: T, serializer: (T) -> String, deserializer: (String) -> T) =
        preference(key, defaultValue)
    override fun getAll(): Map<String, *> = values.toMap()

    private fun <T> preference(key: String, defaultValue: T): Preference<T> = MemoryPreference(key, defaultValue, values)
}

private class MemoryPreference<T>(
    private val preferenceKey: String,
    private val fallback: T,
    private val values: MutableMap<String, Any?>,
) : Preference<T> {
    private val state = MutableStateFlow(get())

    override fun key() = preferenceKey
    @Suppress("UNCHECKED_CAST")
    override fun get(): T = values[preferenceKey] as? T ?: fallback
    override fun set(value: T) { values[preferenceKey] = value; state.value = value }
    override fun isSet() = preferenceKey in values
    override fun delete() { values.remove(preferenceKey); state.value = fallback }
    override fun defaultValue() = fallback
    override fun changes(): Flow<T> = state
    override fun stateIn(scope: CoroutineScope): StateFlow<T> = state
}
