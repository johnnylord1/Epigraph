package epigraph.recommendations

import java.util.Locale
import java.util.IdentityHashMap
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

private const val PROFILE_MATCH_MIN = 0.3
private const val HIGH_CONFIDENCE_PROFILE_MIN = 0.2
private const val TRENDING_PROFILE_MIN = 0.15
private const val OUTSIDE_PROFILE_OVERLAP_MAX = 0.16
private const val OUTSIDE_PERSONAL_AFFINITY_MAX = 0.2
// A tag the reader actively dislikes (dropped/low-rated works) keeps a title out
// of the "like what you read" rows even when other tags match.
private const val PROFILE_NEGATIVE_MAX = 0.35
private const val SECTION_NEGATIVE_MAX = 0.5
private const val NEGATIVE_WEIGHT_SCALE = 1.2
private const val MATCHED_TAG_MIN = 0.25
// Maximal Marginal Relevance (Carbonell & Goldstein): trade a little relevance
// for fewer near-identical titles next to each other inside a row.
private const val MMR_LAMBDA = 0.8
private const val MMR_POSITIONS = 36
private const val MMR_WINDOW = 72
// Every work appears in at most one row. Rows pick in turns so each keeps its
// strongest matches instead of the first row taking everything; this order
// also breaks ties when a work ranks equally well in two rows. Trending goes
// first because its criterion (momentum) is the narrowest.
private val SECTION_DRAFT_ORDER = listOf(
    RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE,
    RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY,
    RecommendationSectionKey.HIGH_CONFIDENCE,
    RecommendationSectionKey.FRESH_IN_YOUR_SOURCES,
    RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS,
)
private val SECTION_DISPLAY_ORDER = listOf(
    RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY,
    RecommendationSectionKey.HIGH_CONFIDENCE,
    RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE,
    RecommendationSectionKey.FRESH_IN_YOUR_SOURCES,
    RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS,
)

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
    val normalizedTags = candidate.tags.flatMap(::recommendationTagTokens).distinct()
    val topicalTags = normalizedTags.filterNot(::isRecommendationMetadataTag)
    val tagAffinity = tagTasteAffinity(topicalTags, profile)
    val personalRatingAffinity = tagAffinity.affinity

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
        negativeTagPenalty = tagAffinity.negativeTagPenalty,
        matchedTagCount = tagAffinity.matchedTagCount,
        finalScore = finalScore,
        diversityBucket = diversityBucket(profileTagOverlap, personalRatingAffinity),
    )
}

/**
 * How much of this title is made of things the reader likes. Each tag is
 * scored against the reader's strongest tag (square root so secondary tastes
 * still count), then averaged over the title's own tags. Unlike a share of the
 * whole profile, this does not collapse for readers with several distinct
 * tastes. The strongest disliked tag scales the result down.
 */
private fun tagTasteAffinity(
    topicalTags: List<String>,
    profile: TasteProfile,
): TagTasteAffinityResult {
    if (topicalTags.isEmpty()) return TagTasteAffinityResult(0.0, 0.0, 0)
    var strongestPositive = 0.0
    for (weight in profile.tagWeights.values) {
        if (weight > strongestPositive) strongestPositive = weight
    }
    val reference = max(0.35, strongestPositive)

    var positive = 0.0
    var negativeTagPenalty = 0.0
    var matchedTagCount = 0
    for (tag in topicalTags) {
        val weight = profile.tagWeights[tag] ?: 0.0
        if (weight > 0) {
            val match = min(1.0, sqrt(weight / reference))
            positive += match
            if (match >= MATCHED_TAG_MIN) matchedTagCount++
        } else if (weight < 0) {
            negativeTagPenalty = max(negativeTagPenalty, min(1.0, abs(weight) / NEGATIVE_WEIGHT_SCALE))
        }
    }
    // Long tag lists are common on some sources; damp them so unrelated extra
    // tags do not erase a strong match, while a single matching tag stays weak.
    val evidence = max(3.0, sqrt(3.0 * topicalTags.size))
    return TagTasteAffinityResult(
        affinity = clamp01((positive / evidence) * (1.0 - negativeTagPenalty)),
        negativeTagPenalty = negativeTagPenalty,
        matchedTagCount = matchedTagCount,
    )
}

private data class TagTasteAffinityResult(val affinity: Double, val negativeTagPenalty: Double, val matchedTagCount: Int)

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

    val ranked = mapOf(
        RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY to rankSectionItems(
            items, limit, RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY,
            score = { (it.breakdown.personalRatingAffinity * 0.7) + (it.breakdown.profileTagOverlap * 0.2) + (it.breakdown.sourceAffinity * 0.05) + (qualityScore(it) * 0.05) },
            eligible = {
                seeded && hasExternalProvider(it) && matchesDominantComicFormat(it, profile) &&
                    it.breakdown.matchedTagCount > 0 &&
                    it.breakdown.personalRatingAffinity >= PROFILE_MATCH_MIN &&
                    it.breakdown.negativeTagPenalty < PROFILE_NEGATIVE_MAX
            },
            profile,
        ),
        RecommendationSectionKey.HIGH_CONFIDENCE to rankSectionItems(
            items, limit, RecommendationSectionKey.HIGH_CONFIDENCE,
            score = { (qualityScore(it) * 0.42) + (it.breakdown.trackerConsensus * 0.2) + (providerEvidenceScore(it) * 0.18) + (profileAffinityScore(it) * 0.12) + (it.breakdown.sourceAvailability * 0.08) },
            eligible = {
                hasExternalProvider(it) &&
                    (qualityScore(it) >= 0.52 || proseWarmStartCandidate(it, profile)) &&
                    (seeded == false || (
                        fitsProfileComicFormat(it, profile) && (
                            (it.breakdown.personalRatingAffinity >= HIGH_CONFIDENCE_PROFILE_MIN && it.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX) ||
                                (!hasTopicalTags(it) && it.breakdown.trackerConsensus >= 0.82 && qualityScore(it) >= 0.72)
                        )
                    ))
            },
            profile,
        ),
        RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE to rankSectionItems(
            items, limit, RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE,
            score = { (momentumScore(it) * 0.52) + (it.breakdown.trendingVelocity * 0.18) + (it.breakdown.recency * 0.1) + (profileAffinityScore(it) * 0.1) + (qualityScore(it) * 0.06) + (it.breakdown.sourceAffinity * 0.04) },
            eligible = {
                hasExternalProvider(it) &&
                    (momentumScore(it) >= 0.08 || proseWarmStartCandidate(it, profile)) &&
                    (qualityScore(it) >= 0.42 || proseWarmStartCandidate(it, profile)) &&
                    (seeded == false || (fitsProfileComicFormat(it, profile) && it.breakdown.personalRatingAffinity >= TRENDING_PROFILE_MIN && it.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX))
            },
            profile,
        ),
        RecommendationSectionKey.FRESH_IN_YOUR_SOURCES to rankSectionItems(
            items, limit, RecommendationSectionKey.FRESH_IN_YOUR_SOURCES,
            score = { (freshnessScore(it) * 0.62) + (it.breakdown.personalRatingAffinity * 0.14) + (it.breakdown.sourceAvailability * 0.1) + (it.breakdown.sourceAffinity * 0.06) + (it.breakdown.contentTypeFit * 0.04) + (qualityScore(it) * 0.04) },
            eligible = {
                hasExternalProvider(it) &&
                    (freshnessScore(it) >= 0.12 || proseSourceAvailabilityCandidate(it, profile)) &&
                    (seeded == false || fitsProfileComicFormat(it, profile)) &&
                    it.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX
            },
            profile,
        ),
        RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS to rankSectionItems(
            items, limit, RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS,
            score = { (it.breakdown.novelty * 0.64) + (qualityScore(it) * 0.18) + (it.breakdown.sourceAvailability * 0.1) + (freshnessScore(it) * 0.08) },
            eligible = {
                seeded && hasExternalProvider(it) && outsideUsualEligibility(it, profile) &&
                    it.breakdown.diversityBucket == RecommendationDiversityBucket.DIVERGENT &&
                    it.breakdown.profileTagOverlap < OUTSIDE_PROFILE_OVERLAP_MAX &&
                    it.breakdown.personalRatingAffinity < OUTSIDE_PERSONAL_AFFINITY_MAX &&
                    // Divergent, not disliked: a tag from dropped or low-rated works only
                    // passes when the title is exceptionally well regarded.
                    it.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX &&
                    (it.breakdown.negativeTagPenalty == 0.0 || qualityScore(it) >= 0.7)
            },
            profile,
        ),
    )
    val drafted = draftUniqueSectionItems(ranked, limit)
    return SECTION_DISPLAY_ORDER.map { key ->
        val sectionItems = if (shouldApplyProfileComicMix(key)) {
            applyProfileComicMix(drafted.getValue(key), profile, limit).take(limit)
        } else {
            drafted.getValue(key)
        }
        RecommendationSection(key, sectionItems)
    }
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

/**
 * Reorders a ranked row so near-identical titles (same tag set) do not sit
 * next to each other. Relevance still dominates; only the first positions are
 * rearranged and the tail keeps its ranked order.
 */
fun rerankForDiversity(entries: List<Pair<RecommendationItem, Double>>): List<RecommendationItem> {
    if (entries.size <= 2) return entries.map { it.first }
    val remaining = entries.take(MMR_WINDOW).toMutableList()
    val tail = entries.drop(MMR_WINDOW)
    val tagSets = IdentityHashMap<RecommendationItem, Set<String>>()
    for (entry in remaining) tagSets[entry.first] = topicalTagSet(entry.first)
    val selected = ArrayList<Pair<RecommendationItem, Double>>()

    while (remaining.isNotEmpty() && selected.size < MMR_POSITIONS) {
        var bestIndex = 0
        var bestValue = Double.NEGATIVE_INFINITY
        for (index in remaining.indices) {
            val candidateTags = tagSets.getValue(remaining[index].first)
            var maxSimilarity = 0.0
            for (chosen in selected) {
                maxSimilarity = maxOf(maxSimilarity, jaccardSimilarity(candidateTags, tagSets.getValue(chosen.first)))
            }
            val value = MMR_LAMBDA * remaining[index].second - (1 - MMR_LAMBDA) * maxSimilarity
            if (value > bestValue) {
                bestValue = value
                bestIndex = index
            }
        }
        selected += remaining.removeAt(bestIndex)
    }

    return (selected + remaining + tail).map { it.first }
}

private fun shouldApplyProfileComicMix(sectionKey: RecommendationSectionKey): Boolean =
    sectionKey != RecommendationSectionKey.FRESH_IN_YOUR_SOURCES &&
        sectionKey != RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS

private fun topicalTagSet(item: RecommendationItem): Set<String> =
    item.candidate.tags
        .flatMap(::recommendationTagTokens)
        .filter { !isRecommendationMetadataTag(it) }
        .toSet()

private fun jaccardSimilarity(a: Set<String>, b: Set<String>): Double {
    if (a.isEmpty() || b.isEmpty()) return 0.0
    var overlap = 0
    for (tag in a) if (tag in b) overlap += 1
    return overlap.toDouble() / (a.size + b.size - overlap)
}

/**
 * Page-level uniqueness: every work (by any identity key, so aliases count)
 * lands in one row only. Rows take turns in SECTION_DRAFT_ORDER claiming their
 * best remaining work, but skip a work that another row ranks far higher, so a
 * title that leads "Fresh" is not taken by a row where it is only a filler.
 * A second pass lets rows with room pick works whose preferred row filled up.
 */
private fun draftUniqueSectionItems(
    ranked: Map<RecommendationSectionKey, List<RecommendationItem>>,
    limit: Int,
): Map<RecommendationSectionKey, List<RecommendationItem>> {
    val identityKeysByItem = IdentityHashMap<RecommendationItem, List<String>>()
    fun identityKeysOf(item: RecommendationItem): List<String> {
        identityKeysByItem[item]?.let { return it }
        val keys = item.candidate.identityKeys()
        identityKeysByItem[item] = keys
        return keys
    }

    // Best rank of each identity key in each row.
    val ranksByIdentity = HashMap<String, MutableMap<RecommendationSectionKey, Int>>()
    for (key in SECTION_DRAFT_ORDER) {
        ranked.getValue(key).forEachIndexed { rank, item ->
            for (identityKey in identityKeysOf(item)) {
                val ranks = ranksByIdentity.getOrPut(identityKey) { HashMap() }
                val current = ranks[key]
                if (current == null || rank < current) ranks[key] = rank
            }
        }
    }

    val picked = LinkedHashMap<RecommendationSectionKey, MutableList<RecommendationItem>>()
    for (key in SECTION_DRAFT_ORDER) picked[key] = mutableListOf()

    // Rows that rank a work similarly share it by taking turns; a row only
    // yields when another ranks the work at least twice as high.
    fun rankedFarHigherElsewhere(item: RecommendationItem, key: RecommendationSectionKey, rank: Int): Boolean =
        identityKeysOf(item).any { identityKey ->
            (ranksByIdentity[identityKey] ?: emptyMap()).any { (otherKey, otherRank) ->
                otherKey != key && picked.getValue(otherKey).size < limit && otherRank < rank / 2.0
            }
        }

    val claimed = LinkedHashSet<String>()

    fun runPass(respectPreference: Boolean) {
        val cursors = HashMap<RecommendationSectionKey, Int>()
        for (key in SECTION_DRAFT_ORDER) cursors[key] = 0
        var progressed = true
        while (progressed) {
            progressed = false
            for (key in SECTION_DRAFT_ORDER) {
                if (picked.getValue(key).size >= limit) continue
                val list = ranked.getValue(key)
                var cursor = cursors.getValue(key)
                while (cursor < list.size) {
                    val rank = cursor
                    val item = list[cursor]
                    cursor += 1
                    val identityKeys = identityKeysOf(item)
                    if (identityKeys.any { it in claimed }) continue
                    if (respectPreference && rankedFarHigherElsewhere(item, key, rank)) continue
                    claimed += identityKeys
                    picked.getValue(key).add(item)
                    progressed = true
                    break
                }
                cursors[key] = cursor
            }
        }
    }
    runPass(true)
    runPass(false)

    for (key in SECTION_DRAFT_ORDER) {
        val rankOf = IdentityHashMap<RecommendationItem, Int>()
        ranked.getValue(key).forEachIndexed { rank, item -> rankOf[item] = rank }
        picked.getValue(key).sortBy { rankOf[it] ?: 0 }
    }
    return picked
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

private fun rankSectionItems(
    items: List<RecommendationItem>,
    limit: Int,
    sectionKey: RecommendationSectionKey,
    score: (RecommendationItem) -> Double,
    eligible: (RecommendationItem) -> Boolean,
    profile: TasteProfile,
): List<RecommendationItem> {
    if (limit <= 0) return emptyList()
    val scored = items
        .map { it to score(it) }
        .filter { (item, value) -> value > 0 && eligible(item) }
        .sortedWith(
            compareByDescending<Pair<RecommendationItem, Double>> { it.second }
                .thenByDescending { stableSectionJitter(it.first, sectionKey) },
        )
    val uniqueItems = IdentityHashMap<RecommendationItem, Boolean>()
    dedupeRecommendationItems(scored.map { it.first }).forEach { uniqueItems[it] = true }
    val unique = scored.filter { (item, _) -> uniqueItems.containsKey(item) }
    // Fresh keeps pure recency order; every other row spreads similar titles apart.
    val ordered = if (sectionKey == RecommendationSectionKey.FRESH_IN_YOUR_SOURCES) {
        unique.map { it.first }
    } else {
        rerankForDiversity(unique)
    }
    return if (shouldApplyProfileComicMix(sectionKey)) applyProfileComicMix(ordered, profile, limit) else ordered
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

private fun profileTagOverlapRatioForTags(tags: List<String>, profile: TasteProfile): Double {
    val profileTags = profile.topTags.map(::normalizeToken).filter { it.isNotEmpty() }.toSet()
    val candidateTags = tags.map(::normalizeToken).filter { it.isNotEmpty() }.toSet()
    if (profileTags.isEmpty() || candidateTags.isEmpty()) return 0.0
    val overlap = candidateTags.count { it in profileTags }
    val union = (profileTags + candidateTags).size
    return if (union > 0) overlap.toDouble() / union else 0.0
}

private fun hasTopicalTags(item: RecommendationItem) = item.candidate.tags
    .flatMap(::recommendationTagTokens)
    .any { !isRecommendationMetadataTag(it) }

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
    val tokens = (
        (listOf(item.candidate.title) + item.candidate.alternativeTitles + item.candidate.tags + item.candidate.status.orEmpty())
            .map(::normalizeToken) +
        item.candidate.tags.flatMap(::recommendationTagTokens)
    ).filter { it.isNotEmpty() }
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
    return blocked.isEmpty() || candidate.tags.none { normalizeToken(it) in blocked || recommendationTagTokens(it).any { token -> token in blocked } }
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
