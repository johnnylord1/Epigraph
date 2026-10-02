package epigraph.recommendations

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.isNovelSource
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.SManga
import java.util.Locale
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.max
import kotlinx.coroutines.withTimeoutOrNull

/** Desktop BrowseV3 constant: max sources queried per batch. */
internal const val SEARCH_SEED_SOURCE_LIMIT_NOVELS = 6

/** Desktop BrowseV3 constant: total seed cap inside [capNovelSeeds]. */
internal const val SEARCH_RECOMMENDATION_NOVEL_SEED_CAP = 180

/** Desktop BrowseV3 constant: minimum results a source page must yield before fallbacks stop. */
internal const val SEARCH_RECOMMENDATION_LIMIT_STEP = 7

/**
 * Desktop BrowseV3 `NOVEL_SOURCE_REQUEST_TIMEOUT_MS` is 850 ms; the phone raises it to 8 s because
 * sources hit the network directly instead of a local server.
 */
internal const val NOVEL_SOURCE_TIMEOUT_MS = 8_000L

/** Desktop BrowseV3 constant: how many seed entries get detail enrichment. */
internal const val NOVEL_DETAIL_ENRICHMENT_LIMIT = 3

/** Desktop BrowseV3 constant: detail enrichment runs one source at a time. */
internal const val NOVEL_DETAIL_ENRICHMENT_CONCURRENCY = 1
/** Desktop BrowseV3 `SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT`: stop autofilling after this many unproductive pages. */
internal const val SEARCH_RECOMMENDATION_NOVEL_AUTOFILL_DUPLICATE_RETRY_LIMIT = 18


/**
 * Desktop BrowseV3 `NOVEL_DETAIL_ENRICHMENT_TIMEOUT_MS` is 850 ms; the phone raises it to 8 s
 * because detail/chapter fetches hit the network directly instead of a local server.
 */
internal const val NOVEL_DETAIL_ENRICHMENT_TIMEOUT_MS = 8_000L

private const val LOCAL_SOURCE_ID = 0L

/** Desktop BrowseV3 `novelRecommendationFallbackTerms` generic terms. */
private val NOVEL_FALLBACK_TERMS = listOf("fantasy", "romance", "adventure", "action")

/**
 * Port of the desktop BrowseV3 novel candidate gathering (`refreshSearchNovelSourceSeeds` +
 * `fetchNovelRecommendationSourcePage` + detail enrichment): interleaved visible novel sources,
 * popular page 1 per source (pages 2-3 and localized keyword fallbacks when thin), a base-term
 * search pass when the first pass is empty, per-source balancing, `sourceId:url` dedupe, the
 * 180-entry seed cap, and silent detail enrichment of the first three seeds.
 */
class NovelRecommendationGatherer(private val sourceManager: SourceManager) {

    data class Result(
        val entries: List<RecommendationEntryInput>,
        val failedSources: List<String>,
    )

    suspend fun gather(
        libraryEntries: List<RecommendationEntryInput>,
        profile: TasteProfile,
        nsfwSourceIds: Set<Long>,
        includeNsfw: Boolean,
    ): Result {
        val pool = browseSources(nsfwSourceIds, includeNsfw)
        val seedSources = pool.take(SEARCH_SEED_SOURCE_LIMIT_NOVELS * 2)
        val failed = mutableSetOf<String>()
        val fallbackTerms = novelRecommendationFallbackTerms(profile)

        // Pass 1: popular page 1 per source (pages 2-3 + localized keyword fallbacks inside),
        // in batches of 6, stopping once the seed cap is reached.
        var incoming = emptyList<RecommendationEntryInput>()
        outer@ for (start in seedSources.indices step RECOMMENDATION_SOURCE_CONCURRENCY) {
            val batch = seedSources.subList(start, minOf(start + RECOMMENDATION_SOURCE_CONCURRENCY, seedSources.size))
            incoming += runConcurrentLimited(batch, RECOMMENDATION_SOURCE_CONCURRENCY) {
                fetchNovelSourcePage(it, 1, fallbackTerms, failed)
            }.flatten()
            if (incoming.size >= SEARCH_RECOMMENDATION_NOVEL_SEED_CAP) break@outer
        }

        // Pass 2 (only when pass 1 produced nothing): base-term keyword search page 1 per source.
        if (incoming.isEmpty()) {
            outer2@ for (start in seedSources.indices step RECOMMENDATION_SOURCE_CONCURRENCY) {
                val batch = seedSources.subList(start, minOf(start + RECOMMENDATION_SOURCE_CONCURRENCY, seedSources.size))
                val sourceFallbacks = runConcurrentLimited(batch, RECOMMENDATION_SOURCE_CONCURRENCY) { source ->
                    val results = mutableListOf<RecommendationEntryInput>()
                    for (term in fallbackTerms) {
                        val page = fetchSourcePageOrNull(NOVEL_SOURCE_TIMEOUT_MS) {
                            source.getSearchManga(1, term, source.getFilterList())
                        }
                        if (page != null && page.mangas.isNotEmpty()) {
                            results += page.mangas.map { it.toInput(source) }
                            if (results.size >= SEARCH_RECOMMENDATION_LIMIT_STEP) break
                        }
                    }
                    if (results.isEmpty() && fallbackTerms.isNotEmpty()) {
                        synchronized(failed) { failed += source.name }
                    }
                    results
                }.flatten()
                incoming += sourceFallbacks
                if (incoming.isNotEmpty()) break@outer2
            }
        }

        var seeds = capNovelSeeds(balanceBySource(dedupeNovelEntries(incoming)))

        // Phase 2: autofill pages 2..SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT in source batches.
        var page = 1
        while (true) {
            val nextPage = page + 1
            if (nextPage > SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT) break
            val (batch, sourcePage) = sourceBatch(pool, nextPage, SEARCH_SEED_SOURCE_LIMIT_NOVELS)
            if (batch.isEmpty()) break
            val throwaway = mutableSetOf<String>()
            val incoming = runConcurrentLimited(batch, RECOMMENDATION_SOURCE_CONCURRENCY) {
                fetchNovelSourcePage(it, sourcePage, fallbackTerms, throwaway)
            }.flatten()
            page = nextPage
            if (incoming.isEmpty()) {
                if (nextPage >= SEARCH_RECOMMENDATION_NOVEL_AUTOFILL_DUPLICATE_RETRY_LIMIT) break
                continue
            }
            val prevSize = seeds.size
            seeds = capNovelSeeds(balanceBySource(dedupeNovelEntries(seeds + incoming)))
            if (seeds.size <= prevSize && nextPage >= SEARCH_RECOMMENDATION_NOVEL_AUTOFILL_DUPLICATE_RETRY_LIMIT) break
        }

        return Result(enrichDetails(seeds, pool), failed.toList())
    }

    /**
     * Desktop `loadMoreSearchRecommendations` novel fetch (`fetchNovelRecommendationSourcePage`
     * for one round-robin source batch); `null` when there are no sources at all.
     */
    suspend fun fetchMore(
        profile: TasteProfile,
        nsfwSourceIds: Set<Long>,
        includeNsfw: Boolean,
        logicalPage: Int,
    ): List<RecommendationEntryInput>? {
        val (batch, sourcePage) = sourceBatch(browseSources(nsfwSourceIds, includeNsfw), logicalPage, SEARCH_SEED_SOURCE_LIMIT_NOVELS)
        if (batch.isEmpty()) return null
        val fallbackTerms = novelRecommendationFallbackTerms(profile)
        val throwaway = mutableSetOf<String>()
        return runConcurrentLimited(batch, RECOMMENDATION_SOURCE_CONCURRENCY) {
            fetchNovelSourcePage(it, sourcePage, fallbackTerms, throwaway)
        }.flatten()
    }

    /** All visible novel sources, interleaved by normalized name; NSFW only when opted in. */
    private fun browseSources(nsfwSourceIds: Set<Long>, includeNsfw: Boolean): List<CatalogueSource> {
        val visible = sourceManager.getVisibleCatalogueSources()
            .filter { it.isNovelSource() && it.id != LOCAL_SOURCE_ID }
            .filter { includeNsfw || it.id !in nsfwSourceIds }
        return interleaveNovelRecommendationSources(visible, Locale.getDefault().language)
    }

    /**
     * Port of `fetchNovelRecommendationSourcePage`: popular page [pageNo]; when thin, pages 2-3
     * (page 1 only) and localized keyword searches; the source is failed only when every fetch
     * threw or timed out.
     */
    private suspend fun fetchNovelSourcePage(
        source: CatalogueSource,
        pageNo: Int,
        fallbackTerms: List<String>,
        failed: MutableSet<String>,
    ): List<RecommendationEntryInput> {
        val popular = fetchSourcePageOrNull(NOVEL_SOURCE_TIMEOUT_MS) { source.getPopularManga(pageNo) }
        var collected = dedupeNovelEntries(popular?.mangas.orEmpty().map { it.toInput(source) })
        if (collected.size >= SEARCH_RECOMMENDATION_LIMIT_STEP) return collected

        var extraPages: List<MangasPage?> = emptyList()
        if (pageNo == 1) {
            extraPages = runConcurrentLimited(listOf(2, 3), RECOMMENDATION_SOURCE_CONCURRENCY) { p ->
                fetchSourcePageOrNull(NOVEL_SOURCE_TIMEOUT_MS) { source.getPopularManga(p) }
            }
            collected = dedupeNovelEntries(
                collected + extraPages.flatMap { page -> page?.mangas.orEmpty().map { m -> m.toInput(source) } },
            )
            if (collected.size >= SEARCH_RECOMMENDATION_LIMIT_STEP) return collected
        }

        val terms = novelSourceLocalizedFallbackTerms(source, fallbackTerms)
        val fallbackPages = runConcurrentLimited(terms, RECOMMENDATION_SOURCE_CONCURRENCY) { term ->
            fetchSourcePageOrNull(NOVEL_SOURCE_TIMEOUT_MS) {
                source.getSearchManga(pageNo, term, source.getFilterList())
            }
        }
        val result = dedupeNovelEntries(
            collected + fallbackPages.flatMap { page -> page?.mangas.orEmpty().map { m -> m.toInput(source) } },
        ).take(max(SEARCH_RECOMMENDATION_LIMIT_STEP, collected.size))

        if (popular == null && extraPages.all { it == null } && fallbackPages.all { it == null }) {
            synchronized(failed) { failed += source.name }
        }
        return result
    }

    /**
     * Port of `refreshSearchNovelDetailTags`: the first [NOVEL_DETAIL_ENRICHMENT_LIMIT] seeds get
     * detail tags and last-chapter time merged in; failures are ignored silently.
     */
    private suspend fun enrichDetails(
        entries: List<RecommendationEntryInput>,
        pool: List<CatalogueSource>,
    ): List<RecommendationEntryInput> {
        val candidates = entries.take(NOVEL_DETAIL_ENRICHMENT_LIMIT)
        if (candidates.isEmpty()) return entries
        val sourcesById = pool.associateBy { it.id }
        return runConcurrentLimited(candidates, NOVEL_DETAIL_ENRICHMENT_CONCURRENCY) { entry ->
            val source = sourcesById[entry.sourceId] ?: return@runConcurrentLimited entry
            val manga = SManga.create().apply {
                title = entry.title
                url = entry.url
            }
            val detail = withDetailTimeout { source.getMangaDetails(manga) }
            val chapters = withDetailTimeout { source.getChapterList(manga) }
            val tags = detail?.let { d ->
                (d.getGenres().orEmpty() + listOfNotNull(statusText(d.status))).filter { it.isNotBlank() }
            }.orEmpty()
            val updatedAtMs = chapters.orEmpty().mapNotNull { normalizeTimestampMs(it.date_upload) }.maxOrNull()
            entry.copy(
                genres = if (tags.isNotEmpty()) mergeTags(entry.genres, tags) else entry.genres,
                lastUpdateMs = updatedAtMs ?: entry.lastUpdateMs,
            )
        }
    }

    /** One detail/chapter fetch with a deadline; `null` when it threw or timed out. */
    private suspend fun <T> withDetailTimeout(block: suspend () -> T): T? = try {
        withTimeoutOrNull(NOVEL_DETAIL_ENRICHMENT_TIMEOUT_MS) { block() }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    private fun statusText(status: Int): String? = when (status) {
        SManga.ONGOING -> "ongoing"
        SManga.COMPLETED, SManga.PUBLISHING_FINISHED -> "completed"
        SManga.CANCELLED -> "cancelled"
        SManga.ON_HIATUS -> "hiatus"
        else -> null
    }
}

/** Port of `novelRecommendationFallbackTerms`: profile tags first, then generic terms, max 4. */
internal fun novelRecommendationFallbackTerms(profile: TasteProfile): List<String> {
    val banned = setOf("book", "novel", "webnovel", "epub", "pdf", "hardcover")
    val profileTerms = profile.topTags
        .map { it.trim() }
        .filter { it.length > 2 }
        .filter { it.lowercase() !in banned }
    return (profileTerms + NOVEL_FALLBACK_TERMS)
        .distinctBy { it.lowercase() }
        .take(4)
}

/** Port of `novelSourceLocalizedFallbackTerms`: localized terms first, then base terms, max 5. */
internal fun novelSourceLocalizedFallbackTerms(source: CatalogueSource, baseTerms: List<String>): List<String> {
    val lang = "${source.lang} ${source.name}".lowercase()
    val localized = when {
        lang.contains("portugu") || lang.contains("pt") || lang.contains("br") ->
            listOf("fantasia", "romance", "ação", "aventura")
        lang.contains("中文") || lang.contains("汉语") || lang.contains("漢語") || lang.contains("chinese") ->
            listOf("玄幻", "都市", "仙侠", "奇幻")
        else -> emptyList()
    }
    return (localized + baseTerms)
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinctBy { it.lowercase() }
        .take(5)
}

/** Port of `dedupeNovelSourceResults`: keep the first entry per `sourceId:url` (or title) key. */
internal fun dedupeNovelEntries(entries: List<RecommendationEntryInput>): List<RecommendationEntryInput> {
    val seen = HashSet<String>()
    return entries.filter { entry ->
        val key = if (entry.url.isNotEmpty()) "${entry.sourceId}:${entry.url}" else entry.title.lowercase().trim()
        if (key.isEmpty()) return@filter false
        seen.add(key)
    }
}

/** Port of `mergeRecommendationTags`: primary first, case-insensitive dedupe keeping first spelling. */
internal fun mergeTags(primary: List<String>, secondary: List<String>): List<String> =
    (primary + secondary)
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinctBy { it.lowercase() }

/** Port of `normalizeTimestampMs`: seconds become milliseconds; non-positive is `null`. */
internal fun normalizeTimestampMs(value: Long): Long? = when {
    value <= 0 -> null
    value < 1_000_000_000_000L -> value * 1000
    else -> value
}

/** Port of `normalizeBrowseSourceName`: strips parentheticals and generic words. */
internal fun normalizeBrowseSourceName(value: String): String =
    value.lowercase()
        .replace(Regex("\\s*\\([^)]*\\)\\s*"), " ")
        .replace(Regex("\\b(novel|novels|source|sources|lnreader|extension)\\b"), " ")
        .replace(Regex("\\s+"), " ")
        .trim()

/**
 * Port of `interleaveNovelRecommendationSources`: bucket sources by normalized name, sort each
 * bucket by language preference, order buckets the same way, then round-robin interleave.
 */
internal fun interleaveNovelRecommendationSources(
    sources: List<CatalogueSource>,
    preferredLang: String,
): List<CatalogueSource> {
    val buckets = LinkedHashMap<String, MutableList<CatalogueSource>>()
    for (source in sources) {
        val nameKey = normalizeBrowseSourceName(source.name).ifEmpty { source.id.toString() }
        buckets.getOrPut(nameKey) { mutableListOf() }.add(source)
    }

    val rank = { source: CatalogueSource ->
        when {
            source.lang == preferredLang -> 0
            source.lang == "en" -> 1
            source.lang == "pt" || source.lang == "pt-BR" -> 2
            else -> 3
        }
    }

    for (bucket in buckets.values) {
        bucket.sortWith(compareBy({ rank(it) }, { it.name }, { it.id.toString() }))
    }

    val orderedBuckets = buckets.entries
        .sortedWith(compareBy({ (key, value) -> value.firstOrNull()?.let(rank) ?: 3 }, { (key, _) -> key }))
        .map { it.value }

    val interleaved = mutableListOf<CatalogueSource>()
    var added = true
    while (added) {
        added = false
        for (bucket in orderedBuckets) {
            if (bucket.isNotEmpty()) {
                interleaved += bucket.removeAt(0)
                added = true
            }
        }
    }
    return interleaved
}

/** Port of `capNovelRecommendationSeeds`. */
internal fun capNovelSeeds(entries: List<RecommendationEntryInput>): List<RecommendationEntryInput> =
    entries.take(SEARCH_RECOMMENDATION_NOVEL_SEED_CAP)
