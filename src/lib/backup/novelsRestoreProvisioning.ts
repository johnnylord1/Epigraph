import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";
import { novelRepositoryUrlKey, type NovelCatalogEntry } from "../novels/contracts";
import type {
  NovelRepositoryRefreshResult,
  NovelRepositoryScopeInput,
  PersistedNovelRepositoryState,
} from "../novels/repositoryState";

export type NovelRestoreProvisioningWarning = {
  code: "repository-refresh-failed" | "plugin-not-found" | "plugin-install-failed" | "approval-required" | "plugin-origin-conflict" | "plugin-ambiguous";
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
  return novelRepositoryUrlKey(value);
}

type NovelDependencyRequirements = Pick<RestoredEpigraphNovelsSnapshot, "entries" | "plugins" | "repositories">;

function requiredRepositoryUrls(restored: NovelDependencyRequirements): string[] {
  return [...new Set([
    ...(restored.repositories ?? []).map((entry) => entry.url),
    ...(restored.plugins ?? []).map((entry) => entry.repositoryUrl ?? ""),
    ...restored.entries.map((entry) => entry.source?.repositoryUrl ?? ""),
  ].map(normalizedUrl).filter(Boolean))];
}

export function requiredNovelRestorePlugins(restored: Pick<RestoredEpigraphNovelsSnapshot, "entries" | "plugins">) {
  const requirements = new Map<string, Set<string>>();
  for (const plugin of [
    ...(restored.plugins ?? []),
    ...restored.entries.map(entry => ({ id: entry.source?.pluginId ?? "", repositoryUrl: entry.source?.repositoryUrl })),
  ]) {
    const pluginId = plugin.id.trim();
    if (!pluginId) continue;
    const urls = requirements.get(pluginId) ?? new Set<string>();
    if (plugin.repositoryUrl) urls.add(normalizedUrl(plugin.repositoryUrl));
    requirements.set(pluginId, urls);
  }
  return [...requirements].map(([pluginId, urls]) => ({ pluginId, repositoryUrls: [...urls].sort() }));
}

export function planNovelRestoreDependencies(restored: Pick<RestoredEpigraphNovelsSnapshot, "entries" | "plugins" | "repositories">, state: PersistedNovelRepositoryState) {
  return {
    plugins: requiredNovelRestorePlugins(restored).map(requirement => {
      const installed = state.installedPlugins.filter(plugin => plugin.pluginId === requirement.pluginId);
      const candidates = state.repositories.filter(repository =>
        state.catalogEntries.some(entry => entry.repositoryId === repository.id && entry.pluginId === requirement.pluginId)
        || requirement.repositoryUrls.includes(normalizedUrl(repository.normalizedUrl))
        || installed.some(plugin => plugin.repositoryId === repository.id))
        .map(repository => ({ repositoryUrl: normalizedUrl(repository.normalizedUrl), repositoryId: repository.id,
          trusted: repository.trustState === "trusted", enabled: repository.enabled }));
      for (const repositoryUrl of requirement.repositoryUrls) {
        if (!candidates.some(candidate => candidate.repositoryUrl === repositoryUrl)) candidates.push({ repositoryUrl, repositoryId: "", trusted: false, enabled: false });
      }
      const usable = installed.filter(plugin => plugin.enabled && !plugin.disabledReason && candidates.some(candidate =>
        candidate.repositoryId === plugin.repositoryId && candidate.trusted && candidate.enabled
        && (requirement.repositoryUrls.length === 0 || requirement.repositoryUrls.includes(candidate.repositoryUrl))));
      const conflict = requirement.repositoryUrls.length > 1 || installed.length > 1
        || installed.some(plugin => requirement.repositoryUrls.length === 1 && !candidates.some(candidate => candidate.repositoryId === plugin.repositoryId && candidate.repositoryUrl === requirement.repositoryUrls[0]));
      return { ...requirement, candidates: candidates.sort((a, b) => a.repositoryUrl.localeCompare(b.repositoryUrl)),
        selectedRepositoryUrl: requirement.repositoryUrls.length === 1 ? requirement.repositoryUrls[0] : null,
        status: conflict ? "conflict" as const : usable.length === 1 ? "ready" as const
          : candidates.length === 0 ? "missing" as const : "needs-selection" as const };
    }),
  };
}

export function novelRestoreRuntimeState(state: PersistedNovelRepositoryState) {
  const repositories = state.repositories.filter(repository => repository.enabled && repository.trustState === "trusted");
  const plugins = state.installedPlugins.filter(plugin => plugin.enabled && !plugin.disabledReason
    && repositories.some(repository => repository.id === plugin.repositoryId)).map(plugin => plugin.pluginId);
  return { repositoryUrls: repositories.map(repository => repository.normalizedUrl), installedPluginIds: plugins, availableSourceIds: plugins };
}

export async function provisionEpigraphNovelDependencies(input: {
  restored: NovelDependencyRequirements;
  state: PersistedNovelRepositoryState;
  scopeInput: NovelRepositoryScopeInput;
  operations: NovelRestoreProvisioningOperations;
  approvals?: { repositoryUrls: readonly string[]; plugins: Readonly<Record<string, string>> };
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
  const approvedRepositories = new Set((input.approvals?.repositoryUrls ?? []).map(normalizedUrl));
  const refreshedRepositories = new Set<string>();

  const selectedRepositories = requiredNovelRestorePlugins(input.restored)
    .filter(requirement => requirement.repositoryUrls.length < 2)
    .map(requirement => input.approvals?.plugins[requirement.pluginId] ?? "").map(normalizedUrl).filter(Boolean);
  for (const repositoryUrl of new Set([...requiredRepositoryUrls(input.restored), ...selectedRepositories])) {
    if (!approvedRepositories.has(repositoryUrl)) {
      warnings.push({ code: "approval-required", repositoryUrl, message: "Review and approve this repository before provisioning." });
      continue;
    }
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
      } else refreshedRepositories.add(repository.id);
    } catch (error) {
      warnings.push({
        code: "repository-refresh-failed",
        repositoryUrl,
        message: error instanceof Error ? error.message : `Could not refresh ${repositoryUrl}.`,
      });
    }
  }

  for (const requirement of requiredNovelRestorePlugins(input.restored)) {
    const { pluginId, repositoryUrls } = requirement;
    if (repositoryUrls.length > 1) {
      warnings.push({ code: "plugin-origin-conflict", pluginId, message: "The backup records conflicting repositories for this plugin. Resolve its provenance before installing." });
      continue;
    }
    const repositoryUrl = repositoryUrls[0] ?? null;
    const selectedUrl = input.approvals?.plugins[pluginId];
    if (!selectedUrl) {
      warnings.push({ code: "approval-required", pluginId, message: "Choose and approve a repository for this plugin before installing." });
      continue;
    }
    if (repositoryUrl && normalizedUrl(selectedUrl) !== repositoryUrl) {
      warnings.push({ code: "plugin-origin-conflict", pluginId, message: "The selected repository differs from the backup. Resolve this conflict before installing." });
      continue;
    }
    const sourceRepository = state.repositories.find(repository => normalizedUrl(repository.normalizedUrl) === normalizedUrl(selectedUrl));
    const requiredRepositoryId = sourceRepository?.id ?? null;
    if (!sourceRepository?.enabled || sourceRepository.trustState !== "trusted") {
      warnings.push({ code: "plugin-not-found", pluginId, message: "The selected plugin repository is not available and trusted." });
      continue;
    }
    if (state.installedPlugins.some(entry => entry.pluginId === pluginId && entry.repositoryId !== requiredRepositoryId)) {
      warnings.push({ code: "plugin-origin-conflict", pluginId, message: "This plugin is installed from another repository. Preserve it until the conflict is resolved." });
      continue;
    }
    const alreadyInstalled = state.installedPlugins.some((entry) => (
      entry.enabled
      && entry.pluginId === pluginId
      && !entry.disabledReason
      && entry.repositoryId === requiredRepositoryId
    ));
    if (alreadyInstalled) continue;
    if (state.installedPlugins.some(entry => entry.pluginId === pluginId)) {
      warnings.push({ code: "plugin-install-failed", pluginId, message: "This plugin is already installed but needs attention. Enable or repair it in Sources to preserve its settings." });
      continue;
    }
    if (!refreshedRepositories.has(sourceRepository.id)) {
      warnings.push({ code: "repository-refresh-failed", pluginId, repositoryUrl: normalizedUrl(selectedUrl), message: "Refresh the approved repository successfully before installing this plugin." });
      continue;
    }
    const candidates = state.catalogEntries.filter((candidate) => (
      candidate.pluginId === pluginId
      && candidate.repositoryId === requiredRepositoryId
    ));
    if (candidates.length > 1) {
      warnings.push({ code: "plugin-ambiguous", pluginId, message: "The selected repository contains conflicting plugin candidates. Refresh and review it before installing." });
      continue;
    }
    const entry = candidates[0];
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
