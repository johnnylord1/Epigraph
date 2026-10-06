package epigraph.books.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.text.Html
import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.view.ActionMode
import android.view.GestureDetector
import android.view.Gravity
import android.view.KeyEvent
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.MenuItem
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog
import androidx.activity.OnBackPressedCallback
import androidx.coordinatorlayout.widget.CoordinatorLayout
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.doOnLayout
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePaddingRelative
import androidx.lifecycle.lifecycleScope
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.R
import com.google.android.material.R as materialR
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.button.MaterialButton
import com.google.android.material.checkbox.MaterialCheckBox
import com.google.android.material.slider.Slider
import com.google.android.material.slider.SliderOrientation
import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookRepository
import epigraph.books.local.BookBookmark
import epigraph.books.local.BookHighlight
import epigraph.books.reader.BookChapterMetrics
import epigraph.books.reader.BookReaderRouter
import epigraph.books.reader.BookReaderPreferences
import epigraph.books.reader.LegacyBookReaderPreferences
import epigraph.books.reader.epubPageMarginsForContentWidth
import epigraph.books.reader.EpubNavigatorSession
import epigraph.books.reader.OpenedBookReader
import epigraph.books.reader.PdfPasswordProvider
import epigraph.books.reader.ReaderHighlight
import epigraph.books.reader.ReaderRange
import epigraph.books.reader.ReaderTocEntry
import epigraph.books.pdf.PdfReaderSession
import epigraph.books.pdf.PdfOcrEngine
import epigraph.books.pdf.PdfSelectionSegments
import epigraph.books.pdf.PdfTextReflow
import epigraph.books.pdf.PdfPageBitmapRenderer
import epigraph.books.pdf.PdfPageView
import epigraph.books.tts.BookTtsPlaybackService
import epigraph.sync.core.assets.BookAssetCoordinator
import epigraph.contract.EpigraphEntityId
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import epigraph.contract.withDocumentMetrics
import epigraph.reader.settings.ReaderDomain
import epigraph.reader.settings.ReaderSettingsCapabilities
import epigraph.reader.settings.ReaderSettingsHost
import epigraph.reader.settings.ReaderThemeColors
import epigraph.reader.settings.applyReaderTheme
import epigraph.reader.selection.showSelectionWebSheet
import eu.kanade.tachiyomi.databinding.ReaderActivityBinding
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.ui.base.MaterialMenuSheet
import eu.kanade.tachiyomi.ui.main.SearchActivity
import eu.kanade.tachiyomi.ui.reader.ReaderSlider
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.getPrefTheme
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.system.materialAlertDialog
import eu.kanade.tachiyomi.util.view.compatToolTipText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import org.koin.android.ext.android.inject
import org.readium.r2.navigator.Decoration
import org.readium.r2.navigator.epub.EpubNavigatorFragment
import org.readium.r2.navigator.epub.EpubPreferences
import org.readium.r2.navigator.preferences.FontFamily
import org.readium.r2.navigator.preferences.TextAlign
import org.readium.r2.navigator.preferences.Theme
import org.readium.r2.navigator.preferences.Color as ReadiumColor
import org.readium.r2.shared.publication.Locator
import org.readium.r2.shared.ExperimentalReadiumApi
import org.readium.r2.shared.util.AbsoluteUrl
import kotlinx.serialization.json.Json
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.Locale
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.coroutines.resume
import yokai.i18n.MR
import yokai.util.lang.getString

/**
 * Functional host for local publications. The rendering engines remain domain-specific, while
 * the reader chrome is shared with Comics through [ReaderActivityBinding]. The file itself is
 * always resolved from the private store and never from the original SAF Uri.
 */
@OptIn(ExperimentalReadiumApi::class)
class LocalBookReaderActivity : AppCompatActivity(), ReaderSettingsHost {

    private val repository: LocalBookRepository by inject()
    private val bookAssets: BookAssetCoordinator by inject()
    private val router: BookReaderRouter by inject()
    private val bookReaderPreferences: BookReaderPreferences by inject()
    private val commonReaderPreferences: PreferencesHelper by inject()

    private var book: LocalBook? = null
    private var requestedLocator: ReaderLocator? = null
    private var opened: OpenedBookReader? = null
    private var pdfView: PdfPageView? = null
    private var pdfSecondaryView: PdfPageView? = null
    private var pdfSpreadPrimaryView: ImageView? = null
    private var pdfSpreadSecondaryView: ImageView? = null
    private var pdfSpreadPrimaryBitmap: Bitmap? = null
    private var pdfSpreadSecondaryBitmap: Bitmap? = null
    private var pdfSpreadRenderJob: Job? = null
    private var pdfSpreadGeneration = 0
    private var epubNavigator: EpubNavigatorFragment? = null
    private var epubSession: EpubNavigatorSession? = null
    private var epubLocator: ReaderLocator.Epub? = null
    private var epubChapterCount: Int = 0
    private var epubChapterIndex: Int = 0
    private var epubPendingLocalProgress: Double = 0.0
    private var password: CharArray? = null
    private var textToSpeech: TextToSpeech? = null
    private var textToSpeechReady = false
    private var pendingSpeech: String? = null
    private var speechRate = 1.0f
    private var epubFontScale = 1.0f
    private var epubLineHeight = 1.55f
    private var epubFontFamily = "serif"
    private var epubTextAlign = "left"
    private var epubParagraphSpacing = 1.1f
    private var epubTheme = "system"
    private var epubFlow = "scroll"
    private var epubContentWidth = 0
    private var pdfNightMode = false
    private var pdfFitEachPage = true
    private var pdfHorizontal = false
    private var pdfTwoPage = false
    private var pdfFitMode = PDF_FIT_BOTH
    private var pdfReflow = false
    private var pdfCurrentPage = 0
    private var pdfChapterCount = 1
    private var pdfChapterStartPages: List<Int> = emptyList()
    private var pdfReflowTextView: TextView? = null
    private var speechPitch = 1.0f
    private var speechVoiceName: String? = null
    private var speechSegments: List<String> = emptyList()
    private var speechSegmentIndex = 0
    private var activeHighlights: List<BookHighlight> = emptyList()
    /** The same reader chrome used by comics, reused for EPUB and PDF content. */
    private var readerBinding: ReaderActivityBinding? = null
    /** Settings are mounted in the existing chapter sheet; no second dialog window is used. */
    private var readerSettingsPanel: LocalBookReaderSettingsPanel? = null
    private var readerSettingsCallback: BottomSheetBehavior.BottomSheetCallback? = null
    private var readerSettingsRootHeight: Int? = null
    private var readerSettingsTopbarHeight: Int? = null
    private var readerProgressBar: ReaderSlider? = null
    private var readerProgressIsPdf = false
    private var readerProgressPageCount = 1
    private var updatingReaderProgress = false
    private var latestReaderLocator: ReaderLocator? = null
    /** Books uses the same tap-to-toggle contract as the Comics reader. */
    private var bookMenuVisible = false
    private var bookGestureStartedOnContent = false
    private val bookChromeGestureDetector by lazy {
        GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(event: MotionEvent): Boolean = true

            override fun onSingleTapConfirmed(event: MotionEvent): Boolean {
                val chrome = readerBinding ?: return false
                if (readerSettingsPanel != null) {
                    // Settings is embedded in the same sheet as the fixed reader HUD. A tap on
                    // the page above that sheet should dismiss the expanded settings surface,
                    // while taps on the sheet itself remain available to its controls.
                    val sheetTop = chrome.chaptersSheet.root.top
                    val inToolbar = chrome.appBar.isVisible && event.y <= chrome.appBar.bottom
                    if (!inToolbar && event.y < sheetTop) {
                        closeReaderSettingsPanel()
                        return true
                    }
                    return false
                }

                // Keep the same central tap affordance used by the manga/novel viewers. Taps on
                // the toolbar, rail, chapter sheet, or edge navigation remain format actions.
                val width = chrome.root.width.takeIf { it > 0 } ?: return false
                val height = chrome.root.height.takeIf { it > 0 } ?: return false
                val inCenterX = event.x in (width * 0.30f)..(width * 0.70f)
                val inCenterY = event.y in (height * 0.25f)..(height * 0.75f)
                if (!inCenterX) {
                    turnPage(forward = event.x > width * 0.70f)
                    return true
                }
                if (!inCenterY) return false

                setBookReaderMenuVisibility(!bookMenuVisible)
                return true
            }

            override fun onFling(
                first: MotionEvent?,
                second: MotionEvent,
                velocityX: Float,
                velocityY: Float,
            ): Boolean {
                if (readerSettingsPanel != null) return false
                if (abs(velocityX) <= abs(velocityY) * 1.5f || abs(velocityX) < BOOK_PAGE_FLING_VELOCITY) {
                    return false
                }
                if (!readerProgressIsPdf) {
                    // The paginated EPUB WebView does not page on a swipe by itself; scroll flow
                    // keeps horizontal flings for the WebView.
                    if (epubNavigator == null || epubFlow != EPUB_FLOW_PAGINATED) return false
                    turnPage(forward = velocityX < 0f)
                    return true
                }
                if (pdfSpreadPrimaryView == null && pdfReflowTextView == null) return false
                navigateReader(if (velocityX < 0f) 1 else -1)
                return true
            }
        })
    }

    /** One page for PDF and a viewport for EPUB, whose [navigateReader] steps whole chapters. */
    private fun turnPage(forward: Boolean) {
        val navigator = epubNavigator
        if (!readerProgressIsPdf && navigator != null) {
            val animated = bookReaderPreferences.epubAnimateTransitions.get()
            if (forward) navigator.goForward(animated) else navigator.goBackward(animated)
            return
        }
        navigateReader(if (forward) 1 else -1)
    }
    private val pdfOcrEngine = PdfOcrEngine()

    override val readerDomain: ReaderDomain = ReaderDomain.BOOK
    override val readerSettingsCapabilities: ReaderSettingsCapabilities
        get() = ReaderSettingsCapabilities(
            supportsPagedNavigation = true,
            supportsTextLayout = book?.contentType == ContentType.EPUB || pdfReflow,
            supportsColorFilters = true,
            supportsDoublePages = book?.contentType == ContentType.PDF,
            supportsCropBorders = false,
            supportsTts = book?.contentType == ContentType.EPUB || pdfReflow,
            supportsChapterTransitions = book?.contentType == ContentType.EPUB,
        )

    override fun applyReaderSettings() = applyBookReaderSettings()

    override fun resetReaderSettingsToDefaults() {
        bookReaderPreferences.resetReaderSettingsToDefaults()
        applyBookReaderSettings(reloadContent = true)
        showMessage(getString(R.string.epigraph_reader_reset_defaults))
    }

    override fun openGlobalReaderSettings() {
        startActivity(SearchActivity.openReaderSettings(this, SettingsReaderTarget.BOOKS.name))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Readium restores child fragments during super.onCreate. A publication is opened
        // asynchronously, so install the official dummy factory first; the real factory replaces
        // it immediately before the navigator is mounted.
        supportFragmentManager.fragmentFactory = EpubNavigatorFragment.Companion.createDummyFactory()
        // The HUD accent follows the app theme, like the comic and novel reader.
        setTheme(getPrefTheme(commonReaderPreferences).styleRes)
        super.onCreate(savedInstanceState)
        bookMenuVisible = savedInstanceState?.getBoolean(KEY_BOOK_MENU_VISIBLE) ?: false
        // Use AndroidX's dispatcher so the reader also receives predictive-back gestures on
        // Android 16+. Settings must close first; a second back exits the activity as before.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (readerSettingsPanel != null) {
                    closeReaderSettingsPanel()
                } else if (readerBinding?.chaptersSheet?.root?.sheetBehavior?.state ==
                    BottomSheetBehavior.STATE_EXPANDED
                ) {
                    readerBinding?.chaptersSheet?.root?.sheetBehavior?.state =
                        BottomSheetBehavior.STATE_COLLAPSED
                } else {
                    finish()
                }
            }
        })
        title = getString(MR.strings.local_books_title)
        setContentView(
            FrameLayout(this).apply {
                addView(
                    ProgressBar(context),
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        Gravity.CENTER,
                    ),
                )
            },
        )
        val bookId = intent.getStringExtra(EXTRA_BOOK_ID)
        if (bookId.isNullOrBlank()) {
            finishWithError(getString(MR.strings.book_reader_unavailable))
            return
        }
        requestedLocator = intent.getStringExtra(EXTRA_INITIAL_LOCATOR_JSON)
            ?.takeIf(String::isNotBlank)
            ?.let { encoded ->
                runCatching { READER_LOCATOR_JSON.decodeFromString(ReaderLocator.serializer(), encoded) }
                    .getOrNull()
            }
        lifecycleScope.launch {
            val loaded = withContext(Dispatchers.IO) { repository.find(bookId) }
            if (loaded == null) {
                finishWithError(getString(MR.strings.book_reader_unavailable))
                return@launch
            }
            book = loaded
            if (!loaded.isAvailable) {
                runCatching {
                    withContext(Dispatchers.IO) { bookAssets.ensurePublicationAvailable(loaded.bookId) }
                }.onFailure { failure ->
                    finishWithError(failure.message ?: getString(MR.strings.book_reader_download_failed))
                    return@launch
                }
            }
            loadReaderPreferences(loaded)
            open(loaded)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(KEY_BOOK_MENU_VISIBLE, bookMenuVisible)
        super.onSaveInstanceState(outState)
    }

    /** Observe content taps before EPUB WebView/PDF surfaces consume them. */
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val chrome = readerBinding
        if (chrome == null) {
            bookGestureStartedOnContent = false
        } else {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val inToolbar = chrome.appBar.isVisible && event.y <= chrome.appBar.bottom
                    // The progress rail may be docked vertically at a screen edge, where taps
                    // would otherwise also turn the page.
                    val inHud = chrome.navLayout.isVisible && (
                        event.y >= chrome.root.height - 180.dpToPx ||
                            android.graphics.Rect().let { bounds ->
                                chrome.navLayout.getGlobalVisibleRect(bounds) &&
                                    bounds.contains(event.rawX.toInt(), event.rawY.toInt())
                            }
                        )
                    val inSheet = chrome.chaptersSheet.root.isVisible &&
                        event.y >= chrome.chaptersSheet.root.top
                    bookGestureStartedOnContent = !inToolbar && !inHud && !inSheet
                    if (bookGestureStartedOnContent) bookChromeGestureDetector.onTouchEvent(event)
                }
                MotionEvent.ACTION_MOVE,
                MotionEvent.ACTION_UP,
                MotionEvent.ACTION_CANCEL
                -> if (bookGestureStartedOnContent) bookChromeGestureDetector.onTouchEvent(event)
            }
            if (event.actionMasked == MotionEvent.ACTION_UP ||
                event.actionMasked == MotionEvent.ACTION_CANCEL
            ) {
                bookGestureStartedOnContent = false
            }
        }
        return super.dispatchTouchEvent(event)
    }

    private suspend fun open(localBook: LocalBook) {
        val progress = withContext(Dispatchers.IO) { repository.getProgress(localBook.bookId) }
        val initialLocator = requestedLocator
            ?.takeIf { locator ->
                locator.entityId == localBook.document().entityId &&
                    locator.contentType == localBook.contentType
            }
            ?: progress
        try {
            val passwordProvider = if (localBook.contentType == ContentType.PDF) {
                PdfPasswordProvider { attempt -> requestPassword(attempt) }
            } else {
                null
            }
            val result = router.open(
                document = localBook.document(),
                initialLocator = initialLocator,
                pdfPasswordProvider = passwordProvider,
            )
            opened = result
            val savedHighlights = withContext(Dispatchers.IO) {
                runCatching { repository.getHighlights(localBook.bookId) }.getOrDefault(emptyList())
            }
            activeHighlights = savedHighlights
            when (result) {
                is OpenedBookReader.Pdf -> {
                    renderPersistedHighlights(result, savedHighlights)
                    showPdf(localBook, result, initialLocator as? ReaderLocator.Pdf)
                }

                is OpenedBookReader.Epub -> {
                    renderPersistedHighlights(result, savedHighlights)
                    showEpub(localBook, result, initialLocator as? ReaderLocator.Epub)
                }
            }
        } catch (error: Throwable) {
            finishWithError(error.message ?: getString(MR.strings.book_reader_open_failed))
        }
    }

    private suspend fun showPdf(
        localBook: LocalBook,
        reader: OpenedBookReader.Pdf,
        progress: ReaderLocator.Pdf?,
    ) {
        if (pdfReflow) {
            showPdfReflow(localBook, reader, progress)
            return
        }
        if (pdfTwoPage) {
            showPdfSpread(localBook, reader, progress)
            return
        }
        readerProgressIsPdf = true
        pdfReflowTextView = null
        clearPdfSpread()
        pdfView?.recycle()
        pdfSecondaryView?.recycle()
        pdfView = null
        pdfSecondaryView = null
        val view = PdfPageView(this)
        pdfView = view
        view.setReaderOptions(pdfFitMode, pdfNightMode, pdfHorizontal)
        setReaderContent(localBook, view)
        val page = progress?.pageIndex ?: reader.session.currentLocator().pageIndex
        val session = reader.session as? PdfReaderSession
            ?: error("The Pdfium reader session is unavailable")
        readerProgressPageCount = session.pageCount.coerceAtLeast(1)
        pdfChapterCount = BookChapterMetrics.effectiveChapterCount(
            ContentType.PDF,
            localBook.chapterCount,
            null,
        )
        pdfChapterStartPages = localBook.pdfSections.map { it.pageIndex }
        withContext(Dispatchers.IO) {
            repository.saveStructure(
                bookId = localBook.bookId,
                chapterCount = null,
                pageCount = readerProgressPageCount,
            )
        }
        pdfCurrentPage = page.coerceIn(0, readerProgressPageCount - 1)
        latestReaderLocator = pdfLocator(localBook.document().entityId, pdfCurrentPage)
        view.onPageSwipe = { delta -> navigateReader(delta) }
        view.onLongPress = { showPdfTextSelectionDialog() }
        renderPdfPage(localBook, reader, view, pdfCurrentPage)
        updateReaderProgress(
            value = pdfCurrentPage,
            max = (readerProgressPageCount - 1).coerceAtLeast(1),
            label = getString(MR.strings.book_reader_page_label, pdfCurrentPage + 1, readerProgressPageCount),
        )
    }

    private fun renderPdfPage(
        localBook: LocalBook,
        reader: OpenedBookReader.Pdf,
        view: PdfPageView,
        page: Int,
    ) {
        val renderer = reader.session as? PdfPageBitmapRenderer ?: return
        val generation = ++pdfSpreadGeneration
        lifecycleScope.launch {
            val bitmap = withContext(Dispatchers.IO) {
                renderer.renderPageBitmap(page.coerceAtLeast(0), maxDimension = 2_800)
            }
            if (generation != pdfSpreadGeneration || isFinishing || isDestroyed || pdfView !== view) {
                bitmap?.recycle()
                return@launch
            }
            view.setBitmap(bitmap)
            val locator = pdfLocator(localBook.document().entityId, page)
            runCatching { reader.session.navigateTo(locator) }
            withContext(Dispatchers.IO) { persistProgress(localBook, locator) }
        }
    }

    private suspend fun showPdfSpread(
        localBook: LocalBook,
        reader: OpenedBookReader.Pdf,
        progress: ReaderLocator.Pdf?,
    ) {
        readerProgressIsPdf = true
        pdfReflowTextView = null
        clearPdfSpread()
        pdfView?.recycle()
        pdfSecondaryView?.recycle()
        pdfView = null
        pdfSecondaryView = null
        clearPdfSpread()
        val session = reader.session as? PdfReaderSession
        readerProgressPageCount = session?.pageCount?.coerceAtLeast(1) ?: 1
        pdfChapterCount = BookChapterMetrics.effectiveChapterCount(
            ContentType.PDF,
            localBook.chapterCount,
            null,
        )
        pdfChapterStartPages = localBook.pdfSections.map { it.pageIndex }
        withContext(Dispatchers.IO) {
            repository.saveStructure(
                bookId = localBook.bookId,
                chapterCount = null,
                pageCount = readerProgressPageCount,
            )
        }
        pdfCurrentPage = pdfSpreadStart(progress?.pageIndex ?: reader.session.currentLocator().pageIndex)
        latestReaderLocator = pdfLocator(localBook.document().entityId, pdfCurrentPage)

        val spread = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(4.dpToPx, 4.dpToPx, 4.dpToPx, 4.dpToPx)
            gravity = android.view.Gravity.CENTER
        }
        val primary = createPdfSpreadImageView()
        val secondary = createPdfSpreadImageView()
        applyPdfImageOptions(primary)
        applyPdfImageOptions(secondary)
        pdfSpreadPrimaryView = primary
        pdfSpreadSecondaryView = secondary
        spread.addView(primary, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        spread.addView(secondary, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        setReaderContent(localBook, spread)
        loadPdfSpreadPages(localBook, reader, primary, secondary, pdfCurrentPage)
        updateReaderProgress(
            value = pdfCurrentPage,
            max = (readerProgressPageCount - 1).coerceAtLeast(1),
            label = getString(MR.strings.book_reader_pages_label, pdfCurrentPage + 1, (pdfCurrentPage + 2).coerceAtMost(readerProgressPageCount), readerProgressPageCount),
        )
    }

    /** A spread shows two pages; reflow and single-page modes show one. */
    private fun pdfPagesShown(): Int = if (pdfReflowTextView == null && pdfSpreadPrimaryView != null) 2 else 1

    private fun pdfSpreadStart(page: Int): Int {
        val bounded = page.coerceIn(0, (readerProgressPageCount - 1).coerceAtLeast(0))
        return bounded - bounded % 2
    }

    private fun createPdfSpreadImageView(): ImageView = ImageView(this).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        setBackgroundColor(android.graphics.Color.WHITE)
        isClickable = true
    }

    private fun applyPdfImageOptions(view: ImageView) {
        view.colorFilter = if (pdfNightMode) {
            android.graphics.ColorMatrixColorFilter(android.graphics.ColorMatrix(floatArrayOf(
                -1f, 0f, 0f, 0f, 255f,
                0f, -1f, 0f, 0f, 255f,
                0f, 0f, -1f, 0f, 255f,
                0f, 0f, 0f, 1f, 0f,
            )))
        } else null
        view.setBackgroundColor(if (pdfNightMode) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
    }

    private fun loadPdfSpreadPages(
        localBook: LocalBook,
        reader: OpenedBookReader.Pdf,
        primary: ImageView,
        secondary: ImageView,
        firstPage: Int,
    ) {
        val renderer = reader.session as? PdfPageBitmapRenderer ?: return
        val safeFirst = firstPage.coerceIn(0, (readerProgressPageCount - 1).coerceAtLeast(0))
        val secondPage = (safeFirst + 1).coerceAtMost((readerProgressPageCount - 1).coerceAtLeast(0))
        secondary.visibility = if (secondPage == safeFirst) android.view.View.INVISIBLE else android.view.View.VISIBLE
        pdfSpreadRenderJob?.cancel()
        val generation = ++pdfSpreadGeneration
        // Select from the page that was pressed; the spread itself stays where it is.
        primary.setOnLongClickListener {
            showPdfTextSelectionDialog(onlyPage = safeFirst)
            true
        }
        secondary.setOnLongClickListener {
            if (secondPage != safeFirst) showPdfTextSelectionDialog(onlyPage = secondPage)
            true
        }
        pdfSpreadRenderJob = lifecycleScope.launch {
            val bitmaps = withContext(Dispatchers.IO) {
                val first = renderer.renderPageBitmap(safeFirst, maxDimension = 2_000)
                val second = if (secondPage != safeFirst) {
                    renderer.renderPageBitmap(secondPage, maxDimension = 2_000)
                } else {
                    null
                }
                first to second
            }
            if (generation != pdfSpreadGeneration || isFinishing || isDestroyed) {
                bitmaps.first?.recycle()
                bitmaps.second?.recycle()
                return@launch
            }
            setPdfSpreadBitmap(primary, bitmaps.first, isPrimary = true)
            setPdfSpreadBitmap(secondary, bitmaps.second, isPrimary = false)
        }
    }

    private fun setPdfSpreadBitmap(view: ImageView, bitmap: Bitmap?, isPrimary: Boolean) {
        val previous = if (isPrimary) pdfSpreadPrimaryBitmap else pdfSpreadSecondaryBitmap
        view.setImageBitmap(bitmap)
        if (isPrimary) {
            pdfSpreadPrimaryBitmap = bitmap
        } else {
            pdfSpreadSecondaryBitmap = bitmap
        }
        if (previous != null && previous !== bitmap) previous.recycle()
    }

    private fun clearPdfSpread() {
        pdfSpreadGeneration++
        pdfSpreadRenderJob?.cancel()
        pdfSpreadRenderJob = null
        pdfSpreadPrimaryView?.setImageDrawable(null)
        pdfSpreadSecondaryView?.setImageDrawable(null)
        pdfSpreadPrimaryBitmap?.recycle()
        pdfSpreadSecondaryBitmap?.recycle()
        pdfSpreadPrimaryBitmap = null
        pdfSpreadSecondaryBitmap = null
        pdfSpreadPrimaryView = null
        pdfSpreadSecondaryView = null
    }

    private suspend fun showPdfReflow(
        localBook: LocalBook,
        reader: OpenedBookReader.Pdf,
        progress: ReaderLocator.Pdf?,
    ) {
        readerProgressIsPdf = true
        clearPdfSpread()
        pdfView?.recycle()
        pdfSecondaryView?.recycle()
        pdfView = null
        pdfSecondaryView = null
        val session = reader.session as? PdfReaderSession
        readerProgressPageCount = session?.pageCount?.coerceAtLeast(1) ?: 1
        pdfChapterCount = BookChapterMetrics.effectiveChapterCount(
            ContentType.PDF,
            localBook.chapterCount,
            null,
        )
        pdfChapterStartPages = localBook.pdfSections.map { it.pageIndex }
        withContext(Dispatchers.IO) {
            repository.saveStructure(
                bookId = localBook.bookId,
                chapterCount = null,
                pageCount = readerProgressPageCount,
            )
        }
        pdfCurrentPage = (progress?.pageIndex ?: reader.session.currentLocator().pageIndex)
            .coerceIn(0, readerProgressPageCount - 1)
        latestReaderLocator = pdfLocator(localBook.document().entityId, pdfCurrentPage)
        val scroll = android.widget.ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
        }
        // Edge-to-edge in fullscreen: keep the first and last lines clear of the system bars.
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val textView = TextView(this).apply {
            setTextIsSelectable(true)
            installTextSelectionActions(this) { selected ->
                savePdfHighlight(pdfCurrentPage, selected.first, selected.second, selected.third)
            }
        }
        pdfReflowTextView = textView
        applyPdfReflowStyle(textView)
        scroll.addView(textView, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))
        setReaderContent(localBook, scroll)
        updateReaderProgress(
            value = pdfCurrentPage,
            max = (readerProgressPageCount - 1).coerceAtLeast(1),
            label = getString(MR.strings.book_reader_page_label, pdfCurrentPage + 1, readerProgressPageCount),
        )
        renderPdfReflowPage(reader, pdfCurrentPage)
    }

    private fun renderPdfReflowPage(reader: OpenedBookReader.Pdf, page: Int) {
        val textView = pdfReflowTextView ?: return
        lifecycleScope.launch {
            val text = withContext(Dispatchers.IO) {
                extractPdfText(reader, page) {
                    withContext(Dispatchers.Main) {
                        if (pdfReflowTextView === textView) textView.text = getString(MR.strings.book_reader_pdf_reading_text)
                    }
                }
            }
            if (isFinishing || isDestroyed || pdfReflowTextView !== textView) return@launch
            val paragraphs = PdfTextReflow.paragraphs(text)
            if (paragraphs.isEmpty()) {
                textView.text =
                    getString(MR.strings.book_reader_reflow_no_text)
                return@launch
            }
            val reflowed = paragraphs.joinToString(PDF_REFLOW_PARAGRAPH_BREAK)
            val styled = SpannableString(highlightPdfText(reflowed, page))
            // The empty line between paragraphs carries the paragraph-spacing setting.
            val spacing = epubParagraphSpacing.coerceIn(0.05f, 3f)
            var breakAt = reflowed.indexOf(PDF_REFLOW_PARAGRAPH_BREAK)
            while (breakAt >= 0) {
                styled.setSpan(
                    android.text.style.RelativeSizeSpan(spacing),
                    breakAt + 1,
                    breakAt + 2,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
                breakAt = reflowed.indexOf(PDF_REFLOW_PARAGRAPH_BREAK, breakAt + 2)
            }
            textView.text = styled
        }
    }

    /** PDF text reflow shares the EPUB text settings, as on the desktop. */
    private fun applyPdfReflowStyle(textView: TextView) {
        val colors = ReaderThemeColors.book(this, epubTheme)
        textView.textSize = PDF_REFLOW_BASE_TEXT_SP * epubFontScale
        textView.setLineSpacing(0f, epubLineHeight / PDF_REFLOW_NATIVE_LINE_HEIGHT)
        textView.typeface = when (epubFontFamily) {
            "sans-serif" -> android.graphics.Typeface.SANS_SERIF
            "monospace" -> android.graphics.Typeface.MONOSPACE
            else -> android.graphics.Typeface.SERIF
        }
        textView.gravity = if (epubTextAlign == EPUB_ALIGN_CENTER) {
            android.view.Gravity.CENTER_HORIZONTAL
        } else {
            android.view.Gravity.START
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            textView.justificationMode = if (epubTextAlign == EPUB_ALIGN_JUSTIFIED) {
                android.text.Layout.JUSTIFICATION_MODE_INTER_WORD
            } else {
                android.text.Layout.JUSTIFICATION_MODE_NONE
            }
        }
        textView.setTextColor(colors.foreground)
        textView.setBackgroundColor(colors.background)
        (textView.parent as? View)?.setBackgroundColor(colors.background)
        val width = resources.displayMetrics.widthPixels
        val side = epubPageMarginsForContentWidth(epubContentWidth)
            ?.let { factor -> (width * factor / 12).toInt() }
            ?: 0
        textView.setPadding(20.dpToPx + side, 16.dpToPx, 20.dpToPx + side, 24.dpToPx)
    }

    /** Text settings apply in reflow and EPUB; the original PDF page keeps its own colors. */
    private fun usesTextTheme(localBook: LocalBook? = book): Boolean =
        localBook?.contentType == ContentType.EPUB || (localBook?.contentType == ContentType.PDF && pdfReflow)

    private fun highlightPdfText(text: String, page: Int): CharSequence {
        val result = SpannableString(text)
        activeHighlights
            .filter { (it.start as? ReaderLocator.Pdf)?.pageIndex == page }
            .forEach { highlight ->
                val selected = highlight.selectedText.trim()
                if (selected.isBlank()) return@forEach
                var from = text.indexOf(selected, ignoreCase = false)
                while (from >= 0) {
                    result.setSpan(
                        BackgroundColorSpan(highlight.colorArgb.toInt()),
                        from,
                        (from + selected.length).coerceAtMost(text.length),
                        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                    )
                    from = text.indexOf(selected, from + selected.length, ignoreCase = false)
                }
            }
        return result
    }

    private fun installTextSelectionActions(
        textView: TextView,
        selected: (Triple<Int, Int, String>) -> Unit,
    ) {
        textView.customSelectionActionModeCallback = object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                menu.add(Menu.NONE, MENU_HIGHLIGHT_SELECTION, Menu.NONE, getString(MR.strings.book_reader_highlight))
                    .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                menu.add(Menu.NONE, MENU_DEFINE_SELECTION, Menu.NONE, getString(MR.strings.book_reader_define))
                    .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                menu.add(Menu.NONE, MENU_TRANSLATE_SELECTION, Menu.NONE, getString(MR.strings.book_reader_translate))
                    .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                menu.add(Menu.NONE, MENU_SEARCH_SELECTION, Menu.NONE, getString(MR.strings.book_reader_search_web))
                    .setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER)
                return true
            }

            override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                val start = min(textView.selectionStart, textView.selectionEnd)
                val end = max(textView.selectionStart, textView.selectionEnd)
                val value = textView.text?.toString().orEmpty()
                if (start < 0 || end <= start || end > value.length) {
                    showMessage(getString(MR.strings.book_reader_select_text_first))
                    return false
                }
                val selectedText = value.substring(start, end)
                when (item.itemId) {
                    MENU_HIGHLIGHT_SELECTION -> selected(Triple(start, end, selectedText))
                    MENU_DEFINE_SELECTION -> showSelectionLookup("define", selectedText)
                    MENU_TRANSLATE_SELECTION -> showSelectionLookup("translate", selectedText)
                    MENU_SEARCH_SELECTION -> showSelectionLookup("search", selectedText)
                    else -> return false
                }
                mode.finish()
                return true
            }

            override fun onDestroyActionMode(mode: ActionMode) = Unit
        }
    }

    private fun showSelectionLookup(kind: String, selectedText: String) {
        val query = selectedText.replace(Regex("\\s+"), " ").trim().take(MAX_SELECTION_QUERY)
        if (query.isBlank()) {
            showMessage(getString(MR.strings.book_reader_select_text_first))
            return
        }
        val encoded = Uri.encode(query)
        val url = when (kind) {
            "define" -> "https://www.google.com/search?q=define+$encoded"
            "translate" -> "https://translate.google.com/?sl=auto&tl=auto&text=$encoded"
            else -> "https://www.google.com/search?q=$encoded"
        }
        showSelectionWebSheet(this, url, query)
    }

    private fun savePdfHighlight(page: Int, start: Int, end: Int, selectedText: String) {
        val localBook = book ?: return
        val normalized = selectedText.replace(Regex("\\s+"), " ").trim()
            .take(MAX_HIGHLIGHT_TEXT)
        if (normalized.isBlank() || end <= start) {
            showMessage(getString(MR.strings.book_reader_select_text_first))
            return
        }
        val length = selectedText.length.coerceAtLeast(1)
        val locatorStart = pdfLocator(
            entityId = localBook.document().entityId,
            pageIndex = page,
            pageOffset = (start.toDouble() / length).coerceIn(0.0, 1.0),
            characterOffset = start,
        )
        val locatorEnd = pdfLocator(
            entityId = localBook.document().entityId,
            pageIndex = page,
            pageOffset = (end.toDouble() / length).coerceIn(0.0, 1.0),
            characterOffset = end,
        )
        lifecycleScope.launch {
            val now = System.currentTimeMillis()
            runCatching {
                withContext(Dispatchers.IO) {
                    repository.addHighlight(
                        BookHighlight(
                            highlightId = UUID.randomUUID().toString(),
                            bookId = localBook.bookId,
                            start = locatorStart,
                            end = locatorEnd,
                            selectedText = normalized,
                            colorArgb = DEFAULT_HIGHLIGHT_COLOR,
                            createdAt = now,
                            updatedAt = now,
                        ),
                    )
                    activeHighlights = repository.getHighlights(localBook.bookId)
                    opened?.let { renderPersistedHighlights(it, activeHighlights) }
                }
                if (pdfReflow) {
                    (opened as? OpenedBookReader.Pdf)?.let { renderPdfReflowPage(it, page) }
                }
            }.onSuccess { showMessage(getString(MR.strings.book_reader_highlight_saved)) }
                .onFailure { showMessage(it.message ?: getString(MR.strings.book_reader_highlight_failed)) }
        }
    }

    private suspend fun showEpub(
        localBook: LocalBook,
        reader: OpenedBookReader.Epub,
        progress: ReaderLocator.Epub?,
    ) {
        val session = reader.session as? EpubNavigatorSession
            ?: error("The EPUB Readium navigator is unavailable")
        epubSession = session
        epubChapterCount = session.spineSize
        withContext(Dispatchers.IO) {
            repository.saveStructure(
                bookId = localBook.bookId,
                chapterCount = epubChapterCount.coerceAtLeast(1),
                pageCount = null,
            )
        }
        readerProgressIsPdf = false
        epubLocator = progress ?: reader.session.currentLocator()
        latestReaderLocator = epubLocator
        epubChapterIndex = epubLocator?.let(session::chapterIndexFor) ?: 0

        // Readium's FragmentFactory must be installed before the navigator fragment is restored.
        // The Activity installs the dummy factory in onCreate; here we replace it with the
        // publication-bound factory and mount the only EPUB renderer.
        val navigatorContainer = FrameLayout(this).apply { id = android.view.View.generateViewId() }
        setReaderContent(localBook, navigatorContainer)
        // A process-death restore may have materialized a dummy navigator before the publication
        // was reopened. Remove that placeholder before mounting the publication-bound fragment.
        supportFragmentManager.findFragmentByTag(EPUB_NAVIGATOR_TAG)?.let { restored ->
            supportFragmentManager.beginTransaction().remove(restored).commitNow()
        }
        supportFragmentManager.fragmentFactory = session.navigator.createFragmentFactory(
            initialLocator = epubLocator?.let(session::toReadiumLocator),
            readingOrder = null,
            initialPreferences = readiumPreferences(session),
            listener = object : EpubNavigatorFragment.Listener {
                override fun onExternalLinkActivated(url: AbsoluteUrl) {
                    showMessage(getString(MR.strings.book_reader_external_links_disabled))
                }
            },
            paginationListener = object : EpubNavigatorFragment.PaginationListener {
                override fun onPageChanged(pageIndex: Int, totalPages: Int, locator: Locator) {
                    blockExternalEpubNetwork(navigator = epubNavigator)
                    session.updateFromNavigator(locator)
                    val current = session.toReaderLocator(locator)
                    epubLocator = current
                    latestReaderLocator = current
                    epubChapterIndex = session.chapterIndexFor(current)
                    val global = current.progression.coerceIn(0.0, 1.0)
                    updateReaderProgress(
                        value = (global * READER_PROGRESS_MAX).toInt(),
                        max = READER_PROGRESS_MAX,
                        label = epubChapterLabel(),
                    )
                    lifecycleScope.launch(Dispatchers.IO) {
                        persistProgress(localBook, current)
                    }
                }

                override fun onPageLoaded() {
                    blockExternalEpubNetwork(navigator = epubNavigator)
                }
            },
            configuration = EpubNavigatorFragment.Configuration().apply {
                selectionActionModeCallback = epubSelectionActionModeCallback
            },
        )
        val navigator = supportFragmentManager.fragmentFactory.instantiate(
            classLoader,
            EpubNavigatorFragment::class.java.name,
        ) as? EpubNavigatorFragment ?: error("Readium did not create an EPUB navigator")
        epubNavigator = navigator
        supportFragmentManager.beginTransaction()
            .replace(navigatorContainer.id, navigator, EPUB_NAVIGATOR_TAG)
            .commitNow()
        blockExternalEpubNetwork(navigator)
        applyEpubHighlights()
        val initialProgress = epubLocator?.progression ?: 0.0
        updateReaderProgress(
            value = (initialProgress * READER_PROGRESS_MAX).toInt(),
            max = READER_PROGRESS_MAX,
            label = epubChapterLabel(),
        )
    }

    /**
     * Readium's WebViewServer intercepts resources from the local publication. Disable the
     * WebView's fallback network path as a second boundary so an EPUB's remote image/script/link
     * cannot escape the private-file reader. This is repeated when lazy pages are created.
     */
    private fun blockExternalEpubNetwork(navigator: EpubNavigatorFragment?) {
        val root = navigator?.publicationView ?: return

        fun visit(view: View) {
            if (view is android.webkit.WebView) {
                runCatching {
                    view.settings.blockNetworkLoads = true
                    view.settings.allowFileAccess = false
                    view.settings.allowContentAccess = false
                    view.settings.allowFileAccessFromFileURLs = false
                    view.settings.allowUniversalAccessFromFileURLs = false
                    view.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                }
            }
            if (view is ViewGroup) {
                for (index in 0 until view.childCount) visit(view.getChildAt(index))
            }
        }

        visit(root)
    }

    /**
     * Installs the canonical Comics reader shell around a book surface. EPUB and PDF keep their
     * own rendering/session code, but the toolbar, progress navigation, bottom action sheet,
     * insets and touch targets now come from the exact same XML used by comics.
     */
    private fun setReaderContent(localBook: LocalBook, content: View) {
        // PDF mode changes rebuild the whole reader surface. Settings belonged to the discarded
        // chrome, so drop that panel and reopen it on the new sheet at the same tab; otherwise
        // taps keep routing to a detached panel and the HUD can no longer be toggled.
        val reopenSettingsTab = readerSettingsPanel?.selectedTab
        if (reopenSettingsTab != null) {
            readerSettingsCallback = null
            readerSettingsPanel = null
            readerSettingsRootHeight = null
            readerSettingsTopbarHeight = null
        }
        val chrome = ReaderActivityBinding.inflate(layoutInflater)
        readerBinding = chrome
        chrome.viewerContainer.addView(
            content,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        chrome.touchView.isVisible = false
        chrome.navigationOverlay.isVisible = false
        chrome.colorOverlay.isVisible = false
        chrome.brightnessOverlay.isVisible = false
        chrome.pageNumber.isVisible = false
        setContentView(chrome.root)

        // Keep the same translucent surface used by ReaderActivity/Comics. The book engines
        // own only the content surface; every piece of chrome is still rendered by this layout.
        chrome.appBar.setBackgroundColor(ContextCompat.getColor(this, R.color.surface_alpha))
        ViewCompat.setBackgroundTintList(
            chrome.readerNav.root,
            ColorStateList.valueOf(ContextCompat.getColor(this, R.color.surface_alpha)),
        )
        window.statusBarColor = Color.TRANSPARENT
        setSupportActionBar(chrome.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        chrome.toolbar.navigationIcon?.setTint(getResourceColor(R.attr.actionBarTintColor))
        chrome.toolbar.navigationContentDescription = getString(android.R.string.cancel)
        chrome.toolbar.setNavigationOnClickListener { finish() }
        chrome.toolbar.title = localBook.displayName
        chrome.toolbar.subtitle = localBook.contentType.name
        chrome.toolbar.menu.clear()
        applyBookChromeTheme(localBook)

        configureBookNavigation(chrome)
        configureBookBottomSheet(chrome)
        ViewCompat.setOnApplyWindowInsetsListener(chrome.root) { _, insets ->
            val system = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            chrome.appBar.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                topMargin = system.top
                leftMargin = system.left
                rightMargin = system.right
            }
            applyBookReaderNavLayout(chrome, system)
            chrome.chaptersSheet.root.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                leftMargin = system.left
                rightMargin = system.right
                if (readerSettingsPanel == null) {
                    height = 280.dpToPx + system.bottom
                } else {
                    height = ViewGroup.LayoutParams.WRAP_CONTENT
                }
            }
            chrome.chaptersSheet.root.sheetBehavior?.peekHeight =
                50.dpToPx + if (bookReaderPreferences.fullscreen.get()) {
                    insets.getInsets(WindowInsetsCompat.Type.systemGestures()).bottom
                } else {
                    0
                }
            chrome.chaptersSheet.chapterRecycler.updatePaddingRelative(bottom = system.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(chrome.root)
        applyBookReaderSettings(reloadContent = false)
        setBookReaderMenuVisibility(bookMenuVisible)
        if (reopenSettingsTab != null) {
            chrome.root.post {
                if (readerBinding !== chrome || isFinishing || isDestroyed) return@post
                showReaderSettings()
                readerSettingsPanel?.selectedTab = reopenSettingsTab
            }
        }
    }

    private fun configureBookNavigation(chrome: ReaderActivityBinding) {
        chrome.readerNav.root.isVisible = true
        chrome.navLayout.isVisible = true
        chrome.readerNav.leftChapter.setOnClickListener { navigateReader(-1) }
        chrome.readerNav.rightChapter.setOnClickListener { navigateReader(1) }
        chrome.readerNav.pageSeekbar.apply {
            valueFrom = 0f
            valueTo = if (readerProgressIsPdf) {
                (readerProgressPageCount - 1).coerceAtLeast(1).toFloat()
            } else {
                READER_PROGRESS_MAX.toFloat()
            }
            stepSize = 1f
            addOnChangeListener { slider, value, fromUser ->
                if (fromUser) {
                    updateReaderProgressLabels(
                        value.roundToInt(),
                        slider.valueTo.roundToInt(),
                        if (readerProgressIsPdf) {
                            "PDF | " + getString(MR.strings.book_reader_page_label, value.roundToInt() + 1, readerProgressPageCount.coerceAtLeast(1))
                        } else {
                            "EPUB | ${epubChapterLabel(epubChapterIndexForProgress((value / READER_PROGRESS_MAX).toDouble()))}"
                        },
                        scrubbing = true,
                    )
                }
            }
            addOnSliderTouchListener(
                object : Slider.OnSliderTouchListener {
                    override fun onStartTrackingTouch(slider: Slider) = Unit

                    override fun onStopTrackingTouch(slider: Slider) {
                        if (updatingReaderProgress) return
                        val progress = slider.value.roundToInt().coerceAtLeast(0)
                        if (readerProgressIsPdf) {
                            // Dispatches to the reflow, spread or single-page surface.
                            navigatePdfTo(progress)
                        } else {
                            seekEpubToProgress(progress / READER_PROGRESS_MAX.toDouble())
                        }
                    }
                },
            )
        }
        readerProgressBar = chrome.readerNav.pageSeekbar
    }

    private fun applyBookReaderNavLayout(
        chrome: ReaderActivityBinding,
        systemInsets: androidx.core.graphics.Insets = androidx.core.graphics.Insets.NONE,
    ) {
        val localBook = book ?: return
        if (chrome.root.height <= 0) {
            // A freshly inflated chrome (every PDF mode switch) gets its insets before its first
            // layout; sizing the rail from a zero height would collapse it to the minimum.
            chrome.root.doOnLayout { if (readerBinding === chrome) applyBookReaderNavLayout(chrome, systemInsets) }
        }
        val format = if (localBook.contentType == ContentType.EPUB) "epub" else "pdf"
        val selected = format in commonReaderPreferences.bookVerticalSeekbarFormats().get()
        val availableHeight = chrome.root.height - systemInsets.top - systemInsets.bottom
        val vertical = selected && (chrome.root.height <= 0 || availableHeight > 300.dpToPx)
        val dockLeft = commonReaderPreferences.readerVerticalSeekbarDockLeft().get()
        val orientation = if (vertical) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL

        with(chrome.readerNav) {
            root.orientation = orientation
            readerSeekbar.orientation = orientation
            pageSeekbar.setOrientation(if (vertical) SliderOrientation.VERTICAL else SliderOrientation.HORIZONTAL)
            pageSeekbar.scaleY = if (vertical) -1f else 1f
            // Keep direction handling identical to the Comics chrome. Books do not have a
            // source-specific R2L viewer, so horizontal mode stays in the platform direction.
            pageSeekbar.isRTL = vertical && dockLeft
            leftChapter.rotation = if (vertical) 90f else 0f
            rightChapter.rotation = if (vertical) 90f else 0f
            readerSeekbar.updateLayoutParams<LinearLayout.LayoutParams> {
                if (vertical) {
                    width = LinearLayout.LayoutParams.WRAP_CONTENT
                    height = 0
                } else {
                    width = 0
                    height = LinearLayout.LayoutParams.WRAP_CONTENT
                }
            }
            pageSeekbar.updateLayoutParams<LinearLayout.LayoutParams> {
                if (vertical) {
                    width = 40.dpToPx
                    height = 0
                } else {
                    width = 0
                    height = 40.dpToPx
                }
            }
            root.updatePaddingRelative(
                if (vertical) 2.dpToPx else 12.dpToPx,
                if (vertical) 12.dpToPx else 6.dpToPx,
                if (vertical) 2.dpToPx else 12.dpToPx,
                if (vertical) 12.dpToPx else 6.dpToPx,
            )
            root.updateLayoutParams<FrameLayout.LayoutParams> {
                width = if (vertical) FrameLayout.LayoutParams.WRAP_CONTENT else FrameLayout.LayoutParams.MATCH_PARENT
                height = if (vertical) FrameLayout.LayoutParams.MATCH_PARENT else FrameLayout.LayoutParams.WRAP_CONTENT
            }
        }

        chrome.navLayout.updateLayoutParams<CoordinatorLayout.LayoutParams> {
            if (vertical) {
                anchorId = View.NO_ID
                anchorGravity = 0
                gravity = (if (dockLeft) Gravity.START else Gravity.END) or Gravity.CENTER_VERTICAL
                width = ViewGroup.LayoutParams.WRAP_CONTENT
                val reserved = (chrome.chaptersSheet.root.sheetBehavior?.peekHeight ?: 60.dpToPx) + 16.dpToPx
                val percent = commonReaderPreferences.readerVerticalSeekbarHeightPercent().get().coerceIn(60, 100)
                height = ((availableHeight - reserved) * percent / 100).coerceAtLeast(200.dpToPx)
                leftMargin = 8.dpToPx
                rightMargin = 8.dpToPx
                topMargin = 8.dpToPx
                bottomMargin = reserved
            } else {
                anchorId = R.id.chapters_sheet
                anchorGravity = Gravity.TOP
                gravity = Gravity.TOP
                width = ViewGroup.LayoutParams.MATCH_PARENT
                height = ViewGroup.LayoutParams.WRAP_CONTENT
                leftMargin = 6.dpToPx
                rightMargin = 6.dpToPx
                topMargin = 0
                bottomMargin = 0
            }
        }
    }

    private fun configureBookBottomSheet(chrome: ReaderActivityBinding) {
        val sheet = chrome.chaptersSheet
        chrome.chaptersSheet.root.isVisible = true
        val behavior = BottomSheetBehavior.from<View>(chrome.chaptersSheet.root)
        // ReaderChapterSheet.setup() is owned by ReaderActivity, so books must explicitly
        // initialise the same behavior contract instead of relying on the XML default. Without
        // this assignment the shared layout's peek height and expanded/collapsed state diverge.
        chrome.chaptersSheet.root.sheetBehavior = behavior
        behavior.apply {
            isHideable = false
            // The bottom HUD is a fixed navigation rail. It becomes draggable only while the
            // in-place reader settings panel is open.
            isDraggable = false
            isGestureInsetBottomIgnored = true
            peekHeight = 50.dpToPx
            state = BottomSheetBehavior.STATE_COLLAPSED
        }
        val fullSurface = getResourceColor(materialR.attr.colorSurface)
        chrome.chaptersSheet.root.backgroundTintList = ColorStateList.valueOf(
            ColorUtils.setAlphaComponent(fullSurface, 200),
        )
        chrome.chaptersSheet.root.binding.chapterRecycler.alpha = 0f
        chrome.chaptersSheet.root.binding.chapterRecycler.isClickable = false
        chrome.chaptersSheet.root.binding.chapterRecycler.isFocusable = false
        sheet.chaptersButton.apply {
            contentDescription = getString(MR.strings.book_reader_contents)
            setOnClickListener { showContentsDialog() }
        }
        // The initial rail contains the actions used most often while reading. TTS playback and
        // voice live in the settings panel's TTS tab (as on the desktop), while annotations and
        // chapter search stay one tap away here.
        sheet.webviewButton.apply {
            isVisible = true
            setImageResource(R.drawable.ic_search_24dp)
            contentDescription = getString(MR.strings.book_reader_search_in_chapter)
            compatToolTipText = getString(MR.strings.book_reader_search_in_chapter)
            setOnClickListener { showSearchDialog() }
        }
        sheet.readingMode.apply {
            isVisible = true
            setImageResource(R.drawable.ic_format_quote_24dp)
            contentDescription = getString(MR.strings.book_reader_annotations)
            compatToolTipText = getString(MR.strings.book_reader_annotations)
            setOnClickListener { showAnnotationOptionsMenu() }
        }
        sheet.rotationSheetButton.isVisible = false
        sheet.cropBordersSheetButton.isVisible = false
        sheet.doublePage.isVisible = false
        sheet.shiftPageButton.isVisible = false
        sheet.displayOptions.apply {
            isVisible = true
            setImageResource(R.drawable.ic_outline_settings_24dp)
            contentDescription = getString(MR.strings.reader_settings)
            compatToolTipText = getString(MR.strings.reader_settings)
            setOnClickListener { showReaderSettings() }
        }
    }

    private fun showTtsOptionsMenu() {
        showBookSubmenu(
            title = getString(MR.strings.book_reader_text_to_speech),
            items = listOf(
                MaterialMenuSheet.MenuSheetItem(
                    TTS_OPTION_READ,
                    R.drawable.ic_play_arrow_24dp,
                    text = getString(MR.strings.book_reader_tts_read_from_here),
                ),
                MaterialMenuSheet.MenuSheetItem(
                    TTS_OPTION_CONTROLS,
                    R.drawable.ic_settings_24dp,
                    text = getString(MR.strings.book_reader_tts_settings),
                ),
                MaterialMenuSheet.MenuSheetItem(
                    TTS_OPTION_PREVIOUS,
                    R.drawable.ic_skip_previous_24,
                    text = getString(MR.strings.book_reader_tts_previous),
                ),
                MaterialMenuSheet.MenuSheetItem(
                    TTS_OPTION_NEXT,
                    R.drawable.ic_skip_next_24,
                    text = getString(MR.strings.book_reader_tts_next),
                ),
                MaterialMenuSheet.MenuSheetItem(
                    TTS_OPTION_STOP,
                    R.drawable.ic_close_24dp,
                    text = getString(MR.strings.book_reader_tts_stop),
                ),
            ),
        ) { itemId ->
            when (itemId) {
                TTS_OPTION_READ -> speakCurrent()
                TTS_OPTION_CONTROLS -> showTtsControls()
                TTS_OPTION_PREVIOUS -> speakSegment(speechSegmentIndex - 1)
                TTS_OPTION_NEXT -> speakSegment(speechSegmentIndex + 1)
                TTS_OPTION_STOP -> stopTtsPlayback()
            }
        }
    }

    private fun showAnnotationOptionsMenu() {
        showBookSubmenu(
            title = getString(MR.strings.book_reader_annotations),
            items = listOf(
                MaterialMenuSheet.MenuSheetItem(
                    ANNOTATION_OPTION_VIEW,
                    R.drawable.ic_format_quote_24dp,
                    text = getString(MR.strings.book_reader_view_annotations),
                ),
                MaterialMenuSheet.MenuSheetItem(
                    ANNOTATION_OPTION_BOOKMARK,
                    R.drawable.ic_bookmark_24dp,
                    text = getString(MR.strings.book_reader_save_bookmark),
                ),
                MaterialMenuSheet.MenuSheetItem(
                    ANNOTATION_OPTION_HIGHLIGHT,
                    R.drawable.ic_format_quote_24dp,
                    text = getString(MR.strings.book_reader_highlight_selected_text),
                ),
            ),
        ) { itemId ->
            when (itemId) {
                ANNOTATION_OPTION_VIEW -> showAnnotationsDialog()
                ANNOTATION_OPTION_BOOKMARK -> saveBookmark()
                ANNOTATION_OPTION_HIGHLIGHT -> saveHighlight()
            }
        }
    }

    private fun showBookSubmenu(
        title: String,
        items: List<MaterialMenuSheet.MenuSheetItem>,
        onSelected: (Int) -> Unit,
    ) {
        val menu = MaterialMenuSheet(
            activity = this,
            items = items,
            title = title,
        ) { sheet, itemId ->
            // Dismiss the current level before showing the next one. This prevents two sheets from
            // competing for the same window and keeps the back gesture hierarchical.
            sheet.dismiss()
            window.decorView.post {
                if (!isFinishing && !isDestroyed) onSelected(itemId)
            }
            false
        }
        menu.show()
    }

    private fun setBookReaderMenuVisibility(visible: Boolean) {
        readerBinding?.let { chrome ->
            bookMenuVisible = visible
            val behavior = chrome.chaptersSheet.root.sheetBehavior
                ?: BottomSheetBehavior.from<View>(chrome.chaptersSheet.root).also {
                    chrome.chaptersSheet.root.sheetBehavior = it
                }

            if (visible) {
                WindowCompat.getInsetsController(window, window.decorView)
                    .show(WindowInsetsCompat.Type.systemBars())
                behavior.apply {
                    isHideable = false
                    isDraggable = false
                    state = BottomSheetBehavior.STATE_COLLAPSED
                }
            } else {
                if (bookReaderPreferences.fullscreen.get()) {
                    WindowCompat.getInsetsController(window, window.decorView)
                        .hide(WindowInsetsCompat.Type.systemBars())
                }
                behavior.apply {
                    isDraggable = false
                    isHideable = true
                    state = BottomSheetBehavior.STATE_HIDDEN
                }
            }
            chrome.appBar.isVisible = visible
            chrome.navLayout.isVisible = visible
            chrome.chaptersSheet.root.isVisible = visible
            ViewCompat.requestApplyInsets(chrome.root)
        }
    }

    private fun updateReaderProgress(value: Int, max: Int, label: String) {
        val bar = readerProgressBar ?: return
        val boundedMax = max.coerceAtLeast(1)
        val boundedValue = value.coerceIn(0, boundedMax)
        val displayLabel = if (readerProgressIsPdf) {
            BookChapterMetrics.pdfLabel(
                value,
                readerProgressPageCount,
                pdfChapterCount,
                pdfChapterStartPages,
                pdfPagesShown(),
                text = pdfLabelText(),
            )
        } else {
            label
        }
        updatingReaderProgress = true
        bar.valueTo = boundedMax.toFloat()
        bar.value = boundedValue.toFloat()
        updatingReaderProgress = false
        updateReaderProgressLabels(boundedValue, boundedMax, displayLabel)
    }

    private fun updateReaderProgressLabels(value: Int, max: Int, label: String, scrubbing: Boolean = false) {
        val chrome = readerBinding ?: return
        if (readerProgressIsPdf) {
            chrome.readerNav.leftPageText.text = (value + 1).toString()
            // Material Slider requires a non-zero range, so one-page PDFs use a logical
            // max of 1 even though the document has only page 1. The chrome must display the
            // document count, not that implementation range (otherwise it showed "1 / 2").
            chrome.readerNav.rightPageText.text = readerProgressPageCount.coerceAtLeast(1).toString()
            chrome.pageNumber.text = BookChapterMetrics.pdfLabel(
                value,
                readerProgressPageCount,
                pdfChapterCount,
                pdfChapterStartPages,
                pdfPagesShown(),
                text = pdfLabelText(),
            )
        } else {
            // While dragging only the slider value is known; otherwise use the chapter resolved
            // from the navigator locator, which is exact for chapters of different lengths.
            val chapterIndex = if (scrubbing) {
                epubChapterIndexForProgress((value.toFloat() / max.coerceAtLeast(1)).toDouble())
            } else {
                epubChapterIndex.coerceIn(0, (epubChapterCount - 1).coerceAtLeast(0))
            }
            chrome.readerNav.leftPageText.text = (chapterIndex + 1).toString()
            chrome.readerNav.rightPageText.text = epubChapterCount.coerceAtLeast(1).toString()
            chrome.pageNumber.text = getString(MR.strings.local_book_chapter_progress, chapterIndex + 1, epubChapterCount.coerceAtLeast(1))
        }
        chrome.pageNumber.isVisible = bookReaderPreferences.showPageNumber.get()
        chrome.toolbar.subtitle = label
    }

    private fun navigateReader(delta: Int) {
        when {
            readerProgressIsPdf -> {
                val pageCount = readerProgressPageCount.coerceAtLeast(1)
                val current = pdfCurrentPage
                // Reflow wins over the spread: both preferences may be on at once.
                val reflowing = pdfReflowTextView != null
                val spread = !reflowing && pdfSpreadPrimaryView != null
                val step = if (spread) 2 else 1
                val target = (current + delta * step).coerceIn(0, pageCount - 1)
                when {
                    reflowing -> navigatePdfReflowTo(target)
                    spread -> navigatePdfSpreadTo(target)
                    else -> navigatePdfTo(target)
                }
            }

            else -> {
                val localBook = book ?: return
                val lastChapter = (epubChapterCount - 1).coerceAtLeast(0)
                val targetChapter = (epubChapterIndex + delta).coerceIn(0, lastChapter)
                if (targetChapter == epubChapterIndex && delta != 0) return
                val global = if (lastChapter == 0) {
                    if (delta < 0) 0.0 else 1.0
                } else {
                    targetChapter.toDouble() / lastChapter.toDouble()
                }
                navigateEpubTo(
                    ReaderLocator.Epub(
                        entityId = localBook.document().entityId,
                        cfi = "aethon-spine:$targetChapter",
                        progression = global,
                    ),
                )
            }
        }
    }

    private fun seekEpubToProgress(progress: Double) {
        val localBook = book ?: return
        val lastChapter = (epubChapterCount - 1).coerceAtLeast(0)
        val bounded = progress.coerceIn(0.0, 1.0)
        val scaled = bounded * lastChapter
        val chapter = scaled.toInt().coerceIn(0, lastChapter)
        navigateEpubTo(
            ReaderLocator.Epub(
                entityId = localBook.document().entityId,
                cfi = "aethon-spine:$chapter",
                progression = bounded,
            ),
        )
    }

    /** Moves the single-page surface through the already-open Pdfium session. */
    private fun navigatePdfTo(page: Int) {
        val localBook = book ?: return
        val reader = opened as? OpenedBookReader.Pdf ?: return
        if (pdfReflowTextView != null) {
            navigatePdfReflowTo(page)
            return
        }
        if (pdfSpreadPrimaryView != null) {
            navigatePdfSpreadTo(page)
            return
        }
        val target = page.coerceIn(0, (readerProgressPageCount - 1).coerceAtLeast(0))
        pdfCurrentPage = target
        val view = pdfView ?: return
        renderPdfPage(localBook, reader, view, target)
        val locator = pdfLocator(reader.document.entityId, target)
        latestReaderLocator = locator
        updateReaderProgress(
            value = target,
            max = (readerProgressPageCount - 1).coerceAtLeast(1),
            label = getString(MR.strings.book_reader_page_label, target + 1, readerProgressPageCount.coerceAtLeast(1)),
        )
    }

    private fun navigatePdfReflowTo(page: Int) {
        val localBook = book ?: return
        val reader = opened as? OpenedBookReader.Pdf ?: return
        val target = page.coerceIn(0, (readerProgressPageCount - 1).coerceAtLeast(0))
        pdfCurrentPage = target
        val locator = pdfLocator(reader.document.entityId, target)
        latestReaderLocator = locator
        lifecycleScope.launch(Dispatchers.IO) {
            runCatching { reader.session.navigateTo(locator) }
            // ReaderLocator.entityId is content-addressed and intentionally differs from the
            // database key used by LocalBookRepository. Persist by the local book ID so reflow
            // navigation resumes correctly after the process is recreated.
            persistProgress(localBook, locator)
        }
        updateReaderProgress(
            value = target,
            max = (readerProgressPageCount - 1).coerceAtLeast(1),
            label = getString(MR.strings.book_reader_page_label, target + 1, readerProgressPageCount.coerceAtLeast(1)),
        )
        renderPdfReflowPage(reader, target)
    }

    private fun navigatePdfSpreadTo(page: Int) {
        val localBook = book ?: return
        val primary = pdfSpreadPrimaryView ?: return
        val secondary = pdfSpreadSecondaryView ?: return
        val reader = opened as? OpenedBookReader.Pdf ?: return
        val target = pdfSpreadStart(page)
        pdfCurrentPage = target
        loadPdfSpreadPages(localBook, reader, primary, secondary, target)
        val locator = pdfLocator(localBook.document().entityId, target)
        latestReaderLocator = locator
        lifecycleScope.launch(Dispatchers.IO) { persistProgress(localBook, locator) }
        updateReaderProgress(
            value = target,
            max = (readerProgressPageCount - 1).coerceAtLeast(1),
            label = getString(MR.strings.book_reader_pages_label, target + 1, (target + 2).coerceAtMost(readerProgressPageCount), readerProgressPageCount),
        )
    }

    private fun pdfLocator(
        entityId: EpigraphEntityId,
        pageIndex: Int,
        pageOffset: Double = 0.0,
        characterOffset: Int? = null,
    ): ReaderLocator.Pdf = ReaderLocator.Pdf(
        entityId = entityId,
        pageIndex = pageIndex.coerceIn(0, (readerProgressPageCount - 1).coerceAtLeast(0)),
        pageOffset = pageOffset,
        characterOffset = characterOffset,
    ).withDocumentMetrics(readerProgressPageCount.coerceAtLeast(1))

    private fun showPdfTextSelectionDialog(onlyPage: Int? = null) {
        val reader = opened as? OpenedBookReader.Pdf ?: return
        val first = pdfCurrentPage.coerceAtLeast(0)
        // A spread shows two pages, so both can be selected from unless one page was pressed.
        val pages = onlyPage?.let { it..it }
            ?: (first until min(first + pdfPagesShown(), readerProgressPageCount.coerceAtLeast(first + 1)))
        lifecycleScope.launch {
            var ocrNoticeShown = false
            val pageTexts = withContext(Dispatchers.IO) {
                pages.map { page ->
                    // OCR takes seconds on a slow device; say so instead of looking unresponsive.
                    page to extractPdfText(reader, page) {
                        if (!ocrNoticeShown) {
                            ocrNoticeShown = true
                            withContext(Dispatchers.Main) { showMessage(getString(MR.strings.book_reader_pdf_reading_text)) }
                        }
                    }
                }.filter { (_, text) -> text.isNotBlank() }
            }
            if (pageTexts.isEmpty()) {
                showMessage(getString(MR.strings.book_reader_pdf_no_text))
                return@launch
            }
            val segments = PdfSelectionSegments(pageTexts)
            val text = segments.text
            fun saveSelection(start: Int, end: Int) {
                val selection = segments.resolve(start, end)
                if (selection == null) {
                    showMessage(getString(MR.strings.book_reader_select_text_first))
                    return
                }
                savePdfHighlight(selection.page, selection.start, selection.end, selection.text)
            }
            val selection = TextView(this@LocalBookReaderActivity).apply {
                setText(text)
                setTextIsSelectable(true)
                setPadding(24.dpToPx, 16.dpToPx, 24.dpToPx, 16.dpToPx)
                installTextSelectionActions(this) { selected ->
                    saveSelection(selected.first, selected.second)
                }
            }
            this@LocalBookReaderActivity.materialAlertDialog()
                .setTitle(getString(MR.strings.book_reader_select_text_title))
                .setView(selection)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(getString(MR.strings.book_reader_highlight_selection)) { _, _ ->
                    val start = min(selection.selectionStart, selection.selectionEnd)
                    val end = max(selection.selectionStart, selection.selectionEnd)
                    saveSelection(start, end)
                }
                .show()
        }
    }

    /** Extract native PDF text first, then OCR the rendered page when the document is scanned. */
    private suspend fun extractPdfText(
        reader: OpenedBookReader.Pdf,
        page: Int,
        onOcrStart: suspend () -> Unit = {},
    ): String {
        val safePage = page.coerceAtLeast(0)
        val locator = ReaderLocator.Pdf(reader.document.entityId, safePage)
        val native = runCatching {
            reader.session.extractText(ReaderRange(locator, locator))
        }.getOrDefault("").trim()
        if (native.isNotBlank()) return native

        val renderer = reader.session as? PdfPageBitmapRenderer ?: return ""
        val bitmap = renderer.renderPageBitmap(safePage) ?: return ""
        return try {
            onOcrStart()
            pdfOcrEngine.recognize(bitmap).trim()
        } catch (_: Throwable) {
            ""
        } finally {
            bitmap.recycle()
        }
    }

    private fun showSearchDialog() {
        val input = EditText(this).apply {
            hint = getString(MR.strings.book_reader_search_hint)
            setSingleLine(true)
        }
        materialAlertDialog()
            .setTitle(getString(MR.strings.search))
            .setView(input)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(getString(MR.strings.search)) { _, _ ->
                performSearch(input.text.toString())
            }
            .show()
    }

    private fun performSearch(query: String) {
        val normalized = query.trim()
        if (normalized.isEmpty()) return
        lifecycleScope.launch {
            when (val current = opened) {
                is OpenedBookReader.Pdf -> {
                    val results = withContext(Dispatchers.IO) { current.session.search(normalized) }
                    if (results.isEmpty()) {
                        showMessage(getString(MR.strings.book_reader_no_results))
                    } else {
                        showReaderChoices(
                            title = getString(MR.strings.book_reader_search_results),
                            labels = results.take(MAX_DIALOG_RESULTS).map { result ->
                                getString(MR.strings.book_reader_search_result_page, result.locator.pageIndex + 1, result.excerpt)
                            },
                        ) { index ->
                            results.getOrNull(index)?.let { result ->
                                if (pdfView != null) {
                                    navigatePdfTo(result.locator.pageIndex)
                                } else {
                                    navigatePdfReflowTo(result.locator.pageIndex)
                                }
                            }
                        }
                    }
                }

                is OpenedBookReader.Epub -> {
                    val results = withContext(Dispatchers.IO) { current.session.search(normalized) }
                    if (results.isEmpty()) {
                        showMessage(getString(MR.strings.book_reader_no_results))
                    } else {
                        showReaderChoices(
                            title = getString(MR.strings.book_reader_search_results),
                            labels = results.take(MAX_DIALOG_RESULTS).map { result -> result.excerpt },
                        ) { index ->
                            results.getOrNull(index)?.let { result ->
                                navigateEpubTo(result.locator)
                            }
                        }
                    }
                }

                null -> Unit
            }
        }
    }

    private fun showContentsDialog() {
        lifecycleScope.launch {
            when (val current = opened) {
                is OpenedBookReader.Pdf -> {
                    val entries = withContext(Dispatchers.IO) { current.session.tableOfContents() }
                    val flattened = mutableListOf<Pair<String, ReaderLocator.Pdf>>()
                    flattenPdfToc(entries, 0, flattened)
                    if (flattened.isEmpty()) {
                        showMessage(getString(MR.strings.book_reader_pdf_no_toc))
                    } else {
                        showReaderChoices(getString(MR.strings.book_reader_contents), flattened.map { it.first }) { index ->
                            flattened.getOrNull(index)?.second?.let { locator ->
                                if (pdfView != null) {
                                    navigatePdfTo(locator.pageIndex)
                                } else {
                                    navigatePdfReflowTo(locator.pageIndex)
                                }
                            }
                        }
                    }
                }

                is OpenedBookReader.Epub -> {
                    val entries = withContext(Dispatchers.IO) { current.session.tableOfContents() }
                    val flattened = mutableListOf<Pair<String, ReaderLocator.Epub>>()
                    flattenEpubToc(entries, 0, flattened)
                    if (flattened.isEmpty()) {
                        showMessage(getString(MR.strings.book_reader_epub_no_toc))
                    } else {
                        showReaderChoices(getString(MR.strings.book_reader_contents), flattened.map { it.first }) { index ->
                            flattened.getOrNull(index)?.second?.let { locator ->
                                navigateEpubTo(locator)
                            }
                        }
                    }
                }

                null -> Unit
            }
        }
    }

    private suspend fun renderPersistedHighlights(
        reader: OpenedBookReader,
        highlights: List<BookHighlight>,
    ) {
        when (reader) {
            is OpenedBookReader.Pdf -> {
                reader.session.renderHighlights(
                    highlights.mapNotNull { highlight ->
                        val start = highlight.start as? ReaderLocator.Pdf ?: return@mapNotNull null
                        val end = highlight.end as? ReaderLocator.Pdf ?: return@mapNotNull null
                        ReaderHighlight(
                            id = highlight.highlightId,
                            range = ReaderRange(start, end),
                            colorArgb = highlight.colorArgb,
                        )
                    },
                )
            }

            is OpenedBookReader.Epub -> {
                reader.session.renderHighlights(
                    highlights.mapNotNull { highlight ->
                        val start = highlight.start as? ReaderLocator.Epub ?: return@mapNotNull null
                        val end = highlight.end as? ReaderLocator.Epub ?: return@mapNotNull null
                        ReaderHighlight(
                            id = highlight.highlightId,
                            range = ReaderRange(start, end),
                            colorArgb = highlight.colorArgb,
                        )
                    },
                )
            }
        }
    }

    private fun showAnnotationsDialog() {
        lifecycleScope.launch {
            val localBook = book ?: return@launch
            val (bookmarks, highlights) = withContext(Dispatchers.IO) {
                repository.getBookmarks(localBook.bookId) to repository.getHighlights(localBook.bookId)
            }
            if (bookmarks.isEmpty() && highlights.isEmpty()) {
                showMessage(getString(MR.strings.book_reader_no_annotations))
                return@launch
            }

            when (val current = opened) {
                is OpenedBookReader.Pdf -> {
                    val targets = buildList<Pair<String, ReaderLocator.Pdf>> {
                        bookmarks.forEach { bookmark ->
                            (bookmark.locator as? ReaderLocator.Pdf)?.let { locator ->
                                add(getString(MR.strings.book_reader_bookmark_entry, bookmark.label ?: getString(MR.strings.book_reader_page_n, locator.pageIndex + 1)) to locator)
                            }
                        }
                        highlights.forEach { highlight ->
                            (highlight.start as? ReaderLocator.Pdf)?.let { locator ->
                                add(getString(MR.strings.book_reader_highlight_entry, highlight.selectedText.take(MAX_ANNOTATION_TEXT)) to locator)
                            }
                        }
                    }
                    showReaderChoices(getString(MR.strings.book_reader_annotations), targets.map { it.first }) { index ->
                        targets.getOrNull(index)?.second?.let { locator ->
                            if (pdfView != null) {
                                navigatePdfTo(locator.pageIndex)
                            } else {
                                navigatePdfReflowTo(locator.pageIndex)
                            }
                        }
                    }
                }

                is OpenedBookReader.Epub -> {
                    val targets = buildList<Pair<String, ReaderLocator.Epub>> {
                        bookmarks.forEach { bookmark ->
                            (bookmark.locator as? ReaderLocator.Epub)?.let { locator ->
                                add(getString(MR.strings.book_reader_bookmark_entry, bookmark.label ?: getString(MR.strings.book_reader_position)) to locator)
                            }
                        }
                        highlights.forEach { highlight ->
                            (highlight.start as? ReaderLocator.Epub)?.let { locator ->
                                add(getString(MR.strings.book_reader_highlight_entry, highlight.selectedText.take(MAX_ANNOTATION_TEXT)) to locator)
                            }
                        }
                    }
                    showReaderChoices(getString(MR.strings.book_reader_annotations), targets.map { it.first }) { index ->
                        targets.getOrNull(index)?.second?.let { locator ->
                            navigateEpubTo(locator)
                        }
                    }
                }

                null -> Unit
            }
        }
    }

    private fun flattenPdfToc(
        entries: List<ReaderTocEntry<ReaderLocator.Pdf>>,
        depth: Int,
        target: MutableList<Pair<String, ReaderLocator.Pdf>>,
    ) {
        entries.forEach { entry ->
            target += ("  ".repeat(depth) + entry.title) to entry.locator
            flattenPdfToc(entry.children, depth + 1, target)
        }
    }

    private fun flattenEpubToc(
        entries: List<ReaderTocEntry<ReaderLocator.Epub>>,
        depth: Int,
        target: MutableList<Pair<String, ReaderLocator.Epub>>,
    ) {
        entries.forEach { entry ->
            target += ("  ".repeat(depth) + entry.title) to entry.locator
            flattenEpubToc(entry.children, depth + 1, target)
        }
    }

    private fun showReaderChoices(
        title: String,
        labels: List<String>,
        onSelected: (Int) -> Unit,
    ) {
        materialAlertDialog()
            .setTitle(title)
            .setItems(labels.toTypedArray()) { _, index -> onSelected(index) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun saveBookmark() {
        val localBook = book ?: return
        lifecycleScope.launch {
            val locator = withContext(Dispatchers.IO) {
                when (val current = opened) {
                    is OpenedBookReader.Pdf -> current.session.currentLocator()
                    is OpenedBookReader.Epub -> current.session.currentLocator()
                    null -> null
                }
            } ?: return@launch
            val now = System.currentTimeMillis()
            runCatching {
                withContext(Dispatchers.IO) {
                    repository.addBookmark(
                        BookBookmark(
                            bookmarkId = UUID.randomUUID().toString(),
                            bookId = localBook.bookId,
                            locator = locator,
                            label = localBook.displayName,
                            createdAt = now,
                            updatedAt = now,
                        ),
                    )
                }
            }.onSuccess { showMessage(getString(MR.strings.book_reader_bookmark_saved)) }
                .onFailure { showMessage(it.message ?: getString(MR.strings.book_reader_bookmark_failed)) }
        }
    }

    /**
     * Highlight straight from the EPUB selection toolbar: a tap on the page to reach the HUD
     * would clear the WebView selection first.
     */
    private val epubSelectionActionModeCallback = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            menu.add(Menu.NONE, MENU_HIGHLIGHT_SELECTION, Menu.NONE, getString(MR.strings.book_reader_highlight))
                .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            if (item.itemId != MENU_HIGHLIGHT_SELECTION) return false
            // Finish only after Readium has read the selection, which finishing would clear.
            captureEpubSelectionAndSave(onDone = mode::finish)
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) = Unit
    }

    private fun captureEpubSelectionAndSave(onDone: () -> Unit = {}) {
        val navigator = epubNavigator ?: return onDone()
        val session = epubSession ?: return onDone()
        val localBook = book ?: return onDone()
        lifecycleScope.launch {
            try {
                saveEpubSelection(navigator, session, localBook)
                // Drop the WebView selection so the new highlight shows instead of the handles.
                runCatching { navigator.clearSelection() }
            } finally {
                onDone()
            }
        }
    }

    private suspend fun saveEpubSelection(
        navigator: EpubNavigatorFragment,
        session: EpubNavigatorSession,
        localBook: LocalBook,
    ) {
        val selection = runCatching { navigator.currentSelection() }.getOrNull()
        val readiumLocator = selection?.locator
        val text = readiumLocator?.text?.highlight
            ?.replace(Regex("\\s+"), " ")
            ?.trim()
            ?.take(MAX_HIGHLIGHT_TEXT)
            .orEmpty()
        if (readiumLocator == null || text.isBlank()) {
            showMessage(getString(MR.strings.book_reader_select_text_first))
            return
        }
        val appLocator = session.toReaderLocator(readiumLocator)
        val now = System.currentTimeMillis()
        runCatching {
            withContext(Dispatchers.IO) {
                repository.addHighlight(
                    BookHighlight(
                        highlightId = UUID.randomUUID().toString(),
                        bookId = localBook.bookId,
                        start = appLocator,
                        end = appLocator,
                        selectedText = text,
                        colorArgb = DEFAULT_HIGHLIGHT_COLOR,
                        createdAt = now,
                        updatedAt = now,
                    ),
                )
                activeHighlights = repository.getHighlights(localBook.bookId)
                opened?.let { renderPersistedHighlights(it, activeHighlights) }
            }
            applyEpubHighlights()
        }.onSuccess { showMessage(getString(MR.strings.book_reader_highlight_saved)) }
            .onFailure { showMessage(it.message ?: getString(MR.strings.book_reader_highlight_failed)) }
    }

    private fun saveHighlight() {
        if (epubNavigator != null) {
            captureEpubSelectionAndSave()
            return
        }
        if (pdfReflowTextView != null) {
            val selection = pdfReflowTextView ?: return
            val start = min(selection.selectionStart, selection.selectionEnd)
            val end = max(selection.selectionStart, selection.selectionEnd)
            if (start >= 0 && end > start) {
                savePdfHighlight(pdfCurrentPage, start, end, selection.text.substring(start, end))
            } else {
                showPdfTextSelectionDialog()
            }
            return
        }
        // Original-page modes (continuous or two pages) select from the page's text, OCR included.
        if (pdfView != null || pdfSpreadPrimaryView != null) {
            showPdfTextSelectionDialog()
            return
        }
        val localBook = book ?: return
        lifecycleScope.launch {
            val current = opened ?: return@launch
            val snapshot = runCatching {
                withContext(Dispatchers.IO) {
                    when (current) {
                        is OpenedBookReader.Pdf -> {
                            val locator = current.session.currentLocator()
                            locator to extractPdfText(current, locator.pageIndex)
                        }

                        is OpenedBookReader.Epub -> {
                            val locator = epubLocator ?: current.session.currentLocator()
                            locator to Html.fromHtml(
                                current.session.extractText(ReaderRange(locator, locator)),
                                Html.FROM_HTML_MODE_LEGACY,
                            ).toString()
                        }
                    }
                }
            }.getOrNull() ?: return@launch
            val selectedText = snapshot.second.replace(Regex("\\s+"), " ").trim()
                .take(MAX_HIGHLIGHT_TEXT)
            if (selectedText.isBlank()) {
                showMessage(getString(MR.strings.book_reader_no_text_here))
                return@launch
            }
            val now = System.currentTimeMillis()
            runCatching {
                withContext(Dispatchers.IO) {
                    repository.addHighlight(
                        BookHighlight(
                            highlightId = UUID.randomUUID().toString(),
                            bookId = localBook.bookId,
                            start = snapshot.first,
                            end = snapshot.first,
                            selectedText = selectedText,
                            colorArgb = DEFAULT_HIGHLIGHT_COLOR,
                            createdAt = now,
                            updatedAt = now,
                        ),
                    )
                    activeHighlights = repository.getHighlights(localBook.bookId)
                    renderPersistedHighlights(current, activeHighlights)
                }
            }.onSuccess { showMessage(getString(MR.strings.book_reader_highlight_saved)) }
                .onFailure { showMessage(it.message ?: getString(MR.strings.book_reader_highlight_failed)) }
        }
    }

    private fun speakCurrent() {
        lifecycleScope.launch {
            val localBook = book ?: return@launch
            val text = runCatching {
                withContext(Dispatchers.IO) {
                    when (val current = opened) {
                        is OpenedBookReader.Pdf -> {
                            val locator = current.session.currentLocator()
                            extractPdfText(current, locator.pageIndex)
                        }

                        is OpenedBookReader.Epub -> {
                            val locator = epubLocator ?: current.session.currentLocator()
                            Html.fromHtml(
                                current.session.extractText(ReaderRange(locator, locator)),
                                Html.FROM_HTML_MODE_LEGACY,
                            ).toString()
                        }

                        null -> ""
                    }
                }
            }.getOrDefault("").trim()
            if (text.isEmpty()) {
                showMessage(getString(MR.strings.book_reader_no_readable_text_here))
            } else {
                currentSpeechText = text
                speechSegments = text
                    .split(Regex("\\n\\s*\\n|(?<=[.!?])\\s+(?=[A-ZÁÉÍÓÚÀ-Ú])"))
                    .map { it.trim() }
                    .filter { it.isNotBlank() }
                    .ifEmpty { listOf(text) }
                speechSegmentIndex = 0
                pendingSpeech = speechSegments.firstOrNull() ?: text
                BookTtsPlaybackService.start(
                    context = this@LocalBookReaderActivity,
                    title = localBook.displayName,
                    bookId = localBook.bookId,
                    text = text,
                    rate = speechRate,
                    pitch = speechPitch,
                    voice = speechVoiceName,
                )
            }
        }
    }

    private fun ensureTextToSpeech() {
        if (textToSpeechReady) {
            speakPendingText()
            return
        }
        if (textToSpeech != null) return
        runCatching {
            textToSpeech = TextToSpeech(applicationContext) { status ->
                runOnUiThread {
                    textToSpeechReady = status == TextToSpeech.SUCCESS
                    if (textToSpeechReady) speakPendingText()
                    else showMessage(getString(MR.strings.book_reader_tts_unavailable))
                }
            }
        }.onFailure {
            showMessage(getString(MR.strings.book_reader_tts_unavailable))
        }
    }

    private fun speakPendingText() {
        val engine = textToSpeech ?: return
        val text = pendingSpeech ?: return
        pendingSpeech = null
        engine.language = Locale.getDefault()
        engine.setSpeechRate(speechRate)
        engine.setPitch(speechPitch)
        speechVoiceName?.let { voiceName ->
            engine.voices?.firstOrNull { it.name == voiceName }?.let { engine.voice = it }
        }
        val maxChunk = TextToSpeech.getMaxSpeechInputLength().coerceAtLeast(1_000)
        text.chunked(maxChunk).forEachIndexed { index, chunk ->
            engine.speak(
                chunk,
                if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD,
                null,
                "epigraph-book-${System.currentTimeMillis()}-$index",
            )
        }
    }

    private var currentSpeechText: String? = null

    internal fun availableTtsVoiceNames(): List<String> = textToSpeech?.voices
        ?.asSequence()
        ?.filter { it.locale.language == Locale.getDefault().language }
        ?.map { it.name }
        ?.distinct()
        ?.sorted()
        ?.take(MAX_VOICE_OPTIONS)
        ?.toList()
        .orEmpty()

    private fun stopTtsPlayback() {
        textToSpeech?.stop()
        pendingSpeech = null
        BookTtsPlaybackService.stop(this)
    }

    /** Read from the current position when idle, otherwise pause or resume the running session. */
    internal fun toggleBookTts() {
        if (BookTtsPlaybackService.playbackState.value == BookTtsPlaybackService.PlaybackState.STOPPED) {
            speakCurrent()
        } else {
            BookTtsPlaybackService.togglePause(this)
        }
    }

    internal fun stopBookTts() = stopTtsPlayback()

    internal fun skipBookTts(forward: Boolean) = BookTtsPlaybackService.skip(this, forward)

    private fun showTtsControls() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24.dpToPx, 8.dpToPx, 24.dpToPx, 0)
        }
        val rates = floatArrayOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f, 2.5f)
        addTtsSettingRow(container, getString(MR.strings.book_reader_tts_rate), "${speechRate}x", rates.map { "${it}x" }) { label ->
            speechRate = label.removeSuffix("x").toFloatOrNull() ?: speechRate
            readerPreferences().edit().putFloat(KEY_TTS_RATE, speechRate).apply()
            textToSpeech?.setSpeechRate(speechRate)
            BookTtsPlaybackService.updateSettings(this, speechRate, speechPitch, speechVoiceName)
        }
        val pitches = floatArrayOf(0.75f, 1.0f, 1.25f, 1.5f)
        addTtsSettingRow(container, getString(MR.strings.book_reader_tts_pitch), formatDecimal(speechPitch), pitches.map { formatDecimal(it) }) { label ->
            speechPitch = label.toFloatOrNull() ?: speechPitch
            readerPreferences().edit().putFloat(KEY_TTS_PITCH, speechPitch).apply()
            textToSpeech?.setPitch(speechPitch)
            BookTtsPlaybackService.updateSettings(this, speechRate, speechPitch, speechVoiceName)
        }
        val availableVoices = textToSpeech?.voices
            ?.asSequence()
            ?.filter { it.locale.language == Locale.getDefault().language }
            ?.map { it.name }
            ?.distinct()
            ?.sorted()
            ?.take(MAX_VOICE_OPTIONS)
            ?.toList()
            .orEmpty()
        if (availableVoices.isNotEmpty()) {
            addTtsSettingRow(
                container,
                getString(MR.strings.book_reader_tts_voice),
                speechVoiceName ?: getString(MR.strings.system_default),
                listOf(getString(MR.strings.system_default)) + availableVoices,
            ) { label ->
                speechVoiceName = label.takeUnless { it == getString(MR.strings.system_default) }
                readerPreferences().edit().putString(KEY_TTS_VOICE, speechVoiceName).apply()
                textToSpeech?.voices?.firstOrNull { it.name == speechVoiceName }?.let { textToSpeech?.voice = it }
                BookTtsPlaybackService.updateSettings(this, speechRate, speechPitch, speechVoiceName)
            }
        } else {
            container.addView(TextView(this).apply { text = getString(MR.strings.book_reader_tts_voices_pending) })
        }
        val segmentRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        segmentRow.addView(MaterialButton(this).apply {
            text = getString(MR.strings.book_reader_tts_previous)
            setOnClickListener { speakSegment(speechSegmentIndex - 1) }
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        segmentRow.addView(MaterialButton(this).apply {
            text = getString(MR.strings.book_reader_tts_next)
            setOnClickListener { speakSegment(speechSegmentIndex + 1) }
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        container.addView(segmentRow)
        materialAlertDialog()
            .setTitle(getString(MR.strings.book_reader_text_to_speech))
            .setView(container)
            .setNegativeButton(getString(MR.strings.stop)) { _, _ ->
                stopTtsPlayback()
            }
            .setPositiveButton(getString(MR.strings.book_reader_tts_read_current)) { _, _ -> speakCurrent() }
            .setNeutralButton(android.R.string.ok, null)
            .show()
    }

    private fun addTtsSettingRow(
        container: LinearLayout,
        label: String,
        selected: String,
        options: List<String>,
        onSelected: (String) -> Unit,
    ) {
        var currentValue = selected
        val button = MaterialButton(this).apply {
            text = "$label: $currentValue"
            setOnClickListener {
                this@LocalBookReaderActivity.materialAlertDialog()
                    .setTitle(label)
                    .setSingleChoiceItems(options.toTypedArray(), options.indexOf(currentValue).coerceAtLeast(0)) { dialog, which ->
                        options.getOrNull(which)?.let { value ->
                            currentValue = value
                            onSelected(value)
                            text = "$label: $value"
                        }
                        dialog.dismiss()
                    }
                    .setNegativeButton(android.R.string.cancel, null)
                    .show()
            }
        }
        container.addView(button, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            topMargin = 4.dpToPx
            bottomMargin = 4.dpToPx
        })
    }

    private fun speakSegment(index: Int) {
        val segment = speechSegments.getOrNull(index) ?: return
        speechSegmentIndex = index
        currentSpeechText = speechSegments.joinToString("\n\n")
        pendingSpeech = segment
        val localBook = book ?: return
        BookTtsPlaybackService.start(
            context = this,
            title = localBook.displayName,
            bookId = localBook.bookId,
            text = segment,
            rate = speechRate,
            pitch = speechPitch,
            voice = speechVoiceName,
        )
    }

    private fun showReaderSettings() {
        val localBook = book ?: return
        val chrome = readerBinding ?: return
        if (readerSettingsPanel != null) return

        val root = chrome.chaptersSheet.root
        val behavior = BottomSheetBehavior.from(root)
        readerSettingsRootHeight = root.layoutParams.height.takeIf { it > 0 } ?: root.height
        readerSettingsTopbarHeight = chrome.chaptersSheet.topbarLayout.layoutParams.height
            .takeIf { it > 0 }

        val panel = LocalBookReaderSettingsPanel(
            context = this,
            activity = this,
            contentType = localBook.contentType,
            bookPreferences = bookReaderPreferences,
            commonPreferences = commonReaderPreferences,
            onChanged = ::applyBookReaderSettings,
            onResetDefaults = ::confirmResetReaderSettings,
        )
        readerSettingsPanel = panel

        // Keep the existing reader sheet and its drag handle. The chapter list is hidden while
        // settings are mounted below the same top bar, so this is one expanding surface rather
        // than a dialog layered over the reader.
        chrome.chaptersSheet.root.binding.chapterRecycler.isVisible = false
        // The chapter sheet's action row is intentionally empty while Settings is mounted. Keep
        // only its drag handle instead of reserving the full action-bar height above the tabs.
        chrome.chaptersSheet.topbarLayout.updateLayoutParams<ViewGroup.LayoutParams> {
            height = 20.dpToPx
        }
        root.backgroundTintList = ColorStateList.valueOf(
            ReaderThemeColors.book(
                this,
                if (usesTextTheme(localBook)) bookReaderPreferences.epubTheme.get() else "light",
            ).surface,
        )
        chrome.chaptersSheet.apply {
            chaptersButton.isVisible = false
            webviewButton.isVisible = false
            readingMode.isVisible = false
            rotationSheetButton.isVisible = false
            cropBordersSheetButton.isVisible = false
            doublePage.isVisible = false
            shiftPageButton.isVisible = false
            displayOptions.isVisible = false
        }
        // The progress/navigation rail belongs to the reader HUD, not to settings. Keeping it
        // above the sheet would make the controls appear to bleed through the settings pages.
        chrome.navLayout.isVisible = false
        root.addView(
            panel,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        root.updateLayoutParams<ViewGroup.LayoutParams> {
            // The embedded panel measures its selected tab.  A long tab is capped and scrolls;
            // a short tab should not leave a full-screen blank sheet over the book.
            height = ViewGroup.LayoutParams.WRAP_CONTENT
        }

        behavior.isHideable = false
        behavior.isDraggable = true
        readerSettingsCallback = object : BottomSheetBehavior.BottomSheetCallback() {
            override fun onSlide(bottomSheet: View, slideOffset: Float) = Unit

            override fun onStateChanged(bottomSheet: View, newState: Int) {
                if (newState == BottomSheetBehavior.STATE_COLLAPSED ||
                    newState == BottomSheetBehavior.STATE_HIDDEN
                ) {
                    closeReaderSettingsPanel()
                }
            }
        }.also(behavior::addBottomSheetCallback)

        root.post {
            if (readerSettingsPanel === panel && !isFinishing && !isDestroyed) {
                behavior.state = BottomSheetBehavior.STATE_EXPANDED
            }
        }
    }

    private fun confirmResetReaderSettings() {
        materialAlertDialog()
            .setTitle(R.string.epigraph_reader_reset_defaults_title)
            .setMessage(R.string.epigraph_reader_reset_defaults_message)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.epigraph_reader_reset_defaults) { _, _ ->
                resetReaderSettingsToDefaults()
            }
            .show()
    }

    /** Closes the embedded settings surface and restores the fixed reader HUD. */
    internal fun closeReaderSettingsPanel() {
        val panel = readerSettingsPanel ?: return
        val chrome = readerBinding
        val root = chrome?.chaptersSheet?.root
        val behavior = root?.let { BottomSheetBehavior.from(it) }
        readerSettingsCallback?.let { callback -> behavior?.removeBottomSheetCallback(callback) }
        readerSettingsCallback = null

        root?.removeView(panel)
        root?.backgroundTintList = ColorStateList.valueOf(
            ReaderThemeColors.book(
                this,
                if (usesTextTheme()) bookReaderPreferences.epubTheme.get() else "light",
            ).surface,
        )
        chrome?.chaptersSheet?.root?.binding?.chapterRecycler?.apply {
            isVisible = true
            alpha = 0f
            isClickable = false
            isFocusable = false
        }
        chrome?.chaptersSheet?.apply {
            chaptersButton.isVisible = true
            webviewButton.isVisible = true
            readingMode.isVisible = true
            rotationSheetButton.isVisible = false
            cropBordersSheetButton.isVisible = false
            doublePage.isVisible = false
            shiftPageButton.isVisible = false
            displayOptions.isVisible = true
        }
        chrome?.chaptersSheet?.topbarLayout?.updateLayoutParams<ViewGroup.LayoutParams> {
            height = readerSettingsTopbarHeight?.takeIf { it > 0 } ?: 56.dpToPx
        }
        chrome?.navLayout?.isVisible = true

        root?.updateLayoutParams<ViewGroup.LayoutParams> {
            height = readerSettingsRootHeight?.takeIf { it > 0 } ?: 280.dpToPx
        }
        applyBookChromeTheme()
        readerSettingsRootHeight = null
        readerSettingsTopbarHeight = null
        readerSettingsPanel = null
        behavior?.apply {
            isHideable = false
            isDraggable = false
            state = BottomSheetBehavior.STATE_COLLAPSED
        }
    }

    private fun reloadPdf() {
        val localBook = book ?: return
        val reader = opened as? OpenedBookReader.Pdf ?: return
        if (pdfReflow) {
            lifecycleScope.launch {
                showPdfReflow(
                    localBook,
                    reader,
                    ReaderLocator.Pdf(reader.document.entityId, pdfCurrentPage),
                )
            }
            return
        }
        if (pdfTwoPage) {
            lifecycleScope.launch {
                showPdfSpread(
                    localBook,
                    reader,
                    ReaderLocator.Pdf(reader.document.entityId, pdfCurrentPage),
                )
            }
            return
        }
        readerProgressIsPdf = true
        val currentPage = pdfCurrentPage
        pdfCurrentPage = currentPage
        pdfReflowTextView = null
        clearPdfSpread()
        pdfView?.recycle()
        pdfSecondaryView?.recycle()
        pdfSecondaryView = null
        val view = PdfPageView(this)
        pdfView = view
        view.setReaderOptions(pdfFitMode, pdfNightMode, pdfHorizontal)
        setReaderContent(localBook, view)
        val session = reader.session as? PdfReaderSession ?: return
        readerProgressPageCount = session.pageCount.coerceAtLeast(1)
        view.onPageSwipe = { delta -> navigateReader(delta) }
        view.onLongPress = { showPdfTextSelectionDialog() }
        renderPdfPage(localBook, reader, view, currentPage.coerceIn(0, readerProgressPageCount - 1))
        updateReaderProgress(
            value = currentPage,
            max = (readerProgressPageCount - 1).coerceAtLeast(1),
            label = getString(MR.strings.book_reader_page_label, currentPage + 1, readerProgressPageCount),
        )
    }

    private fun readerPreferences() = getSharedPreferences(READER_PREFS, MODE_PRIVATE)

    private fun loadReaderPreferences(localBook: LocalBook) {
        val prefs = readerPreferences()
        bookReaderPreferences.migrateLegacy(
            object : LegacyBookReaderPreferences {
                override fun float(key: String) = if (prefs.contains(key)) prefs.getFloat(key, 0f) else null
                override fun int(key: String) = if (prefs.contains(key)) prefs.getInt(key, 0) else null
                override fun string(key: String) = if (prefs.contains(key)) prefs.getString(key, null) else null
                override fun boolean(key: String) = if (prefs.contains(key)) prefs.getBoolean(key, false) else null
            },
        )
        readTypedBookReaderPreferences()
    }

    private fun readTypedBookReaderPreferences() {
        speechRate = bookReaderPreferences.ttsRate.get().coerceIn(0.5f, 3.0f)
        speechPitch = bookReaderPreferences.ttsPitch.get().coerceIn(0.5f, 2.0f)
        speechVoiceName = bookReaderPreferences.ttsVoice.get().ifBlank { null }
        epubFontScale = bookReaderPreferences.epubFontScale.get().coerceIn(0.75f, 2.0f)
        epubLineHeight = bookReaderPreferences.epubLineHeight.get().coerceIn(1.1f, 3.0f)
        epubFontFamily = bookReaderPreferences.epubFontFamily.get()
        epubTextAlign = bookReaderPreferences.epubTextAlign.get()
        epubParagraphSpacing = bookReaderPreferences.epubParagraphSpacing.get().coerceIn(0.0f, 3.0f)
        epubTheme = bookReaderPreferences.epubTheme.get()
        epubFlow = bookReaderPreferences.epubFlow.get()
        epubContentWidth = bookReaderPreferences.epubContentWidth.get()
        // Night mode is now the shared Books inverted-color filter, applied above the engine.
        pdfNightMode = false
        pdfFitMode = bookReaderPreferences.pdfFitMode.get()
        pdfFitEachPage = pdfFitMode != PDF_FIT_ACTUAL
        pdfHorizontal = bookReaderPreferences.pdfHorizontal.get()
        pdfTwoPage = bookReaderPreferences.pdfTwoPage.get()
        pdfReflow = bookReaderPreferences.pdfReflow.get()
    }

    private fun applyBookChromeTheme(localBook: LocalBook? = book) {
        val currentBook = localBook ?: return
        val theme = if (usesTextTheme(currentBook)) {
            bookReaderPreferences.epubTheme.get()
        } else if (bookReaderPreferences.invertedColors.get()) {
            // PDF has no separate page-theme selector; inverted content is the OLED-equivalent
            // reader surface and should tint its chrome consistently.
            "oled"
        } else {
            "light"
        }
        val colors = ReaderThemeColors.book(this, theme)
        readerBinding?.applyReaderTheme(colors)
        // The cutout strip left by hidden system bars shows the window, so it takes the page color.
        window.decorView.setBackgroundColor(colors.background)
        // System bars are part of the reader chrome as well. Keep their surface synchronized with
        // the toolbar/sheet and let fullscreen hide them through the same visibility path.
        window.statusBarColor = Color.TRANSPARENT
        if (!bookReaderPreferences.fullscreen.get()) {
            window.navigationBarColor = colors.surface
        }
    }

    internal fun applyBookReaderSettings(reloadContent: Boolean = true) {
        val oldPdfState = listOf(pdfFitMode, pdfHorizontal, pdfTwoPage, pdfReflow, pdfNightMode)
        readTypedBookReaderPreferences()
        val chrome = readerBinding ?: return

        requestedOrientation = bookReaderPreferences.orientation.get()
        WindowCompat.setDecorFitsSystemWindows(window, !bookReaderPreferences.fullscreen.get())
        if (bookReaderPreferences.keepScreenOn.get()) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        chrome.pageNumber.isVisible = bookReaderPreferences.showPageNumber.get()
        applyBookChromeTheme()
        applyBookFilters(chrome)
        val currentInsets = ViewCompat.getRootWindowInsets(chrome.root)
            ?.getInsets(WindowInsetsCompat.Type.systemBars())
            ?: androidx.core.graphics.Insets.NONE
        applyBookReaderNavLayout(chrome, currentInsets)

        if (!reloadContent) return
        if (book?.contentType == ContentType.PDF) {
            val newPdfState = listOf(pdfFitMode, pdfHorizontal, pdfTwoPage, pdfReflow, pdfNightMode)
            if (newPdfState != oldPdfState) {
                reloadPdf()
            } else {
                pdfReflowTextView?.let { textView ->
                    applyPdfReflowStyle(textView)
                    (opened as? OpenedBookReader.Pdf)?.let { renderPdfReflowPage(it, pdfCurrentPage) }
                }
            }
        } else {
            epubSession?.let { session -> epubNavigator?.submitPreferences(readiumPreferences(session)) }
        }
    }

    private fun applyBookFilters(chrome: ReaderActivityBinding) {
        chrome.colorOverlay.isVisible = bookReaderPreferences.colorFilterEnabled.get()
        if (chrome.colorOverlay.isVisible) {
            chrome.colorOverlay.setFilterColor(
                bookReaderPreferences.colorFilterValue.get(),
                bookReaderPreferences.colorFilterMode.get(),
            )
        }

        val grayscale = bookReaderPreferences.grayscale.get()
        val inverted = bookReaderPreferences.invertedColors.get()
        val paint = if (grayscale || inverted) {
            android.graphics.Paint().apply {
                colorFilter = android.graphics.ColorMatrixColorFilter(
                    android.graphics.ColorMatrix().apply {
                        if (grayscale) setSaturation(0f)
                        if (inverted) {
                            postConcat(
                                android.graphics.ColorMatrix(
                                    floatArrayOf(
                                        -1f, 0f, 0f, 0f, 255f,
                                        0f, -1f, 0f, 0f, 255f,
                                        0f, 0f, -1f, 0f, 255f,
                                        0f, 0f, 0f, 1f, 0f,
                                    ),
                                ),
                            )
                        }
                    },
                )
            }
        } else {
            null
        }
        chrome.viewerContainer.setLayerType(View.LAYER_TYPE_HARDWARE, paint)

        val brightness = if (bookReaderPreferences.customBrightness.get()) {
            bookReaderPreferences.customBrightnessValue.get()
        } else {
            0
        }
        window.attributes = window.attributes.apply {
            screenBrightness = when {
                brightness > 0 -> brightness / 100f
                brightness < 0 -> 0.01f
                else -> WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            }
        }
        chrome.brightnessOverlay.isVisible = brightness < 0
        if (brightness < 0) {
            chrome.brightnessOverlay.setBackgroundColor(Color.argb((kotlin.math.abs(brightness) * 2.56).toInt(), 0, 0, 0))
        }
    }

    private fun percent(value: Float): String = "${(value * 100).toInt()}%"

    private fun percent(value: Double): String = "${(value * 100.0).toInt()}%"

    private fun formatDecimal(value: Float): String = String.format(Locale.US, "%.2f", value)

    private fun navigateEpubTo(locator: ReaderLocator.Epub) {
        val session = epubSession ?: return
        val navigator = epubNavigator ?: return
        val readiumLocator = session.toReadiumLocator(locator)
        epubLocator = locator
        session.updateFromNavigator(readiumLocator)
        epubChapterIndex = session.chapterIndexFor(locator)
        navigator.go(readiumLocator, bookReaderPreferences.epubAnimateTransitions.get())
        updateReaderProgress(
            value = (locator.progression * READER_PROGRESS_MAX).toInt(),
            max = READER_PROGRESS_MAX,
            label = epubChapterLabel(),
        )
    }

    /** Estimate for a slider position; the navigator's own locator resolves [epubChapterIndex] exactly. */
    private fun epubChapterIndexForProgress(progress: Double): Int =
        BookChapterMetrics.epubChapterIndex(progress, epubChapterCount.coerceAtLeast(1))

    private fun epubChapterLabel(index: Int = epubChapterIndex): String =
        getString(MR.strings.local_book_chapter_progress, index.coerceIn(0, (epubChapterCount - 1).coerceAtLeast(0)) + 1, epubChapterCount.coerceAtLeast(1))

    private fun applyEpubHighlights() {
        val navigator = epubNavigator ?: return
        val session = epubSession ?: return
        val decorations = activeHighlights.mapNotNull { highlight ->
            val start = highlight.start as? ReaderLocator.Epub ?: return@mapNotNull null
            runCatching {
                Decoration(
                    id = highlight.highlightId,
                    locator = session.toReadiumLocator(start),
                    style = Decoration.Style.Highlight(highlight.colorArgb.toInt(), false),
                )
            }.getOrNull()
        }
        lifecycleScope.launch {
            runCatching { navigator.applyDecorations(decorations, EPUB_DECORATION_GROUP) }
        }
    }

    private fun showMessage(message: String) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show()
    }

    private fun readiumPreferences(session: EpubNavigatorSession): EpubPreferences {
        val editor = session.navigator.createPreferencesEditor(EpubPreferences())
        val themeColors = ReaderThemeColors.book(this, epubTheme)
        runCatching { editor.fontSize.set(epubFontScale.toDouble().coerceIn(0.5, 3.0)) }
        runCatching { editor.lineHeight.set(epubLineHeight.toDouble().coerceIn(1.0, 3.0)) }
        runCatching { editor.paragraphSpacing.set(epubParagraphSpacing.toDouble().coerceIn(0.0, 3.0)) }
        epubPageMarginsForContentWidth(epubContentWidth)?.let { margins ->
            runCatching { editor.pageMargins.set(margins) }
        }
        runCatching { editor.fontFamily.set(FontFamily(epubFontFamily)) }
        runCatching {
            editor.textAlign.set(
                when (epubTextAlign) {
                    EPUB_ALIGN_JUSTIFIED -> TextAlign.JUSTIFY
                    EPUB_ALIGN_CENTER -> TextAlign.CENTER
                    else -> TextAlign.START
                },
            )
        }
        runCatching { editor.scroll.set(epubFlow != EPUB_FLOW_PAGINATED) }
        runCatching {
            editor.theme.set(
                when (epubTheme) {
                    EPUB_THEME_DARK, EPUB_THEME_OLED -> Theme.DARK
                    EPUB_THEME_SEPIA -> Theme.SEPIA
                    EPUB_THEME_SYSTEM -> if (androidx.core.graphics.ColorUtils.calculateLuminance(themeColors.background) < 0.48) {
                        Theme.DARK
                    } else {
                        Theme.LIGHT
                    }
                    else -> Theme.LIGHT
                },
            )
        }
        // Readium's Theme.DARK is intentionally shared by dark and OLED. Explicit colors make
        // OLED a true #000000 surface while keeping Dark at #121212, and also let the HUD use the
        // same palette.
        runCatching { editor.backgroundColor.set(ReadiumColor(themeColors.background)) }
        runCatching { editor.textColor.set(ReadiumColor(themeColors.foreground)) }
        return editor.preferences
    }

    private suspend fun requestPassword(attempt: Int): CharArray? = suspendCancellableCoroutine { continuation ->
        runOnUiThread {
            if (isFinishing || isDestroyed) {
                continuation.resume(null)
                return@runOnUiThread
            }
            val input = EditText(this).apply {
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                hint = getString(MR.strings.book_reader_pdf_password)
            }
            val dialog = materialAlertDialog()
                .setTitle(getString(MR.strings.book_reader_password_required))
                .setMessage(getString(MR.strings.book_reader_password_attempt, attempt))
                .setView(input)
                .setNegativeButton(android.R.string.cancel) { _, _ -> continuation.resume(null) }
                .setPositiveButton(android.R.string.ok, null)
                .create()
            dialog.setOnShowListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val value = input.text.toString().toCharArray()
                    password?.fill('\u0000')
                    password = value.copyOf()
                    value.fill('\u0000')
                    dialog.dismiss()
                    continuation.resume(password?.copyOf())
                }
            }
            continuation.invokeOnCancellation { dialog.dismiss() }
            dialog.show()
        }
    }

    override fun onPause() {
        super.onPause()
        val localBook = book ?: return
        val locator = latestReaderLocator ?: when {
            readerProgressIsPdf && pdfView != null ->
                pdfLocator(localBook.document().entityId, pdfCurrentPage)
            readerProgressIsPdf && (pdfSpreadPrimaryView != null || pdfReflowTextView != null) ->
                pdfLocator(localBook.document().entityId, pdfCurrentPage)
            !readerProgressIsPdf -> epubNavigator?.currentLocator?.value
                ?.let { epubSession?.toReaderLocator(it) }
                ?: epubLocator
            else -> null
        } ?: return
        lifecycleScope.launch(Dispatchers.IO) { persistProgress(localBook, locator) }
    }

    private suspend fun persistProgress(localBook: LocalBook, locator: ReaderLocator) {
        runCatching { repository.saveProgress(localBook.bookId, locator) }
            .onFailure { Logger.w { "Local book progress persistence failed" } }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (bookReaderPreferences.volumeKeys.get() &&
            (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP)
        ) {
            val down = keyCode == KeyEvent.KEYCODE_VOLUME_DOWN
            turnPage(forward = down != bookReaderPreferences.volumeKeysInverted.get())
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onResume() {
        super.onResume()
        if (book != null) applyBookReaderSettings()
    }

    override fun onDestroy() {
        closeReaderSettingsPanel()
        clearPdfSpread()
        opened?.close()
        opened = null
        pdfView?.recycle()
        pdfView = null
        pdfSecondaryView?.recycle()
        pdfSecondaryView = null
        epubNavigator = null
        epubSession = null
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        pendingSpeech = null
        textToSpeechReady = false
        password?.fill('\u0000')
        password = null
        readerProgressBar = null
        readerBinding = null
        super.onDestroy()
    }

    private fun finishWithError(message: String) {
        if (isFinishing) return
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show()
        finish()
    }

    companion object {
        const val EXTRA_BOOK_ID = "epigraph.book.id"
        private const val KEY_BOOK_MENU_VISIBLE = "epigraph.book.reader.menu_visible"
        private const val EXTRA_INITIAL_LOCATOR_JSON = "epigraph.book.initial_locator"
        private const val MAX_DIALOG_RESULTS = 100
        private const val MAX_ANNOTATION_TEXT = 160
        private const val MAX_HIGHLIGHT_TEXT = 4_000
        private const val MAX_SELECTION_QUERY = 500
        private const val DEFAULT_HIGHLIGHT_COLOR = 0x66ffcc00L
        private const val READER_PROGRESS_MAX = 1_000
        private const val MAX_VOICE_OPTIONS = 40
        private const val MENU_HIGHLIGHT_SELECTION = 0xA37
        private const val MENU_DEFINE_SELECTION = 0xA38
        private const val MENU_TRANSLATE_SELECTION = 0xA39
        private const val MENU_SEARCH_SELECTION = 0xA3A
        private const val BOOK_OPTION_TTS = 0xB01
        private const val BOOK_OPTION_SEARCH = 0xB02
        private const val BOOK_OPTION_SETTINGS = 0xB03
        private const val BOOK_OPTION_ANNOTATIONS = 0xB04
        private const val TTS_OPTION_READ = 0xB11
        private const val TTS_OPTION_CONTROLS = 0xB12
        private const val TTS_OPTION_PREVIOUS = 0xB13
        private const val TTS_OPTION_NEXT = 0xB14
        private const val TTS_OPTION_STOP = 0xB15
        private const val ANNOTATION_OPTION_VIEW = 0xB21
        private const val ANNOTATION_OPTION_BOOKMARK = 0xB22
        private const val ANNOTATION_OPTION_HIGHLIGHT = 0xB23
        private const val READER_PREFS = "aethon_local_reader_preferences"
        private const val KEY_TTS_RATE = "tts_rate"
        private const val KEY_TTS_PITCH = "tts_pitch"
        private const val KEY_TTS_VOICE = "tts_voice"
        private const val KEY_EPUB_FONT_SCALE = "epub_font_scale"
        private const val KEY_EPUB_LINE_HEIGHT = "epub_line_height"
        private const val KEY_EPUB_FONT_FAMILY = "epub_font_family"
        private const val KEY_EPUB_TEXT_ALIGN = "epub_text_align"
        private const val KEY_EPUB_PARAGRAPH_SPACING = "epub_paragraph_spacing"
        private const val KEY_EPUB_THEME = "epub_theme"
        private const val KEY_EPUB_FLOW = "epub_flow"
        private const val KEY_EPUB_CONTENT_WIDTH = "epub_content_width"
        private const val KEY_PDF_NIGHT = "pdf_night_mode"
        private const val KEY_PDF_FIT = "pdf_fit_each_page"
        private const val KEY_PDF_FIT_MODE = "pdf_fit_mode"
        private const val KEY_PDF_HORIZONTAL = "pdf_horizontal"
        private const val KEY_PDF_TWO_PAGE = "pdf_two_page"
        private const val KEY_PDF_REFLOW = "pdf_reflow"
        private const val PDF_REFLOW_PARAGRAPH_BREAK = "\n\n"
        private const val BOOK_PAGE_FLING_VELOCITY = 600f
        private const val PDF_REFLOW_BASE_TEXT_SP = 18f

        /** TextView's default line box is about 1.2× the font size; settings are absolute. */
        private const val PDF_REFLOW_NATIVE_LINE_HEIGHT = 1.2f

        private const val EPUB_THEME_SYSTEM = "system"
        private const val EPUB_THEME_LIGHT = "light"
        private const val EPUB_THEME_DARK = "dark"
        private const val EPUB_THEME_SEPIA = "sepia"
        private const val EPUB_THEME_OLED = "oled"
        private const val EPUB_FLOW_SCROLL = "scroll"
        private const val EPUB_FLOW_PAGINATED = "paginated"
        private const val EPUB_ALIGN_LEFT = "left"
        private const val EPUB_ALIGN_JUSTIFIED = "justified"
        private const val EPUB_ALIGN_CENTER = "center"
        private const val PDF_FIT_WIDTH = "width"
        private const val PDF_FIT_HEIGHT = "height"
        private const val PDF_FIT_BOTH = "both"
        private const val PDF_FIT_ACTUAL = "actual"

        private const val EPUB_NAVIGATOR_TAG = "epigraph.readium.epub.navigator"
        private const val EPUB_DECORATION_GROUP = "epigraph.epub.highlights"
        private val READER_LOCATOR_JSON = Json { ignoreUnknownKeys = true }

        fun intent(context: Context, bookId: String) =
            android.content.Intent(context, LocalBookReaderActivity::class.java)
                .putExtra(EXTRA_BOOK_ID, bookId)

        fun intent(context: Context, bookId: String, locator: ReaderLocator?) =
            intent(context, bookId).apply {
                locator?.let {
                    putExtra(
                        EXTRA_INITIAL_LOCATOR_JSON,
                        READER_LOCATOR_JSON.encodeToString(ReaderLocator.serializer(), it),
                    )
                }
            }
    }
}
