import { gql } from "../client";
import { fetchRepoEntries, type RepoExtensionEntry } from "../extensionSourceMap";
import { FETCH_EXTENSIONS, GET_SETTINGS, GET_SOURCES } from "../queries";
import type { Extension, Source } from "../types";
import type { AvailableExtensionEntry, ReconciliationWarning, RepoExtensionLookup, SourceInventoryEntry } from "./types";

function dedupeSourceInventory(entries: SourceInventoryEntry[]): SourceInventoryEntry[] {
  const seen = new Map<string, SourceInventoryEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.sourceId}:${entry.lang}:${entry.displayName}`;
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
  const [sourcesData, settingsData, extensionsData] = await Promise.all([
    gql<{ sources: { nodes: Source[] } }>(GET_SOURCES),
    gql<{ settings: { extensionRepos: string[] } }>(GET_SETTINGS),
    gql<{ fetchExtensions: { extensions: Extension[] } }>(FETCH_EXTENSIONS),
  ]);

  const repoUrls = settingsData.settings.extensionRepos ?? [];
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
