import { gql } from "../client";
import { GET_SOURCES, UPDATE_MANGA } from "../queries";
import { searchSourceManga } from "../manga/runtime";
import {
  browseInstalledNovelSource,
  acquireInstalledNovelSourcesRuntime,
  loadTrustedInstalledNovelSources,
  readInstalledNovelDetails,
  searchInstalledNovelSource,
} from "../novels/sources";
import {
  loadNovelLibraryState,
  saveNovelLibraryState,
  upsertNovelInLibrary,
} from "../novels/libraryState";
import {
  bumpContentSetupVersion,
  setSearchNovelLibrarySnapshot,
  store,
} from "../../store/state.svelte";
import type { Source } from "../types";
import { shouldHideNsfw, shouldHideSource } from "../util";
import { appliedAppLanguage, translate } from "../i18n/runtime";
import { extensionLanguageMatchesLocale, isMultiLanguageExtension } from "./firstRunSourcesWorkflow";

type DiscoveryScope = { profileId: string | null; serverUrl: string | null };

export type FirstRunDiscoveryKind = "manga" | "novel";
export type FirstRunDiscoveryStatus = "idle" | "adding" | "added";

export interface FirstRunDiscoverySource {
  id: string;
  name: string;
  lang?: string | null;
  /** Language variants of one extension share this, so the step can keep just one of them. */
  group?: string;
  scope?: DiscoveryScope;
}

export interface FirstRunDiscoveryResult {
  id: string | number;
  path?: string;
  title: string;
  coverUrl: string | null;
  inLibrary: boolean;
}

export interface FirstRunWorkCard {
  id: string;
  kind: FirstRunDiscoveryKind;
  title: string;
  sourceName: string;
  coverUrl: string | null;
  inLibrary: boolean;
  status: FirstRunDiscoveryStatus;
}

export interface FirstRunDiscoveryDependencies {
  loadMangaSources(): Promise<FirstRunDiscoverySource[]>;
  loadNovelSources(): Promise<FirstRunDiscoverySource[]>;
  findManga(source: FirstRunDiscoverySource, query: string | null): Promise<FirstRunDiscoveryResult[]>;
  findNovels(source: FirstRunDiscoverySource, query: string | null): Promise<FirstRunDiscoveryResult[]>;
  addManga(source: FirstRunDiscoverySource, result: FirstRunDiscoveryResult): Promise<void>;
  addNovel(source: FirstRunDiscoverySource, result: FirstRunDiscoveryResult): Promise<void>;
  dispose?(): Promise<void>;
}

export interface FirstRunDiscoveryWorkflow {
  readonly items: readonly FirstRunWorkCard[];
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  /** Names of the sources that failed during the last load, so the step can say which one is down. */
  readonly failedSources: readonly string[];
  loadPopular(): Promise<void>;
  search(query: string): Promise<void>;
  addToLibrary(id: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

type WorkPayload = {
  source: FirstRunDiscoverySource;
  result: FirstRunDiscoveryResult;
  kind: FirstRunDiscoveryKind;
};

const MAX_RESULTS = 8;
const MAX_SOURCES_PER_KIND = 4;
const SOURCE_CONCURRENCY = 2;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settleLimited<T>(tasks: Array<() => Promise<T>>, limit: number, isCurrent: () => boolean): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length && isCurrent()) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

function languageRank(lang: string | null | undefined, locale: string): number {
  const value = lang?.trim() ?? "";
  if (value && extensionLanguageMatchesLocale(value, locale)) return 0;
  if (isMultiLanguageExtension(value)) return 1;
  if (value.toLowerCase() === "en" || value.toLowerCase() === "english") return 2;
  return 3;
}

/**
 * A comic extension installs one source per language, so the step would otherwise show four
 * languages of the same catalog. Keep the variant closest to the app language for each name and
 * put the sources in that language first, before the step takes the first few.
 */
export function rankFirstRunDiscoverySources<T extends FirstRunDiscoverySource>(sources: readonly T[], locale: string): T[] {
  const best = new Map<string, { source: T; rank: number; order: number }>();
  sources.forEach((source, order) => {
    const key = (source.group ?? source.name).trim().toLowerCase();
    const rank = languageRank(source.lang, locale);
    const current = best.get(key);
    if (!current || rank < current.rank) best.set(key, { source, rank, order: current?.order ?? order });
  });
  return [...best.values()]
    .sort((left, right) => Number(left.rank !== 0) - Number(right.rank !== 0) || left.order - right.order)
    .map((entry) => entry.source);
}

function discoveryLocale(): string {
  return appliedAppLanguage() ?? (typeof navigator === "undefined" ? "en" : navigator.language) ?? "en";
}

export function createFirstRunDiscoveryWorkflow(
  dependencies: FirstRunDiscoveryDependencies,
): FirstRunDiscoveryWorkflow {
  let items: FirstRunWorkCard[] = [];
  let loading = false;
  let error: string | null = null;
  let failedSources: string[] = [];
  let generation = 0;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  const activeLoads = new Set<Promise<void>>();
  let writeQueue = Promise.resolve();
  const pendingAdds = new Map<string, Promise<boolean>>();
  const payloads = new Map<string, WorkPayload>();
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((listener) => listener());

  function replaceItem(id: string, patch: Partial<FirstRunWorkCard>) {
    items = items.map((item) => item.id === id ? { ...item, ...patch } : item);
    notify();
  }

  async function load(query: string | null) {
    if (disposed || pendingAdds.size > 0) return;
    const currentGeneration = ++generation;
    loading = true;
    error = null;
    failedSources = [];
    notify();
    try {
      const [mangaSourcesResult, novelSourcesResult] = await Promise.allSettled([
        dependencies.loadMangaSources(),
        dependencies.loadNovelSources(),
      ]);
      if (currentGeneration !== generation) return;
      const mangaSources = mangaSourcesResult.status === "fulfilled"
        ? mangaSourcesResult.value.slice(0, MAX_SOURCES_PER_KIND)
        : [];
      const novelSources = novelSourcesResult.status === "fulfilled"
        ? novelSourcesResult.value.slice(0, MAX_SOURCES_PER_KIND)
        : [];
      const taskSources = [...mangaSources, ...novelSources];
      const tasks: Array<() => Promise<{ source: FirstRunDiscoverySource; kind: FirstRunDiscoveryKind; results: FirstRunDiscoveryResult[] }>> = [
        ...mangaSources.map((source) => async () => ({ source, kind: "manga" as const, results: await dependencies.findManga(source, query) })),
        ...novelSources.map((source) => async () => ({ source, kind: "novel" as const, results: await dependencies.findNovels(source, query) })),
      ];
      const settled = await settleLimited(tasks, SOURCE_CONCURRENCY, () => currentGeneration === generation);
      if (currentGeneration !== generation) return;

      const nextItems: FirstRunWorkCard[] = [];
      const nextPayloads = new Map<string, WorkPayload>();
      const groups = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const maxDepth = Math.max(0, ...groups.map((group) => group.results.length));
      for (let depth = 0; depth < maxDepth && nextItems.length < MAX_RESULTS; depth += 1) {
        for (const { source, kind, results } of groups) {
          const result = results[depth];
          if (!result) continue;
          const identity = kind === "manga"
            ? `manga:${source.id}:${result.id}`
            : `novel:${source.id}:${encodeURIComponent(result.path ?? String(result.id))}`;
          if (nextPayloads.has(identity)) continue;
          nextPayloads.set(identity, { source, result, kind });
          nextItems.push({
            id: identity,
            kind,
            title: result.title,
            sourceName: source.name,
            coverUrl: result.coverUrl,
            inLibrary: result.inLibrary,
            status: result.inLibrary ? "added" : "idle",
          });
          if (nextItems.length >= MAX_RESULTS) break;
        }
        if (nextItems.length >= MAX_RESULTS) break;
      }
      payloads.clear();
      nextPayloads.forEach((value, key) => payloads.set(key, value));
      items = nextItems;

      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      failedSources = [...new Set(settled.flatMap((result, index) => result.status === "rejected" ? [taskSources[index].name] : []))];
      const sourceLoadFailures = [mangaSourcesResult, novelSourcesResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (tasks.length === 0 && sourceLoadFailures.length > 0) {
        error = errorMessage(sourceLoadFailures[0].reason);
      } else if (nextItems.length === 0 && failures.length === settled.length && failures.length > 0) {
        error = errorMessage(failures[0].reason);
      }
    } finally {
      if (currentGeneration === generation) {
        loading = false;
        notify();
      }
    }
  }

  function trackedLoad(query: string | null): Promise<void> {
    const operation = load(query);
    activeLoads.add(operation);
    void operation.then(() => activeLoads.delete(operation), () => activeLoads.delete(operation));
    return operation;
  }

  return {
    get items() { return items; },
    get loading() { return loading; },
    get saving() { return pendingAdds.size > 0; },
    get error() { return error; },
    get failedSources() { return failedSources; },
    loadPopular: () => trackedLoad(null),
    search: (query) => trackedLoad(query.trim() || null),
    addToLibrary(id) {
      if (disposed) return Promise.resolve(false);
      const pending = pendingAdds.get(id);
      if (pending) return pending;
      const payload = payloads.get(id);
      const item = items.find((entry) => entry.id === id);
      if (!payload || !item || loading) return Promise.resolve(false);
      if (item.inLibrary) return Promise.resolve(true);
      error = null;
      const operation = writeQueue.then(async () => {
        try {
          if (payload.kind === "manga") await dependencies.addManga(payload.source, payload.result);
          else await dependencies.addNovel(payload.source, payload.result);
          replaceItem(id, { status: "added", inLibrary: true });
          return true;
        } catch (cause) {
          error = errorMessage(cause);
          replaceItem(id, { status: "idle", inLibrary: false });
          throw cause;
        } finally {
          pendingAdds.delete(id);
          notify();
        }
      });
      pendingAdds.set(id, operation);
      writeQueue = operation.then(() => {}, () => {});
      replaceItem(id, { status: "adding" });
      return operation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      generation += 1;
      loading = false;
      listeners.clear();
      disposal = (async () => {
        await Promise.allSettled([...activeLoads, writeQueue]);
        await dependencies.dispose?.();
      })();
      return disposal;
    },
  };
}

export function createProductionFirstRunDiscoveryWorkflow(): FirstRunDiscoveryWorkflow {
  const releaseRuntime = acquireInstalledNovelSourcesRuntime();
  const scope = () => ({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  });
  function checkedScope(source: FirstRunDiscoverySource): DiscoveryScope {
    const original = source.scope;
    const current = scope();
    if (!original || original.profileId !== current.profileId || original.serverUrl !== current.serverUrl) {
      throw new Error(translate("firstRun.discover.profileChanged"));
    }
    return original;
  }

  return createFirstRunDiscoveryWorkflow({
    async loadMangaSources() {
      const original = scope();
      const response = await gql<{ sources: { nodes: Source[] } }>(GET_SOURCES);
      return rankFirstRunDiscoverySources((response.sources.nodes ?? [])
        .filter((source) => source.id !== "0" && !shouldHideSource(source, store.settings))
        .map((source) => ({ id: source.id, name: source.displayName || source.name, group: source.name, lang: source.lang, scope: original })), discoveryLocale());
    },
    async loadNovelSources() {
      const original = scope();
      return rankFirstRunDiscoverySources((await loadTrustedInstalledNovelSources(original)).map((source) => ({
        id: source.pluginId,
        name: source.name,
        lang: source.lang,
        scope: original,
      })), discoveryLocale());
    },
    async findManga(source, query) {
      checkedScope(source);
      const response = await searchSourceManga({
        source: source.id,
        type: query ? "SEARCH" : "POPULAR",
        page: 1,
        query,
      });
      checkedScope(source);
      return response.fetchSourceManga.mangas.filter((manga) => !shouldHideNsfw({ ...manga, source: { ...manga.source, id: source.id } }, store.settings)).map((manga) => ({
        id: manga.id,
        title: manga.title,
        coverUrl: manga.thumbnailUrl || null,
        inLibrary: manga.inLibrary,
      }));
    },
    async findNovels(source, query) {
      const original = checkedScope(source);
      const results = query
        ? await searchInstalledNovelSource(original, source.id, query, 1)
        : await browseInstalledNovelSource(original, source.id, 1);
      checkedScope(source);
      const state = await loadNovelLibraryState(original);
      return results.map((novel) => ({
        id: `${source.id}:${novel.path}`,
        path: novel.path,
        title: novel.title,
        coverUrl: novel.coverUrl,
        inLibrary: state.entries.some((entry) => entry.source.sourceId === source.id && entry.path === novel.path),
      }));
    },
    async addManga(source, result) {
      checkedScope(source);
      const id = Number(result.id);
      if (!Number.isFinite(id)) throw new Error("Invalid manga identifier.");
      await gql(UPDATE_MANGA, { id, inLibrary: true });
      checkedScope(source);
      store.syncLibraryMangaFromDetail({
        id,
        title: result.title,
        thumbnailUrl: result.coverUrl ?? "",
        inLibrary: true,
        source: {
          id: source.id,
          name: source.name,
          displayName: source.name,
          lang: source.lang ?? "",
        },
      });
    },
    async addNovel(source, result) {
      const original = checkedScope(source);
      if (!result.path) throw new Error("Invalid novel path.");
      const detail = await readInstalledNovelDetails(original, source.id, result.path, {
        title: result.title,
        coverUrl: result.coverUrl,
      });
      checkedScope(source);
      const state = await loadNovelLibraryState(original);
      checkedScope(source);
      const saved = await saveNovelLibraryState(upsertNovelInLibrary(state, detail), original);
      checkedScope(source);
      setSearchNovelLibrarySnapshot(saved.entries, saved.chapters);
      bumpContentSetupVersion();
    },
    dispose: releaseRuntime,
  });
}
