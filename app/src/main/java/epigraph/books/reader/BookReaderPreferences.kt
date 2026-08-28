package epigraph.books.reader

import eu.kanade.tachiyomi.core.preference.Preference
import eu.kanade.tachiyomi.core.preference.PreferenceStore

class BookReaderPreferences(private val store: PreferenceStore) {
    val fullscreen = store.getBoolean("aethon_book_reader_fullscreen", true)
    val keepScreenOn = store.getBoolean("aethon_book_reader_keep_screen_on", true)
    val showPageNumber = store.getBoolean("aethon_book_reader_show_page_number", true)
    val orientation = store.getInt("aethon_book_reader_orientation", android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
    val volumeKeys = store.getBoolean("aethon_book_reader_volume_keys", false)
    val volumeKeysInverted = store.getBoolean("aethon_book_reader_volume_keys_inverted", false)

    val epubFontScale = store.getFloat("aethon_epub_font_scale", 1.0f)
    val epubLineHeight = store.getFloat("aethon_epub_line_height", 1.55f)
    val epubFontFamily = store.getString("aethon_epub_font_family", "serif")
    val epubTextAlign = store.getString("aethon_epub_text_align", "left")
    val epubParagraphSpacing = store.getFloat("aethon_epub_paragraph_spacing", 1.1f)
    val epubTheme = store.getString("aethon_epub_theme", "system")
    val epubFlow = store.getString("aethon_epub_flow", "scroll")
    val epubAnimateTransitions = store.getBoolean("aethon_epub_animate_transitions", true)
    val epubContentWidth = store.getInt("aethon_epub_content_width", 0)

    val pdfFitMode = store.getString("aethon_pdf_fit_mode", "both")
    val pdfHorizontal = store.getBoolean("aethon_pdf_horizontal", false)
    val pdfTwoPage = store.getBoolean("aethon_pdf_two_page", false)
    val pdfReflow = store.getBoolean("aethon_pdf_reflow", false)

    val ttsRate = store.getFloat("aethon_book_tts_rate", 1.0f)
    val ttsPitch = store.getFloat("aethon_book_tts_pitch", 1.0f)
    val ttsVoice = store.getString("aethon_book_tts_voice", "")

    val colorFilterEnabled = store.getBoolean("aethon_book_filter_enabled", false)
    val colorFilterValue = store.getInt("aethon_book_filter_value", 0)
    val colorFilterMode = store.getInt("aethon_book_filter_mode", 0)
    val customBrightness = store.getBoolean("aethon_book_brightness_enabled", false)
    val customBrightnessValue = store.getInt("aethon_book_brightness_value", 0)
    val grayscale = store.getBoolean("aethon_book_filter_grayscale", false)
    val invertedColors = store.getBoolean("aethon_book_filter_inverted", false)

    val legacyMigrationComplete = store.getBoolean("aethon_book_reader_legacy_migration_complete", false)

    /** Restores reader defaults while preserving imported files, locators and bookmarks. */
    fun resetReaderSettingsToDefaults() {
        fullscreen.set(true)
        keepScreenOn.set(true)
        showPageNumber.set(true)
        orientation.set(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
        volumeKeys.set(false)
        volumeKeysInverted.set(false)

        epubFontScale.set(1.0f)
        epubLineHeight.set(1.55f)
        epubFontFamily.set("serif")
        epubTextAlign.set("left")
        epubParagraphSpacing.set(1.1f)
        epubTheme.set("system")
        epubFlow.set("scroll")
        epubAnimateTransitions.set(true)
        epubContentWidth.set(0)

        pdfFitMode.set("both")
        pdfHorizontal.set(false)
        pdfTwoPage.set(false)
        pdfReflow.set(false)

        ttsRate.set(1.0f)
        ttsPitch.set(1.0f)
        ttsVoice.set("")
        colorFilterEnabled.set(false)
        colorFilterValue.set(0)
        colorFilterMode.set(0)
        customBrightness.set(false)
        customBrightnessValue.set(0)
        grayscale.set(false)
        invertedColors.set(false)
    }

    fun migrateLegacy(read: LegacyBookReaderPreferences) {
        if (legacyMigrationComplete.get()) return
        copyFloat(read, "epub_font_scale", epubFontScale)
        copyFloat(read, "epub_line_height", epubLineHeight)
        copyString(read, "epub_font_family", epubFontFamily)
        copyString(read, "epub_text_align", epubTextAlign)
        copyFloat(read, "epub_paragraph_spacing", epubParagraphSpacing)
        copyString(read, "epub_theme", epubTheme)
        copyString(read, "epub_flow", epubFlow)
        copyInt(read, "epub_content_width", epubContentWidth)
        copyString(read, "pdf_fit_mode", pdfFitMode)
        copyBoolean(read, "pdf_horizontal", pdfHorizontal)
        copyBoolean(read, "pdf_two_page", pdfTwoPage)
        copyBoolean(read, "pdf_reflow", pdfReflow)
        copyFloat(read, "tts_rate", ttsRate)
        copyFloat(read, "tts_pitch", ttsPitch)
        read.string("tts_voice")?.let(ttsVoice::set)
        if (!invertedColors.get()) read.boolean("pdf_night_mode")?.let(invertedColors::set)
        legacyMigrationComplete.set(true)
    }

    private fun copyFloat(read: LegacyBookReaderPreferences, key: String, target: Preference<Float>) {
        read.float(key)?.let(target::set)
    }

    private fun copyInt(read: LegacyBookReaderPreferences, key: String, target: Preference<Int>) {
        read.int(key)?.let(target::set)
    }

    private fun copyString(read: LegacyBookReaderPreferences, key: String, target: Preference<String>) {
        read.string(key)?.let(target::set)
    }

    private fun copyBoolean(read: LegacyBookReaderPreferences, key: String, target: Preference<Boolean>) {
        read.boolean(key)?.let(target::set)
    }
}

interface LegacyBookReaderPreferences {
    fun float(key: String): Float?
    fun int(key: String): Int?
    fun string(key: String): String?
    fun boolean(key: String): Boolean?
}
