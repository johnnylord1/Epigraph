<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    ArrowsClockwise,
    CaretDown,
    CaretRight,
    Check,
    CircleNotch,
    GitBranch,
    MagnifyingGlass,
    Plus,
    X,
  } from "phosphor-svelte";
  import { gql } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import {
    FETCH_EXTENSIONS,
    GET_EXTENSIONS,
    GET_SETTINGS,
    INSTALL_EXTERNAL_EXTENSION,
    SET_EXTENSION_REPOS,
    UPDATE_EXTENSION,
  } from "../../lib/queries";
  import type { Extension } from "../../lib/types";
  import { toManagedMangaExtension, toManagedNovelCatalogEntry, type ManagedExtension } from "../../lib/managedExtensions";
  import {
    addNovelRepositoryToState,
    deriveNovelRepositoryUiState,
    loadNovelRepositoryState,
    refreshAllNovelRepositories,
    refreshNovelRepositoryCatalog,
    removeNovelRepositoryFromState,
    saveNovelRepositoryState,
    setNovelRepositoryEnabled,
    type PersistedNovelRepositoryState,
  } from "../../lib/novels/repositoryState";
  import type { NovelRepositoryRecord } from "../../lib/novels/contracts";
  import {
    getNovelCatalogEntryInstallState,
    installNovelCatalogPlugin,
    removeInstalledNovelPlugin,
  } from "../../lib/novels/packages";
  import { addToast, bumpContentSetupVersion, setExtensionsPanelHint, store } from "../../store/state.svelte";
  import { ensureExtensionRepo, RECOMMENDED_EXTENSION_REPO } from "../../lib/defaultRepos";
  import { ensureServerAwakeFor, maybeStandbyLocalServer, SERVER_READY_EVENT } from "../../lib/serverLifecycle";
  import { detectSetupState, type SetupState } from "../../lib/setupState";
  import { mockSettingsStore, type MockExtensionSettingsPatch } from "../../store/mockSettingsStore";
  import NocturneState from "../shared/NocturneState.svelte";
  import SetupStatusCard from "../shared/SetupStatusCard.svelte";
  import ExtensionSettingsPanel from "./ExtensionSettingsPanel.svelte";

  type Filter = "installed" | "available" | "updates" | "all";
  type UtilityPanel = null | "apk" | "repos" | "novelRepos";
  type ExtensionOperation = "install" | "update" | "remove";

  let {
    contentType = "manga",
    topbarSearch = null,
  }: {
    contentType?: "manga" | "novels";
    topbarSearch?: string | null;
  } = $props();

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "installed", label: "Installed" },
    { id: "available", label: "Available" },
    { id: "updates", label: "Updates" },
    { id: "all", label: "All" },
  ];
  const LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL =
    "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json";

  const renderLimit = 60;

  function baseName(name: string): string {
    return name.replace(/\s*\([A-Z0-9-]{2,10}\)\s*$/, "").trim();
  }

  let extensions: ManagedExtension[] = $state([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let filter: Filter = $state("installed");
  let search = $state("");
  let activeOperations = $state(new Map<string, ExtensionOperation>());
  let operationErrors = $state(new Map<string, string>());
  let expanded = $state(new Set<string>());
  let selectedPkgName = $state<string | null>(null);
  let utilityPanel: UtilityPanel = $state(null);
  let externalUrl = $state("");
  let installingExternal = $state(false);
  let installError = $state<string | null>(null);
  let installSuccess = $state(false);
  let repos: string[] = $state([]);
  let reposLoading = $state(false);
  let newRepoUrl = $state("");
  let repoError = $state<string | null>(null);
  let savingRepos = $state(false);
  let setupState: SetupState | null = $state(null);
  let setupActionBusy = $state(false);
  let renderVisible = $state(0);
  let novelRepositoryState: PersistedNovelRepositoryState | null = $state(null);
  let updatingAll = $state(false);
  let refreshingNovelRepositoryId = $state<string | null>(null);
  let extensionLoadRun = 0;

  const isNovelMode = $derived(contentType === "novels");
  const activeFilters = $derived(FILTERS);
  const searchPlaceholder = $derived(isNovelMode ? "Search novel sources..." : "Search extensions...");
  const sourceNoun = $derived(isNovelMode ? "sources" : "extensions");
  const sourceTitle = $derived(isNovelMode ? "Manage novel sources" : "Manage extensions");
  const novelRepositoryCount = $derived(novelRepositoryState?.repositories.length ?? 0);
  const novelCatalogCount = $derived(novelRepositoryState?.catalogEntries.length ?? 0);

  const selectedExtension = $derived(
    selectedPkgName ? extensions.find((extension) => extension.pkgName === selectedPkgName) ?? null : null,
  );

  const selectedConfig = $derived(
    selectedExtension ? mockSettingsStore.getConfig(selectedExtension.pkgName, selectedExtension) : null,
  );

  $effect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("aethon-sources-modal-open", utilityPanel !== null);
    return () => document.body.classList.remove("aethon-sources-modal-open");
  });

  const updateCount = $derived(extensions.filter((extension) => extension.hasUpdate).length);
  const updateAllLabel = $derived(updateCount > 0 ? `Update all (${updateCount})` : "Update all");

  const topbarSearchTerm = $derived((topbarSearch ?? "").trim());
  const localSearchTerm = $derived(search.trim());
  const effectiveSearch = $derived(topbarSearchTerm || localSearchTerm);

  const filtered = $derived(extensions.filter((extension) => {
    const query = effectiveSearch.toLowerCase();
    const matchesSearch =
      !query ||
      extension.name.toLowerCase().includes(query) ||
      extension.lang.toLowerCase().includes(query) ||
      extension.pkgName.toLowerCase().includes(query);
    const matchesFilter =
      query && filter === "installed" ? true :
      filter === "installed" ? extension.isInstalled :
      filter === "available" ? !extension.isInstalled :
      filter === "updates" ? extension.hasUpdate :
      true;
    return matchesSearch && matchesFilter;
  }));
  const sourceCountLabel = $derived(`${filtered.length} ${
    filtered.length === 1
      ? isNovelMode ? "source" : "extension"
      : sourceNoun
  }`);

  const groups = $derived.by(() => {
    const map = new Map<string, ManagedExtension[]>();
    for (const extension of filtered) {
      const key = baseName(extension.name);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(extension);
    }

    const preferredLang = store.settings.preferredExtensionLang;
    return Array.from(map.entries()).map(([base, variants]) => {
      const primary =
        variants.find((extension) => extension.pkgName === selectedPkgName) ??
        variants.find((extension) => extension.isInstalled && extension.lang === preferredLang) ??
        variants.find((extension) => extension.isInstalled) ??
        variants.find((extension) => extension.lang === preferredLang) ??
        variants.find((extension) => extension.lang === "en") ??
        variants[0];
      return {
        base,
        primary,
        variants: variants.filter((extension) => extension.pkgName !== primary.pkgName),
      };
    });
  });

  const visibleGroups = $derived(groups.slice(0, renderVisible));
  const hasMore = $derived(groups.length > renderVisible);
  const remainingCount = $derived(Math.max(0, groups.length - renderVisible));

  async function refreshSetupState() {
    setupState = await detectSetupState(store.settings);
  }

  async function ensureMangaServerAwake() {
    if (isNovelMode) return true;
    return ensureServerAwakeFor("browse", {
      serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
      binary: store.settings.serverBinary,
      updateIntensity: store.settings.libraryUpdateIntensity,
    });
  }

  function extensionErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error || "Extension operation failed");
  }

  function startExtensionOperation(pkgName: string, operation: ExtensionOperation) {
    const nextOperations = new Map(activeOperations);
    nextOperations.set(pkgName, operation);
    activeOperations = nextOperations;

    const nextErrors = new Map(operationErrors);
    nextErrors.delete(pkgName);
    operationErrors = nextErrors;
  }

  function finishExtensionOperation(pkgName: string) {
    const nextOperations = new Map(activeOperations);
    nextOperations.delete(pkgName);
    activeOperations = nextOperations;
  }

  function setExtensionOperationError(pkgName: string, message: string) {
    const nextErrors = new Map(operationErrors);
    nextErrors.set(pkgName, message);
    operationErrors = nextErrors;
  }

  function isExtensionWorking(pkgName: string) {
    return activeOperations.has(pkgName);
  }

  function isLockedExtensionFileError(error: unknown) {
    const message = extensionErrorMessage(error).toLowerCase();
    return (
      message.includes("being used by another process") ||
      message.includes("arquivo já está sendo usado") ||
      message.includes("process cannot access the file")
    );
  }

  async function recoverLockedExtensionInstall(extension: ManagedExtension) {
    addToast({
      kind: "info",
      title: "Restarting extension manager",
      body: `${extension.name} is already cached, but Suwayomi is holding the file. Aethon will restart the local server and check again.`,
      duration: 6000,
    });

    await maybeStandbyLocalServer({
      serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
      binary: store.settings.serverBinary,
    }).catch(() => false);

    const woke = await ensureMangaServerAwake();
    if (!woke) {
      throw new Error("Suwayomi could not be restarted. Restart Aethon and try installing the extension again.");
    }

    await loadExtensions();
    const refreshed = extensions.find((item) => item.pkgName === extension.pkgName);
    if (refreshed?.isInstalled) return refreshed;

    await gql(UPDATE_EXTENSION, { id: extension.pkgName, install: true }, undefined, 60000);
    await loadExtensions();
    return extensions.find((item) => item.pkgName === extension.pkgName) ?? refreshed ?? extension;
  }

  function isCurrentExtensionLoad(run: number, mode: "manga" | "novels") {
    return run === extensionLoadRun && (mode === "novels") === isNovelMode;
  }

  async function fetchMangaExtensionNodes() {
    try {
      const data = await gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS, undefined, undefined, 15000);
      return data.extensions.nodes;
    } catch (firstError) {
      if (!(await ensureMangaServerAwake())) throw firstError;
      const data = await gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS, undefined, undefined, 15000);
      return data.extensions.nodes;
    }
  }

  async function loadMangaExtensions(run = ++extensionLoadRun) {
    try {
      const nodes = await fetchMangaExtensionNodes();
      if (isCurrentExtensionLoad(run, "manga")) {
        extensions = nodes.map(toManagedMangaExtension);
      }
    } catch (error) {
      console.error(error);
    } finally {
      if (isCurrentExtensionLoad(run, "manga")) await refreshSetupState();
    }
  }

  async function loadNovelExtensions(run = ++extensionLoadRun) {
    try {
      const state = await loadNovelRepositoryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      });
      if (!isCurrentExtensionLoad(run, "novels")) return;
      novelRepositoryState = state;
      extensions = state.catalogEntries
        .slice()
        .sort((left, right) => {
          const byName = left.name.localeCompare(right.name);
          return byName !== 0 ? byName : left.pluginId.localeCompare(right.pluginId);
        })
        .map((entry) => toManagedNovelCatalogEntry(
          entry,
          getNovelCatalogEntryInstallState(state, entry).status,
        ));
    } catch (error) {
      console.error(error);
      if (isCurrentExtensionLoad(run, "novels")) {
        extensions = [];
        novelRepositoryState = null;
      }
    } finally {
      if (isCurrentExtensionLoad(run, "novels")) setupState = null;
    }
  }

  async function loadExtensions(run = ++extensionLoadRun) {
    if (isNovelMode) {
      await loadNovelExtensions(run);
      return;
    }
    await loadMangaExtensions(run);
  }

  async function fetchFromRepo() {
    const mode = isNovelMode ? "novels" : "manga";
    const run = ++extensionLoadRun;
    refreshing = true;
    try {
      if (mode === "novels") {
        const state = await loadNovelRepositoryState({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        });
        const result = await refreshAllNovelRepositories(state);
        await saveNovelRepositoryState(result.state, {
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        });
        await loadNovelExtensions(run);
        return;
      }
      if (!(await ensureMangaServerAwake())) return;
      const data = await gql<{ fetchExtensions: { extensions: Extension[] } }>(FETCH_EXTENSIONS);
      if (isCurrentExtensionLoad(run, "manga")) {
        extensions = data.fetchExtensions.extensions.map(toManagedMangaExtension);
      }
    } catch (error) {
      console.error(error);
    } finally {
      if (isCurrentExtensionLoad(run, mode)) {
        refreshing = false;
        if (mode === "manga") await refreshSetupState();
      }
    }
  }

  async function loadRepos() {
    reposLoading = true;
    try {
      if (!(await ensureMangaServerAwake())) {
        repos = [];
        return;
      }
      const data = await gql<{ settings: { extensionRepos: string[] } }>(GET_SETTINGS);
      repos = data.settings.extensionRepos ?? [];
    } catch (error) {
      console.error(error);
    } finally {
      reposLoading = false;
      await refreshSetupState();
    }
  }

  async function saveRepos(updated: string[]) {
    savingRepos = true;
    try {
      if (!(await ensureMangaServerAwake())) return;
      const data = await gql<{ setSettings: { settings: { extensionRepos: string[] } } }>(
        SET_EXTENSION_REPOS,
        { repos: updated },
      );
      repos = data.setSettings.settings.extensionRepos;
      bumpContentSetupVersion();
    } catch (error) {
      repoError = error instanceof Error ? error.message : "Failed to save";
    } finally {
      savingRepos = false;
      await refreshSetupState();
    }
  }

  async function saveNovelState(nextState: PersistedNovelRepositoryState) {
    novelRepositoryState = await saveNovelRepositoryState(nextState, {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    });
    await loadNovelExtensions();
  }

  async function addNovelRepo(url: string, recommendedSeed = false) {
    if (!novelRepositoryState) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      repoError = "URL must start with http:// or https://";
      return;
    }

    savingRepos = true;
    repoError = null;
    try {
      const nextState = addNovelRepositoryToState(novelRepositoryState, {
        profileId: store.runtimeResolvedLocalProfileId,
        url: trimmed,
        recommendedSeed,
      });
      await saveNovelState(nextState);
      newRepoUrl = "";
      addToast({
        kind: "success",
        title: "Novel repository added",
        body: "The repository is now available in Sources.",
      });
    } catch (error) {
      repoError = error instanceof Error ? error.message : "Failed to add novel repository";
    } finally {
      savingRepos = false;
    }
  }

  async function refreshNovelRepo(repository: NovelRepositoryRecord) {
    if (!novelRepositoryState) return;
    refreshingNovelRepositoryId = repository.id;
    repoError = null;
    try {
      const result = await refreshNovelRepositoryCatalog(novelRepositoryState, repository.id);
      await saveNovelState(result.state);
      addToast({
        kind: result.status === "error" ? "error" : "success",
        title: result.status === "not-modified" ? "Repository already current" : "Novel repository refreshed",
        body:
          result.status === "error"
            ? (result.repository.lastError ?? "Refresh failed.")
            : `${result.catalogCount} source plugins cached.`,
      });
    } catch (error) {
      repoError = error instanceof Error ? error.message : "Failed to refresh novel repository";
    } finally {
      refreshingNovelRepositoryId = null;
    }
  }

  async function toggleNovelRepo(repository: NovelRepositoryRecord) {
    if (!novelRepositoryState) return;
    savingRepos = true;
    try {
      await saveNovelState(setNovelRepositoryEnabled(novelRepositoryState, repository.id, !repository.enabled));
    } catch (error) {
      repoError = error instanceof Error ? error.message : "Failed to update novel repository";
    } finally {
      savingRepos = false;
    }
  }

  async function removeNovelRepo(repository: NovelRepositoryRecord) {
    if (!novelRepositoryState) return;
    savingRepos = true;
    try {
      await saveNovelState(removeNovelRepositoryFromState(novelRepositoryState, repository.id));
    } catch (error) {
      repoError = error instanceof Error ? error.message : "Failed to remove novel repository";
    } finally {
      savingRepos = false;
    }
  }

  async function addRecommendedRepo() {
    setupActionBusy = true;
    try {
      const result = await ensureExtensionRepo(RECOMMENDED_EXTENSION_REPO);
      addToast({
        kind: result.status === "added" ? "success" : "info",
        title: result.status === "added" ? "Recommended repo added" : "Recommended repo already added",
        body: `${result.repo.name} is ready for extension management.`,
      });
      filter = "available";
      utilityPanel = null;
      await loadRepos();
      await fetchFromRepo();
    } catch (error) {
      addToast({
        kind: "error",
        title: "Could not add the recommended repo",
        body: error instanceof Error ? error.message : "Aethon couldn't save the recommended repo.",
      });
    } finally {
      setupActionBusy = false;
    }
  }

  function browseAvailableExtensions() {
    filter = "available";
    utilityPanel = null;
  }

  function addRepo() {
    const url = newRepoUrl.trim();
    if (!url) return;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      repoError = "URL must start with http:// or https://";
      return;
    }
    if (repos.includes(url)) {
      repoError = "Repo already added";
      return;
    }
    repoError = null;
    newRepoUrl = "";
    void saveRepos([...repos, url]);
  }

  function removeRepo(url: string) {
    void saveRepos(repos.filter((repo) => repo !== url));
  }

  async function mutate(fn: () => Promise<unknown>, pkgName: string, operation: ExtensionOperation) {
    startExtensionOperation(pkgName, operation);
    if (!(await ensureMangaServerAwake())) {
      const message = "Suwayomi is not available right now.";
      setExtensionOperationError(pkgName, message);
      addToast({
        kind: "error",
        title: "Extension action unavailable",
        body: message,
        duration: 6000,
      });
      finishExtensionOperation(pkgName);
      await refreshSetupState();
      return false;
    }
    let ok = true;
    try {
      await fn();
      bumpContentSetupVersion();
      await loadExtensions();
    } catch (error) {
      ok = false;
      console.error(error);
      const message = extensionErrorMessage(error);
      setExtensionOperationError(pkgName, message);
      addToast({
        kind: "error",
        title: "Extension action failed",
        body: message,
        duration: 6000,
      });
    } finally {
      finishExtensionOperation(pkgName);
    }
    return ok;
  }

  async function installExtension(extension: ManagedExtension) {
    if (extension.kind === "novels") {
      if (!novelRepositoryState || !extension.novelPluginId || !extension.novelRepositoryId) {
        const message = "Novel repository metadata is not loaded yet. Refresh novel sources and try again.";
        setExtensionOperationError(extension.pkgName, message);
        addToast({ kind: "error", title: "Could not install novel source", body: message });
        return;
      }
      const entry = novelRepositoryState.catalogEntries.find((item) => (
        item.pluginId === extension.novelPluginId
        && item.repositoryId === extension.novelRepositoryId
      ));
      if (!entry) {
        const message = "This novel source is no longer present in the cached repository catalog.";
        setExtensionOperationError(extension.pkgName, message);
        addToast({ kind: "error", title: "Could not install novel source", body: message });
        return;
      }

      startExtensionOperation(extension.pkgName, extension.hasUpdate ? "update" : "install");
      try {
        const nextState = await installNovelCatalogPlugin({
          state: novelRepositoryState,
          entry,
          scopeInput: {
            profileId: store.runtimeResolvedLocalProfileId,
            serverUrl: store.runtimeServerUrl,
          },
        });
        await saveNovelState(nextState);
        selectedPkgName = extension.pkgName;
        addToast({
          kind: "success",
          title: extension.hasUpdate ? "Novel source updated" : "Novel source installed",
          body: `${extension.name} is ready to use.`,
        });
      } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : "Aethon could not install this novel plugin.";
        setExtensionOperationError(extension.pkgName, message);
        addToast({
          kind: "error",
          title: "Could not install novel source",
          body: message,
        });
      } finally {
        finishExtensionOperation(extension.pkgName);
      }
      return;
    }
    const firstInstallFlow = setupState?.kind === "no_installed_extensions";
    startExtensionOperation(extension.pkgName, extension.hasUpdate ? "update" : "install");
    let installedExtension: ManagedExtension | null = null;
    try {
      if (!(await ensureMangaServerAwake())) {
        throw new Error("Suwayomi is not available right now.");
      }
      await gql(UPDATE_EXTENSION, { id: extension.pkgName, install: true }, undefined, 60000);
      bumpContentSetupVersion();
      await loadExtensions();
      installedExtension = extensions.find((item) => item.pkgName === extension.pkgName) ?? {
        ...extension,
        isInstalled: true,
        hasUpdate: false,
      };
    } catch (error) {
      if (isLockedExtensionFileError(error)) {
        try {
          installedExtension = await recoverLockedExtensionInstall(extension);
          bumpContentSetupVersion();
        } catch (recoveryError) {
          console.error(recoveryError);
          setExtensionOperationError(extension.pkgName, extensionErrorMessage(recoveryError));
          addToast({
            kind: "error",
            title: "Extension install needs restart",
            body: extensionErrorMessage(recoveryError),
            duration: 8000,
          });
          installedExtension = null;
        }
      } else {
        console.error(error);
        setExtensionOperationError(extension.pkgName, extensionErrorMessage(error));
        addToast({
          kind: "error",
          title: "Could not install extension",
          body: extensionErrorMessage(error),
          duration: 7000,
        });
      }
    } finally {
      finishExtensionOperation(extension.pkgName);
    }

    if (!installedExtension) return;

    mockSettingsStore.refreshConfig(extension.pkgName, {
      ...installedExtension,
      isInstalled: true,
      hasUpdate: false,
    });
    selectedPkgName = extension.pkgName;
    addToast({
      kind: "success",
      title: "Extension installed",
      body: `${extension.name} is ready to use.`,
    });

    if (firstInstallFlow) {
      filter = "installed";
      addToast({
        kind: "success",
        title: "First extension installed",
        body: `${extension.name} is installed. Sources is now ready for management.`,
      });
    }
  }

  async function installExternal() {
    const url = externalUrl.trim();
    if (!url) return;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      installError = "URL must start with http:// or https://";
      return;
    }
    if (!url.endsWith(".apk")) {
      installError = "URL must point to an .apk file";
      return;
    }

    installingExternal = true;
    installError = null;
    installSuccess = false;
    try {
      if (!(await ensureMangaServerAwake())) {
        installError = "Suwayomi is not available right now.";
        return;
      }
      await gql(INSTALL_EXTERNAL_EXTENSION, { url });
      installSuccess = true;
      externalUrl = "";
      bumpContentSetupVersion();
      await loadExtensions();
      window.setTimeout(() => {
        utilityPanel = null;
        installSuccess = false;
      }, 1400);
    } catch (error) {
      installError = error instanceof Error ? error.message : "Install failed";
    } finally {
      installingExternal = false;
    }
  }

  function openUtilityPanel(next: UtilityPanel) {
    utilityPanel = utilityPanel === next ? null : next;
    installError = null;
    installSuccess = false;
    externalUrl = "";
    repoError = null;
    newRepoUrl = "";
    if (next === "repos") void loadRepos();
  }

  function openExtensionSettings(extension: ManagedExtension) {
    // Card clicks only open settings. Catalog routing intentionally lives in Discover.
    selectedPkgName = extension.pkgName;
    utilityPanel = null;
    mockSettingsStore.getConfig(extension.pkgName, extension);
  }

  function updateConfig(pkgName: string, patch: MockExtensionSettingsPatch) {
    mockSettingsStore.updateConfig(pkgName, patch);
  }

  async function removeExtension(event: MouseEvent, extension: ManagedExtension) {
    event.stopPropagation();
    if (extension.kind === "novels") {
      if (!novelRepositoryState || !extension.novelPluginId) return;
      startExtensionOperation(extension.pkgName, "remove");
      try {
        const nextState = await removeInstalledNovelPlugin(novelRepositoryState, extension.novelPluginId, {
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        });
        await saveNovelState(nextState);
        if (selectedPkgName === extension.pkgName) {
          selectedPkgName = null;
        }
        addToast({
          kind: "success",
          title: "Novel source removed",
          body: `${extension.name} was removed.`,
        });
      } catch (error) {
        console.error(error);
        setExtensionOperationError(
          extension.pkgName,
          error instanceof Error ? error.message : "Aethon could not remove this novel plugin.",
        );
        addToast({
          kind: "error",
          title: "Could not remove novel source",
          body: error instanceof Error ? error.message : "Aethon could not remove this novel plugin.",
        });
      } finally {
        finishExtensionOperation(extension.pkgName);
      }
      return;
    }
    const didRemove = await mutate(
      () => gql(UPDATE_EXTENSION, { id: extension.pkgName, uninstall: true }),
      extension.pkgName,
      "remove",
    );
    if (didRemove && selectedPkgName === extension.pkgName) {
      selectedPkgName = null;
    }
    if (didRemove) {
      addToast({
        kind: "success",
        title: "Extension removed",
        body: `${extension.name} was removed.`,
      });
    }
  }

  async function updateExtension(event: MouseEvent, extension: ManagedExtension) {
    event.stopPropagation();
    if (extension.kind === "novels") {
      void installExtension(extension);
      return;
    }
    const didUpdate = await mutate(
      () => gql(UPDATE_EXTENSION, { id: extension.pkgName, update: true }),
      extension.pkgName,
      "update",
    );
    if (!didUpdate) return;

    const refreshed = extensions.find((item) => item.pkgName === extension.pkgName) ?? {
      ...extension,
      hasUpdate: false,
    };
    mockSettingsStore.refreshConfig(extension.pkgName, refreshed);
    addToast({
      kind: "success",
      title: "Extension updated",
      body: `${extension.name} is up to date.`,
    });
  }

  async function updateAllExtensions() {
    const candidates = extensions.filter((extension) => extension.hasUpdate);
    if (candidates.length === 0 || updatingAll) return;

    updatingAll = true;
    for (const extension of candidates) {
      startExtensionOperation(extension.pkgName, "update");
    }
    try {
      if (isNovelMode) {
        if (!novelRepositoryState) return;
        let nextState = novelRepositoryState;
        for (const extension of candidates) {
          if (!extension.novelPluginId || !extension.novelRepositoryId) continue;
          const entry = nextState.catalogEntries.find((item) => (
            item.pluginId === extension.novelPluginId
            && item.repositoryId === extension.novelRepositoryId
          ));
          if (!entry) continue;
          nextState = await installNovelCatalogPlugin({
            state: nextState,
            entry,
            scopeInput: {
              profileId: store.runtimeResolvedLocalProfileId,
              serverUrl: store.runtimeServerUrl,
            },
          });
        }
        await saveNovelState(nextState);
      } else {
        for (const extension of candidates) {
          try {
            await gql(UPDATE_EXTENSION, { id: extension.pkgName, update: true });
            mockSettingsStore.refreshConfig(extension.pkgName, {
              ...extension,
              hasUpdate: false,
            });
          } catch (error) {
            console.error(error);
          }
        }
        bumpContentSetupVersion();
        await loadExtensions();
      }
      addToast({
        kind: "success",
        title: "Extensions updated",
        body: `${candidates.length} extension${candidates.length === 1 ? "" : "s"} checked.`,
      });
    } catch (error) {
      console.error(error);
      addToast({
        kind: "error",
        title: "Could not update all extensions",
        body: error instanceof Error ? error.message : "Aethon could not finish the update queue.",
      });
    } finally {
      for (const extension of candidates) {
        finishExtensionOperation(extension.pkgName);
      }
      updatingAll = false;
    }
  }

  function installFromList(event: MouseEvent, extension: ManagedExtension) {
    event.stopPropagation();
    void installExtension(extension);
  }

  function actionLabelFor(extension: ManagedExtension) {
    const operation = activeOperations.get(extension.pkgName);
    if (operation === "update") return "Updating...";
    if (operation === "remove") return "Removing...";
    if (operation === "install") return "Installing...";
    if (extension.hasUpdate) return "Update";
    if (extension.isInstalled) return "Remove";
    return "Install";
  }

  function runVariantAction(event: MouseEvent, extension: ManagedExtension) {
    event.stopPropagation();
    if (extension.hasUpdate) {
      void updateExtension(event, extension);
    } else if (extension.isInstalled) {
      void removeExtension(event, extension);
    } else {
      void installExtension(extension);
    }
  }

  function toggleExpand(event: MouseEvent, base: string) {
    event.stopPropagation();
    const next = new Set(expanded);
    next.has(base) ? next.delete(base) : next.add(base);
    expanded = next;
  }

  function loadMore() {
    renderVisible = Math.min(groups.length, renderVisible + renderLimit);
  }

  $effect(() => {
    if (store.extensionsPanelHint !== "repos") return;
    if (isNovelMode) {
      setExtensionsPanelHint(null);
      return;
    }
    untrack(() => openUtilityPanel("repos"));
    setExtensionsPanelHint(null);
  });

  $effect(() => {
    contentType;
    const mode = isNovelMode ? "novels" : "manga";
    const run = ++extensionLoadRun;
    selectedPkgName = null;
    utilityPanel = null;
    search = "";
    loading = true;
    refreshing = false;
    extensions = [];
    if (mode === "manga") novelRepositoryState = null;
    untrack(() => Promise.all([
      loadExtensions(run),
      mode === "novels" ? Promise.resolve() : refreshSetupState(),
    ]).finally(() => {
      if (isCurrentExtensionLoad(run, mode)) loading = false;
    }));
  });

  onMount(() => {
    const handleServerReady = () => {
      if (isNovelMode) return;
      void Promise.all([
        loadExtensions(),
        loadRepos(),
        refreshSetupState(),
      ]).finally(() => {
        loading = false;
      });
    };
    window.addEventListener(SERVER_READY_EVENT, handleServerReady);
    return () => window.removeEventListener(SERVER_READY_EVENT, handleServerReady);
  });

  $effect(() => {
    filter;
    effectiveSearch;
    loading;

    if (loading) {
      renderVisible = 0;
      return;
    }

    renderVisible = Math.min(renderLimit, groups.length);
  });

  $effect(() => {
    groups.length;
    if (renderVisible > groups.length) renderVisible = groups.length;
  });

  $effect(() => {
    if (!selectedPkgName) return;
    if (!extensions.some((extension) => extension.pkgName === selectedPkgName)) {
      selectedPkgName = null;
    }
  });
</script>

<div class="sourcesRoot" class:hasSettingsPanel={!!selectedExtension}>
  <section class="sourcesMain">
    <div class="sourcesHeader">
      <div class="sourcesTitle">
        <p class="eyebrow">Sources</p>
        <h2>{sourceTitle}</h2>
        <span>{sourceCountLabel}</span>
      </div>

      <div class="sourceTools">
        <div class="tabs">
          {#each activeFilters as item}
            <button class="tab" class:active={filter === item.id} type="button" onclick={() => (filter = item.id)}>
              {item.id === "updates" && updateCount > 0 ? `Updates (${updateCount})` : item.label}
            </button>
          {/each}
        </div>

        <div class="searchWrap">
          <MagnifyingGlass size={13} weight="bold" />
          <input bind:value={search} placeholder={searchPlaceholder} />
        </div>

        {#if updateCount > 0}
          <button class="toolbarActionBtn" type="button" disabled={updatingAll} onclick={updateAllExtensions}>
            {#if updatingAll}
              <CircleNotch size={13} weight="bold" class="anim-spin" />
              Updating
            {:else}
              {updateAllLabel}
            {/if}
          </button>
        {/if}

        {#if isNovelMode}
          <button class="iconBtn" class:active={utilityPanel === "novelRepos"} type="button" title="Manage novel repositories" onclick={() => openUtilityPanel("novelRepos")}>
            <GitBranch size={15} weight="bold" />
          </button>
        {:else}
          <button class="iconBtn" class:active={utilityPanel === "repos"} type="button" title="Manage repos" onclick={() => openUtilityPanel("repos")}>
            <GitBranch size={15} weight="bold" />
          </button>
          <button class="iconBtn" class:active={utilityPanel === "apk"} type="button" title="Install APK URL" onclick={() => openUtilityPanel("apk")}>
            <Plus size={15} weight="bold" />
          </button>
        {/if}
        <button class="iconBtn" type="button" title={isNovelMode ? "Refresh novel sources" : "Refresh repositories"} disabled={refreshing} onclick={fetchFromRepo}>
          <ArrowsClockwise size={15} weight="bold" class={refreshing ? "anim-spin" : ""} />
        </button>
      </div>
    </div>

    {#if !isNovelMode && setupState && setupState.kind !== "ready"}
      <div class="setupWrap">
        <SetupStatusCard
          state={setupState}
          surface="extensions"
          actionBusy={setupActionBusy || savingRepos || refreshing}
          onAddRecommendedRepo={addRecommendedRepo}
          onAddManually={() => openUtilityPanel("repos")}
          onBrowseAvailableExtensions={browseAvailableExtensions}
          onOpenRepoManager={() => openUtilityPanel("repos")}
          onRetry={refreshSetupState}
        />
      </div>
    {/if}

    {#if isNovelMode && utilityPanel === "novelRepos"}
      <div class="repoOverlay" role="presentation">
        <button class="repoOverlayBackdrop" type="button" aria-label="Close repositories panel" onclick={() => (utilityPanel = null)}></button>
        <section class="utilityPanel repoWindow novelRepoPanel">
        <div class="utilityHeader">
          <div class="utilityHeaderCopy">
            <strong>Novel repositories</strong>
            <span>{novelRepositoryCount} feeds · {novelCatalogCount} cached plugins</span>
          </div>
          <button class="closeUtility" type="button" onclick={() => (utilityPanel = null)}><X size={14} weight="bold" /></button>
        </div>

        {#if novelRepositoryState}
          <div class="repoList compactRepoList">
            {#if novelRepositoryState.repositories.length === 0}
              <NocturneState
                layout="compact"
                tone="info"
                icon="folder"
                eyebrow="Novel repositories"
                title="No repositories configured"
                body="Add the official LNReader feed or paste a trusted plugin index URL."
              />
            {:else}
              {#each novelRepositoryState.repositories as repo}
                {@const repoState = deriveNovelRepositoryUiState(repo)}
                {@const repoPluginCount = novelRepositoryState.catalogEntries.filter((entry) => entry.repositoryId === repo.id).length}
                <div class="repoRow novelRepoRow">
                  <div class="novelRepoCopy">
                    <strong>{repo.recommendedSeed ? "Official LNReader feed" : repo.normalizedUrl}</strong>
                    <span>{repoPluginCount} plugins · {repoState}</span>
                    {#if repo.lastError}<small>{repo.lastError}</small>{/if}
                  </div>
                  <div class="novelRepoActions">
                    <button type="button" disabled={refreshingNovelRepositoryId === repo.id} onclick={() => refreshNovelRepo(repo)}>
                      {#if refreshingNovelRepositoryId === repo.id}<CircleNotch size={12} weight="bold" class="anim-spin" />{:else}Refresh{/if}
                    </button>
                    <button type="button" disabled={savingRepos} onclick={() => toggleNovelRepo(repo)}>
                      {repo.enabled ? "Disable" : "Enable"}
                    </button>
                    <button type="button" disabled={savingRepos} onclick={() => removeNovelRepo(repo)}>
                      Remove
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <div class="inlineForm">
            <input
              class:error={repoError}
              placeholder="https://example.com/plugins.min.json"
              bind:value={newRepoUrl}
              disabled={savingRepos}
              oninput={() => (repoError = null)}
              onkeydown={(event) => event.key === "Enter" && !savingRepos && addNovelRepo(newRepoUrl)}
            />
            <button type="button" disabled={savingRepos || !newRepoUrl.trim()} onclick={() => addNovelRepo(newRepoUrl)}>
              {#if savingRepos}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}Add{/if}
            </button>
            <button type="button" disabled={savingRepos} onclick={() => addNovelRepo(LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL, true)}>
              Official
            </button>
          </div>
          {#if repoError}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Repository error" title="Could not update repositories" body={repoError} />
          {/if}
        {/if}
        </section>
      </div>
    {/if}

    {#if !isNovelMode && utilityPanel === "apk"}
      <div class="repoOverlay" role="presentation">
        <button class="repoOverlayBackdrop" type="button" aria-label="Close APK install panel" onclick={() => (utilityPanel = null)}></button>
        <section class="utilityPanel repoWindow repoWindowNarrow">
          <div class="utilityHeader">
            <div class="utilityHeaderCopy">
              <strong>Install APK URL</strong>
              <span>Install a trusted extension package manually</span>
            </div>
            <button class="closeUtility" type="button" onclick={() => (utilityPanel = null)}><X size={14} weight="bold" /></button>
          </div>
          <div class="repoHint">
            Paste a direct `.apk` URL. Aethon will install it through the same extension manager used by repository installs.
          </div>
          <div class="inlineForm">
            <input
              class:error={installError}
              placeholder="https://example.com/extension.apk"
              bind:value={externalUrl}
              disabled={installingExternal}
              oninput={() => (installError = null)}
              onkeydown={(event) => event.key === "Enter" && !installingExternal && installExternal()}
            />
            <button type="button" class:success={installSuccess} disabled={installingExternal || !externalUrl.trim()} onclick={installExternal}>
              {#if installingExternal}
                <CircleNotch size={13} weight="bold" class="anim-spin" />
              {:else if installSuccess}
                <Check size={13} weight="bold" /> Done
              {:else}
                Install
              {/if}
            </button>
          </div>
          {#if installError}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Install error" title="Could not install this package" body={installError} />
          {/if}
        </section>
      </div>
    {/if}

    {#if !isNovelMode && utilityPanel === "repos"}
      <div class="repoOverlay" role="presentation">
        <button class="repoOverlayBackdrop" type="button" aria-label="Close repositories panel" onclick={() => (utilityPanel = null)}></button>
        <section class="utilityPanel repoWindow novelRepoPanel">
          <div class="utilityHeader">
            <div class="utilityHeaderCopy">
              <strong>Manga repositories</strong>
              <span>{repos.length} feeds configured</span>
            </div>
            <button class="closeUtility" type="button" onclick={() => (utilityPanel = null)}><X size={14} weight="bold" /></button>
          </div>
        {#if reposLoading}
          <div class="loadingInline"><CircleNotch size={15} weight="bold" class="anim-spin" /></div>
        {:else}
          {#if repos.length === 0}
            <NocturneState
              layout="compact"
              tone="info"
              icon="folder"
              eyebrow="Manga repositories"
              title="No repositories configured"
              body="Add a Tachiyomi extension index to make sources available."
            />
          {:else}
            <div class="repoList compactRepoList">
              {#each repos as repo}
                <div class="repoRow novelRepoRow">
                  <div class="novelRepoCopy">
                    <strong>{repo}</strong>
                    <span>Extension repository</span>
                  </div>
                  <div class="novelRepoActions">
                    <button type="button" disabled={savingRepos} onclick={() => removeRepo(repo)}>
                      {#if savingRepos}<CircleNotch size={12} weight="bold" class="anim-spin" />{:else}Remove{/if}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          <div class="inlineForm">
            <input
              class:error={repoError}
              placeholder="https://example.com/index.min.json"
              bind:value={newRepoUrl}
              disabled={savingRepos}
              oninput={() => (repoError = null)}
              onkeydown={(event) => event.key === "Enter" && !savingRepos && addRepo()}
            />
            <button type="button" disabled={savingRepos || !newRepoUrl.trim()} onclick={addRepo}>
              {#if savingRepos}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}Add{/if}
            </button>
          </div>
          {#if repoError}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Repository error" title="Could not update repositories" body={repoError} />
          {/if}
        {/if}
        </section>
      </div>
    {/if}

    {#if loading}
      <div class="emptyState">
        <CircleNotch size={18} weight="bold" class="anim-spin" />
      </div>
    {:else if groups.length === 0}
      <div class="emptyState emptyState--panel">
        <NocturneState
          layout="center"
          tone="info"
          icon="search"
          eyebrow="Sources"
          title={`No ${sourceNoun} found`}
          body={isNovelMode ? "Try refreshing novel sources or check your installed novel plugins." : "Try another filter, search term, or refresh your repositories."}
        />
      </div>
    {:else}
      <div class="extensionList">
        <div class="extensionTableHead" aria-hidden="true">
          <span>Source</span>
          <span>Language</span>
          <span>Version</span>
          <span>Status</span>
          <span>Repository</span>
          <span>Actions</span>
        </div>
        {#each visibleGroups as { base, primary, variants }}
          {@const isExpanded = expanded.has(base)}
          {@const hasVariants = variants.length > 0}
          <div
            class="extensionCard"
            class:selected={selectedPkgName === primary.pkgName}
            role="button"
            tabindex="0"
            onclick={() => openExtensionSettings(primary)}
            onkeydown={(event) => event.key === "Enter" && openExtensionSettings(primary)}
          >
            <img
              class="extensionCardIcon"
              src={resolveServiceIconUrl(primary.iconUrl, { kind: "extension" })}
              alt=""
              loading="lazy"
              decoding="async"
              onerror={(event) => applyServiceIconFallback(event, "extension")}
            />
            <div class="extensionCardCopy">
              <div class="extensionTitleRow">
                <h3>{base}</h3>
              </div>
              <p>{primary.pkgName}</p>
            </div>

            <div class="tableCell tableCellLang">
              <span>{primary.lang.toUpperCase()}</span>
              {#if hasVariants}<small>{variants.length + 1} variants</small>{/if}
            </div>

            <div class="tableCell">
              <span>v{primary.versionName}</span>
            </div>

            <div class="tableCell tableCellStatus">
              {#if primary.hasUpdate}
                <span class="updateBadge">Update</span>
              {:else if primary.isInstalled}
                <span class="installedBadge">Installed</span>
              {:else}
                <span class="availableBadge">Available</span>
              {/if}
            </div>

            <div class="tableCell tableCellRepo">
              <span>{primary.kind === "novels" ? primary.site || "LNReader" : primary.apkName || "Suwayomi"}</span>
              <small>{primary.kind === "novels" ? primary.repositoryUrl || "Novel repository" : "Extension repository"}</small>
            </div>

            <div class="cardActions">
              {#if isExtensionWorking(primary.pkgName)}
                <CircleNotch size={16} weight="bold" class="anim-spin" />
              {:else if primary.hasUpdate}
                <button class="actionBtn" type="button" onclick={(event) => updateExtension(event, primary)}>Update</button>
                <button class="ghostBtn" type="button" onclick={(event) => removeExtension(event, primary)}>Remove</button>
              {:else if primary.isInstalled}
                <button class="ghostBtn" type="button" onclick={(event) => removeExtension(event, primary)}>Remove</button>
              {:else}
                <button class="actionBtn" type="button" onclick={(event) => installFromList(event, primary)}>Install</button>
              {/if}

              {#if hasVariants}
                <button class="variantBtn" type="button" onclick={(event) => toggleExpand(event, base)} title={`${variants.length + 1} variants`}>
                  {#if isExpanded}<CaretDown size={13} weight="bold" />{:else}<CaretRight size={13} weight="bold" />{/if}
                </button>
              {/if}
            </div>

            {#if operationErrors.get(primary.pkgName)}
              <p class="extensionOperationError">{operationErrors.get(primary.pkgName)}</p>
            {/if}

            {#if isExpanded && hasVariants}
              <div class="variantList">
                {#each variants as variant}
                  <div
                    class="variantRow"
                    class:selected={selectedPkgName === variant.pkgName}
                    role="button"
                    tabindex="0"
                    onclick={(event) => {
                      event.stopPropagation();
                      openExtensionSettings(variant);
                    }}
                    onkeydown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      openExtensionSettings(variant);
                    }}
                  >
                    <span>{variant.lang.toUpperCase()}</span>
                    <strong>{variant.name}</strong>
                    <small>v{variant.versionName}</small>
                    {#if variant.hasUpdate}<em>Update</em>{/if}
                    <button
                      type="button"
                      class="variantAction"
                      disabled={isExtensionWorking(variant.pkgName)}
                      onclick={(event) => runVariantAction(event, variant)}
                    >
                      {actionLabelFor(variant)}
                    </button>
                  </div>
                  {#if operationErrors.get(variant.pkgName)}
                    <p class="extensionOperationError extensionOperationErrorVariant">{operationErrors.get(variant.pkgName)}</p>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}

        {#if hasMore}
          <button class="loadMoreBtn" type="button" onclick={loadMore}>
            Show {Math.min(remainingCount, renderLimit)} more
          </button>
        {/if}
      </div>
    {/if}
  </section>

  {#if selectedExtension && selectedConfig}
    <ExtensionSettingsPanel
      extension={selectedExtension}
      config={selectedConfig}
      busy={isExtensionWorking(selectedExtension.pkgName)}
      onClose={() => (selectedPkgName = null)}
      onInstall={installExtension}
      onUpdateConfig={updateConfig}
    />
  {/if}
</div>

<style>
  .sourcesRoot {
    position: relative;
    display: flex;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    border-radius: clamp(18px, 1.6vw, 26px);
    border: 1px solid rgba(255, 255, 255, 0.055);
    background:
      radial-gradient(circle at 20% 0%, rgba(184, 167, 234, 0.055), transparent 30%),
      rgba(18, 18, 22, 0.7);
  }

  .sourcesMain {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sourcesHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: calc(52px * var(--n-hud-scale));
    padding: calc(8px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale));
    border-bottom: 1px solid rgba(255, 255, 255, 0.045);
    background: transparent;
  }

  .sourcesTitle {
    display: grid;
    grid-template-columns: auto auto;
    align-items: baseline;
    column-gap: 10px;
    row-gap: 2px;
    min-width: 190px;
  }

  .eyebrow {
    grid-column: 1 / -1;
    margin: 0;
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.18em;
    color: var(--n-primary);
    text-transform: uppercase;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: rgba(244, 241, 243, 0.92);
    font-size: 16px;
    line-height: 1.1;
  }

  .sourcesTitle span {
    color: rgba(202, 196, 208, 0.42);
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .sourceTools {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
    justify-content: flex-end;
  }

  .tabs {
    display: flex;
    padding: 2px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    background: rgba(10, 10, 14, 0.58);
  }

  .tab {
    min-height: 24px;
    padding: 0 11px;
    border-radius: 9px;
    color: rgba(202, 196, 208, 0.58);
    font-size: 11px;
    font-weight: 900;
    transition: color 160ms ease, background 160ms ease;
  }

  .tab.active {
    background: rgba(184, 167, 234, 0.76);
    color: #221a33;
    box-shadow: none;
  }

  .searchWrap {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(240px, 22vw);
    min-width: 170px;
    height: 29px;
    padding: 0 11px;
    border-radius: 11px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    background: rgba(12, 12, 17, 0.62);
    color: rgba(202, 196, 208, 0.42);
  }

  .searchWrap input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    color: rgba(244, 241, 243, 0.84);
    background: transparent;
    font-size: 13px;
  }

  .searchWrap input::placeholder {
    color: rgba(202, 196, 208, 0.42);
  }

  .iconBtn,
  .closeUtility,
  .repoRow button {
    display: grid;
    place-items: center;
    width: 29px;
    height: 29px;
    border-radius: 10px;
    color: rgba(202, 196, 208, 0.56);
    border: 1px solid rgba(255, 255, 255, 0.052);
    background: rgba(12, 12, 17, 0.55);
    transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
  }

  .iconBtn:hover:not(:disabled),
  .iconBtn.active,
  .closeUtility:hover,
  .repoRow button:hover:not(:disabled) {
    color: var(--n-primary);
    border-color: rgba(184, 167, 234, 0.16);
    background: rgba(184, 167, 234, 0.1);
  }

  .iconBtn:disabled {
    opacity: 0.45;
  }

  .setupWrap {
    position: fixed;
    top: 68px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    width: min(1000px, calc(100% - 48px));
    margin: 0;
    pointer-events: none;
  }
  .setupWrap :global(.n-state) {
    width: 100%;
    margin: 0;
    pointer-events: auto;
  }

  .utilityPanel {
    margin: 10px 14px 0;
  }

  .repoOverlay {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: calc(-1 * var(--n-sidebar-width, 76px));
    z-index: 2147483000;
    display: grid;
    place-items: center;
    padding: clamp(28px, 4vh, 54px) clamp(18px, 3vw, 44px);
  }

  .repoOverlayBackdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background:
      radial-gradient(circle at 50% -8%, rgba(184, 167, 234, 0.1), transparent 34%),
      rgba(2, 2, 5, 0.7);
    backdrop-filter: blur(8px) saturate(0.82);
  }

  :global(body.aethon-sources-modal-open .n-sidebar::after) {
    content: "";
    position: absolute;
    inset: -1px;
    z-index: 3;
    pointer-events: none;
    border-radius: inherit;
    background:
      radial-gradient(circle at 50% 7%, rgba(184, 167, 234, 0.08), transparent 44%),
      rgba(2, 2, 5, 0.58);
    backdrop-filter: blur(5px) saturate(0.86);
  }

  .repoWindow {
    position: relative;
    z-index: 1;
    width: min(720px, 100%);
    max-height: min(78vh, 620px);
    margin: 0;
    overflow: hidden;
    border-color: rgba(184, 167, 234, 0.14);
    background:
      linear-gradient(180deg, rgba(24, 22, 31, 0.98), rgba(13, 13, 18, 0.985)),
      #111116;
    box-shadow:
      0 30px 90px rgba(0, 0, 0, 0.68),
      0 0 0 1px rgba(255, 255, 255, 0.035),
      inset 0 1px 0 rgba(255, 255, 255, 0.045);
    animation: repoWindowIn 150ms ease both;
  }

  .repoWindowNarrow {
    width: min(560px, 100%);
  }

  .utilityPanel {
    display: grid;
    gap: 12px;
    padding: 12px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.022);
  }

  .utilityHeader,
  .inlineForm,
  .repoRow {
    display: flex;
    align-items: center;
  }

  .utilityHeader {
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.055);
  }

  .utilityHeaderCopy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .utilityHeader strong {
    color: rgba(244, 241, 243, 0.94);
    font-size: 14px;
  }

  .utilityHeaderCopy span {
    color: rgba(202, 196, 208, 0.5);
    font-size: 11px;
    font-weight: 700;
  }

  .repoHint {
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    background: rgba(255, 255, 255, 0.025);
    color: rgba(202, 196, 208, 0.62);
    font-size: 12px;
    line-height: 1.45;
    padding: 10px 12px;
  }

  .inlineForm {
    gap: 8px;
  }

  .inlineForm input {
    flex: 1;
    min-width: 0;
    min-height: 33px;
    padding: 0 12px;
    border-radius: 13px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(7, 7, 11, 0.82);
    color: rgba(244, 241, 243, 0.86);
    outline: 0;
  }

  .inlineForm input.error {
    border-color: rgba(255, 112, 112, 0.45);
  }

  .inlineForm button,
  .toolbarActionBtn,
  .actionBtn,
  .ghostBtn,
  .variantAction {
    min-height: 26px;
    border-radius: 8px;
    padding: 0 10px;
    font-size: 10px;
    font-weight: 900;
  }

  .inlineForm button,
  .toolbarActionBtn,
  .actionBtn,
  .variantAction {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: rgba(184, 167, 234, 0.78);
    color: #221a33;
  }

  .inlineForm button:disabled,
  .toolbarActionBtn:disabled,
  .actionBtn:disabled,
  .variantAction:disabled {
    opacity: 0.52;
  }

  .toolbarActionBtn {
    min-height: 29px;
    border-radius: 9px;
    padding: 0 12px;
    white-space: nowrap;
  }

  .inlineForm button.success {
    background: rgba(184, 167, 234, 0.9);
  }

  .ghostBtn {
    color: rgba(202, 196, 208, 0.58);
    border: 1px solid rgba(255, 255, 255, 0.045);
    background: rgba(255, 255, 255, 0.012);
  }

  .ghostBtn:hover {
    color: rgba(255, 148, 148, 0.82);
    border-color: rgba(255, 148, 148, 0.18);
  }

  .variantAction {
    min-height: 24px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .extensionOperationError {
    grid-column: 1 / -1;
    margin: -2px 0 0 46px;
    color: rgba(255, 148, 148, 0.82);
    font-size: 10px;
    font-weight: 650;
  }

  .extensionOperationErrorVariant {
    margin: -2px 0 2px 10px;
  }

  .repoList {
    display: grid;
    gap: 6px;
  }

  .compactRepoList {
    max-height: min(42vh, 360px);
    overflow-y: auto;
    padding-right: 2px;
    scrollbar-width: thin;
    scrollbar-color: rgba(184, 167, 234, 0.18) transparent;
  }

  .repoRow {
    gap: 10px;
    min-height: 36px;
    padding: 0 8px 0 12px;
    border-radius: 11px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(25, 24, 31, 0.92);
  }

  .repoRow span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(202, 196, 208, 0.66);
    font-size: 12px;
  }

  .repoRow button {
    width: 24px;
    height: 24px;
    border-radius: 9px;
  }

  .novelRepoPanel {
    gap: 10px;
  }

  .novelRepoRow {
    min-height: 46px;
    padding: 7px 8px 7px 10px;
  }

  .novelRepoCopy {
    display: grid;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .novelRepoCopy strong,
  .novelRepoCopy span,
  .novelRepoCopy small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .novelRepoCopy strong {
    color: rgba(229, 226, 225, 0.82);
    font-size: 11.5px;
    font-weight: 850;
  }

  .novelRepoCopy span {
    color: rgba(202, 196, 208, 0.42);
    font-size: 10px;
  }

  .novelRepoCopy small {
    color: rgba(255, 148, 148, 0.72);
    font-size: 10px;
  }

  .novelRepoActions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    flex: 0 0 auto;
  }

  .novelRepoActions button {
    display: inline-flex;
    width: auto;
    min-width: 58px;
    height: 25px;
    padding: 0 8px;
    border-radius: 7px;
    font-size: 9.5px;
    font-weight: 900;
    background: rgba(255, 255, 255, 0.04);
  }

  @keyframes repoWindowIn {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .loadingInline {
    display: grid;
    place-items: center;
    min-height: 46px;
    color: rgba(202, 196, 208, 0.5);
  }

  .extensionList {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 0;
    padding: 8px 16px 14px;
    scrollbar-width: thin;
    scrollbar-color: rgba(184, 167, 234, 0.18) transparent;
  }

  .extensionTableHead {
    display: grid;
    grid-template-columns: 36px minmax(230px, 1.7fr) 74px 86px 96px minmax(180px, 0.95fr) minmax(104px, auto);
    gap: 10px;
    align-items: center;
    min-height: 28px;
    padding: 0 11px;
    margin-bottom: 0;
    border-radius: 10px 10px 0 0;
    border: 1px solid rgba(255, 255, 255, 0.045);
    border-bottom-color: rgba(255, 255, 255, 0.035);
    background: rgba(18, 18, 22, 0.58);
  }

  .extensionTableHead span {
    color: rgba(202, 196, 208, 0.46);
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.13em;
    text-transform: uppercase;
  }

  .extensionTableHead span:first-child {
    grid-column: 1 / span 2;
  }

  .hasSettingsPanel .extensionList {
    grid-template-columns: minmax(0, 1fr);
  }

  .hasSettingsPanel .sourcesMain {
    flex: 1 1 auto;
    max-width: calc(100% - clamp(320px, 24vw, 390px));
  }

  .extensionCard {
    display: grid;
    grid-template-columns: 36px minmax(230px, 1.7fr) 74px 86px 96px minmax(180px, 0.95fr) minmax(104px, auto);
    gap: 10px;
    align-items: center;
    min-height: 50px;
    padding: 6px 11px;
    border-radius: 0;
    border: 1px solid rgba(255, 255, 255, 0.038);
    border-top: 0;
    background: rgba(18, 18, 22, 0.42);
    cursor: pointer;
    transition: background 160ms ease, border-color 160ms ease;
  }

  .extensionCard:hover,
  .extensionCard.selected {
    background: rgba(26, 24, 34, 0.72);
    border-color: rgba(184, 167, 234, 0.12);
  }

  .extensionCard:last-of-type {
    border-radius: 0 0 10px 10px;
  }

  .extensionCard:focus-visible {
    outline: 2px solid rgba(184, 167, 234, 0.5);
    outline-offset: 2px;
  }

  .extensionCardIcon {
    width: 31px;
    height: 31px;
    border-radius: 8px;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.035);
    border: 1px solid rgba(255, 255, 255, 0.06);
  }

  .extensionCardCopy {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .extensionTitleRow,
  .cardActions,
  .variantRow {
    display: flex;
    align-items: center;
  }

  .extensionTitleRow {
    gap: 7px;
    min-width: 0;
  }

  h3 {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(244, 241, 243, 0.94);
    font-size: 13px;
    font-weight: 850;
    line-height: 1.2;
  }

  .extensionCardCopy p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(202, 196, 208, 0.44);
    font-size: 10px;
  }

  .tableCell {
    min-width: 0;
    display: grid;
    gap: 3px;
    align-content: center;
    color: rgba(229, 226, 225, 0.72);
    font-size: 10.5px;
    font-weight: 760;
  }

  .tableCell span,
  .tableCell small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tableCell small {
    color: rgba(202, 196, 208, 0.36);
    font-size: 9px;
    font-weight: 700;
  }

  .tableCellLang span {
    width: fit-content;
    min-width: 30px;
    padding: 2px 7px;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.052);
    background: rgba(255, 255, 255, 0.026);
    color: rgba(225, 219, 239, 0.76);
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.06em;
    text-align: center;
  }

  .tableCellStatus {
    justify-items: start;
  }

  .tableCellRepo span {
    color: rgba(229, 226, 225, 0.68);
    font-size: 10.5px;
  }

  .installedBadge,
  .updateBadge,
  .availableBadge,
  .variantRow span,
  .variantRow small,
  .variantRow em {
    border-radius: 5px;
    padding: 2px 6px 1px;
    border: 1px solid rgba(255, 255, 255, 0.052);
    background: rgba(255, 255, 255, 0.024);
    color: rgba(202, 196, 208, 0.62);
    font-family: var(--font-ui);
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    line-height: 1.2;
  }

  .installedBadge {
    color: rgba(211, 201, 245, 0.82);
    background: rgba(184, 167, 234, 0.07);
    border-color: rgba(184, 167, 234, 0.12);
  }

  .updateBadge,
  .variantRow em {
    color: rgba(255, 214, 153, 0.8);
    background: rgba(255, 214, 153, 0.08);
    border-color: rgba(255, 214, 153, 0.14);
    font-style: normal;
  }

  .availableBadge {
    color: rgba(202, 196, 208, 0.52);
    background: rgba(255, 255, 255, 0.014);
    border-color: rgba(255, 255, 255, 0.04);
  }

  .cardActions {
    justify-content: flex-end;
    gap: 6px;
    color: rgba(202, 196, 208, 0.52);
  }

  .variantBtn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    color: rgba(202, 196, 208, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.055);
    background: rgba(255, 255, 255, 0.018);
  }

  .variantList {
    grid-column: 1 / -1;
    display: grid;
    gap: 5px;
    padding: 3px 0 0 46px;
  }

  .variantRow {
    width: 100%;
    gap: 8px;
    min-height: 36px;
    padding: 0 9px;
    border-radius: 9px;
    background: rgba(255, 255, 255, 0.018);
    border: 1px solid rgba(255, 255, 255, 0.045);
    text-align: left;
  }

  .variantRow.selected {
    border-color: rgba(184, 167, 234, 0.18);
    background: rgba(184, 167, 234, 0.065);
  }

  .variantRow strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(229, 226, 225, 0.76);
    font-size: 12px;
  }

  .loadMoreBtn {
    grid-column: 1 / -1;
    justify-self: center;
    min-height: 34px;
    padding: 0 16px;
    border-radius: 10px;
    color: rgba(202, 196, 208, 0.64);
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.055);
    font-weight: 900;
  }

  .emptyState {
    flex: 1;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 8px;
    color: rgba(202, 196, 208, 0.5);
    text-align: center;
  }

  @media (max-width: 980px) {
    .sourcesHeader {
      align-items: stretch;
      flex-direction: column;
    }

    .sourceTools {
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .searchWrap {
      flex: 1;
      min-width: 220px;
    }

    .hasSettingsPanel .sourcesMain {
      max-width: none;
    }

    .extensionTableHead {
      display: none;
    }

    .extensionCard {
      grid-template-columns: 34px minmax(0, 1fr) auto;
    }

    .tableCell,
    .tableCellRepo {
      display: none;
    }
  }

  @media (max-width: 760px) {
    .sourcesRoot {
      position: relative;
    }

    .extensionCard {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .cardActions {
      grid-column: 2;
      justify-content: flex-start;
    }

    .variantList {
      padding-left: 0;
    }
  }
</style>
