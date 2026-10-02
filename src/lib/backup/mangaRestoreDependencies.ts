import type { NativeSourceRestoreChoice, ReconciliationClusterResult } from "../reconciliation/types";
import { extensionStoreBaseUrl, extensionStoreIndexCandidates } from "../manga/runtime/storeUrl";
import { loadSettingsStorageRuntime } from "./storageRuntime";

export interface MangaDependencyPlan {
  repositories: readonly { id: string; indexUrl: string }[];
  requiredRepositories: string[];
  extensions: readonly { packageName: string; storeId: string | null; isInstalled: boolean; name?: string }[];
  sources: ReconciliationClusterResult[];
  warnings: Array<string | { kind: string; message: string }>;
}

export function createMangaRestoreDependencySession(deps: {
  target(): string;
  inspect(): Promise<MangaDependencyPlan>;
  admit(): Promise<() => Promise<void>>;
  install(packageName: string): Promise<void>;
  add(url: string): Promise<void>;
}) {
  const target = deps.target();
  let running = false;
  const validate = () => { if (deps.target() !== target) throw Error("RESTORE_TARGET_CHANGED"); };
  async function inspect() { validate(); const plan = await deps.inspect(); validate(); return plan; }
  async function prepare(action: (plan: MangaDependencyPlan) => Promise<void>) {
    validate(); if (running) throw Error("RESTORE_CONFLICT");
    running = true;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await deps.admit(); validate();
      const plan = await inspect(); validate();
      await action(plan); validate();
      return await inspect();
    } finally { try { await release?.(); } finally { running = false; } }
  }
  return { inspect,
    install(approval: { packageName: string; storeId: string }) {
      const { packageName, storeId } = approval;
      return prepare(async plan => {
        const matches = plan.extensions.filter(extension => extension.packageName === packageName);
        if (matches.length !== 1 || matches[0].storeId !== storeId || !plan.repositories.some(repo => repo.id === storeId)) throw Error("RESTORE_EXTENSION_ORIGIN_CHANGED");
        if (!matches[0].isInstalled) await deps.install(packageName);
      });
    },
    addRepository(url: string) {
      return prepare(async plan => {
        if (!plan.requiredRepositories.includes(url)) throw Error("RESTORE_REPOSITORY_NOT_REQUESTED");
        if (!plan.repositories.some(repo => extensionStoreBaseUrl(repo.indexUrl) === extensionStoreBaseUrl(url))) await deps.add(url);
      });
    },
    installMany(approvals: Array<{ packageName: string; storeId: string }>) {
      return prepare(async plan => {
        for (const { packageName, storeId } of approvals) {
          const matches = plan.extensions.filter(extension => extension.packageName === packageName);
          if (matches.length !== 1 || matches[0].storeId !== storeId || !plan.repositories.some(repo => repo.id === storeId)) throw Error("RESTORE_EXTENSION_ORIGIN_CHANGED");
          if (!matches[0].isInstalled) await deps.install(packageName);
        }
      });
    },
    async addRepositories(urls: string[]) {
      const failed: string[] = [];
      const plan = await prepare(async current => {
        for (const url of urls) {
          if (!current.requiredRepositories.includes(url)) throw Error("RESTORE_REPOSITORY_NOT_REQUESTED");
          if (current.repositories.some(repo => extensionStoreBaseUrl(repo.indexUrl) === extensionStoreBaseUrl(url))) continue;
          try { await deps.add(url); } catch { failed.push(url); }
        }
      });
      return { plan, failed };
    },
  };
}

export async function createProductionMangaDependencySession(file: File, format: "native" | "epigraph") {
  const [{ store, bumpContentSetupVersion }, { getManagedSourceRuntime }, { invoke }, { gql }, { GET_TRACKERS }] = await Promise.all([
    import("../../store/state.svelte"), import("../manga/runtime"), import("@tauri-apps/api/core"), import("../client"), import("../startupQueries"),
  ]);
  const profileId = store.runtimeResolvedLocalProfileId;
  const target = () => JSON.stringify([store.runtimeResolvedLocalProfileId, store.runtimeServerUrl]);
  const frozen = target();
  const validate = () => { if (target() !== frozen) throw Error("RESTORE_TARGET_CHANGED"); };
  const storage = await loadSettingsStorageRuntime(); validate();
  const runtime = await getManagedSourceRuntime(); validate();
  const native = format === "epigraph" ? await storage.extractEpigraphMangaPayloadFile(await file.arrayBuffer()) : file;
  const bytes = new Uint8Array(await native.arrayBuffer()); validate();
  return createMangaRestoreDependencySession({ target,
    inspect: async () => {
      validate();
      const [inventory, trackers, overlay, repositories, extensions] = await Promise.all([
        storage.loadSourceInventory(), gql<{ trackers: { nodes: import("../types").Tracker[] } }>(GET_TRACKERS), storage.readOverlayFile(), runtime.listStores(), runtime.listExtensions(),
      ]); validate();
      const parsed = await storage.parseMihonBackup(bytes, inventory.inventory); validate();
      const { analysis } = await storage.analyzeBackupReconciliation(bytes, inventory.inventory, trackers.trackers.nodes ?? [], overlay); validate();
      const sources = [...analysis.exactMatches, ...analysis.autoReconciled, ...analysis.needsReview, ...analysis.unresolved];
      const packages = new Set(sources.flatMap(source => source.candidates.map(candidate => candidate.extensionPkgName)).filter(Boolean));
      return { repositories, requiredRepositories: parsed.extensionStores.map(repo => repo.indexUrl),
        extensions: extensions.filter(extension => packages.has(extension.packageName)), sources,
        warnings: [...inventory.warnings, ...analysis.warnings] };
    },
    admit: async () => {
      validate(); const token = await invoke<string>("restore_session_admit", { profileId });
      if (typeof token !== "string" || !token) throw Error("RESTORE_SESSION_UNAVAILABLE");
      return () => invoke<void>("restore_session_release", { token });
    },
    install: async packageName => { validate(); await runtime.installExtension({ packageName, assertTarget: validate }); validate(); bumpContentSetupVersion(); },
    add: async url => {
      validate();
      let lastError: unknown = null;
      for (const indexUrl of extensionStoreIndexCandidates(url)) {
        try {
          await runtime.addStore({ indexUrl, assertTarget: validate });
          lastError = null;
          break;
        } catch (error) {
          validate();
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      validate(); await runtime.refreshExtensions(undefined, validate); validate(); bumpContentSetupVersion();
    },
  });
}

export type MangaRestoreChoices = Record<string, NativeSourceRestoreChoice>;
