package eu.kanade.tachiyomi.ui.setting.controllers

import epigraph.books.reader.BookReaderPreferences
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.preference.PreferenceKeys as Keys
import eu.kanade.tachiyomi.ui.setting.SettingsLegacyController
import eu.kanade.tachiyomi.ui.setting.bindTo
import eu.kanade.tachiyomi.ui.setting.defaultValue
import eu.kanade.tachiyomi.ui.setting.editTextPreference
import eu.kanade.tachiyomi.ui.setting.listPreference
import eu.kanade.tachiyomi.ui.setting.intListPreference
import eu.kanade.tachiyomi.ui.setting.multiSelectListPreferenceMat
import eu.kanade.tachiyomi.ui.setting.onChange
import eu.kanade.tachiyomi.ui.setting.preferenceCategory
import eu.kanade.tachiyomi.ui.setting.seekBarPreference
import eu.kanade.tachiyomi.ui.setting.switchPreference
import eu.kanade.tachiyomi.ui.setting.titleMRes as titleRes
import yokai.i18n.MR
import yokai.util.koin.get
import yokai.util.lang.getString

class SettingsBooksReaderController : SettingsLegacyController() {
    override fun setupPreferenceScreen(screen: PreferenceScreen) = screen.apply {
        title = context.getString(R.string.epigraph_books)
        populateBooksReaderPreferences(this)
    }
}

fun SettingsLegacyController.populateBooksReaderPreferences(screen: PreferenceScreen) {
    val bookPreferences: BookReaderPreferences = get()
    screen.apply {
        preferenceCategory {
            titleRes = MR.strings.general
            intListPreference(activity) {
                isPersistent = false
                titleRes = MR.strings.default_orientation
                entries = listOf("Automatic", "Portrait", "Landscape")
                entryValues = listOf(
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                )
                defaultValue = bookPreferences.orientation.get()
                onChange { value -> bookPreferences.orientation.set(value as Int); true }
            }
            switchPreference {
                bindTo(bookPreferences.fullscreen)
                titleRes = MR.strings.fullscreen
            }
            switchPreference {
                bindTo(bookPreferences.keepScreenOn)
                titleRes = MR.strings.keep_screen_on
            }
            switchPreference {
                bindTo(bookPreferences.showPageNumber)
                titleRes = MR.strings.show_page_number
            }
        }

        preferenceCategory {
            title = context.getString(R.string.epigraph_epub)
            floatSeekBar(bookPreferences.epubFontScale, context.getString(MR.strings.novel_font_size), 75, 200, 100f)
            floatSeekBar(bookPreferences.epubLineHeight, context.getString(MR.strings.novel_line_height), 110, 300, 100f)
            floatSeekBar(bookPreferences.epubParagraphSpacing, context.getString(R.string.epigraph_reader_paragraph_spacing), 0, 300, 100f)
            seekBarPreference {
                bindTo(bookPreferences.epubContentWidth)
                title = context.getString(R.string.epigraph_reader_content_width)
                min = 0
                max = 100
                seekBarIncrement = 5
                showSeekBarValue = true
            }
            listPreference(activity) {
                bindTo(bookPreferences.epubFontFamily)
                titleRes = MR.strings.novel_font_family
                entries = listOf("Serif", "Sans serif", "Monospace")
                entryValues = listOf("serif", "sans-serif", "monospace")
            }
            listPreference(activity) {
                bindTo(bookPreferences.epubTextAlign)
                titleRes = MR.strings.novel_text_align
                entries = listOf("Left", "Justified", "Center")
                entryValues = listOf("left", "justified", "center")
            }
            listPreference(activity) {
                bindTo(bookPreferences.epubTheme)
                titleRes = MR.strings.novel_reader_theme
                entries = listOf("System", "Light", "Dark", "Sepia", "OLED")
                entryValues = listOf("system", "light", "dark", "sepia", "oled")
            }
            listPreference(activity) {
                bindTo(bookPreferences.epubFlow)
                title = "Flow"
                entries = listOf("Scroll", "Paginated")
                entryValues = listOf("scroll", "paginated")
            }
            switchPreference {
                bindTo(bookPreferences.epubAnimateTransitions)
                titleRes = MR.strings.animate_page_transitions
            }
        }

        preferenceCategory {
            title = context.getString(R.string.epigraph_pdf)
            listPreference(activity) {
                bindTo(bookPreferences.pdfFitMode)
                title = "Fit mode"
                entries = listOf("Width", "Height", "Both", "Actual size")
                entryValues = listOf("width", "height", "both", "actual")
            }
            switchPreference {
                bindTo(bookPreferences.pdfReflow)
                title = "Reflow text"
            }
            switchPreference {
                bindTo(bookPreferences.pdfHorizontal)
                title = "Horizontal paging"
            }
            switchPreference {
                bindTo(bookPreferences.pdfTwoPage)
                title = "Two-page spread"
            }
        }

        preferenceCategory {
            titleRes = MR.strings.navigation
            switchPreference {
                bindTo(bookPreferences.volumeKeys)
                titleRes = MR.strings.volume_keys
            }
            switchPreference {
                bindTo(bookPreferences.volumeKeysInverted)
                titleRes = MR.strings.invert_volume_keys
            }
            multiSelectListPreferenceMat(activity) {
                key = Keys.bookVerticalSeekbarFormats
                title = context.getString(R.string.reader_vertical_progress_modes)
                entries = listOf("EPUB", "PDF")
                entryValues = listOf("epub", "pdf")
                defaultValue = listOf("epub", "pdf")
                allSelectionRes = MR.strings.display_options
            }
            seekBarPreference {
                key = Keys.readerVerticalSeekbarHeightPercent
                title = context.getString(R.string.reader_vertical_progress_height)
                min = 60
                max = 100
                seekBarIncrement = 5
                showSeekBarValue = true
                setDefaultValue(65)
            }
            switchPreference {
                key = Keys.readerVerticalSeekbarDockLeft
                title = context.getString(R.string.reader_vertical_progress_place_left)
                defaultValue = false
            }
        }

        preferenceCategory {
            title = context.getString(MR.strings.custom_filter)
            switchPreference {
                bindTo(bookPreferences.colorFilterEnabled)
                title = context.getString(MR.strings.use_custom_color_filter)
            }
            bookColorChannel(bookPreferences.colorFilterValue, "A", 24)
            bookColorChannel(bookPreferences.colorFilterValue, "R", 16)
            bookColorChannel(bookPreferences.colorFilterValue, "G", 8)
            bookColorChannel(bookPreferences.colorFilterValue, "B", 0)
            intListPreference(activity) {
                isPersistent = false
                title = context.getString(MR.strings.color_filter_blend_mode)
                entries = context.resources.getStringArray(R.array.color_filter_modes).toList()
                entryRange = context.resources.getStringArray(R.array.color_filter_modes).indices
                defaultValue = bookPreferences.colorFilterMode.get()
                onChange { value -> bookPreferences.colorFilterMode.set(value as Int); true }
            }
            switchPreference {
                bindTo(bookPreferences.customBrightness)
                title = context.getString(MR.strings.use_custom_brightness)
            }
            seekBarPreference {
                bindTo(bookPreferences.customBrightnessValue)
                title = context.getString(MR.strings.use_custom_brightness)
                min = -75
                max = 100
                showSeekBarValue = true
            }
            switchPreference {
                bindTo(bookPreferences.grayscale)
                title = context.getString(MR.strings.grayscale)
            }
            switchPreference {
                bindTo(bookPreferences.invertedColors)
                title = context.getString(MR.strings.pref_inverted_colors)
            }
        }

        preferenceCategory {
            titleRes = MR.strings.text_to_speech
            floatSeekBar(bookPreferences.ttsRate, context.getString(MR.strings.novel_tts_speed), 5, 30, 10f)
            floatSeekBar(bookPreferences.ttsPitch, context.getString(MR.strings.novel_tts_pitch), 5, 20, 10f)
            editTextPreference(activity) {
                bindTo(bookPreferences.ttsVoice)
                title = context.getString(R.string.epigraph_reader_tts_voice)
                summary = context.getString(R.string.epigraph_reader_system_default)
            }
        }
    }
}

private fun androidx.preference.PreferenceCategory.floatSeekBar(
    preference: eu.kanade.tachiyomi.core.preference.Preference<Float>,
    label: String,
    minValue: Int,
    maxValue: Int,
    scale: Float,
) {
    seekBarPreference {
        isPersistent = false
        title = label
        min = minValue
        max = maxValue
        showSeekBarValue = false
        val initial = (preference.get() * scale).toInt().coerceIn(minValue, maxValue)
        defaultValue = initial
        summary = "%.2f".format(initial / scale)
        onChange { value ->
            val normalized = (value as Int).coerceIn(minValue, maxValue) / scale
            preference.set(normalized)
            summary = "%.2f".format(normalized)
            true
        }
    }
}

private fun androidx.preference.PreferenceCategory.bookColorChannel(
    preference: eu.kanade.tachiyomi.core.preference.Preference<Int>,
    label: String,
    shift: Int,
) {
    seekBarPreference {
        isPersistent = false
        title = label
        min = 0
        max = 255
        showSeekBarValue = true
        defaultValue = preference.get() shr shift and 0xFF
        onChange { value ->
            val mask = (0xFF shl shift).inv()
            preference.set((preference.get() and mask) or ((value as Int).coerceIn(0, 255) shl shift))
            true
        }
    }
}
