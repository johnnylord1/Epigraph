import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";
import type { NovelCatalogEntry } from "../novels/contracts";
import type {
  NovelRepositoryRefreshResult,
  NovelRepositoryScopeInput,
  PersistedNovelRepositoryState,
} from "../novels/repositoryState";

export type NovelRestoreProvisioningWarning = {
  code: "repository-refresh-failed" | "plugin-not-found" | "plugin-install-failed";
  message: string;
  repositoryUrl?: string;
  pluginId?: string;
};

export interface NovelRestoreProvisioningOperations {
  addRepository(
    state: PersistedNovelRepositoryState,
    input: { profileId?: string | null; url: string; recommendedSeed?: boolean },
  ): PersistedNovelRepositoryState;
  trustRepository(
    state: PersistedNovelRepositoryState,
    repositoryId: string,
    trustState: "trusted",
  ): PersistedNovelRepositoryState;
  refreshRepository(
    state: PersistedNovelRepositoryState,
    repositoryId: string,
  ): Promise<NovelRepositoryRefreshResult>;
  installPlugin(input: {
    state: PersistedNovelRepositoryState;
    entry: NovelCatalogEntry;
    scopeInput?: NovelRepositoryScopeInput;
  }): Promise<PersistedNovelRepositoryState>;
  saveState(
    state: PersistedNovelRepositoryState,
    scopeInput?: NovelRepositoryScopeInput,
  ): Promise<PersistedNovelRepositoryState>;
}

function normalizedUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function requiredRepositoryUrls(restored: RestoredEpigraphNovelsSnapshot): string[] {
  return [...new Set([
    ...(restored.repositories ?? []).map((entry) => entry.url),
    ...(restored.plugins ?? []).map((entry) => entry.repositoryUrl ?? ""),
    ...restored.entries.map((entry) => entry.source?.repositoryUrl ?? ""),
  ].map(normalizedUrl).filter(Boolean))];
}

function requiredPluginIds(restored: RestoredEpigraphNovelsSnapshot): string[] {
  return [...new Set([
    ...(restored.plugins ?? []).map((entry) => entry.id),
    ...restored.entries.map((entry) => entry.source?.pluginId ?? entry.source?.sourceId ?? ""),
  ].map((value) => value.trim()).filter(Boolean))];
}

export async function provisionEpigraphNovelDependencies(input: {
  restored: RestoredEpigraphNovelsSnapshot;
  state: PersistedNovelRepositoryState;
  scopeInput: NovelRepositoryScopeInput;
  operations: NovelRestoreProvisioningOperations;
}): Promise<{
  state: PersistedNovelRepositoryState;
  addedRepositories: number;
  installedPlugins: number;
  warnings: NovelRestoreProvisioningWarning[];
}> {
  let state = input.state;
  let addedRepositories = 0;
  let installedPlugins = 0;
  const warnings: NovelRestoreProvisioningWarning[] = [];

  for (const repositoryUrl of requiredRepositoryUrls(input.restored)) {
    let repository = state.repositories.find(
      (entry) => normalizedUrl(entry.normalizedUrl) === repositoryUrl,
    );
    if (!repository) {
      state = input.operations.addRepository(state, {
        profileId: input.scopeInput.profileId,
        url: repositoryUrl,
        recommendedSeed: false,
      });
      repository = state.repositories.find(
        (entry) => normalizedUrl(entry.normalizedUrl) === repositoryUrl,
      );
      addedRepositories += 1;
    }
    if (!repository) continue;

    if (repository.trustState !== "trusted") {
      state = input.operations.trustRepository(state, repository.id, "trusted");
    }
    state = await input.operations.saveState(state, input.scopeInput);
    try {
      const refreshed = await input.operations.refreshRepository(state, repository.id);
      state = refreshed.state;
      state = await input.operations.saveState(state, input.scopeInput);
      if (refreshed.status === "error") {
        warnings.push({
          code: "repository-refresh-failed",
          repositoryUrl,
          message: refreshed.repository.lastError ?? `Could not refresh ${repositoryUrl}.`,
        });
      }
    } catch (error) {
      warnings.push({
        code: "repository-refresh-failed",
        repositoryUrl,
        message: error instanceof Error ? error.message : `Could not refresh ${repositoryUrl}.`,
      });
    }
  }

  const installed = new Set(state.installedPlugins.filter((entry) => entry.enabled).map((entry) => entry.pluginId));
  for (const pluginId of requiredPluginIds(input.restored)) {
    if (installed.has(pluginId)) continue;
    const entry = state.catalogEntries.find((candidate) => candidate.pluginId === pluginId);
    if (!entry) {
      warnings.push({
        code: "plugin-not-found",
        pluginId,
        message: `The source ${pluginId} is no longer available in the restored repositories.`,
      });
      continue;
    }
    try {
      state = await input.operations.installPlugin({
        state,
        entry,
        scopeInput: input.scopeInput,
      });
      state = await input.operations.saveState(state, input.scopeInput);
      installed.add(pluginId);
      installedPlugins += 1;
    } catch (error) {
      warnings.push({
        code: "plugin-install-failed",
        pluginId,
        message: error instanceof Error ? error.message : `Could not install ${pluginId}.`,
      });
    }
  }

  return { state, addedRepositories, installedPlugins, warnings };
}
