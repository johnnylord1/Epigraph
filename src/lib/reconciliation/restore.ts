import { createReconciledBackupPayload } from "../backup/mihonBackup";
import type { ParsedBackup } from "./types";
import type { ReconciliationAnalysis } from "./types";

export function buildSourceMapping(
  analysis: ReconciliationAnalysis,
  manualSelections: Record<string, string | "skip">,
): Record<string, { sourceId: string; name: string; lang?: string | null }> {
  const mapping: Record<string, { sourceId: string; name: string; lang?: string | null }> = {};

  for (const cluster of [...analysis.exactMatches, ...analysis.autoReconciled]) {
    const candidate = cluster.selectedCandidate;
    if (!candidate) continue;
    mapping[cluster.orphanSourceId] = {
      sourceId: candidate.sourceId,
      name: candidate.sourceName,
      lang: candidate.sourceLang,
    };
  }

  for (const cluster of analysis.needsReview) {
    const selection = manualSelections[cluster.orphanSourceId];
    if (!selection || selection === "skip") continue;
    const candidate = cluster.candidates.find((item) => item.sourceId === selection);
    if (!candidate) continue;
    mapping[cluster.orphanSourceId] = {
      sourceId: candidate.sourceId,
      name: candidate.sourceName,
      lang: candidate.sourceLang,
    };
  }

  return mapping;
}

export function buildExcludedSourceIds(
  analysis: ReconciliationAnalysis,
  manualSelections: Record<string, string | "skip">,
): string[] {
  const excluded = new Set<string>();

  for (const cluster of analysis.unresolved) {
    excluded.add(cluster.orphanSourceId);
  }

  for (const cluster of analysis.needsReview) {
    const selection = manualSelections[cluster.orphanSourceId];
    if (!selection || selection === "skip") {
      excluded.add(cluster.orphanSourceId);
    }
  }

  return [...excluded];
}

export function buildReconciledBackupFile(
  parsedBackup: ParsedBackup,
  analysis: ReconciliationAnalysis,
  manualSelections: Record<string, string | "skip">,
  originalFilename: string,
): File {
  const mapping = buildSourceMapping(analysis, manualSelections);
  const excludedSourceIds = buildExcludedSourceIds(analysis, manualSelections);
  const payload = createReconciledBackupPayload(parsedBackup, mapping, excludedSourceIds);
  return new File([payload], originalFilename, { type: "application/octet-stream" });
}
