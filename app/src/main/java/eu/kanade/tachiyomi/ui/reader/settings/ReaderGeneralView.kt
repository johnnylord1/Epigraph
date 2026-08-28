package eu.kanade.tachiyomi.ui.reader.settings

import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import androidx.core.view.isVisible
import com.google.android.material.button.MaterialButton
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.database.models.orientationType
import eu.kanade.tachiyomi.data.database.models.readingModeType
import eu.kanade.tachiyomi.databinding.ReaderGeneralLayoutBinding
import eu.kanade.tachiyomi.ui.reader.ReaderActivity
import eu.kanade.tachiyomi.util.bindToPreference
import eu.kanade.tachiyomi.util.lang.addBetaTag
import eu.kanade.tachiyomi.util.lang.withSubtitle
import eu.kanade.tachiyomi.util.system.DeviceUtil
import eu.kanade.tachiyomi.widget.BaseReaderSettingsView
import yokai.util.lang.getString
import kotlin.math.roundToInt

class ReaderGeneralView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    BaseReaderSettingsView<ReaderGeneralLayoutBinding>(context, attrs) {

    lateinit var sheet: TabbedReaderSettingsSheet
    override fun inflateBinding() = ReaderGeneralLayoutBinding.bind(this)
    override fun initGeneralPreferences() {
        binding.viewerSeries.onItemSelectedListener = { position ->
            val readingModeType = ReadingModeType.fromSpinner(position)
            (context as ReaderActivity).viewModel.setMangaReadingMode(readingModeType.flagValue)

            val mangaViewer = activity.viewModel.getMangaReadingMode()
            if (mangaViewer == ReadingModeType.LONG_STRIP.flagValue || mangaViewer == ReadingModeType.CONTINUOUS_VERTICAL.flagValue) {
                initWebtoonPreferences()
            } else {
                initPagerPreferences()
            }
        }
        binding.viewerSeries.setSelection(
            (context as? ReaderActivity)?.viewModel?.state?.value?.manga?.readingModeType?.let {
                ReadingModeType.fromPreference(it).prefValue
            } ?: 0,
        )
        binding.rotationMode.onItemSelectedListener = { position ->
            val rotationType = OrientationType.fromSpinner(position)
            (context as ReaderActivity).viewModel.setMangaOrientationType(rotationType.flagValue)
        }
        binding.rotationMode.setSelection(
            (context as ReaderActivity).viewModel.manga?.orientationType?.let {
                OrientationType.fromPreference(it).prefValue
            } ?: 0,
        )

        binding.backgroundColor.setEntries(
            ReaderBackgroundColor.entries
                .map { context.getString(it.stringRes) },
        )
        val selection = ReaderBackgroundColor.indexFromPref(preferences.readerTheme().get())
        binding.backgroundColor.setSelection(selection)
        binding.backgroundColor.onItemSelectedListener = { position ->
            val backgroundColor = ReaderBackgroundColor.entries[position]
            preferences.readerTheme().set(backgroundColor.prefValue)
        }
        binding.showPageNumber.bindToPreference(preferences.showPageNumber())
        binding.fullscreen.bindToPreference(preferences.fullscreen()) {
            updatePrefs()
        }
        binding.cutoutShort.bindToPreference(readerPreferences.cutoutShort())
        binding.cutoutShort.text = binding.cutoutShort.text.toString().addBetaTag(context)
        binding.keepscreen.bindToPreference(preferences.keepScreenOn())
        binding.alwaysShowChapterTransition.bindToPreference(preferences.alwaysShowChapterTransition())

        initVerticalSeekbarPreferences()

        updatePrefs()
    }

    private fun currentModeSelected(modes: Set<String>): Boolean {
        // XML inflation runs before TabbedReaderSettingsSheet can assign the legacy `activity`
        // field. The context is already the canonical ReaderActivity and is safe at this point.
        val currentMode = ReadingModeType.fromPreference((context as ReaderActivity).viewModel.getMangaReadingMode())
        return currentMode.prefValue.toString() in modes
    }

    private fun initVerticalSeekbarPreferences() {
        val modesPref = preferences.readerVerticalSeekbarModes()
        val selectedModes = modesPref.get()
        ReadingModeType.entries.filter { it != ReadingModeType.DEFAULT && it != ReadingModeType.NOVEL }.forEach { mode ->
            val chip = LayoutInflater.from(context).inflate(
                R.layout.reader_mode_chip,
                binding.verticalSeekbarModes,
                false,
            ) as MaterialButton
            chip.id = generateViewId()
            chip.text = context.getString(mode.stringRes)
            chip.isChecked = mode.prefValue.toString() in selectedModes
            chip.addOnCheckedChangeListener { _, checked ->
                val values = modesPref.get().toMutableSet()
                val key = mode.prefValue.toString()
                if (checked) values += key else values -= key
                modesPref.set(values)
                binding.verticalSeekbarExtraSettings.isVisible = currentModeSelected(values)
            }
            binding.verticalSeekbarModes.addView(chip)
        }
        binding.verticalSeekbarExtraSettings.isVisible = currentModeSelected(selectedModes)

        val heightPref = preferences.readerVerticalSeekbarHeightPercent()
        binding.verticalSeekbarHeight.value = heightPref.get().coerceIn(60, 100).toFloat()
        binding.verticalSeekbarHeight.setLabelFormatter { "${it.roundToInt()}%" }
        fun renderHeight(value: Int) {
            binding.verticalSeekbarHeightText.text = context.getString(R.string.reader_vertical_progress_height)
                .withSubtitle(context, "$value%")
        }
        renderHeight(heightPref.get())
        binding.verticalSeekbarHeight.addOnChangeListener { _, value, fromUser ->
            val percent = value.roundToInt()
            renderHeight(percent)
            if (fromUser) heightPref.set(percent)
        }

        val dockLeftPref = preferences.readerVerticalSeekbarDockLeft()
        binding.verticalSeekbarPlacement.check(
            if (dockLeftPref.get()) binding.placeLeftButton.id else binding.placeRightButton.id,
        )
        binding.verticalSeekbarPlacement.addOnButtonCheckedListener { _, checkedId, checked ->
            if (checked) dockLeftPref.set(checkedId == binding.placeLeftButton.id)
        }
    }

    /**
     * Init the preferences for the webtoon reader.
     */
    private fun initWebtoonPreferences() {
        sheet.updateTabs(true)
    }

    private fun initPagerPreferences() {
        sheet.updateTabs(false)
    }

    private fun updatePrefs() {
        binding.cutoutShort.isVisible =
            DeviceUtil.hasCutout(context as ReaderActivity).ordinal >= DeviceUtil.CutoutSupport.MODERN.ordinal && preferences.fullscreen().get()
    }
}
