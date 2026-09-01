import type { ParsedBackupExtensionStore } from "../reconciliation/types";

export interface BackupRepositoryPreview {
  url: string;
  name: string;
}

export interface BackupPluginPreview {
  id: string;
  name: string;
  repositoryUrl: string | null;
}

export interface BackupDependencyPreview {
  titleCount: number | null;
  chapterCount: number | null;
  repositories: BackupRepositoryPreview[];
  plugins: BackupPluginPreview[];
  requiresConfirmation: boolean;
}

interface DependencyPreviewInput {
  titleCount?: number | null;
  chapterCount?: number | null;
  mangaStores?: readonly ParsedBackupExtensionStore[];
  repositories?: readonly { url: string; name?: string | null }[];
  plugins?: readonly { id: string; name?: string | null; repositoryUrl?: string | null }[];
}

function normalizedUrl(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function buildBackupDependencyPreview(input: DependencyPreviewInput): BackupDependencyPreview {
  const repositories: BackupRepositoryPreview[] = [];
  const seenRepositories = new Set<string>();
  for (const candidate of [
    ...(input.mangaStores ?? []).map((store) => ({ url: store.indexUrl, name: store.name })),
    ...(input.repositories ?? []),
  ]) {
    const url = normalizedUrl(candidate.url);
    if (!url || seenRepositories.has(url)) continue;
    seenRepositories.add(url);
    repositories.push({ url, name: candidate.name?.trim() || "Extension repository" });
  }

  const plugins: BackupPluginPreview[] = [];
  const seenPlugins = new Set<string>();
  for (const candidate of input.plugins ?? []) {
    const id = candidate.id.trim();
    if (!id || seenPlugins.has(id)) continue;
    seenPlugins.add(id);
    plugins.push({
      id,
      name: candidate.name?.trim() || id,
      repositoryUrl: normalizedUrl(candidate.repositoryUrl) || null,
    });
  }

  return {
    titleCount: typeof input.titleCount === "number" ? input.titleCount : null,
    chapterCount: typeof input.chapterCount === "number" ? input.chapterCount : null,
    repositories,
    plugins,
    requiresConfirmation: repositories.length > 0 || plugins.length > 0,
  };
}
