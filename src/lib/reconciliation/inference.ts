import { gql } from "../client";
import { GET_CHAPTERS } from "../queries";
import type { Manga } from "../types";
import { fetchSourceMangaDetails } from "../manga/runtime";
import { DEFAULT_CLUSTER_INFERENCE_CONFIG } from "./constants";
import { diceCoefficient, extractSlug, normalizeText, safeNumberSimilarity, tokenize } from "./text";
import type {
  ClusterInferenceConfig,
  OrphanSourceCluster,
  ParsedBackupManga,
  ReconciliationCandidate,
  ReconciliationClusterResult,
  ReconciliationWarning,
  SourceInventoryEntry,
} from "./types";
import { fetchSourceMangaSearchWithFallback } from "../manga/sourceSearch";

type SearchResult = {
  manga: Manga;
  titleSimilarity: number;
};

type CandidateAccumulator = {
  entry: SourceInventoryEntry;
  titleSimilarity: number[];
  authorSimilarity: number[];
  artistSimilarity: number[];
  chapterSimilarity: number[];
  slugSimilarity: number[];
  supportingTitles: string[];
};

const searchCache = new Map<string, SearchResult[]>();
const clusterCache = new Map<string, ReconciliationClusterResult>();

function metadataRichnessScore(manga: ParsedBackupManga): number {
  const titleTokens = tokenize(manga.title).length;
  const author = manga.author ? 1 : 0;
  const artist = manga.artist ? 1 : 0;
  const slug = extractSlug(manga.url) ? 1 : 0;
  const chapters = manga.chapterCount && manga.chapterCount > 0 ? 1 : 0;
  return titleTokens * 2 + author + artist + slug + chapters;
}

export function rankRepresentativeManga(mangas: ParsedBackupManga[]): ParsedBackupManga[] {
  return [...mangas].sort((left, right) => {
    const delta = metadataRichnessScore(right) - metadataRichnessScore(left);
    if (delta !== 0) return delta;
    return normalizeText(right.title).length - normalizeText(left.title).length;
  });
}

function withTimeout<T>(promiseFactory: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promiseFactory(controller.signal)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function searchSource(
  source: SourceInventoryEntry,
  title: string,
  config: ClusterInferenceConfig,
): Promise<SearchResult[]> {
  const cacheKey = `${source.sourceId}:${normalizeText(title)}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const mangas = await withTimeout(
    (signal) =>
      fetchSourceMangaSearchWithFallback({
        sourceId: source.sourceId,
        query: title,
        signal,
      }),
    config.requestTimeoutMs,
  );

  const ranked = (mangas ?? [])
    .map((manga) => ({
      manga,
      titleSimilarity: diceCoefficient(title, manga.title),
    }))
    .filter((candidate) => candidate.titleSimilarity > 0.4)
    .sort((left, right) => right.titleSimilarity - left.titleSimilarity)
    .slice(0, config.maxCandidatesPerMangaSearch);

  searchCache.set(cacheKey, ranked);
  return ranked;
}

async function fetchSearchEvidence(
  source: SourceInventoryEntry,
  backupManga: ParsedBackupManga,
  result: SearchResult,
  config: ClusterInferenceConfig,
): Promise<{
  authorSimilarity: number;
  artistSimilarity: number;
  chapterSimilarity: number;
  slugSimilarity: number;
}> {
  const mangaId = result.manga.id;
  const [detail, chapters] = await Promise.all([
    withTimeout(
      (signal) => fetchSourceMangaDetails({ id: mangaId, sourceId: result.manga.source?.id }, signal),
      config.requestTimeoutMs,
    ),
    withTimeout(
      (signal) => gql<{ chapters: { nodes: { id: number }[] } }>(GET_CHAPTERS, { mangaId }, signal),
      config.requestTimeoutMs,
    ),
  ]);

  return {
    authorSimilarity: diceCoefficient(backupManga.author, detail.fetchManga.manga.author ?? null),
    artistSimilarity: diceCoefficient(backupManga.artist, detail.fetchManga.manga.artist ?? null),
    chapterSimilarity: safeNumberSimilarity(backupManga.chapterCount, chapters.chapters.nodes?.length ?? null),
    slugSimilarity: diceCoefficient(extractSlug(backupManga.url), extractSlug(detail.fetchManga.manga.realUrl ?? "")),
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function scoreClusterCandidates(accumulators: CandidateAccumulator[]): ReconciliationCandidate[] {
  return accumulators
    .map((accumulator) => {
      const titleSimilarity = average(accumulator.titleSimilarity);
      const authorSimilarity = average(accumulator.authorSimilarity);
      const artistSimilarity = average(accumulator.artistSimilarity);
      const chapterSimilarity = average(accumulator.chapterSimilarity);
      const slugSimilarity = average(accumulator.slugSimilarity);
      const consistency = Math.min(1, accumulator.supportingTitles.length / Math.max(1, accumulator.titleSimilarity.length));
      const confidence = (titleSimilarity * 0.46)
        + (authorSimilarity * 0.14)
        + (artistSimilarity * 0.1)
        + (chapterSimilarity * 0.12)
        + (slugSimilarity * 0.08)
        + (consistency * 0.1);

      return {
        sourceId: accumulator.entry.sourceId,
        sourceName: accumulator.entry.name,
        sourceLang: accumulator.entry.lang,
        displayName: accumulator.entry.displayName,
        confidence,
        reasonCode: "cluster-inference" as const,
        evidenceSummary: `${accumulator.supportingTitles.length} sampled manga pointed to ${accumulator.entry.displayName}.`,
        requiresInstall: !accumulator.entry.extensionInstalled && accumulator.entry.kind === "repo",
        extensionPkgName: accumulator.entry.extensionPkgName,
        extensionName: accumulator.entry.extensionName,
        scoreBreakdown: {
          titleSimilarity,
          authorSimilarity,
          artistSimilarity,
          chapterSimilarity,
          slugSimilarity,
          consistency,
        },
      };
    })
    .sort((left, right) => right.confidence - left.confidence);
}

export function shouldAutoSelectCandidate(
  candidates: ReconciliationCandidate[],
  sampledCount: number,
  config: ClusterInferenceConfig = DEFAULT_CLUSTER_INFERENCE_CONFIG,
): ReconciliationCandidate | null {
  const top = candidates[0] ?? null;
  const second = candidates[1] ?? null;
  const consistentMatches = top ? top.scoreBreakdown?.consistency ?? 0 : 0;
  const margin = top && second ? top.confidence - second.confidence : top?.confidence ?? 0;
  const enoughConsistency = sampledCount < 2 || consistentMatches >= (config.minConsistentMatchesForAutoSelect / sampledCount);
  return top
    && top.confidence >= config.highConfidenceThreshold
    && margin >= config.minTopVsSecondMargin
    && enoughConsistency
      ? top
      : null;
}

function clusterCacheKey(
  backupFingerprint: string,
  sourceInventoryFingerprint: string,
  cluster: OrphanSourceCluster,
): string {
  return `${backupFingerprint}:${sourceInventoryFingerprint}:${cluster.orphanSourceId}`;
}

function candidatePool(
  inventory: SourceInventoryEntry[],
  cluster: OrphanSourceCluster,
): SourceInventoryEntry[] {
  const installed = inventory.filter((entry) => entry.kind === "installed");
  if (cluster.sourceLang) {
    const sameLang = installed.filter((entry) => entry.lang === cluster.sourceLang);
    if (sameLang.length > 0) return sameLang;
  }
  return installed;
}

export async function inferClusterCandidate(
  cluster: OrphanSourceCluster,
  inventory: SourceInventoryEntry[],
  backupFingerprint: string,
  sourceInventoryFingerprint: string,
  config: ClusterInferenceConfig = DEFAULT_CLUSTER_INFERENCE_CONFIG,
): Promise<{ result: ReconciliationClusterResult; warnings: ReconciliationWarning[] }> {
  const cacheKey = clusterCacheKey(backupFingerprint, sourceInventoryFingerprint, cluster);
  const cached = clusterCache.get(cacheKey);
  if (cached) return { result: cached, warnings: [] };

  const warnings: ReconciliationWarning[] = [];
  const sampled = rankRepresentativeManga(cluster.mangas).slice(0, config.maxSampledMangaPerCluster);
  const accumulators = new Map<string, CandidateAccumulator>();
  const startedAt = Date.now();
  let searchErrors = 0;

  const sources = candidatePool(inventory, cluster);

  for (const manga of sampled) {
    if (Date.now() - startedAt > config.clusterTimeoutMs) {
      warnings.push({
        kind: "inference_timeout",
        message: `Inference timed out for source ${cluster.sourceName}.`,
        details: cluster.orphanSourceId,
      });
      break;
    }

    for (const source of sources) {
      if (Date.now() - startedAt > config.clusterTimeoutMs) break;
      if (searchErrors >= config.maxClusterSearchErrors) break;

      try {
        const searchResults = await searchSource(source, manga.title, config);
        const top = searchResults[0];
        if (!top) continue;
        const evidence = await fetchSearchEvidence(source, manga, top, config);
        const key = `${source.sourceId}`;
        const accumulator = accumulators.get(key) ?? {
          entry: source,
          titleSimilarity: [],
          authorSimilarity: [],
          artistSimilarity: [],
          chapterSimilarity: [],
          slugSimilarity: [],
          supportingTitles: [],
        };
        accumulator.titleSimilarity.push(top.titleSimilarity);
        accumulator.authorSimilarity.push(evidence.authorSimilarity);
        accumulator.artistSimilarity.push(evidence.artistSimilarity);
        accumulator.chapterSimilarity.push(evidence.chapterSimilarity);
        accumulator.slugSimilarity.push(evidence.slugSimilarity);
        accumulator.supportingTitles.push(manga.title);
        accumulators.set(key, accumulator);
      } catch {
        searchErrors += 1;
      }
    }
  }

  if (searchErrors >= config.maxClusterSearchErrors) {
    warnings.push({
      kind: "cluster_inference_failed",
      message: `Inference stopped early for ${cluster.sourceName} after repeated source-search failures.`,
      details: cluster.orphanSourceId,
    });
  }

  const candidates = scoreClusterCandidates([...accumulators.values()]).slice(0, config.maxRetainedCandidatesPerCluster);
  const selectedCandidate = shouldAutoSelectCandidate(candidates, sampled.length, config);

  const result: ReconciliationClusterResult = {
    orphanSourceId: cluster.orphanSourceId,
    sourceName: cluster.sourceName,
    sourceLang: cluster.sourceLang,
    status: selectedCandidate ? "auto_reconciled" : candidates.length > 0 ? "needs_review" : "unresolved",
    sampleManga: sampled,
    selectedCandidate,
    candidates,
  };

  clusterCache.set(cacheKey, result);
  return { result, warnings };
}

export async function inferClusters(
  clusters: OrphanSourceCluster[],
  inventory: SourceInventoryEntry[],
  backupFingerprint: string,
  sourceInventoryFingerprint: string,
  config: ClusterInferenceConfig = DEFAULT_CLUSTER_INFERENCE_CONFIG,
): Promise<{ results: ReconciliationClusterResult[]; warnings: ReconciliationWarning[] }> {
  const startedAt = Date.now();
  const results: ReconciliationClusterResult[] = [];
  const warnings: ReconciliationWarning[] = [];

  for (const cluster of clusters) {
    if (Date.now() - startedAt > config.fullInferenceTimeoutMs) {
      warnings.push({
        kind: "inference_timeout",
        message: "Stopped inference early after reaching the full restore-analysis time limit.",
      });
      break;
    }
    const { result, warnings: clusterWarnings } = await inferClusterCandidate(
      cluster,
      inventory,
      backupFingerprint,
      sourceInventoryFingerprint,
      config,
    );
    results.push(result);
    warnings.push(...clusterWarnings);
  }

  return { results, warnings };
}
