import { createReconciledBackupPayload, reconciledMangaMessages } from "../backup/mihonBackup";
import type { MangaParityTitle } from "../backup/mangaRestoreParity";
import type { NativeSourceRestoreChoice, ParsedBackup } from "./types";
import type { ReconciliationAnalysis } from "./types";

export function buildSourceMapping(
  analysis: ReconciliationAnalysis,
  choices: Record<string, NativeSourceRestoreChoice>,
): Record<string, { sourceId: string; name: string; lang?: string | null }> {
  const mapping: Record<string, { sourceId: string; name: string; lang?: string | null }> = {};

  const knownSourceIds = new Set([
    ...analysis.exactMatches,
    ...analysis.autoReconciled,
    ...analysis.needsReview,
    ...analysis.unresolved,
  ].map((cluster) => cluster.orphanSourceId));
  for (const [orphanSourceId, choice] of Object.entries(choices)) {
    if (!knownSourceIds.has(orphanSourceId) || choice.mode !== "map") continue;
    mapping[orphanSourceId] = {
      sourceId: choice.sourceId,
      name: choice.name,
      lang: choice.lang,
    };
  }

  return mapping;
}

export function buildExcludedSourceIds(
  analysis: ReconciliationAnalysis,
  choices: Record<string, NativeSourceRestoreChoice>,
): string[] {
  const knownSourceIds = new Set([
    ...analysis.exactMatches,
    ...analysis.autoReconciled,
    ...analysis.needsReview,
    ...analysis.unresolved,
  ].map((cluster) => cluster.orphanSourceId));
  return Object.entries(choices)
    .filter(([sourceId, choice]) => knownSourceIds.has(sourceId) && choice.mode === "skip")
    .map(([sourceId]) => sourceId);
}

export function buildReconciledBackupFile(
  parsedBackup: ParsedBackup,
  analysis: ReconciliationAnalysis,
  choices: Record<string, NativeSourceRestoreChoice>,
  originalFilename: string,
): File {
  const mapping = buildSourceMapping(analysis, choices);
  const excludedSourceIds = buildExcludedSourceIds(analysis, choices);
  const payload = createReconciledBackupPayload(parsedBackup, mapping, excludedSourceIds);
  return new File([Uint8Array.from(payload).buffer], originalFilename, { type: "application/octet-stream" });
}

/** The titles the reconciled backup sends, and whether it brings categories for them. */
export function buildMangaRestoreParityInput(
  parsedBackup: ParsedBackup,
  analysis: ReconciliationAnalysis,
  choices: Record<string, NativeSourceRestoreChoice>,
): MangaParityTitle[] {
  return reconciledMangaMessages(parsedBackup, buildSourceMapping(analysis, choices), buildExcludedSourceIds(analysis, choices))
    .map((message: any) => ({ sourceId: String(message.source ?? ""), url: String(message.url ?? ""), hasCategories: (message.categories?.length ?? 0) > 0 }));
}
