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
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.network.awaitSuccess
import eu.kanade.tachiyomi.network.jsonMime
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.isNovelSource
import eu.kanade.tachiyomi.source.model.SManga
import exh.source.EH_SOURCE_ID
import exh.source.EXH_SOURCE_ID
import java.time.LocalDate
import java.time.ZoneOffset
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.RequestBody.Companion.toRequestBody
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
    private val network: NetworkHelper = get(),
    private val preferences: PreferencesHelper = get(),
    private val extensionManager: ExtensionManager = get(),
) {
    suspend fun load(mode: DiscoverMode, nowMs: Long = System.currentTimeMillis()): DiscoverResult = coroutineScope {
        val library = getLibraryManga.await().distinctBy { it.manga.id }
        val tracksByManga = runCatching { getTrack.awaitAllGroupedByMangaId() }.getOrDefault(emptyMap())
        val libraryEntries = library.mapNotNull { it.toInput(tracksByManga[it.manga.id].orEmpty()) }
            .filter { it.isNovel == (mode == DiscoverMode.NOVELS) }
        val books = if (mode == DiscoverMode.NOVELS) loadBooks() else emptyList()

        val seeds = libraryEntries.map(::entryToTasteProfileSeed) + books.map(::bookToTasteProfileSeed)
        val profile = buildTasteProfile(seeds)
        val failures = mutableListOf<String>()

        val nsfwSourceIds = extensionManager.installedExtensionsFlow.value
            .filter { it.isNsfw }
            .flatMapTo(HashSet()) { ext -> ext.sources.map { it.id } }
            .apply { add(EH_SOURCE_ID); add(EXH_SOURCE_ID) }
        val sources = topSources(libraryEntries, mode, nsfwSourceIds)
        val sourceJobs = sources.map { source ->
            async {
                val popular = fetchSource(source, latest = false)
                val latest = if (mode == DiscoverMode.COMICS && source.supportsLatest) fetchSource(source, latest = true) else emptyList()
                if (popular == null) synchronized(failures) { failures += source.name }
                val found = popular.orEmpty().map { entryToRecommendationCandidate(it, nowMs, novelSourceResult = mode == DiscoverMode.NOVELS) } +
                    applyLatestFeedRank(latest.orEmpty().map { entryToRecommendationCandidate(it, nowMs) })
                // Adult extensions rarely tag their entries, so the extension flag is the safety signal.
                if (source.id in nsfwSourceIds) found.map { it.asAdult() } else found
            }
        }
        val trending = async {
            runCatching { fetchAniListTrending(mode) }
                .onFailure { synchronized(failures) { failures += "AniList" } }
                .getOrDefault(emptyList())
                .map { trackerCatalogToRecommendationCandidate(it, nowMs) }
        }

        val candidates = mergeRecommendationCandidates(
            libraryEntries.map { entryToRecommendationCandidate(it, nowMs) } +
                books.map { bookToRecommendationCandidate(it, nowMs) } +
                sourceJobs.awaitAll().flatten() +
                trending.await(),
        )
        val sections = buildRecommendationSections(
            candidates,
            profile,
            BuildRecommendationSectionsOptions(
                knownTitleKeys = knownTitleKeys(seeds),
                knownProviderKeys = knownProviderKeys(libraryEntries),
                includeNsfw = preferences.showNsfwSources().get(),
                nowMs = nowMs,
                limitPerSection = SECTION_LIMIT,
            ),
        )
        DiscoverResult(withoutRepeats(sections), seeds.size, failures.toList())
    }

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

    /**
     * The installed sources the library uses most, falling back to any visible source. Adult
     * extensions are only queried when the library already reads from them.
     */
    private fun topSources(
        entries: List<RecommendationEntryInput>,
        mode: DiscoverMode,
        nsfwSourceIds: Set<Long>,
    ): List<CatalogueSource> {
        val wantNovel = mode == DiscoverMode.NOVELS
        val visible = sourceManager.getVisibleCatalogueSources()
            .filter { it.isNovelSource() == wantNovel && it.id != LOCAL_SOURCE_ID }
        val byId = visible.associateBy { it.id }
        val used = entries.groupingBy { it.sourceId }.eachCount()
            .entries.sortedByDescending { it.value }
            .mapNotNull { byId[it.key] }
        val fallback = visible.filterNot { it.id in nsfwSourceIds }
        val limit = if (wantNovel) NOVEL_SOURCE_LIMIT else COMIC_SOURCE_LIMIT
        return (used + fallback).distinctBy { it.id }.take(limit)
    }

    private fun RecommendationCandidate.asAdult(): RecommendationCandidate =
        if (safety.ordinal < RecommendationSafetyLevel.ADULT.ordinal) copy(safety = RecommendationSafetyLevel.ADULT) else this

    /** On a phone the sections stack vertically, so a title is shown only in its first section. */
    private fun withoutRepeats(sections: List<RecommendationSection>): List<RecommendationSection> {
        val shown = HashSet<String>()
        return sections.mapNotNull { section ->
            val items = section.items.filter { item ->
                val keys = item.candidate.identityKeys()
                if (keys.any { it in shown }) false else { shown += keys; true }
            }
            section.copy(items = items).takeIf { items.isNotEmpty() }
        }
    }

    private suspend fun fetchSource(source: CatalogueSource, latest: Boolean): List<RecommendationEntryInput>? {
        val page = runCatching {
            withTimeoutOrNull(SOURCE_TIMEOUT_MS) {
                if (latest) source.getLatestUpdates(1) else source.getPopularManga(1)
            }
        }.getOrNull() ?: return null
        return page.mangas.take(SOURCE_RESULT_LIMIT).map { it.toInput(source) }
    }

    private fun SManga.toInput(source: CatalogueSource) = RecommendationEntryInput(
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

    private suspend fun fetchAniListTrending(mode: DiscoverMode): List<TrackerCatalogInput> {
        val formatFilter = if (mode == DiscoverMode.NOVELS) ", format_in: [NOVEL]" else ", format_not_in: [NOVEL]"
        val query = """
            query(${'$'}page: Int!, ${'$'}perPage: Int!) {
              Page(page: ${'$'}page, perPage: ${'$'}perPage) {
                media(type: MANGA, sort: [TRENDING_DESC, POPULARITY_DESC], isAdult: false$formatFilter) {
                  id title { romaji english native } coverImage { large extraLarge } status format
                  countryOfOrigin averageScore meanScore popularity trending genres startDate { year month day }
                }
              }
            }
        """.trimIndent()
        val payload = buildJsonObject {
            put("query", query)
            putJsonObject("variables") {
                put("page", 1)
                put("perPage", ANILIST_PAGE_SIZE)
            }
        }
        val body = withTimeoutOrNull(SOURCE_TIMEOUT_MS) {
            network.client.newCall(POST(ANILIST_URL, body = payload.toString().toRequestBody(jsonMime)))
                .awaitSuccess()
                .use { it.body.string() }
        } ?: error("AniList timed out")
        val media = Json.parseToJsonElement(body).jsonObject["data"]?.jsonObject
            ?.get("Page")?.jsonObject?.get("media") as? JsonArray ?: return emptyList()
        val trackerName = runCatching { trackManager.aniList.displayName() }.getOrDefault("AniList")
        return media.mapNotNull { (it as? JsonObject)?.toAniListInput(trackerName) }
    }

    private fun JsonObject.toAniListInput(trackerName: String): TrackerCatalogInput? {
        val id = this["id"]?.primitiveInt() ?: return null
        val titles = this["title"] as? JsonObject
        val english = titles?.get("english")?.primitiveString()
        val romaji = titles?.get("romaji")?.primitiveString()
        val native = titles?.get("native")?.primitiveString()
        val title = english ?: romaji ?: native ?: return null
        val cover = (this["coverImage"] as? JsonObject)?.let {
            it["extraLarge"]?.primitiveString() ?: it["large"]?.primitiveString()
        }
        val format = this["format"]?.primitiveString()
        val publishingType = when (this["countryOfOrigin"]?.primitiveString()) {
            "KR" -> "MANHWA"
            "CN", "TW" -> "MANHUA"
            "JP" -> if (format == "NOVEL") "NOVEL" else "MANGA"
            else -> format
        }.let { if (format == "NOVEL") "NOVEL" else it }
        val start = this["startDate"] as? JsonObject
        val startMs = start?.get("year")?.primitiveInt()?.let { year ->
            runCatching {
                LocalDate.of(year, start["month"]?.primitiveInt() ?: 1, start["day"]?.primitiveInt() ?: 1)
                    .atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli()
            }.getOrNull()
        }
        return TrackerCatalogInput(
            trackerId = TrackManager.ANILIST,
            trackerName = trackerName,
            remoteId = id.toString(),
            title = title,
            alternativeTitles = listOfNotNull(english, romaji, native),
            coverUrl = cover,
            genres = (this["genres"] as? JsonArray)?.mapNotNull { it.primitiveString() }.orEmpty(),
            publishingType = publishingType,
            publishingStatus = this["status"]?.primitiveString(),
            score = (this["averageScore"]?.primitiveDouble() ?: this["meanScore"]?.primitiveDouble()),
            scoreMax = 100.0,
            popularity = this["popularity"]?.primitiveDouble(),
            trending = this["trending"]?.primitiveDouble(),
            startDateMs = startMs,
        )
    }

    private fun JsonElement.primitiveString(): String? =
        runCatching { jsonPrimitive.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() } }.getOrNull()

    private fun JsonElement.primitiveInt(): Int? = runCatching { jsonPrimitive.intOrNull }.getOrNull()

    private fun JsonElement.primitiveDouble(): Double? = runCatching { jsonPrimitive.doubleOrNull }.getOrNull()

    private fun statusText(status: Int): String? = when (status) {
        SManga.ONGOING -> "ongoing"
        SManga.COMPLETED, SManga.PUBLISHING_FINISHED -> "completed"
        SManga.CANCELLED -> "cancelled"
        SManga.ON_HIATUS -> "hiatus"
        else -> null
    }

    companion object {
        private const val ANILIST_URL = "https://graphql.anilist.co"
        private const val ANILIST_PAGE_SIZE = 40
        private const val LOCAL_SOURCE_ID = 0L
        private const val COMIC_SOURCE_LIMIT = 3
        private const val NOVEL_SOURCE_LIMIT = 2
        private const val SOURCE_RESULT_LIMIT = 40
        private const val SOURCE_TIMEOUT_MS = 20_000L
        private const val SECTION_LIMIT = 24
    }
}
