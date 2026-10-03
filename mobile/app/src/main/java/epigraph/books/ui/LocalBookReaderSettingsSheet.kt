package epigraph.books.ui

import epigraph.books.reader.BookReaderPreferences
import epigraph.books.tts.BookTtsPlaybackService
import epigraph.contract.ContentType
import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.isVisible
import androidx.core.widget.NestedScrollView
import androidx.viewpager.widget.PagerAdapter
import com.google.android.material.tabs.TabLayout
import dev.icerock.moko.resources.StringResource
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.databinding.ReaderBookSettingsPageBinding
import eu.kanade.tachiyomi.databinding.TabbedBottomSheetBinding
import eu.kanade.tachiyomi.databinding.WidgetNovelSliderFloatBinding
import eu.kanade.tachiyomi.util.bindToPreference
import eu.kanade.tachiyomi.widget.TabbedBottomSheetDialog
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.rootWindowInsetsCompat
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import yokai.i18n.MR
import yokai.util.lang.getString

/**
 * EPUB/PDF settings use the same Epigraph contract as the manga and novel sheets:
 * XML-inflated tab views inside [TabbedBottomSheetDialog], backed directly by typed
 * preferences. Engines remain separate, but the chrome and interaction model are shared.
 */
class LocalBookReaderSettingsSheet(
    private val activity: LocalBookReaderActivity,
    private val contentType: ContentType,
    private val bookPreferences: BookReaderPreferences,
    private val commonPreferences: PreferencesHelper,
    private val onChanged: () -> Unit,
) : TabbedBottomSheetDialog(activity) {
    private val content = LocalBookReaderSettingsContent(
        activity = activity,
        contentType = contentType,
        bookPreferences = bookPreferences,
        commonPreferences = commonPreferences,
        onChanged = onChanged,
    )

    override fun getTabViews(): List<View> = content.views

    override fun getTabTitles(): List<StringResource> = content.titles

    init {
        binding.menu.isVisible = true
        binding.menu.setImageResource(R.drawable.ic_outline_settings_24dp)
        binding.menu.setOnClickListener {
            activity.openGlobalReaderSettings()
            dismiss()
        }
        binding.tabs.tabMode = TabLayout.MODE_SCROLLABLE
        binding.tabs.tabGravity = TabLayout.GRAVITY_START
        binding.tabs.compactTabs()
    }
}

/**
 * The shared tab style pads each tab by 20dp; beside the reset and settings actions that pushes
 * the last reader tab off a phone-width row. Tighter padding keeps every tab label visible.
 */
private fun TabLayout.compactTabs() {
    val strip = getChildAt(0) as? ViewGroup ?: return
    for (index in 0 until strip.childCount) {
        val tab = strip.getChildAt(index)
        tab.minimumWidth = 0
        tab.setPaddingRelative(12.dpToPx, tab.paddingTop, 12.dpToPx, tab.paddingBottom)
    }
}

/**
 * The in-reader version of the settings surface. It uses the same tabs and controls as the
 * legacy dialog class, but is embedded in the reader's existing BottomSheetBehavior instead of
 * opening a second window over the reader HUD.
 */
class LocalBookReaderSettingsPanel(
    context: Context,
    private val activity: LocalBookReaderActivity,
    contentType: ContentType,
    bookPreferences: BookReaderPreferences,
    commonPreferences: PreferencesHelper,
    onChanged: () -> Unit,
    onResetDefaults: () -> Unit,
) : FrameLayout(context) {

    private val binding = TabbedBottomSheetBinding.inflate(LayoutInflater.from(context), this, true)
    private val content = LocalBookReaderSettingsContent(
        activity = activity,
        contentType = contentType,
        bookPreferences = bookPreferences,
        commonPreferences = commonPreferences,
        onChanged = onChanged,
    )

    init {
        // The reader's chapter sheet owns the surface.  Measure this panel from the selected
        // page so a short General tab does not become a full-screen blank sheet.
        layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
        val windowHeight = activity.window.decorView.height.takeIf { it > 0 }
            ?: resources.displayMetrics.heightPixels
        val topInset = activity.window.decorView.rootWindowInsetsCompat
            ?.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())?.top.orZero()
        binding.pager.maxHeight = ((windowHeight - topInset - 125.dpToPx) * 0.82f)
            .roundToInt()
            .coerceAtLeast(360.dpToPx)
        binding.pager.currentPageView = content.views.firstOrNull()
        binding.pager.offscreenPageLimit = 2
        binding.pager.adapter = object : PagerAdapter() {
            override fun getCount(): Int = content.views.size

            override fun isViewFromObject(view: View, item: Any): Boolean = view === item

            override fun instantiateItem(container: ViewGroup, position: Int): Any {
                val view = content.views[position]
                container.addView(view)
                return view
            }

            override fun destroyItem(container: ViewGroup, position: Int, item: Any) {
                container.removeView(item as View)
            }

            override fun getPageTitle(position: Int): CharSequence =
                activity.getString(content.titles[position])
        }
        binding.tabs.setupWithViewPager(binding.pager)
        binding.tabs.tabMode = TabLayout.MODE_SCROLLABLE
        binding.tabs.tabGravity = TabLayout.GRAVITY_START
        binding.tabs.compactTabs()
        binding.menu.isVisible = true
        binding.menu.setImageResource(R.drawable.ic_outline_settings_24dp)
        binding.menu.setOnClickListener {
            activity.closeReaderSettingsPanel()
            activity.openGlobalReaderSettings()
        }
        binding.resetDefaults.isVisible = true
        binding.resetDefaults.contentDescription = context.getString(R.string.epigraph_reader_reset_defaults)
        binding.resetDefaults.setOnClickListener { onResetDefaults() }
        setNestedScrollState(0)
        binding.tabs.addOnTabSelectedListener(
            object : TabLayout.OnTabSelectedListener {
                override fun onTabSelected(tab: TabLayout.Tab?) {
                    val position = tab?.position ?: 0
                    binding.pager.currentPageView = content.views.getOrNull(position)
                    setNestedScrollState(position)
                }

                override fun onTabUnselected(tab: TabLayout.Tab?) = Unit

                override fun onTabReselected(tab: TabLayout.Tab?) {
                    val position = tab?.position ?: 0
                    binding.pager.currentPageView = content.views.getOrNull(position)
                    setNestedScrollState(position)
                }
            },
        )
    }

    /** The open tab, kept when a PDF mode change rebuilds the reader surface. */
    var selectedTab: Int
        get() = binding.pager.currentItem
        set(value) {
            val position = value.coerceIn(0, (content.views.size - 1).coerceAtLeast(0))
            binding.pager.setCurrentItem(position, false)
            binding.pager.currentPageView = content.views.getOrNull(position)
            setNestedScrollState(position)
        }

    private fun setNestedScrollState(position: Int) {
        content.views.forEachIndexed { index, view ->
            (view as? NestedScrollView)?.apply {
                isNestedScrollingEnabled = index == position
                requestLayout()
            }
        }
    }

    private fun Int?.orZero(): Int = this ?: 0
}

private class LocalBookReaderSettingsContent(
    private val activity: LocalBookReaderActivity,
    contentType: ContentType,
    bookPreferences: BookReaderPreferences,
    commonPreferences: PreferencesHelper,
    onChanged: () -> Unit,
) {
    val views: List<View>
    val titles: List<StringResource>

    init {
        fun inflatePage(): LocalBookReaderSettingsView = View.inflate(
            activity,
            R.layout.reader_book_settings_page,
            null,
        ) as LocalBookReaderSettingsView

        val generalView = inflatePage()
        val formatView = inflatePage()
        val navigationView = inflatePage()
        val filterView = inflatePage()
        val ttsView = inflatePage()

        generalView.bind(
            page = LocalBookReaderSettingsView.Page.GENERAL,
            contentType = contentType,
            activity = activity,
            bookPreferences = bookPreferences,
            commonPreferences = commonPreferences,
            onChanged = onChanged,
        )
        formatView.bind(
            page = if (contentType == ContentType.EPUB) {
                LocalBookReaderSettingsView.Page.EPUB
            } else {
                LocalBookReaderSettingsView.Page.PDF
            },
            contentType = contentType,
            activity = activity,
            bookPreferences = bookPreferences,
            commonPreferences = commonPreferences,
            onChanged = onChanged,
        )
        navigationView.bind(
            page = LocalBookReaderSettingsView.Page.NAVIGATION,
            contentType = contentType,
            activity = activity,
            bookPreferences = bookPreferences,
            commonPreferences = commonPreferences,
            onChanged = onChanged,
        )
        filterView.bind(
            page = LocalBookReaderSettingsView.Page.FILTER,
            contentType = contentType,
            activity = activity,
            bookPreferences = bookPreferences,
            commonPreferences = commonPreferences,
            onChanged = onChanged,
        )
        ttsView.bind(
            page = LocalBookReaderSettingsView.Page.TTS,
            contentType = contentType,
            activity = activity,
            bookPreferences = bookPreferences,
            commonPreferences = commonPreferences,
            onChanged = onChanged,
        )

        views = buildList {
            add(generalView)
            add(formatView)
            add(navigationView)
            add(filterView)
            add(ttsView)
        }
        titles = buildList {
            add(MR.strings.general)
            // "Paged" is the manga viewer's mode label. Books expose document/page controls
            // instead, so keep the PDF tab honest and consistent with its section.
            add(if (contentType == ContentType.EPUB) MR.strings.novel_text else MR.strings.reader_pages)
            add(MR.strings.navigation)
            add(MR.strings.custom_filter)
            add(MR.strings.text_to_speech)
        }
    }
}

class LocalBookReaderSettingsView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : NestedScrollView(context, attrs) {

    enum class Page { GENERAL, EPUB, PDF, NAVIGATION, FILTER, TTS }

    private lateinit var binding: ReaderBookSettingsPageBinding

    override fun onFinishInflate() {
        super.onFinishInflate()
        binding = ReaderBookSettingsPageBinding.bind(this)
        isFillViewport = true
    }

    @Suppress("LongMethod")
    fun bind(
        page: Page,
        contentType: ContentType,
        activity: LocalBookReaderActivity,
        bookPreferences: BookReaderPreferences,
        commonPreferences: PreferencesHelper,
        onChanged: () -> Unit,
    ) = with(binding) {
        generalGroup.isVisible = page == Page.GENERAL
        epubGroup.isVisible = page == Page.EPUB
        pdfGroup.isVisible = page == Page.PDF
        navigationGroup.isVisible = page == Page.NAVIGATION
        filterGroup.isVisible = page == Page.FILTER
        ttsGroup.isVisible = page == Page.TTS

        when (page) {
            Page.GENERAL -> {
                bindSpinner(
                    orientation,
                    listOf(context.getString(MR.strings.automatic), context.getString(MR.strings.portrait), context.getString(MR.strings.landscape)),
                    listOf(
                        ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
                        ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
                        ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
                    ),
                    bookPreferences.orientation.get(),
                    bookPreferences.orientation::set,
                    onChanged,
                )
                fullscreen.bindToPreference(bookPreferences.fullscreen) { onChanged() }
                keepScreenOn.bindToPreference(bookPreferences.keepScreenOn) { onChanged() }
                showPosition.bindToPreference(bookPreferences.showPageNumber) { onChanged() }
            }

            Page.EPUB -> bindTextSettings(bookPreferences, onChanged)

            Page.PDF -> {
                bindSpinner(pdfFitMode, listOf(context.getString(MR.strings.book_reader_fit_width), context.getString(MR.strings.book_reader_fit_height), context.getString(MR.strings.book_reader_fit_both), context.getString(MR.strings.book_reader_fit_actual)), listOf("width", "height", "both", "actual"), bookPreferences.pdfFitMode.get(), bookPreferences.pdfFitMode::set, onChanged)
                pdfReflow.bindToPreference(bookPreferences.pdfReflow) { onChanged() }
                pdfHorizontal.bindToPreference(bookPreferences.pdfHorizontal) { onChanged() }
                pdfTwoPage.bindToPreference(bookPreferences.pdfTwoPage) { onChanged() }
                // Page layout does not apply to reflowed text; its typography does.
                val reflow = bookPreferences.pdfReflow.get()
                epubGroup.isVisible = reflow
                pdfFitMode.isVisible = !reflow
                pdfHorizontal.isVisible = !reflow
                pdfTwoPage.isVisible = !reflow
                if (reflow) bindTextSettings(bookPreferences, onChanged)
            }

            Page.NAVIGATION -> {
                epubFlow.isVisible = contentType == ContentType.EPUB
                animateTransitions.isVisible = contentType == ContentType.EPUB
                if (contentType == ContentType.EPUB) {
                    bindSpinner(epubFlow, listOf(context.getString(MR.strings.book_reader_flow_scroll), context.getString(MR.strings.book_reader_flow_paginated)), listOf("scroll", "paginated"), bookPreferences.epubFlow.get(), bookPreferences.epubFlow::set, onChanged)
                    animateTransitions.bindToPreference(bookPreferences.epubAnimateTransitions) { onChanged() }
                }
                volumeKeys.bindToPreference(bookPreferences.volumeKeys) { onChanged() }
                invertVolumeKeys.bindToPreference(bookPreferences.volumeKeysInverted) { onChanged() }

                val formatKey = if (contentType == ContentType.EPUB) "epub" else "pdf"
                verticalProgress.isChecked = formatKey in commonPreferences.bookVerticalSeekbarFormats().get()
                verticalProgress.setOnCheckedChangeListener { _, checked ->
                    val formats = commonPreferences.bookVerticalSeekbarFormats().get().toMutableSet()
                    if (checked) formats += formatKey else formats -= formatKey
                    commonPreferences.bookVerticalSeekbarFormats().set(formats)
                    onChanged()
                }
                bindSlider(
                    verticalHeight,
                    context.getString(R.string.reader_vertical_progress_height),
                    commonPreferences.readerVerticalSeekbarHeightPercent().get().toFloat(),
                    60f,
                    100f,
                    5f,
                    "%",
                ) {
                    commonPreferences.readerVerticalSeekbarHeightPercent().set(it.roundToInt()); onChanged()
                }
                verticalSide.check(
                    if (commonPreferences.readerVerticalSeekbarDockLeft().get()) verticalLeft.id else verticalRight.id,
                )
                verticalSide.addOnButtonCheckedListener { _, checkedId, checked ->
                    if (checked) {
                        commonPreferences.readerVerticalSeekbarDockLeft().set(checkedId == verticalLeft.id)
                        onChanged()
                    }
                }
            }

            Page.FILTER -> {
                colorFilterEnabled.bindToPreference(bookPreferences.colorFilterEnabled) { onChanged() }
                val channels = intArrayOf(
                    Color.alpha(bookPreferences.colorFilterValue.get()),
                    Color.red(bookPreferences.colorFilterValue.get()),
                    Color.green(bookPreferences.colorFilterValue.get()),
                    Color.blue(bookPreferences.colorFilterValue.get()),
                )
                fun bindChannel(view: WidgetNovelSliderFloatBinding, label: String, index: Int) {
                    bindSlider(view, label, channels[index].toFloat(), 0f, 255f, 1f, "") {
                        channels[index] = it.roundToInt()
                        bookPreferences.colorFilterValue.set(Color.argb(channels[0], channels[1], channels[2], channels[3]))
                        onChanged()
                    }
                }
                bindChannel(colorAlpha, "A", 0)
                bindChannel(colorRed, "R", 1)
                bindChannel(colorGreen, "G", 2)
                bindChannel(colorBlue, "B", 3)
                bindSpinner(
                    colorFilterMode,
                    resources.getStringArray(R.array.color_filter_modes).toList(),
                    resources.getStringArray(R.array.color_filter_modes).indices.toList(),
                    bookPreferences.colorFilterMode.get(),
                    bookPreferences.colorFilterMode::set,
                    onChanged,
                )
                customBrightness.bindToPreference(bookPreferences.customBrightness) { onChanged() }
                bindSlider(brightness, context.getString(R.string.epigraph_reader_brightness), bookPreferences.customBrightnessValue.get().toFloat(), -75f, 100f, 1f, "") {
                    bookPreferences.customBrightnessValue.set(it.roundToInt()); onChanged()
                }
                grayscale.bindToPreference(bookPreferences.grayscale) { onChanged() }
                inverted.bindToPreference(bookPreferences.invertedColors) { onChanged() }
            }

            Page.TTS -> {
                bindSlider(
                    ttsRate,
                    context.getString(R.string.epigraph_reader_tts_speed),
                    bookPreferences.ttsRate.get() * 10f,
                    5f,
                    30f,
                    1f,
                    valueLabel = { value -> String.format(Locale.getDefault(), "%.1f×", value / 10f) },
                ) {
                    bookPreferences.ttsRate.set(it / 10f); onChanged()
                }
                bindSlider(
                    ttsPitch,
                    context.getString(R.string.epigraph_reader_tts_pitch),
                    bookPreferences.ttsPitch.get() * 10f,
                    5f,
                    20f,
                    1f,
                    valueLabel = { value -> String.format(Locale.getDefault(), "%.1f×", value / 10f) },
                ) {
                    bookPreferences.ttsPitch.set(it / 10f); onChanged()
                }
                val systemDefault = context.getString(R.string.epigraph_reader_system_default)
                val voices = activity.availableTtsVoiceNames()
                val labels = listOf(systemDefault) + voices
                val values = listOf("") + voices
                bindSpinner(ttsVoice, labels, values, bookPreferences.ttsVoice.get(), bookPreferences.ttsVoice::set, onChanged)
                bindTtsPlayback(activity)
            }
        }
    }

    private var playbackScope: CoroutineScope? = null
    private var observesTtsPlayback = false

    private fun bindTtsPlayback(activity: LocalBookReaderActivity) = with(binding) {
        ttsPlayPause.setOnClickListener { activity.toggleBookTts() }
        ttsStop.setOnClickListener { activity.stopBookTts() }
        ttsPrevious.setOnClickListener { activity.skipBookTts(forward = false) }
        ttsNext.setOnClickListener { activity.skipBookTts(forward = true) }
        observesTtsPlayback = true
        if (isAttachedToWindow) startTtsPlaybackUpdates()
    }

    // Collect only while attached: the service's state flow is static, so a view that was bound
    // but never attached (and so never detached) would keep the reader activity alive.
    private fun startTtsPlaybackUpdates() = with(binding) {
        playbackScope?.cancel()
        playbackScope = MainScope().also { scope ->
            scope.launch {
                BookTtsPlaybackService.playbackState.collect { state ->
                    val playing = state == BookTtsPlaybackService.PlaybackState.PLAYING
                    ttsPlayPause.setIconResource(if (playing) R.drawable.ic_pause_24dp else R.drawable.ic_play_arrow_24dp)
                    ttsPlayPause.text = context.getString(
                        when (state) {
                            BookTtsPlaybackService.PlaybackState.PLAYING -> MR.strings.pause
                            BookTtsPlaybackService.PlaybackState.PAUSED -> MR.strings.resume
                            BookTtsPlaybackService.PlaybackState.STOPPED -> MR.strings.novel_tts_read_aloud
                        },
                    )
                }
            }
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (observesTtsPlayback) startTtsPlaybackUpdates()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        playbackScope?.cancel()
        playbackScope = null
    }

    /** Typography shared by EPUB and reflowed PDF text, as on the desktop. */
    private fun bindTextSettings(bookPreferences: BookReaderPreferences, onChanged: () -> Unit) = with(binding) {
        bindSpinner(fontFamily, listOf(context.getString(MR.strings.book_reader_font_serif), context.getString(MR.strings.book_reader_font_sans), context.getString(MR.strings.book_reader_font_mono)), listOf("serif", "sans-serif", "monospace"), bookPreferences.epubFontFamily.get(), bookPreferences.epubFontFamily::set, onChanged)
        bindSpinner(textAlignment, listOf(context.getString(MR.strings.left), context.getString(MR.strings.book_reader_align_justified), context.getString(MR.strings.center)), listOf("left", "justified", "center"), bookPreferences.epubTextAlign.get(), bookPreferences.epubTextAlign::set, onChanged)
        bindSpinner(epubTheme, listOf(context.getString(MR.strings.book_reader_theme_system), context.getString(MR.strings.book_reader_theme_light), context.getString(MR.strings.dark), context.getString(MR.strings.book_reader_theme_sepia), context.getString(MR.strings.book_reader_theme_oled)), listOf("system", "light", "dark", "sepia", "oled"), bookPreferences.epubTheme.get(), bookPreferences.epubTheme::set, onChanged)
        bindSlider(fontSize, context.getString(R.string.epigraph_reader_font_size), bookPreferences.epubFontScale.get() * 100f, 75f, 200f, 5f, "%") {
            bookPreferences.epubFontScale.set(it / 100f); onChanged()
        }
        bindSlider(lineSpacing, context.getString(R.string.epigraph_reader_line_spacing), bookPreferences.epubLineHeight.get() * 100f, 110f, 300f, 5f, "%") {
            bookPreferences.epubLineHeight.set(it / 100f); onChanged()
        }
        bindSlider(paragraphSpacing, context.getString(R.string.epigraph_reader_paragraph_spacing), bookPreferences.epubParagraphSpacing.get() * 100f, 0f, 300f, 10f, "%") {
            bookPreferences.epubParagraphSpacing.set(it / 100f); onChanged()
        }
        bindSlider(contentWidth, context.getString(R.string.epigraph_reader_content_width), bookPreferences.epubContentWidth.get().toFloat(), 0f, 100f, 5f, "%") {
            bookPreferences.epubContentWidth.set(it.roundToInt()); onChanged()
        }
    }

    private fun <T> bindSpinner(
        spinner: eu.kanade.tachiyomi.widget.MaterialSpinnerView,
        labels: List<String>,
        values: List<T>,
        selected: T,
        set: (T) -> Unit,
        onChanged: () -> Unit,
    ) {
        spinner.setEntries(labels)
        spinner.setSelection(values.indexOf(selected).coerceAtLeast(0))
        spinner.onItemSelectedListener = { index ->
            values.getOrNull(index)?.let {
                set(it)
                onChanged()
            }
        }
    }

    private fun bindSlider(
        sliderBinding: WidgetNovelSliderFloatBinding,
        label: String,
        initial: Float,
        from: Float,
        to: Float,
        step: Float,
        suffix: String = "",
        valueLabel: ((Float) -> String)? = null,
        set: (Float) -> Unit,
    ) = with(sliderBinding) {
        title.text = label
        slider.valueFrom = from
        slider.valueTo = to
        slider.stepSize = step
        slider.value = initial.coerceIn(from, to)
        fun render(value: Float) {
            this.value.text = valueLabel?.invoke(value) ?: if (suffix == "%") {
                "${value.roundToInt()}$suffix"
            } else {
                "${value.roundToInt()}$suffix"
            }
        }
        render(slider.value)
        slider.setLabelFormatter { value -> valueLabel?.invoke(value) ?: "${value.roundToInt()}$suffix" }
        slider.addOnChangeListener { _, value, fromUser ->
            render(value)
            if (fromUser) set(value)
        }
    }
}

enum class SettingsReaderTarget { COMICS, NOVELS, BOOKS }
