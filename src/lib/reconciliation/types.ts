import type { Extension, Source } from "../types";

export interface ParsedBackupSource {
  sourceId: string;
  name: string;
  lang: string | null;
}

export interface ParsedBackupManga {
  sourceId: string;
  url: string;
  title: string;
  author: string | null;
  artist: string | null;
  chapterCount: number | null;
  thumbnailUrl: string | null;
}

export interface ParsedBackup {
  bytes: Uint8Array;
  wasGzipped: boolean;
  backupSources: ParsedBackupSource[];
  backupManga: ParsedBackupManga[];
  trackerIds: number[];
  mangaMessages: unknown[];
  sourceMessages: unknown[];
  preservedTopLevelChunks: Uint8Array[];
}

export interface SourceInventoryEntry {
  sourceId: string;
  name: string;
  lang: string;
  displayName: string;
  kind: "installed" | "repo";
  extensionPkgName: string | null;
  extensionName: string | null;
  extensionInstalled: boolean;
}

export interface OrphanSourceCluster {
  orphanSourceId: string;
  sourceName: string;
  sourceLang: string | null;
  mangas: ParsedBackupManga[];
}

export type ReconciliationReasonCode =
  | "installed-source-id"
  | "repo-source-id"
  | "source-name-lang"
  | "source-name-unambiguous"
  | "cluster-inference";

export interface ReconciliationCandidate {
  sourceId: string;
  sourceName: string;
  sourceLang: string;
  displayName: string;
  confidence: number;
  reasonCode: ReconciliationReasonCode;
  evidenceSummary: string;
  requiresInstall: boolean;
  extensionPkgName: string | null;
  extensionName: string | null;
  matchedBy?: "source-id" | "source-name";
  scoreBreakdown?: {
    titleSimilarity: number;
    authorSimilarity: number;
    artistSimilarity: number;
    chapterSimilarity: number;
    slugSimilarity: number;
    consistency: number;
  };
}

export interface ReconciliationClusterResult {
  orphanSourceId: string;
  sourceName: string;
  sourceLang: string | null;
  status: "exact_resolved" | "auto_reconciled" | "needs_review" | "unresolved";
  sampleManga: ParsedBackupManga[];
  selectedCandidate: ReconciliationCandidate | null;
  candidates: ReconciliationCandidate[];
}

export interface ReconciliationWarning {
  kind: "repo_lookup_failed" | "inference_timeout" | "cluster_inference_failed";
  message: string;
  details?: string;
}

export interface ReconciliationAnalysis {
  backupFingerprint: string;
  sourceInventoryFingerprint: string;
  exactMatches: ReconciliationClusterResult[];
  autoReconciled: ReconciliationClusterResult[];
  needsReview: ReconciliationClusterResult[];
  unresolved: ReconciliationClusterResult[];
  warnings: ReconciliationWarning[];
}

export type RestoreReadinessStatus =
  | "ready_now"
  | "requires_install"
  | "unavailable"
  | "unresolved";

export interface RestoreReadinessItem {
  orphanSourceId: string;
  sourceName: string;
  sourceLang: string | null;
  status: RestoreReadinessStatus;
  clusterKind: "exact" | "auto" | "review" | "unresolved";
  selectedCandidate: ReconciliationCandidate | null;
  extension: AvailableExtensionEntry | null;
  detail: string;
}

export interface RestoreReadinessSummary {
  items: RestoreReadinessItem[];
  readyNow: RestoreReadinessItem[];
  requiresInstall: RestoreReadinessItem[];
  unavailable: RestoreReadinessItem[];
  unresolved: RestoreReadinessItem[];
  installableExtensions: AvailableExtensionEntry[];
  readyNowCount: number;
  requiresInstallCount: number;
  unavailableCount: number;
  unresolvedCount: number;
  blocksRestore: boolean;
}

export interface ClusterInferenceConfig {
  maxSampledMangaPerCluster: number;
  maxCandidatesPerMangaSearch: number;
  maxRetainedCandidatesPerCluster: number;
  requestTimeoutMs: number;
  clusterTimeoutMs: number;
  fullInferenceTimeoutMs: number;
  maxClusterSearchErrors: number;
  highConfidenceThreshold: number;
  minTopVsSecondMargin: number;
  minConsistentMatchesForAutoSelect: number;
}

export interface OverlayClusterRecord {
  orphanSourceId: string;
  sourceName: string;
  sourceLang: string | null;
  status: ReconciliationClusterResult["status"];
  selectedCandidate: ReconciliationCandidate | null;
  candidates: ReconciliationCandidate[];
}

export interface OverlayEntry {
  backupFingerprint: string;
  sourceInventoryFingerprint: string;
  updatedAt: string;
  clusters: Record<string, OverlayClusterRecord>;
}

export interface OverlayFile {
  version: 1;
  entries: Record<string, OverlayEntry>;
}

export interface TrackerValidationResult {
  missingTrackers: { id: number; name: string }[];
}

export interface RestoreReviewState {
  clusterSelections: Record<string, string | "skip">;
}

export interface SearchCacheValue {
  source: Source;
  results: { id: number; title: string; thumbnailUrl: string; inLibrary: boolean }[];
}

export interface RepoExtensionLookup {
  sourceId: string;
  sourceName: string;
  lang: string;
  extensionPkgName: string;
  extensionName: string;
}

export interface AvailableExtensionEntry extends Extension {
  repoSources: RepoExtensionLookup[];
}
