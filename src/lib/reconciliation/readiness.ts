import type {
  AvailableExtensionEntry,
  NativeSourceRestoreChoice,
  ReconciliationAnalysis,
  ReconciliationCandidate,
  ReconciliationClusterResult,
  RestoreReadinessItem,
  RestoreReadinessSummary,
  SourceInventoryEntry,
} from "./types";

function selectedCandidateForCluster(
  cluster: ReconciliationClusterResult,
  choices: Record<string, NativeSourceRestoreChoice>,
): ReconciliationCandidate | null {
  const choice = choices[cluster.orphanSourceId];
  if (choice?.mode === "skip" || choice?.mode === "preserve") return null;
  if (cluster.status === "exact_resolved" && cluster.selectedCandidate?.sourceId === cluster.orphanSourceId && !choice) {
    return cluster.selectedCandidate;
  }

  if (cluster.status === "exact_resolved" || cluster.status === "auto_reconciled" || cluster.status === "needs_review") {
    if (!choice || choice.mode !== "map") return null;
    return cluster.candidates.find((candidate) => candidate.sourceId === choice.sourceId) ?? null;
  }

  return null;
}

function clusterKind(cluster: ReconciliationClusterResult): RestoreReadinessItem["clusterKind"] {
  switch (cluster.status) {
    case "exact_resolved":
      return "exact";
    case "auto_reconciled":
      return "auto";
    case "needs_review":
      return "review";
    default:
      return "unresolved";
  }
}

export function buildRestoreReadiness(
  analysis: ReconciliationAnalysis,
  choices: Record<string, NativeSourceRestoreChoice>,
  inventory: SourceInventoryEntry[],
  availableExtensions: AvailableExtensionEntry[],
): RestoreReadinessSummary {
  const usableSourceIds = new Set(
    inventory
      .filter((entry) => entry.kind === "installed")
      .map((entry) => entry.sourceId),
  );
  const packagesWithUsableSources = new Set(
    inventory
      .filter((entry) => entry.kind === "installed" && entry.extensionPkgName)
      .map((entry) => entry.extensionPkgName as string),
  );
  const extensionsByPkg = new Map(
    availableExtensions.map((extension) => [extension.pkgName, extension] as const),
  );

  const allClusters = [
    ...analysis.exactMatches,
    ...analysis.autoReconciled,
    ...analysis.needsReview,
    ...analysis.unresolved,
  ];

  const items: RestoreReadinessItem[] = allClusters.map((cluster) => {
    const candidate = selectedCandidateForCluster(cluster, choices);
    const extension = candidate?.extensionPkgName
      ? extensionsByPkg.get(candidate.extensionPkgName) ?? null
      : null;

    if (!candidate) {
      return {
        orphanSourceId: cluster.orphanSourceId,
        sourceName: cluster.sourceName,
        sourceLang: cluster.sourceLang,
        status: "unresolved",
        clusterKind: clusterKind(cluster),
        selectedCandidate: null,
        extension: null,
        detail: choiceForDisplay(cluster.orphanSourceId, choices),
      };
    }

    if (usableSourceIds.has(candidate.sourceId)) {
      return {
        orphanSourceId: cluster.orphanSourceId,
        sourceName: cluster.sourceName,
        sourceLang: cluster.sourceLang,
        status: "ready_now",
        clusterKind: clusterKind(cluster),
        selectedCandidate: candidate,
        extension,
        detail: "The target source is already usable on this server.",
      };
    }

    if (extension) {
      if (extension.isInstalled && packagesWithUsableSources.has(extension.pkgName)) {
        return {
          orphanSourceId: cluster.orphanSourceId,
          sourceName: cluster.sourceName,
          sourceLang: cluster.sourceLang,
          status: "unavailable",
          clusterKind: clusterKind(cluster),
          selectedCandidate: candidate,
          extension,
          detail: "The installed extension with this package comes from another repository and does not provide this source.",
        };
      }
      return {
        orphanSourceId: cluster.orphanSourceId,
        sourceName: cluster.sourceName,
        sourceLang: cluster.sourceLang,
        status: "requires_install",
        clusterKind: clusterKind(cluster),
        selectedCandidate: candidate,
        extension,
        detail: extension.isInstalled
          ? "The extension exists but the source is not usable on this server yet. Refresh after it finishes syncing."
          : "This source mapping is valid, but its extension still needs to be installed on this server.",
      };
    }

    return {
      orphanSourceId: cluster.orphanSourceId,
      sourceName: cluster.sourceName,
      sourceLang: cluster.sourceLang,
      status: "unavailable",
      clusterKind: clusterKind(cluster),
      selectedCandidate: candidate,
      extension: null,
      detail: "The target source was reconciled, but there is no installable extension candidate available on this server right now.",
    };
  });

  const readyNow = items.filter((item) => item.status === "ready_now");
  const requiresInstall = items.filter((item) => item.status === "requires_install");
  const unavailable = items.filter((item) => item.status === "unavailable");
  const unresolved = items.filter((item) => item.status === "unresolved");

  const installableExtensions = [
    ...new Map(
      requiresInstall
        .filter((item) => item.extension)
        .map((item) => [item.extension!.pkgName, item.extension!] as const),
    ).values(),
  ];

  return {
    items,
    readyNow,
    requiresInstall,
    unavailable,
    unresolved,
    installableExtensions,
    readyNowCount: readyNow.length,
    requiresInstallCount: requiresInstall.length,
    unavailableCount: unavailable.length,
    unresolvedCount: unresolved.length,
    blocksRestore: requiresInstall.length > 0 || [...unavailable, ...unresolved].some((item) => choices[item.orphanSourceId]?.mode === "map"),
  };
}

function choiceForDisplay(sourceId: string, choices: Record<string, NativeSourceRestoreChoice>): string {
  return choices[sourceId]?.mode === "skip"
    ? "Titles from this source will be excluded as requested."
    : "The original source and its titles will be preserved. Choose a replacement only if you want to reconnect them.";
}
