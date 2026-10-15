package yokai.domain.category.interactor

import epigraph.books.local.LocalBookRepository
import eu.kanade.tachiyomi.data.database.models.MangaCategory
import eu.kanade.tachiyomi.data.database.models.isNovel
import eu.kanade.tachiyomi.source.SourceManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import yokai.domain.category.CategoryLibrary
import yokai.domain.manga.interactor.GetLibraryManga
import yokai.util.koin.get

/**
 * Moves the works a library shows under Default into the category the user just made that
 * library's default, so the choice shows up right away. Works already in a category keep it, and
 * Comics and Books & novels never touch each other's works. Only the settings screen calls this;
 * restores and migrations keep the folders they bring.
 */
class FileUncategorizedInCategory(
    private val getLibraryManga: GetLibraryManga = get(),
    private val getCategories: GetCategories = get(),
    private val setMangaCategories: SetMangaCategories = get(),
    private val localBookRepository: LocalBookRepository = get(),
    private val sourceManager: SourceManager = get(),
) {

    /** Returns how many works moved. */
    suspend fun await(library: CategoryLibrary, categoryId: Int): Int {
        if (categoryId <= 0) return 0
        val known = getCategories.await(library).mapNotNull { it.id }.toSet()
        if (categoryId !in known) return 0

        val mangaIds = getLibraryManga.await()
            .groupBy { it.manga.id }
            .filter { (id, rows) ->
                id != null &&
                    rows.all { it.category == 0 } &&
                    runCatching { rows.first().manga.isNovel(sourceManager) }.getOrNull() == (library == CategoryLibrary.BOOKS)
            }
            .keys
            .filterNotNull()
        if (mangaIds.isNotEmpty()) {
            setMangaCategories.awaitAll(
                mangaIds,
                mangaIds.map { id -> MangaCategory().apply { manga_id = id; category_id = categoryId } },
            )
        }

        var books = 0
        if (library == CategoryLibrary.BOOKS) {
            localBookRepository.snapshotForBackup()
                .filter { snapshot -> snapshot.categoryIds.none { it.toInt() in known } }
                .forEach { snapshot ->
                    localBookRepository.setCategory(snapshot.book.bookId, categoryId.toLong(), true)
                    books++
                }
        }
        val moved = mangaIds.size + books
        if (moved > 0) changes.value++
        return moved
    }

    companion object {
        private val changes = MutableStateFlow(0)

        /** Bumps after a move; book category links are not watched by the library queries. */
        val revisions: StateFlow<Int> = changes
    }
}
