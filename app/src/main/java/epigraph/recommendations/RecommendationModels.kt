package epigraph.recommendations

/**
 * Kotlin port of the desktop recommendation engine (`src/lib/recommendations` in the desktop
 * workspace). The engine is pure: callers turn library entries into [TasteProfileSeedItem]s and
 * source/tracker results into [RecommendationCandidate]s, and [buildRecommendationSections]
 * ranks them into the same five Discover sections the desktop shows.
 */
enum class RecommendationProviderKind { LIBRARY, TRACKER, SOURCE }

enum class RecommendationContentType {
    MANGA,
    MANHWA,
    MANHUA,
    NOVEL,
    BOOK,
    ;

    val isComic: Boolean get() = this == MANGA || this == MANHWA || this == MANHUA
    val isProse: Boolean get() = this == NOVEL || this == BOOK
}

enum class RecommendationSafetyLevel { SAFE, SUGGESTIVE, ADULT, EXPLICIT }

data class NormalizedMetric(
    val value: Double,
    val confidence: Double,
    val method: String,
    val sourceValue: String? = null,
)

data class RecommendationProviderSignal(
    val providerId: String,
    val providerName: String,
    val kind: RecommendationProviderKind,
    val remoteId: String? = null,
    val iconKey: String? = null,
    val score: NormalizedMetric? = null,
    val popularity: NormalizedMetric? = null,
    val trending: NormalizedMetric? = null,
    val recency: NormalizedMetric? = null,
    val activity: NormalizedMetric? = null,
    val availability: NormalizedMetric? = null,
)

/** Cover image; [sourceId] lets the image loader apply the source's request headers. */
data class RecommendationCover(val url: String, val sourceId: Long? = null)

/** A concrete entry the user can open in-app (a source result). */
data class RecommendationTarget(val sourceId: Long, val url: String, val title: String)

data class RecommendationCandidate(
    val id: String,
    val title: String,
    val alternativeTitles: List<String> = emptyList(),
    val cover: RecommendationCover? = null,
    val tags: List<String> = emptyList(),
    val contentType: RecommendationContentType,
    val status: String? = null,
    val providers: List<RecommendationProviderSignal> = emptyList(),
    val inLibrary: Boolean = false,
    val safety: RecommendationSafetyLevel = RecommendationSafetyLevel.SAFE,
    val updatedAtMs: Long? = null,
    val publishedAtMs: Long? = null,
    val targets: List<RecommendationTarget> = emptyList(),
)

enum class TasteSeedStatus { READING, COMPLETED, DROPPED, PLANNING, UNKNOWN }

data class TasteProfileSeedItem(
    val id: String,
    val title: String,
    val tags: List<String>,
    val contentType: RecommendationContentType,
    val sourceId: String? = null,
    val userRating: Double? = null,
    val userRatingMax: Double? = null,
    val implicitWeight: Double? = null,
    val status: TasteSeedStatus? = null,
)

data class TasteProfile(
    val tagWeights: Map<String, Double>,
    val contentTypeWeights: Map<RecommendationContentType, Double>,
    val sourceWeights: Map<String, Double>,
    val topTags: List<String>,
    val positiveTags: List<String>,
    val negativeTags: List<String>,
    val seedCount: Int,
)

enum class RecommendationDiversityBucket { FAMILIAR, ADJACENT, DIVERGENT }

data class RecommendationScoreBreakdown(
    val personalRatingAffinity: Double,
    val profileTagOverlap: Double,
    val contentTypeFit: Double,
    val sourceAffinity: Double,
    val contentSimilarity: Double,
    val trackerConsensus: Double,
    val trendingVelocity: Double,
    val recency: Double,
    val sourceAvailability: Double,
    val novelty: Double,
    val finalScore: Double,
    val diversityBucket: RecommendationDiversityBucket,
)

data class TrackerScoreBadge(
    val consensus: Boolean,
    val providerIds: List<String>,
    val iconKeys: List<String>,
    val score: Double,
    val displayScore: String,
    val confidence: Double,
)

data class RecommendationItem(
    val candidate: RecommendationCandidate,
    val breakdown: RecommendationScoreBreakdown,
    val badge: TrackerScoreBadge?,
)

enum class RecommendationSectionKey {
    BECAUSE_YOU_RATED_HIGHLY,
    HIGH_CONFIDENCE,
    TRENDING_NEAR_YOUR_TASTE,
    FRESH_IN_YOUR_SOURCES,
    OUTSIDE_YOUR_USUAL_READS,
    ;

    /** Wire-style key shared with the desktop section identifiers (also used for jitter). */
    val key: String
        get() = when (this) {
            BECAUSE_YOU_RATED_HIGHLY -> "becauseYouRatedHighly"
            HIGH_CONFIDENCE -> "highConfidence"
            TRENDING_NEAR_YOUR_TASTE -> "trendingNearYourTaste"
            FRESH_IN_YOUR_SOURCES -> "freshInYourSources"
            OUTSIDE_YOUR_USUAL_READS -> "outsideYourUsualReads"
        }
}

data class RecommendationSection(
    val key: RecommendationSectionKey,
    val items: List<RecommendationItem>,
)

data class BuildRecommendationSectionsOptions(
    val includeInLibrary: Boolean = false,
    val knownTitleKeys: Set<String> = emptySet(),
    val knownProviderKeys: Set<String> = emptySet(),
    val includeNsfw: Boolean = false,
    val blockedTags: List<String> = emptyList(),
    val nowMs: Long = System.currentTimeMillis(),
    val limitPerSection: Int = DEFAULT_SECTION_LIMIT,
) {
    companion object {
        const val DEFAULT_SECTION_LIMIT = 18
    }
}
