import type { SyncdNovelDependencyDeclaration, SyncdNovelDependencyRemoval } from "../syncdDesktop";
import { novelRepositoryMatchKey, type PersistedNovelRepositoryState } from "./repositoryState";

export interface SyncedNovelDependencyPlan {
  repositories: { url: string }[];
  plugins: { id: string; repositoryUrl: string }[];
  approvals: { repositoryUrls: string[]; plugins: Record<string, string> };
  /** Keys to remember once this plan runs, so a failing install waits before it is tried again. */
  attemptKeys: string[];
}

/**
 * What the paired devices declared through Syncd and this desktop still lacks.
 *
 * Both devices are sources of the library, so a repository or plugin configured on the phone is
 * installed here too. Plugins always come from the declared repository, never from Syncd. A
 * repository this desktop already has keeps its local trust and enabled state: a disabled or
 * untrusted repository is not used. Removals come from the replica plan, never from this list.
 */
export function missingSyncedNovelDependencies(
  declarations: readonly SyncdNovelDependencyDeclaration[],
  state: PersistedNovelRepositoryState,
  attempted: ReadonlySet<string> = new Set(),
): SyncedNovelDependencyPlan {
  const declaredUrls = new Map<string, string>();
  for (const declaration of declarations) {
    if (declaration.kind === "repository" && declaration.enabled) {
      declaredUrls.set(declaration.repositoryId, declaration.canonicalUrl);
    }
  }
  const localRepositories = new Map(
    state.repositories.map((repository) => [novelRepositoryMatchKey(repository.normalizedUrl), repository]),
  );
  const repositoryUrls = new Set<string>();
  const attemptKeys: string[] = [];

  for (const url of new Set(declaredUrls.values())) {
    const key = `${novelRepositoryMatchKey(url)}|`;
    if (localRepositories.has(novelRepositoryMatchKey(url)) || attempted.has(key)) continue;
    repositoryUrls.add(url);
    attemptKeys.push(key);
  }

  const pluginUrls = new Map<string, Set<string>>();
  const pluginKeys = new Map<string, string[]>();
  for (const declaration of declarations) {
    if (declaration.kind !== "plugin" || !declaration.enabled) continue;
    const declaredUrl = declaredUrls.get(declaration.repositoryId);
    if (!declaredUrl) continue;
    if (state.installedPlugins.some((plugin) => plugin.pluginId === declaration.pluginId)) continue;
    const local = localRepositories.get(novelRepositoryMatchKey(declaredUrl));
    if (local && (!local.enabled || local.trustState !== "trusted")) continue;
    const url = local?.normalizedUrl ?? declaredUrl;
    const key = `${novelRepositoryMatchKey(url)}|${declaration.pluginId}@${declaration.version}`;
    if (attempted.has(key)) continue;
    pluginUrls.set(declaration.pluginId, (pluginUrls.get(declaration.pluginId) ?? new Set()).add(url));
    pluginKeys.set(declaration.pluginId, [...(pluginKeys.get(declaration.pluginId) ?? []), key]);
  }

  const plugins: SyncedNovelDependencyPlan["plugins"] = [];
  for (const [id, urls] of pluginUrls) {
    // Declared by two repositories: the user resolves the origin in Sources.
    if (urls.size !== 1) continue;
    const [repositoryUrl] = urls;
    plugins.push({ id, repositoryUrl });
    repositoryUrls.add(repositoryUrl);
    attemptKeys.push(...pluginKeys.get(id)!);
  }

  return {
    repositories: [...repositoryUrls].map((url) => ({ url })),
    plugins,
    approvals: {
      repositoryUrls: [...repositoryUrls],
      plugins: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.repositoryUrl])),
    },
    attemptKeys,
  };
}

/** How long a failed install waits before the next sync tries it again. */
export const SYNCED_DEPENDENCY_RETRY_MS = 5 * 60_000;

/** Keys attempted within the retry window; older ones are forgotten so they are tried again. */
export function recentSyncedDependencyAttempts(attempts: Map<string, number>, nowMs: number): Set<string> {
  for (const [key, attemptedAtMs] of attempts) {
    if (nowMs - attemptedAtMs >= SYNCED_DEPENDENCY_RETRY_MS) attempts.delete(key);
  }
  return new Set(attempts.keys());
}

/**
 * Removes here what another device deleted after both held it, plugins before their repository.
 * Entries already gone are skipped, and a built-in repository is never removed.
 */
export async function applySyncedNovelDependencyRemovals(
  state: PersistedNovelRepositoryState,
  removals: readonly SyncdNovelDependencyRemoval[],
  operations: {
    removePlugin: (state: PersistedNovelRepositoryState, pluginId: string) => Promise<PersistedNovelRepositoryState>;
    removeRepository: (state: PersistedNovelRepositoryState, repositoryId: string) => PersistedNovelRepositoryState;
  },
): Promise<{ state: PersistedNovelRepositoryState; removed: number }> {
  let removed = 0;
  for (const removal of removals) {
    if (removal.kind === "plugin") {
      if (!state.installedPlugins.some((plugin) => plugin.pluginId === removal.pluginId)) continue;
      state = await operations.removePlugin(state, removal.pluginId);
      removed++;
    } else {
      if (!state.repositories.some((repository) => repository.id === removal.localRepositoryId)) continue;
      const next = operations.removeRepository(state, removal.localRepositoryId);
      if (next === state) continue;
      state = next;
      removed++;
    }
  }
  return { state, removed };
}

const attemptedDependencies = new Map<string, number>();
let running: Promise<void> | null = null;
let rerun = false;

/**
 * Keeps this desktop on the list the paired devices share: installs what they declared and removes
 * what they deleted. One pass at a time; a call during a pass queues one more.
 */
export function reconcileSyncedNovelDependencies(profileId: string): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerun = false;
        // A pass that changed something runs once more, so the replica records what is held now.
        if (await reconcileOnce(profileId)) rerun = true;
      } while (rerun);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function reconcileOnce(profileId: string): Promise<boolean> {
  const [{ store, bumpContentSetupVersion }, { invoke }, { syncdPlanNovelDependencySync }, { loadSettingsStorageRuntime }, { provisionEpigraphNovelDependencies }, { normalizeLocalProfileId }, { removeNovelRepositoryFromState }, { removeInstalledNovelPlugin }] = await Promise.all([
    import("../../store/state.svelte"),
    import("@tauri-apps/api/core"),
    import("../syncdDesktop"),
    import("../backup/storageRuntime"),
    import("../backup/novelsRestoreProvisioning"),
    import("../localProfiles"),
    import("./repositoryState"),
    import("./packages"),
  ]);
  const scope = { profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl };
  const target = () => JSON.stringify([store.runtimeResolvedLocalProfileId, store.runtimeServerUrl]);
  const expected = target();
  const assertTarget = () => { if (target() !== expected) throw Error("SYNC_TARGET_CHANGED"); };
  if (normalizeLocalProfileId(scope.profileId) !== profileId) return false;

  const sync = await syncdPlanNovelDependencySync(profileId);
  if (sync.declarations.length === 0 && sync.removals.length === 0) return false;
  const runtime = await loadSettingsStorageRuntime(); assertTarget();
  const pending = (state: PersistedNovelRepositoryState) =>
    missingSyncedNovelDependencies(sync.declarations, state, recentSyncedDependencyAttempts(attemptedDependencies, Date.now()));
  if (sync.removals.length === 0 && pending(await runtime.loadNovelRepositoryState(scope)).attemptKeys.length === 0) return false;

  // Shares the restore lock, so a restore and this pass never write the repository state together.
  const token = await invoke<string>("restore_session_admit", { profileId });
  if (!token) throw Error("RESTORE_SESSION_UNAVAILABLE");
  try {
    assertTarget();
    let state = await runtime.loadNovelRepositoryState(scope); assertTarget();
    const removal = await applySyncedNovelDependencyRemovals(state, sync.removals, {
      removePlugin: async (current, pluginId) => { assertTarget(); const next = await removeInstalledNovelPlugin(current, pluginId, scope); assertTarget(); return next; },
      removeRepository: (current, repositoryId) => { assertTarget(); return removeNovelRepositoryFromState(current, repositoryId); },
    });
    if (removal.removed > 0) {
      state = await runtime.saveNovelRepositoryState(removal.state, scope); assertTarget();
      bumpContentSetupVersion();
    }

    const plan = pending(state);
    if (plan.attemptKeys.length === 0) return removal.removed > 0;
    const attemptedAtMs = Date.now();
    for (const key of plan.attemptKeys) attemptedDependencies.set(key, attemptedAtMs);
    const result = await provisionEpigraphNovelDependencies({
      restored: { entries: [], repositories: plan.repositories, plugins: plan.plugins },
      state,
      approvals: plan.approvals,
      scopeInput: scope,
      operations: {
        addRepository: (current, input) => { assertTarget(); return runtime.addNovelRepositoryToState(current, input); },
        trustRepository: (current, id, trust) => { assertTarget(); return runtime.setNovelRepositoryTrustState(current, id, trust); },
        refreshRepository: async (current, id) => { assertTarget(); const refreshed = await runtime.refreshNovelRepositoryCatalog(current, id); assertTarget(); return refreshed; },
        installPlugin: async (input) => { assertTarget(); const installed = await runtime.installNovelCatalogPlugin(input); assertTarget(); return installed; },
        saveState: async (current) => { assertTarget(); const saved = await runtime.saveNovelRepositoryState(current, scope); assertTarget(); return saved; },
      },
    });
    if (result.warnings.length > 0) console.warn("Synced novel dependencies need attention:", result.warnings);
    const installed = result.addedRepositories > 0 || result.installedPlugins > 0;
    if (installed) bumpContentSetupVersion();
    return installed || removal.removed > 0;
  } finally {
    await invoke<void>("restore_session_release", { token });
  }
}
