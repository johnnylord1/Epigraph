package epigraph.recommendations

import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val PROFILE_MATCH_MIN = 0.28
private const val HIGH_CONFIDENCE_PROFILE_MIN = 0.18
private const val TRENDING_PROFILE_MIN = 0.12
private const val OUTSIDE_PROFILE_OVERLAP_MAX = 0.16
private const val OUTSIDE_PERSONAL_AFFINITY_MAX = 0.22

private val COMIC_TYPES = listOf(
    RecommendationContentType.MANGA,
    RecommendationContentType.MANHWA,
    RecommendationContentType.MANHUA,
)

fun scoreRecommendationCandidate(
    candidate: RecommendationCandidate,
    profile: TasteProfile,
    nowMs: Long,
): RecommendationScoreBreakdown {
    val normalizedTags = candidate.tags.map(::normalizeToken).filter { it.isNotEmpty() }.distinct()
    val topicalTags = normalizedTags.filterNot(::isRecommendationMetadataTag)
    val tagWeights = normalizedTags.map { profile.tagWeights[it] ?: 0.0 }
    val positiveWeight = tagWeights.filter { it > 0 }.sum()
    val negativeWeight = abs(tagWeights.filter { it < 0 }.sum())
    val maxPositive = max(1.0, profile.tagWeights.values.filter { it > 0 }.sum())
    val personalRatingAffinity = clamp01((positiveWeight / maxPositive) - (negativeWeight / maxPositive))

    val profileTagOverlap = profileTagOverlapRatioForTags(topicalTags, profile)
    val contentTypeFit = clamp01(
        contentTypeWeightForCandidate(candidate.contentType, profile) /
            max(1.0, profile.contentTypeWeights.values.fold(0.0, ::max)),
    )
    val sourceAffinity = sourceAffinityScore(candidate, profile)
    val contentSimilarity = clamp01((profileTagOverlap * 0.66) + (contentTypeFit * 0.18) + (sourceAffinity * 0.16))

    val trackerConsensus = combineMetrics(
        candidate.providers.filter { it.kind == RecommendationProviderKind.TRACKER }.map { it.score },
    )?.value ?: 0.0
    val trendingVelocity = combineMetrics(candidate.providers.map { it.trending })?.value ?: 0.0
    val recency = combineMetrics(
        listOf(
            normalizeRecency(candidate.updatedAtMs, nowMs, 14.0, 0.7),
            normalizeRecency(candidate.publishedAtMs, nowMs, 45.0, 0.45),
        ) + candidate.providers.map { it.recency },
    )?.value ?: 0.0
    val sourceProviders = candidate.providers.filter { it.kind == RecommendationProviderKind.SOURCE }
    val sourceAvailability = combineMetrics(sourceProviders.map { it.availability })?.value
        ?: if (sourceProviders.isNotEmpty()) 0.55 else 0.0

    val novelty = noveltyScore(profileTagOverlap, personalRatingAffinity, contentTypeFit)
    val finalScore = clamp01(
        (personalRatingAffinity * 0.34) +
            (contentSimilarity * 0.16) +
            (trackerConsensus * 0.18) +
            (trendingVelocity * 0.1) +
            (recency * 0.08) +
            (sourceAvailability * 0.06) +
            (sourceAffinity * 0.04) +
            (novelty * 0.04),
    )

    return RecommendationScoreBreakdown(
        personalRatingAffinity = personalRatingAffinity,
        profileTagOverlap = profileTagOverlap,
        contentTypeFit = contentTypeFit,
        sourceAffinity = sourceAffinity,
        contentSimilarity = contentSimilarity,
        trackerConsensus = trackerConsensus,
        trendingVelocity = trendingVelocity,
        recency = recency,
        sourceAvailability = sourceAvailability,
        novelty = novelty,
        finalScore = finalScore,
        diversityBucket = diversityBucket(profileTagOverlap, personalRatingAffinity),
    )
}

fun buildRecommendationSections(
    candidates: List<RecommendationCandidate>,
    profile: TasteProfile,
    options: BuildRecommendationSectionsOptions = BuildRecommendationSectionsOptions(),
): List<RecommendationSection> {
    val limit = options.limitPerSection
    val items = candidates
        .filter { passesFilters(it, options) }
        .map { RecommendationItem(it, scoreRecommendationCandidate(it, profile, options.nowMs), buildTrackerScoreBadge(it)) }
        .filterNot { isAffinityGroupMismatch(it, profile) }
    val seeded = profile.seedCount > 0

    val becauseYouRatedHighly = buildSection(
        RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY, items, limit, profile,
        score = { (it.breakdown.personalRatingAffinity * 0.7) + (it.breakdown.profileTagOverlap * 0.26) + (it.breakdown.sourceAffinity * 0.04) },
        eligible = {
            seeded &&
                hasExternalProvider(it) &&
                matchesDominantComicFormat(it, profile) &&
                hasMeaningfulProfileSignal(it, profile) &&
                profileTasteSignalScore(it, profile) >= PROFILE_MATCH_MIN &&
                it.breakdown.diversityBucket != RecommendationDiversityBucket.DIVERGENT
        },
    )
    val highConfidence = buildSection(
        RecommendationSectionKey.HIGH_CONFIDENCE, rerankForDiversity(items), limit, profile,
        score = {
            (qualityScore(it) * 0.42) + (it.breakdown.trackerConsensus * 0.2) + (providerEvidenceScore(it) * 0.18) +
                (profileAffinityScore(it) * 0.12) + (it.breakdown.sourceAvailability * 0.08)
        },
        eligible = {
            hasExternalProvider(it) &&
                (qualityScore(it) >= 0.52 || proseWarmStartCandidate(it, profile)) &&
                (
                    !seeded || (
                        fitsProfileComicFormat(it, profile) && (
                            profileTasteSignalScore(it, profile) >= HIGH_CONFIDENCE_PROFILE_MIN ||
                                (!hasTopicalTags(it) && it.breakdown.trackerConsensus >= 0.82 && qualityScore(it) >= 0.72)
                            )
                        )
                    )
        },
    )
    val trendingNearYourTaste = buildSection(
        RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE, items, limit, profile,
        score = {
            (momentumScore(it) * 0.52) + (it.breakdown.trendingVelocity * 0.18) + (it.breakdown.recency * 0.1) +
                (profileAffinityScore(it) * 0.1) + (qualityScore(it) * 0.06) + (it.breakdown.sourceAffinity * 0.04)
        },
        eligible = {
            hasExternalProvider(it) &&
                (momentumScore(it) >= 0.08 || proseWarmStartCandidate(it, profile)) &&
                (qualityScore(it) >= 0.42 || proseWarmStartCandidate(it, profile)) &&
                (!seeded || fitsProfileComicFormat(it, profile)) &&
                (!seeded || profileTasteSignalScore(it, profile) >= TRENDING_PROFILE_MIN)
        },
    )
    val freshInYourSources = buildSection(
        RecommendationSectionKey.FRESH_IN_YOUR_SOURCES, items, limit, profile,
        score = {
            (freshnessScore(it) * 0.76) + (it.breakdown.sourceAvailability * 0.1) + (it.breakdown.sourceAffinity * 0.06) +
                (it.breakdown.contentTypeFit * 0.04) + (qualityScore(it) * 0.04)
        },
        eligible = {
            hasExternalProvider(it) &&
                (freshnessScore(it) >= 0.12 || proseSourceAvailabilityCandidate(it, profile)) &&
                (!seeded || fitsProfileComicFormat(it, profile))
        },
    )
    val outsideYourUsualReads = buildSection(
        RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS, items, limit, profile,
        score = {
            (it.breakdown.novelty * 0.64) + (qualityScore(it) * 0.18) + (it.breakdown.sourceAvailability * 0.1) +
                (freshnessScore(it) * 0.08)
        },
        eligible = {
            seeded &&
                hasExternalProvider(it) &&
                outsideUsualEligibility(it, profile) &&
                it.breakdown.diversityBucket == RecommendationDiversityBucket.DIVERGENT &&
                it.breakdown.profileTagOverlap < OUTSIDE_PROFILE_OVERLAP_MAX &&
                it.breakdown.personalRatingAffinity < OUTSIDE_PERSONAL_AFFINITY_MAX
        },
    )

    return listOf(becauseYouRatedHighly, highConfidence, trendingNearYourTaste, freshInYourSources, outsideYourUsualReads)
}

fun buildTrackerScoreBadge(candidate: RecommendationCandidate): TrackerScoreBadge? {
    val trackerSignals = candidate.providers.filter {
        it.kind == RecommendationProviderKind.TRACKER && (it.score?.confidence ?: 0.0) > 0
    }
    if (trackerSignals.isEmpty()) return null
    val consensus = combineMetrics(trackerSignals.map { it.score }) ?: return null
    return TrackerScoreBadge(
        consensus = trackerSignals.size > 1,
        providerIds = trackerSignals.map { it.providerId },
        iconKeys = trackerSignals.map { it.iconKey ?: it.providerId },
        score = consensus.value,
        displayScore = String.format(Locale.US, "%.1f", clamp01(consensus.value) * 10),
        confidence = consensus.confidence,
    )
}

/** Interleaves 7 familiar, 2 adjacent and 1 divergent pick to avoid a recommendation loop. */
fun rerankForDiversity(items: List<RecommendationItem>): List<RecommendationItem> {
    val sorted = items.sortedByDescending { it.breakdown.finalScore }
    val buckets = RecommendationDiversityBucket.entries.associateWith { bucket ->
        ArrayDeque(sorted.filter { it.breakdown.diversityBucket == bucket })
    }
    val pattern = List(7) { RecommendationDiversityBucket.FAMILIAR } +
        List(2) { RecommendationDiversityBucket.ADJACENT } +
        RecommendationDiversityBucket.DIVERGENT
    val result = ArrayList<RecommendationItem>(sorted.size)
    while (result.size < sorted.size) {
        val before = result.size
        for (bucket in pattern) buckets.getValue(bucket).removeFirstOrNull()?.let(result::add)
        if (result.size == before) break
    }
    return result
}

fun dedupeRecommendationItems(items: List<RecommendationItem>): List<RecommendationItem> {
    val seen = HashSet<String>()
    return items.filter { item ->
        val keys = item.candidate.identityKeys()
        if (keys.any { it in seen }) {
            false
        } else {
            seen += keys
            true
        }
    }
}

private fun buildSection(
    key: RecommendationSectionKey,
    items: List<RecommendationItem>,
    limit: Int,
    profile: TasteProfile,
    score: (RecommendationItem) -> Double,
    eligible: (RecommendationItem) -> Boolean,
): RecommendationSection {
    if (limit <= 0) return RecommendationSection(key, emptyList())
    val ranked = items
        .map { it to score(it) }
        .filter { (item, value) -> value > 0 && eligible(item) }
        .sortedWith(
            compareByDescending<Pair<RecommendationItem, Double>> { it.second }
                .thenByDescending { stableSectionJitter(it.first, key) },
        )
        .map { it.first }
    val unique = dedupeRecommendationItems(ranked)
    val applyMix = key != RecommendationSectionKey.FRESH_IN_YOUR_SOURCES &&
        key != RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS
    return RecommendationSection(key, (if (applyMix) applyProfileComicMix(unique, profile, limit) else unique).take(limit))
}

private fun hasExternalProvider(item: RecommendationItem) = item.candidate.providers.any {
    it.kind == RecommendationProviderKind.SOURCE || it.kind == RecommendationProviderKind.TRACKER
}

private fun proseWarmStartCandidate(item: RecommendationItem, profile: TasteProfile) =
    profile.seedCount == 0 &&
        item.candidate.contentType.isProse &&
        item.breakdown.sourceAvailability >= 0.45 &&
        (qualityScore(item) >= 0.35 || momentumScore(item) >= 0.08) &&
        item.candidate.title.isNotBlank()

private fun proseSourceAvailabilityCandidate(item: RecommendationItem, profile: TasteProfile) =
    item.candidate.contentType.isProse &&
        item.breakdown.sourceAvailability >= 0.45 &&
        item.candidate.title.isNotBlank() &&
        (profile.seedCount == 0 || item.breakdown.contentTypeFit >= 0.18)

private fun profileAffinityScore(item: RecommendationItem) = clamp01(
    (item.breakdown.personalRatingAffinity * 0.58) + (item.breakdown.profileTagOverlap * 0.24) +
        (item.breakdown.contentTypeFit * 0.1) + (item.breakdown.sourceAffinity * 0.08),
)

/**
 * Content type orders results but is not a personal taste signal: a source result with missing
 * genres must not qualify as a profile recommendation merely because it is a comic or a novel.
 */
private fun profileTasteSignalScore(item: RecommendationItem, profile: TasteProfile) = maxOf(
    item.breakdown.personalRatingAffinity,
    item.breakdown.profileTagOverlap,
    profileTagOverlapRatio(item, profile),
)

private fun hasMeaningfulProfileSignal(item: RecommendationItem, profile: TasteProfile) =
    profileTasteSignalScore(item, profile) > 0 &&
        (item.breakdown.profileTagOverlap > 0 || item.breakdown.personalRatingAffinity > 0)

private fun sourceAffinityScore(candidate: RecommendationCandidate, profile: TasteProfile): Double {
    val maxSourceWeight = profile.sourceWeights.values.filter { it > 0 }.fold(0.0, ::max)
    if (maxSourceWeight <= 0) return 0.0
    val strongest = candidate.providers.mapNotNull {
        when (it.kind) {
            RecommendationProviderKind.SOURCE -> it.providerId
            RecommendationProviderKind.TRACKER -> "tracker:${it.providerId}"
            RecommendationProviderKind.LIBRARY -> null
        }
    }.fold(0.0) { acc, key -> max(acc, profile.sourceWeights[key] ?: 0.0) }
    return clamp01(strongest / maxSourceWeight)
}

private fun contentTypeWeightForCandidate(contentType: RecommendationContentType, profile: TasteProfile): Double {
    val direct = profile.contentTypeWeights[contentType] ?: 0.0
    return when (contentType) {
        RecommendationContentType.NOVEL ->
            max(direct, (profile.contentTypeWeights[RecommendationContentType.BOOK] ?: 0.0) * 0.82)
        RecommendationContentType.BOOK ->
            max(direct, (profile.contentTypeWeights[RecommendationContentType.NOVEL] ?: 0.0) * 0.82)
        else -> direct
    }
}

private class ComicDistribution(val total: Double, val shares: Map<RecommendationContentType, Double>)

private fun comicDistribution(profile: TasteProfile): ComicDistribution {
    val weights = COMIC_TYPES.associateWith { max(0.0, profile.contentTypeWeights[it] ?: 0.0) }
    val total = weights.values.sum()
    return ComicDistribution(total, weights.mapValues { if (total > 0) it.value / total else 0.0 })
}

private fun dominantComicContentType(profile: TasteProfile): Pair<RecommendationContentType, Double>? {
    val distribution = comicDistribution(profile)
    if (distribution.total <= 0) return null
    // Stable descending sort keeps manga first on ties, as in the desktop.
    return distribution.shares.entries.sortedByDescending { it.value }.first().toPair()
}

private fun matchesDominantComicFormat(item: RecommendationItem, profile: TasteProfile): Boolean {
    if (!item.candidate.contentType.isComic) return true
    val (dominant, share) = dominantComicContentType(profile) ?: return true
    if (dominant == RecommendationContentType.MANGA || share < 0.48) return true
    return item.candidate.contentType == dominant
}

private fun fitsProfileComicFormat(item: RecommendationItem, profile: TasteProfile): Boolean {
    if (!item.candidate.contentType.isComic) return true
    val distribution = comicDistribution(profile)
    if (distribution.total <= 0) return true
    val (dominant, share) = dominantComicContentType(profile) ?: return true
    if (share < 0.48 || dominant == RecommendationContentType.MANGA) return true
    if (item.candidate.contentType == dominant) return true
    return (distribution.shares[item.candidate.contentType] ?: 0.0) >= 0.18 || item.breakdown.contentTypeFit >= 0.45
}

private fun applyProfileComicMix(items: List<RecommendationItem>, profile: TasteProfile, limit: Int): List<RecommendationItem> {
    if (limit <= 0) return items
    val distribution = comicDistribution(profile)
    val (dominant, dominantShare) = dominantComicContentType(profile) ?: return items
    if (distribution.total <= 0 || dominantShare < 0.48) return items

    val buckets = COMIC_TYPES.associateWith { type -> ArrayDeque(items.filter { it.candidate.contentType == type }) }
    if (buckets.getValue(dominant).isEmpty()) return items

    val targets = COMIC_TYPES.associateWith { type ->
        if (type == dominant) {
            ceil(limit * min(0.9, max(0.62, dominantShare))).toInt()
        } else {
            (limit * (distribution.shares[type] ?: 0.0)).roundToInt()
        }
    }

    val result = ArrayList<RecommendationItem>()
    val used = HashSet<String>()
    fun take(type: RecommendationContentType, count: Int) {
        var remaining = count
        val bucket = buckets.getValue(type)
        while (remaining > 0 && bucket.isNotEmpty() && result.size < limit) {
            val next = bucket.removeFirst()
            if (!used.add(next.candidate.id)) continue
            result += next
            remaining--
        }
    }

    take(dominant, targets.getValue(dominant))
    COMIC_TYPES.filter { it != dominant }.forEach { take(it, targets.getValue(it)) }
    items.forEach { if (used.add(it.candidate.id)) result += it }
    return result
}

private fun profileTagOverlapRatio(item: RecommendationItem, profile: TasteProfile) = profileTagOverlapRatioForTags(
    item.candidate.tags.map(::normalizeToken).filter { it.isNotEmpty() && !isRecommendationMetadataTag(it) },
    profile,
)

private fun profileTagOverlapRatioForTags(tags: List<String>, profile: TasteProfile): Double {
    val profileTags = profile.topTags.map(::normalizeToken).filter { it.isNotEmpty() }.toSet()
    val candidateTags = tags.map(::normalizeToken).filter { it.isNotEmpty() }.toSet()
    if (profileTags.isEmpty() || candidateTags.isEmpty()) return 0.0
    val overlap = candidateTags.count { it in profileTags }
    val union = (profileTags + candidateTags).size
    return if (union > 0) overlap.toDouble() / union else 0.0
}

private fun hasTopicalTags(item: RecommendationItem) = item.candidate.tags
    .map(::normalizeToken)
    .any { it.isNotEmpty() && !isRecommendationMetadataTag(it) }

private fun outsideUsualEligibility(item: RecommendationItem, profile: TasteProfile): Boolean {
    if (hasTopicalTags(item)) return true
    if (!item.candidate.contentType.isComic) return false
    val (dominant, share) = dominantComicContentType(profile) ?: return false
    if (share < 0.48) return false
    return item.candidate.contentType != dominant &&
        item.breakdown.contentTypeFit <= 0.35 &&
        item.breakdown.sourceAvailability >= 0.45
}

private fun qualityScore(item: RecommendationItem) =
    combineMetrics(item.candidate.providers.flatMap { listOf(it.score, it.popularity) })?.value ?: 0.0

private fun providerEvidenceScore(item: RecommendationItem): Double {
    val providers = item.candidate.providers.filter { it.kind != RecommendationProviderKind.LIBRARY }
    if (providers.isEmpty()) return 0.0
    val confidence = combineMetrics(
        providers.flatMap { listOf(it.score, it.popularity, it.trending, it.availability) },
    )?.confidence ?: 0.0
    val kindCoverage = providers.map { it.kind }.toSet().size / 2.0
    val providerCoverage = clamp01(providers.size / 3.0)
    return clamp01((confidence * 0.5) + (kindCoverage * 0.3) + (providerCoverage * 0.2))
}

private fun momentumScore(item: RecommendationItem) = combineMetrics(
    item.candidate.providers.flatMap { provider ->
        listOf(
            provider.trending,
            provider.recency,
            provider.activity,
            provider.popularity?.let { it.copy(confidence = it.confidence * 0.45, method = "${it.method}/momentum") },
        )
    },
)?.value ?: 0.0

private enum class AffinityGroup { BOYS_LOVE, MATURE_ROMANCE }

/** Niche groups are only recommended when the reader's own profile already includes them. */
private fun isAffinityGroupMismatch(item: RecommendationItem, profile: TasteProfile): Boolean {
    val tokens = (listOf(item.candidate.title) + item.candidate.alternativeTitles + item.candidate.tags + item.candidate.status.orEmpty())
        .map(::normalizeToken)
        .filter { it.isNotEmpty() }
    val groups = buildSet {
        if (tokens.any(::isBoysLoveTag)) add(AffinityGroup.BOYS_LOVE)
        if (hasMatureRomanceSignal(tokens)) add(AffinityGroup.MATURE_ROMANCE)
    }
    return groups.any { !profileHasAffinityGroup(profile, it) }
}

private fun profileHasAffinityGroup(profile: TasteProfile, group: AffinityGroup): Boolean {
    val tags = (profile.positiveTags + profile.topTags).toSet()
    val weighted = profile.tagWeights.filter { it.value > 0.15 }.keys
    return when (group) {
        AffinityGroup.BOYS_LOVE -> tags.any(::isBoysLoveTag) || weighted.any(::isBoysLoveTag)
        AffinityGroup.MATURE_ROMANCE -> hasMatureRomanceSignal(tags.toList()) || weighted.any { hasMatureRomanceSignal(listOf(it)) }
    }
}

private fun isBoysLoveTag(tag: String) =
    tag == "yaoi" || tag == "boys love" || tag == "boy love" || tag == "bl" || tag == "shounen ai" || tag == "shonen ai"

private val SPICY_WORD = Regex("\\bspicy\\b")

private fun hasMatureRomanceSignal(tokens: List<String>): Boolean {
    val hasRomance = tokens.any {
        it == "romance" || it == "love" || it == "romantic" ||
            "romance" in it || "roommate" in it || "relationship" in it
    }
    if (!hasRomance) return false
    return tokens.any {
        it == "spicy" || it == "smut" || it == "erotica" || it == "erotic" || it == "mature" || it == "adult" ||
            "spicy" in it || "smut" in it || "erotica" in it || "mature romance" in it
    } || SPICY_WORD.containsMatchIn(tokens.joinToString(" "))
}

private fun freshnessScore(item: RecommendationItem) = combineMetrics(
    listOf(
        if (item.breakdown.recency > 0) NormalizedMetric(item.breakdown.recency, 0.75, "candidate-recency") else null,
    ) + item.candidate.providers.map { it.recency },
)?.value ?: 0.0

private fun passesFilters(candidate: RecommendationCandidate, options: BuildRecommendationSectionsOptions): Boolean {
    if (!options.includeInLibrary && (candidate.inLibrary || isKnownCandidate(candidate, options))) return false
    if (!options.includeNsfw &&
        (candidate.safety == RecommendationSafetyLevel.ADULT || candidate.safety == RecommendationSafetyLevel.EXPLICIT)
    ) {
        return false
    }
    val blocked = options.blockedTags.map(::normalizeToken).filter { it.isNotEmpty() }.toSet()
    return blocked.isEmpty() || candidate.tags.none { normalizeToken(it) in blocked }
}

private fun isKnownCandidate(candidate: RecommendationCandidate, options: BuildRecommendationSectionsOptions): Boolean {
    if (options.knownTitleKeys.isNotEmpty() && candidate.titleKeys().any { it in options.knownTitleKeys }) return true
    if (options.knownProviderKeys.isEmpty()) return false
    if (candidate.id.startsWith("tracker:") && candidate.id.lowercase(Locale.ROOT) in options.knownProviderKeys) return true
    return candidate.providers.any { provider -> provider.remoteKey()?.let { it in options.knownProviderKeys } == true }
}

private fun noveltyScore(overlapRatio: Double, personalAffinity: Double, contentTypeFit: Double): Double {
    val distance = clamp01(((1 - overlapRatio) * 0.5) + ((1 - personalAffinity) * 0.35) + ((1 - contentTypeFit) * 0.15))
    return when {
        overlapRatio >= 0.38 || personalAffinity >= 0.58 -> clamp01(0.12 + (distance * 0.16))
        overlapRatio >= 0.16 || personalAffinity >= 0.22 -> clamp01(0.35 + (distance * 0.25))
        else -> clamp01(0.65 + (distance * 0.35))
    }
}

private fun diversityBucket(overlapRatio: Double, personalAffinity: Double) = when {
    overlapRatio >= 0.38 || personalAffinity >= 0.58 -> RecommendationDiversityBucket.FAMILIAR
    overlapRatio >= 0.16 || personalAffinity >= 0.22 -> RecommendationDiversityBucket.ADJACENT
    else -> RecommendationDiversityBucket.DIVERGENT
}

/** FNV-1a over the section key and candidate, identical to the desktop tie-breaker. */
internal fun stableSectionJitter(item: RecommendationItem, sectionKey: RecommendationSectionKey): Double {
    val input = "${sectionKey.key}:${item.candidate.id}:${item.candidate.title}"
    var hash = 2166136261L.toInt()
    for (ch in input) {
        hash = hash xor ch.code
        hash *= 16777619
    }
    return (hash.toLong() and 0xffffffffL).toDouble() / 0xffffffffL.toDouble()
}
