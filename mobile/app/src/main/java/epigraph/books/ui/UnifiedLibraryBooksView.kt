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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import eu.kanade.tachiyomi.ui.library.LibraryPlaceholderItem
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.interactor.GetCategories
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
        // A lone section: the header shows only the sort row, never a "Default" title.
        isAlone = true
        isSystem = true
        mangaSort = LibrarySort.Title.categoryValue
    }
    private val booksHeader = LibraryHeaderItem({ booksCategory }, BOOKS_CATEGORY_ID)

    /**
     * Headers for the user's categories. They exist only while the collection spans more than one
     * category; a single category keeps the untitled [booksCategory] section, like a lone Comics
     * category. Ids live in their own negative namespace so they never collide with Comics ids.
     */
    private val groupCategories = mutableMapOf<Int, Category>()
    private val groupHeaders = mutableMapOf<Int, LibraryHeaderItem>()
    private var userCategories: List<Category> = emptyList()
    private var bookCategoryIds: Map<String, List<Int>> = emptyMap()
    private val categoryRevision = MutableStateFlow(0)

    private var collectionJob: Job? = null
    private var books: List<epigraph.books.local.LocalBook> = emptyList()

    /** One row per (novel, category), as the library view returns them. */
    private var novels: List<LibraryManga> = emptyList()
    private var selectedType = TypeFilter.ALL
    private var query = ""
    private var booksFilterStates: Map<Char, Int> = emptyMap()
    private var bookProgress: Map<String, Double> = emptyMap()
    private var bookmarkedBooks: Set<String> = emptySet()
    private var downloadedNovels: Set<Long> = emptySet()
    private var trackedNovels: Set<Long> = emptySet()

    private val downloadManager: DownloadManager by injectLazy()
    private val trackManager: TrackManager by injectLazy()
    private val getTrack: GetTrack by injectLazy()
    private val getCategories: GetCategories by injectLazy()

    /**
     * Real category ids (0 = Default) shown as sections. Like the Comics library, every Books &
     * novels category keeps its header (empty ones show "Category is empty"); Default only appears
     * while it holds a book or novel. Comics folders are never listed here.
     */
    private val presentCategoryIds: List<Int>
        get() {
            val known = userCategories.mapNotNull { it.id }.toSet()
            fun normalize(id: Int) = if (id in known) id else 0
            val occupied = (
                novels.map { normalize(it.category) } +
                    books.flatMap { book -> bookCategoryIds[book.bookId].orEmpty().ifEmpty { listOf(0) } }
                        .map(::normalize)
                ).distinct()
            if (occupied.isEmpty()) return occupied
            return (occupied + known.filter { it > 0 }).distinct()
        }

    /** Whether headers carry category names; false keeps the single untitled section. */
    val isGrouped: Boolean
        get() = presentCategoryIds.size > 1

    /** The categories a book may be assigned to, in library order. */
    val assignableCategories: List<Category>
        get() = userCategories.filter { (it.id ?: 0) > 0 }

    val hasActiveTypeFilter: Boolean
        get() = selectedType != TypeFilter.ALL

    val hasActiveFilters: Boolean
        get() = hasActiveTypeFilter || booksFilterStates.values.any { it != FILTER_IGNORE }

    /** False until the first collection snapshot is rendered, so "empty" is not claimed early. */
    var hasLoadedCollection: Boolean = false
        private set

    /** Source-of-truth collection state; adapter headers/placeholders are not book content. */
    val isCollectionEmpty: Boolean
        get() = books.isEmpty() && novels.isEmpty()

    fun bind(scope: CoroutineScope) {
        collectionJob?.cancel()
        collectionJob = scope.launch {
            combine(
                localBookRepository.observeBooks(),
                mangaRepository.getLibraryMangaAsFlow(),
                // Novel plugins load lazily; reclassify once their sources resolve.
                sourceManager.libraryClassificationChanges,
                getCategories.subscribe(CategoryLibrary.BOOKS),
                // Book category links live in their own table; assignments bump this revision.
                categoryRevision,
            ) { local, library, _, categories, _ ->
                Triple(
                    local,
                    library.filter { manga ->
                        runCatching { manga.manga.isNovel(sourceManager) }.getOrDefault(false)
                    },
                    categories,
                )
            }.collectLatest { (local, libraryNovels, categories) ->
                books = local
                novels = libraryNovels
                userCategories = categories.sortedBy { it.order }
                val snapshots = withContext(Dispatchers.IO) {
                    localBookRepository.snapshotForBackup()
                }
                bookCategoryIds = snapshots.associate { snapshot ->
                    snapshot.book.bookId to snapshot.categoryIds.map { it.toInt() }
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
                hasLoadedCollection = true
                submitItems()
            }
        }
    }

    fun cancel() {
        collectionJob?.cancel()
        collectionJob = null
    }

    /** Re-read book category links after the user assigns categories. */
    fun reloadCategories() {
        categoryRevision.value++
    }

    fun categoryIdsOf(bookId: String): List<Int> = bookCategoryIds[bookId].orEmpty()

    fun isBooksHeader(catId: Int?): Boolean =
        catId == BOOKS_CATEGORY_ID || (catId != null && catId <= GROUP_ID_BASE)

    /** The real Books & novels folder behind a group header; null for Default or the lone section. */
    fun realCategory(catId: Int?): Category? {
        if (catId == null || catId > GROUP_ID_BASE) return null
        val realId = GROUP_ID_BASE - catId
        return userCategories.firstOrNull { it.id == realId && realId > 0 }
    }

    /** Novels a header's refresh button updates; EPUB/PDF have no remote chapters. */
    fun novelsFor(catId: Int?): List<LibraryManga> {
        val rows = when (catId) {
            BOOKS_CATEGORY_ID -> novels
            null -> emptyList()
            else -> {
                val known = userCategories.mapNotNull { it.id }.toSet()
                val realId = GROUP_ID_BASE - catId
                novels.filter { (if (it.category in known) it.category else 0) == realId }
            }
        }
        return rows.distinctBy { it.manga.id }
    }

    fun allNovels(): List<LibraryManga> = novels.distinctBy { it.manga.id }

    fun toggleGroup(catId: Int) {
        if (catId > GROUP_ID_BASE) return
        val key = (GROUP_ID_BASE - catId).toString()
        val collapsed = preferences.collapsedBooksCategories().get().toMutableSet()
        if (!collapsed.remove(key)) collapsed.add(key)
        preferences.collapsedBooksCategories().set(collapsed)
        submitItems()
    }

    /** Whether every category group is expanded; null when there is nothing to collapse. */
    fun allGroupsExpanded(): Boolean? {
        if (!isGrouped) return null
        val collapsed = preferences.collapsedBooksCategories().get()
        return presentCategoryIds.none { it.toString() in collapsed }
    }

    fun setAllGroupsCollapsed(collapse: Boolean) {
        preferences.collapsedBooksCategories().set(
            if (collapse) presentCategoryIds.map { it.toString() }.toSet() else emptySet(),
        )
        submitItems()
    }

    /** Header count: a collapsed group shows one placeholder row, not its real size. */
    fun itemCount(catId: Int): Int? = lastCounts[catId]

    private var lastCounts: Map<Int, Int> = emptyMap()

    private fun groupHeader(realId: Int): LibraryHeaderItem {
        val headerId = GROUP_ID_BASE - realId
        val source = userCategories.firstOrNull { it.id == realId }
        val category = groupCategories.getOrPut(headerId) { Category.create("") }.apply {
            id = headerId
            name = source?.name ?: context.getString(MR.strings.default_value)
            // Default is listed first, as in the Comics library.
            order = if (realId == 0) -1 else source?.order ?: Int.MAX_VALUE
            isAlone = false
            isSystem = true
            mangaSort = booksCategory.mangaSort
            isHidden = realId.toString() in preferences.collapsedBooksCategories().get()
        }
        return groupHeaders.getOrPut(headerId) { LibraryHeaderItem({ category }, headerId) }
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

    /** Apply the same category-sort choice exposed by the Comics header row. */
    fun sortCategory(sortBy: Char) {
        val mode = LibrarySort.valueOf(sortBy) ?: LibrarySort.Title
        booksCategory.mangaSort = sortBy
        groupCategories.values.forEach { it.mangaSort = sortBy }
        submitItems(mode)
    }

    fun refresh() = submitItems()

    fun showStatus(message: String) = onStatus(message)

    private fun submitItems(mode: LibrarySort = LibrarySort.valueOf(booksCategory.mangaSort) ?: LibrarySort.Title) {
        val grouped = isGrouped
        val known = userCategories.mapNotNull { it.id }.toSet()
        fun headerFor(realId: Int) = if (grouped) groupHeader(if (realId in known) realId else 0) else booksHeader
        val entries = buildList<LibraryItem> {
            if (selectedType == TypeFilter.ALL || selectedType == TypeFilter.NOVELS) {
                // The library view has one row per (novel, category); one section shows it once.
                val rows = if (grouped) novels else novels.distinctBy { it.manga.id }
                rows.forEach {
                    val item = LibraryMangaItem(it, headerFor(it.category), context)
                    if (matchesFilters(item)) add(item)
                }
            }
            if (selectedType == TypeFilter.ALL || selectedType == TypeFilter.EPUB || selectedType == TypeFilter.PDF) {
                books.filter { book ->
                    selectedType == TypeFilter.ALL ||
                        (selectedType == TypeFilter.EPUB && book.contentType.name == "EPUB") ||
                        (selectedType == TypeFilter.PDF && book.contentType.name == "PDF")
                }.forEach { book ->
                    val categoryIds = if (grouped) bookCategoryIds[book.bookId].orEmpty().ifEmpty { listOf(0) } else listOf(0)
                    categoryIds.map(::headerFor).distinct().forEach { header ->
                        val item = LibraryBookItem(book, header, context)
                        if (matchesFilters(item)) add(item)
                    }
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

        val sections = if (grouped) {
            // Every present category keeps its header, even when filters empty it, like Comics.
            val byHeader = sorted.groupBy { it.sectionHeader.catId }
            presentCategoryIds
                .map { groupHeader(it) }
                .sortedBy { it.category.order }
                .flatMap { header ->
                    val items = byHeader[header.catId].orEmpty()
                    when {
                        header.category.isHidden -> listOf(
                            LibraryPlaceholderItem.hidden(
                                header.catId,
                                header,
                                context,
                                items.joinToString("\n") { item ->
                                    when (item) {
                                        is LibraryMangaItem -> item.manga.manga.title
                                        is LibraryBookItem -> item.book.displayName
                                        else -> ""
                                    }
                                },
                                items.filterIsInstance<LibraryMangaItem>(),
                            ),
                        )
                        items.isEmpty() -> listOf(LibraryPlaceholderItem.blank(header.catId, header, context))
                        else -> items
                    }
                }
        } else {
            sorted
        }
        lastCounts = sorted.groupingBy { it.sectionHeader.catId }.eachCount()

        libraryAdapter.setItems(sections)
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

        /** Group header id = GROUP_ID_BASE - real category id (Default 0 -> -1000). */
        const val GROUP_ID_BASE = -1000

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
