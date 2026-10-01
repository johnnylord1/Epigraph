import { clamp01, combineMetrics, normalizeRecency, normalizeToken } from "./normalization";
import {
  recommendationCandidateIdentityKeys,
  recommendationCandidateTitleKeys,
  recommendationProviderRemoteKey,
} from "./identity";
import { isRecommendationMetadataTag, recommendationTagTokens } from "./metadata";
import type {
  BuildRecommendationSectionsOptions,
  RecommendationCandidate,
  RecommendationDiversityBucket,
  RecommendationItem,
  RecommendationScoreBreakdown,
  RecommendationSection,
  RecommendationSectionKey,
  TasteProfile,
  TrackerScoreBadge,
} from "./types";

const DEFAULT_LIMIT = 18;
const PROFILE_MATCH_MIN = 0.3;
const HIGH_CONFIDENCE_PROFILE_MIN = 0.2;
const TRENDING_PROFILE_MIN = 0.15;
const OUTSIDE_PROFILE_OVERLAP_MAX = 0.16;
const OUTSIDE_PERSONAL_AFFINITY_MAX = 0.2;
// A tag the reader actively dislikes (dropped/low-rated works) keeps a title out
// of the "like what you read" rows even when other tags match.
const PROFILE_NEGATIVE_MAX = 0.35;
const SECTION_NEGATIVE_MAX = 0.5;
const NEGATIVE_WEIGHT_SCALE = 1.2;
const MATCHED_TAG_MIN = 0.25;
// Maximal Marginal Relevance (Carbonell & Goldstein): trade a little relevance
// for fewer near-identical titles next to each other inside a row.
const MMR_LAMBDA = 0.8;
const MMR_POSITIONS = 36;
const MMR_WINDOW = 72;
// Every work appears in at most one row. Rows pick in turns so each keeps its
// strongest matches instead of the first row taking everything; this order
// also breaks ties when a work ranks equally well in two rows. Trending goes
// first because its criterion (momentum) is the narrowest.
const SECTION_DRAFT_ORDER: RecommendationSectionKey[] = [
  "trendingNearYourTaste",
  "becauseYouRatedHighly",
  "highConfidence",
  "freshInYourSources",
  "outsideYourUsualReads",
];
const SECTION_DISPLAY_ORDER: RecommendationSectionKey[] = [
  "becauseYouRatedHighly",
  "highConfidence",
  "trendingNearYourTaste",
  "freshInYourSources",
  "outsideYourUsualReads",
];

const SECTION_META: Record<RecommendationSectionKey, { title: string; reason: string }> = {
  becauseYouRatedHighly: {
    title: "Because of your library profile",
    reason: "Similar to titles in your library and synced tracker history.",
  },
  highConfidence: {
    title: "High confidence matches",
    reason: "Best blend of personal taste, tracker consensus, and availability.",
  },
  trendingNearYourTaste: {
    title: "Trending near your taste",
    reason: "Titles gaining momentum without drifting too far from your profile.",
  },
  freshInYourSources: {
    title: "Fresh in your sources",
    reason: "Recent updates and newly available titles from installed sources.",
  },
  outsideYourUsualReads: {
    title: "Outside your usual reads",
    reason: "Divergent, high-quality picks to avoid a recommendation loop.",
  },
};

export function scoreRecommendationCandidate(
  candidate: RecommendationCandidate,
  profile: TasteProfile,
  nowMs = Date.now(),
): RecommendationScoreBreakdown {
  const normalizedTags = [...new Set(candidate.tags.flatMap(recommendationTagTokens))];
  const topicalTags = normalizedTags.filter((tag) => !isRecommendationMetadataTag(tag));
  const { affinity: personalRatingAffinity, negativeTagPenalty, matchedTagCount } = tagTasteAffinity(topicalTags, profile);

  const profileTagOverlap = profileTagOverlapRatioForTags(topicalTags, profile);
  const contentTypeFit = clamp01(contentTypeWeightForCandidate(candidate.contentType, profile) / Math.max(1, maxMapValue(profile.contentTypeWeights)));
  const sourceAffinity = sourceAffinityScore(candidate, profile);
  const contentSimilarity = clamp01(
    (profileTagOverlap * 0.66)
    + (contentTypeFit * 0.18)
    + (sourceAffinity * 0.16),
  );

  const trackerConsensus = combineMetrics(candidate.providers
    .filter((provider) => provider.kind === "tracker")
    .map((provider) => provider.score))?.value ?? 0;

  const trendingVelocity = combineMetrics(candidate.providers.flatMap((provider) => [
    provider.trending,
  ]))?.value ?? 0;

  const recency = combineMetrics([
    normalizeRecency(candidate.updatedAtMs, nowMs, 14, 0.7),
    normalizeRecency(candidate.publishedAtMs, nowMs, 45, 0.45),
    ...candidate.providers.map((provider) => provider.recency),
  ])?.value ?? 0;

  const sourceAvailability = combineMetrics(candidate.providers
    .filter((provider) => provider.kind === "source")
    .map((provider) => provider.availability))?.value
    ?? (candidate.providers.some((provider) => provider.kind === "source") ? 0.55 : 0);

  const novelty = noveltyScore(profileTagOverlap, personalRatingAffinity, contentTypeFit);
  const finalScore = clamp01(
    (personalRatingAffinity * 0.34)
    + (contentSimilarity * 0.16)
    + (trackerConsensus * 0.18)
    + (trendingVelocity * 0.1)
    + (recency * 0.08)
    + (sourceAvailability * 0.06)
    + (sourceAffinity * 0.04)
    + (novelty * 0.04),
  );

  return {
    personalRatingAffinity,
    profileTagOverlap,
    contentTypeFit,
    sourceAffinity,
    contentSimilarity,
    trackerConsensus,
    trendingVelocity,
    recency,
    sourceAvailability,
    novelty,
    negativeTagPenalty,
    matchedTagCount,
    finalScore,
    diversityBucket: diversityBucket(profileTagOverlap, personalRatingAffinity),
  };
}

/**
 * How much of this title is made of things the reader likes. Each tag is
 * scored against the reader's strongest tag (square root so secondary tastes
 * still count), then averaged over the title's own tags. Unlike a share of the
 * whole profile, this does not collapse for readers with several distinct
 * tastes. The strongest disliked tag scales the result down.
 */
function tagTasteAffinity(topicalTags: string[], profile: TasteProfile): {
  affinity: number;
  negativeTagPenalty: number;
  matchedTagCount: number;
} {
  if (topicalTags.length === 0) return { affinity: 0, negativeTagPenalty: 0, matchedTagCount: 0 };
  let strongestPositive = 0;
  for (const weight of profile.tagWeights.values()) {
    if (weight > strongestPositive) strongestPositive = weight;
  }
  const reference = Math.max(0.35, strongestPositive);

  let positive = 0;
  let negativeTagPenalty = 0;
  let matchedTagCount = 0;
  for (const tag of topicalTags) {
    const weight = profile.tagWeights.get(tag) ?? 0;
    if (weight > 0) {
      const match = Math.min(1, Math.sqrt(weight / reference));
      positive += match;
      if (match >= MATCHED_TAG_MIN) matchedTagCount += 1;
    } else if (weight < 0) {
      negativeTagPenalty = Math.max(negativeTagPenalty, Math.min(1, Math.abs(weight) / NEGATIVE_WEIGHT_SCALE));
    }
  }
  // Long tag lists are common on some sources; damp them so unrelated extra
  // tags do not erase a strong match, while a single matching tag stays weak.
  const evidence = Math.max(3, Math.sqrt(3 * topicalTags.length));
  return {
    affinity: clamp01((positive / evidence) * (1 - negativeTagPenalty)),
    negativeTagPenalty,
    matchedTagCount,
  };
}

export function buildRecommendationSections(
  candidates: RecommendationCandidate[],
  profile: TasteProfile,
  options: BuildRecommendationSectionsOptions = {},
): RecommendationSection[] {
  const requestedLimit = options.limitPerSection ?? DEFAULT_LIMIT;
  const items = candidates
    .filter((candidate) => passesFilters(candidate, options))
    .map((candidate): RecommendationItem => ({
      candidate,
      breakdown: scoreRecommendationCandidate(candidate, profile, options.nowMs),
      badge: buildTrackerScoreBadge(candidate),
    }))
    .filter((item) => !isAffinityGroupMismatch(item, profile));

  const ranked: Record<RecommendationSectionKey, RecommendationItem[]> = {
    becauseYouRatedHighly: rankSectionItems(items, requestedLimit, "becauseYouRatedHighly", (item) =>
      (item.breakdown.personalRatingAffinity * 0.7)
      + (item.breakdown.profileTagOverlap * 0.2)
      + (item.breakdown.sourceAffinity * 0.05)
      + (qualityScore(item) * 0.05),
      (item) => profile.seedCount > 0
        && hasExternalProvider(item)
        && matchesDominantComicFormat(item, profile)
        && item.breakdown.matchedTagCount > 0
        && item.breakdown.personalRatingAffinity >= PROFILE_MATCH_MIN
        && item.breakdown.negativeTagPenalty < PROFILE_NEGATIVE_MAX,
      profile,
    ),
    highConfidence: rankSectionItems(items, requestedLimit, "highConfidence", (item) =>
      (qualityScore(item) * 0.42)
      + (item.breakdown.trackerConsensus * 0.2)
      + (providerEvidenceScore(item) * 0.18)
      + (profileAffinityScore(item) * 0.12)
      + (item.breakdown.sourceAvailability * 0.08),
      (item) => hasExternalProvider(item)
        && (qualityScore(item) >= 0.52 || proseWarmStartCandidate(item, profile))
        && (profile.seedCount === 0 || (
          fitsProfileComicFormat(item, profile)
          && (
            (
              item.breakdown.personalRatingAffinity >= HIGH_CONFIDENCE_PROFILE_MIN
              && item.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX
            )
            || (
              !hasTopicalTags(item)
              && item.breakdown.trackerConsensus >= 0.82
              && qualityScore(item) >= 0.72
            )
          )
        )),
      profile,
    ),
    trendingNearYourTaste: rankSectionItems(items, requestedLimit, "trendingNearYourTaste", (item) =>
      (momentumScore(item) * 0.52)
      + (item.breakdown.trendingVelocity * 0.18)
      + (item.breakdown.recency * 0.1)
      + (profileAffinityScore(item) * 0.1)
      + (qualityScore(item) * 0.06)
      + (item.breakdown.sourceAffinity * 0.04),
      (item) => hasExternalProvider(item)
        && (momentumScore(item) >= 0.08 || proseWarmStartCandidate(item, profile))
        && (qualityScore(item) >= 0.42 || proseWarmStartCandidate(item, profile))
        && (profile.seedCount === 0 || (
          fitsProfileComicFormat(item, profile)
          && item.breakdown.personalRatingAffinity >= TRENDING_PROFILE_MIN
          && item.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX
        )),
      profile,
    ),
    freshInYourSources: rankSectionItems(items, requestedLimit, "freshInYourSources", (item) =>
      (freshnessScore(item) * 0.62)
      + (item.breakdown.personalRatingAffinity * 0.14)
      + (item.breakdown.sourceAvailability * 0.1)
      + (item.breakdown.sourceAffinity * 0.06)
      + (item.breakdown.contentTypeFit * 0.04)
      + (qualityScore(item) * 0.04),
      (item) => hasExternalProvider(item)
        && (freshnessScore(item) >= 0.12 || proseSourceAvailabilityCandidate(item, profile))
        && (profile.seedCount === 0 || fitsProfileComicFormat(item, profile))
        && item.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX,
      profile,
    ),
    outsideYourUsualReads: rankSectionItems(items, requestedLimit, "outsideYourUsualReads", (item) =>
      (item.breakdown.novelty * 0.64)
      + (qualityScore(item) * 0.18)
      + (item.breakdown.sourceAvailability * 0.1)
      + (freshnessScore(item) * 0.08),
      (item) => profile.seedCount > 0
        && hasExternalProvider(item)
        && outsideUsualEligibility(item, profile)
        && item.breakdown.diversityBucket === "divergent"
        && item.breakdown.profileTagOverlap < OUTSIDE_PROFILE_OVERLAP_MAX
        && item.breakdown.personalRatingAffinity < OUTSIDE_PERSONAL_AFFINITY_MAX
        // Divergent, not disliked: a tag from dropped or low-rated works only
        // passes when the title is exceptionally well regarded.
        && item.breakdown.negativeTagPenalty < SECTION_NEGATIVE_MAX
        && (item.breakdown.negativeTagPenalty === 0 || qualityScore(item) >= 0.7),
      profile,
    ),
  };

  const drafted = draftUniqueSectionItems(ranked, requestedLimit);
  return SECTION_DISPLAY_ORDER.map((key) => {
    const meta = SECTION_META[key];
    const sectionItems = shouldApplyProfileComicMix(key)
      ? applyProfileComicMix(drafted[key], profile, requestedLimit).slice(0, requestedLimit)
      : drafted[key];
    return { key, title: meta.title, reason: meta.reason, items: sectionItems };
  });
}

export function buildTrackerScoreBadge(candidate: RecommendationCandidate): TrackerScoreBadge | null {
  const trackerSignals = candidate.providers
    .filter((provider) => provider.kind === "tracker" && provider.score && provider.score.confidence > 0)
    .map((provider) => ({ provider, score: provider.score! }));

  if (trackerSignals.length === 0) return null;

  const consensus = combineMetrics(trackerSignals.map((entry) => entry.score));
  if (!consensus) return null;

  const providerIds = trackerSignals.map((entry) => entry.provider.providerId);
  const iconKeys = trackerSignals.map((entry) => entry.provider.iconKey ?? entry.provider.providerId);
  return {
    kind: trackerSignals.length > 1 ? "consensus" : "tracker",
    providerIds,
    iconKeys,
    score: consensus.value,
    displayScore: formatScore(consensus.value),
    confidence: consensus.confidence,
  };
}

/**
 * Reorders a ranked row so near-identical titles (same tag set) do not sit
 * next to each other. Relevance still dominates; only the first positions are
 * rearranged and the tail keeps its ranked order.
 */
export function rerankForDiversity(
  entries: Array<{ item: RecommendationItem; score: number }>,
): RecommendationItem[] {
  if (entries.length <= 2) return entries.map((entry) => entry.item);
  const remaining = entries.slice(0, MMR_WINDOW);
  const tail = entries.slice(MMR_WINDOW);
  const tagSets = new Map(remaining.map((entry) => [entry.item, topicalTagSet(entry.item)]));
  const selected: typeof entries = [];

  while (remaining.length > 0 && selected.length < MMR_POSITIONS) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidateTags = tagSets.get(remaining[index].item)!;
      let maxSimilarity = 0;
      for (const chosen of selected) {
        maxSimilarity = Math.max(maxSimilarity, jaccardSimilarity(candidateTags, tagSets.get(chosen.item)!));
      }
      const value = (MMR_LAMBDA * remaining[index].score) - ((1 - MMR_LAMBDA) * maxSimilarity);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return [...selected, ...remaining, ...tail].map((entry) => entry.item);
}

function rankSectionItems(
  items: RecommendationItem[],
  limit: number,
  sectionKey: RecommendationSectionKey,
  scoreFn: (item: RecommendationItem) => number,
  isEligible: (item: RecommendationItem) => boolean,
  profile: TasteProfile,
): RecommendationItem[] {
  if (limit <= 0) return [];
  const scored = items
    .map((item) => ({ item, score: scoreFn(item) }))
    .filter((entry) => entry.score > 0 && isEligible(entry.item))
    .sort((a, b) => (b.score - a.score) || (stableSectionJitter(b.item, sectionKey) - stableSectionJitter(a.item, sectionKey)));
  const uniqueItems = new Set(dedupeRecommendationItems(scored.map((entry) => entry.item)));
  const unique = scored.filter((entry) => uniqueItems.has(entry.item));
  // Fresh keeps pure recency order; every other row spreads similar titles apart.
  const ordered = sectionKey === "freshInYourSources"
    ? unique.map((entry) => entry.item)
    : rerankForDiversity(unique);
  return shouldApplyProfileComicMix(sectionKey) ? applyProfileComicMix(ordered, profile, limit) : ordered;
}

/**
 * Page-level uniqueness: every work (by any identity key, so aliases count)
 * lands in one row only. Rows take turns in SECTION_DRAFT_ORDER claiming their
 * best remaining work, but skip a work that another row ranks far higher, so a
 * title that leads "Fresh" is not taken by a row where it is only a filler.
 * A second pass lets rows with room pick works whose preferred row filled up.
 */
function draftUniqueSectionItems(
  ranked: Record<RecommendationSectionKey, RecommendationItem[]>,
  limit: number,
): Record<RecommendationSectionKey, RecommendationItem[]> {
  const identityKeysByItem = new Map<RecommendationItem, string[]>();
  const identityKeysOf = (item: RecommendationItem) => {
    let keys = identityKeysByItem.get(item);
    if (!keys) {
      keys = recommendationCandidateIdentityKeys(item.candidate);
      identityKeysByItem.set(item, keys);
    }
    return keys;
  };

  // Best rank of each identity key in each row.
  const ranksByIdentity = new Map<string, Map<RecommendationSectionKey, number>>();
  for (const key of SECTION_DRAFT_ORDER) {
    ranked[key].forEach((item, rank) => {
      for (const identityKey of identityKeysOf(item)) {
        let ranks = ranksByIdentity.get(identityKey);
        if (!ranks) {
          ranks = new Map();
          ranksByIdentity.set(identityKey, ranks);
        }
        if (!ranks.has(key) || rank < ranks.get(key)!) ranks.set(key, rank);
      }
    });
  }
  // Rows that rank a work similarly share it by taking turns; a row only
  // yields when another ranks the work at least twice as high.
  const rankedFarHigherElsewhere = (item: RecommendationItem, key: RecommendationSectionKey, rank: number) =>
    identityKeysOf(item).some((identityKey) => {
      for (const [otherKey, otherRank] of ranksByIdentity.get(identityKey) ?? []) {
        if (otherKey !== key && picked[otherKey].length < limit && otherRank < rank / 2) return true;
      }
      return false;
    });

  const claimed = new Set<string>();
  const picked = Object.fromEntries(
    SECTION_DRAFT_ORDER.map((key) => [key, [] as RecommendationItem[]]),
  ) as Record<RecommendationSectionKey, RecommendationItem[]>;

  const runPass = (respectPreference: boolean) => {
    const cursors = new Map<RecommendationSectionKey, number>(SECTION_DRAFT_ORDER.map((key) => [key, 0]));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const key of SECTION_DRAFT_ORDER) {
        if (picked[key].length >= limit) continue;
        const list = ranked[key];
        let cursor = cursors.get(key) ?? 0;
        while (cursor < list.length) {
          const rank = cursor;
          const item = list[cursor];
          cursor += 1;
          const identityKeys = identityKeysOf(item);
          if (identityKeys.some((identityKey) => claimed.has(identityKey))) continue;
          if (respectPreference && rankedFarHigherElsewhere(item, key, rank)) continue;
          for (const identityKey of identityKeys) claimed.add(identityKey);
          picked[key].push(item);
          progressed = true;
          break;
        }
        cursors.set(key, cursor);
      }
    }
  };
  runPass(true);
  runPass(false);

  for (const key of SECTION_DRAFT_ORDER) {
    const rankOf = new Map(ranked[key].map((item, rank) => [item, rank]));
    picked[key].sort((a, b) => (rankOf.get(a) ?? 0) - (rankOf.get(b) ?? 0));
  }
  return picked;
}

function shouldApplyProfileComicMix(sectionKey: RecommendationSectionKey): boolean {
  return sectionKey !== "freshInYourSources" && sectionKey !== "outsideYourUsualReads";
}

function topicalTagSet(item: RecommendationItem): Set<string> {
  return new Set(item.candidate.tags
    .flatMap(recommendationTagTokens)
    .filter((tag) => !isRecommendationMetadataTag(tag)));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const tag of a) if (b.has(tag)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

export function dedupeRecommendationItems(items: RecommendationItem[]): RecommendationItem[] {
  const seenIdentityKeys = new Set<string>();
  const unique: RecommendationItem[] = [];

  for (const item of items) {
    const identityKeys = recommendationCandidateIdentityKeys(item.candidate);
    if (identityKeys.some((key) => seenIdentityKeys.has(key))) continue;
    for (const key of identityKeys) seenIdentityKeys.add(key);
    unique.push(item);
  }

  return unique;
}

function hasExternalProvider(item: RecommendationItem): boolean {
  return item.candidate.providers.some((provider) => provider.kind === "source" || provider.kind === "tracker");
}

function proseWarmStartCandidate(item: RecommendationItem, profile: TasteProfile): boolean {
  return profile.seedCount === 0
    && isProseContentType(item.candidate.contentType)
    && item.breakdown.sourceAvailability >= 0.45
    && (qualityScore(item) >= 0.35 || momentumScore(item) >= 0.08)
    && item.candidate.title.trim().length > 0;
}

function proseSourceAvailabilityCandidate(item: RecommendationItem, profile: TasteProfile): boolean {
  return isProseContentType(item.candidate.contentType)
    && item.breakdown.sourceAvailability >= 0.45
    && item.candidate.title.trim().length > 0
    && (profile.seedCount === 0 || contentTypeFitScore(item, profile) >= 0.18);
}

function profileAffinityScore(item: RecommendationItem): number {
  return clamp01(
    (item.breakdown.personalRatingAffinity * 0.58)
    + (item.breakdown.profileTagOverlap * 0.24)
    + (item.breakdown.contentTypeFit * 0.1)
    + (item.breakdown.sourceAffinity * 0.08),
  );
}

function contentTypeFitScore(item: RecommendationItem, profile: TasteProfile): number {
  return item.breakdown.contentTypeFit;
}

function sourceAffinityScore(candidate: RecommendationCandidate, profile: TasteProfile): number {
  const positiveSourceWeights = [...profile.sourceWeights.entries()]
    .filter(([, weight]) => weight > 0);
  const maxSourceWeight = Math.max(0, ...positiveSourceWeights.map(([, weight]) => weight));
  if (maxSourceWeight <= 0) return 0;

  const candidateSourceKeys = candidate.providers.flatMap((provider) => {
    if (provider.kind === "source") return [provider.providerId];
    if (provider.kind === "tracker") return [`tracker:${provider.providerId}`];
    return [];
  });
  const strongestMatch = candidateSourceKeys.reduce(
    (strongest, key) => Math.max(strongest, profile.sourceWeights.get(key) ?? 0),
    0,
  );
  return clamp01(strongestMatch / maxSourceWeight);
}

function contentTypeWeightForCandidate(
  contentType: RecommendationCandidate["contentType"],
  profile: TasteProfile,
): number {
  const direct = profile.contentTypeWeights.get(contentType) ?? 0;
  if (contentType === "novel") {
    return Math.max(direct, (profile.contentTypeWeights.get("book") ?? 0) * 0.82);
  }
  if (contentType === "book") {
    return Math.max(direct, (profile.contentTypeWeights.get("novel") ?? 0) * 0.82);
  }
  return direct;
}

function matchesDominantComicFormat(item: RecommendationItem, profile: TasteProfile): boolean {
  if (!isComicContentType(item.candidate.contentType)) return true;
  const dominant = dominantComicContentType(profile);
  if (!dominant || dominant.contentType === "manga") return true;
  if (dominant.share < 0.48) return true;
  return item.candidate.contentType === dominant.contentType;
}

function fitsProfileComicFormat(item: RecommendationItem, profile: TasteProfile): boolean {
  if (!isComicContentType(item.candidate.contentType)) return true;
  const distribution = comicContentTypeDistribution(profile);
  if (distribution.total <= 0) return true;
  const dominant = dominantComicContentType(profile);
  if (!dominant || dominant.share < 0.48) return true;
  if (dominant.contentType === "manga") return true;
  if (item.candidate.contentType === dominant.contentType) return true;
  const share = distribution.shares.get(item.candidate.contentType) ?? 0;
  return share >= 0.18 || contentTypeFitScore(item, profile) >= 0.45;
}

function dominantComicContentType(profile: TasteProfile): { contentType: "manga" | "manhwa" | "manhua"; share: number } | null {
  const distribution = comicContentTypeDistribution(profile);
  if (distribution.total <= 0) return null;
  const dominant = ([...distribution.shares.entries()] as Array<["manga" | "manhwa" | "manhua", number]>)
    .sort((a, b) => b[1] - a[1])[0];
  return { contentType: dominant[0], share: dominant[1] };
}

function comicContentTypeDistribution(profile: TasteProfile): {
  total: number;
  shares: Map<"manga" | "manhwa" | "manhua", number>;
} {
  const entries = (["manga", "manhwa", "manhua"] as const)
    .map((contentType) => ({
      contentType,
      weight: Math.max(0, profile.contentTypeWeights.get(contentType) ?? 0),
    }));
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return {
    total,
    shares: new Map(entries.map((entry) => [
      entry.contentType,
      total > 0 ? entry.weight / total : 0,
    ])),
  };
}

function applyProfileComicMix(
  items: RecommendationItem[],
  profile: TasteProfile | undefined,
  limit: number,
): RecommendationItem[] {
  if (!profile || limit <= 0) return items;
  const distribution = comicContentTypeDistribution(profile);
  const dominant = dominantComicContentType(profile);
  if (!dominant || distribution.total <= 0 || dominant.share < 0.48) return items;

  const comicTypes = ["manga", "manhwa", "manhua"] as const;
  const buckets = new Map<"manga" | "manhwa" | "manhua", RecommendationItem[]>();
  for (const type of comicTypes) buckets.set(type, []);
  for (const item of items) {
    if (isComicContentType(item.candidate.contentType)) {
      buckets.get(item.candidate.contentType)?.push(item);
    }
  }
  if ((buckets.get(dominant.contentType)?.length ?? 0) === 0) return items;

  const targets = new Map<"manga" | "manhwa" | "manhua", number>();
  for (const type of comicTypes) {
    const share = distribution.shares.get(type) ?? 0;
    const dominantTarget = Math.ceil(limit * Math.min(0.9, Math.max(0.62, dominant.share)));
    targets.set(type, type === dominant.contentType ? dominantTarget : Math.round(limit * share));
  }

  const result: RecommendationItem[] = [];
  const used = new Set<string>();
  const take = (type: "manga" | "manhwa" | "manhua", count: number) => {
    const bucket = buckets.get(type) ?? [];
    while (count > 0 && bucket.length > 0 && result.length < limit) {
      const next = bucket.shift()!;
      if (used.has(next.candidate.id)) continue;
      used.add(next.candidate.id);
      result.push(next);
      count -= 1;
    }
  };

  take(dominant.contentType, targets.get(dominant.contentType) ?? 0);
  for (const type of comicTypes) {
    if (type !== dominant.contentType) take(type, targets.get(type) ?? 0);
  }

  for (const item of items) {
    if (used.has(item.candidate.id)) continue;
    used.add(item.candidate.id);
    result.push(item);
  }
  return result;
}

function isComicContentType(contentType: RecommendationCandidate["contentType"]): contentType is "manga" | "manhwa" | "manhua" {
  return contentType === "manga" || contentType === "manhwa" || contentType === "manhua";
}

function isProseContentType(contentType: RecommendationCandidate["contentType"]): contentType is "novel" | "book" {
  return contentType === "novel" || contentType === "book";
}

function profileTagOverlapRatioForTags(tags: string[], profile: TasteProfile): number {
  const profileTags = new Set(profile.topTags.map(normalizeToken).filter(Boolean));
  const candidateTags = new Set(tags.map(normalizeToken).filter(Boolean));
  if (profileTags.size === 0 || candidateTags.size === 0) return 0;

  const overlap = [...candidateTags].filter((tag) => profileTags.has(tag)).length;
  const union = new Set([...profileTags, ...candidateTags]).size;
  return union > 0 ? overlap / union : 0;
}

function hasTopicalTags(item: RecommendationItem): boolean {
  return item.candidate.tags
    .flatMap(recommendationTagTokens)
    .some((tag) => !isRecommendationMetadataTag(tag));
}

function outsideUsualEligibility(item: RecommendationItem, profile: TasteProfile): boolean {
  if (hasTopicalTags(item)) return true;
  if (!isComicContentType(item.candidate.contentType)) return false;
  const dominant = dominantComicContentType(profile);
  if (!dominant || dominant.share < 0.48) return false;
  return item.candidate.contentType !== dominant.contentType
    && contentTypeFitScore(item, profile) <= 0.35
    && item.breakdown.sourceAvailability >= 0.45;
}

function qualityScore(item: RecommendationItem): number {
  return combineMetrics(item.candidate.providers.flatMap((provider) => [
    provider.score,
    provider.popularity,
  ]))?.value ?? 0;
}

function providerEvidenceScore(item: RecommendationItem): number {
  const providers = item.candidate.providers.filter((provider) => provider.kind !== "library");
  if (providers.length === 0) return 0;

  const metrics = providers.flatMap((provider) => [
    provider.score,
    provider.popularity,
    provider.trending,
    provider.availability,
  ]);
  const confidence = combineMetrics(metrics)?.confidence ?? 0;
  const kindCoverage = new Set(providers.map((provider) => provider.kind)).size / 2;
  const providerCoverage = clamp01(providers.length / 3);
  return clamp01(
    (confidence * 0.5)
    + (kindCoverage * 0.3)
    + (providerCoverage * 0.2),
  );
}

function momentumScore(item: RecommendationItem): number {
  return combineMetrics(item.candidate.providers.flatMap((provider) => [
    provider.trending,
    provider.recency,
    provider.activity,
    provider.popularity ? { ...provider.popularity, confidence: provider.popularity.confidence * 0.45, method: `${provider.popularity.method}/momentum` } : undefined,
  ]))?.value ?? 0;
}

type AffinityGroup = "boysLove" | "matureRomance";

function isAffinityGroupMismatch(item: RecommendationItem, profile: TasteProfile): boolean {
  const groups = candidateAffinityGroups(item);
  if (groups.size === 0) return false;
  return [...groups].some((group) => !profileHasAffinityGroup(profile, group));
}

function candidateAffinityGroups(item: RecommendationItem): Set<AffinityGroup> {
  const tokens = candidateTextTokens(item);
  const groups = new Set<AffinityGroup>();
  if (tokens.some(isBoysLoveTag)) groups.add("boysLove");
  if (hasMatureRomanceSignal(tokens)) groups.add("matureRomance");
  return groups;
}

function profileHasAffinityGroup(profile: TasteProfile, group: AffinityGroup): boolean {
  const tags = new Set([...profile.positiveTags, ...profile.topTags]);
  if (group === "boysLove") {
    return [...tags].some(isBoysLoveTag)
      || [...profile.tagWeights.entries()].some(([tag, weight]) => weight > 0.15 && isBoysLoveTag(tag));
  }
  if (group === "matureRomance") {
    return hasMatureRomanceSignal([...tags])
      || [...profile.tagWeights.entries()].some(([tag, weight]) => weight > 0.15 && hasMatureRomanceSignal([tag]));
  }
  return false;
}

function candidateTextTokens(item: RecommendationItem): string[] {
  return [
    ...[
      item.candidate.title,
      ...(item.candidate.alternativeTitles ?? []),
      ...(item.candidate.tags ?? []),
      item.candidate.status ?? "",
    ].map(normalizeToken),
    ...(item.candidate.tags ?? []).flatMap(recommendationTagTokens),
  ].filter(Boolean);
}

function isBoysLoveTag(tag: string): boolean {
  return tag === "yaoi"
    || tag === "boys love"
    || tag === "boy love"
    || tag === "bl"
    || tag === "shounen ai"
    || tag === "shonen ai";
}

function hasMatureRomanceSignal(tokens: string[]): boolean {
  const text = tokens.join(" ");
  const hasRomanceSignal = tokens.some((tag) =>
    tag === "romance"
    || tag === "love"
    || tag === "romantic"
    || tag.includes("romance")
    || tag.includes("roommate")
    || tag.includes("relationship"),
  );
  if (!hasRomanceSignal) return false;
  return tokens.some((tag) =>
    tag === "spicy"
    || tag === "smut"
    || tag === "erotica"
    || tag === "erotic"
    || tag === "mature"
    || tag === "adult"
    || tag.includes("spicy")
    || tag.includes("smut")
    || tag.includes("erotica")
    || tag.includes("mature romance"),
  ) || /\bspicy\b/.test(text);
}

function freshnessScore(item: RecommendationItem): number {
  return combineMetrics([
    item.breakdown.recency > 0 ? { value: item.breakdown.recency, confidence: 0.75, method: "candidate-recency" } : undefined,
    ...item.candidate.providers.map((provider) => provider.recency),
  ])?.value ?? 0;
}

function passesFilters(candidate: RecommendationCandidate, options: BuildRecommendationSectionsOptions): boolean {
  if (!options.includeInLibrary && candidate.inLibrary) return false;
  if (!options.includeInLibrary && isKnownCandidate(candidate, options)) return false;
  if (!options.includeNsfw && (candidate.safety === "adult" || candidate.safety === "explicit")) return false;

  const blockedTags = new Set((options.blockedTags ?? []).map(normalizeToken).filter(Boolean));
  if (blockedTags.size === 0) return true;
  // A blocked "Action" also hides "Battle / Action"; a blocked compound only hides itself.
  return !candidate.tags.some((tag) =>
    blockedTags.has(normalizeToken(tag)) || recommendationTagTokens(tag).some((token) => blockedTags.has(token)));
}

function isKnownCandidate(candidate: RecommendationCandidate, options: BuildRecommendationSectionsOptions): boolean {
  const knownTitleKeys = new Set(options.knownTitleKeys ?? []);
  if (knownTitleKeys.size > 0 && recommendationCandidateTitleKeys(candidate).some((key) => knownTitleKeys.has(key))) {
    return true;
  }

  const knownProviderKeys = new Set(options.knownProviderKeys ?? []);
  if (knownProviderKeys.size === 0) return false;

  if (candidate.id.startsWith("tracker:") && knownProviderKeys.has(candidate.id.toLowerCase())) return true;
  return candidate.providers.some((provider) => {
    const key = recommendationProviderRemoteKey(provider);
    return key != null && knownProviderKeys.has(key);
  });
}

function noveltyScore(overlapRatio: number, personalAffinity: number, contentTypeFit: number): number {
  const distance = clamp01(
    ((1 - overlapRatio) * 0.5)
    + ((1 - personalAffinity) * 0.35)
    + ((1 - contentTypeFit) * 0.15),
  );
  if (overlapRatio >= 0.38 || personalAffinity >= 0.58) return clamp01(0.12 + (distance * 0.16));
  if (overlapRatio >= 0.16 || personalAffinity >= 0.22) return clamp01(0.35 + (distance * 0.25));
  return clamp01(0.65 + (distance * 0.35));
}

function diversityBucket(overlapRatio: number, personalAffinity: number): RecommendationDiversityBucket {
  if (overlapRatio >= 0.38 || personalAffinity >= 0.58) return "familiar";
  if (overlapRatio >= 0.16 || personalAffinity >= 0.22) return "adjacent";
  return "divergent";
}

function formatScore(value: number): string {
  return (clamp01(value) * 10).toFixed(1);
}

function stableSectionJitter(item: RecommendationItem, sectionKey: RecommendationSectionKey): number {
  const input = `${sectionKey}:${item.candidate.id}:${item.candidate.title}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function maxMapValue<K>(map: Map<K, number>): number {
  return Math.max(0, ...map.values());
}
