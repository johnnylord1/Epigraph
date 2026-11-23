import { invoke } from "@tauri-apps/api/core";
import { getServerAuthHeader, getServerUrl, gql } from "../client";
import { captureMangaRestoreParity } from "../backup/mangaRestoreParity";
import { encodeMihonImportBackup, type MihonImportWork } from "../backup/mihonBackup";
import { getManagedSourceRuntime } from "../manga/runtime";
import { searchSourcesLive } from "../migration/globalSearch";
import { bestTitleScore, MIN_TITLE_MATCH_SCORE, STRONG_TITLE_MATCH_SCORE } from "../migration/titleMatcher";
import type { NovelRepositoryScopeInput } from "../novels/repositoryState";
import { GET_EXTENSIONS, UPDATE_MANGA, UPDATE_MANGA_CATEGORIES } from "../queries";
import { loadSourceInventory } from "../reconciliation/sourceInventory";
import { GET_CATEGORIES_SUMMARY, UPDATE_EXTENSION } from "../startupQueries";
import type { Category, Extension, Manga } from "../types";
import {
  buildShareManifest,
  decodeShareManifest,
  parseIncomingImportLink,
  sanitizePublicRepoUrl,
  type ShareManifest,
  type ShareManifestSource,
} from "./shareLink";

export type ShareImportExtensionStatus = "installed" | "available" | "needs_repo" | "unavailable";

export interface ShareImportExtensionItem {
  sourceId: string;
  sourceName: string;
  lang: string | null;
  pkgName: string | null;
  extensionName: string | null;
  repoUrl: string | null;
  repoLabel: string | null;
  status: ShareImportExtensionStatus;
  workCount: number;
}

export interface ShareImportAlternativeMatch {
  mangaId: number;
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  thumbnailUrl?: string | null;
  similarity: number;
}

export interface ShareImportLibraryEntry {
  mangaId?: number;
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  thumbnailUrl?: string | null;
}

export interface ShareImportOwnedOtherSource {
  mangaId?: number;
  sourceName: string;
  title: string;
  thumbnailUrl?: string | null;
}

export interface ShareImportWorkRow {
  key: string;
  title: string;
  sourceId: string;
  sourceName: string;
  url: string;
  thumbnailUrl?: string | null;
  existingMangaId?: number | null;
  isLocal: boolean;
  alreadyInLibrary: boolean;
  ownedInOtherSource: ShareImportOwnedOtherSource | null;
  extensionStatus: ShareImportExtensionStatus;
  selected: boolean;
  searching: boolean;
  searchDone: boolean;
  candidates: ShareImportAlternativeMatch[];
  chosenAlternative: ShareImportAlternativeMatch | null;
}

export interface ShareImportInstalledSource {
  id: string;
  name: string;
  displayName: string;
  lang: string;
}

export interface ShareImportPlan {
  manifest: ShareManifest;
  works: ShareImportWorkRow[];
  extensions: ShareImportExtensionItem[];
  installedSources: ShareImportInstalledSource[];
  categories: Category[];
  libraryKeys: Set<string>;
}

const SHARE_MANGA_METADATA_QUERY = `
  query ShareMangaMetadata($ids: [Int!]!) {
    mangas(filter: { id: { in: $ids } }) {
      nodes {
        id
        title
        sourceId
        url
        realUrl
        thumbnailUrl
        source {
          id
          name
          lang
          displayName
          extension {
            pkgName
            name
            lang
          }
        }
      }
    }
  }
`;

const LIBRARY_ENTRIES_QUERY = `
  query ShareImportLibraryEntries($first: Int!, $offset: Int!) {
    mangas(
      condition: { inLibrary: true }
      first: $first
      offset: $offset
    ) {
      pageInfo { hasNextPage }
      nodes {
        id
        title
        sourceId
        url
        thumbnailUrl
        source {
          id
          name
          displayName
        }
      }
    }
  }
`;

const FIND_MANGAS_BY_SOURCES_QUERY = `
  query ShareImportFindMangas($sourceIds: [LongString!]!, $first: Int!, $offset: Int!) {
    mangas(
      filter: { sourceId: { in: $sourceIds } }
      first: $first
      offset: $offset
    ) {
      pageInfo { hasNextPage }
      nodes { id sourceId url inLibrary }
    }
  }
`;

const RESTORE_BACKUP_MUTATION = `
  mutation ShareImportRestoreBackup($backup: Upload!) {
    restoreBackup(input: { backup: $backup }) {
      id
      status { state mangaProgress totalManga }
    }
  }
`;

const RESTORE_STATUS_QUERY = `
  query ShareImportRestoreStatus($id: String!) {
    restoreStatus(id: $id) { state mangaProgress totalManga }
  }
`;

export function workIdentityKey(sourceId: string, url: string): string {
  return `${sourceId}|${url}`;
}

export function formatRepoLabel(repoUrl: string | null | undefined): string | null {
  const safe = sanitizePublicRepoUrl(repoUrl);
  if (!safe) return null;
  try {
    const parsed = new URL(safe);
    if (parsed.hostname === "raw.githubusercontent.com" || parsed.hostname === "github.com") {
      const firstSegment = parsed.pathname.split("/").find(Boolean);
      if (firstSegment) return firstSegment;
    }
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Fetches source-relative URLs and extension/repository hints for selected library mangas
 * so the share link lets receivers identify, install extensions for, and import them.
 */
export async function fetchDesktopShareManifest(
  mangas: readonly Manga[],
  novelScope?: NovelRepositoryScopeInput,
): Promise<ShareManifest> {
  const ids = mangas.map((manga) => manga.id).filter((id) => Number.isInteger(id) && id > 0);
  const needsNovelSites = novelScope && mangas.some((manga) => manga.id < 0 && manga.url && !manga.realUrl && manga.source?.id);
  const novelSites = needsNovelSites
    ? await import("../novels/sources")
      .then(({ loadTrustedInstalledNovelSources }) => loadTrustedInstalledNovelSources(novelScope))
      .then((sources) => new Map(sources.map((source) => [source.pluginId, source.site])))
      .catch(() => new Map<string, string>())
    : new Map<string, string>();
  const byId = new Map<number, {
    sourceId: string | null;
    url: string | null;
    realUrl: string | null;
    thumbnailUrl: string | null;
    sourceName: string | null;
    sourceLang: string | null;
    pkgName: string | null;
  }>();
  const repoByPkg = new Map<string, string>();

  if (ids.length > 0) {
    const [metaResult, extResult] = await Promise.all([
      gql<{
        mangas: {
          nodes: {
            id: number;
            sourceId?: string | null;
            url?: string | null;
            realUrl?: string | null;
            thumbnailUrl?: string | null;
            source?: {
              id: string;
              name: string;
              lang?: string | null;
              displayName?: string | null;
              extension?: { pkgName?: string | null; name?: string | null; lang?: string | null } | null;
            } | null;
          }[];
        };
      }>(SHARE_MANGA_METADATA_QUERY, { ids }).catch(() => null),
      gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS).catch(() => null),
    ]);

    for (const ext of extResult?.extensions?.nodes ?? []) {
      const repo = sanitizePublicRepoUrl(ext.repo);
      if (ext.pkgName && repo && !repoByPkg.has(ext.pkgName)) {
        repoByPkg.set(ext.pkgName, repo);
      }
    }
    for (const node of metaResult?.mangas?.nodes ?? []) {
      byId.set(node.id, {
        sourceId: node.sourceId ?? node.source?.id ?? null,
        url: node.url ?? null,
        realUrl: node.realUrl ?? null,
        thumbnailUrl: node.thumbnailUrl ?? null,
        sourceName: node.source?.displayName ?? node.source?.name ?? null,
        sourceLang: node.source?.lang ?? node.source?.extension?.lang ?? null,
        pkgName: node.source?.extension?.pkgName ?? null,
      });
    }
  }

  return buildShareManifest(
    mangas.map((manga) => {
      const fetched = byId.get(manga.id);
      const sourceId = manga.sourceId ?? manga.source?.id;
      const meta = !sourceId || !fetched?.sourceId || sourceId === fetched.sourceId ? fetched : undefined;
      const pkgName = meta?.pkgName ?? null;
      let webUrl = manga.realUrl || meta?.realUrl;
      const novelSite = manga.id < 0 && manga.source?.id ? novelSites.get(manga.source.id) : undefined;
      if (!webUrl && novelSite && manga.url) {
        try {
          webUrl = new URL(manga.url, novelSite.endsWith("/") ? novelSite : `${novelSite}/`).href;
        } catch {
          // The work stays visible without a link when its source has no valid website.
        }
      }
      return {
        title: manga.title,
        sourceId: meta?.sourceId ?? manga.sourceId ?? manga.source?.id ?? null,
        url: meta?.url ?? manga.url ?? null,
        webUrl,
        coverUrl: meta?.thumbnailUrl ?? manga.thumbnailUrl ?? null,
        sourceName: meta?.sourceName ?? manga.source?.displayName ?? manga.source?.name ?? null,
        sourceLang: meta?.sourceLang ?? manga.source?.lang ?? null,
        extensionPkgName: pkgName,
        repoUrl: pkgName ? (repoByPkg.get(pkgName) ?? null) : null,
        kind: manga.id < 0 ? "book" : "comic",
      };
    }),
  );
}

/** Resolves an incoming `epigraph://import?...` or `https://.../share/#...` link into a manifest. */
export async function resolveIncomingShareManifest(
  rawLink: string,
  fetchHosted: (token: string) => Promise<string> = (token) =>
    invoke<string>("plugin:library-share|fetch_share_payload", { token }),
): Promise<ShareManifest> {
  const parsed = parseIncomingImportLink(rawLink);
  if (!parsed) throw new Error("INVALID_LINK");
  const inlineToken = parsed.kind === "inline" ? parsed.token : await fetchHosted(parsed.token);
  const manifest = decodeShareManifest(inlineToken);
  if (!manifest) throw new Error("INVALID_PAYLOAD");
  return manifest;
}

export interface AnalyzeShareImportDeps {
  loadInventory?: typeof loadSourceInventory;
  loadLibraryKeys?: (sourceIds: string[]) => Promise<Set<string>>;
  loadLibraryEntries?: () => Promise<ShareImportLibraryEntry[]>;
  loadCategories?: () => Promise<Category[]>;
}

async function defaultLoadLibraryEntries(): Promise<ShareImportLibraryEntry[]> {
  const entries: ShareImportLibraryEntry[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const data = await gql<{
      mangas: {
        pageInfo: { hasNextPage: boolean };
        nodes: {
          id: number;
          title: string;
          sourceId: string;
          url: string;
          thumbnailUrl?: string | null;
          source?: { id: string; name?: string | null; displayName?: string | null } | null;
        }[];
      };
    }>(LIBRARY_ENTRIES_QUERY, { first: pageSize, offset });
    for (const node of data.mangas?.nodes ?? []) {
      const sourceId = String(node.sourceId);
      entries.push({
        mangaId: node.id,
        sourceId,
        sourceName: node.source?.displayName ?? node.source?.name ?? (sourceId === "0" ? "Local" : `Source ${sourceId}`),
        url: node.url,
        title: node.title,
        thumbnailUrl: node.thumbnailUrl ?? null,
      });
    }
    if (!data.mangas?.pageInfo?.hasNextPage) break;
  }
  return entries;
}

function findOwnedInOtherSource(
  title: string,
  sourceId: string,
  entries: readonly ShareImportLibraryEntry[],
): ShareImportOwnedOtherSource | null {
  if (!title.trim() || entries.length === 0) return null;
  let best: { entry: ShareImportLibraryEntry; score: number } | null = null;
  for (const entry of entries) {
    if (entry.sourceId === sourceId) continue;
    const score = bestTitleScore(title, entry.title);
    if (score >= STRONG_TITLE_MATCH_SCORE && (!best || score > best.score)) {
      best = { entry, score };
      if (score >= 1) break;
    }
  }
  return best
    ? {
      mangaId: best.entry.mangaId,
      sourceName: best.entry.sourceName,
      title: best.entry.title,
      thumbnailUrl: best.entry.thumbnailUrl ?? null,
    }
    : null;
}

async function defaultLoadCategories(): Promise<Category[]> {
  try {
    const data = await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY);
    return (data.categories?.nodes ?? []).filter((category) => category.id > 0);
  } catch {
    return [];
  }
}

/** Inspects the user's current library and extensions to build an actionable import plan. */
export async function analyzeShareImport(
  manifest: ShareManifest,
  deps: AnalyzeShareImportDeps = {},
): Promise<ShareImportPlan> {
  const loadInventory = deps.loadInventory ?? loadSourceInventory;
  const loadCategories = deps.loadCategories ?? defaultLoadCategories;

  const sourceIds = [...new Set(manifest.sources.map((source) => source.sourceId).filter(Boolean))];
  const [inventoryResult, libraryData, categories] = await Promise.all([
    loadInventory(),
    deps.loadLibraryEntries
      ? deps.loadLibraryEntries().then((entries) => ({
        entries,
        keys: new Set(entries.map((entry) => workIdentityKey(entry.sourceId, entry.url))),
      }))
      : deps.loadLibraryKeys
        ? deps.loadLibraryKeys(sourceIds).then((keys) => ({ entries: [] as ShareImportLibraryEntry[], keys }))
        : defaultLoadLibraryEntries().then((entries) => ({
          entries,
          keys: new Set(entries.map((entry) => workIdentityKey(entry.sourceId, entry.url))),
        })),
    loadCategories(),
  ]);
  const libraryKeys = libraryData.keys;
  const libraryEntries = libraryData.entries;

  const installedBySourceId = new Map<string, ShareImportInstalledSource>();
  const repoEntryBySourceId = new Map<string, { pkgName: string | null; extensionName: string | null }>();
  for (const entry of inventoryResult.inventory) {
    if (entry.kind === "installed") {
      installedBySourceId.set(entry.sourceId, {
        id: entry.sourceId,
        name: entry.name,
        displayName: entry.displayName || entry.name,
        lang: entry.lang,
      });
    } else if (!repoEntryBySourceId.has(entry.sourceId)) {
      repoEntryBySourceId.set(entry.sourceId, {
        pkgName: entry.extensionPkgName ?? null,
        extensionName: entry.extensionName ?? null,
      });
    }
  }

  const availableByPkg = new Map(
    inventoryResult.availableExtensions.map((ext) => [ext.pkgName, ext] as const),
  );
  const availableBySourceId = new Map<string, (typeof inventoryResult.availableExtensions)[number]>();
  for (const ext of inventoryResult.availableExtensions) {
    for (const src of ext.repoSources) {
      if (!availableBySourceId.has(src.sourceId)) availableBySourceId.set(src.sourceId, ext);
    }
  }

  const workCountBySourceId = new Map<string, number>();
  for (const work of manifest.works) {
    if (work.sourceId) {
      workCountBySourceId.set(work.sourceId, (workCountBySourceId.get(work.sourceId) ?? 0) + 1);
    }
  }

  const sourceById = new Map<string, ShareManifestSource>();
  const statusBySourceId = new Map<string, ShareImportExtensionStatus>();
  const extensions: ShareImportExtensionItem[] = [];

  for (const source of manifest.sources) {
    sourceById.set(source.sourceId, source);
    const installed = installedBySourceId.has(source.sourceId);
    const repoMatch = repoEntryBySourceId.get(source.sourceId);
    const availableExt = (source.pkgName ? availableByPkg.get(source.pkgName) : undefined)
      ?? (repoMatch?.pkgName ? availableByPkg.get(repoMatch.pkgName) : undefined)
      ?? availableBySourceId.get(source.sourceId);
    const repoUrl = sanitizePublicRepoUrl(source.repoUrl);

    let status: ShareImportExtensionStatus;
    if (installed || availableExt?.isInstalled) {
      status = "installed";
    } else if (availableExt) {
      status = "available";
    } else if (repoUrl) {
      status = "needs_repo";
    } else {
      status = "unavailable";
    }
    statusBySourceId.set(source.sourceId, status);

    extensions.push({
      sourceId: source.sourceId,
      sourceName: source.name,
      lang: source.lang ?? null,
      pkgName: availableExt?.pkgName ?? source.pkgName ?? repoMatch?.pkgName ?? null,
      extensionName: availableExt?.name ?? repoMatch?.extensionName ?? source.name,
      repoUrl,
      repoLabel: formatRepoLabel(repoUrl),
      status,
      workCount: workCountBySourceId.get(source.sourceId) ?? 0,
    });
  }

  const libraryEntryByKey = new Map(
    libraryEntries.map((entry) => [workIdentityKey(entry.sourceId, entry.url), entry] as const),
  );
  const works: ShareImportWorkRow[] = manifest.works.map((work, index) => {
    const isLocal = !work.sourceId || !work.url;
    const exactEntry = !isLocal ? libraryEntryByKey.get(workIdentityKey(work.sourceId, work.url)) : undefined;
    const alreadyInLibrary = !isLocal && libraryKeys.has(workIdentityKey(work.sourceId, work.url));
    const ownedInOtherSource = !isLocal && !alreadyInLibrary
      ? findOwnedInOtherSource(work.title, work.sourceId, libraryEntries)
      : null;
    const extensionStatus: ShareImportExtensionStatus = isLocal
      ? "unavailable"
      : (statusBySourceId.get(work.sourceId) ?? "unavailable");
    const sourceName = isLocal
      ? "Local"
      : (sourceById.get(work.sourceId)?.name ?? `Source ${work.sourceId}`);
    return {
      key: `${index}:${work.sourceId}:${work.url}:${work.title}`,
      title: work.title,
      sourceId: work.sourceId,
      sourceName,
      url: work.url,
      thumbnailUrl: exactEntry?.thumbnailUrl ?? null,
      existingMangaId: exactEntry?.mangaId ?? null,
      isLocal,
      alreadyInLibrary,
      ownedInOtherSource,
      extensionStatus,
      selected: !isLocal && !alreadyInLibrary && !ownedInOtherSource && extensionStatus === "installed",
      searching: false,
      searchDone: false,
      candidates: [],
      chosenAlternative: null,
    };
  });

  const installedSources = [...installedBySourceId.values()]
    .filter((source) => source.id !== "0")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    manifest,
    works,
    extensions,
    installedSources,
    categories,
    libraryKeys,
  };
}

/**
 * Installs a missing extension, automatically adding its repository first when the share
 * manifest included one (`needs_repo`).
 */
export async function installShareImportExtension(
  ext: ShareImportExtensionItem,
  deps: {
    addStore?: (indexUrl: string) => Promise<unknown>;
    loadInventory?: typeof loadSourceInventory;
    installByPkg?: (pkgName: string) => Promise<unknown>;
  } = {},
): Promise<{ installed: boolean; pkgName: string | null }> {
  const loadInventory = deps.loadInventory ?? loadSourceInventory;
  const installByPkg = deps.installByPkg ?? (async (pkgName: string) => {
    await gql(UPDATE_EXTENSION, { id: pkgName, install: true });
  });

  if (ext.status === "needs_repo" && ext.repoUrl) {
    const addStore = deps.addStore ?? (async (indexUrl: string) => {
      const runtime = await getManagedSourceRuntime();
      await runtime.addStore({ indexUrl });
    });
    await addStore(ext.repoUrl);
  }

  let pkgName = ext.pkgName;
  if (!pkgName || ext.status === "needs_repo") {
    const fresh = await loadInventory();
    const matched = (pkgName ? fresh.availableExtensions.find((item) => item.pkgName === pkgName) : undefined)
      ?? fresh.availableExtensions.find((item) => item.repoSources.some((src) => src.sourceId === ext.sourceId))
      ?? fresh.availableExtensions.find((item) => item.name.toLowerCase() === ext.sourceName.toLowerCase());
    if (matched?.isInstalled) {
      return { installed: true, pkgName: matched.pkgName };
    }
    pkgName = matched?.pkgName ?? pkgName;
  }

  if (!pkgName) {
    return { installed: false, pkgName: null };
  }

  await installByPkg(pkgName);
  return { installed: true, pkgName };
}

/** Searches all currently installed sources for a single shared work, returning ranked matches. */
export async function searchWorkInInstalledSources(
  title: string,
  installedSources: readonly ShareImportInstalledSource[],
  options: {
    signal?: AbortSignal;
    search?: Parameters<typeof searchSourcesLive>[0]["search"];
  } = {},
): Promise<ShareImportAlternativeMatch[]> {
  if (installedSources.length === 0 || !title.trim()) return [];
  const sourceById = new Map(installedSources.map((src) => [src.id, src] as const));
  const collected: ShareImportAlternativeMatch[] = [];
  const seen = new Set<string>();

  await searchSourcesLive({
    sourceIds: installedSources.map((src) => src.id),
    query: title,
    title,
    concurrency: 4,
    timeoutMs: 12000,
    signal: options.signal,
    search: options.search,
    onSourceDone(sourceId, outcome) {
      const source = sourceById.get(sourceId);
      const sourceName = source?.displayName ?? source?.name ?? `Source ${sourceId}`;
      for (const item of outcome.results.filter(({ manga }) => !manga.inLibrary).slice(0, 3)) {
        if (item.similarity < MIN_TITLE_MATCH_SCORE) continue;
        const dedupeKey = `${sourceId}:${item.manga.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        collected.push({
          mangaId: item.manga.id,
          sourceId,
          sourceName,
          url: (item.manga as Manga & { url?: string }).url ?? "",
          title: item.manga.title,
          thumbnailUrl: item.manga.thumbnailUrl ?? null,
          similarity: item.similarity,
        });
      }
    },
  });

  return collected.sort((left, right) => right.similarity - left.similarity);
}

/** Searches installed sources for every work whose original extension is missing (2 at a time). */
export async function searchAllMissingWorksInInstalledSources(
  works: readonly ShareImportWorkRow[],
  installedSources: readonly ShareImportInstalledSource[],
  onWorkResult: (workKey: string, state: { searching: boolean; candidates?: ShareImportAlternativeMatch[] }) => void,
  options: {
    signal?: AbortSignal;
    search?: Parameters<typeof searchSourcesLive>[0]["search"];
  } = {},
): Promise<void> {
  const queue = works.filter(
    (work) => !work.isLocal && !work.alreadyInLibrary && !work.ownedInOtherSource && work.extensionStatus !== "installed" && !work.chosenAlternative && !work.searching,
  );
  if (queue.length === 0 || installedSources.length === 0) return;

  let index = 0;
  async function worker() {
    while (index < queue.length && !options.signal?.aborted) {
      const work = queue[index]!;
      index += 1;
      onWorkResult(work.key, { searching: true });
      const candidates = await searchWorkInInstalledSources(work.title, installedSources, options);
      if (options.signal?.aborted) return;
      onWorkResult(work.key, { searching: false, candidates });
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
}

async function submitBackupBufferToSuwayomi(buffer: ArrayBuffer): Promise<void> {
  const url = `${getServerUrl()}/api/graphql`;
  const authorization = getServerAuthHeader();
  const file = new File([buffer], "epigraph-share-import.proto.gz", { type: "application/octet-stream" });
  const form = new FormData();
  form.append("operations", JSON.stringify({ query: RESTORE_BACKUP_MUTATION, variables: { backup: null } }));
  form.append("map", JSON.stringify({ "0": ["variables.backup"] }));
  form.append("0", file);

  const response = await fetch(url, {
    method: "POST",
    body: form,
    headers: authorization ? { Authorization: authorization } : undefined,
  });
  if (!response.ok) throw new Error(`Restore HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.errors?.length || !payload?.data?.restoreBackup?.id) {
    throw new Error(payload?.errors?.[0]?.message ?? "Restore failed");
  }
  const restoreId: string = payload.data.restoreBackup.id;
  let state: string = payload.data.restoreBackup.status?.state ?? "PROCESSING";

  for (let attempt = 0; attempt < 90 && (state === "IDLE" || state === "PROCESSING"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const statusData = await gql<{ restoreStatus: { state: string } | null }>(RESTORE_STATUS_QUERY, { id: restoreId });
    state = statusData.restoreStatus?.state ?? "SUCCESS";
  }
  if (state === "FAILURE") {
    throw new Error("Suwayomi backup restore failed");
  }
}

/**
 * Adds the selected works to Suwayomi's library using existing Epigraph/Suwayomi flows:
 * - Works resolved from installed sources via search already have a Suwayomi ID -> `UPDATE_MANGA`.
 * - Works from their original source -> `encodeMihonImportBackup` + `captureMangaRestoreParity` + `RESTORE_BACKUP`.
 * Optionally adds each imported work to the selected categories.
 */
export async function applyShareImport(
  works: readonly ShareImportWorkRow[],
  targetCategoryIds: readonly number[],
  deps: {
    updateManga?: (id: number, inLibrary: boolean) => Promise<unknown>;
    restoreBackup?: (buffer: ArrayBuffer) => Promise<void>;
    request?: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
  } = {},
): Promise<{ added: number }> {
  const request = deps.request ?? gql;
  const updateManga = deps.updateManga ?? ((id: number, inLibrary: boolean) => request(UPDATE_MANGA, { id, inLibrary }));
  const restoreBackup = deps.restoreBackup ?? submitBackupBufferToSuwayomi;
  const categoryIds = [...new Set(targetCategoryIds.filter((id) => Number.isInteger(id) && id > 0))];

  const chosen = works.filter(
    (work) => work.selected && !work.isLocal && !work.alreadyInLibrary
      && (work.extensionStatus === "installed" || work.chosenAlternative !== null),
  );
  if (chosen.length === 0) return { added: 0 };

  const viaAlternative = chosen.filter((work) => work.chosenAlternative !== null);
  const viaOriginal = chosen.filter((work) => work.chosenAlternative === null && work.extensionStatus === "installed");
  const addedMangaIds: number[] = [];

  for (const work of viaAlternative) {
    const match = work.chosenAlternative!;
    await updateManga(match.mangaId, true);
    addedMangaIds.push(match.mangaId);
  }

  if (viaOriginal.length > 0) {
    const now = Date.now();
    const importWorks: MihonImportWork[] = viaOriginal.map((work) => ({
      sourceId: work.sourceId,
      url: work.url,
      title: work.title,
      genre: [],
      dateAdded: now,
      chapters: [],
    }));
    const applyParity = await captureMangaRestoreParity(
      importWorks.map((work) => ({ sourceId: work.sourceId, url: work.url, hasCategories: false })),
      request,
    );
    const buffer = encodeMihonImportBackup(importWorks);
    await restoreBackup(buffer);
    await applyParity();

    if (categoryIds.length > 0) {
      const targetKeys = new Set(viaOriginal.map((work) => workIdentityKey(work.sourceId, work.url)));
      const sourceIds = [...new Set(viaOriginal.map((work) => work.sourceId))];
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const result = await request<{
          mangas: { pageInfo: { hasNextPage: boolean }; nodes: { id: number; sourceId: string; url: string }[] };
        }>(FIND_MANGAS_BY_SOURCES_QUERY, { sourceIds, first: pageSize, offset });
        for (const node of result.mangas?.nodes ?? []) {
          if (targetKeys.has(workIdentityKey(String(node.sourceId), node.url))) {
            addedMangaIds.push(node.id);
          }
        }
        if (!result.mangas?.pageInfo?.hasNextPage) break;
      }
    }
  }

  if (categoryIds.length > 0) {
    for (const mangaId of new Set(addedMangaIds)) {
      await request(UPDATE_MANGA_CATEGORIES, { mangaId, addTo: categoryIds, removeFrom: [] });
    }
  }

  return { added: chosen.length };
}
