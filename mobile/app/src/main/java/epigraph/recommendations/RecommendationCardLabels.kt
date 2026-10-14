package epigraph.recommendations

import java.util.Locale

/**
 * What a Discover card shows, as the desktop Discover card does (BrowseV3 `recommendationProviderLabel`,
 * `recommendationStatusLabel` and `getRecommendationBannerInfo`).
 */

/** The flag on the cover: which tracker the score comes from, and the score out of 10. */
data class RecommendationCardBanner(val tracker: String, val score: String)

/** A work status the app has a string for. */
enum class RecommendationCardKnownStatus { ONGOING, COMPLETED, CANCELLED, HIATUS, UNKNOWN, IN_LIBRARY }

sealed interface RecommendationCardStatus {
    data class Text(val text: String) : RecommendationCardStatus
    data class Known(val status: RecommendationCardKnownStatus) : RecommendationCardStatus
}

/** Where the work came from: its first source, else its first provider. */
fun RecommendationCandidate.cardProviderLabel(): String {
    val provider = providers.firstOrNull { it.kind == RecommendationProviderKind.SOURCE } ?: providers.firstOrNull()
    return provider?.providerName ?: "Epigraph"
}

/** A novel's Hardcover score, then the work's status, then whether it is in the library. */
fun RecommendationCandidate.cardStatus(): RecommendationCardStatus {
    if (contentType.isProse) {
        hardcoverScore()?.takeIf { it.value > 0 }?.let {
            return RecommendationCardStatus.Text("HC ${formatHardcoverBadgeScore(it.value)}")
        }
    }
    if (!status.isNullOrEmpty()) return workStatus(status)
    return RecommendationCardStatus.Known(
        if (inLibrary) RecommendationCardKnownStatus.IN_LIBRARY else RecommendationCardKnownStatus.ONGOING,
    )
}

/** A novel shows Hardcover's score, then Kitsu's, then its surest source's; a comic its tracker badge. */
fun RecommendationCandidate.cardBanner(badge: TrackerScoreBadge?): RecommendationCardBanner? {
    if (contentType.isProse) {
        hardcoverScore()?.takeIf { it.value > 0 }?.let {
            return RecommendationCardBanner("hardcover", formatHardcoverBadgeScore(it.value))
        }
        providers.firstOrNull { it.providerId == "kitsu" && it.score.isConfident() }?.score
            ?.takeIf { it.value > 0 }
            ?.let { return RecommendationCardBanner("kitsu", formatSourceBadgeScore(it.value)) }
        return providers
            .filter { it.kind == RecommendationProviderKind.SOURCE && it.score.isConfident() }
            .maxByOrNull { it.score!!.confidence }
            ?.let { RecommendationCardBanner("source", formatSourceBadgeScore(it.score!!.value)) }
    }
    badge ?: return null
    val key = badge.iconKeys.firstOrNull()?.lowercase(Locale.ROOT).orEmpty()
    val tracker = when {
        "mal" in key || "myanimelist" in key -> "myanimelist"
        "ani" in key -> "anilist"
        "kitsu" in key -> "kitsu"
        "bangumi" in key -> "bangumi"
        "mangaupdates" in key -> "mangaupdates"
        "hardcover" in key -> "hardcover"
        else -> "tracker"
    }
    return RecommendationCardBanner(tracker, badge.displayScore)
}

private val STATUS_SEPARATORS = Regex("[_-]+")
private val STATUS_SPACES = Regex("\\s+")
private val WORD_START = Regex("\\b\\w")

/** Desktop `formatWorkStatus`: trackers' words for a status, else the status as given. */
internal fun workStatus(status: String?): RecommendationCardStatus {
    val normalized = status?.let { STATUS_SPACES.replace(STATUS_SEPARATORS.replace(it, " "), " ").trim() }
    if (normalized.isNullOrEmpty()) return RecommendationCardStatus.Known(RecommendationCardKnownStatus.UNKNOWN)
    val known = when (STATUS_SPACES.replace(normalized.lowercase(Locale.ROOT), "_")) {
        // AniList says RELEASING and FINISHED, Kitsu says current.
        "ongoing", "releasing", "publishing", "current" -> RecommendationCardKnownStatus.ONGOING
        "completed", "finished", "publishing_finished" -> RecommendationCardKnownStatus.COMPLETED
        "cancelled" -> RecommendationCardKnownStatus.CANCELLED
        "hiatus", "on_hiatus" -> RecommendationCardKnownStatus.HIATUS
        "unknown" -> RecommendationCardKnownStatus.UNKNOWN
        else -> null
    }
    if (known != null) return RecommendationCardStatus.Known(known)
    return RecommendationCardStatus.Text(
        WORD_START.replace(normalized.lowercase(Locale.ROOT)) { it.value.uppercase(Locale.ROOT) },
    )
}

private fun RecommendationCandidate.hardcoverScore(): NormalizedMetric? =
    providers.firstOrNull { it.providerId == "hardcover" && it.score.isConfident() }?.score

private fun NormalizedMetric?.isConfident(): Boolean = this != null && confidence > 0

/** Hardcover rates out of 5, other trackers and sources out of 10. */
internal fun formatHardcoverBadgeScore(value: Double): String = oneDecimal(Math.round(value * 50) / 10.0)

internal fun formatSourceBadgeScore(value: Double): String = oneDecimal(Math.round(value * 100) / 10.0)

private fun oneDecimal(value: Double): String = String.format(Locale.ROOT, "%.1f", value)
