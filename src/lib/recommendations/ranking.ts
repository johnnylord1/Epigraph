import { clamp01, combineMetrics, normalizeRecency, normalizeToken } from "./normalization";
import { recommendationCandidateTitleKeys, recommendationProviderRemoteKey } from "./identity";
import { isRecommendationMetadataTag } from "./metadata";
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
  const normalizedTags = candidate.tags.map(normalizeToken).filter(Boolean);
  const tagWeights = normalizedTags.map((tag) => profile.tagWeights.get(tag) ?? 0);
  const positiveWeight = tagWeights.filter((weight) => weight > 0).reduce((sum, weight) => sum + weight, 0);
  const negativeWeight = Math.abs(tagWeights.filter((weight) => weight < 0).reduce((sum, weight) => sum + weight, 0));
  const maxPositive = Math.max(1, [...profile.tagWeights.values()].filter((weight) => weight > 0).reduce((sum, weight) => sum + weight, 0));
  const personalRatingAffinity = clamp01((positiveWeight / maxPositive) - (negativeWeight / maxPositive));

  const topTagSet = new Set(profile.topTags);
  const overlap = normalizedTags.filter((tag) => topTagSet.has(tag)).length;
  const overlapRatio = profile.topTags.length > 0 ? overlap / Math.min(profile.topTags.length, Math.max(1, normalizedTags.length)) : 0;
  const contentTypeAffinity = clamp01(contentTypeWeightForCandidate(candidate.contentType, profile) / Math.max(1, maxMapValue(profile.contentTypeWeights)));
  const contentSimilarity = clamp01((overlapRatio * 0.78) + (contentTypeAffinity * 0.22));

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

  const novelty = noveltyScore(overlapRatio, personalRatingAffinity);
  const finalScore = clamp01(
    (personalRatingAffinity * 0.35)
    + (contentSimilarity * 0.15)
    + (trackerConsensus * 0.2)
    + (trendingVelocity * 0.1)
    + (recency * 0.08)
    + (sourceAvailability * 0.07)
    + (novelty * 0.05),
  );

  return {
    personalRatingAffinity,
    contentSimilarity,
    trackerConsensus,
    trendingVelocity,
    recency,
    sourceAvailability,
    novelty,
    finalScore,
    diversityBucket: diversityBucket(overlapRatio, personalRatingAffinity),
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

  return [
    buildCriterionSection("becauseYouRatedHighly", items, requestedLimit, (item) =>
      (item.breakdown.personalRatingAffinity * 0.56)
      + (item.breakdown.contentSimilarity * 0.24)
      + (contentTypeFitScore(item, profile) * 0.2),
      (item) => profile.seedCount > 0
        && hasExternalProvider(item)
        && matchesDominantComicFormat(item, profile)
        && contentTypeFitScore(item, profile) >= 0.18
        && profileTasteSignalScore(item, profile) >= 0.16,
      profile,
    ),
    buildCriterionSection("highConfidence", rerankForDiversity(items), requestedLimit, (item) =>
      (profileAffinityScore(item) * 0.32)
      + (qualityScore(item) * 0.3)
      + (contentTypeFitScore(item, profile) * 0.2)
      + (item.breakdown.sourceAvailability * 0.12)
      + (item.breakdown.finalScore * 0.06),
      (item) => hasExternalProvider(item)
        && (qualityScore(item) >= 0.52 || proseWarmStartCandidate(item, profile))
        && (profile.seedCount === 0 || (
          fitsProfileComicFormat(item, profile)
          && profileTasteSignalScore(item, profile) >= 0.12
          && contentTypeFitScore(item, profile) >= 0.18
        )),
      profile,
    ),
    buildCriterionSection("trendingNearYourTaste", items, requestedLimit, (item) =>
      (momentumScore(item) * 0.42)
      + (qualityScore(item) * 0.28)
      + (profileAffinityScore(item) * 0.18)
      + (contentTypeFitScore(item, profile) * 0.06)
      + (item.breakdown.sourceAvailability * 0.06),
      (item) => hasExternalProvider(item)
        && (momentumScore(item) >= 0.08 || proseWarmStartCandidate(item, profile))
        && (qualityScore(item) >= 0.42 || proseWarmStartCandidate(item, profile))
        && (profile.seedCount === 0 || fitsProfileComicFormat(item, profile))
        && (profile.seedCount === 0 || profileTasteSignalScore(item, profile) >= 0.1),
      profile,
    ),
    buildCriterionSection("freshInYourSources", items, requestedLimit, (item) =>
      (freshnessScore(item) * 0.68)
      + (item.breakdown.sourceAvailability * 0.14)
      + (contentTypeFitScore(item, profile) * 0.12)
      + (qualityScore(item) * 0.08)
      + (profileAffinityScore(item) * 0.06),
      (item) => hasExternalProvider(item)
        && freshnessScore(item) >= 0.12
        && (profile.seedCount === 0 || fitsProfileComicFormat(item, profile)),
      profile,
    ),
    buildCriterionSection("outsideYourUsualReads", items, requestedLimit, (item) =>
      (item.breakdown.novelty * 0.5)
      + (qualityScore(item) * 0.22)
      + (item.breakdown.sourceAvailability * 0.16)
      + (freshnessScore(item) * 0.12),
      (item) => profile.seedCount > 0
        && hasExternalProvider(item)
        && outsideUsualEligibility(item, profile)
        && item.breakdown.diversityBucket !== "familiar"
        && profileTagOverlapRatio(item, profile) < 0.35
        && item.breakdown.personalRatingAffinity < 0.45,
    ),
  ];
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

export function rerankForDiversity(items: RecommendationItem[]): RecommendationItem[] {
  const sorted = [...items].sort((a, b) => b.breakdown.finalScore - a.breakdown.finalScore);
  const buckets: Record<RecommendationDiversityBucket, RecommendationItem[]> = {
    familiar: sorted.filter((item) => item.breakdown.diversityBucket === "familiar"),
    adjacent: sorted.filter((item) => item.breakdown.diversityBucket === "adjacent"),
    divergent: sorted.filter((item) => item.breakdown.diversityBucket === "divergent"),
  };

  const pattern: RecommendationDiversityBucket[] = [
    "familiar", "familiar", "familiar", "familiar", "familiar", "familiar", "familiar",
    "adjacent", "adjacent",
    "divergent",
  ];
  const result: RecommendationItem[] = [];
  while (result.length < sorted.length) {
    const before = result.length;
    for (const bucket of pattern) {
      const next = buckets[bucket].shift();
      if (next) result.push(next);
    }
    if (result.length === before) break;
  }

  return result;
}

function buildCriterionSection(
  key: RecommendationSectionKey,
  items: RecommendationItem[],
  limit: number,
  scoreFn: (item: RecommendationItem) => number,
  isEligible: (item: RecommendationItem) => boolean,
  profile?: TasteProfile,
): RecommendationSection {
  const meta = SECTION_META[key];
  const ranked = rankSectionItems(items, limit, key, scoreFn, isEligible, profile);
  return { key, title: meta.title, reason: meta.reason, items: ranked };
}

function rankSectionItems(
  items: RecommendationItem[],
  limit: number,
  sectionKey: RecommendationSectionKey,
  scoreFn: (item: RecommendationItem) => number,
  isEligible: (item: RecommendationItem) => boolean,
  profile?: TasteProfile,
): RecommendationItem[] {
  if (limit <= 0) return [];
  const ranked = [...items]
    .map((item) => ({
      item,
      score: scoreFn(item),
    }))
    .filter((item) => {
      return item.score > 0 && isEligible(item.item);
    })
    .sort((a, b) => (b.score - a.score) || (stableSectionJitter(b.item, sectionKey) - stableSectionJitter(a.item, sectionKey)))
    .map((entry) => entry.item);
  return applyProfileComicMix(ranked, profile, limit).slice(0, limit);
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

function profileAffinityScore(item: RecommendationItem): number {
  return clamp01((item.breakdown.personalRatingAffinity * 0.65) + (item.breakdown.contentSimilarity * 0.35));
}

function profileTasteSignalScore(item: RecommendationItem, profile: TasteProfile): number {
  const explicitSignal = Math.max(item.breakdown.personalRatingAffinity, profileTagOverlapRatio(item, profile));
  if (explicitSignal > 0) return explicitSignal;
  if (hasTopicalTags(item)) return 0;
  if (isProseContentType(item.candidate.contentType)) {
    return contentTypeFitScore(item, profile) * 0.55;
  }
  return contentTypeFitScore(item, profile) * 0.18;
}

function contentTypeFitScore(item: RecommendationItem, profile: TasteProfile): number {
  const maxWeight = maxMapValue(profile.contentTypeWeights);
  if (maxWeight <= 0) return 1;
  return clamp01(contentTypeWeightForCandidate(item.candidate.contentType, profile) / maxWeight);
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

function profileTagOverlapRatio(item: RecommendationItem, profile: TasteProfile): number {
  if (profile.topTags.length === 0) return 0;
  const profileTags = new Set(profile.topTags);
  const candidateTags = item.candidate.tags.map(normalizeToken).filter(Boolean);
  if (candidateTags.length === 0) return 0;
  const overlap = candidateTags.filter((tag) => profileTags.has(tag)).length;
  return overlap / Math.min(profileTags.size, candidateTags.length);
}

function hasTopicalTags(item: RecommendationItem): boolean {
  return item.candidate.tags
    .map(normalizeToken)
    .filter(Boolean)
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
    item.candidate.title,
    ...(item.candidate.alternativeTitles ?? []),
    ...(item.candidate.tags ?? []),
    item.candidate.status ?? "",
  ]
    .map(normalizeToken)
    .filter(Boolean);
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
  return !candidate.tags.some((tag) => blockedTags.has(normalizeToken(tag)));
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

function noveltyScore(overlapRatio: number, personalAffinity: number): number {
  if (overlapRatio >= 0.75) return 0.18;
  if (overlapRatio >= 0.45) return 0.45;
  if (overlapRatio >= 0.18) return 0.95;
  return personalAffinity > 0.55 ? 0.78 : 0.62;
}

function diversityBucket(overlapRatio: number, personalAffinity: number): RecommendationDiversityBucket {
  if (overlapRatio >= 0.45 || personalAffinity >= 0.62) return "familiar";
  if (overlapRatio >= 0.18 || personalAffinity >= 0.22) return "adjacent";
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
