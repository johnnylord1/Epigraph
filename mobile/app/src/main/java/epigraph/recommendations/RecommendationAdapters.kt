package epigraph.recommendations

import eu.kanade.tachiyomi.data.track.hardcover.Hardcover
import eu.kanade.tachiyomi.data.track.hardcover.HardcoverBookResult
import eu.kanade.tachiyomi.data.track.hardcover.HardcoverLibraryBook

import java.util.Calendar
import java.util.Locale
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlinx.serialization.Serializable


/**
 * Pure adapters from app data to engine inputs, mirroring the desktop `adapters.ts`. The loader
 * flattens database/source/tracker objects into these inputs first so the mapping stays testable
 * without Android, a database, or network access.
 */
@Serializable
data class RecommendationTrackInput(
    val trackerId: Long,
    val trackerName: String,
    val remoteId: String,
    /** The tracker score on a 10-point scale; null or 0 when the entry is unscored. */
    val score10: Double?,
    val status: TasteSeedStatus? = null,
    val dateMs: Long? = null,
)

@Serializable
data class RecommendationEntryInput(
    val mangaId: Long?,
    val url: String,
    val title: String,
    val description: String? = null,
    val genres: List<String> = emptyList(),
    val publicationStatus: String? = null,
    val sourceId: Long,
    val sourceName: String,
    val sourceLang: String? = null,
    val coverUrl: String? = null,
    val isNovel: Boolean,
    val inLibrary: Boolean,
    val unreadCount: Int = 0,
    val downloadCount: Int = 0,
    val chapterCount: Int = 0,
    val lastUpdateMs: Long? = null,
    val tracks: List<RecommendationTrackInput> = emptyList(),
    /** The format by the publisher's country (see [ComicOriginLookup]); beats source and tag guesses. */
    val comicOrigin: RecommendationContentType? = null,
)

data class RecommendationBookInput(
    val bookId: String,
    val title: String,
    /** "epub" or "pdf". */
    val subtype: String,
    val coverPath: String? = null,
    /** Reading progress in 0..1, or null when the book was never opened. */
    val progress: Double? = null,
    val importedAtMs: Long? = null,
    val updatedAtMs: Long? = null,
)

@Serializable
data class TrackerCatalogInput(
    val trackerId: Long,
    val trackerName: String,
    val remoteId: String,
    val title: String,
    val alternativeTitles: List<String> = emptyList(),
    val coverUrl: String? = null,
    val genres: List<String> = emptyList(),
    val publishingType: String? = null,
    val publishingStatus: String? = null,
    val score: Double? = null,
    val scoreMax: Double = 100.0,
    val popularity: Double? = null,
    val trending: Double? = null,
    val startDateMs: Long? = null,
)

fun RecommendationEntryInput.recommendationId(): String = when {
    mangaId != null -> "${if (isNovel) "novel" else "manga"}:$mangaId"
    else -> "source:$sourceId:$url"
}

fun RecommendationEntryInput.contentType(): RecommendationContentType =
    if (isNovel) {
        RecommendationContentType.NOVEL
    } else {
        comicOrigin ?: inferComicContentType(title, description, genres, sourceName, sourceLang)
    }

fun entryToTasteProfileSeed(entry: RecommendationEntryInput): TasteProfileSeedItem {
    val bestTrack = entry.tracks
        .filter { (it.score10 ?: 0.0) > 0.0 }
        .maxByOrNull { it.score10 ?: 0.0 }
    val statusTrack = bestTrack ?: entry.tracks.firstOrNull()
    return TasteProfileSeedItem(
        id = entry.recommendationId(),
        title = entry.title,
        tags = entry.genres,
        contentType = entry.contentType(),
        sourceId = entry.sourceId.toString(),
        userRating = bestTrack?.score10,
        userRatingMax = bestTrack?.let { 10.0 },
        implicitWeight = if (entry.inLibrary) entryImplicitWeight(entry) else 0.0,
        // The publication status ("ONGOING", "COMPLETED") says nothing about the
        // reader; only a tracker record knows whether they dropped or finished it.
        status = if (entry.isNovel) {
            TasteSeedStatus.UNKNOWN
        } else {
            statusTrack?.let { trackRecordSeedStatus(it) } ?: TasteSeedStatus.UNKNOWN
        },
    )
}

/**
 * Reading status of a tracker record. Tracker status values differ per service, so the
 * status name is preferred; the finish date is only a fallback when the name is unknown.
 */
fun trackRecordSeedStatus(record: RecommendationTrackInput): TasteSeedStatus {
    val normalizedName = record.status?.name?.trim()?.lowercase(Locale.ROOT).orEmpty()
    if (SEED_STATUS_DROPPED_PATTERN.containsMatchIn(normalizedName)) return TasteSeedStatus.DROPPED
    if (SEED_STATUS_PLANNING_PATTERN.containsMatchIn(normalizedName)) return TasteSeedStatus.PLANNING
    if (SEED_STATUS_COMPLETED_PATTERN.containsMatchIn(normalizedName)) return TasteSeedStatus.COMPLETED
    if (SEED_STATUS_READING_PATTERN.containsMatchIn(normalizedName)) return TasteSeedStatus.READING
    if (hasTrackRecordDate(record.dateMs)) return TasteSeedStatus.COMPLETED
    return TasteSeedStatus.PLANNING
}

private fun hasTrackRecordDate(value: Long?): Boolean = value != null && value > 0

internal fun entryImplicitWeight(entry: RecommendationEntryInput): Double = when {
    entry.isNovel -> if (entry.chapterCount > 30) 0.55 else 0.4
    entry.unreadCount > 0 -> 0.55
    entry.downloadCount > 0 -> 0.65
    else -> 0.4
}

/** A library or source entry; [novelSourceResult] applies the desktop's novel-source priors. */
fun entryToRecommendationCandidate(
    entry: RecommendationEntryInput,
    nowMs: Long,
    novelSourceResult: Boolean = false,
): RecommendationCandidate {
    val sourceProvider = if (novelSourceResult) {
        RecommendationProviderSignal(
            providerId = entry.sourceId.toString(),
            providerName = entry.sourceName,
            kind = RecommendationProviderKind.SOURCE,
            availability = normalizeScore(1.0, 1.0, 0.82),
            popularity = NormalizedMetric(0.58, 0.36, "novel-source-result"),
            trending = NormalizedMetric(0.22, 0.28, "novel-source-result"),
            recency = NormalizedMetric(0.24, 0.3, "novel-source-result"),
        )
    } else {
        RecommendationProviderSignal(
            providerId = entry.sourceId.toString(),
            providerName = entry.sourceName,
            kind = RecommendationProviderKind.SOURCE,
            availability = normalizeScore(1.0, 1.0, 0.75),
            recency = if (entry.isNovel) normalizeRecency(entry.lastUpdateMs, nowMs, 21.0, 0.55) else null,
        )
    }
    val tags = if (novelSourceResult) {
        (entry.genres + listOf("novel", "webnovel", entry.sourceLang.orEmpty())).filter { it.isNotBlank() }.distinct()
    } else {
        entry.genres
    }
    return RecommendationCandidate(
        id = entry.recommendationId(),
        title = entry.title,
        cover = entry.coverUrl?.takeIf { it.isNotBlank() }?.let { RecommendationCover(it, entry.sourceId) },
        tags = tags,
        contentType = entry.contentType(),
        status = entry.publicationStatus,
        providers = listOf(sourceProvider) + entry.tracks.map { it.toProviderSignal(nowMs) },
        inLibrary = entry.inLibrary,
        safety = inferRecommendationSafety(entry.genres),
        updatedAtMs = if (entry.isNovel) entry.lastUpdateMs else null,
        targets = listOf(RecommendationTarget(entry.sourceId, entry.url, entry.title)),
    )
}

private fun RecommendationTrackInput.toProviderSignal(nowMs: Long) = RecommendationProviderSignal(
    providerId = trackerId.toString(),
    providerName = trackerName,
    kind = RecommendationProviderKind.TRACKER,
    remoteId = remoteId,
    iconKey = inferTrackerIconKey(trackerName),
    score = score10?.takeIf { it > 0 }?.let { normalizeScore(it, 10.0, 0.9) },
    recency = normalizeRecency(dateMs, nowMs, 365.0, 0.35),
)

/**
 * The source's "latest" feed is already ordered by update time, so rank stands in for recency:
 * the first result scores 1.0 and the last one 0.2 (desktop `source-latest-feed-rank`).
 */
fun applyLatestFeedRank(candidates: List<RecommendationCandidate>): List<RecommendationCandidate> {
    val last = candidates.size - 1
    return candidates.mapIndexed { index, candidate ->
        val rankRatio = if (last <= 0) 1.0 else 1.0 - (index.toDouble() / last) * 0.8
        candidate.copy(
            updatedAtMs = null,
            providers = candidate.providers.map { provider ->
                if (provider.kind != RecommendationProviderKind.SOURCE) {
                    provider
                } else {
                    provider.copy(
                        recency = NormalizedMetric(max(0.2, rankRatio), 0.84, "source-latest-feed-rank", "${index + 1}"),
                    )
                }
            },
        )
    }
}

fun bookToTasteProfileSeed(book: RecommendationBookInput): TasteProfileSeedItem {
    val progress = book.progress
    return TasteProfileSeedItem(
        id = "book:${book.bookId}",
        title = book.title,
        tags = listOf("book", book.subtype),
        contentType = RecommendationContentType.BOOK,
        sourceId = book.subtype,
        implicitWeight = when {
            progress == null -> 0.3
            progress >= 0.98 -> 0.75
            progress >= 0.25 -> 0.6
            else -> 0.45
        },
        status = when {
            progress == null -> TasteSeedStatus.PLANNING
            progress >= 0.98 -> TasteSeedStatus.COMPLETED
            else -> TasteSeedStatus.READING
        },
    )
}

fun bookToRecommendationCandidate(book: RecommendationBookInput, nowMs: Long) = RecommendationCandidate(
    id = "book:${book.bookId}",
    title = book.title,
    cover = book.coverPath?.takeIf { it.isNotBlank() }?.let { RecommendationCover(it) },
    tags = listOf("book", book.subtype),
    contentType = RecommendationContentType.BOOK,
    status = book.subtype,
    inLibrary = true,
    updatedAtMs = book.updatedAtMs,
    publishedAtMs = book.importedAtMs,
    providers = listOf(
        RecommendationProviderSignal(
            providerId = "local-${book.subtype}",
            providerName = "${book.subtype.uppercase(Locale.ROOT)} library",
            kind = RecommendationProviderKind.SOURCE,
            availability = normalizeScore(1.0, 1.0, 0.8),
            recency = normalizeRecency(book.updatedAtMs, nowMs, 45.0, 0.35),
        ),
    ),
)

fun trackerCatalogToRecommendationCandidate(input: TrackerCatalogInput, nowMs: Long) = RecommendationCandidate(
    id = "tracker:${input.trackerId}:${input.remoteId}",
    title = input.title,
    alternativeTitles = input.alternativeTitles.filter { it.isNotBlank() && it != input.title }.distinct(),
    cover = input.coverUrl?.takeIf { it.isNotBlank() }?.let { RecommendationCover(it) },
    tags = (input.genres + listOfNotNull(input.publishingType, input.publishingStatus))
        .filter { it.isNotBlank() }
        .distinct(),
    contentType = inferTrackerContentType(input.publishingType, input.title),
    status = input.publishingStatus,
    safety = inferRecommendationSafety(input.genres),
    providers = listOf(
        RecommendationProviderSignal(
            providerId = input.trackerId.toString(),
            providerName = input.trackerName,
            kind = RecommendationProviderKind.TRACKER,
            remoteId = input.remoteId,
            iconKey = inferTrackerIconKey(input.trackerName),
            score = normalizeScore(input.score, input.scoreMax, if (input.score == null) 0.0 else 0.78),
            popularity = normalizeLogCount(input.popularity, 1_000_000.0, 0.62),
            trending = normalizeLogCount(input.trending, 500_000.0, 0.68),
            recency = normalizeRecency(input.startDateMs, nowMs, 365.0, 0.35),
        ),
    ),
)

/**
 * Hardcover library book to a recommendation candidate, mirroring the desktop
 * `hardcoverRecordToRecommendationCandidate`. The user's own rating wins over the
 * community rating for the provider score. Tags are the book's genres (filled from
 * the linked local work) plus the desktop base tags.
 */
fun hardcoverBookToRecommendationCandidate(book: HardcoverLibraryBook): RecommendationCandidate {
    val rating = book.userRating ?: book.rating
    return RecommendationCandidate(
        id = "hardcover:${book.bookId}",
        title = book.title,
        cover = book.coverUrl?.takeIf { it.isNotBlank() }?.let { RecommendationCover(it) },
        tags = (listOf("novel", "book", "hardcover") + book.tags).distinct(),
        contentType = RecommendationContentType.NOVEL,
        status = null,
        inLibrary = true,
        safety = RecommendationSafetyLevel.SAFE,
        updatedAtMs = book.updatedAtMs,
        providers = listOf(
            RecommendationProviderSignal(
                providerId = "hardcover",
                providerName = "Hardcover",
                kind = RecommendationProviderKind.TRACKER,
                remoteId = book.bookId.toString(),
                iconKey = "HC",
                score = normalizeScore(rating, 5.0, if (rating == null) 0.0 else 0.9),
            ),
        ),
    )
}

/** Desktop `hardcoverBookToProvider` (hardcover.ts 607): tracker signal for a search result. */
fun hardcoverBookResultToProvider(book: HardcoverBookResult): RecommendationProviderSignal =
    RecommendationProviderSignal(
        providerId = "hardcover",
        providerName = "Hardcover",
        kind = RecommendationProviderKind.TRACKER,
        remoteId = book.id.toString(),
        iconKey = "HC",
        score = normalizeScore(book.rating, 5.0, if (book.rating == null) 0.0 else 0.84),
    )

/**
 * Desktop `hardcoverBookToRecommendationCandidate` (BrowseV3 4524): discovery candidate from a
 * Hardcover search result. Tags are merged case-insensitively; providers carry rating,
 * popularity, and trending metrics plus a catalog availability signal.
 */
fun hardcoverDiscoveryToRecommendationCandidate(
    book: HardcoverBookResult,
    queryTags: List<String>,
): RecommendationCandidate {
    val provider = hardcoverBookResultToProvider(book)
    val ratingConfidence = if (book.rating == null) 0.0 else 0.84
    val popularityValue = if (book.ratingsCount != null && book.ratingsCount > 0)
        min(1.0, log10(book.ratingsCount + 1.0) / 5.0)
    else 0.38
    val hasRatings = book.ratingsCount != null && book.ratingsCount != 0
    val publishedAtMs = book.releaseYear?.let { year ->
        val cal = Calendar.getInstance()
        cal.clear()
        cal.set(year, Calendar.JANUARY, 1)
        cal.timeInMillis
    }
    return RecommendationCandidate(
        id = "hardcover-discovery:${book.id}",
        title = book.title,
        alternativeTitles = book.authors,
        cover = book.coverUrl?.let { RecommendationCover(it) },
        tags = mergeRecommendationTags(
            listOf("novel", "book", "hardcover") + book.genres + book.tags + book.moods,
            queryTags,
        ),
        contentType = RecommendationContentType.BOOK,
        status = book.releaseYear?.toString(),
        inLibrary = false,
        safety = RecommendationSafetyLevel.SAFE,
        publishedAtMs = publishedAtMs,
        providers = listOf(
            provider.copy(
                score = provider.score ?: NormalizedMetric(
                    value = if (book.rating != null && book.rating > 0) min(1.0, book.rating / 5.0) else 0.0,
                    confidence = ratingConfidence,
                    method = "hardcover-rating",
                ),
                popularity = NormalizedMetric(
                    value = popularityValue,
                    confidence = if (hasRatings) 0.72 else 0.32,
                    method = "hardcover-ratings-count",
                    sourceValue = book.ratingsCount?.takeIf { it != 0 }?.let { "$it ratings" },
                ),
                trending = NormalizedMetric(
                    value = max(0.18, min(0.74, popularityValue * 0.72)),
                    confidence = if (hasRatings) 0.42 else 0.18,
                    method = "hardcover-discovery",
                ),
            ),
            RecommendationProviderSignal(
                providerId = "hardcover-catalog",
                providerName = "Hardcover",
                kind = RecommendationProviderKind.SOURCE,
                remoteId = book.id.toString(),
                availability = NormalizedMetric(0.76, 0.62, "hardcover-catalog"),
                recency = if (book.releaseYear == null) NormalizedMetric(0.18, 0.16, "hardcover-catalog") else null,
            ),
        ),
    )
}

/** Desktop `mergeRecommendationTags` (BrowseV3 3994): trim, skip blanks, case-insensitive dedupe keeping first spelling. */
private fun mergeRecommendationTags(primary: List<String>, secondary: List<String>): List<String> =
    (primary + secondary)
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .distinctBy { it.lowercase() }

/**
 * Hardcover library book to a taste profile seed, mirroring the desktop
 * `hardcoverRecordToTasteProfileSeed`. Tags are the book's genres (filled from
 * the linked local work) plus the desktop base tags.
 */
fun hardcoverBookToTasteProfileSeed(book: HardcoverLibraryBook): TasteProfileSeedItem {
    val rating = book.userRating ?: book.rating
    return TasteProfileSeedItem(
        id = "hardcover:${book.bookId}",
        title = book.title,
        tags = (listOf("novel", "book") + book.tags).distinct(),
        contentType = RecommendationContentType.NOVEL,
        sourceId = "hardcover",
        userRating = rating,
        userRatingMax = 5.0,
        implicitWeight = if (rating != null && rating > 0.0) null else 0.45,
        status = hardcoverStatusToSeedStatus(book.statusId),
    )
}

private fun hardcoverStatusToSeedStatus(statusId: Int?): TasteSeedStatus = when (statusId) {
    Hardcover.READING -> TasteSeedStatus.READING
    Hardcover.COMPLETED -> TasteSeedStatus.COMPLETED
    Hardcover.DID_NOT_FINISH -> TasteSeedStatus.DROPPED
    Hardcover.WANT_TO_READ -> TasteSeedStatus.PLANNING
    else -> TasteSeedStatus.UNKNOWN
}

private val MANHWA_SOURCE_MARKERS = listOf("asura", "flame", "reaper", "void scans")
private val COMIC_AGGREGATOR_MARKERS = listOf("mangakakalot", "manganato", "mangadex", "mangalife")
private val MANHWA_MARKER_PATTERN = Regex("\\b(manhwa|korean|webtoons?)\\b")
private val MANHUA_MARKER_PATTERN = Regex("\\b(manhua|chinese)\\b")
private val MANHWA_GENRES = setOf("murim")
private val MANHUA_GENRES = setOf("cultivation", "wuxia", "xianxia", "xuanhuan")
// Tropes common in Korean web novels/comics, but also used by Japanese isekai.
// They only tip the balance as explicit genre tags and when several co-occur.
private val MANHWA_TROPE_GENRES = setOf(
    "regression", "necromancer", "dungeon", "system", "level up", "hunter", "hunters",
    "tower", "gate", "gates", "ranker", "player", "constellation",
)
private val SEED_STATUS_DROPPED_PATTERN = Regex("drop|unfinished|abandon")
private val SEED_STATUS_PLANNING_PATTERN = Regex("plan|wish|want")
private val SEED_STATUS_COMPLETED_PATTERN = Regex("complet|finished")
private val SEED_STATUS_READING_PATTERN = Regex("reading|watching|current|rereading|repeating")

/**
 * Desktop `inferMangaRecommendationContentType`: dedicated sources, then word-boundary
 * markers in the title and genre tags, then explicit genre sets. Synopsis text is ignored
 * on purpose: words like "system", "player" or "gate" appear in ordinary descriptions and
 * used to mislabel Japanese series as manhwa.
 */
fun inferComicContentType(
    title: String,
    description: String?,
    genres: List<String>,
    sourceName: String?,
    sourceLang: String?,
): RecommendationContentType {
    val source = sourceName.orEmpty().lowercase(Locale.ROOT)
    if (MANHWA_SOURCE_MARKERS.any { it in source }) return RecommendationContentType.MANHWA

    val normalizedGenres = genres.map { it.trim().lowercase(Locale.ROOT) }.filter { it.isNotEmpty() }
    val markerText = (listOf(title) + normalizedGenres).joinToString(" ").lowercase(Locale.ROOT)
    if (MANHWA_MARKER_PATTERN.containsMatchIn(markerText)) return RecommendationContentType.MANHWA
    if (MANHUA_MARKER_PATTERN.containsMatchIn(markerText)) return RecommendationContentType.MANHUA
    if (normalizedGenres.any { it in MANHWA_GENRES }) return RecommendationContentType.MANHWA
    if (normalizedGenres.any { it in MANHUA_GENRES }) return RecommendationContentType.MANHUA
    if (normalizedGenres.count { it in MANHWA_TROPE_GENRES } >= 2) return RecommendationContentType.MANHWA

    if (COMIC_AGGREGATOR_MARKERS.none { it in source }) {
        comicTypeFromLanguage(sourceLang)?.let { return it }
    }
    return RecommendationContentType.MANGA
}

private fun comicTypeFromLanguage(language: String?): RecommendationContentType? {
    val normalized = language?.trim()?.lowercase(Locale.ROOT)?.replace("_", "-").orEmpty()
    return when {
        normalized.isEmpty() -> null
        normalized == "kr" || normalized == "ko" || normalized.startsWith("ko-") || "korean" in normalized ->
            RecommendationContentType.MANHWA
        normalized == "cn" || normalized == "zh" || normalized.startsWith("zh-") || "chinese" in normalized ->
            RecommendationContentType.MANHUA
        normalized == "jp" || normalized == "ja" || normalized.startsWith("ja-") || "japanese" in normalized ->
            RecommendationContentType.MANGA
        else -> null
    }
}

private fun inferTrackerContentType(publishingType: String?, title: String): RecommendationContentType {
    val type = publishingType.orEmpty().lowercase(Locale.ROOT)
    val lowerTitle = title.lowercase(Locale.ROOT)
    return when {
        "manhwa" in type || "manhwa" in lowerTitle -> RecommendationContentType.MANHWA
        "manhua" in type || "manhua" in lowerTitle -> RecommendationContentType.MANHUA
        "novel" in type -> RecommendationContentType.NOVEL
        else -> RecommendationContentType.MANGA
    }
}

fun inferTrackerIconKey(name: String): String {
    val normalized = name.lowercase(Locale.ROOT)
    return when {
        "anilist" in normalized -> "anilist"
        "myanimelist" in normalized || normalized == "mal" -> "myanimelist"
        "kitsu" in normalized -> "kitsu"
        "bangumi" in normalized -> "bangumi"
        "mangaupdates" in normalized -> "mangaupdates"
        "hardcover" in normalized -> "hardcover"
        else -> "tracker"
    }
}

/**
 * Title keys of everything already in the library, so sections never re-suggest owned works. A novel
 * also counts under its known English title: "Ldm Lorde Dos Misterios" is Lord of the Mysteries.
 */
fun knownTitleKeys(seeds: List<TasteProfileSeedItem>): Set<String> =
    seeds.flatMap { seed ->
        val titles = if (seed.contentType.isProse) canonicalNovelTitleCandidates(seed.title) else listOf(seed.title)
        titles.map { recommendationTitleKey(it, seed.contentType) }
    }.filterNot { it.endsWith(":") }.toSet()

fun knownProviderKeys(entries: List<RecommendationEntryInput>): Set<String> =
    entries.flatMap { entry -> entry.tracks.mapNotNull { recommendationTrackerRemoteKey(it.trackerId.toString(), it.remoteId) } }
        .toSet()
