import { clamp01, normalizeScore, normalizeToken } from "./normalization";
import { isRecommendationMetadataTag } from "./metadata";
import type { RecommendationContentType, TasteProfile, TasteProfileSeedItem } from "./types";

const DEFAULT_IMPLICIT_WEIGHT = 0.35;

export function buildTasteProfile(items: TasteProfileSeedItem[]): TasteProfile {
  const tagWeights = new Map<string, number>();
  const contentTypeWeights = new Map<RecommendationContentType, number>();
  const sourceWeights = new Map<string, number>();

  for (const item of items) {
    const preference = preferenceWeight(item);
    if (preference === 0) continue;

    addWeight(contentTypeWeights, item.contentType, preference);
    if (item.sourceId) addWeight(sourceWeights, item.sourceId, preference);

    for (const tag of item.tags) {
      const normalized = normalizeToken(tag);
      if (!normalized) continue;
      if (isRecommendationMetadataTag(normalized)) continue;
      addWeight(tagWeights, normalized, preference);
    }
  }

  const sortedTags = [...tagWeights.entries()].sort((a, b) => b[1] - a[1]);
  return {
    tagWeights,
    contentTypeWeights,
    sourceWeights,
    topTags: sortedTags.filter(([, weight]) => weight > 0).slice(0, 10).map(([tag]) => tag),
    positiveTags: sortedTags.filter(([, weight]) => weight > 0.15).map(([tag]) => tag),
    negativeTags: sortedTags.filter(([, weight]) => weight < -0.15).map(([tag]) => tag),
    seedCount: items.length,
  };
}

export function preferenceWeight(item: TasteProfileSeedItem): number {
  const ratingWeight = ratingPreferenceWeight(item.userRating, item.userRatingMax);
  const statusMultiplier = statusPreferenceMultiplier(item.status);
  const implicit = typeof item.implicitWeight === "number"
    ? Math.max(-1, Math.min(1, item.implicitWeight))
    : DEFAULT_IMPLICIT_WEIGHT;

  const base = ratingWeight ?? implicit;
  return clampSigned(base * statusMultiplier, -1.4, 1.4);
}

export function ratingPreferenceWeight(
  rating: number | null | undefined,
  ratingMax: number | null | undefined = 10,
): number | null {
  const normalized = normalizeScore(rating, ratingMax ?? 10)?.value;
  if (normalized === undefined) return null;

  if (normalized >= 0.95) return 1.4;
  if (normalized >= 0.9) return 1.25;
  if (normalized >= 0.8) return 1;
  if (normalized >= 0.7) return 0.6;
  if (normalized >= 0.6) return 0.2;
  if (normalized >= 0.5) return -0.2;
  return -0.65;
}

function statusPreferenceMultiplier(status: TasteProfileSeedItem["status"]): number {
  switch (status) {
    case "completed":
      return 1.1;
    case "reading":
      return 1;
    case "planning":
      return 0.45;
    case "dropped":
      return -0.8;
    default:
      return 1;
  }
}

function addWeight<K>(map: Map<K, number>, key: K, weight: number) {
  map.set(key, (map.get(key) ?? 0) + weight);
}

function clampSigned(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}
