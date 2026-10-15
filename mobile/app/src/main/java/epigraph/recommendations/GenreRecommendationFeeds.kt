package epigraph.recommendations

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import java.util.Collections
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable

/** Desktop BrowseV3 constants for the genre lists of the extensions and the tracker lookups. */
internal const val SEARCH_GENRE_SOURCE_LIMIT = 12
internal const val SEARCH_GENRE_SOURCE_CONCURRENCY = 4
internal const val SEARCH_GENRE_SOURCE_INITIAL_EXPLORE = 2
internal const val SEARCH_GENRE_SOURCE_SCROLL_SEARCHES = 8
internal const val SEARCH_GENRE_SOURCE_RESULT_CAP = 600
internal const val SEARCH_GENRE_SCORE_TITLE_LIMIT = 36
internal const val SEARCH_TRACKER_SOURCE_INITIAL_TITLES = 8
internal const val SEARCH_TRACKER_SOURCE_SCROLL_TITLES = 8
internal const val SEARCH_TRACKER_SOURCE_CONCURRENCY = 3
internal const val SEARCH_TRACKER_SCORE_RESULT_CAP = 1500
internal const val SEARCH_NOVEL_GENRE_SOURCE_TIMEOUT_MS = 15_000L
internal const val SEARCH_NOVEL_GENRE_SOURCE_MAX_MISSES = 3
private const val COMIC_GENRE_SOURCE_TIMEOUT_MS = 20_000L

/** Desktop BrowseV3 constants for Kitsu's novels. */
internal const val KITSU_NOVEL_SCORE_LIMIT = 16
internal const val KITSU_NOVEL_SCORE_CONCURRENCY = 2
internal const val KITSU_NOVEL_SEARCH_RESULTS = 5
internal const val KITSU_NOVEL_TASTE_CATEGORY_LIMIT = 3
internal const val KITSU_NOVEL_TASTE_PER_CATEGORY = 20
internal const val KITSU_NOVEL_TASTE_PAGES = 2
internal const val KITSU_NOVEL_EXPLORE_GENRE_LIMIT = 2
internal const val KITSU_NOVEL_EXPLORE_PER_GENRE = 20
internal const val KITSU_NOVEL_EXPLORE_PAGES = 3
internal const val KITSU_NOVEL_SCROLL_SCORES = 8
internal const val KITSU_NOVEL_DISCOVERY_CAP = 480
internal const val KITSU_NOVEL_TIMEOUT_MS = 9_000L

private const val SOURCE_LIST_USE = "list"
private const val SOURCE_SEARCH_USE = "search"
private const val CERTAIN_TITLE_MATCH = 0.8
private const val NOVEL_PAGE_SIGNATURE_SIZE = 8
private const val NOVEL_LOOKUP_QUERIES = 2
// A title in Latin script, so a source searched by it can answer; native titles are searched only when first.
private val LATIN_TITLE = Regex("^[\\p{IsLatin}\\p{N}\\p{P}\\p{Zs}]+$")

/** Which row a genre list or a lookup feeds: the reader's genres, or the rarely read ones. */
enum class GenreFeedKind { TASTE, EXPLORE }

/** One extension's own list of one genre, and the next page to read. */
@Serializable
data class GenreSourceCursor(
    val sourceId: Long,
    val genre: String,
    val kind: GenreFeedKind,
    val page: Int = 1,
    val done: Boolean = false,
) {
    fun sameList(other: GenreSourceCursor) = sourceId == other.sourceId && genre == other.genre && kind == other.kind
}

/** A source work found for a Kitsu novel: Kitsu's rating and categories go with it. */
@Serializable
data class KitsuSourceLink(val provider: RecommendationProviderSignal, val tags: List<String>)

/**
 * Desktop `searchGenreSourceCursors`: works the extensions list under the reader's genres (and the
 * rarely read ones), the works the trackers found in those genres and the extensions answered for
 * by title, and what each extension has shown it can do.
 */
@Serializable
data class GenreSourceFeed(
    val novels: Boolean,
    val sourceIds: List<Long>,
    val tasteGenres: List<String>,
    val exploreGenres: List<String>,
    val cursors: List<GenreSourceCursor> = emptyList(),
    val entries: List<RecommendationEntryInput> = emptyList(),
    /** The genres each work ([genreEntryKey]) was listed under. */
    val tags: Map<String, List<String>> = emptyMap(),
    /** Tracker works (`trackerId:remoteId`) and Kitsu novels (candidate id) already looked up. */
    val lookedUp: Set<String> = emptySet(),
    val failedSources: Set<Long> = emptySet(),
    /** Failed requests in a row per `sourceId:use` (a list or a title search). */
    val misses: Map<String, Int> = emptyMap(),
    /** Novel extensions whose genre filter does nothing: every genre lists the same works. */
    val ignoringSources: Set<Long> = emptySet(),
    /** Novels: the first works of each genre's first page, per extension. */
    val firstPages: Map<Long, Map<String, String>> = emptyMap(),
    /** Works found by title lookups; they stay when their extension is dropped. */
    val linkedKeys: Set<String> = emptySet(),
    /** Comics: tracker works under the title the extension gave them, so both merge. */
    val trackerLinks: List<TrackerCatalogInput> = emptyList(),
    /** Novels: Kitsu's signal per novel title key of a work found by title. */
    val kitsuLinks: Map<String, KitsuSourceLink> = emptyMap(),
) {
    fun genres(kind: GenreFeedKind): List<String> = if (kind == GenreFeedKind.TASTE) tasteGenres else exploreGenres

    fun withCursor(cursor: GenreSourceCursor): GenreSourceFeed =
        copy(cursors = cursors.map { if (it.sameList(cursor)) cursor else it })

    fun usable(sourceId: Long, use: String): Boolean =
        (misses["$sourceId:$use"] ?: 0) < SEARCH_NOVEL_GENRE_SOURCE_MAX_MISSES

    fun missed(sourceId: Long, use: String): GenreSourceFeed {
        val key = "$sourceId:$use"
        return copy(misses = misses + (key to (misses[key] ?: 0) + 1))
    }

    fun answered(sourceId: Long, use: String): GenreSourceFeed = copy(misses = misses - "$sourceId:$use")
}

/** A genre feed being read: each page and lookup lands in it as it arrives, so a deadline keeps what came. */
class GenreSourceFeedRun(@Volatile var feed: GenreSourceFeed) {
    fun update(block: (GenreSourceFeed) -> GenreSourceFeed) = synchronized(this) { feed = block(feed) }
}

/** One Kitsu category list and how far it was read. */
@Serializable
data class KitsuNovelFeedCursor(val category: String, val limit: Int, val offset: Int = 0, val done: Boolean = false)

/** Desktop `searchKitsuNovelFeed`: Kitsu's lists for the reader's taste and rare genres, and its ratings. */
@Serializable
data class KitsuNovelFeed(
    val taste: List<KitsuNovelFeedCursor>,
    val explore: List<KitsuNovelFeedCursor>,
    /** The other rarely read genres, read once the explored ones run out. */
    val later: List<String> = emptyList(),
    /** Tokens of the reader's usual genres; an explored novel carrying one is left out. */
    val usualGenres: Set<String> = emptySet(),
    /** Novels found, by Kitsu id, in the order they came. */
    val discovered: Map<Int, RecommendationCandidate> = emptyMap(),
    /** Novel title keys already asked about. */
    val rated: Set<String> = emptySet(),
    val scores: Map<String, RecommendationProviderSignal> = emptyMap(),
    val categories: Map<String, List<String>> = emptyMap(),
) {
    fun cursors(kind: GenreFeedKind): List<KitsuNovelFeedCursor> = if (kind == GenreFeedKind.TASTE) taste else explore

    fun withCursor(kind: GenreFeedKind, cursor: KitsuNovelFeedCursor): KitsuNovelFeed {
        fun swap(list: List<KitsuNovelFeedCursor>) = list.map { if (it.category == cursor.category) cursor else it }
        return if (kind == GenreFeedKind.TASTE) copy(taste = swap(taste)) else copy(explore = swap(explore))
    }
}

class KitsuNovelRun(@Volatile var feed: KitsuNovelFeed) {
    fun update(block: (KitsuNovelFeed) -> KitsuNovelFeed) = synchronized(this) { feed = block(feed) }
}

/** [block]'s answer, or null when it failed or ran out of time; cancellation still propagates. */
internal suspend fun <T> withSoftTimeout(timeoutMs: Long, block: suspend () -> T): T? = try {
    withTimeoutOrNull(timeoutMs) { block() }
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    null
}

/** Desktop `mergeSearchTrackerScores`: the newest scores first, capped. */
internal fun mergeTrackerScoreResults(
    existing: List<TrackerCatalogInput>,
    incoming: List<TrackerCatalogInput>,
): List<TrackerCatalogInput> = dedupeTrackSearches(incoming + existing).take(SEARCH_TRACKER_SCORE_RESULT_CAP)

/** Comics: the reader's strongest AniList genres, and today's rarely read ones. */
internal fun comicGenreFeedGenres(profile: TasteProfile, rotation: Int): Pair<List<String>, List<String>> =
    tasteCatalogRequests(profile).map { it.genre }.distinct() to
        explorationGenres(profile, rotation = rotation)?.include.orEmpty()

/** Novels: the reader's strongest tags as Kitsu and the extensions name them. */
internal fun novelTasteGenres(profile: TasteProfile): List<String> =
    profile.topTags
        .map { formatHardcoverTasteTag(it).trim() }
        .filter(::isUsefulHardcoverDiscoveryTag)
        .take(KITSU_NOVEL_TASTE_CATEGORY_LIMIT)
        .distinct()

/** Novels: every rarely read genre, today's first. */
internal fun novelExploreGenres(profile: TasteProfile, rotation: Int): List<String> =
    explorationGenres(profile, limit = Int.MAX_VALUE, rotation = rotation)?.include.orEmpty()

internal fun genreEntryKey(entry: RecommendationEntryInput): String = "${entry.sourceId}:${entry.url}"

internal fun trackerLookupKey(item: TrackerCatalogInput): String = "${item.trackerId}:${item.remoteId}"

/**
 * Desktop `refreshSearchGenreSources`: one list per genre and extension that can list it ([lists]),
 * genre by genre, the reader's genres first. Novels only use filters named for genres.
 */
internal fun buildGenreSourceFeed(
    sourceIds: List<Long>,
    tasteGenres: List<String>,
    exploreGenres: List<String>,
    novels: Boolean,
    lists: (Long, String) -> Boolean,
): GenreSourceFeed {
    fun cursors(genres: List<String>, kind: GenreFeedKind) = genres.flatMap { genre ->
        sourceIds.filter { lists(it, genre) }.map { GenreSourceCursor(it, genre, kind) }
    }
    return GenreSourceFeed(
        novels = novels,
        sourceIds = sourceIds,
        tasteGenres = tasteGenres,
        exploreGenres = exploreGenres,
        cursors = cursors(tasteGenres, GenreFeedKind.TASTE) + cursors(exploreGenres, GenreFeedKind.EXPLORE),
    )
}

/** The first read: every list of the reader's genres and the lists of the first rarely read genres. */
internal fun initialGenreCursors(feed: GenreSourceFeed): List<GenreSourceCursor> {
    val explore = feed.exploreGenres.take(SEARCH_GENRE_SOURCE_INITIAL_EXPLORE).toSet()
    return feed.cursors.filter { !it.done && (it.kind == GenreFeedKind.TASTE || it.genre in explore) }
}

/** A row's scroll: its lists furthest behind, so every genre and extension keeps pace. */
internal fun scrollGenreCursors(feed: GenreSourceFeed, kind: GenreFeedKind): List<GenreSourceCursor> =
    feed.cursors
        .filter { it.kind == kind && !it.done && it.sourceId !in feed.ignoringSources }
        .filter { !feed.novels || feed.usable(it.sourceId, SOURCE_LIST_USE) }
        .sortedBy { it.page }
        .take(SEARCH_GENRE_SOURCE_SCROLL_SEARCHES)

/**
 * Desktop `addSearchGenreSourceResults`: tags every work with the genre that listed it and keeps the
 * new ones (with a cover, for novels), newest last, within [SEARCH_GENRE_SOURCE_RESULT_CAP].
 * [known] are works present before the page was asked for. Returns the feed and the new works.
 */
internal fun addGenreSourceEntries(
    feed: GenreSourceFeed,
    incoming: List<RecommendationEntryInput>,
    genre: String,
    requireCover: Boolean,
    known: Set<String> = emptySet(),
): Pair<GenreSourceFeed, List<RecommendationEntryInput>> {
    val tags = feed.tags.toMutableMap()
    for (entry in incoming) {
        val key = genreEntryKey(entry)
        val current = tags[key].orEmpty()
        if (current.none { it.equals(genre, ignoreCase = true) }) tags[key] = current + genre
    }
    val present = feed.entries.mapTo(HashSet(), ::genreEntryKey)
    val seen = HashSet<String>()
    val fresh = incoming.filter { entry ->
        val key = genreEntryKey(entry)
        key !in present && key !in known && (!requireCover || !entry.coverUrl.isNullOrBlank()) && seen.add(key)
    }
    val entries = (feed.entries + fresh).takeLast(SEARCH_GENRE_SOURCE_RESULT_CAP)
    return feed.copy(entries = entries, tags = tags) to fresh
}

/** Drops a novel extension whose genre filter does nothing; works found by title stay. */
internal fun dropGenreSource(feed: GenreSourceFeed, sourceId: Long): GenreSourceFeed {
    fun keep(key: String) = !key.startsWith("$sourceId:") || key in feed.linkedKeys
    return feed.copy(
        ignoringSources = feed.ignoringSources + sourceId,
        cursors = feed.cursors.map { if (it.sourceId == sourceId) it.copy(done = true) else it },
        entries = feed.entries.filter { it.sourceId != sourceId || genreEntryKey(it) in feed.linkedKeys },
        tags = feed.tags.filterKeys(::keep),
    )
}

/** The works a first page opens with: two genres opening the same way mean the filter did nothing. */
internal fun novelPageSignature(entries: List<RecommendationEntryInput>): String =
    entries.take(NOVEL_PAGE_SIGNATURE_SIZE).joinToString("|", transform = ::genreEntryKey)

/** Up to [limit] items, one genre after another in [genres]' order, so every genre gets its turn. */
internal fun <T> interleaveByGenre(items: List<Pair<T, String>>, genres: List<String>, limit: Int): List<Pair<T, String>> {
    val buckets = (genres + items.map { it.second }).distinct()
        .map { genre -> ArrayDeque(items.filter { it.second == genre }) }
    val out = mutableListOf<Pair<T, String>>()
    while (out.size < limit && buckets.any { it.isNotEmpty() }) {
        for (bucket in buckets) {
            if (out.size >= limit) break
            bucket.removeFirstOrNull()?.let(out::add)
        }
    }
    return out
}

/** The titles to search a novel by: its main title, then names in Latin script, two at most. */
internal fun latinTitleQueries(titles: List<String>): List<String> =
    titles
        .map { it.trim() }
        .filterIndexed { index, title -> title.isNotEmpty() && (index == 0 || LATIN_TITLE.matches(title)) }
        .distinctBy { recommendationTitleKey(it, RecommendationContentType.NOVEL) }
        .take(NOVEL_LOOKUP_QUERIES)

/** The item whose title surely names one of [titles], or null: an uncertain match is never taken. */
internal fun <T> bestCertainTitleMatch(items: List<T>, titles: List<String>, titleOf: (T) -> String): T? =
    items
        .map { item -> item to titles.maxOf { trackerTitleMatchScore(it, titleOf(item)) } }
        .filter { it.second >= CERTAIN_TITLE_MATCH }
        .maxByOrNull { it.second }
        ?.first

/** Desktop `isKnownSearchTrackerResult`: a tracker work the reader already has or tracks. */
internal fun isKnownTrackerResult(
    item: TrackerCatalogInput,
    knownTitleKeys: Set<String>,
    knownProviderKeys: Set<String>,
): Boolean =
    recommendationTrackerRemoteKey(item.trackerId.toString(), item.remoteId) in knownProviderKeys ||
        (listOf(item.title) + item.alternativeTitles)
            .any { recommendationTitleKey(it, RecommendationContentType.MANGA) in knownTitleKeys }

/** Comic source entries with the genre lists' works after them and each work tagged with its genres. */
internal fun mergeComicGenreEntries(
    entries: List<Pair<RecommendationEntryInput, Boolean>>,
    feed: GenreSourceFeed?,
): List<Pair<RecommendationEntryInput, Boolean>> {
    if (feed == null || (feed.entries.isEmpty() && feed.tags.isEmpty())) return entries
    val latest = entries.filter { it.second }.mapTo(HashSet()) { it.first }
    val combined = dedupeByTitle(dedupeById(entries.map { it.first } + balanceBySource(feed.entries, SEARCH_GENRE_SOURCE_RESULT_CAP)))
    return combined.map { entry ->
        val fromLatest = entry in latest
        val tags = feed.tags[genreEntryKey(entry)]
        (if (tags.isNullOrEmpty()) entry else entry.copy(genres = mergeTags(entry.genres, tags))) to fromLatest
    }
}

/** Novel source entries with the genre lists' works after them. */
internal fun mergeNovelGenreEntries(
    entries: List<RecommendationEntryInput>,
    feed: GenreSourceFeed?,
): List<RecommendationEntryInput> =
    if (feed == null || feed.entries.isEmpty()) entries
    else dedupeNovelEntries(entries + balanceBySource(feed.entries, SEARCH_GENRE_SOURCE_RESULT_CAP))

/** Desktop `refreshSearchKitsuNovelFeed` lists: the reader's taste and today's rarely read genres. */
internal fun initialKitsuNovelFeed(profile: TasteProfile, rotation: Int): KitsuNovelFeed {
    val explore = explorationGenres(profile, KITSU_NOVEL_EXPLORE_GENRE_LIMIT, rotation)
    val include = explore?.include.orEmpty()
    return KitsuNovelFeed(
        taste = novelTasteGenres(profile).map { KitsuNovelFeedCursor(it, KITSU_NOVEL_TASTE_PER_CATEGORY) },
        explore = include.map { KitsuNovelFeedCursor(it, KITSU_NOVEL_EXPLORE_PER_GENRE) },
        later = novelExploreGenres(profile, rotation).filter { it !in include },
        usualGenres = explore?.exclude.orEmpty().flatMap(::recommendationTagTokens).toSet(),
    )
}

/**
 * The genre lists of the extensions, the tracker works looked up in them by title, and Kitsu's
 * novel lists and ratings (desktop BrowseV3). Comics and novels never share a feed: comic lists
 * read comic extensions and AniList, novel lists read novel extensions and Kitsu.
 */
class GenreRecommendationFeeds(
    private val sourceManager: SourceManager,
    private val kitsu: KitsuNovelClient = KitsuNovelClient(),
) {
    private fun source(id: Long): CatalogueSource? = sourceManager.get(id) as? CatalogueSource

    /** The genre lists of the first [SEARCH_GENRE_SOURCE_LIMIT] extensions. */
    fun buildFeed(
        sources: List<CatalogueSource>,
        tasteGenres: List<String>,
        exploreGenres: List<String>,
        novels: Boolean,
    ): GenreSourceFeed {
        val picked = sources.take(SEARCH_GENRE_SOURCE_LIMIT)
        val byId = picked.associateBy { it.id }
        return buildGenreSourceFeed(picked.map { it.id }, tasteGenres, exploreGenres, novels) { id, genre ->
            byId[id]?.let { sourceGenreFilterList(it, genre, strict = novels) } != null
        }
    }

    /** Desktop `loadSearchGenreSourcePages` for comics: a few lists at a time, each page landing as it comes. */
    suspend fun readComicPages(run: GenreSourceFeedRun, cursors: List<GenreSourceCursor>) {
        runConcurrentLimited(cursors, SEARCH_GENRE_SOURCE_CONCURRENCY) { readComicCursor(run, it) }
    }

    private suspend fun readComicCursor(run: GenreSourceFeedRun, cursor: GenreSourceCursor) {
        val source = source(cursor.sourceId)
        val filters = source?.let { sourceGenreFilterList(it, cursor.genre) }
        val page = if (source == null || filters == null) {
            null
        } else {
            fetchSourcePageOrNull(COMIC_GENRE_SOURCE_TIMEOUT_MS) { source.getSearchManga(cursor.page, "", filters) }
        }
        val entries = if (source == null) emptyList() else page?.mangas.orEmpty().map { it.toInput(source) }
        run.update { feed ->
            // A list that failed is not asked again.
            val next = if (page == null) {
                cursor.copy(done = true)
            } else {
                cursor.copy(page = cursor.page + 1, done = !page.hasNextPage || entries.isEmpty())
            }
            val moved = feed.withCursor(next)
            if (entries.isEmpty()) moved else addGenreSourceEntries(moved, entries, cursor.genre, requireCover = false).first
        }
    }

    /**
     * Desktop `lookUpSearchTrackerWorks`: tracker works of the row's genres the extensions have not
     * listed, asked by title of the extensions that cannot list that genre. A work is taken only on
     * a certain title match; it then carries the tracker's rating and genres. [isKnown] covers the
     * reader's works and the source pool.
     */
    suspend fun lookUpTrackerWorks(
        run: GenreSourceFeedRun,
        kind: GenreFeedKind,
        results: List<TrackerCatalogInput>,
        isKnown: (TrackerCatalogInput) -> Boolean,
        limit: Int,
    ) {
        val feed = run.feed
        val genres = feed.genres(kind)
        val present = feed.entries.mapTo(HashSet()) { recommendationTitleKey(it.title, RecommendationContentType.MANGA) }
        fun sourcesFor(genre: String) = feed.sourceIds.filter { id ->
            id !in feed.failedSources && feed.cursors.none { it.kind == kind && it.sourceId == id && it.genre == genre }
        }
        val pending = results
            .filter { trackerLookupKey(it) !in feed.lookedUp }
            .filter { !isKnown(it) && recommendationTitleKey(it.title, RecommendationContentType.MANGA) !in present }
            .mapNotNull { item ->
                // The later rarely read genres the row's scroll reads are not in the feed's list.
                val genre = genres.firstOrNull { it in item.genres }
                    ?: if (kind == GenreFeedKind.EXPLORE) item.genres.firstOrNull { it !in feed.tasteGenres } else null
                genre?.takeIf { sourcesFor(it).isNotEmpty() }?.let { item to it }
            }
        val next = interleaveByGenre(pending, genres, limit)
        if (next.isEmpty()) return
        run.update { current -> current.copy(lookedUp = current.lookedUp + next.map { trackerLookupKey(it.first) }) }
        runConcurrentLimited(next, SEARCH_TRACKER_SOURCE_CONCURRENCY) { (item, genre) ->
            findTrackerWork(run, item, genre, sourcesFor(genre))
        }
    }

    private suspend fun findTrackerWork(
        run: GenreSourceFeedRun,
        item: TrackerCatalogInput,
        genre: String,
        sourceIds: List<Long>,
    ) {
        val titles = listOf(item.title) + item.alternativeTitles
        for (id in sourceIds) {
            if (id in run.feed.failedSources) continue
            val source = source(id) ?: continue
            val page = fetchSourcePageOrNull(COMIC_GENRE_SOURCE_TIMEOUT_MS) {
                source.getSearchManga(1, item.title, source.getFilterList())
            }
            if (page == null) {
                // An extension whose search fails (one behind a browser challenge) is not asked again.
                run.update { it.copy(failedSources = it.failedSources + id) }
                continue
            }
            val match = bestCertainTitleMatch(page.mangas, titles) { it.title } ?: continue
            val entry = match.toInput(source)
            run.update { feed ->
                addGenreSourceEntries(feed, listOf(entry), genre, requireCover = false).first
                    .copy(trackerLinks = feed.trackerLinks + item.copy(title = entry.title))
            }
            return
        }
    }

    /**
     * Desktop `loadSearchGenreSourcePages` for novels: an extension that keeps failing is left alone,
     * and one whose genres all open with the same works (its filter does nothing) is dropped.
     */
    suspend fun readNovelPages(run: GenreSourceFeedRun, cursors: List<GenreSourceCursor>) {
        for (wave in cursors.chunked(SEARCH_GENRE_SOURCE_CONCURRENCY)) {
            val feed = run.feed
            val usable = wave.filter { cursor ->
                val current = feed.cursors.firstOrNull { it.sameList(cursor) } ?: cursor
                !current.done && cursor.sourceId !in feed.ignoringSources && feed.usable(cursor.sourceId, SOURCE_LIST_USE)
            }
            val known = feed.entries.mapTo(HashSet(), ::genreEntryKey)
            coroutineScope { usable.map { async { readNovelCursor(run, it, known) } }.awaitAll() }
        }
    }

    private suspend fun readNovelCursor(run: GenreSourceFeedRun, cursor: GenreSourceCursor, known: Set<String>) {
        val source = source(cursor.sourceId)
        val filters = source?.let { sourceGenreFilterList(it, cursor.genre, strict = true) }
        if (source == null || filters == null) {
            run.update { it.withCursor(cursor.copy(done = true)) }
            return
        }
        val page = fetchSourcePageOrNull(SEARCH_NOVEL_GENRE_SOURCE_TIMEOUT_MS) {
            source.getSearchManga(cursor.page, "", filters)
        }
        if (page == null) {
            run.update { it.missed(cursor.sourceId, SOURCE_LIST_USE) }
            return
        }
        val entries = dedupeNovelEntries(page.mangas.map { it.toInput(source) })
        run.update { current ->
            var feed = current.answered(cursor.sourceId, SOURCE_LIST_USE)
            if (cursor.sourceId in feed.ignoringSources) return@update feed
            if (cursor.page == 1 && entries.isNotEmpty()) {
                val signature = novelPageSignature(entries)
                val pages = feed.firstPages[cursor.sourceId].orEmpty()
                if (pages.any { (genre, seen) -> genre != cursor.genre && seen == signature }) {
                    return@update dropGenreSource(feed, cursor.sourceId)
                }
                feed = feed.copy(firstPages = feed.firstPages + (cursor.sourceId to pages + (cursor.genre to signature)))
            }
            // A page of works already listed means the list started over.
            val next = cursor.copy(
                page = cursor.page + 1,
                done = entries.isEmpty() || entries.all { genreEntryKey(it) in known },
            )
            addGenreSourceEntries(feed.withCursor(next), entries, cursor.genre, requireCover = true, known = known).first
        }
    }

    /**
     * Desktop `lookUpSearchKitsuNovelWorks`: novels Kitsu found in the row's genres, asked by title of
     * the novel extensions that cannot list that genre. A certain match becomes a work the reader can
     * open, with Kitsu's rating and categories.
     */
    suspend fun lookUpKitsuWorks(
        run: GenreSourceFeedRun,
        kitsuRun: KitsuNovelRun,
        kind: GenreFeedKind,
        isKnown: (RecommendationCandidate) -> Boolean,
        limit: Int,
    ) {
        val feed = run.feed
        val genres = feed.genres(kind)
        val present = feed.entries.mapTo(HashSet()) { recommendationTitleKey(it.title, RecommendationContentType.NOVEL) }
        fun sourcesFor(genre: String) = feed.sourceIds.filter { id ->
            feed.usable(id, SOURCE_SEARCH_USE) &&
                (id in feed.ignoringSources || feed.cursors.none { it.kind == kind && it.sourceId == id && it.genre == genre })
        }
        val pending = kitsuRun.feed.discovered.values
            .filter { it.id !in feed.lookedUp && !isKnown(it) && it.titleKeys().none { key -> key in present } }
            .mapNotNull { candidate ->
                val genre = genres.firstOrNull { genre -> candidate.tags.any { it.equals(genre, ignoreCase = true) } }
                genre?.takeIf { sourcesFor(it).isNotEmpty() }?.let { candidate to it }
            }
        val next = interleaveByGenre(pending, genres, limit)
        if (next.isEmpty()) return
        run.update { current -> current.copy(lookedUp = current.lookedUp + next.map { it.first.id }) }
        runConcurrentLimited(next, SEARCH_TRACKER_SOURCE_CONCURRENCY) { (candidate, genre) ->
            findKitsuWork(run, kitsuRun, candidate, genre, sourcesFor(genre))
        }
    }

    private suspend fun findKitsuWork(
        run: GenreSourceFeedRun,
        kitsuRun: KitsuNovelRun,
        candidate: RecommendationCandidate,
        genre: String,
        sourceIds: List<Long>,
    ) {
        val titles = listOf(candidate.title) + candidate.alternativeTitles
        val queries = latinTitleQueries(titles)
        for (id in sourceIds) {
            val source = source(id) ?: continue
            for (query in queries) {
                if (!run.feed.usable(id, SOURCE_SEARCH_USE)) break
                val page = fetchSourcePageOrNull(SEARCH_NOVEL_GENRE_SOURCE_TIMEOUT_MS) {
                    source.getSearchManga(1, query, source.getFilterList())
                }
                if (page == null) {
                    run.update { it.missed(id, SOURCE_SEARCH_USE) }
                    continue
                }
                run.update { it.answered(id, SOURCE_SEARCH_USE) }
                val match = bestCertainTitleMatch(page.mangas, titles) { it.title } ?: continue
                val entry = match.toInput(source)
                val key = recommendationTitleKey(entry.title, RecommendationContentType.NOVEL)
                val provider = candidate.providers.firstOrNull { it.kind == RecommendationProviderKind.TRACKER }
                run.update { feed ->
                    val link = provider?.let { KitsuSourceLink(it, candidate.tags.filterNot { tag -> tag.equals("novel", ignoreCase = true) }) }
                    addGenreSourceEntries(feed, listOf(entry), genre, requireCover = false).first.copy(
                        linkedKeys = feed.linkedKeys + genreEntryKey(entry),
                        kitsuLinks = if (link == null) feed.kitsuLinks else feed.kitsuLinks + (key to link),
                    )
                }
                kitsuRun.update { it.copy(rated = it.rated + key) }
                return
            }
        }
    }

    /**
     * Desktop `refreshSearchKitsuNovelFeed` reads: the reader's taste categories two pages each and
     * the rarely read genres three pages each, one request at a time.
     */
    suspend fun startKitsuFeeds(state: KitsuNovelRun, includeNsfw: Boolean) {
        val feed = state.feed
        val reads = List(KITSU_NOVEL_TASTE_PAGES) { feed.taste }.flatten().map { GenreFeedKind.TASTE to it.category } +
            List(KITSU_NOVEL_EXPLORE_PAGES) { feed.explore }.flatten().map { GenreFeedKind.EXPLORE to it.category }
        for ((kind, category) in reads) {
            val cursor = state.feed.cursors(kind).firstOrNull { it.category == category } ?: continue
            val pages = if (kind == GenreFeedKind.TASTE) KITSU_NOVEL_TASTE_PAGES else KITSU_NOVEL_EXPLORE_PAGES
            if (cursor.done || cursor.offset >= cursor.limit * pages) continue
            readKitsuFeed(state, kind, category, includeNsfw)
        }
    }

    /** Desktop `loadMoreSearchKitsuNovels`: the next page of the row's Kitsu lists and, for taste, more ratings. */
    suspend fun scrollKitsu(state: KitsuNovelRun, kind: GenreFeedKind, includeNsfw: Boolean, poolTitles: List<String>) {
        if (kind == GenreFeedKind.EXPLORE) {
            state.update { feed ->
                if (feed.later.isNotEmpty() && feed.explore.all { it.done }) {
                    feed.copy(
                        explore = feed.explore + KitsuNovelFeedCursor(feed.later.first(), KITSU_NOVEL_EXPLORE_PER_GENRE),
                        later = feed.later.drop(1),
                    )
                } else {
                    feed
                }
            }
        }
        val categories = state.feed.cursors(kind).filter { !it.done }.map { it.category }
        coroutineScope {
            val rating = if (kind == GenreFeedKind.TASTE) {
                async { rateKitsuTitles(state, poolTitles, KITSU_NOVEL_SCROLL_SCORES) }
            } else {
                null
            }
            for (category in categories) readKitsuFeed(state, kind, category, includeNsfw)
            rating?.await()
        }
    }

    /** Desktop `readKitsuNovelFeed`: one page of a Kitsu list; returns how many novels were new. */
    private suspend fun readKitsuFeed(state: KitsuNovelRun, kind: GenreFeedKind, category: String, includeNsfw: Boolean): Int {
        val cursor = state.feed.cursors(kind).firstOrNull { it.category == category } ?: return 0
        suspend fun page(offset: Int) = withSoftTimeout(KITSU_NOVEL_TIMEOUT_MS) { kitsu.discover(category, cursor.limit, offset) }
        var novels = page(cursor.offset) ?: return 0
        var offset = cursor.offset + cursor.limit
        // A page of novels found already: read past it once.
        if (offset > cursor.limit && novels.isNotEmpty() && novels.all { it.id in state.feed.discovered }) {
            val further = page(offset)
            if (further == null) {
                state.update { it.withCursor(kind, cursor.copy(offset = offset)) }
                return 0
            }
            novels = further
            offset += cursor.limit
        }
        val next = cursor.copy(offset = offset, done = novels.size < cursor.limit)
        var added = 0
        state.update { feed ->
            val discovered = LinkedHashMap(feed.discovered)
            for (novel in novels) {
                if (novel.id in discovered || (novel.adult && !includeNsfw)) continue
                // Outside the reader's habits means none of their usual genres.
                if (kind == GenreFeedKind.EXPLORE && novel.categories.flatMap(::recommendationTagTokens).any { it in feed.usualGenres }) continue
                discovered[novel.id] = kitsuNovelToRecommendationCandidate(novel, listOf(category))
                added += 1
            }
            feed.withCursor(kind, next).copy(discovered = discovered)
        }
        return added
    }

    /**
     * Desktop `rateKitsuNovelTitles`: Kitsu's rating and categories for up to [limit] titles not asked
     * about yet, by the title and its known aliases; only a certain match counts. A title whose
     * search did not finish is asked again later.
     */
    suspend fun rateKitsuTitles(state: KitsuNovelRun, titles: List<String>, limit: Int) {
        val picked = LinkedHashMap<String, String>()
        state.update { feed ->
            for (title in titles) {
                if (picked.size >= limit) break
                val key = recommendationTitleKey(title, RecommendationContentType.NOVEL)
                if (key.endsWith(":") || key in feed.rated || key in picked) continue
                picked[key] = title
            }
            feed.copy(rated = feed.rated + picked.keys)
        }
        if (picked.isEmpty()) return
        val finished = Collections.synchronizedSet(HashSet<String>())
        try {
            runConcurrentLimited(picked.entries.toList(), KITSU_NOVEL_SCORE_CONCURRENCY) { (key, title) ->
                var answered = true
                for (candidate in canonicalNovelTitleCandidates(title)) {
                    val novels = withSoftTimeout(KITSU_NOVEL_TIMEOUT_MS) { kitsu.search(candidate, KITSU_NOVEL_SEARCH_RESULTS) }
                    if (novels == null) {
                        answered = false
                        continue
                    }
                    val match = matchKitsuNovel(candidate, novels) ?: continue
                    state.update { feed ->
                        feed.copy(
                            scores = feed.scores + (key to kitsuNovelToProvider(match)),
                            categories = if (match.categories.isEmpty()) feed.categories else feed.categories + (key to match.categories),
                        )
                    }
                    answered = true
                    break
                }
                if (answered) finished += key
            }
        } finally {
            val unfinished = picked.keys - finished
            if (unfinished.isNotEmpty()) state.update { it.copy(rated = it.rated - unfinished) }
        }
    }
}
