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
import eu.kanade.tachiyomi.ui.library.LibrarySortComparator
import eu.kanade.tachiyomi.ui.library.LibrarySortKey
import eu.kanade.tachiyomi.util.isLocal
import epigraph.content.activeBlockedTags
import epigraph.content.isBlockedGenreString
import kotlin.random.Random
import yokai.domain.library.LibraryPreferences
import exh.util.throttleLatest
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
        mangaSort = preferences.booksLibrarySort().get().firstOrNull()
            ?.takeIf { LibrarySort.valueOf(it) != null }
            ?: LibrarySort.Title.categoryValue
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
    private var novelDownloadCounts: Map<Long, Int> = emptyMap()

    /** Logged-in tracker ids per tracked novel. */
    private var novelTrackers: Map<Long, Set<Long>> = emptyMap()

    /** Tracker chosen under the Tracked filter; empty means any tracker, as in Comics. */
    private var trackerFilter = ""

    private val downloadManager: DownloadManager by injectLazy()
    private val trackManager: TrackManager by injectLazy()
    private val getTrack: GetTrack by injectLazy()
    private val getCategories: GetCategories by injectLazy()
    private val libraryPreferences: LibraryPreferences by injectLazy()

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
                // Book category links and novel downloads live outside the library tables, so
                // assignments and returns to the library bump this revision.
                categoryRevision,
            ) { local, library, _, categories, _ ->
                Triple(
                    local,
                    library.filter { manga ->
                        runCatching { manga.manga.isNovel(sourceManager) }.getOrDefault(false)
                    },
                    categories,
                )
            }
                // A sync writes works one at a time; rebuilding the shelf for each write makes it
                // flicker and stalls navigation.
                .throttleLatest(1_000L)
                .collectLatest { (local, libraryNovels, categories) ->
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
                novelDownloadCounts = withContext(Dispatchers.IO) {
                    libraryNovels.mapNotNull { libraryManga ->
                        libraryManga.manga.id?.let { it to downloadManager.getDownloadCount(libraryManga.manga) }
                    }.toMap()
                }
                novelTrackers = withContext(Dispatchers.IO) {
                    val loggedServices = trackManager.services
                        .filter { it.isLogged }
                        .map { it.id }
                        .toSet()
                    if (loggedServices.isEmpty()) {
                        emptyMap()
                    } else {
                        getTrack.awaitAllGroupedByMangaId()
                            .mapValues { (_, tracks) ->
                                tracks.map { it.sync_id }.filter { it in loggedServices }.toSet()
                            }
                            .filterValues { it.isNotEmpty() }
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

    /** Re-reads novel download counts, which change without a library write, as Comics does on return. */
    fun reload() {
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
            // Default is listed first, as in the Comics library. The category editor numbers
            // folders from -1, so Default sits below every real order instead of tying with one.
            order = if (realId == 0) Int.MIN_VALUE else source?.order ?: Int.MAX_VALUE
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

    /** Narrows the Tracked filter to one tracker by its name, like the Comics trackers row. */
    fun setTrackerFilter(name: String) {
        if (trackerFilter == name) return
        trackerFilter = name
        submitItems()
    }

    fun clearFilters() {
        booksFilterStates = emptyMap()
        trackerFilter = ""
        selectedType = TypeFilter.ALL
        submitItems()
    }

    /** Apply the same category-sort choice exposed by the Comics header row. */
    fun sortCategory(sortBy: Char) {
        val mode = LibrarySort.valueOf(sortBy) ?: LibrarySort.Title
        booksCategory.mangaSort = sortBy
        groupCategories.values.forEach { it.mangaSort = sortBy }
        preferences.booksLibrarySort().set(sortBy.toString())
        if (mode == LibrarySort.Random) libraryPreferences.booksRandomSortSeed().set(Random.nextInt())
        submitItems(mode)
    }

    fun refresh() = submitItems()

    fun showStatus(message: String) = onStatus(message)

    private fun submitItems(mode: LibrarySort = LibrarySort.valueOf(booksCategory.mangaSort) ?: LibrarySort.Title) {
        val grouped = isGrouped
        val known = userCategories.mapNotNull { it.id }.toSet()
        fun headerFor(realId: Int) = if (grouped) groupHeader(if (realId in known) realId else 0) else booksHeader
        val blockedTags = activeBlockedTags(preferences.filterBlockedTags().get(), preferences.blockedTags().get())
        val trackerFilterId = trackerFilter.takeIf { it.isNotEmpty() }?.let { name ->
            trackManager.services.find { it.isLogged && context.getString(it.nameRes()) == name }?.id
        }
        val entries = buildList<LibraryItem> {
            if (selectedType == TypeFilter.ALL || selectedType == TypeFilter.NOVELS) {
                // The library view has one row per (novel, category); one section shows it once.
                val rows = if (grouped) novels else novels.distinctBy { it.manga.id }
                val items = rows
                    .filterNot { isBlockedGenreString(it.manga.genre, blockedTags) }
                    .map { LibraryMangaItem(it, headerFor(it.category), context) }
                libraryController.presenter.applyBadges(items) { manga ->
                    manga.id?.let(novelDownloadCounts::get) ?: 0
                }
                items.forEach { item ->
                    if (matchesFilters(item, trackerFilterId)) add(item)
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
                        if (matchesFilters(item, trackerFilterId)) add(item)
                    }
                }
            }
        }

        // Same order as the Comics library: shared comparator, title tie-break and random seed.
        val sorted = if (mode == LibrarySort.Random) {
            entries.shuffled(Random(libraryPreferences.booksRandomSortSeed().get()))
        } else {
            val ignoreArticles = preferences.removeArticles().get()
            val ascending = booksCategory.isAscending()
            entries
                .map { it to sortKeyOf(it) }
                .sortedWith { (_, k1), (_, k2) ->
                    LibrarySortComparator.compare(mode, ascending, k1, k2, ignoreArticles).takeIf { it != 0 }
                        ?: LibrarySortComparator.compareTitles(k1.sortTitle, k2.sortTitle, ignoreArticles)
                }
                .map { it.first }
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

    /** Sort values of a row; novels are [LibraryMangaItem]s, which already provide them. */
    private fun sortKeyOf(item: LibraryItem): LibrarySortKey = when (item) {
        is LibraryMangaItem -> item
        is LibraryBookItem -> BookSortKey(
            sortTitle = item.book.displayName,
            sortLatestUpdate = item.book.updatedAt,
            sortUnread = if (bookProgress[item.book.bookId].orZero() < 1.0) 1 else 0,
            sortTotalChapters = item.book.chapterCount ?: item.book.pageCount ?: 0,
            sortLastFetch = item.book.updatedAt,
            sortDateAdded = item.book.importedAt,
        )
        else -> BookSortKey(sortTitle = "")
    }

    private data class BookSortKey(
        override val sortTitle: String,
        override val sortLatestUpdate: Long = 0L,
        override val sortUnread: Int = 0,
        override val sortLastRead: Long = 0L,
        override val sortTotalChapters: Int = 0,
        override val sortLastFetch: Long = 0L,
        override val sortNextUpdate: Long = 0L,
        override val sortDateAdded: Long = 0L,
    ) : LibrarySortKey

    private fun matchesFilters(item: LibraryItem, trackerFilterId: Long?): Boolean {
        val state = { key: Char -> booksFilterStates[key] ?: FILTER_IGNORE }
        val downloaded = when (item) {
            is LibraryBookItem -> item.book.isAvailable
            is LibraryMangaItem -> item.manga.manga.isLocal() ||
                (item.manga.manga.id?.let(novelDownloadCounts::get) ?: 0) > 0
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
        val trackers = (item as? LibraryMangaItem)?.manga?.manga?.id?.let(novelTrackers::get).orEmpty()
        // With a tracker chosen, Tracked means tracked there, as in the Comics library.
        val tracked = if (trackerFilterId != null) trackerFilterId in trackers else trackers.isNotEmpty()

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
