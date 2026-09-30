package epigraph.books.ui

import android.animation.ValueAnimator
import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.text.format.Formatter
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import androidx.annotation.FloatRange
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.isInvisible
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePaddingRelative
import androidx.core.widget.TextViewCompat
import androidx.palette.graphics.Palette
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.appcompat.widget.SearchView
import com.bluelinelabs.conductor.ControllerChangeHandler
import com.bluelinelabs.conductor.ControllerChangeType
import coil3.asDrawable
import coil3.asImage
import coil3.dispose
import coil3.imageLoader
import coil3.load
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.request.error
import coil3.request.placeholder
import com.google.android.material.R as materialR
import epigraph.ui.color.CoverPalette
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.databinding.ChaptersItemBinding
import eu.kanade.tachiyomi.databinding.MangaDetailsControllerBinding
import eu.kanade.tachiyomi.databinding.MangaHeaderItemBinding
import eu.kanade.tachiyomi.ui.base.SmallToolbarInterface
import eu.kanade.tachiyomi.ui.base.controller.BaseLegacyController
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.ui.manga.MangaDetailsDivider
import eu.kanade.tachiyomi.data.coil.getBestColor
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.contextCompatColor
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.system.ignoredSystemInsets
import eu.kanade.tachiyomi.util.system.isLandscape
import eu.kanade.tachiyomi.util.system.isTablet
import eu.kanade.tachiyomi.util.system.statusBarTint
import eu.kanade.tachiyomi.util.view.activityBinding
import eu.kanade.tachiyomi.util.view.compatToolTipText
import eu.kanade.tachiyomi.util.view.isControllerVisible
import eu.kanade.tachiyomi.util.view.scrollViewWith
import eu.kanade.tachiyomi.util.view.setTextColorAlpha
import eu.kanade.tachiyomi.util.view.toolbarHeight
import eu.kanade.tachiyomi.util.view.resetStrokeColor
import eu.kanade.tachiyomi.util.view.setOnQueryTextChangeListener
import eu.kanade.tachiyomi.widget.LinearLayoutManagerAccurateOffset
import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookRepository
import epigraph.books.reader.BookChapterMetrics
import epigraph.books.reader.BookStructure
import epigraph.books.reader.BookStructureInspector
import epigraph.sync.core.assets.BookAssetCoordinator
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.core.component.inject
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt
import eu.kanade.tachiyomi.util.system.materialAlertDialog
import yokai.i18n.MR
import yokai.util.lang.getString
import android.R as AR

/**
 * Details route for local EPUB/PDF publications.
 *
 * The wrapper and header are the same resources used by MangaDetailsController. Domain-specific
 * chapter/tracker rows are hidden, while the existing details chrome, cover treatment and read FAB
 * remain intact. Local files never get fabricated as Manga database rows.
 */
class LocalBookDetailsController(bundle: Bundle? = null) :
    BaseLegacyController<MangaDetailsControllerBinding>(bundle),
    SmallToolbarInterface {

    constructor(bookId: String) : this(
        Bundle().apply { putString(BOOK_ID_KEY, bookId) },
    )

    private val bookId: String
        get() = args.getString(BOOK_ID_KEY)
            ?: error("A local book details controller requires a book id")

    private val repository: LocalBookRepository by inject()
    private val bookAssets: BookAssetCoordinator by inject()
    private val preferences: PreferencesHelper by inject()
    private lateinit var structureInspector: BookStructureInspector
    private var book: LocalBook? = null
    private var progress: ReaderLocator? = null
    private var structure: BookStructure? = null
    private var isTablet = false
    private var headerHeight = 0
    private var toolbarIsColored = false
    private var colorAnimator: ValueAnimator? = null
    private var headerColor: Int? = null
    private var detailsAdapter: LocalBookDetailsAdapter? = null
    private var tabletDetailsAdapter: LocalBookDetailsAdapter? = null

    override fun getTitle(): String? = book?.displayName ?: view?.context?.getString(MR.strings.local_book_fallback_title)

    override fun createBinding(inflater: LayoutInflater): MangaDetailsControllerBinding =
        MangaDetailsControllerBinding.inflate(inflater)

    override fun onViewCreated(view: View) {
        super.onViewCreated(view)
        binding.swipeRefresh.isEnabled = false
        structureInspector = BookStructureInspector(view.context)
        setupDetailsChrome(view)

        viewScope.launch {
            val loaded = withContext(Dispatchers.IO) { repository.find(bookId) }
            if (loaded == null) {
                router.popController(this@LocalBookDetailsController)
                return@launch
            }
            book = loaded
            progress = withContext(Dispatchers.IO) { repository.getProgress(bookId) }
            val inspected = withContext(Dispatchers.IO) {
                structureInspector.inspect(loaded.document())
            }
            // Preserve the richer synchronized TOC count when PdfRenderer can only report pages.
            structure = BookChapterMetrics.resolve(loaded, inspected)
            // Core snapshots may not carry publication structure yet. Once the private asset is
            // available, persist the inspected counts locally so the shared Library/detail
            // chapter badge and catalog use the real EPUB/PDF structure on the next render.
            inspected?.let { inspectedStructure ->
                withContext(Dispatchers.IO) {
                    repository.saveStructure(
                        bookId = loaded.bookId,
                        chapterCount = structure?.chapterCount ?: inspectedStructure.chapterCount,
                        pageCount = inspectedStructure.pageCount,
                    )
                }
            }
            detailsAdapter = createAdapter(loaded)
            binding.recycler.adapter = detailsAdapter
            if (isTablet) {
                tabletDetailsAdapter = createAdapter(loaded)
                binding.tabletRecycler.adapter = tabletDetailsAdapter
            }
            binding.recycler.post { applyHeaderHeight() }
            binding.fab.isVisible = true
            binding.fab.setOnClickListener { openReader() }
            activity?.invalidateOptionsMenu()
            setTitle()
        }
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        inflater.inflate(R.menu.book_details, menu)
        val searchItem = menu.findItem(R.id.action_search)
        val searchView = searchItem.actionView as? SearchView
        searchView?.queryHint = activity?.getString(MR.strings.search_chapters)
        setOnQueryTextChangeListener(searchView) { query ->
            detailsAdapter?.setFilter(query.orEmpty())
            tabletDetailsAdapter?.setFilter(query.orEmpty())
            true
        }
        searchItem.fixExpand(onExpand = {
            activity?.invalidateOptionsMenu()
            true
        })
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        if (item.itemId == R.id.action_file_info) {
            showFileInfo()
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    /**
     * Installs the same app-bar/scroll/inset pipeline used by MangaDetailsController.
     *
     * The book header intentionally remains a small domain adapter, but its containing chrome
     * must not be a second, simplified implementation: toolbar lift, title fading, tablet split,
     * FAB insets and backdrop parallax all come from this canonical details setup.
     */
    private fun setupDetailsChrome(view: View) {
        isTablet = view.context.isTablet() && view.context.isLandscape()
        binding.tabletOverlay.isVisible = isTablet
        binding.tabletRecycler.isVisible = isTablet
        binding.tabletDivider.isVisible = isTablet
        binding.tabletRecycler.itemAnimator = null
        binding.recycler.updateLayoutParams<ViewGroup.LayoutParams> {
            width = if (isTablet) 0 else ViewGroup.LayoutParams.MATCH_PARENT
        }
        binding.recycler.layoutManager = LinearLayoutManagerAccurateOffset(view.context)
        binding.recycler.setHasFixedSize(true)
        binding.recycler.setItemViewCacheSize(8)
        binding.recycler.itemAnimator = null
        // Keep the pull gesture and the details header metrics identical to the canonical
        // MangaDetailsController. Books do not refresh remotely, but the same threshold avoids
        // a visibly different drag response when the user starts at the top of the page.
        binding.swipeRefresh.setDistanceToTriggerSync(70.dpToPx)
        binding.recycler.addItemDecoration(MangaDetailsDivider(view.context))
        if (isTablet) {
            binding.tabletRecycler.layoutManager = LinearLayoutManager(view.context)
            binding.tabletRecycler.setHasFixedSize(true)
        }
        // MangaDetailsAdapter normally wires this through its fastScroller property. Local books
        // use a deliberately smaller adapter, so bind the canonical chrome explicitly as well.
        binding.fastScroller.setRecyclerView(binding.recycler)

        val appbarHeight = activityBinding?.appBar?.attrToolbarHeight ?: 0
        scrollViewWith(
            binding.recycler,
            padBottom = true,
            customPadding = true,
            swipeRefreshLayout = binding.swipeRefresh,
            afterInsets = { insets ->
                setInsets(insets, appbarHeight, 10.dpToPx)
            },
            liftOnScroll = { colorToolbar(it) },
        )

        binding.recycler.addOnScrollListener(
            object : RecyclerView.OnScrollListener() {
                override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                    super.onScrolled(recyclerView, dx, dy)
                    if (isTablet) return
                    updateToolbarTitleAlpha(isScrollingDown = dy > 0 && !view.context.isTablet())
                    val atTop = !recyclerView.canScrollVertically(-1)
                    val holder = recyclerView.findViewHolderForAdapterPosition(0)
                        as? LocalBookDetailsAdapter.Holder
                    val currentTranslation = holder?.backdropView?.translationY ?: 0f
                    holder?.backdropView?.translationY = max(0f, currentTranslation + dy * 0.25f)
                    if (atTop) holder?.backdropView?.translationY = 0f
                }

                override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
                    updateToolbarTitleAlpha()
                    if (!recyclerView.canScrollVertically(-1)) {
                        (recyclerView.findViewHolderForAdapterPosition(0)
                            as? LocalBookDetailsAdapter.Holder)?.backdropView?.translationY = 0f
                    }
                }
            },
        )

        binding.fab.transitionName = "details start reading transition"
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(binding.fab) { fab, insets ->
            val systemBars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            fab.updateLayoutParams {
                if (this is androidx.coordinatorlayout.widget.CoordinatorLayout.LayoutParams) {
                    bottomMargin = systemBars.bottom + 16.dpToPx
                }
            }
            insets
        }
        binding.fastScroller.controller = this
        binding.fastScroller.addOnScrollStateChangeListener {
            activityBinding?.appBar?.y = 0f
        }
        updateToolbarTitleAlpha(0f)
        setStatusBarAndToolbar()
    }

    private fun createAdapter(loaded: LocalBook): LocalBookDetailsAdapter = LocalBookDetailsAdapter(
        book = loaded,
        progress = progress,
        structure = structure,
        onRead = ::openReader,
        onChapter = ::openReader,
        onBookmarks = ::showBookmarks,
        onHighlights = ::showHighlights,
        onFileInfo = ::showFileInfo,
        // DESIGN.md §2: the global `themeMangaDetails` toggle decides (a book has no per-title override).
        onPalette = if (preferences.themeMangaDetails().get()) ::applyCoverPalette else null,
    )

    /**
     * Books use the same cover-derived chrome as Comics. The local file has no Manga row from
     * which the canonical palette pipeline can read, so the header holder reports the decoded
     * cover swatch back here and we apply the same toolbar/status-bar blend used by
     * MangaDetailsController.
     */
    private fun applyCoverPalette(color: Int) {
        val currentActivity = activity ?: return
        val accent = readerAccentForTheme(currentActivity, color)
        val background = currentActivity.getResourceColor(android.R.attr.colorBackground)
        val luminance = ColorUtils.calculateLuminance(color)
        val wrongForTheme = if (currentActivity.resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK !=
            android.content.res.Configuration.UI_MODE_NIGHT_NO
        ) {
            luminance > 0.8
        } else {
            luminance <= 0.2
        }
        val backdropColor = ColorUtils.blendARGB(color, background, if (wrongForTheme) 0.9f else 0.7f)
        val surfaceColor = currentActivity.getResourceColor(materialR.attr.colorPrimaryVariant)
        val surfaceHsl = FloatArray(3)
        val colorHsl = FloatArray(3)
        ColorUtils.colorToHSL(surfaceColor, surfaceHsl)
        ColorUtils.colorToHSL(color, colorHsl)
        headerColor = ColorUtils.HSLToColor(floatArrayOf(colorHsl[0], surfaceHsl[1], surfaceHsl[2]))
        binding.recycler.findViewHolderForAdapterPosition(0)
            ?.let { (it as? LocalBookDetailsAdapter.Holder)?.applyPalette(color, backdropColor) }
        if (isTablet) {
            binding.tabletRecycler.findViewHolderForAdapterPosition(0)
                ?.let { (it as? LocalBookDetailsAdapter.Holder)?.applyPalette(color, backdropColor) }
        }
        // If the page is already lifted, repaint immediately; when it is at the top the window
        // remains transparent and the trueBackdrop supplies the colour behind the status bar.
        if (toolbarIsColored) colorToolbar(isColor = true, animate = false) else setStatusBarAndToolbar()
        binding.fab.backgroundTintList = ColorStateList.valueOf(accent)
        val fabForeground = readerReadableForeground(currentActivity, accent)
        binding.fab.setTextColor(ColorStateList.valueOf(fabForeground))
        binding.fab.iconTint = ColorStateList.valueOf(fabForeground)
    }

    private fun setInsets(
        insets: androidx.core.view.WindowInsetsCompat,
        appbarHeight: Int,
        offset: Int,
    ) {
        val systemInsets = insets.ignoredSystemInsets
        val fabPadding = 72.dpToPx
        binding.recycler.updatePaddingRelative(bottom = systemInsets.bottom + fabPadding)
        binding.tabletRecycler.updatePaddingRelative(bottom = systemInsets.bottom)
        // Comics details is a SmallToolbar route, so the canonical collapse point is the
        // compact toolbar height plus the system inset. A local book must use that same metric;
        // the activity's expanded card height would otherwise leave a visibly taller gap above
        // the cover.
        val tHeight = appbarHeight.takeIf { it > 0 }
            ?: toolbarHeight.takeIf { it ?: 0 > 0 }
            ?: 0
        headerHeight = tHeight + systemInsets.top
        binding.swipeRefresh.setProgressViewOffset(false, (-40).dpToPx, headerHeight + offset)
        if (isTablet) {
            binding.tabletOverlay.updateLayoutParams<ViewGroup.LayoutParams> {
                height = headerHeight
            }
            binding.recycler.updatePaddingRelative(top = headerHeight + 4.dpToPx)
        }
        applyHeaderHeight()
        binding.fastScroller.updateLayoutParams<ViewGroup.MarginLayoutParams> {
            topMargin = headerHeight
            bottomMargin = systemInsets.bottom
        }
        binding.fastScroller.scrollOffset = headerHeight
    }

    private fun applyHeaderHeight() {
        if (headerHeight <= 0) return
        (binding.recycler.findViewHolderForAdapterPosition(0)
            as? LocalBookDetailsAdapter.Holder)?.setTopHeight(headerHeight)
        if (isTablet) {
            (binding.tabletRecycler.findViewHolderForAdapterPosition(0)
                as? LocalBookDetailsAdapter.Holder)?.setTopHeight(headerHeight)
        }
    }

    private fun colorToolbar(isColor: Boolean, animate: Boolean = true) {
        if (isColor == toolbarIsColored || (isTablet && isColor)) return
        val currentActivity = activity ?: return
        toolbarIsColored = isColor
        if (isControllerVisible) setTitle()
        val scrollingColor = headerColor
            ?: currentActivity.getResourceColor(materialR.attr.colorPrimaryVariant)
        val topColor = ColorUtils.setAlphaComponent(scrollingColor, 0)
        val scrollingStatusColor = ColorUtils.setAlphaComponent(scrollingColor, (0.87f * 255).roundToInt())
        colorAnimator?.cancel()
        if (animate) {
            colorAnimator = ValueAnimator.ofFloat(
                if (toolbarIsColored) 0f else 1f,
                if (toolbarIsColored) 1f else 0f,
            ).apply {
                duration = 250
                addUpdateListener { animator ->
                    val fraction = animator.animatedValue as Float
                    activityBinding?.appBar?.setBackgroundColor(
                        ColorUtils.blendARGB(topColor, scrollingColor, fraction),
                    )
                    currentActivity.window?.statusBarTint = if (toolbarIsColored) {
                        ColorUtils.blendARGB(topColor, scrollingStatusColor, fraction)
                    } else {
                        Color.TRANSPARENT
                    }
                }
                start()
            }
        } else {
            activityBinding?.appBar?.setBackgroundColor(if (toolbarIsColored) scrollingColor else topColor)
            currentActivity.window?.statusBarTint =
                if (toolbarIsColored) scrollingStatusColor else topColor
        }
    }

    private fun setStatusBarAndToolbar() {
        val currentActivity = activity ?: return
        val scrollingColor = headerColor
            ?: currentActivity.getResourceColor(materialR.attr.colorPrimaryVariant)
        val scrollingStatusColor = ColorUtils.setAlphaComponent(scrollingColor, (0.87f * 255).roundToInt())
        currentActivity.window?.statusBarTint =
            if (toolbarIsColored) scrollingStatusColor else Color.TRANSPARENT
        activityBinding?.appBar?.setBackgroundColor(
            if (toolbarIsColored) scrollingColor else Color.TRANSPARENT,
        )
    }

    private fun updateToolbarTitleAlpha(
        @FloatRange(from = 0.0, to = 1.0) alpha: Float? = null,
        isScrollingDown: Boolean = false,
    ) {
        if ((!isControllerVisible && alpha == null) || isScrollingDown) return
        val toolbarTextView = activityBinding?.toolbar?.toolbarTitle ?: return
        if (isTablet) {
            toolbarTextView.setTextColorAlpha(0)
            return
        }
        val layoutManager = binding.recycler.layoutManager as? LinearLayoutManager ?: return
        val titleAlpha = when {
            alpha != null -> alpha
            layoutManager.findFirstVisibleItemPosition() > 0 -> 1f
            layoutManager.findFirstCompletelyVisibleItemPosition() == 0 -> 0f
            else -> (binding.recycler.computeVerticalScrollOffset() - 20.dpToPx)
                .coerceIn(0, 255) / 255f
        }
        toolbarTextView.setTextColorAlpha((titleAlpha * 255).roundToInt())
    }

    override fun onChangeStarted(handler: ControllerChangeHandler, type: ControllerChangeType) {
        super.onChangeStarted(handler, type)
        if (type.isEnter && isControllerVisible) {
            updateToolbarTitleAlpha(0f)
            setStatusBarAndToolbar()
        } else if (!type.isEnter) {
            colorAnimator?.cancel()
            val currentActivity = activity
            val colorSurface = currentActivity?.getResourceColor(materialR.attr.colorSurface)
                ?: Color.BLACK
            if (router.backstackSize > 0 && router.backstack.lastOrNull()?.controller !is LocalBookDetailsController) {
                activityBinding?.appBar?.setBackgroundColor(colorSurface)
                currentActivity?.window?.statusBarTint =
                    currentActivity.getResourceColor(AR.attr.statusBarColor)
            }
        }
    }

    override fun onActivityResumed(activity: Activity) {
        super.onActivityResumed(activity)
        // The reader is a separate activity, so returning from it resumes this controller with
        // its view intact. Reload the saved position or the header keeps the pre-reading page.
        if (book == null || detailsAdapter == null) return
        viewScope.launch { refreshProgress() }
    }

    private suspend fun refreshProgress() {
        val loaded = book ?: return
        val currentProgress = withContext(Dispatchers.IO) { repository.getProgress(bookId) }
        if (currentProgress == progress || detailsAdapter == null) return
        progress = currentProgress
        detailsAdapter = createAdapter(loaded)
        binding.recycler.adapter = detailsAdapter
        if (isTablet) {
            tabletDetailsAdapter = createAdapter(loaded)
            binding.tabletRecycler.adapter = tabletDetailsAdapter
        }
        binding.recycler.post { applyHeaderHeight() }
    }

    override fun onDestroyView(view: View) {
        colorAnimator?.cancel()
        colorAnimator = null
        detailsAdapter = null
        tabletDetailsAdapter = null
        super.onDestroyView(view)
    }

    private fun openReader(locator: ReaderLocator? = null) {
        val context = activity ?: return
        val loaded = book ?: return
        viewScope.launch {
            val fileAvailable = withContext(Dispatchers.IO) {
                loaded.isAvailable
            }
            if (!fileAvailable) {
                runCatching {
                    withContext(Dispatchers.IO) { bookAssets.ensurePublicationAvailable(bookId) }
                }.onFailure { failure ->
                    context.materialAlertDialog()
                        .setTitle(context.getString(MR.strings.local_books_unavailable_title))
                        .setMessage(failure.message ?: context.getString(MR.strings.local_book_download_failed_message))
                        .setPositiveButton(android.R.string.ok, null)
                        .show()
                    return@launch
                }
            }
            // The download may have supplied the actual EPUB spine/PDF page count. Refresh the
            // already visible details adapter before opening the reader so its header, badge and
            // chapter catalog stop showing the provisional fallback immediately.
            refreshBookSnapshot()
            startActivity(LocalBookReaderActivity.intent(context, bookId, locator))
        }
    }

    private suspend fun refreshBookSnapshot() {
        val refreshed = withContext(Dispatchers.IO) { repository.find(bookId) } ?: return
        val inspected = withContext(Dispatchers.IO) {
            structureInspector.inspect(refreshed.document())
        }
        val resolvedStructure = BookChapterMetrics.resolve(refreshed, inspected)
        inspected?.let {
            withContext(Dispatchers.IO) {
                repository.saveStructure(
                    bookId = refreshed.bookId,
                    chapterCount = resolvedStructure.chapterCount,
                    pageCount = it.pageCount,
                )
            }
        }
        val currentProgress = withContext(Dispatchers.IO) { repository.getProgress(bookId) }
        book = refreshed
        progress = currentProgress
        structure = resolvedStructure
        if (detailsAdapter == null) return
        detailsAdapter = createAdapter(refreshed)
        binding.recycler.adapter = detailsAdapter
        if (isTablet) {
            tabletDetailsAdapter = createAdapter(refreshed)
            binding.tabletRecycler.adapter = tabletDetailsAdapter
        }
        binding.recycler.post { applyHeaderHeight() }
        setTitle()
    }

    private fun showBookmarks() {
        val context = activity ?: return
        viewScope.launch {
            val bookmarks = withContext(Dispatchers.IO) { repository.getBookmarks(bookId) }
            if (bookmarks.isEmpty()) {
                context.materialAlertDialog()
                    .setTitle(context.getString(MR.strings.local_book_bookmarks))
                    .setMessage(context.getString(MR.strings.local_book_no_bookmarks))
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
                return@launch
            }
            context.materialAlertDialog()
                .setTitle(context.getString(MR.strings.local_book_bookmarks))
                .setItems(bookmarks.map { bookmark ->
                    bookmark.label?.takeIf(String::isNotBlank) ?: context.getString(MR.strings.local_book_saved_position)
                }.toTypedArray()) { _, index -> openReader(bookmarks[index].locator) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
    }

    private fun showHighlights() {
        val context = activity ?: return
        viewScope.launch {
            val highlights = withContext(Dispatchers.IO) { repository.getHighlights(bookId) }
            if (highlights.isEmpty()) {
                context.materialAlertDialog()
                    .setTitle(context.getString(MR.strings.local_book_highlights))
                    .setMessage(context.getString(MR.strings.local_book_no_highlights))
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
                return@launch
            }
            context.materialAlertDialog()
                .setTitle(context.getString(MR.strings.local_book_highlights))
                .setItems(highlights.map { highlight ->
                    highlight.selectedText.replace(Regex("\\s+"), " ").trim().take(120)
                }.toTypedArray()) { _, index -> openReader(highlights[index].start) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
    }

    private fun showFileInfo() {
        val context = activity ?: return
        val loaded = book ?: return
        val positionLabel = bookProgressLabel(context, loaded, progress, structure)
        val availability = context.getString(
            if (loaded.isAvailable) MR.strings.local_book_available_offline else MR.strings.local_book_file_unavailable,
        )
        context.materialAlertDialog()
            .setTitle(context.getString(MR.strings.local_book_file_info))
            .setMessage(
                "${context.getString(MR.strings.type)}: ${loaded.contentType}\n" +
                    "${context.getString(MR.strings.local_books_size)}: " +
                    "${Formatter.formatShortFileSize(context, loaded.byteSize)}\n" +
                    "SHA-256: ${loaded.sha256}\n" +
                    "${context.getString(MR.strings.local_book_position)}: $positionLabel\n" +
                    "${context.getString(MR.strings.status)}: $availability",
            )
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }


    private companion object {
        const val BOOK_ID_KEY = "epigraph.book.id"
    }
}

/**
 * Matches MangaDetailsController.setAccentColorValue so light covers cannot produce white
 * controls on the light application surface (and dark covers remain vivid in dark mode).
 */
private fun readerAccentForTheme(context: android.content.Context, color: Int): Int {
    val luminance = ColorUtils.calculateLuminance(color).toFloat()
    val night = context.resources.configuration.uiMode and
        android.content.res.Configuration.UI_MODE_NIGHT_MASK !=
        android.content.res.Configuration.UI_MODE_NIGHT_NO
    val needsBlend = if (night) luminance <= 0.6f else luminance > 0.4f
    val blended = if (!needsBlend) {
        color
    } else {
        val amount = if (night) -(luminance - 1f) else luminance
        val factor = amount * if (night) 0.22f else 0.35f
        ColorUtils.blendARGB(
            color,
            context.contextCompatColor(R.color.colorOnDownloadBadgeDayNight),
            factor,
        )
    }
    return CoverPalette.accentFor(blended, context.getResourceColor(android.R.attr.colorBackground))
}

private fun readerReadableForeground(context: android.content.Context, background: Int): Int {
    val opaqueBackground = ColorUtils.setAlphaComponent(background, 255)
    val candidates = intArrayOf(
        Color.BLACK,
        Color.WHITE,
        context.contextCompatColor(R.color.colorOnDownloadBadgeDayNight),
        context.getResourceColor(materialR.attr.colorOnPrimary),
    )
    return candidates.maxBy { ColorUtils.calculateContrast(it, opaqueBackground) }
}

private fun bookProgressLabel(
    context: android.content.Context,
    book: LocalBook,
    locator: ReaderLocator?,
    structure: BookStructure?,
): String = when (book.contentType) {
    ContentType.EPUB -> {
        val total = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
        val index = BookChapterMetrics.epubChapterIndex(
            locator as? ReaderLocator.Epub,
            total,
            structure?.chapterPaths.orEmpty(),
        )
        context.getString(MR.strings.local_book_chapter_progress, index + 1, total)
    }

    ContentType.PDF -> {
        val pdf = locator as? ReaderLocator.Pdf
        val total = (structure?.pageCount ?: book.pageCount ?: pdf?.totalPages)?.coerceAtLeast(1)
        val chapters = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
        if (total == null) context.getString(MR.strings.local_book_chapter_progress, 1, chapters) else {
            BookChapterMetrics.pdfLabel(
                pdf?.pageIndex ?: 0,
                total,
                chapters,
                structure?.chapterStartPages.orEmpty(),
            )
        }
    }

    else -> context.getString(MR.strings.local_book_count_unavailable)
}

private class LocalBookDetailsAdapter(
    private val book: LocalBook,
    private val progress: ReaderLocator?,
    private val structure: BookStructure?,
    private val onRead: () -> Unit,
    private val onChapter: (ReaderLocator) -> Unit,
    private val onBookmarks: () -> Unit,
    private val onHighlights: () -> Unit,
    private val onFileInfo: () -> Unit,
    private val onPalette: ((Int) -> Unit)?,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private val catalogTitles: List<String> = structure?.chapterTitles.orEmpty().ifEmpty {
        val count = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
        List(count) { index -> "Chapter ${index + 1}" }
    }
    private var visibleChapterIndexes: List<Int> = catalogTitles.indices.toList()

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder = when (viewType) {
        VIEW_TYPE_HEADER -> Holder(
            MangaHeaderItemBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            onRead,
            onBookmarks,
            onHighlights,
            onFileInfo,
            onPalette,
        )

        else -> ChapterHolder(
            ChaptersItemBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            book = book,
            structure = structure,
            progress = progress,
            onChapter = onChapter,
        )
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        if (position == 0) {
            (holder as Holder).bind(book, progress, structure, catalogTitles)
        } else {
            val chapterIndex = visibleChapterIndexes[position - 1]
            (holder as ChapterHolder).bind(
                index = chapterIndex,
                title = catalogTitles[chapterIndex],
            )
        }
    }

    override fun getItemViewType(position: Int): Int =
        if (position == 0) VIEW_TYPE_HEADER else VIEW_TYPE_CHAPTER

    override fun getItemCount(): Int = visibleChapterIndexes.size + 1

    fun setFilter(query: String) {
        val normalized = query.trim()
        visibleChapterIndexes = if (normalized.isEmpty()) {
            catalogTitles.indices.toList()
        } else {
            catalogTitles.indices.filter { index ->
                catalogTitles[index].contains(normalized, ignoreCase = true)
            }
        }
        notifyDataSetChanged()
    }

    class Holder(
        private val binding: MangaHeaderItemBinding,
        private val onRead: () -> Unit,
        private val onBookmarks: () -> Unit,
        private val onHighlights: () -> Unit,
        private val onFileInfo: () -> Unit,
        private val onPalette: ((Int) -> Unit)?,
    ) : RecyclerView.ViewHolder(binding.root) {

        val backdropView: View
            get() = binding.backdrop

        fun setTopHeight(height: Int) {
            binding.topView.updateLayoutParams<androidx.constraintlayout.widget.ConstraintLayout.LayoutParams> {
                this.height = height
            }
        }

        fun bind(
            book: LocalBook,
            progress: ReaderLocator?,
            structure: BookStructure?,
            catalogTitles: List<String>,
        ) = with(binding) {
            val context = root.context
            val cover = book.coverPath?.let(::File)?.takeIf(File::isFile)
            val placeholder = ContextCompat.getDrawable(
                context,
                if (book.contentType.name == "PDF") R.drawable.ic_file_open_24dp else R.drawable.ic_book_open_variant_24dp,
            )?.asImage()

            mangaCover.dispose()
            backdrop.dispose()
            val background = ColorDrawable(context.getResourceColor(android.R.attr.colorBackground))
            mangaCover.background = background
            backdrop.background = background
            resetCoverTreatment()
            if (cover != null) {
                mangaCover.load(cover) {
                    placeholder?.let(::placeholder)
                    placeholder?.let(::error)
                }
                // Use the same cropped/blurred backdrop treatment as MangaHeaderHolder rather
                // than showing a second, sharp copy of the cover behind the header. The palette
                // is extracted from the decoded bitmap once and then applied to the shared
                // details chrome.
                val request = ImageRequest.Builder(context)
                    .data(cover)
                    .allowHardware(false)
                    .placeholder(placeholder)
                    .error(placeholder)
                    .target(
                        onSuccess = { drawable ->
                            val image = drawable.asDrawable(context.resources)
                            val bitmap = (image as? BitmapDrawable)?.bitmap
                            if (bitmap == null) {
                                backdrop.setImageDrawable(image)
                                applyBackdropTreatment()
                                return@target
                            }
                            val crop = (bitmap.height * 0.33f).roundToInt()
                                .coerceIn(0, (bitmap.height - 1).coerceAtLeast(0))
                            val cropped = if (crop > 0 && bitmap.height - crop > 0) {
                                Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height - crop)
                            } else {
                                bitmap
                            }
                            backdrop.setImageDrawable(BitmapDrawable(context.resources, cropped))
                            applyBackdropTreatment()
                            // Coil may decode the displayed drawable as a hardware bitmap on
                            // newer Android releases. Palette needs CPU-readable pixels, so use
                            // a software copy only for color extraction and keep the displayed
                            // image untouched.
                            val paletteBitmap = if (
                                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                                bitmap.config == Bitmap.Config.HARDWARE
                            ) {
                                bitmap.copy(Bitmap.Config.ARGB_8888, false)
                            } else {
                                bitmap
                            }
                            val paletteCallback = onPalette ?: return@target
                            Palette.from(paletteBitmap).generate { palette ->
                                palette?.getBestColor()?.let { color ->
                                    root.post {
                                        applyPalette(color, coverBackdropColor(color))
                                        paletteCallback(color)
                                    }
                                }
                            }
                        },
                    )
                    .build()
                context.imageLoader.enqueue(request)
            } else {
                placeholder?.let {
                    mangaCover.setImageDrawable(it.asDrawable(context.resources))
                    backdrop.setImageDrawable(it.asDrawable(context.resources))
                }
                applyBackdropTreatment()
            }

            title.text = book.displayName
            // MangaHeaderHolder keeps the author row in the header even when a source has no
            // author. Do the same for local publications so status/source and the action row
            // occupy the same vertical rhythm as Comics details.
            mangaAuthor.text = book.author?.takeIf(String::isNotBlank) ?: context.getString(MR.strings.local_book_unknown_author)
            mangaAuthor.isVisible = true
            mangaStatus.text = buildString {
                append(book.contentType.name)
                append(" • ")
                append(bookProgressLabel(context, book, progress, structure))
            }
            mangaSource.text = context.getString(
                if (book.isAvailable) MR.strings.local_book_local_file else MR.strings.local_book_file_unavailable,
            )
            mangaSummaryLabel.text = context.getString(
                MR.strings.about_this_,
                book.contentType.name,
            )
            val description = book.description?.takeIf(String::isNotBlank)
                ?: context.getString(MR.strings.local_book_imported_publication, book.contentType.name)
            mangaSummary.text = description
            mangaSummary.setTextIsSelectable(true)
            mangaSummary.maxLines = 3
            moreButtonGroup.isVisible = false
            lessButton.isVisible = false
            mangaSummary.post {
                if (mangaSummary.lineCount > 3) {
                    moreButtonGroup.isVisible = true
                }
            }
            moreButton.setOnClickListener {
                mangaSummary.maxLines = Int.MAX_VALUE
                moreButtonGroup.isVisible = false
                lessButton.isVisible = true
            }
            lessButton.setOnClickListener {
                mangaSummary.maxLines = 3
                lessButton.isVisible = false
                moreButtonGroup.isVisible = mangaSummary.lineCount > 3
            }

            // Keep the exact action-row geometry used by Comics: one primary MaterialButton and
            // three compact image actions. The labels/operations are book-specific, but changing
            // the view types here would make the details page visibly drift from the canonical
            // MangaHeaderItem chrome.
            favoriteButton.isVisible = true
            favoriteButton.text = context.getString(MR.strings.read)
            favoriteButton.setIconResource(R.drawable.ic_play_arrow_24dp)
            // Comics' primary action occupies the 111dp slot before the compact icon actions.
            // Keep that slot stable even though the shorter "Read" label would otherwise shrink
            // the book row and shift every following action to the left.
            favoriteButton.minimumWidth = 111.dpToPx
            favoriteButton.updateLayoutParams<ViewGroup.LayoutParams> {
                width = 111.dpToPx
            }
            favoriteButton.setOnClickListener { onRead() }
            trackButton.isVisible = false
            predictedUpdateButton?.isVisible = false
            webviewButton.apply {
                isVisible = true
                setImageResource(R.drawable.ic_bookmark_24dp)
                contentDescription = context.getString(MR.strings.local_book_bookmarks)
                compatToolTipText = contentDescription
                setOnClickListener { onBookmarks() }
            }
            shareButton.apply {
                isVisible = true
                setImageResource(R.drawable.ic_format_quote_24dp)
                contentDescription = context.getString(MR.strings.local_book_highlights)
                compatToolTipText = contentDescription
                setOnClickListener { onHighlights() }
            }
            recsButton.apply {
                isVisible = true
                setImageResource(R.drawable.ic_info_outline_24dp)
                contentDescription = context.getString(MR.strings.local_book_file_info)
                compatToolTipText = contentDescription
                setOnClickListener { onFileInfo() }
            }
            metadataCompose.isVisible = false
            mangaGenresTags.isVisible = false
            lessButton.isVisible = false
            moreButtonGroup.isVisible = false
            buttonGroupCompose.isVisible = false
            pagePreviewCompose.isVisible = false
            chapterLayout.isVisible = catalogTitles.isNotEmpty()
            chaptersTitle.text = context.getString(
                MR.plurals.chapters_plural,
                catalogTitles.size,
                catalogTitles.size,
            )
            // INVISIBLE, not GONE: the title/filters chain would otherwise center the count label.
            filtersText.text = null
            filtersText.isInvisible = true
            filterButton.isVisible = false
            chapterLayout.setOnClickListener(null)
        }

        /** Keep backdrop opacity/blur identical to MangaHeaderHolder on every API level. */
        private fun applyBackdropTreatment() {
            binding.backdrop.alpha = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) 0.2f else 0.1f
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                binding.backdrop.setRenderEffect(
                    RenderEffect.createBlurEffect(20f, 20f, Shader.TileMode.MIRROR),
                )
            }
        }

        private fun resetCoverTreatment() {
            binding.backdrop.alpha = 0.1f
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                binding.backdrop.setRenderEffect(null)
            }
            binding.trueBackdrop.setBackgroundColor(
                binding.root.context.getResourceColor(android.R.attr.colorBackground),
            )
            val defaultTint = ColorStateList.valueOf(
                binding.root.context.getResourceColor(materialR.attr.colorSecondary),
            )
            binding.webviewButton.imageTintList = defaultTint
            binding.shareButton.imageTintList = defaultTint
            binding.recsButton.imageTintList = defaultTint
            binding.favoriteButton.iconTint = defaultTint
            binding.favoriteButton.resetStrokeColor()
            binding.favoriteButton.backgroundTintList = ColorStateList.valueOf(
                binding.root.context.getResourceColor(android.R.attr.colorBackground),
            )
        }

        private fun coverBackdropColor(color: Int): Int {
            val context = binding.root.context
            val background = context.getResourceColor(android.R.attr.colorBackground)
            val luminance = ColorUtils.calculateLuminance(color)
            val night = context.resources.configuration.uiMode and
                android.content.res.Configuration.UI_MODE_NIGHT_MASK !=
                android.content.res.Configuration.UI_MODE_NIGHT_NO
            val wrongForTheme = if (night) luminance > 0.8 else luminance <= 0.2
            return ColorUtils.blendARGB(color, background, if (wrongForTheme) 0.9f else 0.7f)
        }

        fun applyPalette(color: Int, backdropColor: Int = coverBackdropColor(color)) {
            val context = binding.root.context
            val accentColor = readerAccentForTheme(context, color)
            val accent = ColorStateList.valueOf(accentColor)
            binding.trueBackdrop.setBackgroundColor(backdropColor)
            binding.webviewButton.imageTintList = accent
            binding.shareButton.imageTintList = accent
            binding.recsButton.imageTintList = accent
            binding.favoriteButton.iconTint = accent
            // Imported books are already in the local library, so the primary action uses the
            // same checked/filled treatment as Comics' "In library" button while retaining its
            // book-specific Read label and play icon.
            val actionBackground = ColorUtils.blendARGB(
                accentColor,
                context.getResourceColor(android.R.attr.colorBackground),
                0.88f,
            )
            binding.favoriteButton.backgroundTintList = ColorStateList.valueOf(actionBackground)
            binding.favoriteButton.setTextColor(
                ColorStateList.valueOf(readerReadableForeground(context, actionBackground)),
            )
            binding.favoriteButton.strokeColor = ColorStateList.valueOf(Color.TRANSPARENT)
            TextViewCompat.setCompoundDrawableTintList(binding.moreButton, accent)
            binding.moreButton.setTextColor(accentColor)
            TextViewCompat.setCompoundDrawableTintList(binding.lessButton, accent)
            binding.lessButton.setTextColor(accentColor)
        }

    }

    private class ChapterHolder(
        private val binding: ChaptersItemBinding,
        private val book: LocalBook,
        private val structure: BookStructure?,
        private val progress: ReaderLocator?,
        private val onChapter: (ReaderLocator) -> Unit,
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(index: Int, title: String) = with(binding) {
            chapterTitle.text = title
            chapterScanlator.text = when (book.contentType) {
                ContentType.PDF -> {
                    val totalPages = (structure?.pageCount ?: book.pageCount)?.coerceAtLeast(1)
                    val chapterCount = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
                    if (totalPages == null) {
                        "PDF chapter"
                    } else if (chapterCount == 1) {
                        "$totalPages pages"
                    } else {
                        val anchors = structure?.chapterStartPages.orEmpty()
                        val firstPage = BookChapterMetrics.pageIndexForChapter(
                            index,
                            totalPages,
                            chapterCount,
                            anchors,
                        ) + 1
                        val nextPage = if (index + 1 < chapterCount) {
                            BookChapterMetrics.pageIndexForChapter(
                                index + 1,
                                totalPages,
                                chapterCount,
                                anchors,
                            )
                        } else {
                            totalPages
                        }
                        "Pages $firstPage–${nextPage.coerceAtLeast(firstPage)} of $totalPages"
                    }
                }

                else -> "Chapter ${index + 1} of ${(structure?.chapterCount ?: book.chapterCount ?: (index + 1))}"
            }
            translationButton.isVisible = false
            downloadButton.root.isVisible = false
            root.contentDescription = title
            root.setOnClickListener { onChapter(locatorFor(index)) }
            root.isActivated = isCurrent(index)
        }

        private fun locatorFor(index: Int): ReaderLocator = when (book.contentType) {
            ContentType.EPUB -> {
                val total = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
                val progression = if (total <= 1) 0.0 else index.toDouble() / (total - 1).toDouble()
                ReaderLocator.Epub(book.document().entityId, progression = progression)
            }

            ContentType.PDF -> {
                val totalPages = (structure?.pageCount ?: book.pageCount)?.coerceAtLeast(1) ?: 1
                val chapterCount = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
                val pageIndex = BookChapterMetrics.pageIndexForChapter(
                    index,
                    totalPages,
                    chapterCount,
                    structure?.chapterStartPages.orEmpty(),
                )
                ReaderLocator.Pdf(
                    entityId = book.document().entityId,
                    pageIndex = pageIndex,
                    totalPages = totalPages,
                    documentProgression = if (totalPages <= 1) 0.0 else {
                        pageIndex.toDouble() / (totalPages - 1).toDouble()
                    },
                )
            }

            else -> error("Unsupported local chapter content")
        }

        private fun isCurrent(index: Int): Boolean = when (val current = progress) {
            is ReaderLocator.Epub -> {
                val total = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
                BookChapterMetrics.epubChapterIndex(
                    current,
                    total,
                    structure?.chapterPaths.orEmpty(),
                ) == index
            }

            is ReaderLocator.Pdf -> {
                val totalPages = (structure?.pageCount ?: book.pageCount ?: current.totalPages ?: 1).coerceAtLeast(1)
                val chapterCount = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
                BookChapterMetrics.chapterIndexForPage(
                    current.pageIndex,
                    totalPages,
                    chapterCount,
                    structure?.chapterStartPages.orEmpty(),
                ) == index
            }
            else -> false
        }
    }

    private companion object {
        const val VIEW_TYPE_HEADER = 0
        const val VIEW_TYPE_CHAPTER = 1
    }
}
