import { gql } from "../client";
import { fetchRepoEntries, type RepoExtensionEntry } from "../extensionSourceMap";
import { getManagedSourceRuntime } from "../manga/runtime";
import { loadNovelRepositoryState, type NovelRepositoryScopeInput } from "../novels/repositoryState";
import { FETCH_EXTENSIONS, GET_SOURCES } from "../queries";
import type { Extension, Source } from "../types";
import type {
  AvailableExtensionEntry,
  ContentSourceInventoryEntry,
  ReconciliationWarning,
  RepoExtensionLookup,
  SourceInventoryEntry,
} from "./types";

function dedupeSourceInventory(entries: SourceInventoryEntry[]): SourceInventoryEntry[] {
  const seen = new Map<string, SourceInventoryEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.sourceId}:${entry.lang}:${entry.displayName}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function dedupeContentSourceInventory(entries: ContentSourceInventoryEntry[]): ContentSourceInventoryEntry[] {
  const seen = new Map<string, ContentSourceInventoryEntry>();
  for (const entry of entries) {
    const key = `${entry.contentKind}:${entry.kind}:${entry.sourceId}:${entry.lang}:${entry.displayName}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function buildRepoSourceLookup(entry: RepoExtensionEntry): RepoExtensionLookup[] {
  return (entry.sources ?? []).map((source) => ({
    sourceId: String(source.id),
    sourceName: source.name,
    lang: source.lang ?? entry.lang ?? "all",
    extensionPkgName: entry.pkg,
    extensionName: entry.name,
  }));
}

export async function loadSourceInventory(): Promise<{
  inventory: SourceInventoryEntry[];
  availableExtensions: AvailableExtensionEntry[];
  warnings: ReconciliationWarning[];
  repoUrls: string[];
}> {
  const runtime = await getManagedSourceRuntime();
  const [sourcesData, stores, extensionsData] = await Promise.all([
    gql<{ sources: { nodes: Source[] } }>(GET_SOURCES),
    runtime.listStores(),
    gql<{ fetchExtensions: { extensions: Extension[] } }>(FETCH_EXTENSIONS),
  ]);

  const repoUrls = stores.map((store) => store.indexUrl);
  const repoFetch = await fetchRepoEntries(repoUrls);
  const warnings: ReconciliationWarning[] = repoFetch.failedRepos.map((repo) => ({
    kind: "repo_lookup_failed",
    message: `Extension repo could not be checked: ${repo}`,
    details: repo,
  }));

  const installed = (sourcesData.sources.nodes ?? []).map<SourceInventoryEntry>((source) => ({
    sourceId: String(source.id),
    name: source.name,
    lang: source.lang,
    displayName: source.displayName,
    kind: "installed",
    extensionPkgName: null,
    extensionName: null,
    extensionInstalled: true,
  }));

  const availableByPkg = new Map(
    (extensionsData.fetchExtensions.extensions ?? []).map((extension) => [extension.pkgName, extension] as const),
  );

  const availableExtensions: AvailableExtensionEntry[] = [];
  const repoEntriesByPkg = new Map<string, RepoExtensionEntry>();
  for (const entry of repoFetch.entries) {
    if (!repoEntriesByPkg.has(entry.pkg)) repoEntriesByPkg.set(entry.pkg, entry);
  }

  for (const extension of extensionsData.fetchExtensions.extensions ?? []) {
    const repoEntry = repoEntriesByPkg.get(extension.pkgName);
    availableExtensions.push({
      ...extension,
      repoSources: repoEntry ? buildRepoSourceLookup(repoEntry) : [],
    });
  }

  const repoEntries = repoFetch.entries.flatMap<SourceInventoryEntry>((entry) => {
    const ext = availableByPkg.get(entry.pkg);
    return (entry.sources ?? []).map((source) => ({
      sourceId: String(source.id),
      name: source.name,
      lang: source.lang ?? entry.lang ?? "all",
      displayName: source.name,
      kind: "repo",
      extensionPkgName: entry.pkg,
      extensionName: entry.name,
      extensionInstalled: ext?.isInstalled ?? false,
    }));
  });

  return {
    inventory: dedupeSourceInventory([...installed, ...repoEntries]),
    availableExtensions,
    warnings,
    repoUrls,
  };
}

export async function loadNovelSourceInventory(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<{
  inventory: ContentSourceInventoryEntry[];
  warnings: ReconciliationWarning[];
}> {
  const state = await loadNovelRepositoryState(scopeInput);
  const repositoryById = new Map(state.repositories.map((entry) => [entry.id, entry] as const));

  const installed = state.installedPlugins.flatMap<ContentSourceInventoryEntry>((plugin) => {
    const catalog = state.catalogEntries.find((entry) => (
      entry.repositoryId === plugin.repositoryId
      && entry.pluginId === plugin.pluginId
      && entry.version === plugin.version
    )) ?? state.catalogEntries.find((entry) => entry.pluginId === plugin.pluginId);

    if (!catalog) return [];

    return [{
      contentKind: "novel",
      sourceId: plugin.pluginId,
      name: catalog.name,
      lang: catalog.lang,
      displayName: catalog.name,
      kind: "installed",
      extensionPkgName: plugin.pluginId,
      extensionName: catalog.name,
      extensionInstalled: plugin.enabled,
    }];
  });

  const repoEntries = state.catalogEntries.map<ContentSourceInventoryEntry>((entry) => ({
    contentKind: "novel",
    sourceId: entry.pluginId,
    name: entry.name,
    lang: entry.lang,
    displayName: entry.name,
    kind: "repo",
    extensionPkgName: entry.pluginId,
    extensionName: entry.name,
    extensionInstalled: state.installedPlugins.some((plugin) => plugin.pluginId === entry.pluginId && plugin.enabled),
  }));

  const warnings: ReconciliationWarning[] = state.repositories
    .filter((entry) => entry.enabled && entry.lastError)
    .map((entry) => ({
      kind: "repo_lookup_failed",
      message: `Novel repository could not be checked: ${entry.url}`,
      details: entry.lastError ?? undefined,
    }));

  return {
    inventory: dedupeContentSourceInventory([
      ...installed,
      ...repoEntries.filter((entry) => repositoryById.has(state.catalogEntries.find((catalog) => catalog.pluginId === entry.sourceId)?.repositoryId ?? "")),
    ]),
    warnings,
  };
}

export async function loadContentSourceInventory(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<{
  inventory: ContentSourceInventoryEntry[];
  availableExtensions: AvailableExtensionEntry[];
  warnings: ReconciliationWarning[];
  repoUrls: string[];
}> {
  const manga = await loadSourceInventory();
  const novels = await loadNovelSourceInventory(scopeInput);
  return {
    inventory: dedupeContentSourceInventory([
      ...manga.inventory.map((entry) => ({ ...entry, contentKind: "manga" as const })),
      ...novels.inventory,
    ]),
    availableExtensions: manga.availableExtensions,
    warnings: [...manga.warnings, ...novels.warnings],
    repoUrls: manga.repoUrls,
  };
}
