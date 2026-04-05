import { fingerprintText, parseMihonBackup } from "../backup/mihonBackup";
import type { Tracker } from "../types";
import { DEFAULT_CLUSTER_INFERENCE_CONFIG } from "./constants";
import { buildOrphanSourceClusters, runExactReconciliation } from "./exact";
import { inferClusters } from "./inference";
import type {
  ClusterInferenceConfig,
  OverlayClusterRecord,
  OverlayEntry,
  OverlayFile,
  ParsedBackup,
  ReconciliationAnalysis,
  ReconciliationClusterResult,
  ReconciliationWarning,
  SourceInventoryEntry,
} from "./types";

function sourceInventoryFingerprintInput(inventory: SourceInventoryEntry[]): string {
  return inventory
    .map((entry) => [
      entry.kind,
      entry.sourceId,
      entry.name,
      entry.lang,
      entry.displayName,
      entry.extensionPkgName ?? "",
      entry.extensionInstalled ? "1" : "0",
    ].join("|"))
    .sort()
    .join("\n");
}

function overlayClusterToResult(record: OverlayClusterRecord): ReconciliationClusterResult {
  return {
    orphanSourceId: record.orphanSourceId,
    sourceName: record.sourceName,
    sourceLang: record.sourceLang,
    status: record.status,
    sampleManga: [],
    selectedCandidate: record.selectedCandidate,
    candidates: record.candidates,
  };
}

function hydrateFromOverlay(entry: OverlayEntry | undefined): Record<string, ReconciliationClusterResult> {
  if (!entry) return {};
  return Object.fromEntries(
    Object.entries(entry.clusters).map(([key, value]) => [key, overlayClusterToResult(value)]),
  );
}

function splitResults(
  exactMatches: ReconciliationClusterResult[],
  inferred: ReconciliationClusterResult[],
  warnings: ReconciliationWarning[],
  backupFingerprint: string,
  sourceInventoryFingerprint: string,
): ReconciliationAnalysis {
  const autoReconciled = inferred.filter((result) => result.status === "auto_reconciled");
  const needsReview = inferred.filter((result) => result.status === "needs_review");
  const unresolved = inferred.filter((result) => result.status === "unresolved");
  return {
    backupFingerprint,
    sourceInventoryFingerprint,
    exactMatches,
    autoReconciled,
    needsReview,
    unresolved,
    warnings,
  };
}

export function overlayEntryFromAnalysis(analysis: ReconciliationAnalysis): OverlayEntry {
  const allClusters = [...analysis.exactMatches, ...analysis.autoReconciled, ...analysis.needsReview, ...analysis.unresolved];
  return {
    backupFingerprint: analysis.backupFingerprint,
    sourceInventoryFingerprint: analysis.sourceInventoryFingerprint,
    updatedAt: new Date().toISOString(),
    clusters: Object.fromEntries(
      allClusters.map((cluster) => [
        cluster.orphanSourceId,
        {
          orphanSourceId: cluster.orphanSourceId,
          sourceName: cluster.sourceName,
          sourceLang: cluster.sourceLang,
          status: cluster.status,
          selectedCandidate: cluster.selectedCandidate,
          candidates: cluster.candidates,
        },
      ]),
    ),
  };
}

export async function analyzeBackupReconciliation(
  fileBytes: ArrayBuffer | Uint8Array,
  inventory: SourceInventoryEntry[],
  trackers: Tracker[],
  overlay: OverlayFile,
  config: ClusterInferenceConfig = DEFAULT_CLUSTER_INFERENCE_CONFIG,
): Promise<{ parsedBackup: ParsedBackup; analysis: ReconciliationAnalysis }> {
  const parsedBackup = await parseMihonBackup(fileBytes, inventory);
  const backupFingerprint = await fingerprintText([
    JSON.stringify(parsedBackup.backupSources),
    JSON.stringify(parsedBackup.backupManga.map((manga) => ({
      sourceId: manga.sourceId,
      title: manga.title,
      author: manga.author,
      artist: manga.artist,
      url: manga.url,
      chapterCount: manga.chapterCount,
    }))),
  ].join("\n"));
  const sourceInventoryFingerprint = await fingerprintText(sourceInventoryFingerprintInput(inventory));
  const overlayEntry = overlay.entries[backupFingerprint];
  const overlayResults = overlayEntry?.sourceInventoryFingerprint === sourceInventoryFingerprint
    ? hydrateFromOverlay(overlayEntry)
    : {};

  const missingTrackers = parsedBackup.trackerIds
    .filter((trackerId) => !(trackers ?? []).some((tracker) => tracker.id === trackerId))
    .map((trackerId) => ({ name: `Tracker #${trackerId}` }));

  const exact = runExactReconciliation(parsedBackup, inventory);
  const unresolvedClusters = buildOrphanSourceClusters(parsedBackup)
    .filter((cluster) => !exact.exactMatches.some((match) => match.orphanSourceId === cluster.orphanSourceId));

  const overlayBackedResults = unresolvedClusters
    .map((cluster) => overlayResults[cluster.orphanSourceId])
    .filter(Boolean);

  const pendingInferenceClusters = unresolvedClusters.filter((cluster) => !overlayResults[cluster.orphanSourceId]);
  const inferred = await inferClusters(
    pendingInferenceClusters,
    inventory,
    backupFingerprint,
    sourceInventoryFingerprint,
    config,
  );

  const warnings = [
    ...exact.warnings,
    ...inferred.warnings,
    ...missingTrackers.map<ReconciliationWarning>((tracker) => ({
      kind: "cluster_inference_failed",
      message: `Backup references ${tracker.name}, which is not available on the current server.`,
      details: tracker.name,
    })),
  ];

  const analysis = splitResults(
    exact.exactMatches,
    [...overlayBackedResults, ...inferred.results],
    warnings,
    backupFingerprint,
    sourceInventoryFingerprint,
  );

  return { parsedBackup, analysis };
}
