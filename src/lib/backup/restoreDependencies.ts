import { planNovelRestoreDependencies, provisionEpigraphNovelDependencies } from "./novelsRestoreProvisioning";
import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";
import type { PersistedNovelRepositoryState } from "../novels/repositoryState";

export type NovelDependencyApproval = NonNullable<Parameters<typeof provisionEpigraphNovelDependencies>[0]["approvals"]>;
export type NovelDependencyPlan = ReturnType<typeof planNovelRestoreDependencies>;
export function createNovelRestoreDependencySession(deps: {
  target(): string;
  snapshot: RestoredEpigraphNovelsSnapshot;
  load(): Promise<PersistedNovelRepositoryState>;
  admit(): Promise<() => Promise<void>>;
  provision(state: PersistedNovelRepositoryState, approvals: NovelDependencyApproval, validate: () => void): Promise<Awaited<ReturnType<typeof provisionEpigraphNovelDependencies>>>;
}) {
  const frozenTarget = deps.target();
  const snapshot = structuredClone(deps.snapshot);
  let running = false;
  const validate = () => { if (deps.target() !== frozenTarget) throw Error("RESTORE_TARGET_CHANGED"); };
  async function inspect() {
    validate(); const state = await deps.load(); validate();
    return planNovelRestoreDependencies(snapshot, state);
  }
  async function apply(approvals: NovelDependencyApproval) {
    validate();
    if (running) throw Error("RESTORE_CONFLICT");
    const frozenApproval = { repositoryUrls: [...approvals.repositoryUrls], plugins: { ...approvals.plugins } };
    running = true;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await deps.admit(); validate();
      const state = await deps.load(); validate();
      const result = await deps.provision(state, frozenApproval, validate); validate();
      return { plan: await inspect(), warnings: result.warnings };
    } finally { try { await release?.(); } finally { running = false; } }
  }
  return { inspect, apply };
}

export async function createProductionNovelDependencySession(file: File, format: "epigraph" | "lnreader") {
  const [{ store, bumpContentSetupVersion }, { loadSettingsStorageRuntime }, { invoke }] = await Promise.all([
    import("../../store/state.svelte"), import("./storageRuntime"), import("@tauri-apps/api/core"),
  ]);
  const scope = { profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl };
  const target = () => JSON.stringify([store.runtimeResolvedLocalProfileId, store.runtimeServerUrl]);
  const expected = target();
  const validate = () => { if (target() !== expected) throw Error("RESTORE_TARGET_CHANGED"); };
  const runtime = await loadSettingsStorageRuntime(); validate();
  const bytes = await file.arrayBuffer(); validate();
  const absent = { repositoryUrls: [], installedPluginIds: [], availableSourceIds: [] };
  const snapshot = format === "lnreader" ? await runtime.restoreLnReaderNovelsBackup(bytes, absent) : await runtime.restoreEpigraphNovelsPayload(bytes, absent);
  validate();
  return createNovelRestoreDependencySession({ target, snapshot,
    load: () => runtime.loadNovelRepositoryState(scope),
    admit: async () => {
      const token = await invoke<string>("restore_session_admit", { profileId: scope.profileId });
      if (!token) throw Error("RESTORE_SESSION_UNAVAILABLE");
      return () => invoke<void>("restore_session_release", { token });
    },
    provision: async (state, approvals, assertTarget) => {
      const result = await provisionEpigraphNovelDependencies({ restored: snapshot, state, approvals, scopeInput: scope, operations: {
        addRepository: (current, input) => { assertTarget(); return runtime.addNovelRepositoryToState(current, input); },
        trustRepository: (current, id, trust) => { assertTarget(); return runtime.setNovelRepositoryTrustState(current, id, trust); },
        refreshRepository: async (current, id) => { assertTarget(); const refreshed = await runtime.refreshNovelRepositoryCatalog(current, id); assertTarget(); return refreshed; },
        installPlugin: async input => { assertTarget(); const installed = await runtime.installNovelCatalogPlugin(input); assertTarget(); return installed; },
        saveState: async current => { assertTarget(); const saved = await runtime.saveNovelRepositoryState(current, scope); assertTarget(); return saved; },
      } });
      assertTarget(); bumpContentSetupVersion(); return result;
    },
  });
}
