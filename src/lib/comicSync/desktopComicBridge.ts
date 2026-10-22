import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { gql, gqlUpload } from "../client";
import { encodeMihonImportBackup, type MihonImportWork } from "../backup/mihonBackup";
import { extensionStoreIndexCandidates, extensionStoreKey } from "../manga/runtime/storeUrl";
import { fetchSourceMangaChapters } from "../manga/runtime/sourceOperations";
import { GET_SETTINGS, legacyExtensionRepos, type LegacyRepoSettings } from "../queries";
import { bumpContentSetupVersion, store } from "../../store/state.svelte";
import {
  batchChapterUpdates,
  comicKey,
  emptyBaseline,
  mergeAssignments,
  parseBaseline,
  planCategories,
  planChapters,
  planLibrary,
  type ChapterProgressBatch,
  type ChapterTriple,
  type ChapterUpdate,
  type ComicChapterState,
  type ComicKey,
  type ComicSyncBaseline,
  type ComicWork,
} from "./plan";

/**
 * Keeps the comics of a profile joined to another desktop the same on both. The host desktop's Core
 * shares its Suwayomi with this one, but nothing writes the other way or into this desktop's own
 * Suwayomi, so this window reconciles both libraries: works, categories, chapter progress,
 * extension repositories and extensions.
 */

/** The window's own reconciliations, so open pages reload what changed under them. */
export const COMIC_LIBRARY_RECONCILED_EVENT = "epigraph-comic-library-reconciled";
/** This window changed comics; the other computer gets them on the next run. */
export const COMIC_LOCAL_EDIT_EVENT = "epigraph-comic-local-edit";

const LIBRARY_PAGE_SIZE = 200;
const CHAPTER_PAGE_SIZE = 500;
const WORKS_PER_CHAPTER_READ = 20;
/** Works whose chapters are compared in one run; the rest wait for the next. */
const MAX_CHAPTER_WORKS_PER_RUN = 120;
/** Works whose digest did not change are still compared this often. */
const FULL_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * A work or extension that could not be found on one side is looked for again after this, then
 * after twice as long each time, so sources are not searched over and over for it.
 */
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
const MAX_RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;
export const COMIC_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const COMIC_SYNC_DEBOUNCE_MS = 4_000;
/** Sources searched at the same time while bringing works in; each source sees one search at a time. */
const PARALLEL_SOURCES = 4;
/** Works read for bringing in at once, and restored at once; the Core takes at most 25. */
const WORKS_PER_DETAILS_READ = 20;
const MAX_IMPORT_WORKS = 25;
/** Below the Core's 2 MB request limit. */
const MAX_IMPORT_BYTES = 900_000;
const IMPORT_POLL_MS = 500;
const IMPORT_TIMEOUT_MS = 180_000;

const LIBRARY_QUERY = `
  query EpigraphComicSyncLibrary($first: Int!, $offset: Int!) {
    mangas(condition: { inLibrary: true }, orderBy: ID, orderByType: ASC, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes {
        id
        sourceId
        url
        title
        unreadCount
        bookmarkCount
        chapters { totalCount }
        latestReadChapter { id isRead isBookmarked lastPageRead }
        categories { nodes { id name } }
      }
    }
  }
`;

const CATEGORIES_QUERY = `
  query EpigraphComicSyncCategories {
    categories { nodes { id name } }
  }
`;

const CHAPTERS_QUERY = `
  query EpigraphComicSyncChapters($mangaIds: [Int!]!, $first: Int!, $offset: Int!) {
    chapters(filter: { mangaId: { in: $mangaIds } }, orderBy: ID, orderByType: ASC, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id mangaId url isRead isBookmarked lastPageRead lastReadAt }
    }
  }
`;

const REMOTE_INSTALLED_QUERY = `
  query EpigraphComicSyncExtensions {
    extensions(condition: { isInstalled: true }) { nodes { pkgName } }
  }
`;

const REMOTE_STORES_QUERY = `
  query EpigraphComicSyncStores {
    extensionStores { nodes { indexUrl } }
  }
`;

const WORK_DETAILS_QUERY = `
  query EpigraphComicSyncWorkDetails($ids: [Int!]!) {
    mangas(filter: { id: { in: $ids } }) {
      nodes {
        id
        sourceId
        url
        title
        author
        artist
        genre
        status
        inLibraryAt
        chapters {
          nodes { url name scanlator isRead isBookmarked lastPageRead fetchedAt uploadDate chapterNumber sourceOrder }
        }
      }
    }
  }
`;

const LOCAL_IMPORT_MUTATION = `
  mutation EpigraphComicSyncImport($backup: Upload!) {
    restoreBackup(input: {
      backup: $backup
      flags: {
        includeManga: true
        includeChapters: true
        includeCategories: false
        includeHistory: false
        includeTracking: false
        includeServerSettings: false
        includeClientData: false
      }
    }) {
      id
      status { state }
    }
  }
`;

const LOCAL_IMPORT_STATUS_QUERY = `
  query EpigraphComicSyncImportStatus($id: String!) {
    restoreStatus(id: $id) { state }
  }
`;

const LOCAL_LOOKUP_QUERY = `
  query EpigraphComicSyncLookup($sourceId: LongString!, $url: String!) {
    mangas(condition: { sourceId: $sourceId, url: $url }, first: 2) { nodes { id url } }
  }
`;

const LOCAL_SEARCH_MUTATION = `
  mutation EpigraphComicSyncSearch($source: LongString!, $query: String!) {
    fetchSourceManga(input: { source: $source, type: SEARCH, query: $query, page: 1 }) { mangas { id url } }
  }
`;

const LOCAL_UPDATE_MANGA_MUTATION = `
  mutation EpigraphComicSyncUpdateManga($id: Int!, $inLibrary: Boolean) {
    updateManga(input: { id: $id, patch: { inLibrary: $inLibrary } }) { manga { id inLibrary } }
  }
`;

const LOCAL_UPDATE_CHAPTERS_MUTATION = `
  mutation EpigraphComicSyncUpdateChapters($ids: [Int!]!, $isRead: Boolean, $isBookmarked: Boolean, $lastPageRead: Int) {
    updateChapters(input: { ids: $ids, patch: { isRead: $isRead, isBookmarked: $isBookmarked, lastPageRead: $lastPageRead } }) {
      chapters { id }
    }
  }
`;

const LOCAL_CREATE_CATEGORY_MUTATION = `
  mutation EpigraphComicSyncCreateCategory($name: String!) {
    createCategory(input: { name: $name }) { category { id name } }
  }
`;

const LOCAL_DELETE_CATEGORY_MUTATION = `
  mutation EpigraphComicSyncDeleteCategory($id: Int!) {
    deleteCategory(input: { categoryId: $id }) { category { id } }
  }
`;

const LOCAL_UPDATE_MANGA_CATEGORIES_MUTATION = `
  mutation EpigraphComicSyncMangaCategories($mangaId: Int!, $addTo: [Int!]!, $removeFrom: [Int!]!) {
    updateMangaCategories(input: { id: $mangaId, patch: { addToCategories: $addTo, removeFromCategories: $removeFrom } }) {
      manga { id }
    }
  }
`;

interface LibraryNode {
  id: number;
  sourceId: string;
  url: string;
  title: string;
  unreadCount?: number | null;
  bookmarkCount?: number | null;
  chapters?: { totalCount?: number | null } | null;
  latestReadChapter?: { id: number; isRead: boolean; isBookmarked: boolean; lastPageRead: number } | null;
  categories?: { nodes?: { id: number; name: string }[] | null } | null;
}

interface WorkDetailsNode {
  id: number;
  sourceId: string;
  url: string;
  title: string;
  author?: string | null;
  artist?: string | null;
  genre?: string[] | null;
  status?: string | null;
  /** Seconds since the epoch. */
  inLibraryAt?: string | number | null;
  chapters?: {
    nodes?: {
      url: string;
      name: string;
      scanlator?: string | null;
      isRead: boolean;
      isBookmarked: boolean;
      lastPageRead?: number | null;
      /** Seconds since the epoch. */
      fetchedAt?: string | number | null;
      /** Milliseconds since the epoch. */
      uploadDate?: string | number | null;
      chapterNumber?: number | null;
      sourceOrder?: number | null;
    }[] | null;
  } | null;
}

interface ChapterNode {
  id: number;
  mangaId: number;
  url: string;
  isRead: boolean;
  isBookmarked: boolean;
  lastPageRead: number;
  lastReadAt: string | number | null;
}

/** One desktop's Suwayomi, read and written the same way whichever side it is. */
interface ComicSide {
  name: "local" | "remote";
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  setInLibrary(id: number, inLibrary: boolean): Promise<void>;
  /** The work's id here, fetching it from its source when needed; null when it cannot be found. */
  resolve(work: ComicWork): Promise<number | null>;
  /**
   * Puts the works and their chapters in this library without asking their sources; false when
   * this side cannot.
   */
  importWorks(works: MihonImportWork[]): Promise<boolean>;
  fetchChapters(mangaId: number): Promise<void>;
  createCategory(name: string): Promise<void>;
  deleteCategory(id: number): Promise<void>;
  updateMangaCategories(mangaId: number, addTo: number[], removeFrom: number[]): Promise<void>;
  updateChapters(batch: ChapterProgressBatch): Promise<void>;
}

interface SideLibrary {
  works: Map<ComicKey, ComicWork>;
  ids: Map<number, ComicKey>;
}

export function workDigest(node: LibraryNode): string {
  const latest = node.latestReadChapter;
  return [
    node.unreadCount ?? 0,
    node.bookmarkCount ?? 0,
    node.chapters?.totalCount ?? 0,
    latest ? `${latest.id}:${latest.isRead ? 1 : 0}:${latest.isBookmarked ? 1 : 0}:${latest.lastPageRead}` : "-",
  ].join("/");
}

async function readLibrary(side: ComicSide): Promise<SideLibrary> {
  const works = new Map<ComicKey, ComicWork>();
  const ids = new Map<number, ComicKey>();
  for (let offset = 0; ; offset += LIBRARY_PAGE_SIZE) {
    const data = await side.query<{ mangas: { pageInfo: { hasNextPage: boolean }; nodes: LibraryNode[] } }>(
      LIBRARY_QUERY,
      { first: LIBRARY_PAGE_SIZE, offset },
    );
    for (const node of data.mangas.nodes) {
      const key = comicKey(String(node.sourceId), node.url);
      works.set(key, {
        id: node.id,
        sourceId: String(node.sourceId),
        url: node.url,
        title: node.title,
        categories: (node.categories?.nodes ?? []).filter((category) => category.id !== 0).map((category) => category.name),
        digest: workDigest(node),
      });
      ids.set(node.id, key);
    }
    if (!data.mangas.pageInfo.hasNextPage || data.mangas.nodes.length === 0) break;
  }
  return { works, ids };
}

async function readCategories(side: ComicSide): Promise<Map<string, number>> {
  const data = await side.query<{ categories: { nodes: { id: number; name: string }[] } }>(CATEGORIES_QUERY);
  return new Map(data.categories.nodes.filter((category) => category.id !== 0).map((category) => [category.name, category.id]));
}

async function readChapters(side: ComicSide, mangaIds: number[]): Promise<Map<number, Map<string, ComicChapterState>>> {
  const byWork = new Map<number, Map<string, ComicChapterState>>(mangaIds.map((id) => [id, new Map()]));
  for (let start = 0; start < mangaIds.length; start += WORKS_PER_CHAPTER_READ) {
    const chunk = mangaIds.slice(start, start + WORKS_PER_CHAPTER_READ);
    for (let offset = 0; ; offset += CHAPTER_PAGE_SIZE) {
      const data = await side.query<{ chapters: { pageInfo: { hasNextPage: boolean }; nodes: ChapterNode[] } }>(
        CHAPTERS_QUERY,
        { mangaIds: chunk, first: CHAPTER_PAGE_SIZE, offset },
      );
      for (const node of data.chapters.nodes) {
        byWork.get(node.mangaId)?.set(node.url, {
          id: node.id,
          isRead: node.isRead,
          isBookmarked: node.isBookmarked,
          lastPageRead: node.lastPageRead ?? 0,
          lastReadAt: Number(node.lastReadAt ?? 0) || 0,
        });
      }
      if (!data.chapters.pageInfo.hasNextPage || data.chapters.nodes.length === 0) break;
    }
  }
  return byWork;
}

function toImportWork(node: WorkDetailsNode): MihonImportWork {
  const ms = (value: string | number | null | undefined) => Number(value ?? 0) || 0;
  return {
    sourceId: String(node.sourceId),
    url: node.url,
    title: node.title.trim() || node.url,
    author: node.author ?? null,
    artist: node.artist ?? null,
    genre: (node.genre ?? []).filter((genre) => typeof genre === "string" && genre.length > 0),
    status: node.status ?? null,
    dateAdded: ms(node.inLibraryAt) * 1000,
    chapters: (node.chapters?.nodes ?? []).map((chapter) => ({
      url: chapter.url,
      name: chapter.name ?? "",
      scanlator: chapter.scanlator ?? null,
      isRead: chapter.isRead,
      isBookmarked: chapter.isBookmarked,
      lastPageRead: Math.max(0, Math.trunc(chapter.lastPageRead ?? 0)),
      fetchedAt: ms(chapter.fetchedAt) * 1000,
      uploadDate: ms(chapter.uploadDate),
      chapterNumber: Number.isFinite(chapter.chapterNumber) ? chapter.chapterNumber! : 0,
      sourceOrder: Math.max(0, Math.trunc(chapter.sourceOrder ?? 0)),
    })),
  };
}

async function readWorkDetails(side: ComicSide, ids: number[]): Promise<Map<number, MihonImportWork>> {
  const details = new Map<number, MihonImportWork>();
  for (let start = 0; start < ids.length; start += WORKS_PER_DETAILS_READ) {
    const data = await side.query<{ mangas: { nodes: WorkDetailsNode[] } }>(WORK_DETAILS_QUERY, {
      ids: ids.slice(start, start + WORKS_PER_DETAILS_READ),
    });
    for (const node of data.mangas.nodes) details.set(node.id, toImportWork(node));
  }
  return details;
}

/** Groups works into restores the Core accepts: a few works and well under its request limit. */
export function importBatches(works: readonly MihonImportWork[]): MihonImportWork[][] {
  const encoder = new TextEncoder();
  const batches: MihonImportWork[][] = [];
  let batch: MihonImportWork[] = [];
  let bytes = 0;
  for (const work of works) {
    const size = encoder.encode(JSON.stringify(work)).length;
    if (batch.length && (batch.length >= MAX_IMPORT_WORKS || bytes + size > MAX_IMPORT_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(work);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Brings works from one side into the other's library with their chapters and progress, without
 * searching their sources. Answers how many arrived and which did not.
 */
async function importWorks(from: ComicSide, to: ComicSide, works: readonly ComicWork[]) {
  if (!works.length) return { imported: 0, missing: [] as ComicWork[] };
  const details = await readWorkDetails(from, works.map((work) => work.id));
  for (const batch of importBatches(works.flatMap((work) => details.get(work.id) ?? []))) {
    try {
      if (!(await to.importWorks(batch))) break;
    } catch (error) {
      console.warn(`Could not bring ${batch.length} works in on the ${to.name} computer:`, error);
    }
  }
  // A work counts only once it is in the library there; the rest are looked for at their sources.
  const after = await readLibrary(to);
  const missing = works.filter((work) => !after.works.has(comicKey(work.sourceId, work.url)));
  return { imported: works.length - missing.length, missing };
}

/** A work both sides have whose chapters only one of them lists. */
export interface ChapterGap {
  key: ComicKey;
  source: ComicWork;
  target: ComicWork;
}

/**
 * Copies the chapters and their progress to the side that lists none, so a work whose source that
 * side cannot reach still gets them. What cannot be copied is listed from the source instead; either
 * way the progress is matched on the next pass. Answers how many works got their chapters.
 */
export async function fillChapters(from: ComicSide, to: ComicSide, gaps: readonly ChapterGap[], now: number): Promise<number> {
  const pending = gaps.filter((gap) => !recentlyFailed(`chapters:${to.name}:${gap.key}`, now));
  if (!pending.length) return 0;
  const byKey = new Map(pending.map((gap) => [gap.key, gap]));
  const [sources, targets] = await Promise.all([
    readWorkDetails(from, pending.map((gap) => gap.source.id)),
    readWorkDetails(to, pending.map((gap) => gap.target.id)),
  ]).catch((error) => {
    console.warn(`Could not read the chapters to copy to the ${to.name} computer:`, error);
    return [new Map<number, MihonImportWork>(), new Map<number, MihonImportWork>()];
  });
  // A restore overwrites a known work's credits, status and date added, even when the backup leaves
  // them out, so the work keeps the target's own details and only the chapters come from the other side.
  const works = pending.flatMap((gap) => {
    const source = sources.get(gap.source.id);
    const target = targets.get(gap.target.id);
    return source && target ? [{ ...target, chapters: source.chapters }] : [];
  });
  let filled = 0;
  let restoring = works.length > 0;
  const batches = importBatches(works);
  const copying = new Set(works.map((work) => comicKey(work.sourceId, work.url)));
  for (const gap of pending.filter((gap) => !copying.has(gap.key))) await to.fetchChapters(gap.target.id).catch(() => {});
  for (const batch of batches) {
    let copied = false;
    if (restoring) {
      try {
        restoring = await to.importWorks(batch);
        copied = restoring;
      } catch (error) {
        console.warn(`Could not copy chapters of ${batch.length} works to the ${to.name} computer:`, error);
        for (const work of batch) markFailed(`chapters:${to.name}:${comicKey(work.sourceId, work.url)}`, now);
      }
    }
    for (const work of batch) {
      const gap = byKey.get(comicKey(work.sourceId, work.url));
      if (!gap) continue;
      if (copied) filled += 1;
      else await to.fetchChapters(gap.target.id).catch(() => {});
    }
  }
  return filled;
}

async function waitForLocalImport(id: string) {
  const started = Date.now();
  for (;;) {
    const data = await gql<{ restoreStatus: { state: string } | null }>(LOCAL_IMPORT_STATUS_QUERY, { id });
    const state = data.restoreStatus?.state;
    // Suwayomi forgets a restore some time after it ends.
    if (!state || state === "SUCCESS") return;
    if (state === "FAILURE") throw Error("Suwayomi could not restore the works.");
    if (Date.now() - started > IMPORT_TIMEOUT_MS) throw Error("Suwayomi is still restoring the works.");
    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_MS));
  }
}

function exactMatch(nodes: readonly { id: number; url: string }[] | undefined, url: string): number | null {
  return nodes?.find((node) => node.url === url)?.id ?? null;
}

function localSide(): ComicSide {
  return {
    name: "local",
    query: (document, variables) => gql(document, variables),
    async setInLibrary(id, inLibrary) {
      await gql(LOCAL_UPDATE_MANGA_MUTATION, { id, inLibrary });
    },
    async resolve(work) {
      const found = await gql<{ mangas: { nodes: { id: number; url: string }[] } }>(
        LOCAL_LOOKUP_QUERY,
        { sourceId: work.sourceId, url: work.url },
      );
      const id = exactMatch(found.mangas.nodes, work.url);
      if (id !== null) return id;
      // Suwayomi only knows works it fetched; searching the source by title fetches this one.
      const searched = await gql<{ fetchSourceManga: { mangas: { id: number; url: string }[] } }>(
        LOCAL_SEARCH_MUTATION,
        { source: work.sourceId, query: work.title },
      ).catch(() => null);
      return exactMatch(searched?.fetchSourceManga.mangas, work.url);
    },
    async importWorks(works) {
      const backup = new File([encodeMihonImportBackup(works)], "epigraph-sync.tachibk", { type: "application/octet-stream" });
      const data = await gqlUpload<{ restoreBackup: { id: string; status: { state: string } | null } }>(
        LOCAL_IMPORT_MUTATION,
        { backup: null },
        { "variables.backup": backup },
      );
      if (data.restoreBackup.status?.state === "FAILURE") throw Error("Suwayomi could not restore the works.");
      await waitForLocalImport(data.restoreBackup.id);
      return true;
    },
    async fetchChapters(mangaId) {
      await fetchSourceMangaChapters({ mangaId });
    },
    async createCategory(name) {
      await gql(LOCAL_CREATE_CATEGORY_MUTATION, { name });
    },
    async deleteCategory(id) {
      await gql(LOCAL_DELETE_CATEGORY_MUTATION, { id });
    },
    async updateMangaCategories(mangaId, addTo, removeFrom) {
      await gql(LOCAL_UPDATE_MANGA_CATEGORIES_MUTATION, { mangaId, addTo, removeFrom });
    },
    async updateChapters(batch) {
      await gql(LOCAL_UPDATE_CHAPTERS_MUTATION, { ...batch });
    },
  };
}

function remoteSide(profileId: string): ComicSide {
  const command = <T>(operation: string, variables: Record<string, unknown>) =>
    invoke<T>("syncd_remote_comic_command", { profileId, operation, variables });
  return {
    name: "remote",
    query: (query, variables) => invoke("syncd_remote_comic_query", { profileId, query, variables: variables ?? {} }),
    async setInLibrary(id, inLibrary) {
      await command("UpdateManga", { id, inLibrary });
    },
    async resolve(work) {
      const data = await command<{ mangaId: number | null }>(
        "ResolveManga",
        { sourceId: work.sourceId, url: work.url, title: work.title.trim() || work.url },
      );
      return typeof data?.mangaId === "number" ? data.mangaId : null;
    },
    async importWorks(works) {
      try {
        await command("ImportWorks", { works });
        return true;
      } catch (error) {
        if (isUnknownOperation(error)) return false;
        throw error;
      }
    },
    async fetchChapters(mangaId) {
      await command("FetchChapters", { mangaId });
    },
    async createCategory(name) {
      await command("CreateCategory", { name });
    },
    async deleteCategory(id) {
      await command("DeleteCategory", { id });
    },
    async updateMangaCategories(mangaId, addTo, removeFrom) {
      await command("UpdateMangaCategories", { mangaId, addTo, removeFrom });
    },
    async updateChapters(batch) {
      await command("UpdateChaptersProgress", { ...batch });
    },
  };
}

const failures = new Map<string, { at: number; count: number }>();

function markFailed(key: string, now: number) {
  failures.set(key, { at: now, count: (failures.get(key)?.count ?? 0) + 1 });
}

function recentlyFailed(key: string, now: number): boolean {
  const failure = failures.get(key);
  if (!failure) return false;
  const wait = Math.min(RETRY_AFTER_FAILURE_MS * 2 ** (failure.count - 1), MAX_RETRY_AFTER_FAILURE_MS);
  return now - failure.at < wait;
}

/** A Core from before these commands rejects the request body as unreadable. */
function isUnknownOperation(error: unknown): boolean {
  return /HTTP 422\b|unknown variant/i.test(String(error));
}

/** Suwayomi v2.3 lists extension stores; older runtimes keep repositories in settings. */
async function readRemoteStores(remote: ComicSide): Promise<string[]> {
  try {
    const data = await remote.query<{ extensionStores: { nodes: { indexUrl: string }[] } }>(REMOTE_STORES_QUERY);
    return data.extensionStores.nodes.map((node) => node.indexUrl);
  } catch {
    return legacyExtensionRepos(await remote.query<LegacyRepoSettings>(GET_SETTINGS));
  }
}

/** Repositories and extensions are only added: removing one is left to each desktop. */
async function reconcileExtensions(profileId: string, assertTarget: () => void, remote: ComicSide): Promise<boolean> {
  const { getManagedSourceRuntime } = await import("../manga/runtime");
  const runtime = await getManagedSourceRuntime();
  const [stores, extensions, remoteRepos, remoteData] = await Promise.all([
    runtime.listStores(),
    runtime.listExtensions(),
    readRemoteStores(remote),
    remote.query<{ extensions: { nodes: { pkgName: string }[] } }>(REMOTE_INSTALLED_QUERY),
  ]);
  assertTarget();
  const now = Date.now();
  const localStores = new Map(stores.map((repo) => [extensionStoreKey(repo.indexUrl), repo.indexUrl]));
  const remoteStores = new Map(remoteRepos.map((url) => [extensionStoreKey(url), url]));

  // The other Core accepts https indexes and picks the format its runtime reads.
  const toRemote = [...localStores]
    .filter(([key]) => !remoteStores.has(key) && !recentlyFailed(`repo:remote:${key}`, now))
    .filter(([, url]) => url.startsWith("https://") && /\.(json|pb)$/i.test(url));
  if (toRemote.length) {
    await invoke("syncd_remote_comic_command", {
      profileId,
      operation: "AddExtensionRepos",
      variables: { repos: toRemote.map(([, url]) => url) },
    }).catch((error) => {
      for (const [key] of toRemote) markFailed(`repo:remote:${key}`, now);
      console.warn("Could not add extension repositories on the other computer:", error);
    });
  }

  let addedLocalStore = false;
  for (const [key, url] of remoteStores) {
    if (localStores.has(key) || recentlyFailed(`repo:local:${key}`, now)) continue;
    let added = false;
    for (const indexUrl of extensionStoreIndexCandidates(url)) {
      try {
        await runtime.addStore({ indexUrl, assertTarget });
        added = true;
        break;
      } catch {
        assertTarget();
      }
    }
    if (added) addedLocalStore = true;
    else markFailed(`repo:local:${key}`, now);
  }

  const localInstalled = new Set(extensions.filter((extension) => extension.isInstalled).map((extension) => extension.packageName));
  const remoteInstalled = new Set(remoteData.extensions.nodes.map((extension) => extension.pkgName));
  for (const pkgName of localInstalled) {
    if (remoteInstalled.has(pkgName) || recentlyFailed(`ext:remote:${pkgName}`, now)) continue;
    const result = await invoke<{ isInstalled?: boolean } | null>("syncd_remote_comic_command", {
      profileId,
      operation: "InstallExtension",
      variables: { pkgName },
    }).catch(() => null);
    if (!result?.isInstalled) markFailed(`ext:remote:${pkgName}`, now);
  }

  const missingLocal = [...remoteInstalled].filter((pkgName) => !localInstalled.has(pkgName) && !recentlyFailed(`ext:local:${pkgName}`, now));
  if (!missingLocal.length) return addedLocalStore;
  const available = new Map((await runtime.refreshExtensions(undefined, assertTarget)).map((extension) => [extension.packageName, extension]));
  let installed = false;
  for (const packageName of missingLocal) {
    const extension = available.get(packageName);
    if (extension?.isInstalled) continue;
    try {
      if (!extension) throw Error("not listed in this computer's repositories");
      await runtime.installExtension({ packageName, assertTarget });
      installed = true;
    } catch (error) {
      assertTarget();
      markFailed(`ext:local:${packageName}`, now);
      console.warn(`Could not install ${packageName} from the other computer:`, error);
    }
  }
  if (installed || addedLocalStore) bumpContentSetupVersion();
  return installed || addedLocalStore;
}

async function applyLibrary(local: ComicSide, remote: ComicSide, localLibrary: SideLibrary, remoteLibrary: SideLibrary, baseline: ComicSyncBaseline | null) {
  const plan = planLibrary(localLibrary.works, remoteLibrary.works, baseline);
  const now = Date.now();
  let changed = 0;
  let remoteCanResolve = true;
  // Restoring the works is exact and does not depend on their sources being reachable; only what
  // it could not bring in is searched for.
  const bringIn = async (from: ComicSide, to: ComicSide, works: readonly ComicWork[]) => {
    const pending = works.filter((work) => !recentlyFailed(`work:${to.name}:${comicKey(work.sourceId, work.url)}`, now));
    const result = await importWorks(from, to, pending).catch((error) => {
      console.warn(`Could not bring works in on the ${to.name} computer:`, error);
      return { imported: 0, missing: pending };
    });
    changed += result.imported;
    return result.missing;
  };
  const searchLocal = await bringIn(remote, local, plan.addLocal);
  const searchRemote = await bringIn(local, remote, plan.addRemote);
  const add = async (side: ComicSide, work: ComicWork) => {
    const key = comicKey(work.sourceId, work.url);
    if (recentlyFailed(`work:${side.name}:${key}`, now)) return;
    try {
      const id = await side.resolve(work);
      if (id === null) {
        markFailed(`work:${side.name}:${key}`, now);
        return;
      }
      await side.setInLibrary(id, true);
      changed += 1;
      // Chapters come from the source; their progress is matched on the next pass.
      await side.fetchChapters(id).catch((error) => console.warn(`Could not list chapters of ${work.title}:`, error));
    } catch (error) {
      if (side.name === "remote" && isUnknownOperation(error)) {
        remoteCanResolve = false;
        return;
      }
      markFailed(`work:${side.name}:${key}`, now);
      console.warn(`Could not add ${work.title} on the ${side.name} computer:`, error);
    }
  };
  await bySource(searchLocal, (work) => add(local, work));
  await bySource(searchRemote, (work) => (remoteCanResolve ? add(remote, work) : Promise.resolve()));
  for (const work of plan.removeLocal) {
    await local.setInLibrary(work.id, false);
    changed += 1;
  }
  for (const work of plan.removeRemote) {
    await remote.setInLibrary(work.id, false);
    changed += 1;
  }
  return changed;
}

/** Runs `task` for each work, one at a time per source and a few sources at once. */
async function bySource(works: readonly ComicWork[], task: (work: ComicWork) => Promise<void>) {
  const groups = new Map<string, ComicWork[]>();
  for (const work of works) groups.set(work.sourceId, [...(groups.get(work.sourceId) ?? []), work]);
  const queue = [...groups.values()];
  const worker = async () => {
    for (let group = queue.shift(); group; group = queue.shift()) {
      for (const work of group) await task(work);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_SOURCES, queue.length) }, worker));
}

async function applyCategories(
  local: ComicSide,
  remote: ComicSide,
  localLibrary: SideLibrary,
  remoteLibrary: SideLibrary,
  baseline: ComicSyncBaseline | null,
) {
  let [localCategories, remoteCategories] = await Promise.all([readCategories(local), readCategories(remote)]);
  const plan = planCategories(new Set(localCategories.keys()), new Set(remoteCategories.keys()), baseline);
  let changed = 0;
  for (const name of plan.createLocal) await local.createCategory(name).then(() => changed++);
  for (const name of plan.createRemote) await remote.createCategory(name).then(() => changed++);
  for (const name of plan.deleteLocal) await local.deleteCategory(localCategories.get(name)!).then(() => changed++);
  for (const name of plan.deleteRemote) await remote.deleteCategory(remoteCategories.get(name)!).then(() => changed++);
  if (changed) [localCategories, remoteCategories] = await Promise.all([readCategories(local), readCategories(remote)]);

  const shared = new Set(plan.names.filter((name) => localCategories.has(name) && remoteCategories.has(name)));
  const known = new Set(baseline?.library ?? []);
  const assignments: Record<ComicKey, string[]> = {};
  for (const [key, mine] of localLibrary.works) {
    const theirs = remoteLibrary.works.get(key);
    if (!theirs) continue;
    const desired = mergeAssignments(mine.categories, theirs.categories, known.has(key) ? baseline?.assignments[key] ?? [] : undefined, shared);
    assignments[key] = desired;
    for (const [side, work, ids] of [[local, mine, localCategories], [remote, theirs, remoteCategories]] as const) {
      const current = new Set(work.categories.filter((name) => shared.has(name)));
      const addTo = desired.filter((name) => !current.has(name)).map((name) => ids.get(name)!);
      const removeFrom = [...current].filter((name) => !desired.includes(name)).map((name) => ids.get(name)!);
      if (addTo.length || removeFrom.length) {
        await side.updateMangaCategories(work.id, addTo, removeFrom);
        changed += 1;
      }
    }
  }
  return { changed, names: [...shared].sort(), assignments };
}

async function applyChapters(
  local: ComicSide,
  remote: ComicSide,
  localLibrary: SideLibrary,
  remoteLibrary: SideLibrary,
  baseline: ComicSyncBaseline | null,
) {
  const now = Date.now();
  const sweep = !baseline || now - baseline.sweptAt > FULL_SWEEP_INTERVAL_MS;
  const shared = [...localLibrary.works.keys()].filter((key) => remoteLibrary.works.has(key));
  const digestOf = (key: ComicKey) => `${localLibrary.works.get(key)!.digest}|${remoteLibrary.works.get(key)!.digest}`;
  const changedKeys = shared.filter((key) => !baseline?.chapters[key] || baseline.digests[key] !== digestOf(key));
  const candidates = sweep ? [...new Set([...changedKeys, ...shared])] : changedKeys;
  const keys = candidates.slice(0, MAX_CHAPTER_WORKS_PER_RUN);

  const chapters: Record<ComicKey, Record<string, ChapterTriple>> = {};
  const digests: Record<ComicKey, string> = {};
  for (const key of shared) {
    if (baseline?.chapters[key]) chapters[key] = baseline.chapters[key];
    if (baseline?.digests[key]) digests[key] = baseline.digests[key];
  }
  if (!keys.length) return { changed: 0, chapters, digests, swept: sweep };

  const [localChapters, remoteChapters] = await Promise.all([
    readChapters(local, keys.map((key) => localLibrary.works.get(key)!.id)),
    readChapters(remote, keys.map((key) => remoteLibrary.works.get(key)!.id)),
  ]);
  const localUpdates: ChapterUpdate[] = [];
  const remoteUpdates: ChapterUpdate[] = [];
  const localGaps: ChapterGap[] = [];
  const remoteGaps: ChapterGap[] = [];
  for (const key of keys) {
    const mine = localLibrary.works.get(key)!;
    const theirs = remoteLibrary.works.get(key)!;
    const localList = localChapters.get(mine.id) ?? new Map();
    const remoteList = remoteChapters.get(theirs.id) ?? new Map();
    // A side that lists none of this work's chapters gets the other's; they are matched next run.
    if (!localList.size || !remoteList.size) {
      if (!localList.size && remoteList.size) localGaps.push({ key, source: theirs, target: mine });
      if (!remoteList.size && localList.size) remoteGaps.push({ key, source: mine, target: theirs });
      continue;
    }
    const plan = planChapters(localList, remoteList, baseline?.chapters[key]);
    localUpdates.push(...plan.localUpdates);
    remoteUpdates.push(...plan.remoteUpdates);
    chapters[key] = plan.merged;
    digests[key] = digestOf(key);
  }
  for (const batch of batchChapterUpdates(localUpdates)) await local.updateChapters(batch);
  for (const batch of batchChapterUpdates(remoteUpdates)) await remote.updateChapters(batch);
  const filled = (await fillChapters(remote, local, localGaps, now)) + (await fillChapters(local, remote, remoteGaps, now));
  return {
    changed: localUpdates.length + remoteUpdates.length + filled,
    chapters,
    digests,
    swept: sweep && candidates.length <= MAX_CHAPTER_WORKS_PER_RUN,
  };
}

/** One full reconciliation; answers whether this desktop's comics changed. */
export async function reconcileJoinedComics(profileId: string): Promise<boolean> {
  if (!(await invoke<boolean>("syncd_comic_bridge_available", { profileId }))) return false;
  const assertTarget = () => {
    if (store.runtimeResolvedLocalProfileId !== profileId) throw Error("COMIC_SYNC_TARGET_CHANGED");
  };
  const baseline = parseBaseline(await invoke("syncd_read_comic_sync_baseline", { profileId }));
  const local = localSide();
  const remote = remoteSide(profileId);

  // Works can only be found once their extension is installed, so extensions go first.
  const extensionsChanged = await reconcileExtensions(profileId, assertTarget, remote).catch((error) => {
    console.warn("Comic extension sync failed:", error);
    return false;
  });
  assertTarget();

  let [localLibrary, remoteLibrary] = await Promise.all([readLibrary(local), readLibrary(remote)]);
  const libraryChanged = await applyLibrary(local, remote, localLibrary, remoteLibrary, baseline);
  assertTarget();
  if (libraryChanged) [localLibrary, remoteLibrary] = await Promise.all([readLibrary(local), readLibrary(remote)]);

  const categories = await applyCategories(local, remote, localLibrary, remoteLibrary, baseline);
  assertTarget();
  const progress = await applyChapters(local, remote, localLibrary, remoteLibrary, baseline);
  assertTarget();

  const next: ComicSyncBaseline = {
    ...emptyBaseline(),
    library: [...localLibrary.works.keys()].filter((key) => remoteLibrary.works.has(key)).sort(),
    categories: categories.names,
    assignments: categories.assignments,
    chapters: progress.chapters,
    digests: progress.digests,
    sweptAt: progress.swept ? Date.now() : baseline?.sweptAt ?? 0,
  };
  await invoke("syncd_write_comic_sync_baseline", { profileId, baseline: next });
  return extensionsChanged || libraryChanged > 0 || categories.changed > 0 || progress.changed > 0;
}

let running: Promise<void> | null = null;
let rerun = false;
let debounce: ReturnType<typeof setTimeout> | null = null;

function currentProfileId(): string | null {
  const profileId = store.runtimeResolvedLocalProfileId?.trim();
  return profileId ? profileId : null;
}

async function runOnce(): Promise<void> {
  const profileId = currentProfileId();
  if (!profileId || !store.runtimeServerUrl) return;
  try {
    if (await reconcileJoinedComics(profileId)) {
      window.dispatchEvent(new CustomEvent(COMIC_LIBRARY_RECONCILED_EVENT, { detail: { localProfileId: profileId } }));
    }
  } catch (error) {
    if (String(error).includes("needs_reauth")) return;
    console.warn("Comic sync with the other computer failed:", error);
  }
}

/** Reconciles soon; requests during a run start one more run after it. */
export function requestComicSync(delayMs = COMIC_SYNC_DEBOUNCE_MS) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    if (running) {
      rerun = true;
      return;
    }
    running = runOnce().finally(() => {
      running = null;
      if (rerun) {
        rerun = false;
        requestComicSync();
      }
    });
  }, delayMs);
}

/** Starts reconciling on changes from the other computer, on this window's edits, and periodically. */
export async function startJoinedComicSync(): Promise<() => void> {
  const unlisten: UnlistenFn = await listen("syncd-comic-library-changed", () => requestComicSync());
  const onLocalEdit = () => requestComicSync();
  window.addEventListener(COMIC_LOCAL_EDIT_EVENT, onLocalEdit);
  const timer = setInterval(() => requestComicSync(0), COMIC_SYNC_INTERVAL_MS);
  requestComicSync(0);
  return () => {
    unlisten();
    window.removeEventListener(COMIC_LOCAL_EDIT_EVENT, onLocalEdit);
    clearInterval(timer);
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
  };
}
