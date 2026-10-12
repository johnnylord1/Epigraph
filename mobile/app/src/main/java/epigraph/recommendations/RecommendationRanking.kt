package epigraph.recommendations

import java.util.Locale
import java.util.IdentityHashMap
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

private const val PROFILE_MATCH_MIN = 0.3
private const val HIGH_CONFIDENCE_PROFILE_MIN = 0.2
private const val TRENDING_PROFILE_MIN = 0.15
private const val OUTSIDE_PROFILE_OVERLAP_MAX = 0.16
// Every genre a large library touches keeps some weight, and a title shares at least one with
// almost any reader, so "outside" allows a weak match rather than demanding none.
private const val OUTSIDE_PERSONAL_AFFINITY_MAX = 0.35
// A weak overall match can still hide one of the reader's main genres (a title tagged only
// "Fantasy" for a fantasy reader). Tags weighing this share of the strongest one are core.
private const val OUTSIDE_CORE_TAG_SHARE = 0.72
// The genres the page shows as the reader's main ones are core too, however their weights compare.
private const val PRINCIPAL_TASTE_TAG_COUNT = 6
// A tag the reader actively dislikes (dropped/low-rated works) keeps a title out
// of the "like what you read" rows even when other tags match.
private const val PROFILE_NEGATIVE_MAX = 0.35
private const val SECTION_NEGATIVE_MAX = 0.5
private const val NEGATIVE_WEIGHT_SCALE = 1.2
private const val MATCHED_TAG_MIN = 0.25
// Only a library this dominated by one comic format keeps the other formats out of the taste rows;
// below it the rows follow the library's format mix.
private const val COMIC_FORMAT_EXCLUSIVE_SHARE = 0.75
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
// Sequels, side stories and one-shots may be recommended, but new series come first: they rank a
// little lower when a row picks its works, and sit after the new series in the row.
private const val SECONDARY_RELEASE_FACTOR = 0.9
// A row's order adds the work's fit to the reader's profile to the card's rating (0..1): closeness to
// the genres they rated well is worth up to PRIORITY_AFFINITY_BONUS, and how much of the work's format
// they read up to PRIORITY_FORMAT_BONUS. Global trackers rate Japanese titles higher, so without the
// format bonus a manhwa reader's rows would open with manga; with it, the format they read most leads
// while a much better rated work of another format still moves ahead.
private const val PRIORITY_AFFINITY_BONUS = 0.25
private const val PRIORITY_FORMAT_BONUS = 0.3
// "Episode 1" starts a series told in episodes (Umineko); a later episode or act continues it, as
// does a later "Dai N-wa" (Higurashi's Japanese episode numbering).
private val CONTINUATION_TITLE_PATTERN = Regex(
    "\\b(season\\s*\\d+|\\d+(st|nd|rd|th)\\s+season|part\\s*(\\d+|[ivx]+)\\b|(episode|act)\\s*(0*[2-9]|[1-9]\\d+|ii|iii|iv|v|vi|vii|viii|ix|x)\\b|dai\\s*0*([2-9]|[1-9]\\d+)\\s*-?\\s*(wa|shou|bu|kan)\\b|side\\s*stor(y|ies)|gaiden|spin[\\s-]?offs?|after\\s*stor(y|ies)|extra\\s*stor(y|ies))",
    RegexOption.IGNORE_CASE,
)
// "Series: Subtitle", "Series - Subtitle" or "Series (Subtitle)" continue a known series. Short names
// ("Re", "Gate") start too many unrelated titles to count.
private val SERIES_PREFIX_PATTERN = Regex("^(.+?)\\s*(?::|\\s[-–—]\\s|[(（\\[])")
private const val SERIES_PREFIX_MIN_LENGTH = 6
private val ONE_SHOT_TAGS = setOf("one shot", "oneshot")
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
        .map {
            RecommendationItem(
                candidate = it,
                breakdown = scoreRecommendationCandidate(it, profile, options.nowMs),
                badge = buildTrackerScoreBadge(it),
                releaseKind = recommendationReleaseKind(it, options.knownTitleKeys),
            )
        }
        .filterNot { isAffinityGroupMismatch(it, profile) }
    val seeded = profile.seedCount > 0
    val coreTags = profileCoreTags(profile)

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
                    qualityScore(it) >= 0.52 &&
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
                    momentumScore(it) >= 0.08 &&
                    qualityScore(it) >= 0.42 &&
                    (seeded == false || (fitsProfileComicFormat(it, profile) && it.breakdown.personalRatingAffinity >= TRENDING_PROFILE_MIN && it.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX))
            },
            profile,
        ),
        RecommendationSectionKey.FRESH_IN_YOUR_SOURCES to rankSectionItems(
            items, limit, RecommendationSectionKey.FRESH_IN_YOUR_SOURCES,
            score = { (freshnessScore(it) * 0.62) + (it.breakdown.personalRatingAffinity * 0.14) + (it.breakdown.sourceAvailability * 0.1) + (it.breakdown.sourceAffinity * 0.06) + (it.breakdown.contentTypeFit * 0.04) + (qualityScore(it) * 0.04) },
            eligible = {
                hasExternalProvider(it) &&
                    freshnessScore(it) >= 0.12 &&
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
                    it.breakdown.profileTagOverlap < OUTSIDE_PROFILE_OVERLAP_MAX &&
                    it.breakdown.personalRatingAffinity < OUTSIDE_PERSONAL_AFFINITY_MAX &&
                    !hasCoreTag(it, coreTags) &&
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
        val mixed = shouldApplyProfileComicMix(key, profile)
        // A row ends where the library's main format runs out rather than filling up with another.
        val sectionItems = if (mixed) {
            applyProfileComicMix(drafted.getValue(key), profile, limit, trim = true).take(limit)
        } else {
            drafted.getValue(key)
        }
        // "Fresh" is about what came out lately: how recent a work is takes the place of its rating.
        val ordered = if (key == RecommendationSectionKey.FRESH_IN_YOUR_SOURCES) {
            orderByProfilePriority(sectionItems) { freshnessScore(it) }
        } else {
            orderByProfilePriority(sectionItems, ::displayedRating)
        }
        RecommendationSection(key, ordered)
    }
}

/**
 * Whether a work is a new series or comes after one: a one-shot, or a sequel/spin-off by its title
 * ("Season 2", "Side Story") or by being named "<a series the reader knows>: <subtitle>".
 */
fun recommendationReleaseKind(
    candidate: RecommendationCandidate,
    knownTitleKeys: Set<String> = emptySet(),
): RecommendationReleaseKind {
    if (candidate.format.orEmpty().uppercase(Locale.ROOT) == "ONE_SHOT") return RecommendationReleaseKind.ONE_SHOT
    if (candidate.tags.any { normalizeToken(it) in ONE_SHOT_TAGS }) return RecommendationReleaseKind.ONE_SHOT
    val titles = listOf(candidate.title) + candidate.alternativeTitles
    if (titles.any { CONTINUATION_TITLE_PATTERN.containsMatchIn(it) }) return RecommendationReleaseKind.CONTINUATION
    if (knownTitleKeys.isNotEmpty() && titles.any { continuesKnownSeries(it, candidate, knownTitleKeys) }) {
        return RecommendationReleaseKind.CONTINUATION
    }
    return RecommendationReleaseKind.SERIES
}

private fun continuesKnownSeries(title: String, candidate: RecommendationCandidate, knownTitleKeys: Set<String>): Boolean {
    val prefix = SERIES_PREFIX_PATTERN.find(title)?.groupValues?.get(1) ?: return false
    if (normalizeToken(prefix).replace(" ", "").length < SERIES_PREFIX_MIN_LENGTH) return false
    return recommendationTitleKey(prefix, candidate.contentType) in knownTitleKeys
}

/**
 * The series a work belongs to, by its title before a subtitle ("Higurashi no Naku Koro ni - Dai 3-wa",
 * "Yakusoku no Neverland: Norman kara no Tegami"). Rows other than "fresh" list one work of a series,
 * so one series' episodes or side novels do not fill a row.
 */
private fun seriesClaimKey(item: RecommendationItem): String? {
    val title = item.candidate.title
    val prefix = SERIES_PREFIX_PATTERN.find(title)?.groupValues?.get(1)
    val series = if (prefix != null && normalizeToken(prefix).replace(" ", "").length >= SERIES_PREFIX_MIN_LENGTH) prefix else title
    val key = recommendationTitleKey(series, item.candidate.contentType)
    return if (key.isNotEmpty()) "series:$key" else null
}

private fun isSecondaryRelease(item: RecommendationItem) =
    item.releaseKind == RecommendationReleaseKind.CONTINUATION || item.releaseKind == RecommendationReleaseKind.ONE_SHOT

/** The rating shown on the card: the trackers' consensus, else the best-backed source score. */
private fun displayedRating(item: RecommendationItem): Double? {
    item.badge?.let { return it.score }
    return item.candidate.providers
        .filter { it.kind == RecommendationProviderKind.SOURCE && (it.score?.confidence ?: 0.0) > 0 }
        .maxByOrNull { it.score!!.confidence }
        ?.score?.value
}

/**
 * How close a work is to the reader: the genres of what they rated well, and how much of the work's
 * format the library holds (a manhwa reader's manhwa fits better than a manga of the same genres).
 */
private fun profileBonus(item: RecommendationItem): Double =
    (clamp01(item.breakdown.personalRatingAffinity) * PRIORITY_AFFINITY_BONUS) +
        (clamp01(item.breakdown.contentTypeFit) * PRIORITY_FORMAT_BONUS)

/**
 * A row reads by the reader's priority: new series before sequels and one-shots, then by the rating
 * on the card (or, for "Fresh", how recent the work is) raised by how close the work is to the
 * reader's profile, so the formats and genres they read most come first without forcing turns
 * between formats. Unrated works go last; equal priorities keep the row's relevance order.
 */
private fun orderByProfilePriority(
    items: List<RecommendationItem>,
    baseScore: (RecommendationItem) -> Double?,
): List<RecommendationItem> =
    items.withIndex()
        .map { (index, item) -> Triple(item, index, baseScore(item)?.let { it + profileBonus(item) }) }
        .sortedWith(
            compareBy<Triple<RecommendationItem, Int, Double?>> { if (isSecondaryRelease(it.first)) 1 else 0 }
                .thenByDescending { it.third ?: -1.0 }
                .thenBy { it.second },
        )
        .map { it.first }

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

// Every row follows the library's comic mix. "Outside" does too (other genres, not other formats),
// unless the library is almost all one format: then the other formats are what lies outside it.
private fun shouldApplyProfileComicMix(sectionKey: RecommendationSectionKey, profile: TasteProfile): Boolean {
    if (sectionKey != RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS) return true
    val dominant = dominantComicContentType(profile) ?: return true
    return dominant.second < COMIC_FORMAT_EXCLUSIVE_SHARE
}

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
                    val series = if (key == RecommendationSectionKey.FRESH_IN_YOUR_SOURCES) null else seriesClaimKey(item)
                    if (series != null && series in claimed) continue
                    if (respectPreference && rankedFarHigherElsewhere(item, key, rank)) continue
                    claimed += identityKeys
                    if (series != null) claimed += series
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
        .map { it to score(it) * (if (isSecondaryRelease(it)) SECONDARY_RELEASE_FACTOR else 1.0) }
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
    return if (shouldApplyProfileComicMix(sectionKey, profile)) applyProfileComicMix(ordered, profile, limit) else ordered
}

private fun hasExternalProvider(item: RecommendationItem) = item.candidate.providers.any {
    it.kind == RecommendationProviderKind.SOURCE || it.kind == RecommendationProviderKind.TRACKER
}

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
    if (dominant == RecommendationContentType.MANGA || share < COMIC_FORMAT_EXCLUSIVE_SHARE) return true
    return item.candidate.contentType == dominant
}

private fun fitsProfileComicFormat(item: RecommendationItem, profile: TasteProfile): Boolean {
    if (!item.candidate.contentType.isComic) return true
    val distribution = comicDistribution(profile)
    if (distribution.total <= 0) return true
    val (dominant, share) = dominantComicContentType(profile) ?: return true
    if (share < COMIC_FORMAT_EXCLUSIVE_SHARE || dominant == RecommendationContentType.MANGA) return true
    if (item.candidate.contentType == dominant) return true
    return (distribution.shares[item.candidate.contentType] ?: 0.0) >= 0.18 || item.breakdown.contentTypeFit >= 0.45
}

/**
 * Picks a row's works in the library's comic format proportions, so a manhwa-heavy library is not
 * handed a row of higher-rated manga. Each format keeps its own ranking order; the next pick goes to
 * the format furthest behind its share. The row's display order is set afterwards by the reader's
 * priority ([orderByProfilePriority]), not by these turns.
 *
 * When a format runs out, the formats the library reads less of stop at their share of it: a row
 * for a manhwa-heavy library ends when the manhwa does instead of going on with manga. A format the
 * library reads less of than the ones left may run out without holding them back. [trim] drops what
 * the proportions leave over; without it the rest follows in ranking order (a reorder, not a cut).
 */
private fun applyProfileComicMix(
    items: List<RecommendationItem>,
    profile: TasteProfile,
    limit: Int,
    trim: Boolean = false,
): List<RecommendationItem> {
    if (limit <= 0) return items
    val distribution = comicDistribution(profile)
    if (distribution.total <= 0) return items

    val buckets = COMIC_TYPES.associateWith { type -> ArrayDeque(items.filter { it.candidate.contentType == type }) }
    val order = IdentityHashMap<RecommendationItem, Int>()
    items.forEachIndexed { index, item -> order[item] = index }

    val result = ArrayList<RecommendationItem>()
    val used = HashSet<String>()
    val taken = COMIC_TYPES.associateWith { 0 }.toMutableMap()
    fun shareOf(type: RecommendationContentType) = distribution.shares[type] ?: 0.0
    fun exhausted(type: RecommendationContentType): Boolean {
        val bucket = buckets.getValue(type)
        while (bucket.isNotEmpty() && bucket.first().candidate.id in used) bucket.removeFirst()
        return bucket.isEmpty()
    }
    // A format may not outgrow its share of a larger format that has run out.
    fun withinShare(type: RecommendationContentType) = COMIC_TYPES.all { larger ->
        shareOf(larger) <= shareOf(type) || !exhausted(larger) ||
            taken.getValue(type) + 1 <= ceil(taken.getValue(larger) * shareOf(type) / shareOf(larger))
    }
    while (result.size < limit) {
        var next: RecommendationContentType? = null
        var nextDeficit = Double.NEGATIVE_INFINITY
        for (type in COMIC_TYPES) {
            val share = shareOf(type)
            if (exhausted(type) || share <= 0 || !withinShare(type)) continue
            val bucket = buckets.getValue(type)
            val deficit = (share * (result.size + 1)) - taken.getValue(type)
            val ahead = next != null && deficit == nextDeficit &&
                order.getValue(bucket.first()) < order.getValue(buckets.getValue(next).first())
            if (deficit > nextDeficit || ahead) {
                next = type
                nextDeficit = deficit
            }
        }
        if (next == null) break
        val item = buckets.getValue(next).removeFirst()
        used += item.candidate.id
        taken[next] = taken.getValue(next) + 1
        result += item
    }

    for (item in items) {
        if (item.candidate.id in used) continue
        if (trim && item.candidate.contentType.isComic) continue
        used += item.candidate.id
        result += item
    }
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

private fun profileCoreTags(profile: TasteProfile): Set<String> {
    val strongest = profile.tagWeights.values.fold(0.0, ::max)
    val core = profile.topTags.take(PRINCIPAL_TASTE_TAG_COUNT).toMutableSet()
    if (strongest <= 0) return core
    profile.tagWeights.forEach { (tag, weight) -> if (weight >= strongest * OUTSIDE_CORE_TAG_SHARE) core += tag }
    return core
}

private fun hasCoreTag(item: RecommendationItem, coreTags: Set<String>) =
    coreTags.isNotEmpty() && item.candidate.tags.flatMap(::recommendationTagTokens).any { it in coreTags }

private fun outsideUsualEligibility(item: RecommendationItem, profile: TasteProfile): Boolean {
    if (hasTopicalTags(item)) return true
    if (!item.candidate.contentType.isComic) return false
    val (dominant, share) = dominantComicContentType(profile) ?: return false
    if (share < COMIC_FORMAT_EXCLUSIVE_SHARE) return false
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

internal fun passesFilters(candidate: RecommendationCandidate, options: BuildRecommendationSectionsOptions): Boolean {
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
