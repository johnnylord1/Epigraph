import { getManagedSourceRuntime, resolveExtensionStoreInputUrl } from "../manga/runtime";
import type { ExtensionRef } from "../manga/runtime/types";
import {
  addNovelRepositoryToState,
  isBuiltinNovelRepository,
  loadNovelRepositoryState,
  refreshNovelRepositoryCatalog,
  saveNovelRepositoryState,
  setNovelRepositoryTrustState,
  type PersistedNovelRepositoryState,
} from "../novels/repositoryState";
import { installNovelCatalogPlugin, setInstalledNovelPluginEnabled } from "../novels/packages";
import { resolveNovelRepositoryInputUrl } from "../novels/repositories";
import { bumpContentSetupVersion, store } from "../../store/state.svelte";
import { translate } from "../i18n/runtime";
import { waitForSuwayomiGraphqlReady } from "../suwayomiReadiness";

export type FirstRunSourceKind = "manga" | "novels";
export type FirstRunExtensionStatus = "idle" | "installing" | "installed" | "error";

export interface FirstRunExtension {
  id: string;
  name: string;
  lang: string;
  version: string;
  iconUrl: string | null;
  installed: boolean;
  status: FirstRunExtensionStatus;
  error?: string | null;
  action?: "install" | "enable";
  /** Adult-only extensions stay hidden unless the user opts in. */
  nsfw?: boolean;
}

export interface FirstRunRepository {
  id: string;
  kind: FirstRunSourceKind;
  url: string;
  name: string;
  /** The LNReader feed that ships with the app. */
  builtin?: boolean;
  extensions: FirstRunExtension[];
}

export interface FirstRunSourcesDependencies {
  addRepository(kind: FirstRunSourceKind, url: string): Promise<FirstRunRepository>;
  installExtension(repository: FirstRunRepository, extension: FirstRunExtension): Promise<void>;
  loadRepositories?(): Promise<readonly FirstRunRepository[] | { repositories: readonly FirstRunRepository[]; warnings: string[] }>;
}

function comparableUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function createFirstRunSourcesWorkflow(dependencies: FirstRunSourcesDependencies) {
  const repositories: FirstRunRepository[] = [];
  const listeners = new Set<() => void>();
  const pendingAdds = new Set<string>();
  let hydration: Promise<readonly FirstRunRepository[]> | null = null;
  let writes = 0;
  let warnings: string[] = [];

  function notify() { for (const listener of listeners) listener(); }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  }

  function hydrate(): Promise<readonly FirstRunRepository[]> {
    if (hydration) return hydration;
    if (!dependencies.loadRepositories) return Promise.resolve(repositories);
    if (writes) return Promise.reject(new Error("Wait for the current operation to finish before refreshing."));
    hydration = dependencies.loadRepositories().then((snapshot) => {
      const restored = "repositories" in snapshot ? snapshot.repositories : snapshot;
      warnings = "warnings" in snapshot ? snapshot.warnings : [];
      repositories.splice(0, repositories.length, ...restored.map((repository) => ({
        ...repository,
        extensions: repository.extensions.map((extension) => ({ ...extension })),
      })));
      notify();
      return repositories;
    }).finally(() => { hydration = null; });
    return hydration;
  }

  async function addRepository(kind: FirstRunSourceKind, rawUrl: string): Promise<FirstRunRepository> {
    if (hydration) await hydration;
    const url = rawUrl.trim();
    if (!url) throw new Error("Enter a repository URL.");
    const key = `${kind}:${comparableUrl(url)}`;
    if (pendingAdds.has(key) || repositories.some((entry) => entry.kind === kind && comparableUrl(entry.url) === comparableUrl(url))) {
      throw new Error("This repository is already added.");
    }
    pendingAdds.add(key);
    writes += 1;
    try {
      const repository = await dependencies.addRepository(kind, url);
      if (!repositories.some((entry) => entry.kind === kind && entry.id === repository.id)) repositories.push(repository);
      notify();
      return repository;
    } finally {
      pendingAdds.delete(key);
      writes -= 1;
    }
  }

  async function refreshRepository(repositoryId: string) {
    if (hydration) await hydration;
    if (writes) return;
    const index = repositories.findIndex((entry) => entry.id === repositoryId);
    if (index < 0) return;
    writes += 1;
    try {
      const repository = repositories[index];
      repositories[index] = await dependencies.addRepository(repository.kind, repository.url);
      notify();
    } finally { writes -= 1; }
  }

  async function installExtension(repositoryId: string, extensionId: string) {
    if (hydration) await hydration;
    const repository = repositories.find((entry) => entry.id === repositoryId);
    const extension = repository?.extensions.find((entry) => entry.id === extensionId);
    if (!repository || !extension || extension.installed || extension.status === "installing") return;
    extension.status = "installing";
    extension.error = null;
    writes += 1;
    notify();
    try {
      await dependencies.installExtension(repository, extension);
      extension.installed = true;
      extension.status = "installed";
    } catch (error) {
      extension.status = "error";
      extension.error = error instanceof Error ? error.message : "Installation failed.";
      throw error;
    } finally {
      writes -= 1;
      notify();
    }
  }

  async function installAll(repositoryId: string, extensionIds?: readonly string[]) {
    const repository = repositories.find((entry) => entry.id === repositoryId);
    if (!repository) return;
    for (const extension of repository.extensions) {
      if (!extension.installed && (!extensionIds || extensionIds.includes(extension.id))) await installExtension(repositoryId, extension.id);
    }
  }

  function isReady(kind?: FirstRunSourceKind): boolean {
    return repositories.some((repository) =>
      (!kind || repository.kind === kind) && repository.extensions.some((extension) => extension.installed),
    );
  }

  return { repositories, get warnings() { return warnings; }, subscribe, hydrate, addRepository, refreshRepository, installExtension, installAll, isReady };
}

export type FirstRunSourcesWorkflow = ReturnType<typeof createFirstRunSourcesWorkflow>;

/** Catalog order is the package name order, which puts multi-language adult sources first. */
export function compareFirstRunExtensions(left: FirstRunExtension, right: FirstRunExtension): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
    || left.lang.localeCompare(right.lang)
    || left.id.localeCompare(right.id);
}

export function buildFirstRunMangaExtensions(extensions: readonly ExtensionRef[], storeId: string): FirstRunExtension[] {
  return extensions
    .filter((extension) => extension.storeId === storeId)
    .map((extension) => ({
      id: extension.packageName,
      name: extension.name,
      lang: extension.language,
      version: extension.versionName,
      iconUrl: extension.iconUrl,
      installed: extension.isInstalled,
      nsfw: extension.isNsfw === true,
      status: extension.isInstalled ? "installed" as const : "idle" as const,
    }))
    .sort(compareFirstRunExtensions);
}

export function visibleFirstRunExtensions(extensions: readonly FirstRunExtension[], showNsfw: boolean): FirstRunExtension[] {
  return showNsfw ? [...extensions] : extensions.filter((extension) => !extension.nsfw || extension.installed);
}

export function buildFirstRunNovelRepositories(state: PersistedNovelRepositoryState): FirstRunRepository[] {
  return state.repositories.map((repository) => ({
    id: repository.id,
    kind: "novels",
    url: repository.normalizedUrl,
    name: translate(isBuiltinNovelRepository(repository) ? "firstRun.sources.builtinNovelRepository" : "firstRun.sources.novelRepository"),
    builtin: isBuiltinNovelRepository(repository),
    extensions: state.catalogEntries.filter((entry) => entry.repositoryId === repository.id).map((entry) => {
      const existing = state.installedPlugins.find((plugin) => plugin.repositoryId === repository.id && plugin.pluginId === entry.pluginId);
      const installed = Boolean(repository.enabled && repository.trustState === "trusted" && existing?.enabled && !existing.disabledReason);
      return { id: entry.pluginId, name: entry.name, lang: entry.lang, version: entry.version, iconUrl: entry.iconUrl,
        installed, action: existing ? "enable" as const : "install" as const, status: installed ? "installed" as const : "idle" as const };
    }).sort(compareFirstRunExtensions),
  }));
}

export function createProductionFirstRunSourcesWorkflow(): FirstRunSourcesWorkflow {
  const scopeInput = () => ({ profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl });
  /** The built-in LNReader feed lists its extensions without asking the user to refresh it. */
  async function loadNovelStateWithBuiltinCatalog() {
    let state = await loadNovelRepositoryState(scopeInput());
    const builtin = state.repositories.find(isBuiltinNovelRepository);
    if (builtin?.enabled && !state.catalogEntries.some((entry) => entry.repositoryId === builtin.id)) {
      const refreshed = await refreshNovelRepositoryCatalog(state, builtin.id);
      if (refreshed.status !== "error") state = await saveNovelRepositoryState(refreshed.state, scopeInput());
    }
    return state;
  }
  return createFirstRunSourcesWorkflow({
    loadRepositories: async () => {
      const [manga, novels] = await Promise.allSettled([
        (async (): Promise<FirstRunRepository[]> => {
          // The step can open while the local server is still starting (e.g. right after launch).
          await waitForSuwayomiGraphqlReady("extensions", { attempts: 40, delayMs: 1000, timeoutMs: 5000 });
          const runtime = await getManagedSourceRuntime();
          const [mangaStores, listedExtensions] = await Promise.all([runtime.listStores(), runtime.listExtensions()]);
          // A restored or freshly started runtime knows its stores before it has fetched their
          // catalogs; fetch once instead of presenting an empty repository.
          const mangaExtensions = mangaStores.some((store) => !listedExtensions.some((extension) => extension.storeId === store.id))
            ? await runtime.refreshExtensions()
            : listedExtensions;
          return mangaStores.map((store) => ({
        id: store.id,
        kind: "manga",
        url: store.indexUrl,
        name: store.name || translate("firstRun.sources.extensionRepository"),
        extensions: buildFirstRunMangaExtensions(mangaExtensions, store.id),
          }));
        })(),
        loadNovelStateWithBuiltinCatalog().then(buildFirstRunNovelRepositories),
      ]);
      return {
        repositories: [manga, novels].flatMap((result) => result.status === "fulfilled" ? result.value : []),
        warnings: [manga, novels].flatMap((result, index) => result.status === "rejected"
          ? [`${index === 0 ? "Comics" : "Novels"} repositories could not be loaded. Try reloading repositories.`] : []),
      };
    },
    addRepository: async (kind, rawUrl) => {
      if (kind === "manga") {
        const runtime = await getManagedSourceRuntime();
        const url = resolveExtensionStoreInputUrl(rawUrl);
        const existing = await runtime.listStores();
        // Retrying a failed catalog refresh must reuse the already-added store.
        const added = existing.find((entry) => comparableUrl(entry.indexUrl) === comparableUrl(url))
          ?? await runtime.addStore({ indexUrl: url });
        const extensions = await runtime.refreshExtensions();
        bumpContentSetupVersion();
        return {
          id: added.id,
          kind,
          url: added.indexUrl,
          name: added.name || translate("firstRun.sources.extensionRepository"),
          extensions: buildFirstRunMangaExtensions(extensions, added.id),
        };
      }

      const url = resolveNovelRepositoryInputUrl(rawUrl);
      let state = await loadNovelRepositoryState(scopeInput());
      const existing = state.repositories.find((entry) => comparableUrl(entry.normalizedUrl) === comparableUrl(url));
      if (!existing) state = addNovelRepositoryToState(state, {
        profileId: store.runtimeResolvedLocalProfileId,
        url,
      });
      const added = state.repositories.find((entry) => comparableUrl(entry.normalizedUrl) === comparableUrl(url))!;
      if (!existing) state = setNovelRepositoryTrustState(state, added.id, "trusted");
      const refreshed = await refreshNovelRepositoryCatalog(state, added.id);
      if (refreshed.status === "error") throw new Error(refreshed.repository.lastError || "The repository could not be loaded. Try again.");
      state = refreshed.state;
      state = await saveNovelRepositoryState(state, scopeInput());
      bumpContentSetupVersion();
      return buildFirstRunNovelRepositories(state).find((repository) => repository.id === added.id)!;
    },
    installExtension: async (repository, extension) => {
      if (repository.kind === "manga") {
        const runtime = await getManagedSourceRuntime();
        const current = (await runtime.listExtensions()).find((candidate) => candidate.packageName === extension.id);
        if (!current || current.storeId !== repository.id) throw new Error("This extension's repository changed. Refresh the repository before installing.");
        await runtime.installExtension({ packageName: extension.id });
      } else {
        let state = await loadNovelRepositoryState(scopeInput());
        const entry = state.catalogEntries.find((candidate) => candidate.repositoryId === repository.id && candidate.pluginId === extension.id);
        if (!entry) throw new Error("This novel extension is no longer present in its repository.");
        if (state.installedPlugins.some((plugin) => plugin.pluginId === entry.pluginId && plugin.repositoryId !== entry.repositoryId)) {
          throw new Error("An extension with this identifier is installed from another repository. Manage that extension in Sources before replacing it.");
        }
        const existing = state.installedPlugins.find((plugin) => plugin.pluginId === entry.pluginId);
        if (existing) {
          const sourceRepository = state.repositories.find((candidate) => candidate.id === repository.id);
          if (!sourceRepository?.enabled || sourceRepository.trustState !== "trusted") throw new Error("Enable and trust this repository in Sources before enabling its extensions.");
          if (existing.disabledReason && existing.disabledReason !== "user-disabled") throw new Error("This extension needs attention. Open Sources to repair it without losing its settings.");
          state = setInstalledNovelPluginEnabled(state, existing.pluginId, true);
        } else {
          state = await installNovelCatalogPlugin({ state, entry, scopeInput: scopeInput() });
        }
        await saveNovelRepositoryState(state, scopeInput());
      }
      bumpContentSetupVersion();
    },
  });
}
