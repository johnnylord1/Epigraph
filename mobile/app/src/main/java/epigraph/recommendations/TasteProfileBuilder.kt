package epigraph.recommendations

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

private const val DEFAULT_IMPLICIT_WEIGHT = 0.35

fun buildTasteProfile(items: List<TasteProfileSeedItem>): TasteProfile {
    val tagWeights = LinkedHashMap<String, Double>()
    val contentTypeWeights = LinkedHashMap<RecommendationContentType, Double>()
    val sourceWeights = LinkedHashMap<String, Double>()

    for (item in items) {
        val preference = preferenceWeight(item)
        if (preference == 0.0) continue

        contentTypeWeights.addWeight(item.contentType, preference)
        item.sourceId?.takeIf { it.isNotEmpty() }?.let { sourceWeights.addWeight(it, preference) }

        // "Battle / Action" and "Action" on one title are the same taste once.
        val tokens = LinkedHashSet(item.tags.flatMap(::recommendationTagTokens))
        for (token in tokens) {
            if (isRecommendationMetadataTag(token)) continue
            tagWeights.addWeight(token, preference)
        }
    }

    val sortedTags = tagWeights.entries.sortedByDescending { it.value }
    return TasteProfile(
        tagWeights = tagWeights,
        contentTypeWeights = contentTypeWeights,
        sourceWeights = sourceWeights,
        topTags = sortedTags.filter { it.value > 0 }.take(10).map { it.key },
        positiveTags = sortedTags.filter { it.value > 0.15 }.map { it.key },
        negativeTags = sortedTags.filter { it.value < -0.15 }.map { it.key },
        seedCount = items.size,
    )
}

fun preferenceWeight(item: TasteProfileSeedItem): Double {
    val ratingWeight = ratingPreferenceWeight(item.userRating, item.userRatingMax)
    val statusMultiplier = statusPreferenceMultiplier(item.status)
    val implicit = item.implicitWeight?.let { max(-1.0, min(1.0, it)) } ?: DEFAULT_IMPLICIT_WEIGHT

    if (item.status == TasteSeedStatus.DROPPED) {
        // A dropped item without an explicit rating is negative evidence. Never multiply a
        // negative rating by another negative value: that turned low-rated drops positive.
        val droppedBase = ratingWeight ?: -max(0.45, abs(implicit))
        return clampSigned(droppedBase * statusMultiplier, -1.4, 1.4)
    }
    return clampSigned((ratingWeight ?: implicit) * statusMultiplier, -1.4, 1.4)
}

fun ratingPreferenceWeight(rating: Double?, ratingMax: Double? = 10.0): Double? {
    val normalized = normalizeScore(rating, ratingMax ?: 10.0)?.value ?: return null
    return when {
        normalized >= 0.95 -> 1.4
        normalized >= 0.9 -> 1.25
        normalized >= 0.8 -> 1.0
        normalized >= 0.7 -> 0.6
        normalized >= 0.6 -> 0.2
        normalized >= 0.5 -> -0.2
        else -> -0.65
    }
}

private fun statusPreferenceMultiplier(status: TasteSeedStatus?): Double = when (status) {
    TasteSeedStatus.COMPLETED -> 1.1
    TasteSeedStatus.PLANNING -> 0.45
    TasteSeedStatus.DROPPED -> 0.85
    else -> 1.0
}

private fun <K> MutableMap<K, Double>.addWeight(key: K, weight: Double) {
    this[key] = (this[key] ?: 0.0) + weight
}

private fun clampSigned(value: Double, min: Double, max: Double): Double {
    if (!value.isFinite()) return 0.0
    return max(min, min(max, value))
}

/**
 * Merges candidates that share a title key or tracker remote key, so a source result and the
 * matching tracker catalog entry become one card carrying both the source availability and the
 * tracker genres/scores.
 */
fun mergeRecommendationCandidates(candidates: List<RecommendationCandidate>): List<RecommendationCandidate> {
    class Record(var candidate: RecommendationCandidate, var active: Boolean = true)

    val records = mutableListOf<Record>()
    val identityToRecord = HashMap<String, Int>()

    for (incoming in candidates) {
        val matching = incoming.identityKeys()
            .mapNotNull { identityToRecord[it] }
            .filter { records[it].active }
            .toSortedSet()

        if (matching.isEmpty()) {
            val index = records.size
            records += Record(incoming)
            incoming.identityKeys().forEach { identityToRecord[it] = index }
            continue
        }

        val targetIndex = matching.first()
        var merged = records[targetIndex].candidate
        for (index in matching) {
            if (index == targetIndex) continue
            merged = mergeCandidateValues(merged, records[index].candidate)
            records[index].active = false
        }
        merged = mergeCandidateValues(merged, incoming)

        identityToRecord.entries.removeAll { it.value in matching }
        records[targetIndex].candidate = merged
        merged.identityKeys().forEach { identityToRecord[it] = targetIndex }
    }

    return records.filter { it.active }.map { it.candidate }
}

private fun mergeCandidateValues(existing: RecommendationCandidate, candidate: RecommendationCandidate) =
    existing.copy(
        providers = mergeProviders(existing.providers, candidate.providers),
        tags = (existing.tags + candidate.tags).distinct(),
        inLibrary = existing.inLibrary || candidate.inLibrary,
        cover = existing.cover?.takeIf { it.url.isNotBlank() } ?: candidate.cover?.takeIf { it.url.isNotBlank() }
            ?: existing.cover ?: candidate.cover,
        alternativeTitles = (existing.alternativeTitles + candidate.alternativeTitles + existing.title + candidate.title)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
            .filter { it != existing.title },
        contentType = chooseContentType(existing.contentType, candidate.contentType),
        status = existing.status?.takeIf { it.isNotEmpty() } ?: candidate.status,
        updatedAtMs = max(existing.updatedAtMs ?: 0, candidate.updatedAtMs ?: 0).takeIf { it != 0L }
            ?: existing.updatedAtMs,
        publishedAtMs = existing.publishedAtMs ?: candidate.publishedAtMs,
        targets = (existing.targets + candidate.targets).distinctBy { it.sourceId to it.url },
    )

private fun chooseContentType(
    existing: RecommendationContentType,
    incoming: RecommendationContentType,
): RecommendationContentType {
    if (existing == incoming) return existing
    if (existing.isComic && incoming.isComic) {
        // Tracker/country data is more specific than the generic "manga" fallback.
        return if (existing == RecommendationContentType.MANGA) incoming else existing
    }
    if (existing == RecommendationContentType.BOOK && incoming == RecommendationContentType.NOVEL) return incoming
    return existing
}

private fun mergeProviders(
    current: List<RecommendationProviderSignal>,
    incoming: List<RecommendationProviderSignal>,
): List<RecommendationProviderSignal> {
    fun key(p: RecommendationProviderSignal) =
        "${p.kind}:${p.providerId}:${if (p.kind == RecommendationProviderKind.TRACKER) p.remoteId.orEmpty() else ""}"

    val byId = LinkedHashMap<String, RecommendationProviderSignal>()
    current.forEach { byId[key(it)] = it }
    for (provider in incoming) {
        val k = key(provider)
        byId[k] = byId[k]?.let { mergeProviderSignal(it, provider) } ?: provider
    }
    return byId.values.toList()
}

private fun mergeProviderSignal(existing: RecommendationProviderSignal, incoming: RecommendationProviderSignal) =
    incoming.copy(
        remoteId = existing.remoteId ?: incoming.remoteId,
        iconKey = existing.iconKey ?: incoming.iconKey,
        score = strongestMetric(existing.score, incoming.score),
        popularity = strongestMetric(existing.popularity, incoming.popularity),
        trending = strongestMetric(existing.trending, incoming.trending),
        recency = strongestMetric(existing.recency, incoming.recency),
        availability = strongestMetric(existing.availability, incoming.availability),
        activity = strongestMetric(existing.activity, incoming.activity),
    )

private fun strongestMetric(current: NormalizedMetric?, incoming: NormalizedMetric?): NormalizedMetric? {
    if (current == null) return incoming
    if (incoming == null) return current
    return if (incoming.value * incoming.confidence > current.value * current.confidence) incoming else current
}

/** Tag-based safety inference shared by every adapter. */
fun inferRecommendationSafety(tags: List<String>): RecommendationSafetyLevel {
    val normalized = tags.map { it.lowercase() }
    return when {
        normalized.any { "hentai" in it || "porn" in it } -> RecommendationSafetyLevel.EXPLICIT
        normalized.any { "adult" in it || "mature" in it } -> RecommendationSafetyLevel.ADULT
        normalized.any { "suggestive" in it || "ecchi" in it } -> RecommendationSafetyLevel.SUGGESTIVE
        else -> RecommendationSafetyLevel.SAFE
    }
}

/** Library/tracker status strings to seed status, matching the desktop heuristic. */
fun seedStatusFromText(status: String?): TasteSeedStatus {
    val normalized = status?.lowercase().orEmpty()
    return when {
        "complete" in normalized || "finished" in normalized -> TasteSeedStatus.COMPLETED
        "drop" in normalized -> TasteSeedStatus.DROPPED
        "plan" in normalized -> TasteSeedStatus.PLANNING
        "read" in normalized || "ongoing" in normalized -> TasteSeedStatus.READING
        else -> TasteSeedStatus.UNKNOWN
    }
}
