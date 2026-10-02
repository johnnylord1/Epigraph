package epigraph.recommendations

import eu.kanade.tachiyomi.data.database.models.Track
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.data.track.hardcover.HardcoverApi
import eu.kanade.tachiyomi.data.track.hardcover.HardcoverLibraryBook
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import yokai.domain.manga.interactor.GetManga
import yokai.domain.track.interactor.GetTrack

/**
 * Phone timeout for individual Hardcover search calls. The desktop uses soft
 * timeouts of 750 ms (scores) and 950 ms (discovery) because it runs on a
 * desktop network; phone networks are slower, so a single 8 s ceiling is used
 * for both paths.
 */
internal const val HARDCOVER_PHONE_TIMEOUT_MS = 8_000L

/**
 * Shared mutable state for the Hardcover recommendation gatherer.
 * All mutations are guarded by [synchronized] on the instance.
 */
internal class HardcoverRecommendationState(
    val now: () -> Long = System::currentTimeMillis,
) {
    var recordsFailedAtMs: Long? = null
        private set
    var pausedUntilMs: Long? = null
        private set
    val scoreCache = HashMap<String, RecommendationProviderSignal?>()
    val enrichCache = HardcoverEnrichmentGate<HardcoverRecommendationGatherer.Result>(now)

    fun markRecordsFailed() {
        synchronized(this) { recordsFailedAtMs = now() }
    }

    fun clearRecordsFailed() {
        synchronized(this) { recordsFailedAtMs = null }
    }

    fun pause(ms: Long) {
        synchronized(this) { pausedUntilMs = now() + ms }
    }

    fun isPaused(): Boolean =
        synchronized(this) { pausedUntilMs?.let { now() < it } ?: false }

    fun scoreCacheGet(key: String): RecommendationProviderSignal? =
        synchronized(this) { scoreCache[key] }

    fun scoreCacheContainsKey(key: String): Boolean =
        synchronized(this) { scoreCache.containsKey(key) }

    fun scoreCachePut(key: String, value: RecommendationProviderSignal?) {
        synchronized(this) { scoreCache[key] = value }
    }
}

internal val hardcoverRecommendationState = HardcoverRecommendationState()

/**
 * Cooldown in milliseconds after a Hardcover enrichment error.
 * Rate-limit errors (HTTP 429, "throttled", "rate limit") get the full
 * [HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS]; other errors get the
 * shorter of the enrichment cooldown and the record-refresh cooldown.
 */
internal fun hardcoverPauseMs(error: Throwable): Long =
    if (Regex("http 429|throttled|rate limit", RegexOption.IGNORE_CASE).containsMatchIn(error.message.orEmpty()))
        HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS
    else
        minOf(HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS, HARDCOVER_RECORD_REFRESH_COOLDOWN_MS)

class HardcoverRecommendationGatherer internal constructor(
    private val trackManager: TrackManager = Injekt.get(),
    private val getTrack: GetTrack = Injekt.get(),
    private val getManga: GetManga = Injekt.get(),
    private val state: HardcoverRecommendationState = hardcoverRecommendationState,
) {
    constructor() : this(Injekt.get(), Injekt.get(), Injekt.get(), hardcoverRecommendationState)

    data class UserBooks(val books: List<HardcoverLibraryBook>, val online: Boolean)

    data class Result(
        val scoresByTitleKey: Map<String, RecommendationProviderSignal>,
        val discovery: List<RecommendationCandidate>,
        val failed: Boolean,
    )

    suspend fun userBooks(): UserBooks {
        val logged = trackManager.hardcover.isLogged
        if (!logged || state.isPaused() || !useRemoteHardcoverBooks(logged, state.recordsFailedAtMs, state.now())) {
            return UserBooks(localBooks(), online = false)
        }
        return try {
            val remote = trackManager.hardcover.recommendationUserBooks()
            state.clearRecordsFailed()
            // Remote books carry no genres; take them from the linked local works.
            UserBooks(mergeHardcoverBookTags(remote, localTracks().second), online = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            state.markRecordsFailed()
            state.pause(hardcoverPauseMs(e))
            UserBooks(localBooks(), online = false)
        }
    }

    suspend fun enrich(
        novelPoolTitles: List<String>,
        profileTopTags: List<String>,
        userBooks: UserBooks,
    ): Result {
        if (!userBooks.online || state.isPaused()) {
            return Result(emptyMap(), emptyList(), failed = false)
        }
        val titles = hardcoverScoreTitles(novelPoolTitles, userBooks.books.map { it.title })
        val queries = hardcoverDiscoveryQueries(profileTopTags)
        if (titles.isEmpty() && queries.isEmpty()) {
            return Result(emptyMap(), emptyList(), failed = false)
        }
        val key = titles.joinToString("|") + "#" + queries.joinToString("|")
        state.enrichCache.cached(key)?.let { return it }

        val scores = HashMap<String, RecommendationProviderSignal>()
        var failed = false

        // Scores: sequential per title
        for (title in titles) {
            if (failed) break
            val titleKey = recommendationTitleKey(title, RecommendationContentType.NOVEL)
            if (state.scoreCacheContainsKey(titleKey)) {
                state.scoreCacheGet(titleKey)?.let { scores[titleKey] = it }
                continue
            }
            var provider: RecommendationProviderSignal? = null
            for (candidate in canonicalNovelTitleCandidates(title)) {
                if (failed) break
                val results = try {
                    withTimeoutOrNull(HARDCOVER_PHONE_TIMEOUT_MS) {
                        trackManager.hardcover.recommendationSearchBooks(candidate, 5)
                    } ?: emptyList()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    state.pause(hardcoverPauseMs(e))
                    failed = true
                    break
                }
                val match = matchHardcoverBook(candidate, results)
                if (match != null && match.rating != null && match.rating > 0) {
                    provider = hardcoverBookResultToProvider(match)
                    break
                }
            }
            state.scoreCachePut(titleKey, provider)
            if (provider != null) scores[titleKey] = provider
        }

        // Discovery: sequential per query, only if scores did not fail
        val byId = HashMap<Long, RecommendationCandidate>()
        if (!failed) {
            for (query in queries) {
                if (failed) break
                val queryTags = query
                    .split(Regex("\\s+"))
                    .map { it.trim() }
                    .filter { it.length > 2 && !it.equals("novel", true) }
                val results = try {
                    withTimeoutOrNull(HARDCOVER_PHONE_TIMEOUT_MS) {
                        trackManager.hardcover.recommendationSearchBooks(
                            query,
                            HARDCOVER_DISCOVERY_RESULTS_PER_QUERY,
                            fields = "series_names,title,subtitle,description",
                            weights = "8,5,4,3",
                            sort = "rating:desc",
                        )
                    } ?: emptyList()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    state.pause(hardcoverPauseMs(e))
                    failed = true
                    break
                }
                val filtered = filterHardcoverDiscovery(results) { it.rating }
                for (book in filtered) {
                    byId.putIfAbsent(book.id, hardcoverDiscoveryToRecommendationCandidate(book, queryTags))
                }
            }
        }
        val discovery = capProviderResults(byId.values.toList())

        val result = Result(scores, discovery, failed)
        if (!failed) {
            state.enrichCache.store(key, result)
        }
        return result
    }

    private suspend fun localBooks(): List<HardcoverLibraryBook> {
        val (tracks, genresByBookId) = localTracks()
        val books = tracks.map { (bookId, track) ->
            HardcoverLibraryBook(
                bookId = bookId,
                title = track.title,
                authors = emptyList(),
                coverUrl = null,
                rating = null,
                userRating = if (track.score > 0f) track.score.toDouble() else null,
                statusId = track.status,
                tags = emptyList(),
                updatedAtMs = null,
            )
        }
        return mergeHardcoverBookTags(books, genresByBookId)
    }

    /** Local Hardcover tracks keyed by book id, plus each book's genres from the linked local work. */
    private suspend fun localTracks(): Pair<List<Pair<Long, Track>>, Map<Long, List<String>>> {
        val tracks = getTrack.awaitAllGroupedByMangaId().values.flatten()
            .filter { it.sync_id == TrackManager.HARDCOVER }
            .mapNotNull { track ->
                val bookId = track.media_id.takeIf { it != 0L } ?: HardcoverApi.bookIdFromUrl(track.tracking_url)
                bookId?.let { it to track }
            }
        val genresByBookId = tracks.associate { (bookId, track) ->
            bookId to getManga.awaitById(track.manga_id)?.getGenres().orEmpty()
        }
        return tracks to genresByBookId
    }
}
