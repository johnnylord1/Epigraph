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

function requiredPlugins(restored: RestoredEpigraphNovelsSnapshot): Array<{ pluginId: string; repositoryUrl: string | null }> {
  const requirements = new Map<string, { pluginId: string; repositoryUrl: string | null }>();
  for (const plugin of restored.plugins ?? []) {
    const pluginId = plugin.id.trim();
    if (!pluginId) continue;
    requirements.set(pluginId, {
      pluginId,
      repositoryUrl: plugin.repositoryUrl ? normalizedUrl(plugin.repositoryUrl) : null,
    });
  }
  for (const restoredEntry of restored.entries) {
    const pluginId = (restoredEntry.source?.pluginId ?? restoredEntry.source?.sourceId ?? "").trim();
    if (!pluginId) continue;
    const repositoryUrl = restoredEntry.source?.repositoryUrl
      ? normalizedUrl(restoredEntry.source.repositoryUrl)
      : null;
    const current = requirements.get(pluginId);
    if (!current || (!current.repositoryUrl && repositoryUrl)) {
      requirements.set(pluginId, { pluginId, repositoryUrl });
    }
  }
  return [...requirements.values()];
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

  for (const requirement of requiredPlugins(input.restored)) {
    const { pluginId, repositoryUrl } = requirement;
    const requiredRepositoryId = repositoryUrl
      ? state.repositories.find((repository) => normalizedUrl(repository.normalizedUrl) === repositoryUrl)?.id ?? null
      : null;
    const alreadyInstalled = state.installedPlugins.some((entry) => (
      entry.enabled
      && entry.pluginId === pluginId
      && (!repositoryUrl || (requiredRepositoryId !== null && entry.repositoryId === requiredRepositoryId))
    ));
    if (alreadyInstalled) continue;
    const entry = state.catalogEntries.find((candidate) => (
      candidate.pluginId === pluginId
      && (!repositoryUrl || candidate.repositoryId === requiredRepositoryId)
    ));
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
