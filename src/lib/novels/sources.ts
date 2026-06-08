import { invoke } from "@tauri-apps/api/core";

import { TauriNovelRuntimeHostAdapter } from "./runtimeHost";
import { loadNovelRepositoryState, type NovelRepositoryScopeInput } from "./repositoryState";
import { resolveSearchResultsWithFallback } from "../search/queryFallback";
import type { NovelCatalogEntry, NovelRepositoryRecord } from "./contracts";
import {
  createNovelChapterId,
  createNovelLibraryId,
  normalizeStringArray,
  normalizeText,
  type InstalledNovelSourceDescriptor,
  type NovelDetailRecord,
  type NovelSourceSearchResult,
} from "./domain";

const runtimeHost = new TauriNovelRuntimeHostAdapter();

type NovelSourceRuntimeEntry = {
  name: string | null;
  path: string | null;
  cover: string | null;
  rating?: unknown;
  score?: unknown;
  stars?: unknown;
  ratingMax?: unknown;
  scoreMax?: unknown;
};

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").match(/\d+(?:\.\d+)?/u)?.[0];
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractNovelSourceRating(entry: NovelSourceRuntimeEntry): Pick<NovelSourceSearchResult, "rating" | "ratingMax" | "ratingLabel"> {
  const ratingValue = entry.rating ?? entry.score ?? entry.stars;
  const rating = coerceNumber(ratingValue);
  if (rating == null) return {};
  const explicitMax = coerceNumber(entry.ratingMax ?? entry.scoreMax);
  const ratingMax = explicitMax ?? (rating > 10 ? 100 : rating > 5 ? 10 : 5);
  return {
    rating,
    ratingMax,
    ratingLabel: typeof ratingValue === "string" ? ratingValue : `${rating}`,
  };
}

function decodeBase64Text(input: string): string {
  if (typeof atob === "function") {
    const binary = atob(input);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  const maybeBuffer = (globalThis as {
    Buffer?: { from(input: string, encoding: string): { toString(encoding?: string): string } };
  }).Buffer;
  if (!maybeBuffer) {
    throw new Error("No base64 decoder is available in this runtime.");
  }
  return maybeBuffer.from(input, "base64").toString("utf8");
}

function normalizeInstalledSource(
  repository: NovelRepositoryRecord,
  catalogEntry: NovelCatalogEntry,
  installedPlugin: {
    enabled: boolean;
    artifactPath: string;
  },
): InstalledNovelSourceDescriptor {
  return {
    pluginId: catalogEntry.pluginId,
    repositoryId: repository.id,
    repositoryUrl: repository.normalizedUrl,
    trustState: repository.trustState,
    name: catalogEntry.name,
    lang: catalogEntry.lang,
    site: catalogEntry.site,
    version: catalogEntry.version,
    iconUrl: catalogEntry.iconUrl,
    artifactUrl: catalogEntry.artifactUrl,
    artifactPath: installedPlugin.artifactPath,
    enabled: installedPlugin.enabled,
  };
}

async function readInstalledArtifactSource(path: string): Promise<string> {
  const encoded = await invoke<string>("read_file_base64", { path });
  return decodeBase64Text(encoded);
}

async function readPluginPayload(
  source: InstalledNovelSourceDescriptor,
): Promise<{
  pluginId: string;
  artifactUrl: string;
  pluginSource: string;
  settingsSeed: Record<string, unknown>;
}> {
  return {
    pluginId: source.pluginId,
    artifactUrl: source.artifactUrl,
    pluginSource: await readInstalledArtifactSource(source.artifactPath),
    settingsSeed: {},
  };
}

export async function readInstalledNovelSourceRuntimeSummary(
  scopeInput: NovelRepositoryScopeInput,
  sourceId: string,
): Promise<{
  pluginSettingsKeys: string[];
  filterKeys: string[];
}> {
  const source = (await loadTrustedInstalledNovelSources(scopeInput)).find((entry) => entry.pluginId === sourceId);
  if (!source) {
    throw new Error("Novel source is not installed, enabled, and trusted.");
  }

  const payload = await readPluginPayload(source);
  const settings = await runtimeHost.invoke<typeof payload, {
    pluginSettingKeys: string[];
    pluginSettings: Record<string, unknown>;
  }>("source.settings.read", payload);
  const filters = await runtimeHost.invoke<typeof payload, {
    filterKeys: string[];
  }>("source.filters.read", payload);

  return {
    pluginSettingsKeys: (settings.pluginSettingKeys ?? Object.keys(settings.pluginSettings ?? {})).filter(Boolean),
    filterKeys: (filters.filterKeys ?? []).filter(Boolean),
  };
}

function createSourceIdentity(source: InstalledNovelSourceDescriptor) {
  return {
    repositoryUrl: source.repositoryUrl,
    repositoryName: null,
    pluginId: source.pluginId,
    pluginName: source.name,
    pluginVersion: source.version,
    sourceId: source.pluginId,
    sourceName: source.name,
    lang: source.lang,
  };
}

export async function loadInstalledNovelSources(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<InstalledNovelSourceDescriptor[]> {
  const state = await loadNovelRepositoryState(scopeInput);

  return state.installedPlugins
    .map((installedPlugin) => {
      const repository = state.repositories.find((entry) => entry.id === installedPlugin.repositoryId);
      const catalogEntry = state.catalogEntries.find((entry) => (
        entry.repositoryId === installedPlugin.repositoryId
        && entry.pluginId === installedPlugin.pluginId
        && entry.version === installedPlugin.version
      )) ?? state.catalogEntries.find((entry) => entry.pluginId === installedPlugin.pluginId);

      if (!repository || !catalogEntry) {
        return null;
      }

      return normalizeInstalledSource(repository, catalogEntry, installedPlugin);
    })
    .filter((entry): entry is InstalledNovelSourceDescriptor => Boolean(entry))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadTrustedInstalledNovelSources(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<InstalledNovelSourceDescriptor[]> {
  const sources = await loadInstalledNovelSources(scopeInput);
  return sources.filter((source) => source.enabled && source.trustState === "trusted");
}

export async function searchInstalledNovelSource(
  scopeInput: NovelRepositoryScopeInput,
  sourceId: string,
  searchTerm: string,
  pageNo = 1,
): Promise<NovelSourceSearchResult[]> {
  const source = (await loadTrustedInstalledNovelSources(scopeInput)).find((entry) => entry.pluginId === sourceId);
  if (!source) {
    throw new Error("Novel source is not installed, enabled, and trusted.");
  }

  const payload = await readPluginPayload(source);
  return resolveSearchResultsWithFallback(searchTerm, async (attemptTerm) => {
    const result = await runtimeHost.invoke<typeof payload & { searchTerm: string; pageNo: number }, {
      results: Array<NovelSourceRuntimeEntry>;
    }>("source.search", {
      ...payload,
      searchTerm: attemptTerm,
      pageNo,
    });

    return (result.results ?? [])
      .map((entry) => {
        const title = normalizeText(entry.name);
        const path = normalizeText(entry.path);
        if (!title || !path) {
          return null;
        }

        return {
          sourceId: source.pluginId,
          title,
          path,
          coverUrl: normalizeText(entry.cover),
          ...extractNovelSourceRating(entry),
        } satisfies NovelSourceSearchResult;
      })
      .filter((entry): entry is NovelSourceSearchResult => Boolean(entry));
  });
}

export async function browseInstalledNovelSource(
  scopeInput: NovelRepositoryScopeInput,
  sourceId: string,
  pageNo = 1,
): Promise<NovelSourceSearchResult[]> {
  const source = (await loadTrustedInstalledNovelSources(scopeInput)).find((entry) => entry.pluginId === sourceId);
  if (!source) {
    throw new Error("Novel source is not installed, enabled, and trusted.");
  }

  const payload = await readPluginPayload(source);
  const result = await runtimeHost.invoke<typeof payload & { pageNo: number }, {
    results: Array<NovelSourceRuntimeEntry>;
  }>("source.popular", {
    ...payload,
    pageNo,
  });

  return (result.results ?? [])
    .map((entry) => {
      const title = normalizeText(entry.name);
      const path = normalizeText(entry.path);
      if (!title || !path) {
        return null;
      }

      return {
        sourceId: source.pluginId,
        title,
        path,
        coverUrl: normalizeText(entry.cover),
        ...extractNovelSourceRating(entry),
      } satisfies NovelSourceSearchResult;
    })
    .filter((entry): entry is NovelSourceSearchResult => Boolean(entry));
}

export async function readInstalledNovelDetails(
  scopeInput: NovelRepositoryScopeInput,
  sourceId: string,
  novelPath: string,
  fallback: {
    title?: string | null;
    coverUrl?: string | null;
  } = {},
): Promise<NovelDetailRecord> {
  const source = (await loadTrustedInstalledNovelSources(scopeInput)).find((entry) => entry.pluginId === sourceId);
  if (!source) {
    throw new Error("Novel source is not installed, enabled, and trusted.");
  }

  const payload = await readPluginPayload(source);
  const details = await runtimeHost.invoke<typeof payload & { novelPath: string }, {
    name: string | null;
    novelPath: string;
    author: string | null;
    cover: string | null;
    summary: string | null;
    status: string | null;
    tags: string[];
    chapterCount: number | null;
    chapters: Array<{
      path: string | null;
      title: string | null;
      releaseTime: number | null;
    }>;
  }>("source.details", {
    ...payload,
    novelPath,
  });

  const title = normalizeText(details.name) ?? normalizeText(fallback.title);
  if (!title) {
    throw new Error("Novel details did not include a title.");
  }

  const id = createNovelLibraryId(source.pluginId, details.novelPath || novelPath);
  const chapters = (details.chapters ?? [])
    .map((chapter, index) => {
      const path = normalizeText(chapter.path);
      const chapterTitle = normalizeText(chapter.title);
      if (!path || !chapterTitle) return null;

      return {
        id: createNovelChapterId(id, path),
        novelId: id,
        path,
        title: chapterTitle,
        order: index,
        releaseTime: typeof chapter.releaseTime === "number" ? chapter.releaseTime : null,
        unread: true,
      };
    })
    .filter((entry): entry is NovelDetailRecord["chapters"][number] => Boolean(entry));

  return {
    id,
    sourceId: source.pluginId,
    title,
    path: details.novelPath || novelPath,
    coverUrl: normalizeText(details.cover) ?? normalizeText(fallback.coverUrl),
    author: normalizeText(details.author),
    description: normalizeText(details.summary),
    status: normalizeText(details.status),
    tags: normalizeStringArray(details.tags),
    chapterCount: typeof details.chapterCount === "number" ? details.chapterCount : chapters.length,
    chapters,
    source: createSourceIdentity(source),
  };
}

export async function readInstalledNovelChapter(
  scopeInput: NovelRepositoryScopeInput,
  sourceId: string,
  chapterPath: string,
): Promise<{ content: string; source: InstalledNovelSourceDescriptor }> {
  const source = (await loadTrustedInstalledNovelSources(scopeInput)).find((entry) => entry.pluginId === sourceId);
  if (!source) {
    throw new Error("Novel source is not installed, enabled, and trusted.");
  }

  const payload = await readPluginPayload(source);
  const chapter = await runtimeHost.invoke<typeof payload & { chapterPath: string }, {
    content: string;
    preview: string | null;
    hasContent: boolean;
  }>("source.chapter", {
    ...payload,
    chapterPath,
  });

  const content = normalizeText(chapter.content) ?? normalizeText(chapter.preview) ?? "";
  if (!content) {
    throw new Error("Novel chapter did not return readable content.");
  }

  return { content, source };
}

export async function shutdownInstalledNovelSourcesRuntime(): Promise<void> {
  await runtimeHost.stop().catch(() => {});
}
