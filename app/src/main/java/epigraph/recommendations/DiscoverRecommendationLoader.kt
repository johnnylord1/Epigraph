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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
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
@Serializable
data class DiscoverPool(
    val mode: DiscoverMode,
    val candidates: List<RecommendationCandidate>,
    val profile: TasteProfile,
    val seedCount: Int,
    val knownTitleKeys: Set<String>,
    val knownProviderKeys: Set<String>,
    val failedProviders: List<String>,
    /** Library entries and local books, already converted. */
    val libraryCandidates: List<RecommendationCandidate> = emptyList(),
    /** Comics: tracker records of titles that are not in the library. */
    val trackerRecordCandidates: List<RecommendationCandidate> = emptyList(),
    /** Comics: source entries, paired with `true` when they came from a Latest feed. */
    val comicEntries: List<Pair<RecommendationEntryInput, Boolean>> = emptyList(),
    /** Novels: source entries. */
    val novelEntries: List<RecommendationEntryInput> = emptyList(),
    val trackerTrending: List<TrackerCatalogInput> = emptyList(),
    val trackerScores: List<TrackerCatalogInput> = emptyList(),
    /** Last AniList catalog page already fetched for trending. */
    val trackerTrendingPage: Int = 4,
    /** Novels: Hardcover provider signal per novel title key. */
    val hardcoverScores: Map<String, RecommendationProviderSignal> = emptyMap(),
    /** Novels: Hardcover discovery + Hardcover user-book candidates. */
    val hardcoverCandidates: List<RecommendationCandidate> = emptyList(),
    val nsfwSourceIds: Set<Long> = emptySet(),
    val gatheredAtMs: Long = 0L,
    /** [DiscoverRecommendationLoader.librarySignature] when gathered; a change makes the pool stale. */
    val librarySignature: Int = 0,
    /** Desktop `searchRecommendationMorePages`: last source page loaded per section (absent = 1). */
    val morePages: Map<RecommendationSectionKey, Int> = emptyMap(),
    /** Desktop `searchRecommendationExhausted`. */
    val exhausted: Set<RecommendationSectionKey> = emptySet(),
    /** Per source list (see [sourceCursorKey]): next page cursor, or [SOURCE_CURSOR_END]. */
    val sourceCursors: Map<String, Long> = emptyMap(),
    /** The extensions' genre lists and the tracker (comics) or Kitsu (novels) works found in them by title. */
    val genreFeed: GenreSourceFeed? = null,
    /** Comics: AniList works of the reader's strongest genres, per comic format the library holds. */
    val trackerTaste: List<TrackerCatalogInput> = emptyList(),
    /** Comics: AniList searches of the rarely read genres, and what they found. */
    val trackerExplore: AniListExploreFeed? = null,
    val trackerExploreResults: List<TrackerCatalogInput> = emptyList(),
    /** Novels: Kitsu's lists of the reader's taste and rare genres, and its ratings. */
    val kitsuFeed: KitsuNovelFeed? = null,
)

/** Desktop BrowseV3 constants for the For you rails. */
internal const val SEARCH_RECOMMENDATION_BASE_LIMIT = 18
internal const val SEARCH_RECOMMENDATION_MAX_LIMIT = 420
internal const val SEARCH_RECOMMENDATION_SCROLL_THROTTLE_MS = 160L

/** Desktop BrowseV3: a section is exhausted after an unproductive load-more at this page. */
internal const val SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT = 18

/** One [DiscoverRecommendationLoader.loadMore] step. */
data class DiscoverMoreResult(
    val pool: DiscoverPool,
    /** Desktop `addedVisibleItems`: the rail may grow by one step. */
    val grew: Boolean,
)

/** Desktop manga merge for load-more: POPULAR pages go into the seeds, LATEST pages into the fresh list too. */
internal fun mergeComicMore(
    entries: List<Pair<RecommendationEntryInput, Boolean>>,
    incoming: List<RecommendationEntryInput>,
    latest: Boolean,
): List<Pair<RecommendationEntryInput, Boolean>> {
    val seeds = entries.map { it.first }
    var fresh = entries.filter { it.second }.map { it.first }
    val combined = if (latest) {
        fresh = refineSeedEntries(fresh + incoming)
        refineSeedEntries(seeds + fresh)
    } else {
        refineSeedEntries(seeds + incoming)
    }
    val freshSet = fresh.toHashSet()
    return combined.map { it to (it in freshSet) }
}

/** Desktop novel merge for load-more. */
internal fun mergeNovelMore(
    entries: List<RecommendationEntryInput>,
    incoming: List<RecommendationEntryInput>,
): List<RecommendationEntryInput> = capNovelSeeds(balanceBySource(dedupeNovelEntries(entries + incoming)))

/**
 * Desktop `loadMoreSearchRecommendations` (local part): the next visible limit for a rail, or
 * null when every ranked item is already visible.
 */
internal fun nextVisibleLimit(current: Int?, sectionSize: Int): Int? {
    val limit = current ?: SEARCH_RECOMMENDATION_BASE_LIMIT
    if (limit >= sectionSize || limit >= SEARCH_RECOMMENDATION_MAX_LIMIT) return null
    return minOf(SEARCH_RECOMMENDATION_MAX_LIMIT, limit + SEARCH_RECOMMENDATION_LIMIT_STEP)
}

/** Raw parts returned by the source-gathering job in [DiscoverRecommendationLoader.gather]. */
private data class SourceParts(
    val comicEntries: List<Pair<RecommendationEntryInput, Boolean>> = emptyList(),
    val novelEntries: List<RecommendationEntryInput> = emptyList(),
    val trackerTrending: List<TrackerCatalogInput> = emptyList(),
    val trackerScores: List<TrackerCatalogInput> = emptyList(),
    val hardcoverScores: Map<String, RecommendationProviderSignal> = emptyMap(),
    val hardcoverCandidates: List<RecommendationCandidate> = emptyList(),
    val sourceCursors: Map<String, Long> = emptyMap(),
)

/** A work the reader already has: one of its titles or tracker entries is in their library. */
internal fun isKnownRecommendationCandidate(
    candidate: RecommendationCandidate,
    knownTitleKeys: Set<String>,
    knownProviderKeys: Set<String>,
): Boolean =
    candidate.titleKeys().any { it in knownTitleKeys } || candidate.providers.any { it.remoteKey() in knownProviderKeys }

/** The genre feed a row's scroll reads, or null for the rows fed only by source pages and trending. */
internal fun genreFeedKind(mode: DiscoverMode, key: RecommendationSectionKey): GenreFeedKind? = when {
    key == RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS -> GenreFeedKind.EXPLORE
    key == RecommendationSectionKey.FRESH_IN_YOUR_SOURCES -> null
    mode == DiscoverMode.COMICS && key == RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE -> null
    else -> GenreFeedKind.TASTE
}

/** Whether a row's genre feeds still have lists to read, so the row is not exhausted yet. */
internal fun hasGenreFeedLeft(pool: DiscoverPool, kind: GenreFeedKind): Boolean {
    val genre = pool.genreFeed?.let { feed -> feed.cursors.any { it.kind == kind && !it.done && it.sourceId !in feed.ignoringSources } } == true
    val kitsu = pool.kitsuFeed?.let { feed ->
        feed.cursors(kind).any { !it.done } || (kind == GenreFeedKind.EXPLORE && feed.later.isNotEmpty())
    } == true
    val explore = kind == GenreFeedKind.EXPLORE &&
        pool.trackerExplore?.let { feed -> feed.searches.any { !it.done } || feed.later.isNotEmpty() } == true
    return genre || kitsu || explore
}

/** Rebuilds the pool's candidates from its parts, exactly as [DiscoverRecommendationLoader.gather] does. */
internal fun assembleDiscoverCandidates(pool: DiscoverPool): List<RecommendationCandidate> {
    val sourceCandidates = when (pool.mode) {
        DiscoverMode.COMICS -> {
            val comicCandidates = mergeComicGenreEntries(pool.comicEntries, pool.genreFeed).map { (entry, fromLatest) ->
                var candidate = entryToRecommendationCandidate(entry, pool.gatheredAtMs)
                if (fromLatest) candidate = applyLatestFeedRank(listOf(candidate)).single()
                // Adult extensions rarely tag their entries, so the extension flag is the safety signal.
                if (entry.sourceId in pool.nsfwSourceIds) candidate = candidate.asAdult()
                candidate
            }
            // Tracker works an extension answered for by title come under the extension's title too, so they merge.
            val trackers = dedupeTrackSearches(pool.trackerTrending + pool.trackerScores + pool.trackerExploreResults + pool.trackerTaste) +
                pool.genreFeed?.trackerLinks.orEmpty()
            comicCandidates + trackers.map { trackerCatalogToRecommendationCandidate(it, pool.gatheredAtMs) }
        }
        DiscoverMode.NOVELS -> {
            val genreTags = pool.genreFeed?.tags.orEmpty()
            val kitsuLinks = pool.genreFeed?.kitsuLinks.orEmpty()
            val kitsu = pool.kitsuFeed
            val novelCandidates = mergeNovelGenreEntries(pool.novelEntries, pool.genreFeed).map { entry ->
                var candidate = entryToRecommendationCandidate(entry, pool.gatheredAtMs, novelSourceResult = true)
                if (entry.sourceId in pool.nsfwSourceIds) candidate = candidate.asAdult()
                val key = recommendationTitleKey(candidate.title, RecommendationContentType.NOVEL)
                val link = kitsuLinks[key]
                val providers = listOfNotNull(pool.hardcoverScores[key], link?.provider ?: kitsu?.scores?.get(key))
                val tags = (link?.tags ?: kitsu?.categories?.get(key)).orEmpty() + genreTags[genreEntryKey(entry)].orEmpty()
                candidate.copy(
                    providers = candidate.providers + providers,
                    tags = if (tags.isEmpty()) candidate.tags else mergeTags(candidate.tags, tags),
                )
            }
            novelCandidates + kitsu?.discovered?.values.orEmpty().take(KITSU_NOVEL_DISCOVERY_CAP) + pool.hardcoverCandidates
        }
    }
    return mergeRecommendationCandidates(pool.libraryCandidates + sourceCandidates + pool.trackerRecordCandidates)
}

private fun RecommendationCandidate.asAdult(): RecommendationCandidate =
    if (safety.ordinal < RecommendationSafetyLevel.ADULT.ordinal) copy(safety = RecommendationSafetyLevel.ADULT) else this

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
    private val genreFeeds: GenreRecommendationFeeds = GenreRecommendationFeeds(sourceManager),
    private val comicOriginLookup: ComicOriginLookup = ComicOriginLookup.create(context),
) {
    /**
     * Network + library reads only; ranking happens in [rank] so the UI can re-rank the cached
     * pool (library/NSFW toggles) without touching the sources again.
     */
    suspend fun gather(mode: DiscoverMode, nowMs: Long = System.currentTimeMillis()): DiscoverPool = coroutineScope {
        val library = getLibraryManga.await().distinctBy { it.manga.id }
        val librarySignature = librarySignature(library)
        val tracksByManga = runCatching { getTrack.awaitAllGroupedByMangaId() }.getOrDefault(emptyMap())
        val libraryInputs = library.mapNotNull { it.toInput(tracksByManga[it.manga.id].orEmpty()) }
            .filter { it.isNovel == (mode == DiscoverMode.NOVELS) }
        // Comics: the publisher's country tells manga, manhwa and manhua apart, like the desktop.
        val comicOrigins = if (mode == DiscoverMode.COMICS) {
            // Novels never go to AniList: only the comic library and works tracked outside the library.
            val libraryMangaIds = library.mapTo(HashSet()) { it.manga.id }
            val comicIds = libraryInputs.mapNotNullTo(HashSet()) { it.mangaId }
            resolveComicOrigins(libraryInputs, tracksByManga.filterKeys { it in comicIds || it !in libraryMangaIds })
        } else {
            ComicOrigins.NONE
        }
        val libraryEntries = if (mode == DiscoverMode.COMICS) {
            libraryInputs.map { entry ->
                entry.copy(comicOrigin = comicOrigins.of(tracksByManga[entry.mangaId].orEmpty().map(Track::originKey), entry.title))
            }
        } else {
            libraryInputs
        }
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
            val origin = comicOrigins.of(tracks.map(Track::originKey), manga?.title ?: tracks.firstOrNull()?.title.orEmpty())
            for (track in tracks) {
                trackerRecordSeeds += track.toTasteSeed(manga, origin)
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
                    comicOrigin = origin,
                )
                trackerRecordCandidates += entryToRecommendationCandidate(entry, nowMs)
            }
        }
        val trackerRemoteKeys = tracksByManga.values.flatten()
            .mapNotNull { recommendationTrackerRemoteKey(it.sync_id.toString(), it.media_id.toString()) }
            .toSet()

        val failures = mutableListOf<String>()
        val hardcoverBooks = if (mode == DiscoverMode.NOVELS) {
            runCatching { withTimeoutOrNull(HARDCOVER_LOADER_BUDGET_MS) { hardcoverGatherer.userBooks() } }.getOrNull() ?: run {
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
        val includeNsfw = preferences.showNsfwSources().get()
        val rotation = explorationRotation(nowMs)
        val knownTitles = knownTitleKeys(seeds)
        val knownProviders = knownProviderKeys(libraryEntries) + trackerRemoteKeys +
            hardcoverBooks?.books.orEmpty().mapNotNull { recommendationTrackerRemoteKey("hardcover", it.bookId.toString()) }

        // The extensions the reader uses most list their genres first.
        val sourceUse = libraryEntries.groupingBy { it.sourceId }.eachCount()
        val genreSources = if (mode == DiscoverMode.COMICS) {
            ComicRecommendationGatherer(sourceManager).browseSources(nsfwSourceIds, includeNsfw)
        } else {
            NovelRecommendationGatherer(sourceManager).browseSources(nsfwSourceIds, includeNsfw)
        }.sortedByDescending { sourceUse[it.id] ?: 0 }
        val (tasteGenres, exploreGenres) = if (mode == DiscoverMode.COMICS) {
            comicGenreFeedGenres(profile, rotation)
        } else {
            novelTasteGenres(profile) to novelExploreGenres(profile, rotation)
        }
        val genreRun = GenreSourceFeedRun(
            runCatching { genreFeeds.buildFeed(genreSources, tasteGenres, exploreGenres, novels = mode == DiscoverMode.NOVELS) }
                .getOrElse { GenreSourceFeed(mode == DiscoverMode.NOVELS, emptyList(), tasteGenres, exploreGenres) },
        )
        val exploreRun = if (mode == DiscoverMode.COMICS) aniListExploreFeed(profile, rotation)?.let { AniListExploreRun(it) } else null
        val kitsuRun = if (mode == DiscoverMode.NOVELS) KitsuNovelRun(initialKitsuNovelFeed(profile, rotation)) else null
        val tasteSink = mutableListOf<TrackerCatalogInput>()
        // Desktop BrowseV3 genre feeds: read alongside the source pages, each landing as it arrives.
        val feedJob = async {
            coroutineScope {
                launch {
                    withTimeoutOrNull(GENRE_FEED_BUDGET_MS) {
                        if (mode == DiscoverMode.COMICS) {
                            genreFeeds.readComicPages(genreRun, initialGenreCursors(genreRun.feed))
                        } else {
                            genreFeeds.readNovelPages(genreRun, initialGenreCursors(genreRun.feed))
                        }
                    }
                }
                if (mode == DiscoverMode.COMICS) {
                    launch {
                        withTimeoutOrNull(GENRE_FEED_BUDGET_MS) {
                            trackerGatherer.fetchTasteFeed(
                                tasteCatalogRequests(profile),
                                includeNsfw,
                                { isKnownTrackerResult(it, knownTitles, knownProviders) },
                                tasteSink,
                            )
                        }
                    }
                }
                exploreRun?.let { state ->
                    launch { withTimeoutOrNull(GENRE_FEED_BUDGET_MS) { trackerGatherer.startExploreFeed(state, includeNsfw) } }
                }
                kitsuRun?.let { state ->
                    launch { withTimeoutOrNull(GENRE_FEED_BUDGET_MS) { genreFeeds.startKitsuFeeds(state, includeNsfw) } }
                }
            }
        }
        val sourceJobs = async {
            if (mode == DiscoverMode.COMICS) {
                val gathered = ComicRecommendationGatherer(sourceManager).gather(libraryEntries, profile, nsfwSourceIds, includeNsfw)
                synchronized(failures) { failures += gathered.failedSources }
                val trackerResult = trackerGatherer.gather(gathered.entries.map { it.first.title })
                synchronized(failures) { failures += trackerResult.failed }
                SourceParts(
                    comicEntries = gathered.entries,
                    trackerTrending = trackerResult.trending,
                    trackerScores = trackerResult.scores,
                    sourceCursors = gathered.cursors,
                )
            } else {
                val gathered = NovelRecommendationGatherer(sourceManager).gather(
                    libraryEntries, profile, nsfwSourceIds, includeNsfw,
                )
                synchronized(failures) { failures += gathered.failedSources }
                val hardcover = hardcoverBooks?.let { userBooks ->
                    withTimeoutOrNull(HARDCOVER_LOADER_BUDGET_MS) {
                        hardcoverGatherer.enrich(gathered.entries.map { it.title }, profile.topTags, userBooks)
                    }
                }
                if (hardcover?.failed == true) synchronized(failures) { failures += "Hardcover" }
                SourceParts(
                    novelEntries = gathered.entries,
                    hardcoverScores = hardcover?.scoresByTitleKey.orEmpty(),
                    hardcoverCandidates = hardcover?.discovery.orEmpty() + hardcoverBooks?.books.orEmpty().map(::hardcoverBookToRecommendationCandidate),
                )
            }
        }

        val parts = sourceJobs.await()
        feedJob.await()
        val trackerTaste = capProviderResults(dedupeTrackSearches(synchronized(tasteSink) { tasteSink.toList() }))
        // Then the works the trackers (comics) or Kitsu (novels) found in those genres are looked up by
        // title in the extensions that cannot list the genre, and the new works get their ratings.
        val extraScores = coroutineScope {
            if (mode == DiscoverMode.COMICS) {
                val poolKeys = parts.comicEntries.mapTo(HashSet()) { recommendationTitleKey(it.first.title, RecommendationContentType.MANGA) }
                val isKnown = { item: TrackerCatalogInput ->
                    isKnownTrackerResult(item, knownTitles, knownProviders) ||
                        recommendationTitleKey(item.title, RecommendationContentType.MANGA) in poolKeys
                }
                val genreTitles = genreRun.feed.entries.map { it.title }
                launch {
                    withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                        genreFeeds.lookUpTrackerWorks(genreRun, GenreFeedKind.TASTE, trackerTaste, isKnown, SEARCH_TRACKER_SOURCE_INITIAL_TITLES)
                    }
                }
                exploreRun?.let { state ->
                    launch {
                        withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                            genreFeeds.lookUpTrackerWorks(genreRun, GenreFeedKind.EXPLORE, state.results, isKnown, SEARCH_TRACKER_SOURCE_INITIAL_TITLES)
                        }
                    }
                }
                withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                    trackerGatherer.fetchScores(genreTitles, SEARCH_GENRE_SCORE_TITLE_LIMIT)
                }.orEmpty()
            } else {
                kitsuRun?.let { state ->
                    val novelKeys = parts.novelEntries.mapTo(HashSet()) { recommendationTitleKey(it.title, RecommendationContentType.NOVEL) }
                    val isKnown = { candidate: RecommendationCandidate ->
                        isKnownRecommendationCandidate(candidate, knownTitles, knownProviders) || candidate.titleKeys().any { it in novelKeys }
                    }
                    val genreTitles = genreRun.feed.entries.map { it.title }
                    launch {
                        withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                            genreFeeds.rateKitsuTitles(state, parts.novelEntries.map { it.title }, KITSU_NOVEL_SCORE_LIMIT)
                        }
                    }
                    launch {
                        withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                            genreFeeds.rateKitsuTitles(state, genreTitles, SEARCH_GENRE_SCORE_TITLE_LIMIT)
                        }
                    }
                    for (kind in GenreFeedKind.entries) {
                        launch {
                            withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                                genreFeeds.lookUpKitsuWorks(genreRun, state, kind, isKnown, SEARCH_TRACKER_SOURCE_INITIAL_TITLES)
                            }
                        }
                    }
                }
                emptyList<TrackerCatalogInput>()
            }
        }
        val pool = DiscoverPool(
            mode = mode,
            candidates = emptyList(),
            profile = profile,
            seedCount = seeds.size,
            knownTitleKeys = knownTitles,
            knownProviderKeys = knownProviders,
            failedProviders = failures.toList(),
            libraryCandidates = libraryEntries.map { entryToRecommendationCandidate(it, nowMs) } + books.map { bookToRecommendationCandidate(it, nowMs) },
            trackerRecordCandidates = trackerRecordCandidates,
            comicEntries = parts.comicEntries,
            sourceCursors = parts.sourceCursors,
            novelEntries = parts.novelEntries,
            trackerTrending = parts.trackerTrending,
            trackerScores = mergeTrackerScoreResults(parts.trackerScores, extraScores),
            hardcoverScores = parts.hardcoverScores,
            hardcoverCandidates = parts.hardcoverCandidates,
            nsfwSourceIds = nsfwSourceIds,
            gatheredAtMs = nowMs,
            librarySignature = librarySignature,
            genreFeed = genreRun.feed,
            trackerTaste = trackerTaste,
            trackerExplore = exploreRun?.feed,
            trackerExploreResults = exploreRun?.results.orEmpty(),
            kitsuFeed = kitsuRun?.feed,
        )
        pool.copy(candidates = assembleDiscoverCandidates(pool))
    }

    /** Pure ranking over a gathered pool; safe to re-run for filter toggles without network. */
    fun rank(pool: DiscoverPool, includeInLibrary: Boolean, includeNsfw: Boolean, nowMs: Long): DiscoverResult {
        val sections = buildRecommendationSections(
            pool.candidates,
            pool.profile,
            filterOptions(pool, includeInLibrary, includeNsfw, nowMs),
        )
        return DiscoverResult(sections.filter { it.items.isNotEmpty() }, pool.seedCount, pool.failedProviders)
    }

    /** Discover › Catalog over the same pool and filters as [rank]; no network. */
    fun catalog(pool: DiscoverPool, includeInLibrary: Boolean, includeNsfw: Boolean, nowMs: Long): List<DiscoverCatalogEntry> =
        buildDiscoverCatalog(pool.candidates, filterOptions(pool, includeInLibrary, includeNsfw, nowMs))

    /** Catalog with genres: the pool's works tagged with them, then the genre search results; no network. */
    fun genreCatalog(
        pool: DiscoverPool,
        search: DiscoverGenreSearch,
        includeInLibrary: Boolean,
        includeNsfw: Boolean,
        nowMs: Long,
    ): List<DiscoverCatalogEntry> {
        val searchCandidates = search.entries.map { entry ->
            val candidate = entryToRecommendationCandidate(entry, nowMs, novelSourceResult = pool.mode == DiscoverMode.NOVELS)
            if (entry.sourceId in pool.nsfwSourceIds) candidate.asAdult() else candidate
        }
        return buildDiscoverGenreCatalog(
            pool.candidates,
            searchCandidates,
            filterOptions(pool, includeInLibrary, includeNsfw, nowMs),
            search.genres,
        )
    }

    /** Next page of the Catalog genre search, over the same sources the pool was gathered from. */
    suspend fun searchGenre(pool: DiscoverPool, search: DiscoverGenreSearch, includeNsfw: Boolean): DiscoverGenreSearch =
        fetchGenreSearchPage(sourceManager, search, pool.nsfwSourceIds, includeNsfw)

    /** Genres the Catalog filter offers, without the ones the user blocked. */
    fun genreOptions(includeNsfw: Boolean): List<String> =
        discoverGenreOptions(includeNsfw, blockedTags())

    private fun blockedTags(): List<String> =
        if (preferences.filterBlockedTags().get()) preferences.blockedTags().get().toList() else emptyList()

    private fun filterOptions(pool: DiscoverPool, includeInLibrary: Boolean, includeNsfw: Boolean, nowMs: Long) =
        BuildRecommendationSectionsOptions(
            includeInLibrary = includeInLibrary,
            knownTitleKeys = pool.knownTitleKeys,
            knownProviderKeys = pool.knownProviderKeys,
            includeNsfw = includeNsfw,
            blockedTags = blockedTags(),
            nowMs = nowMs,
            limitPerSection = SEARCH_RECOMMENDATION_MAX_LIMIT,
        )

    /**
     * Desktop `loadMoreSearchRecommendations`: fetches the next source page for a section that has
     * no more hidden ranked items, merges it into the pool, and reports whether the rail may grow.
     */
    suspend fun loadMore(
        pool: DiscoverPool,
        key: RecommendationSectionKey,
        includeNsfw: Boolean,
        sectionSizeOf: (DiscoverPool) -> Int,
    ): DiscoverMoreResult {
        if (key in pool.exhausted) return DiscoverMoreResult(pool, false)
        val kind = genreFeedKind(pool.mode, key) ?: return loadMoreFromSources(pool, key, includeNsfw, sectionSizeOf)

        // Desktop: a row's scroll reads its genre feeds first, then the next source pages.
        val startingSize = sectionSizeOf(pool)
        val scrolled = reassembled(scrollGenreFeeds(pool, kind, includeNsfw))
        if (sectionSizeOf(scrolled) > startingSize) return DiscoverMoreResult(scrolled, true)
        val more = loadMoreFromSources(scrolled, key, includeNsfw, sectionSizeOf)
        // A row whose genre lists still have pages is not done, however the source pages ran.
        return if (key in more.pool.exhausted && hasGenreFeedLeft(more.pool, kind)) {
            more.copy(pool = more.pool.copy(exhausted = more.pool.exhausted - key))
        } else {
            more
        }
    }

    /**
     * Desktop `loadMoreSearchGenreSources` with the tracker (comics) or Kitsu (novels) feeds of the
     * row: the next pages of its genre lists, more of its tracker works looked up by title, and
     * ratings for the new works.
     */
    private suspend fun scrollGenreFeeds(pool: DiscoverPool, kind: GenreFeedKind, includeNsfw: Boolean): DiscoverPool {
        val genreRun = pool.genreFeed?.let(::GenreSourceFeedRun)
        val before = pool.genreFeed?.entries.orEmpty().mapTo(HashSet(), ::genreEntryKey)
        fun freshTitles() = genreRun?.feed?.entries.orEmpty().filter { genreEntryKey(it) !in before }.map { it.title }
        if (pool.mode == DiscoverMode.COMICS) {
            val exploreRun = if (kind == GenreFeedKind.EXPLORE) {
                pool.trackerExplore?.let { AniListExploreRun(it, pool.trackerExploreResults) }
            } else {
                null
            }
            val poolKeys = pool.comicEntries.mapTo(HashSet()) { recommendationTitleKey(it.first.title, RecommendationContentType.MANGA) }
            val isKnown = { item: TrackerCatalogInput ->
                isKnownTrackerResult(item, pool.knownTitleKeys, pool.knownProviderKeys) ||
                    recommendationTitleKey(item.title, RecommendationContentType.MANGA) in poolKeys
            }
            val results = if (kind == GenreFeedKind.TASTE) pool.trackerTaste else pool.trackerExploreResults
            coroutineScope {
                genreRun?.let { state ->
                    launch { withTimeoutOrNull(GENRE_FEED_BUDGET_MS) { genreFeeds.readComicPages(state, scrollGenreCursors(state.feed, kind)) } }
                    launch {
                        withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                            genreFeeds.lookUpTrackerWorks(state, kind, results, isKnown, SEARCH_TRACKER_SOURCE_SCROLL_TITLES)
                        }
                    }
                }
                exploreRun?.let { state ->
                    launch { withTimeoutOrNull(GENRE_FEED_BUDGET_MS) { trackerGatherer.scrollExploreFeed(state, pool.profile, includeNsfw) } }
                }
            }
            val fresh = freshTitles()
            val scores = if (fresh.isEmpty()) {
                emptyList()
            } else {
                withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) { trackerGatherer.fetchScores(fresh, SEARCH_GENRE_SCORE_TITLE_LIMIT) }.orEmpty()
            }
            return pool.copy(
                genreFeed = genreRun?.feed ?: pool.genreFeed,
                trackerExplore = exploreRun?.feed ?: pool.trackerExplore,
                trackerExploreResults = exploreRun?.results ?: pool.trackerExploreResults,
                trackerScores = mergeTrackerScoreResults(pool.trackerScores, scores),
            )
        }

        val kitsuRun = pool.kitsuFeed?.let(::KitsuNovelRun)
        val novelKeys = pool.novelEntries.mapTo(HashSet()) { recommendationTitleKey(it.title, RecommendationContentType.NOVEL) }
        val isKnown = { candidate: RecommendationCandidate ->
            isKnownRecommendationCandidate(candidate, pool.knownTitleKeys, pool.knownProviderKeys) || candidate.titleKeys().any { it in novelKeys }
        }
        coroutineScope {
            kitsuRun?.let { state ->
                launch {
                    withTimeoutOrNull(GENRE_FEED_BUDGET_MS) {
                        genreFeeds.scrollKitsu(state, kind, includeNsfw, pool.novelEntries.map { it.title })
                    }
                }
            }
            genreRun?.let { state ->
                launch { withTimeoutOrNull(GENRE_FEED_BUDGET_MS) { genreFeeds.readNovelPages(state, scrollGenreCursors(state.feed, kind)) } }
                kitsuRun?.let { kitsuState ->
                    launch {
                        withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) {
                            genreFeeds.lookUpKitsuWorks(state, kitsuState, kind, isKnown, SEARCH_TRACKER_SOURCE_SCROLL_TITLES)
                        }
                    }
                }
            }
        }
        val fresh = freshTitles()
        if (kitsuRun != null && fresh.isNotEmpty()) {
            withTimeoutOrNull(GENRE_LOOKUP_BUDGET_MS) { genreFeeds.rateKitsuTitles(kitsuRun, fresh, SEARCH_GENRE_SCORE_TITLE_LIMIT) }
        }
        return pool.copy(genreFeed = genreRun?.feed ?: pool.genreFeed, kitsuFeed = kitsuRun?.feed ?: pool.kitsuFeed)
    }

    private suspend fun loadMoreFromSources(
        pool: DiscoverPool,
        key: RecommendationSectionKey,
        includeNsfw: Boolean,
        sectionSizeOf: (DiscoverPool) -> Int,
    ): DiscoverMoreResult {

        // COMICS + TRENDING_NEAR_YOUR_TASTE
        if (pool.mode == DiscoverMode.COMICS && key == RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE) {
            val page = pool.trackerTrendingPage + 1
            val incoming = trackerGatherer.fetchTrendingPage(page)
            if (incoming.isEmpty()) return DiscoverMoreResult(pool, true)
            val next = pool.copy(
                trackerTrending = capProviderResults(dedupeTrackSearches(pool.trackerTrending + incoming)),
                trackerTrendingPage = page,
            )
            return DiscoverMoreResult(reassembled(next), true)
        }

        // COMICS + HIGH_CONFIDENCE
        if (pool.mode == DiscoverMode.COMICS && key == RecommendationSectionKey.HIGH_CONFIDENCE) {
            val page = (pool.morePages[key] ?: 1) + 1
            val gatherer = ComicRecommendationGatherer(sourceManager, pool.sourceCursors)
            val incoming = gatherer.fetchMore(pool.nsfwSourceIds, includeNsfw, page, latest = false)
            if (incoming == null) return DiscoverMoreResult(pool, false)
            val next = withPage(pool, key, page).copy(sourceCursors = gatherer.cursorSnapshot())
            if (incoming.isEmpty()) {
                val exhausted = if (page >= SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT) exhaust(next, key) else next
                return DiscoverMoreResult(exhausted, true)
            }
            val comicEntries = mergeComicMore(pool.comicEntries, incoming, latest = false)
            val scores = trackerGatherer.fetchScores(incoming.map { it.title })
            val trackerScores = mergeTrackerScoreResults(pool.trackerScores, scores)
            val updated = next.copy(comicEntries = comicEntries, trackerScores = trackerScores)
            return DiscoverMoreResult(reassembled(updated), true)
        }

        // Every other case
        val startingSize = sectionSizeOf(pool)
        val latest = pool.mode == DiscoverMode.COMICS && key == RecommendationSectionKey.FRESH_IN_YOUR_SOURCES
        val startPage = (pool.morePages[key] ?: 1) + 1
        var current = pool
        var added = false
        val comicGatherer = ComicRecommendationGatherer(sourceManager, pool.sourceCursors)
        for (attemptPage in startPage until startPage + 4) {
            val incoming = if (pool.mode == DiscoverMode.COMICS) {
                comicGatherer.fetchMore(pool.nsfwSourceIds, includeNsfw, attemptPage, latest)
            } else {
                NovelRecommendationGatherer(sourceManager).fetchMore(pool.profile, pool.nsfwSourceIds, includeNsfw, attemptPage)
            }
            if (incoming == null) break
            current = withPage(current, key, attemptPage)
            if (pool.mode == DiscoverMode.COMICS) current = current.copy(sourceCursors = comicGatherer.cursorSnapshot())
            if (incoming.isEmpty()) continue
            val beforeCount = when {
                pool.mode == DiscoverMode.COMICS && latest -> current.comicEntries.count { it.second }
                pool.mode == DiscoverMode.COMICS -> current.comicEntries.size
                else -> current.novelEntries.size
            }
            current = if (pool.mode == DiscoverMode.COMICS) {
                current.copy(comicEntries = mergeComicMore(current.comicEntries, incoming, latest))
            } else {
                current.copy(novelEntries = mergeNovelMore(current.novelEntries, incoming))
            }
            current = reassembled(current)
            val afterCount = when {
                pool.mode == DiscoverMode.COMICS && latest -> current.comicEntries.count { it.second }
                pool.mode == DiscoverMode.COMICS -> current.comicEntries.size
                else -> current.novelEntries.size
            }
            if (afterCount > beforeCount || sectionSizeOf(current) > startingSize) {
                added = true
                break
            }
        }
        if (!added && (current.morePages[key] ?: startPage) >= SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT) {
            current = exhaust(current, key)
        }
        return DiscoverMoreResult(current, added)
    }

    private fun withPage(pool: DiscoverPool, key: RecommendationSectionKey, page: Int): DiscoverPool =
        pool.copy(morePages = pool.morePages + (key to page))

    private fun exhaust(pool: DiscoverPool, key: RecommendationSectionKey): DiscoverPool =
        pool.copy(exhausted = pool.exhausted + key)

    private fun reassembled(pool: DiscoverPool): DiscoverPool =
        pool.copy(candidates = assembleDiscoverCandidates(pool))

    /**
     * Identifies the library a pool was built from: its works, which of their sources are
     * available (a synced work is told apart as comic or novel only once its source is installed),
     * and their genres, which arrive after sync once the installed extension fills in details and
     * are the taste profile's tags.
     */
    suspend fun librarySignature(): Int = librarySignature(getLibraryManga.await().distinctBy { it.manga.id })

    private fun librarySignature(library: List<LibraryManga>): Int = library
        .map { Triple(it.manga.id, sourceManager.get(it.manga.source) != null, it.manga.genre) }
        .sortedBy { it.first }
        .hashCode()

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

    /**
     * Desktop `comicOriginForRecords` and the library's AniList lookup: asks AniList for the country of
     * the tracked works and of the most read untracked ones, within [COMIC_ORIGIN_BUDGET_MS], then
     * reads every answer known so far. What is not asked this time is asked on a later visit.
     */
    private suspend fun resolveComicOrigins(
        entries: List<RecommendationEntryInput>,
        tracksByManga: Map<Long, List<Track>>,
    ): ComicOrigins {
        val trackPairs = tracksByManga.values.flatten()
            .filter { (it.sync_id == TrackManager.ANILIST || it.sync_id == TrackManager.MYANIMELIST) && it.media_id > 0 }
            .map { it.sync_id to it.media_id }
            .distinct()
        val untrackedTitles = entries
            .filter { entry -> tracksByManga[entry.mangaId].orEmpty().none { it.sync_id == TrackManager.ANILIST || it.sync_id == TrackManager.MYANIMELIST } }
            .sortedByDescending(::entryImplicitWeight)
            .map { it.title }
        runCatching {
            withTimeoutOrNull(COMIC_ORIGIN_BUDGET_MS) {
                comicOriginLookup.refreshTracks(trackPairs)
                comicOriginLookup.refreshTitles(untrackedTitles, COMIC_ORIGIN_TITLE_REQUESTS)
            }
        }
        return runCatching {
            ComicOrigins(
                byTrack = comicOriginLookup.cachedTracks(trackPairs.map { comicOriginTrackKey(it.first, it.second) }),
                byTitle = comicOriginLookup.cachedTitles(entries.map { it.title }),
            )
        }.getOrDefault(ComicOrigins.NONE)
    }

    private fun Track.toTasteSeed(manga: SManga?, origin: RecommendationContentType?): TasteProfileSeedItem {
        val trackInput = toInput()
        return TasteProfileSeedItem(
            id = "tracker:$sync_id:$media_id",
            title = manga?.title ?: title,
            tags = manga?.getGenres().orEmpty(),
            contentType = origin ?: RecommendationContentType.MANGA,
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
        /** Genre lists and tracker/Kitsu feeds: what arrived by then is kept, the rest is read on scroll. */
        private const val GENRE_FEED_BUDGET_MS = 22_000L
        /** Title lookups and ratings of the genre feeds' works. */
        private const val GENRE_LOOKUP_BUDGET_MS = 10_000L
        /** Countries of origin asked per visit; answers are kept, so later visits ask only for new works. */
        private const val COMIC_ORIGIN_BUDGET_MS = 8_000L
        private const val COMIC_ORIGIN_TITLE_REQUESTS = 6
    }
}

private fun Track.originKey() = comicOriginTrackKey(sync_id, media_id)
