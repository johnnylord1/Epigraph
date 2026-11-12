package epigraph.books.ui

import android.animation.AnimatorInflater
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.text.TextUtils
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
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePaddingRelative
import androidx.core.widget.TextViewCompat
import androidx.core.widget.doAfterTextChanged
import androidx.palette.graphics.Palette
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.appcompat.widget.PopupMenu
import androidx.appcompat.widget.SearchView
import com.bluelinelabs.conductor.ControllerChangeHandler
import com.bluelinelabs.conductor.ControllerChangeType
import coil3.asDrawable
import coil3.dispose
import coil3.imageLoader
import coil3.load
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.request.error
import coil3.request.placeholder
import coil3.request.transformations
import com.google.android.material.button.MaterialButton
import com.google.android.material.R as materialR
import epigraph.ui.color.CoverPalette
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.databinding.ChaptersItemBinding
import eu.kanade.tachiyomi.databinding.DialogBookEditBinding
import eu.kanade.tachiyomi.databinding.MangaDetailsControllerBinding
import eu.kanade.tachiyomi.databinding.MangaHeaderItemBinding
import eu.kanade.tachiyomi.ui.base.SmallToolbarInterface
import eu.kanade.tachiyomi.ui.base.controller.BaseLegacyController
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.ui.manga.CoverVeil
import eu.kanade.tachiyomi.ui.manga.DetailsCoverPlaceholder
import eu.kanade.tachiyomi.ui.manga.MangaDetailsDivider
import eu.kanade.tachiyomi.ui.manga.MangaReadingButtonState
import eu.kanade.tachiyomi.ui.manga.getReadingButtonText
import eu.kanade.tachiyomi.data.coil.getBestColor
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.contextCompatColor
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.system.ignoredSystemInsets
import eu.kanade.tachiyomi.util.system.isLandscape
import eu.kanade.tachiyomi.util.system.isTablet
import eu.kanade.tachiyomi.util.system.statusBarTint
import eu.kanade.tachiyomi.util.system.toast
import eu.kanade.tachiyomi.util.view.activityBinding
import eu.kanade.tachiyomi.util.view.compatToolTipText
import eu.kanade.tachiyomi.util.view.isControllerVisible
import eu.kanade.tachiyomi.util.view.scrollViewWith
import eu.kanade.tachiyomi.util.view.setTextColorAlpha
import eu.kanade.tachiyomi.util.view.toolbarHeight
import eu.kanade.tachiyomi.util.view.setOnQueryTextChangeListener
import eu.kanade.tachiyomi.widget.LinearLayoutManagerAccurateOffset
import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookChapterState
import epigraph.books.local.LocalBookImportService
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
import java.text.DecimalFormat
import kotlin.math.max
import kotlin.math.roundToInt
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.util.system.materialAlertDialog
import yokai.i18n.MR
import yokai.presentation.theme.ReducedMotion
import yokai.util.coil.CropBottomTransformation
import yokai.util.lang.getString
import android.content.Context
import android.graphics.Canvas
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.view.ActionMode
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.forEach
import androidx.recyclerview.widget.ItemTouchHelper
import com.google.android.material.snackbar.Snackbar
import epigraph.books.reader.BookChapterProgress
import epigraph.books.reader.reconcileChapterState
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.ui.base.MaterialMenuSheet
import eu.kanade.tachiyomi.ui.main.MainActivity
import eu.kanade.tachiyomi.ui.main.SearchActivity
import eu.kanade.tachiyomi.ui.manga.chapter.ChapterActionBarHandlers
import eu.kanade.tachiyomi.ui.manga.chapter.ChapterActionBarState
import eu.kanade.tachiyomi.ui.manga.chapter.MangaChapterActionBar
import eu.kanade.tachiyomi.ui.manga.shouldAnimateMangaDetailsPredictiveBack
import eu.kanade.tachiyomi.util.chapter.ChapterUtil
import eu.kanade.tachiyomi.util.view.setAction
import eu.kanade.tachiyomi.util.view.snack
import kotlin.math.min
import yokai.presentation.theme.YokaiTheme
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
    SmallToolbarInterface,
    ActionMode.Callback {

    constructor(bookId: String) : this(
        Bundle().apply { putString(BOOK_ID_KEY, bookId) },
    )

    private val bookId: String
        get() = args.getString(BOOK_ID_KEY)
            ?: error("A local book details controller requires a book id")

    private val repository: LocalBookRepository by inject()
    private val bookAssets: BookAssetCoordinator by inject()
    private val importService: LocalBookImportService by inject()
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
    private val settings by lazy { BookChapterListSettings(bookId, preferences) }
    private var chapterProgress: BookChapterProgress? = null
    private var chapterState = LocalBookChapterState()
    private var query = ""
    private var accentColor: Int? = null
    private var snack: Snackbar? = null
    private var chapterSwipeHelper: ItemTouchHelper? = null
    private var isSelectionMode = false
    private var selectedChapters: Set<Int> = emptySet()
    private var lastSelectionChapter: Int? = null
    private var rangeMode: ChapterRangeMode? = null
    private var rangeStartChapter: Int? = null
    private var actionMode: ActionMode? = null
    private var actionBarState by mutableStateOf(ChapterActionBarState())
    private var chapterActionBarBottomInsetPx by mutableIntStateOf(0)

    override fun getTitle(): String? {
        if (isSelectionMode && selectedChapters.isNotEmpty()) return selectedChapters.size.toString()
        return book?.displayName ?: view?.context?.getString(MR.strings.local_book_fallback_title)
    }

    override fun createBinding(inflater: LayoutInflater): MangaDetailsControllerBinding =
        MangaDetailsControllerBinding.inflate(inflater)

    override fun onViewCreated(view: View) {
        super.onViewCreated(view)
        binding.swipeRefresh.isEnabled = false
        structureInspector = BookStructureInspector(view.context)
        setupDetailsChrome(view)
        setupChapterActionBar()

        viewScope.launch {
            val loaded = withContext(Dispatchers.IO) {
                repository.ensurePdfOutline(bookId)
                repository.find(bookId)
            }
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
            val helper = BookChapterProgress(loaded, structure)
            chapterProgress = helper
            chapterState = withContext(Dispatchers.IO) {
                repository.reconcileChapterState(helper, bookId, progress)
            }
            // Core snapshots may not carry publication structure yet. Once the private asset is
            // available, persist the inspected counts locally so the shared Library/detail
            // chapter badge and catalog use the real EPUB/PDF structure on the next render. The
            // inspected count goes as is: sections read from a PDF's outline stay on this device,
            // and the router keeps a higher count the Core confirmed.
            inspected?.let { inspectedStructure ->
                withContext(Dispatchers.IO) {
                    repository.saveStructure(
                        bookId = loaded.bookId,
                        chapterCount = inspectedStructure.chapterCount,
                        pageCount = inspectedStructure.pageCount,
                    )
                }
            }
            installAdapters(loaded)
            binding.fab.isVisible = true
            binding.fab.setOnClickListener { readNextChapter() }
            updateFab()
            activity?.invalidateOptionsMenu()
            setTitle()
        }
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        inflater.inflate(R.menu.book_details, menu)
        updateMenuVisibility(menu)
        val searchItem = menu.findItem(R.id.action_search)
        val searchView = searchItem.actionView as? SearchView
        searchView?.queryHint = activity?.getString(MR.strings.search_chapters)
        if (query.isNotEmpty() && (!searchItem.isActionViewExpanded || searchView?.query?.toString() != query)) {
            searchItem.expandActionView()
            setSearchViewListener(searchView)
            searchView?.setQuery(query, true)
            searchView?.clearFocus()
        } else {
            setSearchViewListener(searchView)
        }
        searchItem.fixExpand(onExpand = { invalidateMenuOnExpand() })
    }

    private fun setSearchViewListener(searchView: SearchView?) {
        setOnQueryTextChangeListener(searchView) {
            query = it.orEmpty()
            refreshList()
            true
        }
    }

    private fun updateMenuVisibility(menu: Menu) {
        if (isSelectionMode && selectedChapters.isNotEmpty()) {
            menu.forEach { it.isVisible = it.itemId == R.id.action_select_all || it.itemId == R.id.action_select_inverse }
            return
        }
        val helper = chapterProgress
        menu.findItem(R.id.action_mark_all_as_read)?.isVisible = helper != null && helper.unreadCount(chapterState) > 0
        menu.findItem(R.id.action_mark_all_as_unread)?.isVisible = helper != null && helper.anyRead(chapterState)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.action_edit -> showEditDialog()
            R.id.action_file_info -> showFileInfo()
            R.id.action_select_all -> selectAllChapters()
            R.id.action_select_inverse -> invertChapterSelection()
            R.id.action_mark_all_as_read -> confirmMarkAll(read = true)
            R.id.action_mark_all_as_unread -> confirmMarkAll(read = false)
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun confirmMarkAll(read: Boolean) {
        val context = activity ?: return
        val helper = chapterProgress ?: return
        context.materialAlertDialog()
            .setMessage(
                context.getString(
                    if (read) MR.strings.mark_all_chapters_as_read else MR.strings.mark_all_chapters_as_unread,
                ),
            )
            .setPositiveButton(context.getString(if (read) MR.strings.mark_as_read else MR.strings.mark_as_unread)) { _, _ ->
                mutate {
                    repository.resetChaptersRead(bookId, if (read) helper.chapterCount else 0)
                    repository.saveProgress(bookId, if (read) helper.end() else helper.startOf(0))
                }
            }
            .setNegativeButton(AR.string.cancel, null)
            .show()
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
        chapterSwipeHelper = ItemTouchHelper(ChapterSwipeCallback()).also {
            it.attachToRecyclerView(binding.recycler)
        }
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
                    updateVeil(recyclerView)
                }

                override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
                    updateToolbarTitleAlpha()
                    if (!isTablet) updateVeil(recyclerView)
                }
            },
        )

        binding.fab.transitionName = "details start reading transition"
        // A section's own name can be long; it ends in an ellipsis rather than spanning the screen.
        binding.fab.maxLines = 1
        binding.fab.ellipsize = TextUtils.TruncateAt.END
        binding.fab.maxWidth = (binding.root.resources.displayMetrics.widthPixels * 0.75f).toInt()
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
        structure = structure,
        chapterProgress = checkNotNull(chapterProgress),
        titleOf = ::chapterTitle,
        initialState = chapterListState(),
        onLibrary = ::showLibraryPopup,
        onChapterClick = ::onChapterClick,
        onChapterLongClick = ::onChapterLongClick,
        onFilter = ::showFilters,
        onBookmarks = ::showBookmarks,
        onHighlights = ::showHighlights,
        onFileInfo = ::showFileInfo,
        // DESIGN.md §2: the global `themeMangaDetails` toggle decides (a book has no per-title override).
        onPalette = if (preferences.themeMangaDetails().get()) ::applyCoverPalette else null,
    )

    /** Rebuilds the list for a changed book file, keeping the scroll position. */
    private fun installAdapters(loaded: LocalBook) {
        val scrollState = binding.recycler.layoutManager?.onSaveInstanceState()
        detailsAdapter = createAdapter(loaded)
        binding.recycler.adapter = detailsAdapter
        if (isTablet) {
            tabletDetailsAdapter = createAdapter(loaded)
            binding.tabletRecycler.adapter = tabletDetailsAdapter
        }
        scrollState?.let { binding.recycler.layoutManager?.onRestoreInstanceState(it) }
        binding.recycler.post { applyHeaderHeight() }
        updateFab()
    }

    /**
     * Books use the same cover-derived chrome as Comics. The local file has no Manga row from
     * which the canonical palette pipeline can read, so the header holder reports the decoded
     * cover swatch back here and we apply the same toolbar/status-bar blend used by
     * MangaDetailsController.
     */
    private fun applyCoverPalette(color: Int) {
        val currentActivity = activity ?: return
        val accent = readerAccentForTheme(currentActivity, color)
        accentColor = accent
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
        refreshList()
    }

    private fun setInsets(
        insets: androidx.core.view.WindowInsetsCompat,
        appbarHeight: Int,
        offset: Int,
    ) {
        val systemInsets = insets.ignoredSystemInsets
        chapterActionBarBottomInsetPx = systemInsets.bottom
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
        if (actionMode != null || isSelectionMode) return
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
        val forceColored = isSelectionMode || toolbarIsColored
        currentActivity.window?.statusBarTint =
            if (forceColored) scrollingStatusColor else Color.TRANSPARENT
        activityBinding?.appBar?.setBackgroundColor(
            if (forceColored) scrollingColor else Color.TRANSPARENT,
        )
    }

    /** Feeds the header's absolute scroll offset to its veil, exactly as Comics does. */
    private fun updateVeil(recyclerView: RecyclerView) {
        val header = recyclerView.findViewHolderForAdapterPosition(0) as? LocalBookDetailsAdapter.Holder ?: return
        header.onVeilScrolled(max(0, recyclerView.paddingTop - header.itemView.top))
    }

    private fun updateToolbarTitleAlpha(
        @FloatRange(from = 0.0, to = 1.0) alpha: Float? = null,
        isScrollingDown: Boolean = false,
    ) {
        if ((!isControllerVisible && alpha == null) || isScrollingDown) return
        val toolbarTextView = activityBinding?.toolbar?.toolbarTitle ?: return
        if (isSelectionMode) {
            toolbarTextView.setTextColorAlpha(255)
            toolbarTextView.translationY = 0f
            return
        }
        if (isTablet) {
            toolbarTextView.setTextColorAlpha(0)
            toolbarTextView.translationY = 0f
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
        // The title rises into the bar as the header's title scrolls under it (DESIGN.md §9).
        toolbarTextView.translationY =
            if (ReducedMotion.isEnabled()) 0f else (1f - titleAlpha) * TITLE_RISE_DP.dpToPx
    }

    override fun onChangeStarted(handler: ControllerChangeHandler, type: ControllerChangeType) {
        super.onChangeStarted(handler, type)
        if (type.isEnter && isControllerVisible) {
            updateToolbarTitleAlpha(0f)
            setStatusBarAndToolbar()
        } else if (!type.isEnter) {
            colorAnimator?.cancel()
            // The shared toolbar title must leave at rest for the next screen.
            activityBinding?.toolbar?.toolbarTitle?.translationY = 0f
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
        viewScope.launch { reloadChapterState() }
    }

    private suspend fun reloadChapterState() {
        val helper = chapterProgress ?: return
        val (currentProgress, currentState) = withContext(Dispatchers.IO) {
            val position = repository.getProgress(bookId)
            position to repository.reconcileChapterState(helper, bookId, position)
        }
        if (detailsAdapter == null) return
        if (currentProgress == progress && currentState == chapterState) return
        progress = currentProgress
        chapterState = currentState
        refreshList()
        activity?.invalidateOptionsMenu()
    }

    override fun onDestroyView(view: View) {
        if (isSelectionMode || actionMode != null) destroyActionModeIfNeeded()
        snack?.dismiss()
        snack = null
        chapterSwipeHelper = null
        colorAnimator?.cancel()
        colorAnimator = null
        detailsAdapter = null
        tabletDetailsAdapter = null
        super.onDestroyView(view)
    }

    private fun openReader(locator: ReaderLocator? = null) {
        val context = activity ?: return
        if (isSelectionMode || actionMode != null) destroyActionModeIfNeeded()
        val loaded = book ?: return
        viewScope.launch {
            val fileAvailable = withContext(Dispatchers.IO) {
                loaded.isAvailable
            }
            if (!fileAvailable) {
                runCatching {
                    withContext(Dispatchers.IO) { bookAssets.ensurePublicationAvailable(bookId) }
                }.onFailure { failure ->
                    // A restored or unsynced book has no copy to download; the fix is the user's
                    // original file, so offer that instead of the transport's diagnostic.
                    Logger.w(failure) { "Book file unavailable: $bookId" }
                    context.materialAlertDialog()
                        .setTitle(context.getString(MR.strings.local_books_unavailable_title))
                        .setMessage(context.getString(MR.strings.local_books_unavailable_message))
                        .setNegativeButton(android.R.string.cancel, null)
                        .setPositiveButton(context.getString(MR.strings.local_books_relink_file)) { _, _ ->
                            launchRelink(loaded)
                        }
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

    private fun launchRelink(book: LocalBook) {
        val type = if (book.contentType == ContentType.EPUB) "application/epub+zip" else "application/pdf"
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            this.type = type
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(type))
        }
        startActivityForResult(intent, REQUEST_RELINK)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_RELINK || resultCode != Activity.RESULT_OK) return
        val uri = data?.data ?: return
        val target = book ?: return
        val context = activity ?: return
        viewScope.launch {
            runCatching {
                // Relink verifies the SHA-256, so only the book's own file is accepted.
                withContext(Dispatchers.IO) { importService.relink(uri, target) }
            }.onSuccess { relinked ->
                context.toast(context.getString(MR.strings.local_books_relinked, relinked.displayName))
                refreshBookSnapshot()
            }.onFailure { error ->
                Logger.w(error) { "Book relink failed: $bookId" }
                context.toast(
                    if (error is IllegalArgumentException) MR.strings.local_books_choose_original
                    else MR.strings.local_books_relink_failed,
                )
            }
        }
    }

    private suspend fun refreshBookSnapshot() {
        val refreshed = withContext(Dispatchers.IO) {
            repository.ensurePdfOutline(bookId)
            repository.find(bookId)
        } ?: return
        val inspected = withContext(Dispatchers.IO) {
            structureInspector.inspect(refreshed.document())
        }
        val resolvedStructure = BookChapterMetrics.resolve(refreshed, inspected)
        inspected?.let {
            withContext(Dispatchers.IO) {
                repository.saveStructure(
                    bookId = refreshed.bookId,
                    chapterCount = it.chapterCount,
                    pageCount = it.pageCount,
                )
            }
        }
        val currentProgress = withContext(Dispatchers.IO) { repository.getProgress(bookId) }
        val helper = BookChapterProgress(refreshed, resolvedStructure)
        val currentState = withContext(Dispatchers.IO) {
            repository.reconcileChapterState(helper, bookId, currentProgress)
        }
        book = refreshed
        progress = currentProgress
        chapterState = currentState
        structure = resolvedStructure
        chapterProgress = helper
        if (detailsAdapter == null) return
        installAdapters(refreshed)
        activity?.invalidateOptionsMenu()
        setTitle()
    }

    /** The Comics FAB: opens the next unread chapter, and leaves once every chapter is read. */
    private fun updateFab() {
        val context = view?.context ?: return
        val helper = chapterProgress ?: return
        val next = helper.nextChapter(chapterState, progress)
        binding.fab.isEnabled = next != null
        if (next != null) {
            binding.fab.text = context.getReadingButtonText(
                MangaReadingButtonState(
                    chapterNumber = if (helper.chapterCount <= 1) 0.0 else next + 1.0,
                    hasProgress = next == helper.resumableChapter(chapterState, progress),
                    chapterTitle = structure?.chapterTitles?.getOrNull(next)
                        ?.takeIf { it.isNotBlank() && helper.chapterCount > 1 && !settings.hideTitles },
                ),
                DecimalFormat("#"),
            )
        }
        if (!isSelectionMode && next != null) binding.fab.show() else if (binding.fab.isVisible) binding.fab.hide()
    }

    private fun readNextChapter() {
        val helper = chapterProgress ?: return
        val next = helper.nextChapter(chapterState, progress) ?: return
        openReader(if (next == helper.resumableChapter(chapterState, progress)) null else helper.startOf(next))
    }

    /**
     * An imported book is always in the library, so the primary header action reads "In library"
     * like Comics and opens the same removal popup.
     */
    private fun showLibraryPopup(anchor: View) {
        val context = activity ?: return
        val loaded = book ?: return
        PopupMenu(context, anchor).apply {
            menu.add(context.getString(MR.strings.remove_from_library))
            setOnMenuItemClickListener {
                confirmRemove(loaded)
                true
            }
        }.show()
    }

    private fun confirmRemove(loaded: LocalBook) {
        val context = activity ?: return
        // Removing also deletes the private copy of the file, which cannot be undone.
        context.materialAlertDialog()
            .setTitle(context.getString(MR.strings.local_books_remove_title))
            .setMessage(context.getString(MR.strings.local_books_remove_message, loaded.displayName))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(context.getString(MR.strings.remove)) { _, _ ->
                viewScope.launch {
                    runCatching {
                        withContext(Dispatchers.IO) { repository.remove(loaded.bookId, removeFile = true) }
                    }
                        .onSuccess {
                            settings.clear()
                            router.popController(this@LocalBookDetailsController)
                        }
                        .onFailure { error -> view?.context?.toast(error.message) }
                }
            }
            .show()
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

    /** The name and author shown for this book; the file itself and its identity stay as they are. */
    private fun showEditDialog() {
        val context = activity ?: return
        val loaded = book ?: return
        val builder = context.materialAlertDialog()
        val fields = DialogBookEditBinding.inflate(LayoutInflater.from(builder.context)).apply {
            title.setText(loaded.displayName)
            author.setText(loaded.author.orEmpty())
        }
        val dialog = builder
            .setTitle(context.getString(MR.strings.edit))
            .setView(fields.root)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val title = fields.title.text?.toString().orEmpty().trim()
                val author = fields.author.text?.toString().orEmpty().trim()
                viewScope.launch {
                    runCatching {
                        withContext(Dispatchers.IO) {
                            repository.saveTitleAndAuthor(bookId, title, author.ifEmpty { null })
                        }
                        refreshBookSnapshot()
                    }.onFailure { error -> view?.context?.toast(error.message) }
                }
            }
            .show()
        // A book cannot go without a name, so saving waits until it has one.
        val save = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
        save.isEnabled = loaded.displayName.isNotBlank()
        fields.title.doAfterTextChanged { save.isEnabled = !it.isNullOrBlank() }
    }

    private fun showFileInfo() {
        val context = activity ?: return
        val loaded = book ?: return
        val positionLabel = bookProgressLabel(context, loaded, progress, structure)
        val availability = context.getString(
            when {
                loaded.isAvailable -> MR.strings.local_book_available_offline
                loaded.downloadsWhenOpened -> MR.strings.local_books_downloads_when_opened
                else -> MR.strings.local_book_file_unavailable
            },
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


    private fun chapterLabel(index: Int): String =
        view?.context?.getString(MR.strings.chapter_, (index + 1).toString()).orEmpty()

    private fun catalogTitle(index: Int): String =
        structure?.chapterTitles?.getOrNull(index)?.takeIf(String::isNotBlank) ?: chapterLabel(index)

    private fun chapterTitle(index: Int): String =
        if (settings.hideTitles) chapterLabel(index) else catalogTitle(index)

    private fun chapterListState(): ChapterListState {
        return ChapterListState(
            progress = progress,
            chapterState = chapterState,
            selectedChapters = selectedChapters,
            readFilter = settings.readFilter,
            bookmarkFilter = settings.bookmarkFilter,
            descending = settings.descending,
            hideTitles = settings.hideTitles,
            query = query,
            accent = accentColor,
        )
    }

    private fun refreshList() {
        val state = chapterListState()
        detailsAdapter?.submit(state)
        tabletDetailsAdapter?.submit(state)
        updateFab()
        refreshActionBar()
    }

    private fun showFilters() {
        val currentActivity = activity ?: return
        if (isSelectionMode || rangeMode != null) return
        BookChaptersSortBottomSheet(currentActivity, settings) { refreshList() }.show()
    }

    private fun mutate(action: suspend () -> Unit) {
        viewScope.launch {
            runCatching { withContext(Dispatchers.IO) { action() } }
                .onFailure { error ->
                    Logger.w(error) { "Book chapter change failed: $bookId" }
                    view?.context?.toast(error.message)
                }
            reloadChapterState()
        }
    }

    private fun markChapters(chapters: Collection<Int>, read: Boolean) {
        val helper = chapterProgress ?: return
        if (chapters.isEmpty()) return
        val marked = chapterState.copy(readOverrides = chapterState.readOverrides + chapters.associateWith { read })
        val target = helper.positionAfterMarking(chapters, read, marked, progress)
        mutate {
            repository.setChaptersRead(bookId, chapters.associateWith { read })
            target?.let { repository.saveProgress(bookId, it) }
        }
    }

    private fun setChapterBookmarks(chapters: Collection<Int>, bookmarked: Boolean) {
        mutate { repository.setChaptersBookmarked(bookId, chapters, bookmarked) }
    }

    private fun toggleChapterBookmark(index: Int) {
        val bookmarked = index !in chapterState.bookmarks
        setChapterBookmarks(listOf(index), bookmarked)
        snack?.dismiss()
        snack = view?.snack(
            if (bookmarked) MR.strings.bookmarked else MR.strings.removed_bookmark,
            Snackbar.LENGTH_INDEFINITE,
        ) {
            setAction(MR.strings.undo) { setChapterBookmarks(listOf(index), !bookmarked) }
        }
        (activity as? MainActivity)?.setUndoSnackBar(snack)
    }

    private fun toggleChapterRead(index: Int) {
        val helper = chapterProgress ?: return
        val previous = progress
        val previousChoice = chapterState.readOverrides[index]
        val wasRead = helper.isRead(index, chapterState)
        markChapters(listOf(index), read = !wasRead)
        snack?.dismiss()
        snack = view?.snack(
            if (wasRead) MR.strings.marked_as_unread else MR.strings.marked_as_read,
            Snackbar.LENGTH_INDEFINITE,
        ) {
            setAction(MR.strings.undo) {
                val moved = progress != previous
                mutate {
                    repository.setChaptersRead(bookId, mapOf(index to previousChoice))
                    if (moved) repository.saveProgress(bookId, previous ?: helper.startOf(0))
                }
            }
        }
        (activity as? MainActivity)?.setUndoSnackBar(snack)
    }

    private fun onChapterClick(index: Int) {
        val mode = rangeMode
        when {
            isSelectionMode || (mode == null && selectedChapters.isNotEmpty()) -> toggleChapterSelection(index)
            mode != null -> {
                val start = rangeStartChapter
                if (start == null) {
                    selectedChapters = setOf(index)
                    rangeStartChapter = index
                    refreshList()
                    actionMode?.invalidate()
                } else {
                    val range = chaptersBetween(start, index)
                    rangeMode = null
                    rangeStartChapter = null
                    destroyActionModeIfNeeded()
                    markChapters(range, read = mode == ChapterRangeMode.MarkRead)
                }
            }
            else -> {
                val helper = chapterProgress ?: return
                val resumes = helper.resumableChapter(chapterState, progress) == index
                openReader(if (resumes) null else helper.startOf(index))
            }
        }
    }

    private fun onChapterLongClick(index: Int) {
        // A long-press during a multi-select range-selects from the previous anchor.
        if (isSelectionMode) {
            enterSelectionMode(index)
            return
        }
        if (rangeMode != null) return
        showChapterActions(index)
    }

    /** The J2K long-press sheet: labeled chapter actions, with multi-select as its last row. */
    private fun showChapterActions(index: Int) {
        val currentActivity = activity ?: return
        val previousChaptersBelow = settings.descending
        val items = listOf(
            MaterialMenuSheet.MenuSheetItem(
                R.id.action_mark_previous_as_read,
                if (previousChaptersBelow) R.drawable.ic_eye_down_24dp else R.drawable.ic_eye_up_24dp,
                MR.strings.mark_previous_as_read,
            ),
            MaterialMenuSheet.MenuSheetItem(
                R.id.action_mark_previous_as_unread,
                if (previousChaptersBelow) R.drawable.ic_eye_off_down_24dp else R.drawable.ic_eye_off_up_24dp,
                MR.strings.mark_previous_as_unread,
            ),
            MaterialMenuSheet.MenuSheetItem(
                R.id.action_mark_range_as_read,
                R.drawable.ic_eye_range_24dp,
                MR.strings.mark_range_as_read,
            ),
            MaterialMenuSheet.MenuSheetItem(
                R.id.action_mark_range_as_unread,
                R.drawable.ic_eye_off_range_24dp,
                MR.strings.mark_range_as_unread,
            ),
            MaterialMenuSheet.MenuSheetItem(
                R.id.action_select_chapters,
                R.drawable.ic_select_all_24dp,
                MR.strings.select_chapters,
            ),
        )
        MaterialMenuSheet(currentActivity, items, chapterTitle(index)) { _, id ->
            when (id) {
                R.id.action_mark_previous_as_read -> markChapters((0 until index).toList(), read = true)
                R.id.action_mark_previous_as_unread -> markChapters((0 until index).toList(), read = false)
                R.id.action_mark_range_as_read -> startMarkRange(index, ChapterRangeMode.MarkRead)
                R.id.action_mark_range_as_unread -> startMarkRange(index, ChapterRangeMode.MarkUnread)
                R.id.action_select_chapters -> enterSelectionMode(index)
            }
            true
        }.show()
    }

    /** Uses the long-pressed chapter as the range start; the next tap picks the end. */
    private fun startMarkRange(index: Int, mode: ChapterRangeMode) {
        createActionModeIfNeeded()
        rangeMode = mode
        onChapterClick(index)
    }

    private fun chaptersBetween(first: Int, last: Int): List<Int> {
        val visible = detailsAdapter?.visibleChapters.orEmpty()
        val from = visible.indexOf(first)
        val to = visible.indexOf(last)
        if (from < 0 || to < 0) return listOf(last)
        return visible.subList(min(from, to), max(from, to) + 1).toList()
    }

    private fun enterSelectionMode(index: Int) {
        val firstEntry = !isSelectionMode
        if (firstEntry) {
            rangeStartChapter = null
            rangeMode = null
        }
        isSelectionMode = true
        if (firstEntry) collapseSearchForSelection()
        val anchor = lastSelectionChapter
        selectedChapters = if (anchor == null || anchor == index) {
            selectedChapters + index
        } else {
            selectedChapters + chaptersBetween(anchor, index)
        }
        lastSelectionChapter = index
        refreshList()
        updateSelectionChrome()
    }

    private fun toggleChapterSelection(index: Int) {
        val nowSelected = index !in selectedChapters
        selectedChapters = if (nowSelected) selectedChapters + index else selectedChapters - index
        lastSelectionChapter = if (nowSelected) index else null
        if (selectedChapters.isEmpty()) {
            destroyActionModeIfNeeded()
        } else {
            refreshList()
            updateSelectionChrome()
        }
    }

    private fun selectAllChapters() {
        selectedChapters = selectedChapters + detailsAdapter?.visibleChapters.orEmpty()
        refreshList()
        updateSelectionChrome()
    }

    private fun invertChapterSelection() {
        selectedChapters = detailsAdapter?.visibleChapters.orEmpty().toSet() - selectedChapters
        lastSelectionChapter = null
        if (selectedChapters.isEmpty()) {
            destroyActionModeIfNeeded()
        } else {
            refreshList()
            updateSelectionChrome()
        }
    }

    private fun createActionModeIfNeeded() {
        if (actionMode == null) {
            actionMode = (activity as AppCompatActivity).startSupportActionMode(this)
            activityBinding?.root?.requestApplyInsets()
            val view = activity?.window?.currentFocus ?: return
            val imm = activity?.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
            imm.hideSoftInputFromWindow(view.windowToken, 0)
        }
    }

    private fun destroyActionModeIfNeeded() {
        if (isSelectionMode) {
            clearChapterSelectionMode()
            return
        }
        actionMode?.finish()
    }

    private fun clearChapterSelectionMode() {
        isSelectionMode = false
        lastSelectionChapter = null
        selectedChapters = emptySet()
        refreshList()
        updateSelectionChrome()
    }

    private fun updateSelectionChrome() {
        if (view == null) return
        setStatusBarAndToolbar()
        if (isControllerVisible) setTitle()
        updateToolbarTitleAlpha()
        updateSelectionNavigationIcon(isSelectionMode)
        updateFab()
        activity?.invalidateOptionsMenu()
    }

    private fun updateSelectionNavigationIcon(isSelecting: Boolean) {
        val context = view?.context ?: return
        val toolbar = activityBinding?.toolbar
        val searchToolbar = activityBinding?.searchToolbar
        val tint = context.getResourceColor(R.attr.actionBarTintColor)
        fun icon(resId: Int) = ContextCompat.getDrawable(context, resId)?.mutate()?.apply { setTint(tint) }
        if (isSelecting) {
            toolbar?.navigationIcon = icon(R.drawable.ic_close_24dp)
            searchToolbar?.navigationIcon = icon(R.drawable.ic_close_24dp)
            return
        }
        val onRoot = router.backstackSize == 1 && activity !is SearchActivity
        toolbar?.navigationIcon = if (onRoot) null else icon(R.drawable.ic_arrow_back_24dp)
        searchToolbar?.navigationIcon = when {
            activityBinding?.appBar?.useLargeToolbar == true || onRoot -> icon(R.drawable.ic_search_24dp)
            else -> icon(R.drawable.ic_arrow_back_24dp)
        }
    }

    private fun collapseSearchForSelection() {
        activityBinding?.toolbar?.menu?.findItem(R.id.action_search)?.collapseActionView()
        activityBinding?.searchToolbar?.menu?.findItem(R.id.action_search)?.collapseActionView()
    }

    private fun setupChapterActionBar() {
        val handlers = ChapterActionBarHandlers(
            onBookmark = { applyToSelection { setChapterBookmarks(it, bookmarked = true) } },
            onRemoveBookmark = { applyToSelection { setChapterBookmarks(it, bookmarked = false) } },
            onMarkRead = { applyToSelection { markChapters(it, read = true) } },
            onMarkUnread = { applyToSelection { markChapters(it, read = false) } },
            onMarkPreviousRead = {
                applyToSelection { chapters ->
                    chapters.singleOrNull()?.let { markChapters((0 until it).toList(), read = true) }
                }
            },
            onDownload = {},
            onDelete = {},
        )
        ViewCompat.setOnApplyWindowInsetsListener(binding.actionBarCompose) { _, _ -> WindowInsetsCompat.CONSUMED }
        binding.actionBarCompose.setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        binding.actionBarCompose.setContent {
            YokaiTheme {
                val bottomInset = with(LocalDensity.current) { chapterActionBarBottomInsetPx.toDp() }
                val context = binding.actionBarCompose.context
                MangaChapterActionBar(
                    state = actionBarState,
                    handlers = handlers,
                    bottomInset = bottomInset,
                    containerColor = androidx.compose.ui.graphics.Color(
                        headerColor ?: context.getResourceColor(materialR.attr.colorPrimaryVariant),
                    ),
                    contentColor = androidx.compose.ui.graphics.Color(
                        context.getResourceColor(R.attr.actionBarTintColor),
                    ),
                )
            }
        }
    }

    private fun applyToSelection(action: (Set<Int>) -> Unit) {
        val chapters = selectedChapters
        destroyActionModeIfNeeded()
        action(chapters)
    }

    private fun refreshActionBar() {
        val helper = chapterProgress
        if (helper == null || !isSelectionMode || selectedChapters.isEmpty()) {
            actionBarState = ChapterActionBarState(visible = false)
            return
        }
        val bookmarked = chapterState.bookmarks
        actionBarState = ChapterActionBarState(
            visible = true,
            showBookmark = selectedChapters.any { it !in bookmarked },
            showRemoveBookmark = selectedChapters.any { it in bookmarked },
            showMarkAsRead = selectedChapters.any { !helper.isRead(it, chapterState) },
            showMarkAsUnread = selectedChapters.any { helper.isRead(it, chapterState) },
            showMarkPreviousAsRead = selectedChapters.size == 1,
        )
    }

    override fun shouldAnimatePredictiveBack(): Boolean =
        // This back action clears selection instead of popping the controller.
        shouldAnimateMangaDetailsPredictiveBack(isSelectionMode, selectedChapters.size)

    override fun handleBack(): Boolean {
        if (isSelectionMode && selectedChapters.isNotEmpty()) {
            destroyActionModeIfNeeded()
            return true
        }
        return super.handleBack()
    }

    override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean = false

    // Multi-select uses the normal app toolbar; only the range prompt is a contextual bar.
    override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean = !isSelectionMode

    override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean {
        mode?.title = view?.context?.getString(
            if (rangeStartChapter == null) MR.strings.select_starting_chapter else MR.strings.select_ending_chapter,
        )
        return false
    }

    override fun onDestroyActionMode(mode: ActionMode?) {
        actionMode = null
        rangeMode = null
        rangeStartChapter = null
        clearChapterSelectionMode()
    }

    /** The Comics row swipe: toward the end bookmarks, toward the start toggles read. */
    private inner class ChapterSwipeCallback : ItemTouchHelper.Callback() {

        private val rtl get() = binding.recycler.layoutDirection == View.LAYOUT_DIRECTION_RTL

        override fun getMovementFlags(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder): Int {
            if (viewHolder !is LocalBookDetailsAdapter.ChapterHolder || isSelectionMode || rangeMode != null) return 0
            return makeMovementFlags(0, ItemTouchHelper.LEFT or ItemTouchHelper.RIGHT)
        }

        override fun onMove(
            recyclerView: RecyclerView,
            viewHolder: RecyclerView.ViewHolder,
            target: RecyclerView.ViewHolder,
        ): Boolean = false

        override fun isLongPressDragEnabled(): Boolean = false

        override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {
            val holder = viewHolder as? LocalBookDetailsAdapter.ChapterHolder ?: return
            val index = holder.chapterIndex
            val position = holder.bindingAdapterPosition
            val bookmarkSide = (direction == ItemTouchHelper.RIGHT) != rtl
            // The helper keeps a swiped-out row until it is detached; this row stays in the list.
            chapterSwipeHelper?.let {
                it.attachToRecyclerView(null)
                it.attachToRecyclerView(binding.recycler)
            }
            binding.recycler.adapter?.notifyItemChanged(position)
            if (bookmarkSide) toggleChapterBookmark(index) else toggleChapterRead(index)
        }

        override fun onChildDraw(
            c: Canvas,
            recyclerView: RecyclerView,
            viewHolder: RecyclerView.ViewHolder,
            dX: Float,
            dY: Float,
            actionState: Int,
            isCurrentlyActive: Boolean,
        ) {
            val holder = viewHolder as? LocalBookDetailsAdapter.ChapterHolder ?: return
            val bookmarkSide = (dX > 0) != rtl
            holder.binding.startView.isVisible = bookmarkSide && dX != 0f
            holder.binding.endView.isVisible = !bookmarkSide && dX != 0f
            getDefaultUIUtil().onDraw(c, recyclerView, holder.binding.frontView, dX, dY, actionState, isCurrentlyActive)
        }

        override fun onChildDrawOver(
            c: Canvas,
            recyclerView: RecyclerView,
            viewHolder: RecyclerView.ViewHolder?,
            dX: Float,
            dY: Float,
            actionState: Int,
            isCurrentlyActive: Boolean,
        ) {
            val holder = viewHolder as? LocalBookDetailsAdapter.ChapterHolder ?: return
            getDefaultUIUtil().onDrawOver(c, recyclerView, holder.binding.frontView, dX, dY, actionState, isCurrentlyActive)
        }

        override fun clearView(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder) {
            val holder = viewHolder as? LocalBookDetailsAdapter.ChapterHolder ?: return
            getDefaultUIUtil().clearView(holder.binding.frontView)
            holder.binding.startView.isVisible = false
            holder.binding.endView.isVisible = false
        }

        override fun onSelectedChanged(viewHolder: RecyclerView.ViewHolder?, actionState: Int) {
            val holder = viewHolder as? LocalBookDetailsAdapter.ChapterHolder ?: return
            getDefaultUIUtil().onSelected(holder.binding.frontView)
        }
    }

    private companion object {
        const val BOOK_ID_KEY = "epigraph.book.id"
        const val REQUEST_RELINK = 0xAEB4

        /** Matches MangaDetailsController.TITLE_RISE_DP. */
        const val TITLE_RISE_DP = 8
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

/** [BookChapterMetrics.pdfLabel] wording in the app language. */
internal fun android.content.Context.pdfLabelText() = BookChapterMetrics.PdfLabelText(
    chapter = { current, total -> getString(MR.strings.local_book_chapter_progress, current, total) },
    page = { current, total -> getString(MR.strings.book_reader_page_label, current, total) },
    pages = { first, last, total -> getString(MR.strings.book_reader_pages_label, first, last, total) },
)

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
                text = context.pdfLabelText(),
            )
        }
    }

    else -> context.getString(MR.strings.local_book_count_unavailable)
}

private enum class ChapterRangeMode { MarkRead, MarkUnread }

/** What the chapter rows and the header's chapter bar show. */
private data class ChapterListState(
    val progress: ReaderLocator?,
    val chapterState: LocalBookChapterState,
    val selectedChapters: Set<Int>,
    val readFilter: Int,
    val bookmarkFilter: Int,
    val descending: Boolean,
    val hideTitles: Boolean,
    val query: String,
    val accent: Int?,
)

private class LocalBookDetailsAdapter(
    private val book: LocalBook,
    private val structure: BookStructure?,
    private val chapterProgress: BookChapterProgress,
    private val titleOf: (Int) -> String,
    initialState: ChapterListState,
    private val onLibrary: (View) -> Unit,
    private val onChapterClick: (Int) -> Unit,
    private val onChapterLongClick: (Int) -> Unit,
    private val onFilter: () -> Unit,
    private val onBookmarks: () -> Unit,
    private val onHighlights: () -> Unit,
    private val onFileInfo: () -> Unit,
    private val onPalette: ((Int) -> Unit)?,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private var state = initialState

    var visibleChapters: List<Int> = computeVisible(initialState)
        private set

    private fun computeVisible(state: ChapterListState): List<Int> {
        val normalized = state.query.trim()
        val chapters = (0 until chapterProgress.chapterCount).filter { index ->
            val isRead = chapterProgress.isRead(index, state.chapterState)
            val isBookmarked = index in state.chapterState.bookmarks
            val readMatches = when (state.readFilter) {
                Manga.CHAPTER_SHOW_READ -> isRead
                Manga.CHAPTER_SHOW_UNREAD -> !isRead
                else -> true
            }
            val bookmarkMatches = when (state.bookmarkFilter) {
                Manga.CHAPTER_SHOW_BOOKMARKED -> isBookmarked
                Manga.CHAPTER_SHOW_NOT_BOOKMARKED -> !isBookmarked
                else -> true
            }
            readMatches && bookmarkMatches &&
                (normalized.isEmpty() || titleOf(index).contains(normalized, ignoreCase = true))
        }
        return if (state.descending) chapters.reversed() else chapters
    }

    fun submit(newState: ChapterListState) {
        if (newState == state) return
        val oldCount = visibleChapters.size
        state = newState
        visibleChapters = computeVisible(newState)
        val newCount = visibleChapters.size
        // By payload, as a full header bind would reload the cover.
        notifyItemChanged(0, PAYLOAD_LIST)
        val common = min(oldCount, newCount)
        if (common > 0) notifyItemRangeChanged(1, common)
        if (newCount > oldCount) {
            notifyItemRangeInserted(oldCount + 1, newCount - oldCount)
        } else if (newCount < oldCount) {
            notifyItemRangeRemoved(newCount + 1, oldCount - newCount)
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder = when (viewType) {
        VIEW_TYPE_HEADER -> Holder(
            MangaHeaderItemBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            onLibrary,
            onBookmarks,
            onHighlights,
            onFileInfo,
            onFilter,
            onPalette,
        )

        else -> ChapterHolder(
            ChaptersItemBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            book = book,
            structure = structure,
            onClick = onChapterClick,
            onLongClick = onChapterLongClick,
        )
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
        if (position == 0 && payloads.isNotEmpty()) {
            (holder as Holder).bindListState(book, structure, state, visibleChapters.size)
        } else {
            onBindViewHolder(holder, position)
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        if (position == 0) {
            (holder as Holder).bind(book, structure, state, visibleChapters.size)
        } else {
            val chapterIndex = visibleChapters[position - 1]
            (holder as ChapterHolder).bind(chapterIndex, titleOf(chapterIndex), state, chapterProgress)
        }
    }

    override fun getItemViewType(position: Int): Int =
        if (position == 0) VIEW_TYPE_HEADER else VIEW_TYPE_CHAPTER

    override fun getItemCount(): Int = visibleChapters.size + 1

    class Holder(
        private val binding: MangaHeaderItemBinding,
        private val onLibrary: (View) -> Unit,
        private val onBookmarks: () -> Unit,
        private val onHighlights: () -> Unit,
        private val onFileInfo: () -> Unit,
        private val onFilter: () -> Unit,
        private val onPalette: ((Int) -> Unit)?,
    ) : RecyclerView.ViewHolder(binding.root) {

        /** The same veil Comics and Novels use (DESIGN.md §6). */
        private val veil = CoverVeil(binding.backdrop)
        private var accentColor: Int? = null
        private var searching = false

        fun onVeilScrolled(scrolled: Int) = veil.onScrolled(scrolled)

        fun setTopHeight(height: Int) {
            binding.topView.updateLayoutParams<androidx.constraintlayout.widget.ConstraintLayout.LayoutParams> {
                this.height = height
            }
        }

        fun bind(
            book: LocalBook,
            structure: BookStructure?,
            state: ChapterListState,
            visibleCount: Int,
        ) = with(binding) {
            val context = root.context
            val cover = book.coverPath?.let(::File)?.takeIf(File::isFile)
            val fallback = DetailsCoverPlaceholder.create(
                context,
                if (book.contentType == ContentType.PDF) R.drawable.ic_file_open_24dp else R.drawable.ic_book_open_variant_24dp,
            )

            mangaCover.dispose()
            backdrop.dispose()
            resetCoverTreatment()
            if (cover != null) {
                mangaCover.load(cover) {
                    placeholder(fallback)
                    error(fallback)
                }
                // The backdrop gets the header's crop and veil; its software bitmap also feeds
                // Palette, which cannot read hardware bitmaps.
                val request = ImageRequest.Builder(context)
                    .data(cover)
                    .allowHardware(false)
                    .transformations(CropBottomTransformation(CoverVeil.CROP_FRACTION))
                    .target(
                        onSuccess = { image ->
                            val drawable = image.asDrawable(context.resources)
                            backdrop.setImageDrawable(drawable)
                            veil.apply()
                            val bitmap = (drawable as? BitmapDrawable)?.bitmap ?: return@target
                            val paletteCallback = onPalette ?: return@target
                            Palette.from(bitmap).generate { palette ->
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
                // Like a comic without artwork: the placeholder card, and no veil over nothing.
                mangaCover.setImageDrawable(fallback)
                backdrop.setImageDrawable(null)
            }

            title.text = book.displayName
            mangaAuthor.text = book.author?.takeIf(String::isNotBlank) ?: context.getString(MR.strings.local_book_unknown_author)
            mangaAuthor.isVisible = true
            mangaSource.text = context.getString(
                when {
                    book.isAvailable -> MR.strings.local_book_local_file
                    book.downloadsWhenOpened -> MR.strings.local_books_downloads_when_opened
                    else -> MR.strings.local_book_file_unavailable
                },
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
                if (!searching && mangaSummary.lineCount > 3) {
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

            // An imported book is in the library by definition, so the primary action is the
            // Comics "In library" button, with the same removal popup; reading is the FAB's job.
            favoriteButton.isVisible = true
            favoriteButton.icon = ContextCompat.getDrawable(context, R.drawable.ic_heart_24dp)
            favoriteButton.text = context.getString(MR.strings.in_library)
            favoriteButton.checked()
            favoriteButton.setOnClickListener { onLibrary(it) }
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
            buttonGroupCompose.isVisible = false
            pagePreviewCompose.isVisible = false
            bindListState(book, structure, state, visibleCount)
        }

        fun bindListState(
            book: LocalBook,
            structure: BookStructure?,
            state: ChapterListState,
            visibleCount: Int,
        ) = with(binding) {
            val context = root.context
            // MangaHeaderHolder.collapse()/expand(): results take the room of the description and
            // chips while searching, except on a tablet, where the header has its own pane.
            val nowSearching = state.query.isNotBlank() && !(context.isTablet() && context.isLandscape())
            if (nowSearching != searching) {
                searching = nowSearching
                subItemGroup.isVisible = !nowSearching
                moreButtonGroup.isVisible = false
                lessButton.isVisible = !nowSearching && mangaSummary.maxLines == Int.MAX_VALUE
                if (!nowSearching) {
                    mangaSummary.post {
                        moreButtonGroup.isVisible = !searching &&
                            mangaSummary.maxLines != Int.MAX_VALUE &&
                            mangaSummary.lineCount > 3
                    }
                }
            }
            mangaStatus.text = buildString {
                append(book.contentType.name)
                append(" • ")
                append(bookProgressLabel(context, book, state.progress, structure))
            }
            chapterLayout.isVisible = true
            chaptersTitle.text = context.getString(MR.plurals.chapters_plural, visibleCount, visibleCount)
            filtersText.text = listOfNotNull(
                when (state.readFilter) {
                    Manga.CHAPTER_SHOW_READ -> context.getString(MR.strings.read)
                    Manga.CHAPTER_SHOW_UNREAD -> context.getString(MR.strings.unread)
                    else -> null
                },
                when (state.bookmarkFilter) {
                    Manga.CHAPTER_SHOW_BOOKMARKED -> context.getString(MR.strings.bookmarked)
                    Manga.CHAPTER_SHOW_NOT_BOOKMARKED -> context.getString(MR.strings.not_bookmarked)
                    else -> null
                },
            ).joinToString(", ")
            filterButton.isVisible = true
            filterButton.setOnClickListener { onFilter() }
            chapterLayout.setOnClickListener { onFilter() }
        }

        /** MangaHeaderHolder's checked favorite: a tonal fill from the accent and no outline. */
        private fun MaterialButton.checked() {
            stateListAnimator = AnimatorInflater.loadStateListAnimator(context, R.animator.icon_btn_state_list_anim)
            backgroundTintList = ColorStateList.valueOf(
                ColorUtils.blendARGB(
                    accentColor ?: context.getResourceColor(materialR.attr.colorSecondary),
                    context.getResourceColor(android.R.attr.colorBackground),
                    0.88f,
                ),
            )
            strokeColor = ColorStateList.valueOf(Color.TRANSPARENT)
        }

        private fun resetCoverTreatment() {
            veil.reset()
            accentColor = null
            val context = binding.root.context
            binding.trueBackdrop.setBackgroundColor(context.getResourceColor(android.R.attr.colorBackground))
            val defaultTint = ColorStateList.valueOf(context.getResourceColor(materialR.attr.colorSecondary))
            binding.webviewButton.imageTintList = defaultTint
            binding.shareButton.imageTintList = defaultTint
            binding.recsButton.imageTintList = defaultTint
            binding.filterButton.imageTintList = defaultTint
            binding.favoriteButton.iconTint = defaultTint
            binding.favoriteButton.checked()
            TextViewCompat.setCompoundDrawableTintList(binding.moreButton, defaultTint)
            binding.moreButton.setTextColor(defaultTint)
            TextViewCompat.setCompoundDrawableTintList(binding.lessButton, defaultTint)
            binding.lessButton.setTextColor(defaultTint)
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
            this.accentColor = accentColor
            val accent = ColorStateList.valueOf(accentColor)
            binding.trueBackdrop.setBackgroundColor(backdropColor)
            binding.webviewButton.imageTintList = accent
            binding.shareButton.imageTintList = accent
            binding.recsButton.imageTintList = accent
            binding.filterButton.imageTintList = accent
            binding.favoriteButton.iconTint = accent
            binding.favoriteButton.checked()
            TextViewCompat.setCompoundDrawableTintList(binding.moreButton, accent)
            binding.moreButton.setTextColor(accentColor)
            TextViewCompat.setCompoundDrawableTintList(binding.lessButton, accent)
            binding.lessButton.setTextColor(accentColor)
        }
    }

    class ChapterHolder(
        val binding: ChaptersItemBinding,
        private val book: LocalBook,
        private val structure: BookStructure?,
        onClick: (Int) -> Unit,
        onLongClick: (Int) -> Unit,
    ) : RecyclerView.ViewHolder(binding.root) {

        var chapterIndex = -1
            private set

        init {
            binding.root.setOnClickListener { onClick(chapterIndex) }
            binding.root.setOnLongClickListener {
                onLongClick(chapterIndex)
                true
            }
        }

        fun bind(
            index: Int,
            title: String,
            state: ChapterListState,
            chapterProgress: BookChapterProgress,
        ) = with(binding) {
            chapterIndex = index
            val context = root.context
            val isRead = chapterProgress.isRead(index, state.chapterState)
            val isBookmarked = index in state.chapterState.bookmarks
            val isCurrent = index == chapterProgress.resumableChapter(state.chapterState, state.progress)
            val readColor = context.contextCompatColor(R.color.read_chapter)
            val unreadColor = context.getResourceColor(materialR.attr.colorOnSurface)
            chapterTitle.text = title
            chapterTitle.setTextColor(if (isRead) readColor else unreadColor)
            chapterScanlator.setTextColor(if (isRead) readColor else ColorUtils.setAlphaComponent(unreadColor, 198))
            ChapterUtil.setBookmark(chapterTitle, isBookmarked)
            val accent = state.accent
            if (isBookmarked && accent != null) {
                TextViewCompat.setCompoundDrawableTintList(chapterTitle, ColorStateList.valueOf(accent))
            }
            val statuses = listOfNotNull(
                chapterSummary(context, index),
                resumeNote(context, state.progress).takeIf { isCurrent },
            )
            chapterScanlator.text = statuses.joinToString(" • ")
            read.setImageResource(if (isRead) R.drawable.ic_eye_off_24dp else R.drawable.ic_eye_24dp)
            bookmark.setImageResource(if (isBookmarked) R.drawable.ic_bookmark_off_24dp else R.drawable.ic_bookmark_24dp)
            startView.backgroundTintList = ColorStateList.valueOf(
                accent ?: context.getResourceColor(materialR.attr.colorSecondary),
            )
            bookmark.imageTintList = ColorStateList.valueOf(context.getResourceColor(AR.attr.textColorPrimaryInverse))
            frontView.translationX = 0f
            startView.isVisible = false
            endView.isVisible = false
            translationButton.isVisible = false
            downloadButton.root.isVisible = false
            root.contentDescription = title
            root.isActivated = index in state.selectedChapters
        }

        /** Only a PDF section has something to add here: its page range. Otherwise a row is its title, as in novels. */
        private fun chapterSummary(context: android.content.Context, index: Int): String? {
            if (book.contentType != ContentType.PDF) return null
            val chapterCount = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
            val totalPages = (structure?.pageCount ?: book.pageCount)?.coerceAtLeast(1) ?: return null
            if (chapterCount == 1) return null
            val anchors = structure?.chapterStartPages.orEmpty()
            val firstPage = BookChapterMetrics.pageIndexForChapter(index, totalPages, chapterCount, anchors) + 1
            val nextPage = if (index + 1 < chapterCount) {
                BookChapterMetrics.pageIndexForChapter(index + 1, totalPages, chapterCount, anchors)
            } else {
                totalPages
            }
            val lastPage = nextPage.coerceAtLeast(firstPage)
            if (lastPage == firstPage) return context.getString(MR.strings.page_x_of_y, firstPage, totalPages)
            return context.getString(MR.strings.local_book_page_range, firstPage, lastPage, totalPages)
        }

        /**
         * Comics' in-progress note: the page for a PDF, and for an EPUB the share of the chapter.
         * A position set from this list starts its chapter, so it has no note.
         */
        private fun resumeNote(context: android.content.Context, progress: ReaderLocator?): String? = when (val current = progress) {
            is ReaderLocator.Pdf -> {
                val totalPages = (structure?.pageCount ?: book.pageCount ?: current.totalPages)?.coerceAtLeast(1)
                totalPages?.let { context.getString(MR.strings.page_x_of_y, current.pageIndex + 1, it) }
            }

            is ReaderLocator.Epub -> BookChapterMetrics.epubChapterProgression(current.cfi)
                ?.let { (it * 100).roundToInt().coerceIn(0, 100) }
                ?.takeIf { it > 0 }
                ?.let { context.getString(MR.strings.local_book_progress_percent, it) }

            else -> null
        }

    }

    private companion object {
        const val VIEW_TYPE_HEADER = 0
        const val VIEW_TYPE_CHAPTER = 1
        const val PAYLOAD_LIST = "list"
    }
}
