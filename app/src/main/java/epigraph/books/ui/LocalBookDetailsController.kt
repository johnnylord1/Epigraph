package epigraph.books.ui

import android.animation.AnimatorInflater
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
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
import eu.kanade.tachiyomi.databinding.MangaDetailsControllerBinding
import eu.kanade.tachiyomi.databinding.MangaHeaderItemBinding
import eu.kanade.tachiyomi.ui.base.SmallToolbarInterface
import eu.kanade.tachiyomi.ui.base.controller.BaseLegacyController
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.ui.manga.CoverVeil
import eu.kanade.tachiyomi.ui.manga.DetailsCoverPlaceholder
import eu.kanade.tachiyomi.ui.manga.MangaDetailsDivider
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
import kotlin.math.max
import kotlin.math.roundToInt
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.util.system.materialAlertDialog
import yokai.i18n.MR
import yokai.presentation.theme.ReducedMotion
import yokai.util.coil.CropBottomTransformation
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
            updateFab()
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
            val context = view?.context ?: return@setOnQueryTextChangeListener true
            detailsAdapter?.setFilter(context, query.orEmpty())
            tabletDetailsAdapter?.setFilter(context, query.orEmpty())
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
                    updateVeil(recyclerView)
                }

                override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
                    updateToolbarTitleAlpha()
                    if (!isTablet) updateVeil(recyclerView)
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
        onLibrary = ::showLibraryPopup,
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
        updateFab()
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
        updateFab()
        setTitle()
    }

    /** Same labels as the Comics FAB: start, or continue at the chapter the saved position is in. */
    private fun updateFab() {
        val context = view?.context ?: return
        val loaded = book ?: return
        val current = progress?.takeUnless { it.isAtStart() }
        val chapter = current?.let { currentChapterIndex(loaded, structure, it) }
        val singleChapter = (structure?.chapterCount ?: loaded.chapterCount ?: 1) <= 1
        binding.fab.text = when {
            current == null && singleChapter -> context.getString(MR.strings.start_reading)
            current == null -> context.getString(MR.strings.start_reading_chapter_, "1")
            chapter == null || singleChapter -> context.getString(MR.strings.continue_reading)
            else -> context.getString(MR.strings.continue_reading_chapter_, (chapter + 1).toString())
        }
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
                        .onSuccess { router.popController(this@LocalBookDetailsController) }
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

/**
 * A position still on the first page is where a fresh book opens, so like an unstarted comic it
 * offers "Start reading" and marks nothing as read.
 */
private fun ReaderLocator.isAtStart(): Boolean = when (this) {
    is ReaderLocator.Epub -> (progression * 100).roundToInt() == 0
    is ReaderLocator.Pdf -> pageIndex == 0
    else -> false
}

/**
 * The chapter the saved position falls in, resolved exactly as the reader does, so the FAB label,
 * the dimmed rows and the resume note agree with where the reader will open.
 */
private fun currentChapterIndex(book: LocalBook, structure: BookStructure?, progress: ReaderLocator): Int? {
    val chapterCount = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
    return when (progress) {
        is ReaderLocator.Epub -> BookChapterMetrics.epubChapterIndex(
            progress,
            chapterCount,
            structure?.chapterPaths.orEmpty(),
        )

        is ReaderLocator.Pdf -> {
            val totalPages = (structure?.pageCount ?: book.pageCount ?: progress.totalPages ?: 1).coerceAtLeast(1)
            BookChapterMetrics.chapterIndexForPage(
                progress.pageIndex,
                totalPages,
                chapterCount,
                structure?.chapterStartPages.orEmpty(),
            )
        }

        else -> null
    }
}

private class LocalBookDetailsAdapter(
    private val book: LocalBook,
    private val progress: ReaderLocator?,
    private val structure: BookStructure?,
    private val onLibrary: (View) -> Unit,
    private val onChapter: (ReaderLocator) -> Unit,
    private val onBookmarks: () -> Unit,
    private val onHighlights: () -> Unit,
    private val onFileInfo: () -> Unit,
    private val onPalette: ((Int) -> Unit)?,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    private val currentIndex: Int? = progress
        ?.takeUnless { it.isAtStart() }
        ?.let { currentChapterIndex(book, structure, it) }

    /** Catalog titles, or null entries for chapters without one (labelled per locale on bind). */
    private val catalogTitles: List<String?> = structure?.chapterTitles.orEmpty().ifEmpty {
        val count = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
        List(count) { null }
    }
    private var visibleChapterIndexes: List<Int> = catalogTitles.indices.toList()

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder = when (viewType) {
        VIEW_TYPE_HEADER -> Holder(
            MangaHeaderItemBinding.inflate(LayoutInflater.from(parent.context), parent, false),
            onLibrary,
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
            currentIndex = currentIndex,
            onChapter = onChapter,
        )
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        if (position == 0) {
            (holder as Holder).bind(book, progress, structure, catalogTitles.size)
        } else {
            val chapterIndex = visibleChapterIndexes[position - 1]
            (holder as ChapterHolder).bind(
                index = chapterIndex,
                title = titleFor(holder.itemView.context, chapterIndex),
            )
        }
    }

    private fun titleFor(context: android.content.Context, index: Int): String =
        catalogTitles[index] ?: context.getString(MR.strings.chapter_, (index + 1).toString())

    override fun getItemViewType(position: Int): Int =
        if (position == 0) VIEW_TYPE_HEADER else VIEW_TYPE_CHAPTER

    override fun getItemCount(): Int = visibleChapterIndexes.size + 1

    fun setFilter(context: android.content.Context, query: String) {
        val normalized = query.trim()
        visibleChapterIndexes = if (normalized.isEmpty()) {
            catalogTitles.indices.toList()
        } else {
            catalogTitles.indices.filter { index ->
                titleFor(context, index).contains(normalized, ignoreCase = true)
            }
        }
        notifyDataSetChanged()
    }

    class Holder(
        private val binding: MangaHeaderItemBinding,
        private val onLibrary: (View) -> Unit,
        private val onBookmarks: () -> Unit,
        private val onHighlights: () -> Unit,
        private val onFileInfo: () -> Unit,
        private val onPalette: ((Int) -> Unit)?,
    ) : RecyclerView.ViewHolder(binding.root) {

        /** The same veil Comics and Novels use (DESIGN.md §6). */
        private val veil = CoverVeil(binding.backdrop)
        private var accentColor: Int? = null

        fun onVeilScrolled(scrolled: Int) = veil.onScrolled(scrolled)

        fun setTopHeight(height: Int) {
            binding.topView.updateLayoutParams<androidx.constraintlayout.widget.ConstraintLayout.LayoutParams> {
                this.height = height
            }
        }

        fun bind(
            book: LocalBook,
            progress: ReaderLocator?,
            structure: BookStructure?,
            chapterCount: Int,
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
            mangaStatus.text = buildString {
                append(book.contentType.name)
                append(" • ")
                append(bookProgressLabel(context, book, progress, structure))
            }
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
            chapterLayout.isVisible = chapterCount > 0
            chaptersTitle.text = context.getString(
                MR.plurals.chapters_plural,
                chapterCount,
                chapterCount,
            )
            // INVISIBLE, not GONE: the title/filters chain would otherwise center the count label.
            filtersText.text = null
            filtersText.isInvisible = true
            filterButton.isVisible = false
            chapterLayout.setOnClickListener(null)
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
            binding.favoriteButton.iconTint = accent
            binding.favoriteButton.checked()
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
        private val currentIndex: Int?,
        private val onChapter: (ReaderLocator) -> Unit,
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(index: Int, title: String) = with(binding) {
            val context = root.context
            // Comics dims read chapters; a book has one position, so everything before the
            // chapter it sits in reads as read, and that chapter carries the resume note.
            val read = currentIndex != null && index < currentIndex
            val readColor = context.contextCompatColor(R.color.read_chapter)
            val unreadColor = context.getResourceColor(materialR.attr.colorOnSurface)
            chapterTitle.text = title
            chapterTitle.setTextColor(if (read) readColor else unreadColor)
            chapterScanlator.setTextColor(if (read) readColor else ColorUtils.setAlphaComponent(unreadColor, 198))
            val statuses = listOfNotNull(
                chapterSummary(context, index),
                resumeNote(context).takeIf { index == currentIndex },
            )
            chapterScanlator.text = statuses.joinToString(" • ")
            translationButton.isVisible = false
            downloadButton.root.isVisible = false
            root.contentDescription = title
            root.setOnClickListener { onChapter(locatorFor(index)) }
            root.isActivated = false
        }

        private fun chapterSummary(context: android.content.Context, index: Int): String {
            val chapterCount = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)
            if (book.contentType != ContentType.PDF) {
                return context.getString(MR.strings.chapter_x_of_y, index + 1, chapterCount)
            }
            val totalPages = (structure?.pageCount ?: book.pageCount)?.coerceAtLeast(1)
                ?: return context.getString(MR.strings.chapter_x_of_y, index + 1, chapterCount)
            if (chapterCount == 1) return context.getString(MR.plurals.pages_plural, totalPages, totalPages)
            val anchors = structure?.chapterStartPages.orEmpty()
            val firstPage = BookChapterMetrics.pageIndexForChapter(index, totalPages, chapterCount, anchors) + 1
            val nextPage = if (index + 1 < chapterCount) {
                BookChapterMetrics.pageIndexForChapter(index + 1, totalPages, chapterCount, anchors)
            } else {
                totalPages
            }
            return context.getString(
                MR.strings.local_book_page_range,
                firstPage,
                nextPage.coerceAtLeast(firstPage),
                totalPages,
            )
        }

        /**
         * Comics' in-progress note: the page for a PDF, and for an EPUB the share of the whole
         * book, the only progress its locator records.
         */
        private fun resumeNote(context: android.content.Context): String? = when (val current = progress) {
            is ReaderLocator.Pdf -> {
                val totalPages = (structure?.pageCount ?: book.pageCount ?: current.totalPages)?.coerceAtLeast(1)
                totalPages?.let { context.getString(MR.strings.page_x_of_y, current.pageIndex + 1, it) }
            }

            is ReaderLocator.Epub -> context.getString(
                MR.strings.local_book_progress_percent,
                (current.progression * 100).roundToInt().coerceIn(0, 100),
            )

            else -> null
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
    }

    private companion object {
        const val VIEW_TYPE_HEADER = 0
        const val VIEW_TYPE_CHAPTER = 1
    }
}
