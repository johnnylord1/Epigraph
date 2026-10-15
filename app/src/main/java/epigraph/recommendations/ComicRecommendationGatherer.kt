package epigraph.recommendations

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.isNovelSource
import eu.kanade.tachiyomi.source.model.SManga
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.MetadataMangasPage
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.cancellation.CancellationException

/** Desktop BrowseV3 constant: max sources queried per phase. */
internal const val SEARCH_SEED_SOURCE_LIMIT_MANGA = 8

/** Desktop BrowseV3 constant: per-source cap inside [balanceBySource]. */
internal const val SEARCH_RECOMMENDATION_PER_SOURCE_CAP = 60

/** Desktop BrowseV3 constant: total seed cap inside [capSeeds]. */
internal const val SEARCH_RECOMMENDATION_MANGA_SEED_CAP = 240

/** Desktop BrowseV3 constant: last autofill page (1-based seed page is page 1). */
internal const val SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT = 3

/** Desktop BrowseV3 constant: stop autofilling after this many unproductive pages. */
internal const val SEARCH_RECOMMENDATION_MANGA_AUTOFILL_DUPLICATE_RETRY_LIMIT = 3

/** Desktop BrowseV3 constant: concurrent source requests. */
internal const val RECOMMENDATION_SOURCE_CONCURRENCY = 6

private const val SOURCE_TIMEOUT_MS = 20_000L

/**
 * Whole source phase of a Discover load. Without it, dead or captcha-walled sources each cost
 * a timeout per page and per fallback term, and the screen could spin for minutes.
 */
internal const val SOURCE_GATHER_BUDGET_MS = 45_000L
private const val LOCAL_SOURCE_ID = 0L
private val FALLBACK_TERMS = listOf("action", "fantasy", "adventure", "romance")

/**
 * Port of the desktop BrowseV3 manga candidate gathering (`refreshSearchSourceSeeds` +
 * `loadMangaSearchSeedAutofill`): popular page 1 per source with keyword-search fallback,
 * latest page 1, then autofill pages 2..3 in source batches, with per-source balancing,
 * id/title dedupe, and the 240-entry seed cap applied at every refinement step.
 */
class ComicRecommendationGatherer(private val sourceManager: SourceManager, initialCursors: Map<String, Long> = emptyMap()) {

    private val cursors = java.util.concurrent.ConcurrentHashMap(initialCursors)

    /** End of [gather]'s budget; requests get only the time left. Load-more pages are not bounded. */
    @Volatile
    private var deadlineAt = Long.MAX_VALUE

    private fun timeout(maxMs: Long): Long = minOf(maxMs, deadlineAt - System.currentTimeMillis())

    fun cursorSnapshot(): Map<String, Long> = HashMap(cursors)

    data class Result(
        val entries: List<Pair<RecommendationEntryInput, Boolean /* fromLatestFeed */>>,
        val failedSources: List<String>,
        val cursors: Map<String, Long> = emptyMap(),
    )

    suspend fun gather(
        libraryEntries: List<RecommendationEntryInput>,
        profile: TasteProfile,
        nsfwSourceIds: Set<Long>,
        includeNsfw: Boolean,
    ): Result {
        deadlineAt = System.currentTimeMillis() + SOURCE_GATHER_BUDGET_MS
        val pool = browseSources(nsfwSourceIds, includeNsfw)
        val seedSources = sourceBatch(pool, 1, SEARCH_SEED_SOURCE_LIMIT_MANGA).first
        val failed = mutableSetOf<String>()

        // Phase 1: popular page 1 (keyword fallback) and latest page 1, in parallel.
        val seedIncoming = runConcurrentLimited(seedSources, RECOMMENDATION_SOURCE_CONCURRENCY) {
            fetchSeedEntries(it, failed)
        }
        var seeds = refineSeedEntries(seedIncoming.flatten())
        val latestIncoming = runConcurrentLimited(seedSources, RECOMMENDATION_SOURCE_CONCURRENCY) {
            fetchLatestEntries(it, failed)
        }
        var fresh = refineSeedEntries(latestIncoming.flatten())

        // Phase 2: autofill pages 2..SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT in source batches.
        var page = 1
        while (true) {
            val nextPage = page + 1
            if (nextPage > SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT || timeout(SOURCE_TIMEOUT_MS) <= 0) break
            val (batch, sourcePage) = sourceBatch(pool, nextPage, SEARCH_SEED_SOURCE_LIMIT_MANGA)
            if (batch.isEmpty()) break
            val prevSeeds = seeds.size
            val prevFresh = fresh.size
            val popularIncoming = runConcurrentLimited(batch, RECOMMENDATION_SOURCE_CONCURRENCY) {
                fetchSourcePage(it, latest = false, page = sourcePage)
            }.flatten()
            val freshIncoming = runConcurrentLimited(batch, RECOMMENDATION_SOURCE_CONCURRENCY) {
                fetchSourcePage(it, latest = true, page = sourcePage)
            }.flatten()
            if (popularIncoming.isEmpty() && freshIncoming.isEmpty()) {
                page = nextPage
                if (nextPage >= SEARCH_RECOMMENDATION_MANGA_AUTOFILL_DUPLICATE_RETRY_LIMIT) break
                continue
            }
            fresh = refineSeedEntries(fresh + freshIncoming)
            seeds = refineSeedEntries(seeds + popularIncoming + fresh)
            page = nextPage
            if (seeds.size <= prevSeeds && fresh.size <= prevFresh &&
                nextPage >= SEARCH_RECOMMENDATION_MANGA_AUTOFILL_DUPLICATE_RETRY_LIMIT
            ) break
        }

        val combined = refineSeedEntries(seeds + fresh)
        val freshIds = fresh.toHashSet()
        val entries = combined.map { it to (it in freshIds) }
        return Result(entries, failed.toList(), cursorSnapshot())
    }

    /**
     * Desktop `loadMoreSearchRecommendations` fetch: popular or latest entries for one
     * round-robin source batch; `null` when there are no sources at all.
     */
    suspend fun fetchMore(
        nsfwSourceIds: Set<Long>,
        includeNsfw: Boolean,
        logicalPage: Int,
        latest: Boolean,
    ): List<RecommendationEntryInput>? {
        val (batch, sourcePage) = sourceBatch(browseSources(nsfwSourceIds, includeNsfw), logicalPage, SEARCH_SEED_SOURCE_LIMIT_MANGA)
        if (batch.isEmpty()) return null
        return runConcurrentLimited(batch, RECOMMENDATION_SOURCE_CONCURRENCY) {
            fetchSourcePage(it, latest = latest, page = sourcePage)
        }.flatten()
    }

    /** All visible non-novel sources; NSFW sources only when the user opted in. */
    internal fun browseSources(nsfwSourceIds: Set<Long>, includeNsfw: Boolean): List<CatalogueSource> {
        return sourceManager.getVisibleCatalogueSources()
            .filter { !it.isNovelSource() && it.id != LOCAL_SOURCE_ID }
            .filter { includeNsfw || it.id !in nsfwSourceIds }
    }

    /** Popular page 1; falls back to keyword searches when the source has no popular list. */
    private suspend fun fetchSeedEntries(
        source: CatalogueSource,
        failed: MutableSet<String>,
    ): List<RecommendationEntryInput> {
        val popular = fetchSourcePageOrNull(timeout(SOURCE_TIMEOUT_MS)) { source.getPopularManga(1) }
        remember(source, false, popular)
        if (popular != null && popular.mangas.isNotEmpty()) return popular.mangas.map { it.toInput(source) }
        // A source that did not answer would not answer the keyword searches either.
        if (popular == null) {
            synchronized(failed) { failed += source.name }
            return emptyList()
        }
        for (term in FALLBACK_TERMS) {
            val results = fetchSourcePageOrNull(timeout(SOURCE_TIMEOUT_MS)) { source.getSearchManga(1, term, source.getFilterList()) }
            if (results != null && results.mangas.isNotEmpty()) return results.mangas.map { it.toInput(source) }
        }
        return emptyList()
    }

    private suspend fun fetchLatestEntries(
        source: CatalogueSource,
        failed: MutableSet<String>,
    ): List<RecommendationEntryInput> {
        if (!source.supportsLatest) return emptyList()
        val latest = fetchSourcePageOrNull(timeout(SOURCE_TIMEOUT_MS)) { source.getLatestUpdates(1) }
        remember(source, true, latest)
        return latest?.mangas.orEmpty().map { it.toInput(source) }
    }

    private suspend fun fetchSourcePage(source: CatalogueSource, latest: Boolean, page: Int): List<RecommendationEntryInput> {
        if (latest && !source.supportsLatest) return emptyList()
        val requestPage = resolveSourcePage(page, cursors[sourceCursorKey(source.id, latest)]) ?: return emptyList()
        val result = if (latest) {
            fetchSourcePageOrNull(timeout(SOURCE_TIMEOUT_MS)) { source.getLatestUpdates(requestPage) }
        } else {
            fetchSourcePageOrNull(timeout(SOURCE_TIMEOUT_MS)) { source.getPopularManga(requestPage) }
        }
        remember(source, latest, result)
        return result?.mangas.orEmpty().map { it.toInput(source) }
    }

    private fun remember(source: CatalogueSource, latest: Boolean, result: MangasPage?) {
        if (result == null) return
        val cursor = cursorAfter(result) ?: return
        cursors[sourceCursorKey(source.id, latest)] = cursor
    }

}
/** Port of `searchRecommendationSourceRequest`: round-robin source batches with per-batch page. */
internal fun <T> sourceBatch(pool: List<T>, logicalPage: Int, batchSize: Int): Pair<List<T>, Int> {
    if (pool.size <= batchSize) return pool to logicalPage.coerceAtLeast(1)
    val batchCount = (pool.size + batchSize - 1) / batchSize
    val safePage = logicalPage.coerceAtLeast(1)
    val batchIndex = (safePage - 1) % batchCount
    val sourcePage = (safePage - 1) / batchCount + 1
    return pool.drop(batchIndex * batchSize).take(batchSize) to sourcePage
}

/** Cursor value meaning the source said there is no next page for that list. */
internal const val SOURCE_CURSOR_END = -1L

/** Key of one source list inside [DiscoverPool.sourceCursors]. */
internal fun sourceCursorKey(sourceId: Long, latest: Boolean): String = "$sourceId:${if (latest) "latest" else "popular"}"

/**
 * The `page` argument for a source request, like the Browse pager: page 1 is always 1; later
 * pages use the stored cursor when the source gave one. `null` means the list ended; skip the request.
 */
internal fun resolveSourcePage(page: Int, cursor: Long?): Int? = when {
    page <= 1 -> 1
    cursor == SOURCE_CURSOR_END -> null
    cursor != null -> cursor.toInt()
    else -> page
}

/** What to store after a page arrives: the source's cursor, END when the list ended, or null to store nothing. */
internal fun cursorAfter(result: MangasPage): Long? = when {
    !result.hasNextPage || result.mangas.isEmpty() -> SOURCE_CURSOR_END
    result is MetadataMangasPage -> result.nextKey
    else -> null
}

/**
 * Port of `balanceMangaBySource`: per-source buckets capped at [perSourceCap], then
 * round-robin interleaving so no single source dominates the head of the list.
 */
internal fun <T> balanceBySource(
    items: List<T>,
    perSourceCap: Int = SEARCH_RECOMMENDATION_PER_SOURCE_CAP,
    sourceKey: (T) -> String,
): List<T> {
    val buckets = LinkedHashMap<String, MutableList<T>>()
    for (item in items) {
        val bucket = buckets.getOrPut(sourceKey(item)) { mutableListOf() }
        if (bucket.size < perSourceCap) bucket += item
    }
    val out = mutableListOf<T>()
    var added = true
    while (added) {
        added = false
        for (bucket in buckets.values) {
            val next = bucket.removeFirstOrNull() ?: continue
            out += next
            added = true
        }
    }
    return out
}

internal fun balanceBySource(
    items: List<RecommendationEntryInput>,
    perSourceCap: Int = SEARCH_RECOMMENDATION_PER_SOURCE_CAP,
): List<RecommendationEntryInput> = balanceBySource(items, perSourceCap) { it.sourceId.toString() }

/** Port of `dedupeMangaById`: keep the first entry per non-null manga id. */
internal fun dedupeById(entries: List<RecommendationEntryInput>): List<RecommendationEntryInput> {
    val seen = HashSet<Long>()
    return entries.filter { entry -> entry.mangaId?.let { seen.add(it) } ?: true }
}

/** Port of `dedupeMangaByTitle`: keep the first entry per normalized title key. */
internal fun dedupeByTitle(entries: List<RecommendationEntryInput>): List<RecommendationEntryInput> {
    val seen = HashSet<String>()
    return entries.filter { entry -> seen.add(recommendationTitleKey(entry.title, RecommendationContentType.MANGA)) }
}

/** Port of `capMangaRecommendationSeeds`. */
internal fun capSeeds(entries: List<RecommendationEntryInput>): List<RecommendationEntryInput> =
    entries.take(SEARCH_RECOMMENDATION_MANGA_SEED_CAP)

/** The desktop's refinement pipeline, in its exact order: id dedupe, title dedupe, balance, cap. */
internal fun refineSeedEntries(entries: List<RecommendationEntryInput>): List<RecommendationEntryInput> =
    capSeeds(balanceBySource(dedupeByTitle(dedupeById(entries))))

/** One source page with a deadline; `null` when the fetch threw or timed out. */
internal suspend fun fetchSourcePageOrNull(timeoutMs: Long, block: suspend () -> MangasPage): MangasPage? {
    val page = try {
        withTimeoutOrNull(timeoutMs) { block() }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        return null
    } ?: return null
    return page
}

/** Port of the desktop's `Promise.allSettled` fan-out with a concurrency limit. */
internal suspend fun <T, R> runConcurrentLimited(
    items: List<T>,
    limit: Int,
    fn: suspend (T) -> R,
): List<R> = coroutineScope {
    val semaphore = Semaphore(limit.coerceAtLeast(1))
    items.map { item -> async { semaphore.withPermit { fn(item) } } }.awaitAll()
}

internal fun SManga.toInput(source: CatalogueSource) = RecommendationEntryInput(
    mangaId = null,
    url = url,
    title = title,
    description = description,
    genres = getGenres().orEmpty(),
    publicationStatus = statusText(status),
    sourceId = source.id,
    sourceName = source.name,
    sourceLang = source.lang,
    coverUrl = thumbnail_url,
    isNovel = source.isNovelSource(),
    inLibrary = false,
)

private fun statusText(status: Int): String? = when (status) {
    SManga.ONGOING -> "ongoing"
    SManga.COMPLETED, SManga.PUBLISHING_FINISHED -> "completed"
    SManga.CANCELLED -> "cancelled"
    SManga.ON_HIATUS -> "hiatus"
    else -> null
}
