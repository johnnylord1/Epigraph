package epigraph.recommendations

import java.util.Locale
import kotlin.math.max

/**
 * Pure adapters from app data to engine inputs, mirroring the desktop `adapters.ts`. The loader
 * flattens database/source/tracker objects into these inputs first so the mapping stays testable
 * without Android, a database, or network access.
 */
data class RecommendationTrackInput(
    val trackerId: Long,
    val trackerName: String,
    val remoteId: String,
    /** The tracker score on a 10-point scale; null or 0 when the entry is unscored. */
    val score10: Double?,
    val status: TasteSeedStatus? = null,
    val dateMs: Long? = null,
)

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
        inferComicContentType(title, description, genres, sourceName, sourceLang)
    }

fun entryToTasteProfileSeed(entry: RecommendationEntryInput): TasteProfileSeedItem {
    val bestTrack = entry.tracks
        .filter { (it.score10 ?: 0.0) > 0.0 }
        .maxByOrNull { it.score10 ?: 0.0 }
    val trackedStatus = entry.tracks.firstNotNullOfOrNull { it.status?.takeIf { s -> s != TasteSeedStatus.UNKNOWN } }
    return TasteProfileSeedItem(
        id = entry.recommendationId(),
        title = entry.title,
        tags = entry.genres,
        contentType = entry.contentType(),
        sourceId = entry.sourceId.toString(),
        userRating = bestTrack?.score10,
        userRatingMax = bestTrack?.let { 10.0 },
        implicitWeight = if (entry.inLibrary) entryImplicitWeight(entry) else 0.0,
        status = trackedStatus ?: seedStatusFromText(entry.publicationStatus),
    )
}

private fun entryImplicitWeight(entry: RecommendationEntryInput): Double = when {
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

private val DEDICATED_MANHWA_SOURCES = listOf("asura", "flame", "reaper", "void scans")
private val MANHWA_HINTS = listOf(
    "manhwa", "korean", "webtoon", "regression", "murim", "necromancer", "dungeon", "system",
    "level up", "hunter", "tower", "gate", "ranker", "player", "constellation",
)
private val MANHUA_HINTS = listOf("manhua", "chinese", "cultivation", "wuxia", "xianxia", "xuanhuan")
private val AGGREGATOR_SOURCES = listOf("mangakakalot", "manganato", "mangadex", "mangalife")

/** Desktop `inferMangaContentType`: dedicated sources, then title/genre hints, then language. */
fun inferComicContentType(
    title: String,
    description: String?,
    genres: List<String>,
    sourceName: String?,
    sourceLang: String?,
): RecommendationContentType {
    val source = sourceName.orEmpty().lowercase(Locale.ROOT)
    if (DEDICATED_MANHWA_SOURCES.any { it in source }) return RecommendationContentType.MANHWA

    val haystack = (listOf(title, description.orEmpty()) + genres).joinToString(" ").lowercase(Locale.ROOT)
    if (MANHWA_HINTS.any { it in haystack }) return RecommendationContentType.MANHWA
    if (MANHUA_HINTS.any { it in haystack }) return RecommendationContentType.MANHUA

    if (AGGREGATOR_SOURCES.none { it in source }) {
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

/** Title keys of everything already in the library, so sections never re-suggest owned works. */
fun knownTitleKeys(seeds: List<TasteProfileSeedItem>): Set<String> =
    seeds.map { recommendationTitleKey(it.title, it.contentType) }.filterNot { it.endsWith(":") }.toSet()

fun knownProviderKeys(entries: List<RecommendationEntryInput>): Set<String> =
    entries.flatMap { entry -> entry.tracks.mapNotNull { recommendationTrackerRemoteKey(it.trackerId.toString(), it.remoteId) } }
        .toSet()
