import type {
  OrphanSourceCluster,
  ParsedBackup,
  ParsedBackupSource,
  ReconciliationCandidate,
  ReconciliationClusterResult,
  ReconciliationWarning,
  SourceInventoryEntry,
} from "./types";
import { normalizeText, isNumericStub } from "./text";

function clusterSourceName(source: ParsedBackupSource | undefined, sourceId: string): string {
  const candidate = source?.name?.trim();
  return candidate || sourceId;
}

export function buildOrphanSourceClusters(parsedBackup: ParsedBackup): OrphanSourceCluster[] {
  const sourceMetaById = new Map(parsedBackup.backupSources.map((source) => [source.sourceId, source] as const));
  const grouped = new Map<string, typeof parsedBackup.backupManga>();
  for (const manga of parsedBackup.backupManga) {
    const bucket = grouped.get(manga.sourceId) ?? [];
    bucket.push(manga);
    grouped.set(manga.sourceId, bucket);
  }
  for (const source of parsedBackup.backupSources) {
    if (!grouped.has(source.sourceId)) grouped.set(source.sourceId, []);
  }

  return [...grouped.entries()].map(([sourceId, mangas]) => {
    const source = sourceMetaById.get(sourceId);
    return {
      orphanSourceId: sourceId,
      sourceName: clusterSourceName(source, sourceId),
      sourceLang: source?.lang ?? null,
      mangas,
    };
  });
}

function candidateFromInventory(
  entry: SourceInventoryEntry,
  confidence: number,
  reasonCode: ReconciliationCandidate["reasonCode"],
  evidenceSummary: string,
): ReconciliationCandidate {
  return {
    sourceId: entry.sourceId,
    sourceName: entry.name,
    sourceLang: entry.lang,
    displayName: entry.displayName,
    confidence,
    reasonCode,
    evidenceSummary,
    requiresInstall: !entry.extensionInstalled && entry.kind === "repo",
    extensionPkgName: entry.extensionPkgName,
    extensionName: entry.extensionName,
  };
}

function normalizedNameMatches(sourceName: string, entry: SourceInventoryEntry): boolean {
  const sourceNormalized = normalizeText(sourceName);
  return !!sourceNormalized && sourceNormalized === normalizeText(entry.name);
}

export function resolveExactCluster(
  cluster: OrphanSourceCluster,
  inventory: SourceInventoryEntry[],
): ReconciliationClusterResult {
  const exactInstalled = inventory.find((entry) => entry.kind === "installed" && entry.sourceId === cluster.orphanSourceId);
  if (exactInstalled) {
    return {
      ...cluster,
      status: "exact_resolved",
      sampleManga: cluster.mangas.slice(0, 3),
      selectedCandidate: candidateFromInventory(exactInstalled, 1, "installed-source-id", "Matched an installed source by exact source ID."),
      candidates: [candidateFromInventory(exactInstalled, 1, "installed-source-id", "Matched an installed source by exact source ID.")],
    };
  }

  const exactRepo = inventory.find((entry) => entry.kind === "repo" && entry.sourceId === cluster.orphanSourceId);
  if (exactRepo) {
    const candidate = candidateFromInventory(exactRepo, 1, "repo-source-id", "Matched a configured repo source by exact source ID.");
    return {
      ...cluster,
      status: "exact_resolved",
      sampleManga: cluster.mangas.slice(0, 3),
      selectedCandidate: candidate,
      candidates: [candidate],
    };
  }

  if (cluster.sourceName && !isNumericStub(cluster.sourceName)) {
    const byName = inventory.filter((entry) => normalizedNameMatches(cluster.sourceName, entry));
    if (cluster.sourceLang) {
      const byNameAndLang = byName.filter((entry) => entry.lang === cluster.sourceLang);
      if (byNameAndLang.length === 1) {
        const candidate = candidateFromInventory(
          byNameAndLang[0],
          0.96,
          "source-name-lang",
          `Matched normalized source name and language (${cluster.sourceLang}).`,
        );
        return {
          ...cluster,
          status: "exact_resolved",
          sampleManga: cluster.mangas.slice(0, 3),
          selectedCandidate: candidate,
          candidates: [candidate],
        };
      }
    }

    const uniqueLangs = new Set(byName.map((entry) => entry.lang));
    if (byName.length === 1 || uniqueLangs.size === 1) {
      const target = byName[0];
      if (target) {
        const candidate = candidateFromInventory(
          target,
          0.93,
          "source-name-unambiguous",
          "Matched normalized source name with no remaining language ambiguity.",
        );
        return {
          ...cluster,
          status: "exact_resolved",
          sampleManga: cluster.mangas.slice(0, 3),
          selectedCandidate: candidate,
          candidates: [candidate],
        };
      }
    }
  }

  return {
    ...cluster,
    status: "needs_review",
    sampleManga: [],
    selectedCandidate: null,
    candidates: [],
  };
}

export function runExactReconciliation(
  parsedBackup: ParsedBackup,
  inventory: SourceInventoryEntry[],
  warnings: ReconciliationWarning[] = [],
): {
  exactMatches: ReconciliationClusterResult[];
  unresolvedClusters: ReconciliationClusterResult[];
  warnings: ReconciliationWarning[];
} {
  const exactMatches: ReconciliationClusterResult[] = [];
  const unresolvedClusters: ReconciliationClusterResult[] = [];

  for (const cluster of buildOrphanSourceClusters(parsedBackup)) {
    const resolved = resolveExactCluster(cluster, inventory);
    if (resolved.status === "exact_resolved") exactMatches.push(resolved);
    else unresolvedClusters.push(resolved);
  }

  return { exactMatches, unresolvedClusters, warnings };
}
