import type {
  AvailableExtensionEntry,
  ReconciliationAnalysis,
  ReconciliationCandidate,
  ReconciliationClusterResult,
  RestoreReadinessItem,
  RestoreReadinessSummary,
  SourceInventoryEntry,
} from "./types";

function selectedCandidateForCluster(
  cluster: ReconciliationClusterResult,
  manualSelections: Record<string, string | "skip">,
): ReconciliationCandidate | null {
  if (cluster.status === "exact_resolved" || cluster.status === "auto_reconciled") {
    return cluster.selectedCandidate;
  }

  if (cluster.status === "needs_review") {
    const selection = manualSelections[cluster.orphanSourceId];
    if (!selection || selection === "skip") return null;
    return cluster.candidates.find((candidate) => candidate.sourceId === selection) ?? null;
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
  manualSelections: Record<string, string | "skip">,
  inventory: SourceInventoryEntry[],
  availableExtensions: AvailableExtensionEntry[],
): RestoreReadinessSummary {
  const usableSourceIds = new Set(
    inventory
      .filter((entry) => entry.kind === "installed")
      .map((entry) => entry.sourceId),
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
    const candidate = selectedCandidateForCluster(cluster, manualSelections);
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
        detail: cluster.status === "needs_review"
          ? "This cluster still needs an explicit choice or skip before it can be reconciled."
          : "No confident replacement source is available yet.",
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
    blocksRestore: requiresInstall.length > 0 || unavailable.length > 0,
  };
}
