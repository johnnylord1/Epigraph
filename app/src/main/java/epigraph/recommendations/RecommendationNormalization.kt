package epigraph.recommendations

import java.text.Normalizer
import java.util.Locale
import kotlin.math.ln1p
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

internal const val DAY_MS = 86_400_000.0

fun clamp01(value: Double): Double {
    if (!value.isFinite()) return 0.0
    return max(0.0, min(1.0, value))
}

fun normalizedMetric(value: Double, confidence: Double, method: String, sourceValue: String? = null) =
    NormalizedMetric(clamp01(value), clamp01(confidence), method, sourceValue)

fun normalizeScore(score: Double?, scaleMax: Double = 10.0, confidence: Double = 1.0): NormalizedMetric? {
    if (score == null || !score.isFinite() || scaleMax <= 0) return null
    return normalizedMetric(score / scaleMax, confidence, "score/${formatPlain(scaleMax)}", formatPlain(score))
}

fun normalizeRank(rank: Int?, total: Int?, confidence: Double = 0.8): NormalizedMetric? {
    if (rank == null || total == null || rank <= 0 || total <= 1) return null
    return normalizedMetric(1 - ((rank - 1).toDouble() / (total - 1)), confidence, "inverse-rank", "#$rank")
}

fun normalizeLogCount(count: Double?, benchmarkCount: Double, confidence: Double = 0.65): NormalizedMetric? {
    if (count == null || !count.isFinite() || count < 0 || !benchmarkCount.isFinite() || benchmarkCount <= 0) {
        return null
    }
    return normalizedMetric(ln1p(count) / ln1p(benchmarkCount), confidence, "log-count", formatPlain(count))
}

fun normalizeRecency(
    dateMs: Long?,
    nowMs: Long,
    halfLifeDays: Double = 14.0,
    confidence: Double = 0.7,
): NormalizedMetric? {
    if (dateMs == null || halfLifeDays <= 0) return null
    val ageDays = max(0.0, (nowMs - dateMs) / DAY_MS)
    return normalizedMetric(0.5.pow(ageDays / halfLifeDays), confidence, "recency-decay", "${Math.round(ageDays)}d")
}

/** Confidence-weighted mean of the valid metrics; confidence is the mean confidence. */
fun combineMetrics(metrics: List<NormalizedMetric?>): NormalizedMetric? {
    val valid = metrics.filterNotNull().filter { it.confidence > 0 }
    if (valid.isEmpty()) return null
    val confidenceSum = valid.sumOf { it.confidence }
    val value = valid.sumOf { it.value * it.confidence } / confidenceSum
    return normalizedMetric(value, confidenceSum / valid.size, "weighted-consensus")
}

private val COMBINING_MARKS = Regex("[\\u0300-\\u036f]")
private val NON_ALPHANUMERIC = Regex("[^a-z0-9]+")
private val WHITESPACE = Regex("\\s+")

fun normalizeToken(value: String): String =
    Normalizer.normalize(value.trim().lowercase(Locale.ROOT), Normalizer.Form.NFKD)
        .replace(COMBINING_MARKS, "")
        .replace("&", " and ")
        .replace(NON_ALPHANUMERIC, " ")
        .replace(WHITESPACE, " ")
        .trim()

private fun formatPlain(value: Double): String =
    if (value == Math.floor(value) && value.isFinite()) value.toLong().toString() else value.toString()

private val STRUCTURAL_METADATA_TAGS = setOf(
    "manga", "manhwa", "manhua", "comic", "comics", "novel", "book", "webnovel", "epub", "pdf",
    "hardcover", "ongoing", "completed", "complete", "finished", "releasing", "hiatus", "unknown",
)

private val LANGUAGE_METADATA_TAGS = setOf(
    "af", "afrikaans", "am", "amhara", "amharic", "ar", "arabic", "az", "azerbaijani", "be",
    "belarusian", "bg", "bulgarian", "bn", "bengali", "br", "brazilian", "ca", "catalan", "cn",
    "chinese", "cs", "czech", "da", "danish", "de", "deutsch", "german", "el", "greek", "en",
    "english", "eo", "esperanto", "es", "espanol", "spanish", "et", "estonian", "fa", "persian",
    "fi", "finnish", "fil", "filipino", "fr", "francais", "french", "he", "hebrew", "hi", "hindi",
    "hr", "croatian", "hu", "hungarian", "id", "indonesian", "it", "italian", "ja", "japanese",
    "jp", "ka", "georgian", "kk", "kazakh", "km", "khmer", "ko", "korean", "kr", "la", "latin",
    "lo", "lao", "lt", "lithuanian", "lv", "latvian", "ms", "malay", "my", "burmese", "ne",
    "nepali", "nl", "dutch", "no", "norwegian", "pl", "polish", "pt", "portugues", "portuguese",
    "ro", "romanian", "ru", "russian", "si", "sinhala", "sk", "slovak", "sl", "slovenian", "sq",
    "albanian", "sr", "serbian", "sv", "swedish", "sw", "swahili", "ta", "tamil", "te", "telugu",
    "th", "thai", "tl", "tr", "turkish", "tw", "uk", "ukrainian", "ur", "urdu", "uz", "uzbek",
    "vi", "vietnamese", "zh",
)

private val REGION_CODE = Regex("^[a-z]{2,3}$")

/** Format, status, and language tags describe the entry rather than the reader's taste. */
fun isRecommendationMetadataTag(tag: String): Boolean {
    if (tag in STRUCTURAL_METADATA_TAGS || tag in LANGUAGE_METADATA_TAGS) return true
    val parts = tag.split(" ").filter { it.isNotEmpty() }
    if (parts.size < 2 || parts.size > 3) return false
    return parts[0] in LANGUAGE_METADATA_TAGS &&
        REGION_CODE.matches(parts[1]) &&
        (parts.size == 2 || REGION_CODE.matches(parts[2]))
}

fun RecommendationContentType.family(): String = if (isProse) "prose" else "comic"

fun recommendationTitleKey(title: String, contentType: RecommendationContentType): String =
    "${contentType.family()}:${normalizeToken(title)}"

fun RecommendationCandidate.titleKeys(): List<String> =
    (listOf(title) + alternativeTitles)
        .map { recommendationTitleKey(it, contentType) }
        .filterNot { it.endsWith(":") }
        .distinct()

fun recommendationTrackerRemoteKey(providerId: String?, remoteId: String?): String? {
    val provider = providerId.orEmpty().trim()
    val remote = remoteId.orEmpty().trim()
    if (provider.isEmpty() || remote.isEmpty()) return null
    return "tracker:$provider:$remote".lowercase(Locale.ROOT)
}

fun RecommendationProviderSignal.remoteKey(): String? =
    if (kind != RecommendationProviderKind.TRACKER) null else recommendationTrackerRemoteKey(providerId, remoteId)

fun RecommendationCandidate.identityKeys(): List<String> {
    val providerKeys = providers.mapNotNull { it.remoteKey() }
    val candidateId = id.trim().lowercase(Locale.ROOT)
    val idKey = if (candidateId.isNotEmpty()) listOf("candidate:$candidateId") else emptyList()
    return (titleKeys() + providerKeys + idKey).distinct()
}
