import { gql } from "../client";
import { FETCH_MANGA, FETCH_SOURCE_MANGA, GET_CHAPTERS } from "../queries";
import type { Extension, Manga, Source } from "../types";
import { findMissingSourceExtensionSuggestions } from "../extensionSourceMap";
import type {
  AvailableExtensionEntry,
  ClusterInferenceConfig,
  OrphanSourceCluster,
  ParsedBackup,
  ParsedBackupManga,
  ReconciliationAnalysis,
  ReconciliationCandidate,
  ReconciliationClusterResult,
  ReconciliationWarning,
  SearchCacheValue,
  SourceInventoryEntry,
} from "./types";
import { fingerprintText } from "../backup/mihonBackup";

export const DEFAULT_INFERENCE_CONFIG: ClusterInferenceConfig = {
  maxSampledMangaPerCluster: 5,
  maxCandidatesPerMangaSearch: 8,
  maxRetainedCandidatesPerCluster: 5,
  requestTimeoutMs: 4000,
  clusterTimeoutMs: 15000,
  fullInferenceTimeoutMs: 45000,
  maxClusterSearchErrors: 3,
  highConfidenceThreshold: 0.88,
  minTopVsSecondMargin: 0.12,
  minConsistentMatchesForAutoSelect: 2,
};

type RepoEntry = {
  sourceId: string;
  name: string;
  lang: string;
  displayName: string;
  extensionPkgName: string;
  extensionName: string;
};

type CandidateEvidence = {
  mangaId: number;
  score: number;
  titleSimilarity: number;
  authorSimilarity: number;
  artistSimilarity: number;
  chapterSimilarity: number;
  slugSimilarity: number;
};

const searchCache = new Map<string, SearchCacheValue>();
const clusterCache = new Map<string, ReconciliationClusterResult>();

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeSlug(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  return normalizeName(parts[parts.length - 1] ?? trimmed);
}

function tokenize(value: string): string[] {
  return normalizeName(value).split(" ").filter(Boolean);
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  const jaccard = union === 0 ? 0 : intersection / union;
  const exact = normalizeName(left) === normalizeName(right) ? 1 : 0;
  return Math.max(jaccard, exact);
}

function stringEqualityScore(left: string | null, right: string | null): number {
  if (!left || !right) return 0;
  return normalizeName(left) === normalizeName(right) ? 1 : 0;
}

function chapterSimilarity(expected: number | null, actual: number | null): number {
  if (!expected || !actual || expected <= 0 || actual <= 0) return 0;
  const delta = Math.abs(expected - actual);
  return Math.max(0, 1 - delta / Math.max(expected, actual));
}

function scoreDistinctiveness(manga: ParsedBackupManga): number {
  const normalizedTitle = normalizeName(manga.title);
  return [
    manga.author ? 3 : 0,
    manga.artist ? 3 : 0,
    manga.chapterCount && manga.chapterCount > 0 ? 2 : 0,
    normalizeSlug(manga.url).length >= 4 ? 2 : 0,
    Math.min(4, normalizedTitle.split(" ").filter(Boolean).length),
    Math.min(4, normalizedTitle.length / 10),
  ].reduce((sum, value) => sum + value, 0);
}

function sampleRepresentativeManga(cluster: OrphanSourceCluster, maxCount: number): ParsedBackupManga[] {
  return [...cluster.mangas]
    .sort((left, right) => scoreDistinctiveness(right) - scoreDistinctiveness(left))
    .slice(0, maxCount);
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

async function fetchMangaDetails(mangaId: number, signal: AbortSignal): Promise<{ author: string | null; artist: string | null; chapterCount: number | null; realUrl: string | null }> {
  const [mangaResult, chaptersResult] = await Promise.all([
    gql<{ fetchManga: { manga: { author: string | null; artist: string | null; realUrl: string | null } } }>(
      FETCH_MANGA,
      { id: mangaId },
      signal,
    ),
    gql<{ chapters: { nodes: { id: number }[] } }>(GET_CHAPTERS, { mangaId }, signal),
  ]);

  return {
    author: mangaResult.fetchManga.manga.author,
    artist: mangaResult.fetchManga.manga.artist,
    realUrl: mangaResult.fetchManga.manga.realUrl,
    chapterCount: chaptersResult.chapters.nodes.length,
  };
}

async function searchSource(
  source: Source,
  title: string,
  signal: AbortSignal,
): Promise<SearchCacheValue> {
  const cacheKey = `${source.id}::${normalizeName(title)}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const result = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
    FETCH_SOURCE_MANGA,
    { source: source.id, type: "SEARCH", page: 1, query: title },
    signal,
  );
  const value: SearchCacheValue = {
    source,
    results: result.fetchSourceManga.mangas.map((manga) => ({
      id: manga.id,
      title: manga.title,
      thumbnailUrl: manga.thumbnailUrl,
      inLibrary: manga.inLibrary,
    })),
  };
  searchCache.set(cacheKey, value);
  return value;
}

async function scoreCandidateForSample(
  source: Source,
  sample: ParsedBackupManga,
  config: ClusterInferenceConfig,
  fullSignal: AbortSignal,
): Promise<CandidateEvidence | null> {
  const signal = combineSignals(fullSignal, timeoutSignal(config.requestTimeoutMs));
  const search = await searchSource(source, sample.title, signal);
  const topResults = search.results
    .map((result) => ({ result, titleScore: titleSimilarity(sample.title, result.title) }))
    .sort((left, right) => right.titleScore - left.titleScore)
    .slice(0, config.maxCandidatesPerMangaSearch);

  let best: CandidateEvidence | null = null;
  for (const entry of topResults) {
    const details = await fetchMangaDetails(entry.result.id, signal).catch(() => null);
    const authorScore = stringEqualityScore(sample.author, details?.author ?? null);
    const artistScore = stringEqualityScore(sample.artist, details?.artist ?? null);
    const chapterScore = chapterSimilarity(sample.chapterCount, details?.chapterCount ?? null);
    const slugScore = titleSimilarity(normalizeSlug(sample.url), normalizeSlug(details?.realUrl ?? ""));
    const totalScore =
      entry.titleScore * 0.5 +
      authorScore * 0.15 +
      artistScore * 0.1 +
      chapterScore * 0.15 +
      slugScore * 0.1;

    const evidence: CandidateEvidence = {
      mangaId: entry.result.id,
      score: totalScore,
      titleSimilarity: entry.titleScore,
      authorSimilarity: authorScore,
      artistSimilarity: artistScore,
      chapterSimilarity: chapterScore,
      slugSimilarity: slugScore,
    };

    if (!best || evidence.score > best.score) {
      best = evidence;
    }
  }

  return best;
}

function toClusterCacheKey(backupFingerprint: string, inventoryFingerprint: string, orphanSourceId: string): string {
  return `${backupFingerprint}::${inventoryFingerprint}::${orphanSourceId}`;
}

function chooseAutoCandidate(
  candidates: ReconciliationCandidate[],
  supportCounts: Map<string, number>,
  config: ClusterInferenceConfig,
): ReconciliationCandidate | null {
  if (!candidates.length) return null;
  const [top, second] = candidates;
  const margin = top.confidence - (second?.confidence ?? 0);
  const support = supportCounts.get(top.sourceId) ?? 0;
  if (
    top.confidence >= config.highConfidenceThreshold &&
    margin >= config.minTopVsSecondMargin &&
    support >= config.minConsistentMatchesForAutoSelect
  ) {
    return top;
  }
  return null;
}

export async function loadSourceInventory(
  installedSources: Source[],
  repoUrls: string[],
  availableExtensions: Extension[],
): Promise<{ inventory: SourceInventoryEntry[]; warnings: ReconciliationWarning[]; availableExtensionsWithSources: AvailableExtensionEntry[] }> {
  const inventory: SourceInventoryEntry[] = installedSources.map((source) => ({
    sourceId: String(source.id),
    name: source.name,
    lang: source.lang,
    displayName: source.displayName,
    kind: "installed",
    extensionPkgName: null,
    extensionName: null,
    extensionInstalled: true,
  }));

  const warnings: ReconciliationWarning[] = [];
  const suggestions = await findMissingSourceExtensionSuggestions([], repoUrls, availableExtensions, "en");
  void suggestions;

  const availableByPkg = new Map(availableExtensions.map((extension) => [extension.pkgName, extension] as const));
  const availableExtensionsWithSources: AvailableExtensionEntry[] = availableExtensions.map((extension) => ({
    ...extension,
    repoSources: [],
  }));
  const extIndex = new Map(availableExtensionsWithSources.map((entry) => [entry.pkgName, entry] as const));

  for (const url of repoUrls) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) throw new Error(text.slice(0, 120));
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("Repo index is not an array");

      for (const item of parsed as any[]) {
        for (const repoSource of item.sources ?? []) {
          const extension = availableByPkg.get(item.pkg);
          const displayName = repoSource.name ?? item.name;
          inventory.push({
            sourceId: String(repoSource.id),
            name: repoSource.name ?? item.name,
            lang: repoSource.lang ?? item.lang ?? "all",
            displayName,
            kind: "repo",
            extensionPkgName: item.pkg,
            extensionName: extension?.name ?? item.name,
            extensionInstalled: extension?.isInstalled ?? false,
          });

          const target = extIndex.get(item.pkg);
          if (target) {
            target.repoSources.push({
              sourceId: String(repoSource.id),
              sourceName: repoSource.name ?? item.name,
              lang: repoSource.lang ?? item.lang ?? "all",
              extensionPkgName: item.pkg,
              extensionName: extension?.name ?? item.name,
            });
          }
        }
      }
    } catch (error) {
      warnings.push({
        kind: "repo_lookup_failed",
        message: `Could not load extension repo index`,
        details: `${url}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { inventory, warnings, availableExtensionsWithSources };
}

export function fingerprintSourceInventory(inventory: SourceInventoryEntry[]): Promise<string> {
  const payload = inventory
    .map((entry) => `${entry.kind}|${entry.sourceId}|${entry.lang}|${entry.name}|${entry.extensionPkgName ?? ""}|${entry.extensionInstalled}`)
    .sort()
    .join("\n");
  return fingerprintText(payload);
}

export function buildOrphanSourceClusters(parsedBackup: ParsedBackup): OrphanSourceCluster[] {
  const sourcesById = new Map(parsedBackup.backupSources.map((source) => [source.sourceId, source] as const));
  const bySourceId = new Map<string, ParsedBackupManga[]>();
  for (const manga of parsedBackup.backupManga) {
    const list = bySourceId.get(manga.sourceId) ?? [];
    list.push(manga);
    bySourceId.set(manga.sourceId, list);
  }
  return [...bySourceId.entries()].map(([orphanSourceId, mangas]) => {
    const source = sourcesById.get(orphanSourceId);
    return {
      orphanSourceId,
      sourceName: source?.name ?? orphanSourceId,
      sourceLang: source?.lang ?? null,
      mangas,
    };
  });
}

export function resolveExactMatches(
  clusters: OrphanSourceCluster[],
  inventory: SourceInventoryEntry[],
): { exact: ReconciliationClusterResult[]; pending: OrphanSourceCluster[] } {
  const exact: ReconciliationClusterResult[] = [];
  const pending: OrphanSourceCluster[] = [];

  for (const cluster of clusters) {
    const byInstalledId = inventory.find((entry) => entry.kind === "installed" && entry.sourceId === cluster.orphanSourceId);
    if (byInstalledId) {
      exact.push({
        orphanSourceId: cluster.orphanSourceId,
        sourceName: cluster.sourceName,
        sourceLang: cluster.sourceLang,
        status: "exact_resolved",
        sampleManga: sampleRepresentativeManga(cluster, DEFAULT_INFERENCE_CONFIG.maxSampledMangaPerCluster),
        selectedCandidate: {
          sourceId: byInstalledId.sourceId,
          sourceName: byInstalledId.name,
          sourceLang: byInstalledId.lang,
          displayName: byInstalledId.displayName,
          confidence: 1,
          reasonCode: "installed-source-id",
          evidenceSummary: "Exact installed source id match",
          requiresInstall: false,
          extensionPkgName: byInstalledId.extensionPkgName,
          extensionName: byInstalledId.extensionName,
          matchedBy: "source-id",
        },
        candidates: [],
      });
      continue;
    }

    const byRepoId = inventory.find((entry) => entry.kind === "repo" && entry.sourceId === cluster.orphanSourceId);
    if (byRepoId) {
      exact.push({
        orphanSourceId: cluster.orphanSourceId,
        sourceName: cluster.sourceName,
        sourceLang: cluster.sourceLang,
        status: "exact_resolved",
        sampleManga: sampleRepresentativeManga(cluster, DEFAULT_INFERENCE_CONFIG.maxSampledMangaPerCluster),
        selectedCandidate: {
          sourceId: byRepoId.sourceId,
          sourceName: byRepoId.name,
          sourceLang: byRepoId.lang,
          displayName: byRepoId.displayName,
          confidence: 1,
          reasonCode: "repo-source-id",
          evidenceSummary: "Exact repo source id match",
          requiresInstall: !byRepoId.extensionInstalled,
          extensionPkgName: byRepoId.extensionPkgName,
          extensionName: byRepoId.extensionName,
          matchedBy: "source-id",
        },
        candidates: [],
      });
      continue;
    }

    const normalizedName = normalizeName(cluster.sourceName);
    if (normalizedName && !/^\d+$/.test(normalizedName)) {
      const nameMatches = inventory.filter((entry) => normalizeName(entry.name) === normalizedName);
      const sameLangMatches = cluster.sourceLang
        ? nameMatches.filter((entry) => entry.lang === cluster.sourceLang)
        : [];
      if (sameLangMatches.length === 1) {
        const match = sameLangMatches[0];
        exact.push({
          orphanSourceId: cluster.orphanSourceId,
          sourceName: cluster.sourceName,
          sourceLang: cluster.sourceLang,
          status: "exact_resolved",
          sampleManga: sampleRepresentativeManga(cluster, DEFAULT_INFERENCE_CONFIG.maxSampledMangaPerCluster),
          selectedCandidate: {
            sourceId: match.sourceId,
            sourceName: match.name,
            sourceLang: match.lang,
            displayName: match.displayName,
            confidence: 0.95,
            reasonCode: "source-name-lang",
            evidenceSummary: "Exact normalized source name + language match",
            requiresInstall: match.kind === "repo" && !match.extensionInstalled,
            extensionPkgName: match.extensionPkgName,
            extensionName: match.extensionName,
            matchedBy: "source-name",
          },
          candidates: [],
        });
        continue;
      }

      if (!cluster.sourceLang && nameMatches.length === 1) {
        const match = nameMatches[0];
        exact.push({
          orphanSourceId: cluster.orphanSourceId,
          sourceName: cluster.sourceName,
          sourceLang: cluster.sourceLang,
          status: "exact_resolved",
          sampleManga: sampleRepresentativeManga(cluster, DEFAULT_INFERENCE_CONFIG.maxSampledMangaPerCluster),
          selectedCandidate: {
            sourceId: match.sourceId,
            sourceName: match.name,
            sourceLang: match.lang,
            displayName: match.displayName,
            confidence: 0.92,
            reasonCode: "source-name-unambiguous",
            evidenceSummary: "Exact normalized source name match with no language ambiguity",
            requiresInstall: match.kind === "repo" && !match.extensionInstalled,
            extensionPkgName: match.extensionPkgName,
            extensionName: match.extensionName,
            matchedBy: "source-name",
          },
          candidates: [],
        });
        continue;
      }
    }

    pending.push(cluster);
  }

  return { exact, pending };
}

async function inferSingleCluster(
  cluster: OrphanSourceCluster,
  installedSources: Source[],
  config: ClusterInferenceConfig,
  backupFingerprint: string,
  inventoryFingerprint: string,
  fullSignal: AbortSignal,
): Promise<{ result: ReconciliationClusterResult; warnings: ReconciliationWarning[] }> {
  const cacheKey = toClusterCacheKey(backupFingerprint, inventoryFingerprint, cluster.orphanSourceId);
  const cached = clusterCache.get(cacheKey);
  if (cached) {
    return { result: cached, warnings: [] };
  }

  const warnings: ReconciliationWarning[] = [];
  const sampled = sampleRepresentativeManga(cluster, config.maxSampledMangaPerCluster);
  const candidateSources = installedSources.filter((source) =>
    cluster.sourceLang ? source.lang === cluster.sourceLang || source.lang === "all" : true,
  );

  const sourceEvidence = new Map<string, CandidateEvidence[]>();
  let searchErrors = 0;
  const clusterDeadline = Date.now() + config.clusterTimeoutMs;

  for (const sample of sampled) {
    if (Date.now() > clusterDeadline || fullSignal.aborted) {
      warnings.push({
        kind: "inference_timeout",
        message: `Inference timed out for cluster ${cluster.sourceName}`,
      });
      break;
    }

    for (const source of candidateSources) {
      if (Date.now() > clusterDeadline || fullSignal.aborted) break;
      try {
        const evidence = await scoreCandidateForSample(source, sample, config, combineSignals(fullSignal, timeoutSignal(config.clusterTimeoutMs)));
        if (!evidence) continue;
        const list = sourceEvidence.get(source.id) ?? [];
        list.push(evidence);
        sourceEvidence.set(source.id, list);
      } catch {
        searchErrors += 1;
        if (searchErrors >= config.maxClusterSearchErrors) {
          warnings.push({
            kind: "cluster_inference_failed",
            message: `Inference aborted for ${cluster.sourceName} after repeated search failures`,
          });
          break;
        }
      }
    }
    if (searchErrors >= config.maxClusterSearchErrors) break;
  }

  const candidates = [...sourceEvidence.entries()]
    .map(([sourceId, evidenceList]) => {
      const source = candidateSources.find((entry) => entry.id === sourceId);
      if (!source) return null;
      const avg = evidenceList.reduce((sum, evidence) => sum + evidence.score, 0) / evidenceList.length;
      const best = evidenceList.sort((left, right) => right.score - left.score)[0];
      const consistency = evidenceList.length / Math.max(sampled.length, 1);
      const confidence = avg * 0.75 + consistency * 0.25;
      const candidate: ReconciliationCandidate = {
        sourceId: String(source.id),
        sourceName: source.name,
        sourceLang: source.lang,
        displayName: source.displayName,
        confidence,
        reasonCode: "cluster-inference",
        evidenceSummary: `${evidenceList.length}/${sampled.length} sampled manga aligned with this source`,
        requiresInstall: false,
        extensionPkgName: null,
        extensionName: null,
        scoreBreakdown: {
          titleSimilarity: best?.titleSimilarity ?? 0,
          authorSimilarity: best?.authorSimilarity ?? 0,
          artistSimilarity: best?.artistSimilarity ?? 0,
          chapterSimilarity: best?.chapterSimilarity ?? 0,
          slugSimilarity: best?.slugSimilarity ?? 0,
          consistency,
        },
      };
      return candidate;
    })
    .filter((candidate): candidate is ReconciliationCandidate => candidate !== null)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, config.maxRetainedCandidatesPerCluster);

  const supportCounts = new Map<string, number>();
  for (const [sourceId, evidenceList] of sourceEvidence.entries()) {
    supportCounts.set(sourceId, evidenceList.length);
  }

  const autoSelected = chooseAutoCandidate(candidates, supportCounts, config);
  const result: ReconciliationClusterResult = {
    orphanSourceId: cluster.orphanSourceId,
    sourceName: cluster.sourceName,
    sourceLang: cluster.sourceLang,
    status: autoSelected ? "auto_reconciled" : candidates.length ? "needs_review" : "unresolved",
    sampleManga: sampled,
    selectedCandidate: autoSelected,
    candidates,
  };

  clusterCache.set(cacheKey, result);
  return { result, warnings };
}

export async function runReconciliationAnalysis(
  parsedBackup: ParsedBackup,
  installedSources: Source[],
  inventory: SourceInventoryEntry[],
  backupFingerprint: string,
  sourceInventoryFingerprint: string,
  config: ClusterInferenceConfig = DEFAULT_INFERENCE_CONFIG,
): Promise<ReconciliationAnalysis> {
  const warnings: ReconciliationWarning[] = [];
  const clusters = buildOrphanSourceClusters(parsedBackup);
  const { exact, pending } = resolveExactMatches(clusters, inventory);

  const inferenceAbort = AbortSignal.timeout(config.fullInferenceTimeoutMs);
  const inferred: ReconciliationClusterResult[] = [];

  for (const cluster of pending) {
    if (inferenceAbort.aborted) {
      warnings.push({
        kind: "inference_timeout",
        message: "Full inference timeout reached before all orphan clusters could be processed",
      });
      inferred.push({
        orphanSourceId: cluster.orphanSourceId,
        sourceName: cluster.sourceName,
        sourceLang: cluster.sourceLang,
        status: "unresolved",
        sampleManga: sampleRepresentativeManga(cluster, config.maxSampledMangaPerCluster),
        selectedCandidate: null,
        candidates: [],
      });
      continue;
    }

    const { result, warnings: clusterWarnings } = await inferSingleCluster(
      cluster,
      installedSources,
      config,
      backupFingerprint,
      sourceInventoryFingerprint,
      inferenceAbort,
    );
    warnings.push(...clusterWarnings);
    inferred.push(result);
  }

  return {
    backupFingerprint,
    sourceInventoryFingerprint,
    exactMatches: exact,
    autoReconciled: inferred.filter((cluster) => cluster.status === "auto_reconciled"),
    needsReview: inferred.filter((cluster) => cluster.status === "needs_review"),
    unresolved: inferred.filter((cluster) => cluster.status === "unresolved"),
    warnings,
  };
}
