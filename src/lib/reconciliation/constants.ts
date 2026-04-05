import type { ClusterInferenceConfig } from "./types";

export const MAX_SAMPLED_MANGA_PER_CLUSTER = 5;
export const MAX_CANDIDATES_PER_MANGA_SEARCH = 8;
export const MAX_RETAINED_CANDIDATES_PER_CLUSTER = 5;
export const REQUEST_TIMEOUT_MS = 4000;
export const CLUSTER_TIMEOUT_MS = 15000;
export const FULL_INFERENCE_TIMEOUT_MS = 45000;
export const MAX_CLUSTER_SEARCH_ERRORS = 3;
export const HIGH_CONFIDENCE_THRESHOLD = 0.88;
export const MIN_TOP_VS_SECOND_MARGIN = 0.12;
export const MIN_CONSISTENT_MATCHES_FOR_AUTOSELECT = 2;

export const DEFAULT_CLUSTER_INFERENCE_CONFIG: ClusterInferenceConfig = {
  maxSampledMangaPerCluster: MAX_SAMPLED_MANGA_PER_CLUSTER,
  maxCandidatesPerMangaSearch: MAX_CANDIDATES_PER_MANGA_SEARCH,
  maxRetainedCandidatesPerCluster: MAX_RETAINED_CANDIDATES_PER_CLUSTER,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  clusterTimeoutMs: CLUSTER_TIMEOUT_MS,
  fullInferenceTimeoutMs: FULL_INFERENCE_TIMEOUT_MS,
  maxClusterSearchErrors: MAX_CLUSTER_SEARCH_ERRORS,
  highConfidenceThreshold: HIGH_CONFIDENCE_THRESHOLD,
  minTopVsSecondMargin: MIN_TOP_VS_SECOND_MARGIN,
  minConsistentMatchesForAutoSelect: MIN_CONSISTENT_MATCHES_FOR_AUTOSELECT,
};
