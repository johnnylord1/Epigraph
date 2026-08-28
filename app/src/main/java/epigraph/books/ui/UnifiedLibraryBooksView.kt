package epigraph.books.ui

import android.content.Context
import epigraph.books.local.LocalBookRepository
import epigraph.contract.ReaderLocator
import eu.kanade.tachiyomi.data.database.models.Category
import eu.kanade.tachiyomi.data.database.models.LibraryManga
import eu.kanade.tachiyomi.data.database.models.isNovel
import eu.kanade.tachiyomi.data.download.DownloadManager
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.ui.library.LibraryBookItem
import eu.kanade.tachiyomi.ui.library.LibraryCategoryAdapter
import eu.kanade.tachiyomi.ui.library.LibraryController
import eu.kanade.tachiyomi.ui.library.LibraryHeaderItem
import eu.kanade.tachiyomi.ui.library.LibraryItem
import eu.kanade.tachiyomi.ui.library.LibraryMangaItem
import eu.kanade.tachiyomi.ui.library.LibrarySort
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import yokai.domain.manga.MangaRepository
import yokai.domain.track.interactor.GetTrack
import yokai.domain.ui.UiPreferences
import yokai.util.isLewd
import yokai.util.koin.injectLazy
import yokai.i18n.MR
import yokai.util.lang.getString

/**
 * Data coordinator for the Books surface.
 *
 * This class deliberately has no layout of its own. Books/novels are submitted to the same
 * RecyclerView, app bar, search pill, category header, filter sheet and display-options sheet as
 * Comics. The only differences are the source collection and the additional type filter.
 */
class UnifiedLibraryBooksView(
    private val context: Context,
    private val libraryController: LibraryController,
    private val localBookRepository: LocalBookRepository,
    private val mangaRepository: MangaRepository,
    private val sourceManager: SourceManager,
    private val preferences: PreferencesHelper,
    private val uiPreferences: UiPreferences,
    private val onStatus: (String) -> Unit = {},
    private val onContentChanged: () -> Unit = {},
) {

    internal val libraryAdapter: LibraryCategoryAdapter = LibraryCategoryAdapter(libraryController).apply {
        // Books are a single category, but not a pager page. Keeping section headers enabled makes
        // the category title/sort row identical to the continuous Comics library.
        isPagedMode = false
        showOutline = uiPreferences.outlineOnCovers().get()
        showNumber = preferences.categoryNumberOfItems().get()
    }

    val category: Category
        get() = booksCategory

    private val booksCategory = Category.create(context.getString(MR.strings.default_value)).apply {
        id = BOOKS_CATEGORY_ID
        order = 0
        isAlone = false
        isSystem = true
        mangaSort = LibrarySort.Title.categoryValue
    }
    private val booksHeader = LibraryHeaderItem({ booksCategory }, BOOKS_CATEGORY_ID)

    private var collectionJob: Job? = null
    private var books: List<epigraph.books.local.LocalBook> = emptyList()
    private var novels: List<LibraryManga> = emptyList()
    private var selectedType = TypeFilter.ALL
    private var query = ""
    private var booksFilterStates: Map<Char, Int> = emptyMap()
    private var bookProgress: Map<String, Double> = emptyMap()
    private var bookmarkedBooks: Set<String> = emptySet()
    private var downloadedNovels: Set<Long> = emptySet()
    private var trackedNovels: Set<Long> = emptySet()
    private var categoryHidden = false

    private val downloadManager: DownloadManager by injectLazy()
    private val trackManager: TrackManager by injectLazy()
    private val getTrack: GetTrack by injectLazy()

    val hasActiveTypeFilter: Boolean
        get() = selectedType != TypeFilter.ALL

    val hasActiveFilters: Boolean
        get() = hasActiveTypeFilter || booksFilterStates.values.any { it != FILTER_IGNORE }

    val isCategoryHidden: Boolean
        get() = categoryHidden

    /** Source-of-truth collection state; adapter headers/placeholders are not book content. */
    val isCollectionEmpty: Boolean
        get() = books.isEmpty() && novels.isEmpty()

    fun bind(scope: CoroutineScope) {
        collectionJob?.cancel()
        collectionJob = scope.launch {
            combine(
                localBookRepository.observeBooks(),
                mangaRepository.getLibraryMangaAsFlow(),
            ) { local, library ->
                local to library.filter { manga ->
                    runCatching { manga.manga.isNovel(sourceManager) }.getOrDefault(false)
                }
            }.collectLatest { (local, libraryNovels) ->
                books = local
                novels = libraryNovels
                val snapshots = withContext(Dispatchers.IO) {
                    localBookRepository.snapshotForBackup()
                }
                bookProgress = snapshots.associate { it.book.bookId to it.progress.progressionOrZero() }
                bookmarkedBooks = snapshots
                    .filter { it.bookmarks.isNotEmpty() }
                    .map { it.book.bookId }
                    .toSet()
                downloadedNovels = withContext(Dispatchers.IO) {
                    libraryNovels.mapNotNull { libraryManga ->
                        libraryManga.manga.id?.takeIf {
                            downloadManager.getDownloadCount(libraryManga.manga) > 0
                        }
                    }.toSet()
                }
                trackedNovels = withContext(Dispatchers.IO) {
                    val loggedServices = trackManager.services
                        .filter { it.isLogged }
                        .map { it.id }
                        .toSet()
                    if (loggedServices.isEmpty()) {
                        emptySet()
                    } else {
                        getTrack.awaitAllGroupedByMangaId()
                            .filterValues { tracks -> tracks.any { it.sync_id in loggedServices } }
                            .keys
                    }
                }
                submitItems()
            }
        }
    }

    fun cancel() {
        collectionJob?.cancel()
        collectionJob = null
    }

    fun setQuery(value: String?) {
        query = value.orEmpty()
        libraryAdapter.setFilter(query)
        libraryAdapter.requestFilter()
    }

    /** Called by the shared Library filter sheet. Empty/null means all book types. */
    fun setTypeFilter(value: String?) {
        selectedType = when (value?.uppercase()) {
            "NOVELS" -> TypeFilter.NOVELS
            "EPUB" -> TypeFilter.EPUB
            "PDF" -> TypeFilter.PDF
            else -> TypeFilter.ALL
        }
        submitItems()
    }

    /** Applies a common library filter without writing to the Comics preference store. */
    fun setFilter(key: Char, state: Int) {
        val states = booksFilterStates.toMutableMap()
        if (state == FILTER_IGNORE) states.remove(key) else states[key] = state
        if (key == FILTER_UNREAD || key == FILTER_UNREAD_PROGRESS) {
            val other = if (key == FILTER_UNREAD) FILTER_UNREAD_PROGRESS else FILTER_UNREAD
            if (state != FILTER_IGNORE) states.remove(other)
        }
        booksFilterStates = states
        submitItems()
    }

    fun clearFilters() {
        booksFilterStates = emptyMap()
        selectedType = TypeFilter.ALL
        submitItems()
    }

    fun toggleCategoryVisibility() {
        setCategoryHidden(!categoryHidden)
    }

    fun setCategoryHidden(hidden: Boolean) {
        if (categoryHidden == hidden) return
        categoryHidden = hidden
        booksCategory.isHidden = hidden
        submitItems()
    }

    /** Apply the same category-sort choice exposed by the Comics header row. */
    fun sortCategory(sortBy: Char) {
        val mode = LibrarySort.valueOf(sortBy) ?: LibrarySort.Title
        booksCategory.mangaSort = sortBy
        submitItems(mode)
    }

    fun refresh() = submitItems()

    fun showStatus(message: String) = onStatus(message)

    private fun submitItems(mode: LibrarySort = LibrarySort.valueOf(booksCategory.mangaSort) ?: LibrarySort.Title) {
        val entries = buildList<LibraryItem> {
            if (categoryHidden) {
                // Keep the normal section header in the adapter while hiding its content. The
                // shared placeholder is deliberately empty so Books behaves like a collapsed
                // Comics category instead of disappearing and losing the expansion affordance.
                add(
                    eu.kanade.tachiyomi.ui.library.LibraryPlaceholderItem.hidden(
                        BOOKS_CATEGORY_ID,
                        booksHeader,
                        context,
                        "",
                        emptyList(),
                    ),
                )
                return@buildList
            }
            if (selectedType == TypeFilter.ALL || selectedType == TypeFilter.NOVELS) {
                novels.forEach {
                    val item = LibraryMangaItem(it, booksHeader, context)
                    if (matchesFilters(item)) add(item)
                }
            }
            if (selectedType == TypeFilter.ALL || selectedType == TypeFilter.EPUB || selectedType == TypeFilter.PDF) {
                books.filter { book ->
                    selectedType == TypeFilter.ALL ||
                        (selectedType == TypeFilter.EPUB && book.contentType.name == "EPUB") ||
                        (selectedType == TypeFilter.PDF && book.contentType.name == "PDF")
                }.forEach {
                    val item = LibraryBookItem(it, booksHeader, context)
                    if (matchesFilters(item)) add(item)
                }
            }
        }

        val sorted = when (mode) {
            LibrarySort.Random -> entries.shuffled()
            LibrarySort.DateAdded -> entries.sortedBy { item ->
                when (item) {
                    is LibraryBookItem -> item.book.importedAt
                    is LibraryMangaItem -> item.manga.manga.date_added
                    else -> 0L
                }
            }
            LibrarySort.LastRead -> entries.sortedBy { item ->
                (item as? LibraryMangaItem)?.manga?.lastRead ?: 0L
            }
            LibrarySort.DateFetched,
            LibrarySort.LatestChapter,
            LibrarySort.NextExpectedUpdate,
            -> entries.sortedBy { item ->
                when (item) {
                    is LibraryBookItem -> item.book.updatedAt
                    is LibraryMangaItem -> item.manga.lastFetch
                    else -> 0L
                }
            }
            LibrarySort.Unread -> entries.sortedBy { item ->
                when (item) {
                    is LibraryMangaItem -> item.manga.unread
                    is LibraryBookItem -> if (bookProgress[item.book.bookId].orZero() < 1.0) 1 else 0
                    else -> 0
                }
            }
            LibrarySort.TotalChapters -> entries.sortedBy { item ->
                (item as? LibraryMangaItem)?.manga?.totalChapters ?: 0
            }
            LibrarySort.DragAndDrop,
            LibrarySort.Title,
            -> entries.sortedBy { item ->
                when (item) {
                    is LibraryBookItem -> item.book.displayName.lowercase()
                    is LibraryMangaItem -> item.manga.manga.title.lowercase()
                    else -> ""
                }
            }
        }.let { values ->
            if (booksCategory.isAscending() || mode == LibrarySort.Random || mode == LibrarySort.DragAndDrop) {
                values
            } else {
                values.reversed()
            }
        }

        libraryAdapter.setItems(sorted)
        libraryAdapter.setFilter(query)
        libraryAdapter.requestFilter()
        onContentChanged()
    }

    private fun matchesFilters(item: LibraryItem): Boolean {
        val state = { key: Char -> booksFilterStates[key] ?: FILTER_IGNORE }
        val downloaded = when (item) {
            is LibraryBookItem -> item.book.isAvailable
            is LibraryMangaItem -> item.manga.manga.id?.let(downloadedNovels::contains) == true
            else -> false
        }
        val unread = when (item) {
            is LibraryBookItem -> bookProgress[item.book.bookId].orZero() < 1.0
            is LibraryMangaItem -> item.manga.unread > 0
            else -> false
        }
        val started = when (item) {
            is LibraryBookItem -> bookProgress[item.book.bookId].orZero() > 0.0
            is LibraryMangaItem -> item.manga.unread > 0 && item.manga.hasRead
            else -> false
        }
        val completed = when (item) {
            is LibraryBookItem -> bookProgress[item.book.bookId].orZero() >= 1.0
            is LibraryMangaItem -> item.manga.manga.status == SManga.COMPLETED
            else -> false
        }
        val bookmarked = when (item) {
            is LibraryBookItem -> item.book.bookId in bookmarkedBooks
            is LibraryMangaItem -> item.manga.bookmarkCount > 0
            else -> false
        }
        val customInterval = (item as? LibraryMangaItem)?.manga?.manga?.fetch_interval?.let { it < 0 } ?: true
        val contentIsSafe = (item as? LibraryMangaItem)?.manga?.manga?.isLewd() != true
        val tracked = (item as? LibraryMangaItem)?.manga?.manga?.id?.let(trackedNovels::contains) == true

        fun matchesTriState(value: Boolean, filterState: Int): Boolean = when (filterState) {
            FILTER_INCLUDE -> value
            FILTER_EXCLUDE -> !value
            else -> true
        }

        if (!matchesTriState(downloaded, state(FILTER_DOWNLOADED))) return false
        if (!matchesTriState(unread, state(FILTER_UNREAD))) return false
        if (state(FILTER_UNREAD_PROGRESS) == FILTER_NOT_STARTED && !(unread && !started)) return false
        if (state(FILTER_UNREAD_PROGRESS) == FILTER_IN_PROGRESS && !(unread && started)) return false
        if (!matchesTriState(completed, state(FILTER_COMPLETED))) return false
        if (!matchesTriState(bookmarked, state(FILTER_BOOKMARKED))) return false
        if (!matchesTriState(customInterval, state(FILTER_CUSTOM_INTERVAL))) return false
        if (!matchesTriState(tracked, state(FILTER_TRACKED))) return false
        if (!matchesTriState(contentIsSafe, state(FILTER_CONTENT_TYPE))) return false
        return true
    }

    private fun ReaderLocator?.progressionOrZero(): Double = when (this) {
        is ReaderLocator.Epub -> progression
        is ReaderLocator.Pdf -> documentProgression ?: 0.0
        else -> 0.0
    }

    private fun Double?.orZero(): Double = this ?: 0.0

    enum class TypeFilter {
        ALL,
        NOVELS,
        EPUB,
        PDF,
    }

    companion object {
        const val BOOKS_CATEGORY_ID = -2

        const val FILTER_IGNORE = 0
        const val FILTER_INCLUDE = 1
        const val FILTER_EXCLUDE = 2
        const val FILTER_NOT_STARTED = 3
        const val FILTER_IN_PROGRESS = 4
        const val FILTER_UNREAD_PROGRESS = 'u'
        const val FILTER_UNREAD = 'r'
        const val FILTER_DOWNLOADED = 'd'
        const val FILTER_COMPLETED = 'c'
        const val FILTER_BOOKMARKED = 'b'
        const val FILTER_CUSTOM_INTERVAL = 'i'
        const val FILTER_TRACKED = 't'
        const val FILTER_CONTENT_TYPE = 's'
    }
}
