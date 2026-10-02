package epigraph.recommendations

import android.content.Context
import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookRepository
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import eu.kanade.tachiyomi.data.database.models.LibraryManga
import eu.kanade.tachiyomi.data.database.models.Track
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.data.track.TrackService
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.isNovelSource
import eu.kanade.tachiyomi.source.model.SManga
import exh.source.EH_SOURCE_ID
import exh.source.EXH_SOURCE_ID
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.GetLibraryManga
import yokai.domain.track.interactor.GetTrack
import yokai.util.koin.get
import yokai.util.lang.getString

enum class DiscoverMode { COMICS, NOVELS }

data class DiscoverResult(
    val sections: List<RecommendationSection>,
    val seedCount: Int,
    /** Providers that failed; the screen still shows whatever the others returned. */
    val failedProviders: List<String>,
)

/** Everything [DiscoverRecommendationLoader.gather] collects, so [DiscoverRecommendationLoader.rank] can re-run without network. */
data class DiscoverPool(
    val candidates: List<RecommendationCandidate>,
    val profile: TasteProfile,
    val seedCount: Int,
    val knownTitleKeys: Set<String>,
    val knownProviderKeys: Set<String>,
    val failedProviders: List<String>,
)

/** Desktop BrowseV3 constants for the For you rails. */
internal const val SEARCH_RECOMMENDATION_BASE_LIMIT = 18
internal const val SEARCH_RECOMMENDATION_MAX_LIMIT = 420
internal const val SEARCH_RECOMMENDATION_SCROLL_THROTTLE_MS = 160L

/**
 * Desktop `loadMoreSearchRecommendations` (local part): the next visible limit for a rail, or
 * null when every ranked item is already visible.
 */
internal fun nextVisibleLimit(current: Int?, sectionSize: Int): Int? {
    val limit = current ?: SEARCH_RECOMMENDATION_BASE_LIMIT
    if (limit >= sectionSize || limit >= SEARCH_RECOMMENDATION_MAX_LIMIT) return null
    return minOf(SEARCH_RECOMMENDATION_MAX_LIMIT, limit + SEARCH_RECOMMENDATION_LIMIT_STEP)
}

/**
 * Builds the Discover sections the way the desktop Browse page does: the library (plus tracker
 * scores) is the taste profile, and candidates come from the most-used installed sources
 * (popular + latest) and AniList trending. Every provider fails independently.
 */
class DiscoverRecommendationLoader(
    private val context: Context,
    private val getLibraryManga: GetLibraryManga = get(),
    private val getTrack: GetTrack = get(),
    private val trackManager: TrackManager = get(),
    private val sourceManager: SourceManager = get(),
    private val localBooks: LocalBookRepository = get(),
    private val getManga: GetManga = get(),
    private val preferences: PreferencesHelper = get(),
    private val extensionManager: ExtensionManager = get(),
    private val trackerGatherer: TrackerRecommendationGatherer = TrackerRecommendationGatherer(),
    private val hardcoverGatherer: HardcoverRecommendationGatherer = HardcoverRecommendationGatherer(),
) {
    /**
     * Network + library reads only; ranking happens in [rank] so the UI can re-rank the cached
     * pool (library/NSFW toggles) without touching the sources again.
     */
    suspend fun gather(mode: DiscoverMode, nowMs: Long = System.currentTimeMillis()): DiscoverPool = coroutineScope {
        val library = getLibraryManga.await().distinctBy { it.manga.id }
        val tracksByManga = runCatching { getTrack.awaitAllGroupedByMangaId() }.getOrDefault(emptyMap())
        val libraryEntries = library.mapNotNull { it.toInput(tracksByManga[it.manga.id].orEmpty()) }
            .filter { it.isNovel == (mode == DiscoverMode.NOVELS) }
        val books = if (mode == DiscoverMode.NOVELS) loadBooks() else emptyList()

        val libraryIds = library.mapTo(mutableSetOf()) { it.manga.id }
        val trackerGroups = if (mode == DiscoverMode.COMICS) {
            tracksByManga.entries
                .filter { (mangaId, _) -> mangaId !in libraryIds }
        } else emptyList()
        val trackerRecordSeeds = mutableListOf<TasteProfileSeedItem>()
        val trackerRecordCandidates = mutableListOf<RecommendationCandidate>()
        for ((mangaId, tracks) in trackerGroups) {
            val manga = runCatching { getManga.awaitById(mangaId) }.getOrNull()
            if (manga != null && sourceManager.get(manga.source)?.isNovelSource() == true) continue
            for (track in tracks) {
                trackerRecordSeeds += track.toTasteSeed(manga)
            }
            if (manga != null) {
                val source = sourceManager.get(manga.source)
                val entry = RecommendationEntryInput(
                    mangaId = manga.id,
                    url = manga.url,
                    title = manga.title,
                    description = manga.description,
                    genres = manga.getGenres().orEmpty(),
                    publicationStatus = statusText(manga.status),
                    sourceId = manga.source,
                    sourceName = source?.name.orEmpty(),
                    sourceLang = (source as? CatalogueSource)?.lang,
                    coverUrl = manga.thumbnail_url,
                    isNovel = false,
                    inLibrary = false,
                    tracks = tracks.mapNotNull { it.toInput() },
                )
                trackerRecordCandidates += entryToRecommendationCandidate(entry, nowMs)
            }
        }
        val trackerRemoteKeys = tracksByManga.values.flatten()
            .mapNotNull { recommendationTrackerRemoteKey(it.sync_id.toString(), it.media_id.toString()) }
            .toSet()

        val failures = mutableListOf<String>()
        val hardcoverBooks = if (mode == DiscoverMode.NOVELS) {
            runCatching { hardcoverGatherer.userBooks() }.getOrNull() ?: run {
                failures += "Hardcover"
                null
            }
        } else null
        val hardcoverSeeds = hardcoverBooks?.books.orEmpty().map(::hardcoverBookToTasteProfileSeed)
        val seeds = libraryEntries.map(::entryToTasteProfileSeed) + books.map(::bookToTasteProfileSeed) + trackerRecordSeeds + hardcoverSeeds
        val profile = buildTasteProfile(seeds)

        val nsfwSourceIds = extensionManager.installedExtensionsFlow.value
            .filter { it.isNsfw }
            .flatMapTo(HashSet()) { ext -> ext.sources.map { it.id } }
            .apply { add(EH_SOURCE_ID); add(EXH_SOURCE_ID) }
        val sourceJobs = async {
            if (mode == DiscoverMode.COMICS) {
                val gathered = ComicRecommendationGatherer(sourceManager).gather(libraryEntries, profile, nsfwSourceIds, preferences.showNsfwSources().get())
                synchronized(failures) { failures += gathered.failedSources }
                val comicCandidates = gathered.entries.map { (entry, fromLatest) ->
                    var candidate = entryToRecommendationCandidate(entry, nowMs)
                    if (fromLatest) candidate = applyLatestFeedRank(listOf(candidate)).single()
                    // Adult extensions rarely tag their entries, so the extension flag is the safety signal.
                    if (entry.sourceId in nsfwSourceIds) candidate = candidate.asAdult()
                    candidate
                }
                val trackerResult = trackerGatherer.gather(gathered.entries.map { it.first.title })
                synchronized(failures) { failures += trackerResult.failed }
                comicCandidates + (trackerResult.trending + trackerResult.scores).map { trackerCatalogToRecommendationCandidate(it, nowMs) }
            } else {
                val gathered = NovelRecommendationGatherer(sourceManager).gather(
                    libraryEntries, profile, nsfwSourceIds, preferences.showNsfwSources().get(),
                )
                synchronized(failures) { failures += gathered.failedSources }
                val novelCandidates = gathered.entries.map { entry ->
                    var candidate = entryToRecommendationCandidate(entry, nowMs, novelSourceResult = true)
                    if (entry.sourceId in nsfwSourceIds) candidate = candidate.asAdult()
                    candidate
                }
                val hardcover = hardcoverBooks?.let { userBooks ->
                    withTimeoutOrNull(HARDCOVER_LOADER_BUDGET_MS) {
                        hardcoverGatherer.enrich(gathered.entries.map { it.title }, profile.topTags, userBooks)
                    }
                }
                if (hardcover?.failed == true) synchronized(failures) { failures += "Hardcover" }
                val scored = novelCandidates.map { candidate ->
                    val provider = hardcover?.scoresByTitleKey?.get(recommendationTitleKey(candidate.title, RecommendationContentType.NOVEL))
                    if (provider == null) candidate else candidate.copy(providers = candidate.providers + provider)
                }
                scored + hardcover?.discovery.orEmpty() + hardcoverBooks?.books.orEmpty().map(::hardcoverBookToRecommendationCandidate)
            }
        }

        val candidates = mergeRecommendationCandidates(
            libraryEntries.map { entryToRecommendationCandidate(it, nowMs) } +
                books.map { bookToRecommendationCandidate(it, nowMs) } +
                sourceJobs.await() +
                trackerRecordCandidates,
        )
        DiscoverPool(
            candidates = candidates,
            profile = profile,
            seedCount = seeds.size,
            knownTitleKeys = knownTitleKeys(seeds),
            knownProviderKeys = knownProviderKeys(libraryEntries) + trackerRemoteKeys + hardcoverBooks?.books.orEmpty().mapNotNull { recommendationTrackerRemoteKey("hardcover", it.bookId.toString()) },
            failedProviders = failures.toList(),
        )
    }

    /** Pure ranking over a gathered pool; safe to re-run for filter toggles without network. */
    fun rank(pool: DiscoverPool, includeInLibrary: Boolean, includeNsfw: Boolean, nowMs: Long): DiscoverResult {
        val sections = buildRecommendationSections(
            pool.candidates,
            pool.profile,
            BuildRecommendationSectionsOptions(
                includeInLibrary = includeInLibrary,
                knownTitleKeys = pool.knownTitleKeys,
                knownProviderKeys = pool.knownProviderKeys,
                includeNsfw = includeNsfw,
                blockedTags = if (preferences.filterBlockedTags().get()) preferences.blockedTags().get().toList() else emptyList(),
                nowMs = nowMs,
                limitPerSection = SEARCH_RECOMMENDATION_MAX_LIMIT,
            ),
        )
        return DiscoverResult(sections.filter { it.items.isNotEmpty() }, pool.seedCount, pool.failedProviders)
    }

    suspend fun load(mode: DiscoverMode, nowMs: Long = System.currentTimeMillis()): DiscoverResult =
        rank(gather(mode, nowMs), includeInLibrary = false, includeNsfw = preferences.showNsfwSources().get(), nowMs = nowMs)

    private fun LibraryManga.toInput(tracks: List<Track>): RecommendationEntryInput? {
        val id = manga.id ?: return null
        val source = sourceManager.get(manga.source)
        return RecommendationEntryInput(
            mangaId = id,
            url = manga.url,
            title = manga.title,
            description = manga.description,
            genres = manga.getGenres().orEmpty(),
            publicationStatus = statusText(manga.status),
            sourceId = manga.source,
            sourceName = source?.name.orEmpty(),
            sourceLang = (source as? CatalogueSource)?.lang,
            coverUrl = manga.thumbnail_url,
            isNovel = source?.isNovelSource() == true,
            inLibrary = true,
            unreadCount = unread,
            chapterCount = totalChapters,
            lastUpdateMs = latestUpdate.takeIf { it > 0 },
            tracks = tracks.mapNotNull { it.toInput() },
        )
    }

    private fun Track.toInput(): RecommendationTrackInput? {
        val service = trackManager.getService(sync_id) ?: return null
        if (media_id <= 0) return null
        return RecommendationTrackInput(
            trackerId = sync_id,
            trackerName = service.displayName(),
            remoteId = media_id.toString(),
            score10 = runCatching { service.get10PointScore(score).toDouble() }.getOrNull()?.takeIf { it > 0 },
            status = when (status) {
                service.completedStatus() -> TasteSeedStatus.COMPLETED
                service.planningStatus() -> TasteSeedStatus.PLANNING
                service.readingStatus() -> TasteSeedStatus.READING
                else -> seedStatusFromText(service.getGlobalStatus(status))
            },
            dateMs = (finished_reading_date.takeIf { it > 0 } ?: started_reading_date.takeIf { it > 0 }),
        )
    }

    private fun Track.toTasteSeed(manga: SManga?): TasteProfileSeedItem {
        val trackInput = toInput()
        return TasteProfileSeedItem(
            id = "tracker:$sync_id:$media_id",
            title = manga?.title ?: title,
            tags = manga?.getGenres().orEmpty(),
            contentType = RecommendationContentType.MANGA,
            sourceId = "tracker:$sync_id",
            userRating = score.takeIf { it > 0f }?.toDouble(),
            userRatingMax = if (score > 10f) 100.0 else 10.0,
            implicitWeight = if (score > 0f) null else 0.42,
            status = trackInput?.let { trackRecordSeedStatus(it) },
        )
    }

    private fun TrackService.displayName(): String = runCatching { context.getString(nameRes()) }.getOrDefault("Tracker $id")

    private suspend fun loadBooks(): List<RecommendationBookInput> {
        val books = runCatching { withTimeoutOrNull(5_000) { localBooks.observeBooks().first() } }.getOrNull().orEmpty()
        return books.map { it.toInput() }
    }

    private suspend fun LocalBook.toInput(): RecommendationBookInput {
        val progress = runCatching { localBooks.getProgress(bookId) }.getOrNull()?.let { locator ->
            when (locator) {
                is ReaderLocator.Epub -> locator.progression
                is ReaderLocator.Pdf -> locator.documentProgression
                    ?: locator.totalPages?.let { (locator.pageIndex + 1).toDouble() / it }
                else -> null
            }
        }
        return RecommendationBookInput(
            bookId = bookId,
            title = displayName,
            subtype = if (contentType == ContentType.PDF) "pdf" else "epub",
            coverPath = coverPath,
            progress = progress,
            importedAtMs = importedAt,
            updatedAtMs = updatedAt,
        )
    }

    private fun RecommendationCandidate.asAdult(): RecommendationCandidate =
        if (safety.ordinal < RecommendationSafetyLevel.ADULT.ordinal) copy(safety = RecommendationSafetyLevel.ADULT) else this

    private fun statusText(status: Int): String? = when (status) {
        SManga.ONGOING -> "ongoing"
        SManga.COMPLETED, SManga.PUBLISHING_FINISHED -> "completed"
        SManga.CANCELLED -> "cancelled"
        SManga.ON_HIATUS -> "hiatus"
        else -> null
    }

    companion object {
        private const val SOURCE_TIMEOUT_MS = 20_000L
        private const val HARDCOVER_LOADER_BUDGET_MS = 15_000L
    }
}
