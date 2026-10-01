export type RecommendationProviderKind = "library" | "tracker" | "source";

export type RecommendationContentType = "manga" | "manhwa" | "manhua" | "novel" | "book";

export type RecommendationSafetyLevel = "safe" | "suggestive" | "adult" | "explicit";

export interface NormalizedMetric {
  value: number;
  confidence: number;
  sourceValue?: string;
  method: string;
}

export interface RecommendationProviderSignal {
  providerId: string;
  providerName: string;
  kind: RecommendationProviderKind;
  remoteId?: string | null;
  iconKey?: string;
  score?: NormalizedMetric;
  popularity?: NormalizedMetric;
  trending?: NormalizedMetric;
  recency?: NormalizedMetric;
  activity?: NormalizedMetric;
  availability?: NormalizedMetric;
}

export interface RecommendationCandidate {
  id: string;
  title: string;
  alternativeTitles?: string[];
  coverUrl?: string | null;
  tags: string[];
  contentType: RecommendationContentType;
  status?: string | null;
  providers: RecommendationProviderSignal[];
  inLibrary?: boolean;
  safety?: RecommendationSafetyLevel;
  updatedAtMs?: number | null;
  publishedAtMs?: number | null;
}

export interface TasteProfileSeedItem {
  id: string;
  title: string;
  tags: string[];
  contentType: RecommendationContentType;
  sourceId?: string | null;
  userRating?: number | null;
  userRatingMax?: number | null;
  implicitWeight?: number | null;
  status?: "reading" | "completed" | "dropped" | "planning" | "unknown" | null;
}

export interface TasteProfile {
  tagWeights: Map<string, number>;
  contentTypeWeights: Map<RecommendationContentType, number>;
  sourceWeights: Map<string, number>;
  topTags: string[];
  positiveTags: string[];
  negativeTags: string[];
  seedCount: number;
}

export interface RecommendationScoreBreakdown {
  personalRatingAffinity: number;
  profileTagOverlap: number;
  contentTypeFit: number;
  sourceAffinity: number;
  contentSimilarity: number;
  trackerConsensus: number;
  trendingVelocity: number;
  recency: number;
  sourceAvailability: number;
  novelty: number;
  /** Strongest dislike among the candidate's tags (0 = none, 1 = strongly disliked). */
  negativeTagPenalty: number;
  /** Topical tags that meaningfully match a positive taste signal. */
  matchedTagCount: number;
  finalScore: number;
  diversityBucket: RecommendationDiversityBucket;
}

export type RecommendationDiversityBucket = "familiar" | "adjacent" | "divergent";

export interface TrackerScoreBadge {
  kind: "tracker" | "consensus";
  providerIds: string[];
  iconKeys: string[];
  score: number;
  displayScore: string;
  confidence: number;
}

export interface RecommendationItem {
  candidate: RecommendationCandidate;
  breakdown: RecommendationScoreBreakdown;
  badge: TrackerScoreBadge | null;
}

export type RecommendationSectionKey =
  | "becauseYouRatedHighly"
  | "highConfidence"
  | "trendingNearYourTaste"
  | "freshInYourSources"
  | "outsideYourUsualReads";

export interface RecommendationSection {
  key: RecommendationSectionKey;
  title: string;
  reason: string;
  items: RecommendationItem[];
}

export interface BuildRecommendationSectionsOptions {
  includeInLibrary?: boolean;
  knownTitleKeys?: Iterable<string>;
  knownProviderKeys?: Iterable<string>;
  includeNsfw?: boolean;
  blockedTags?: string[];
  nowMs?: number;
  limitPerSection?: number;
}
