package epigraph.recommendations

import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.isNovelSource

private const val GENRE_SEARCH_TIMEOUT_MS = 20_000L
private const val GENRE_SEARCH_LOCAL_SOURCE_ID = 0L

/**
 * The Catalog's genre search, like the desktop Browse `tagFetchSources` / `tagLoadMoreSource`:
 * every installed source of the mode is searched for the first genre, page by page.
 */
data class DiscoverGenreSearch(
    val mode: DiscoverMode,
    val genres: List<String>,
    val entries: List<RecommendationEntryInput> = emptyList(),
    /** Next page per source id, [SOURCE_CURSOR_END] once a source ran out; null before page 1. */
    val nextPages: Map<Long, Int>? = null,
) {
    val exhausted: Boolean get() = nextPages != null && nextPages.values.none { it > 0 }
}

/**
 * Whether a source search result counts for [genres]. Lists rarely carry genres, so an untagged
 * result of a one-genre search is trusted (the source matched the term); with several genres
 * only the first was searched, so the result must be tagged with all of them.
 */
internal fun genreSearchKeeps(entryGenres: List<String>, genres: List<String>): Boolean =
    if (entryGenres.isEmpty()) genres.size == 1 else matchesAllGenres(entryGenres, genres)

/** Fetches the next page of [search] from every source that still has one. */
internal suspend fun fetchGenreSearchPage(
    sourceManager: SourceManager,
    search: DiscoverGenreSearch,
    nsfwSourceIds: Set<Long>,
    includeNsfw: Boolean,
): DiscoverGenreSearch {
    if (search.genres.isEmpty() || search.exhausted) return search
    val novels = search.mode == DiscoverMode.NOVELS
    val sources = sourceManager.getVisibleCatalogueSources()
        .filter { it.isNovelSource() == novels && it.id != GENRE_SEARCH_LOCAL_SOURCE_ID }
        .filter { includeNsfw || it.id !in nsfwSourceIds }
        .filter { (search.nextPages?.get(it.id) ?: 1) > 0 }
    val term = discoverGenreSearchTerm(search.genres.first())
    val pages = runConcurrentLimited(sources, RECOMMENDATION_SOURCE_CONCURRENCY) { source ->
        val page = search.nextPages?.get(source.id) ?: 1
        val result = fetchSourcePageOrNull(GENRE_SEARCH_TIMEOUT_MS) {
            source.getSearchManga(page, term, source.getFilterList())
        }
        val next = when {
            result == null -> SOURCE_CURSOR_END.toInt()
            else -> cursorAfter(result)?.toInt() ?: (page + 1)
        }
        Triple(source, next, result?.mangas.orEmpty())
    }
    val nextPages = HashMap(search.nextPages.orEmpty())
    val incoming = mutableListOf<RecommendationEntryInput>()
    for ((source, next, mangas) in pages) {
        nextPages[source.id] = next
        incoming += mangas.map { it.toInput(source) }.filter { genreSearchKeeps(it.genres, search.genres) }
    }
    val entries = (search.entries + incoming).distinctBy { it.sourceId to it.url }
    return search.copy(entries = entries, nextPages = nextPages)
}
