<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { onMount, untrack } from "svelte";
  import {
    ArrowCircleUp,
    ArrowsClockwise,
    CaretDown,
    CaretRight,
    Check,
    CheckCircle,
    CircleNotch,
    FileArrowUp,
    GitBranch,
    MagnifyingGlass,
    Package,
    Plus,
    X,
  } from "phosphor-svelte";
  import { gqlUpload } from "../../lib/client";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { INSTALL_EXTERNAL_EXTENSION } from "../../lib/queries";
  import {
    toManagedMangaRuntimeExtension,
    toManagedNovelCatalogEntry,
    type ManagedExtension,
  } from "../../lib/managedExtensions";
  import {
    canonicalizeExtensionStoreUrl,
    getManagedSourceRuntime,
    loadExtensionCompatibilityState,
    runExplicitCompatibilityProbe,
    runTransactionalExtensionUpdates,
    saveExtensionCompatibilityState,
    type ObservedCompatibilityReport,
    type SourcePreferenceAccess,
    type SourcePreferenceGroup,
    type SourcePreferenceUpdateInput,
    type SourceRuntime,
    upsertObservedCompatibilityReport,
  } from "../../lib/manga/runtime";
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
  import { readInstalledNovelSourceRuntimeSummary } from "../../lib/novels/sources";
  import { addToast, bumpContentSetupVersion, setExtensionsPanelHint, store } from "../../store/state.svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { ensureExtensionRepo, RECOMMENDED_EXTENSION_REPO } from "../../lib/defaultRepos";
  import { ensureServerAwakeFor, maybeStandbyLocalServer, SERVER_READY_EVENT } from "../../lib/serverLifecycle";
  import { waitForSuwayomiGraphqlReady } from "../../lib/suwayomiReadiness";
  import { getSuwayomiRuntimeStatus } from "../../lib/suwayomiRuntimeUpdate";
  import { detectSetupState, type SetupState } from "../../lib/setupState";
  import NocturneState from "../shared/NocturneState.svelte";
  import SetupStatusCard from "../shared/SetupStatusCard.svelte";
  import ExtensionSettingsPanel from "./ExtensionSettingsPanel.svelte";
  import MassMigrateModal from "./MassMigrateModal.svelte";

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

  const FILTERS: { id: Filter; labelKey: string }[] = [
    { id: "installed", labelKey: "sources.filters.installed" },
    { id: "available", labelKey: "sources.filters.available" },
    { id: "updates", labelKey: "sources.filters.updates" },
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
  let externalFile: File | null = $state(null);
  let externalFileInput: HTMLInputElement | null = $state(null);
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
  let extensionLoadError = $state<string | null>(null);
  let lastMangaExtensions: ManagedExtension[] = $state([]);
  let lastNovelExtensions: ManagedExtension[] = $state([]);
  let massMigrationExtension: ManagedExtension | null = $state(null);
  let mangaExtensionCatalogLoaded = $state(false);
  let compatibilityReports: ObservedCompatibilityReport[] = $state([]);
  let checkingCompatibilityPkg = $state<string | null>(null);
  let preferenceGroups: SourcePreferenceGroup[] = $state([]);
  let preferenceAccess: SourcePreferenceAccess = $state("unsupported");
  let preferenceLoading = $state(false);
  let preferenceLoadError: string | null = $state(null);
  let preferenceBusyKey: string | null = $state(null);
  let preferenceErrors: Record<string, string> = $state({});
  let novelPreferenceKeys: string[] = $state([]);
  let selectedPreferenceSourceId = $state("");
  let extensionLoadRun = 0;
  let preferenceLoadRun = 0;
  let preferenceAbort: AbortController | null = null;

  const isNovelMode = $derived(contentType === "novels");
  const activeFilters = $derived(FILTERS.map((item) => ({ ...item, label: $_(item.labelKey) })));
  const searchPlaceholder = $derived(isNovelMode ? $_("sources.search.novelSources") : $_("sources.search.extensions"));
  const sourceTitle = $derived(isNovelMode ? $_("sources.title.novelSources") : $_("sources.title.extensions"));
  const novelRepositoryCount = $derived.by<number>(() => {
    const state = novelRepositoryState;
    return state ? state.repositories.length : 0;
  });
  const novelCatalogCount = $derived.by<number>(() => {
    const state = novelRepositoryState;
    return state ? state.catalogEntries.length : 0;
  });
  const novelRepositorySummary = $derived($_("sources.repositories.novelSummary", {
    feeds: novelRepositoryCount,
    plugins: novelCatalogCount,
  }));

  const selectedExtension = $derived(
    selectedPkgName ? extensions.find((extension) => extension.pkgName === selectedPkgName) ?? null : null,
  );

  $effect(() => {
    if (typeof document === "undefined") return;
    document.body.classList.toggle("epigraph-sources-modal-open", utilityPanel !== null);
    return () => document.body.classList.remove("epigraph-sources-modal-open");
  });

  const updateCount = $derived(extensions.filter((extension) => extension.hasUpdate).length);
  const installedCount = $derived(extensions.filter((extension) => extension.isInstalled).length);
  const availableCount = $derived(extensions.filter((extension) => !extension.isInstalled).length);
  const updateAllLabel = $derived(updateCount > 0
    ? $_("sources.actions.updateAllCount", { count: updateCount })
    : $_("sources.actions.updateAll"));

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
  const sourceCountLabel = $derived(
    isNovelMode
      ? $_(filtered.length === 1 ? "sources.count.source" : "sources.count.sources", { count: filtered.length })
      : $_(filtered.length === 1 ? "sources.count.extension" : "sources.count.extensions", { count: filtered.length }),
  );

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
  const showLoadError = $derived(Boolean(extensionLoadError && !loading && groups.length === 0));
  const awaitingFirstMangaCatalog = $derived(
    !isNovelMode
    && !loading
    && !extensionLoadError
    && !mangaExtensionCatalogLoaded
    && extensions.length === 0,
  );

  async function refreshSetupState() {
    const nextState = await detectSetupState(store.settings);
    setupState = nextState;
    return nextState;
  }

  function isServerUnavailableState(state: SetupState | null | undefined) {
    return state?.kind === "server_offline" || state?.kind === "server_initializing";
  }

  async function ensureMangaServerAwake() {
    if (isNovelMode) return true;
    return ensureServerAwakeFor("browse", {
      serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
      binary: store.settings.serverBinary,
      updateIntensity: store.settings.libraryUpdateIntensity,
      profileId: store.runtimeResolvedLocalProfileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
    });
  }

  function extensionErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error || translate("ui_extensionActionFailed"));
  }

  function preferenceKey(sourceId: string, position: number): string {
    return `${sourceId}:${position}`;
  }

  function resetPreferenceState() {
    preferenceAbort?.abort();
    preferenceAbort = null;
    preferenceGroups = [];
    preferenceAccess = "unsupported";
    preferenceLoading = false;
    preferenceLoadError = null;
    preferenceBusyKey = null;
    preferenceErrors = {};
    novelPreferenceKeys = [];
    selectedPreferenceSourceId = "";
  }

  async function hydratePreferenceGroup(
    runtime: SourceRuntime,
    sourceId: string,
    run: number,
    signal: AbortSignal,
  ) {
    const current = preferenceGroups.find((group) => group.source.id === sourceId);
    if (!current || current.status === "loading" || current.status === "ready") return;
    preferenceGroups = preferenceGroups.map((group) => (
      group.source.id === sourceId
        ? { ...group, status: "loading", error: null }
        : group
    ));

    try {
      const preferences = await runtime.getSourcePreferences(sourceId, signal);
      if (run !== preferenceLoadRun || signal.aborted) return;
      preferenceGroups = preferenceGroups.map((group) => (
        group.source.id === sourceId
          ? { ...group, preferences, status: "ready", error: null }
          : group
      ));
    } catch (error) {
      if (run !== preferenceLoadRun || signal.aborted) return;
      preferenceGroups = preferenceGroups.map((group) => (
        group.source.id === sourceId
          ? {
              ...group,
              preferences: [],
              status: "error",
              error: extensionErrorMessage(error),
            }
          : group
      ));
    }
  }

  async function loadPreferenceSource(sourceId: string) {
    selectedPreferenceSourceId = sourceId;
    const group = preferenceGroups.find((item) => item.source.id === sourceId);
    if (!group || group.status === "loading" || group.status === "ready") return;
    const run = preferenceLoadRun;
    const controller = preferenceAbort;
    if (!controller || controller.signal.aborted) return;
    const runtime = await getManagedSourceRuntime();
    await hydratePreferenceGroup(runtime, sourceId, run, controller.signal);
  }

  async function loadExtensionPreferences(extension: ManagedExtension) {
    const run = ++preferenceLoadRun;
    preferenceAbort?.abort();
    const controller = new AbortController();
    preferenceAbort = controller;
    preferenceGroups = [];
    preferenceAccess = extension.kind === "novels" ? "read-only" : "unsupported";
    preferenceLoading = extension.isInstalled;
    preferenceLoadError = null;
    preferenceBusyKey = null;
    preferenceErrors = {};
    novelPreferenceKeys = [];

    if (!extension.isInstalled) {
      preferenceLoading = false;
      return;
    }

    try {
      if (extension.kind === "novels") {
        if (!extension.novelPluginId) {
          throw new Error(translate("sources_runtime_novelIdentityMissing"));
        }
        const summary = await readInstalledNovelSourceRuntimeSummary({}, extension.novelPluginId);
        if (run !== preferenceLoadRun || controller.signal.aborted) return;
        novelPreferenceKeys = [...new Set(summary.pluginSettingsKeys)].sort((left, right) =>
          left.localeCompare(right),
        );
        preferenceAccess = "read-only";
        return;
      }

      const runtime = await getManagedSourceRuntime();
      const [capabilities, sources] = await Promise.all([
        runtime.getCapabilities(),
        runtime.listSources(controller.signal),
      ]);
      if (run !== preferenceLoadRun || controller.signal.aborted) return;

      preferenceAccess = capabilities.sourcePreferenceAccess;
      if (preferenceAccess === "unsupported") return;

      const extensionSources = sources
        .filter((source) => source.extensionPackageName === extension.pkgName)
        .sort((left, right) => {
          const leftPreferred = left.language === extension.lang || left.language === "en";
          const rightPreferred = right.language === extension.lang || right.language === "en";
          if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
          return left.displayName.localeCompare(right.displayName);
        });
      preferenceGroups = extensionSources.map((source) => ({
        source,
        preferences: [],
        status: "pending",
        error: null,
      }));
      if (extensionSources[0]) {
        selectedPreferenceSourceId = extensionSources[0].id;
        await hydratePreferenceGroup(runtime, extensionSources[0].id, run, controller.signal);
      }
    } catch (error) {
      if (run !== preferenceLoadRun || controller.signal.aborted) return;
      preferenceLoadError = extensionErrorMessage(error);
    } finally {
      if (run === preferenceLoadRun && !controller.signal.aborted) {
        preferenceLoading = false;
      }
    }
  }

  async function updateSourcePreference(input: SourcePreferenceUpdateInput) {
    if (preferenceAccess !== "read-write" || preferenceBusyKey) return;
    const key = preferenceKey(input.sourceId, input.position);
    preferenceBusyKey = key;
    const nextErrors = { ...preferenceErrors };
    delete nextErrors[key];
    preferenceErrors = nextErrors;

    try {
      const runtime = await getManagedSourceRuntime();
      const preferences = await runtime.updateSourcePreference(input);
      preferenceGroups = preferenceGroups.map((group) => (
        group.source.id === input.sourceId
          ? { ...group, preferences, status: "ready", error: null }
          : group
      ));
    } catch (error) {
      preferenceErrors = {
        ...preferenceErrors,
        [key]: extensionErrorMessage(error),
      };
    } finally {
      preferenceBusyKey = null;
    }
  }

  async function certifyMangaExtensionUpdates(candidates: Parameters<typeof runTransactionalExtensionUpdates>[0]) {
    try {
      return await runTransactionalExtensionUpdates(candidates);
    } catch {
      throw new Error(
        translate("sources_runtime_updateVerificationFailed"),
      );
    }
  }

  function extensionOperationLabel(operation: ExtensionOperation) {
    return operation === "install"
      ? translate("sources_actions_install")
      : operation === "update"
        ? translate("sources_actions_update")
        : translate("sources_actions_remove");
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
      title: translate("ui_restartingExtensionManager"),
      body: `${extension.name} is already cached, but Suwayomi is holding the file. Epigraph will restart the local server and check again.`,
      duration: 6000,
    });

    await maybeStandbyLocalServer({
      serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
      binary: store.settings.serverBinary,
    }).catch(() => false);

    const woke = await ensureMangaServerAwake();
    if (!woke) {
      throw new Error(translate("sources_runtime_restartFailed"));
    }

    await loadExtensions();
    const refreshed = extensions.find((item) => item.pkgName === extension.pkgName);
    if (refreshed?.isInstalled) return refreshed;

    const runtime = await getManagedSourceRuntime();
    await runtime.installExtension({ packageName: extension.pkgName });
    await loadExtensions();
    return extensions.find((item) => item.pkgName === extension.pkgName) ?? refreshed ?? extension;
  }

  function isCurrentExtensionLoad(run: number, mode: "manga" | "novels") {
    return run === extensionLoadRun && (mode === "novels") === isNovelMode;
  }

  async function fetchMangaExtensionCatalog(refreshConfiguredCatalog = false) {
    const readCatalog = async () => {
      const runtime = await getManagedSourceRuntime();
      const [cached, stores] = await Promise.all([
        runtime.listExtensions(),
        runtime.listStores(),
      ]);
      const nodes = stores.length === 0
        ? cached.filter((extension) => extension.isInstalled)
        : refreshConfiguredCatalog || cached.length === 0
          ? await runtime.refreshExtensions()
          : cached;
      return {
        nodes,
        repoUrls: stores.map((store) => store.indexUrl),
      };
    };

    try {
      return await readCatalog();
    } catch (firstError) {
      if (!(await ensureMangaServerAwake())) throw firstError;
      if (!(await waitForSuwayomiGraphqlReady("extensions", { attempts: 8, delayMs: 800, timeoutMs: 5000 }))) {
        throw firstError;
      }
      return readCatalog();
    }
  }

  async function loadMangaExtensions(run = ++extensionLoadRun) {
    try {
      const [catalog, compatibilityState] = await Promise.all([
        fetchMangaExtensionCatalog(),
        loadExtensionCompatibilityState({
          profileId: store.runtimeResolvedLocalProfileId ?? "main",
          serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
        }).catch(() => null),
      ]);
      if (isCurrentExtensionLoad(run, "manga")) {
        const next = catalog.nodes.map(toManagedMangaRuntimeExtension);
        mangaExtensionCatalogLoaded = true;
        lastMangaExtensions = next;
        extensions = next;
        repos = catalog.repoUrls;
        compatibilityReports = compatibilityState?.reports ?? [];
        extensionLoadError = null;
      }
    } catch (error) {
      console.error(error);
      if (isCurrentExtensionLoad(run, "manga")) {
        extensionLoadError = extensionErrorMessage(error);
        if (lastMangaExtensions.length > 0) extensions = lastMangaExtensions;
      }
    } finally {
      if (isCurrentExtensionLoad(run, "manga")) void refreshSetupState();
    }
  }

  async function loadNovelExtensions(run = ++extensionLoadRun) {
    try {
      const state = await loadNovelRepositoryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      });
      if (!isCurrentExtensionLoad(run, "novels")) return;
      compatibilityReports = [];
      novelRepositoryState = state;
      const next = state.catalogEntries
        .slice()
        .sort((left, right) => {
          const byName = left.name.localeCompare(right.name);
          return byName !== 0 ? byName : left.pluginId.localeCompare(right.pluginId);
        })
        .map((entry) => toManagedNovelCatalogEntry(
          entry,
          getNovelCatalogEntryInstallState(state, entry).status,
        ));
      lastNovelExtensions = next;
      extensions = next;
      extensionLoadError = null;
    } catch (error) {
      console.error(error);
      if (isCurrentExtensionLoad(run, "novels")) {
        extensionLoadError = extensionErrorMessage(error);
        if (lastNovelExtensions.length > 0) extensions = lastNovelExtensions;
        novelRepositoryState = null;
      }
    } finally {
      if (isCurrentExtensionLoad(run, "novels")) setupState = null;
    }
  }

  function latestCompatibilityReport(packageName: string): ObservedCompatibilityReport | null {
    return compatibilityReports.find((report) => report.packageName === packageName) ?? null;
  }

  function compatibilityStatusLabel(report: ObservedCompatibilityReport): string {
    return report.aggregateStatus === "PASS"
      ? translate("extensionSettings_passed")
      : report.aggregateStatus === "DEGRADED"
        ? translate("extensionSettings_degraded")
        : report.aggregateStatus === "FAIL"
          ? translate("extensionSettings_failed")
          : report.aggregateStatus === "CANCELLED"
            ? translate("extensionSettings_cancelled")
            : translate("extensionSettings_inconclusive");
  }

  async function compatibilityRuntimeScope(): Promise<"LOCAL_OWNED" | "REMOTE_SHARED"> {
    try {
      const status = await getSuwayomiRuntimeStatus();
      return status.updateAllowed
        && (status.mode === "managed-bundled" || status.mode === "managed-runtime")
        ? "LOCAL_OWNED"
        : "REMOTE_SHARED";
    } catch {
      return "REMOTE_SHARED";
    }
  }

  async function checkCompatibility(extension: ManagedExtension) {
    if (extension.kind !== "manga" || checkingCompatibilityPkg) return;
    checkingCompatibilityPkg = extension.pkgName;
    try {
      const profileId = store.runtimeResolvedLocalProfileId ?? "main";
      const serverUrl = store.runtimeServerUrl ?? store.settings.serverUrl;
      const runtime = await getManagedSourceRuntime();
      const state = await loadExtensionCompatibilityState({ profileId, serverUrl });
      const identity = state.records.find((record) => (
        record.packageName === extension.pkgName
        && record.versionCode === String(extension.versionCode ?? extension.versionName)
      ));
      const runtimeScope = await compatibilityRuntimeScope();
      const report = await runExplicitCompatibilityProbe(runtime, {
        profileId,
        packageName: extension.pkgName,
        versionCode: String(extension.versionCode ?? extension.versionName),
        artifactSha256: identity?.artifactSha256 ?? extension.provenance?.artifactDigest ?? null,
        runtimeArtifactSha256: identity?.runtimeArtifactSha256 ?? null,
        runtimeScope,
      });
      const saved = await saveExtensionCompatibilityState(
        upsertObservedCompatibilityReport(state, report),
        { profileId, serverUrl },
      );
      compatibilityReports = saved.reports;
      addToast({
        kind: report.aggregateStatus === "FAIL" ? "error" : "info",
        title: compatibilityStatusLabel(report),
        body: report.aggregateStatus === "PASS"
          ? translate("sources_runtime_compatibilityProbePassed", { name: extension.name })
          : translate("sources_runtime_compatibilityProbePreserved", { name: extension.name }),
        duration: 5000,
      });
    } catch (error) {
      const nextState = await refreshSetupState();
      if (isServerUnavailableState(nextState)) {
        setExtensionOperationError(extension.pkgName, extensionErrorMessage(error));
      } else {
        addToast({
          kind: "error",
          title: translate("sources_runtime_compatibilityCheckIncomplete"),
          body: extensionErrorMessage(error),
          duration: 6000,
        });
      }
    } finally {
      checkingCompatibilityPkg = null;
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
      if (!(await waitForSuwayomiGraphqlReady("extensions", { attempts: 8, delayMs: 800, timeoutMs: 5000 }))) {
        throw new Error(translate("sources_runtime_suwayomiStarting"));
      }
      const catalog = await fetchMangaExtensionCatalog(true);
      if (isCurrentExtensionLoad(run, "manga")) {
        const next = catalog.nodes.map(toManagedMangaRuntimeExtension);
        mangaExtensionCatalogLoaded = true;
        lastMangaExtensions = next;
        extensions = next;
        repos = catalog.repoUrls;
        extensionLoadError = null;
      }
    } catch (error) {
      console.error(error);
      if (isCurrentExtensionLoad(run, mode)) extensionLoadError = extensionErrorMessage(error);
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
      const runtime = await getManagedSourceRuntime();
      repos = (await runtime.listStores()).map((store) => store.indexUrl);
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
      const runtime = await getManagedSourceRuntime();
      const current = await runtime.listStores();
      const currentUrls = new Set(current.map((store) => canonicalizeExtensionStoreUrl(store.indexUrl)));
      const updatedUrls = new Set(
        updated.map((url) => url.trim()).filter(Boolean).map(canonicalizeExtensionStoreUrl),
      );
      for (const url of currentUrls) {
        if (!updatedUrls.has(url)) await runtime.removeStore(url);
      }
      for (const url of updatedUrls) {
        if (!currentUrls.has(url)) await runtime.addStore({ indexUrl: url });
      }
      repos = (await runtime.listStores()).map((store) => store.indexUrl);
      bumpContentSetupVersion();
      await fetchFromRepo();
    } catch (error) {
      repoError = error instanceof Error ? error.message : translate("ui_couldNotSaveRepository");
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
      repoError = translate("sources_runtime_invalidRepositoryUrl");
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
        title: translate("ui_novelRepositoryAdded"),
        body: translate("ui_theRepositoryIsNowAvailableInSources"),
      });
    } catch (error) {
      repoError = error instanceof Error ? error.message : translate("ui_couldNotSaveRepository");
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
        title: result.status === "not-modified" ? translate("ui_repositoryAlreadyCurrent") : translate("ui_novelRepositoryRefreshed"),
        body:
          result.status === "error"
            ? (result.repository.lastError ?? translate("ui_refreshFailed_0a5e2c85"))
            : `${result.catalogCount} source plugins cached.`,
      });
    } catch (error) {
      repoError = error instanceof Error ? error.message : translate("ui_refreshFailed");
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
      repoError = error instanceof Error ? error.message : translate("ui_couldNotSaveRepository");
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
      repoError = error instanceof Error ? error.message : translate("ui_couldNotSaveRepository");
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
        title: result.status === "added" ? translate("ui_recommendedRepoAdded") : translate("ui_recommendedRepoAlreadyAdded"),
        body: translate("sources_runtime_repositoryReady", { name: result.repo.name }),
      });
      filter = "available";
      utilityPanel = null;
      await loadRepos();
      await fetchFromRepo();
    } catch (error) {
      const nextState = await refreshSetupState();
      if (!isServerUnavailableState(nextState)) {
        addToast({
          kind: "error",
          title: translate("ui_couldNotAddTheRecommendedRepo"),
          body: error instanceof Error ? error.message : translate("ui_epigraphCouldnTSaveTheRecommendedRepo"),
        });
      }
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
      repoError = translate("sources_runtime_invalidRepositoryUrl");
      return;
    }
    if (repos.includes(url)) {
      repoError = translate("sources_runtime_repoAlreadyAdded");
      return;
    }
    repoError = null;
    newRepoUrl = "";
    void saveRepos([...repos, url]);
  }

  function removeRepo(url: string) {
    void saveRepos(repos.filter((repo) => repo !== url));
  }

  async function mutate(
    fn: () => Promise<unknown>,
    pkgName: string,
    operation: ExtensionOperation,
    reloadAfter = true,
  ) {
    startExtensionOperation(pkgName, operation);
    if (!(await ensureMangaServerAwake())) {
      const message = translate("sources_runtime_suwayomiUnavailable");
      setExtensionOperationError(pkgName, message);
      finishExtensionOperation(pkgName);
      await refreshSetupState();
      return false;
    }
    if (!(await waitForSuwayomiGraphqlReady("extensions", { attempts: 8, delayMs: 800, timeoutMs: 5000 }))) {
      const message = translate("sources_runtime_suwayomiStarting");
      setExtensionOperationError(pkgName, message);
      finishExtensionOperation(pkgName);
      await refreshSetupState();
      return false;
    }
    let ok = true;
    try {
      await fn();
      bumpContentSetupVersion();
      if (reloadAfter) await loadExtensions();
    } catch (error) {
      ok = false;
      console.error(error);
      const message = extensionErrorMessage(error);
      const extensionName = extensions.find((extension) => extension.pkgName === pkgName)?.name
        ?? translate("sources_runtime_extensionFallback");
      setExtensionOperationError(pkgName, message);
      const nextState = await refreshSetupState();
      if (!isServerUnavailableState(nextState)) {
        addToast({
          kind: "error",
          title: `${extensionOperationLabel(operation)} ${extensionName} failed`,
          body: message,
          duration: 6000,
        });
      }
    } finally {
      finishExtensionOperation(pkgName);
    }
    return ok;
  }

  async function installExtension(extension: ManagedExtension) {
    if (extension.kind === "novels") {
      if (!novelRepositoryState || !extension.novelPluginId || !extension.novelRepositoryId) {
        const message = translate("sources_runtime_novelMetadataNotLoaded");
        setExtensionOperationError(extension.pkgName, message);
        addToast({ kind: "error", title: translate("ui_couldNotInstallNovelSource"), body: message });
        return;
      }
      const entry = novelRepositoryState.catalogEntries.find((item) => (
        item.pluginId === extension.novelPluginId
        && item.repositoryId === extension.novelRepositoryId
      ));
      if (!entry) {
        const message = translate("sources_runtime_novelCatalogMissing");
        setExtensionOperationError(extension.pkgName, message);
        addToast({ kind: "error", title: translate("ui_couldNotInstallNovelSource"), body: message });
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
          title: extension.hasUpdate ? translate("ui_novelSourceUpdated") : translate("ui_novelSourceInstalled"),
          body: `${extension.name} is ready to use.`,
        });
      } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : translate("sources_runtime_novelPluginFailed");
        setExtensionOperationError(extension.pkgName, message);
        addToast({
          kind: "error",
          title: translate("ui_couldNotInstallNovelSource"),
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
    let blockedByRuntime = false;
    try {
      if (!(await ensureMangaServerAwake())) {
        blockedByRuntime = true;
        throw new Error(translate("sources_runtime_suwayomiUnavailable"));
      }
      if (!(await waitForSuwayomiGraphqlReady("extensions", { attempts: 8, delayMs: 800, timeoutMs: 5000 }))) {
        blockedByRuntime = true;
        throw new Error(translate("sources_runtime_suwayomiStarting"));
      }
      const runtime = await getManagedSourceRuntime();
      await runtime.installExtension({ packageName: extension.pkgName });
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
            title: translate("ui_extensionInstallNeedsRestart"),
            body: extensionErrorMessage(recoveryError),
            duration: 8000,
          });
          installedExtension = null;
        }
      } else {
        console.error(error);
        setExtensionOperationError(extension.pkgName, extensionErrorMessage(error));
        const nextState = blockedByRuntime ? null : await refreshSetupState();
        if (blockedByRuntime || isServerUnavailableState(nextState)) {
          if (blockedByRuntime) await refreshSetupState();
        } else {
          addToast({
            kind: "error",
            title: translate("ui_couldNotInstallExtension"),
            body: extensionErrorMessage(error),
            duration: 7000,
          });
        }
      }
    } finally {
      finishExtensionOperation(extension.pkgName);
    }

    if (!installedExtension) return;

    selectedPkgName = extension.pkgName;
    void loadExtensionPreferences(installedExtension);
    addToast({
      kind: "success",
      title: translate("ui_extensionInstalled"),
      body: translate("sources_runtime_extensionReady", { name: extension.name }),
    });

    if (firstInstallFlow) {
      filter = "installed";
      addToast({
        kind: "success",
        title: translate("ui_firstExtensionInstalled"),
        body: translate("sources_runtime_firstExtensionReady", { name: extension.name }),
      });
    }
  }

  async function installExternal() {
    const file = externalFile;
    if (!file) {
      installError = translate("sources_runtime_chooseApk");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".apk")) {
      installError = translate("sources_runtime_invalidApk");
      return;
    }

    installingExternal = true;
    installError = null;
    installSuccess = false;
    try {
      if (!(await ensureMangaServerAwake())) {
        installError = translate("sources_runtime_suwayomiUnavailable");
        return;
      }
      if (!(await waitForSuwayomiGraphqlReady("extensions", { attempts: 8, delayMs: 800, timeoutMs: 5000 }))) {
        installError = translate("sources_runtime_suwayomiStarting");
        return;
      }
      await gqlUpload(
        INSTALL_EXTERNAL_EXTENSION,
        { extensionFile: null },
        { "variables.extensionFile": file },
      );
      installSuccess = true;
      clearExternalFile();
      bumpContentSetupVersion();
      await loadExtensions();
      window.setTimeout(() => {
        utilityPanel = null;
        installSuccess = false;
      }, 1400);
    } catch (error) {
      installError = error instanceof Error ? error.message : translate("sources_runtime_installFailed");
    } finally {
      installingExternal = false;
    }
  }

  function openUtilityPanel(next: UtilityPanel) {
    utilityPanel = utilityPanel === next ? null : next;
    installError = null;
    installSuccess = false;
    clearExternalFile();
    repoError = null;
    newRepoUrl = "";
    if (next === "repos") void loadRepos();
  }

  function handleUtilityPanelKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || utilityPanel === null) return;
    event.preventDefault();
    event.stopPropagation();
    utilityPanel = null;
  }

  function selectExternalFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    externalFile = input.files?.[0] ?? null;
    installError = null;
    installSuccess = false;
  }

  function clearExternalFile() {
    externalFile = null;
    if (externalFileInput) externalFileInput.value = "";
  }

  function openExtensionSettings(extension: ManagedExtension) {
    // Card clicks only open settings. Catalog routing intentionally lives in Discover.
    selectedPkgName = extension.pkgName;
    utilityPanel = null;
    void loadExtensionPreferences(extension);
  }

  function openMassMigration(extension: ManagedExtension) {
    if (extension.kind !== "manga" || !extension.isInstalled) return;
    massMigrationExtension = extension;
  }

  function closeExtensionSettings() {
    preferenceLoadRun += 1;
    resetPreferenceState();
    selectedPkgName = null;
  }

  async function removeExtension(extension: ManagedExtension, event?: MouseEvent) {
    event?.stopPropagation();
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
          title: translate("ui_novelSourceRemoved"),
          body: translate("sources_runtime_extensionRemoved", { name: extension.name }),
        });
      } catch (error) {
        console.error(error);
        setExtensionOperationError(
          extension.pkgName,
          error instanceof Error ? error.message : translate("sources_runtime_novelPluginFailed"),
        );
        addToast({
          kind: "error",
          title: translate("ui_couldNotRemoveNovelSource"),
          body: error instanceof Error ? error.message : translate("ui_epigraphCouldNotRemoveThisNovelPlugin"),
        });
      } finally {
        finishExtensionOperation(extension.pkgName);
      }
      return;
    }
    const didRemove = await mutate(
      async () => {
        const runtime = await getManagedSourceRuntime();
        await runtime.uninstallExtension(extension.pkgName);
      },
      extension.pkgName,
      "remove",
      false,
    );
    if (didRemove && selectedPkgName === extension.pkgName) {
      selectedPkgName = null;
    }
    if (didRemove) {
      extensions = extensions.map((item) => (
        item.pkgName === extension.pkgName
          ? { ...item, isInstalled: false, hasUpdate: false }
          : item
      ));
      lastMangaExtensions = extensions.filter((item) => item.kind === "manga");
      addToast({
        kind: "success",
        title: translate("ui_extensionRemoved"),
        body: translate("sources_runtime_extensionRemoved", { name: extension.name }),
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
      async () => {
        const runtime = await getManagedSourceRuntime();
        await runtime.refreshExtensions();
        const candidate = (await runtime.listExtensions())
          .find((item) => item.packageName === extension.pkgName);
        if (!candidate) throw new Error(translate("sources_runtime_updateUnavailable"));
        const batchResult = await certifyMangaExtensionUpdates([candidate]);
        const rejection = batchResult.rejected.find((item) => item.packageName === extension.pkgName);
        if (rejection) {
          throw new Error(translate("sources_runtime_updateCompatibilityFailed"));
        }
      },
      extension.pkgName,
      "update",
      false,
    );
    if (!didUpdate) return;

    await loadExtensions();

    const refreshed = {
      ...(extensions.find((item) => item.pkgName === extension.pkgName) ?? extension),
      hasUpdate: false,
    };
    extensions = extensions.map((item) => (
      item.pkgName === extension.pkgName ? refreshed : item
    ));
    lastMangaExtensions = extensions.filter((item) => item.kind === "manga");
    if (selectedPkgName === extension.pkgName) {
      void loadExtensionPreferences(refreshed);
    }
    addToast({
      kind: "success",
      title: translate("ui_extensionUpdated"),
      body: translate("sources_runtime_compatibilityProbePassed", { name: extension.name }),
    });
  }

  async function updateAllExtensions() {
    const expectedKind = isNovelMode ? "novels" : "manga";
    const candidates = extensions.filter((extension) => extension.hasUpdate && extension.kind === expectedKind);
    if (candidates.length === 0 || updatingAll) return;

    updatingAll = true;
    let failedUpdateCount = 0;
    let blockedByRuntime = false;
    for (const extension of candidates) {
      startExtensionOperation(extension.pkgName, "update");
    }
    try {
      if (isNovelMode) {
        if (!novelRepositoryState) return;
        let nextState = novelRepositoryState;
        let hasNovelChanges = false;
        for (const extension of candidates) {
          try {
            if (!extension.novelPluginId || !extension.novelRepositoryId) {
              throw new Error(translate("sources_runtime_novelMetadataIncomplete"));
            }
            const entry = nextState.catalogEntries.find((item) => (
              item.pluginId === extension.novelPluginId
              && item.repositoryId === extension.novelRepositoryId
            ));
            if (!entry) {
              throw new Error(translate("sources_runtime_novelSourceMissing"));
            }
            nextState = await installNovelCatalogPlugin({
              state: nextState,
              entry,
              scopeInput: {
                profileId: store.runtimeResolvedLocalProfileId,
                serverUrl: store.runtimeServerUrl,
              },
            });
            hasNovelChanges = true;
          } catch (error) {
            failedUpdateCount += 1;
            console.error(error);
            setExtensionOperationError(
              extension.pkgName,
              error instanceof Error ? error.message : translate("sources_runtime_novelPluginFailed"),
            );
          }
        }
        if (hasNovelChanges) await saveNovelState(nextState);
      } else {
        if (!(await ensureMangaServerAwake())) {
          blockedByRuntime = true;
          throw new Error(translate("sources_runtime_suwayomiUnavailable"));
        }
        if (!(await waitForSuwayomiGraphqlReady("extensions", { attempts: 8, delayMs: 800, timeoutMs: 5000 }))) {
          blockedByRuntime = true;
          throw new Error(translate("sources_runtime_suwayomiStarting"));
        }
        const runtime = await getManagedSourceRuntime();
        await runtime.refreshExtensions();
        const candidateNames = new Set(candidates.map((extension) => extension.pkgName));
        const runtimeCandidates = (await runtime.listExtensions())
          .filter((extension) => candidateNames.has(extension.packageName));
        const batchResult = await certifyMangaExtensionUpdates(runtimeCandidates);
        const updatedPkgNames = new Set(batchResult.approved.map((item) => item.packageName));
        const rejectedPkgNames = new Set(batchResult.rejected.map((item) => item.packageName));
        failedUpdateCount = candidates.length - updatedPkgNames.size;
        for (const extension of candidates) {
          if (updatedPkgNames.has(extension.pkgName)) {
            if (selectedPkgName === extension.pkgName) {
              void loadExtensionPreferences(extension);
            }
          } else if (rejectedPkgNames.has(extension.pkgName)) {
            setExtensionOperationError(
              extension.pkgName,
              translate("sources_runtime_updateCompatibilityFailed"),
            );
          } else {
            setExtensionOperationError(
              extension.pkgName,
              translate("sources_runtime_updateProvenanceMissing"),
            );
          }
        }
        await loadExtensions();
        extensions = extensions.map((extension) => (
          updatedPkgNames.has(extension.pkgName)
            ? { ...extension, hasUpdate: false }
            : extension
        ));
        lastMangaExtensions = extensions.filter((extension) => extension.kind === "manga");
        bumpContentSetupVersion();
      }
      const succeededCount = candidates.length - failedUpdateCount;
      addToast({
        kind: failedUpdateCount > 0 ? "error" : "success",
        title: failedUpdateCount > 0 ? translate("ui_someExtensionsCouldNotUpdate") : translate("ui_extensionsUpdated"),
        body:
          failedUpdateCount > 0
            ? translate("sources_runtime_batchPartial", { succeeded: succeededCount, total: candidates.length })
            : translate("sources_runtime_batchReady", { count: candidates.length }),
      });
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : translate("ui_epigraphCouldNotFinishTheUpdateQueue");
      const nextState = blockedByRuntime ? null : await refreshSetupState();
      if (blockedByRuntime || isServerUnavailableState(nextState)) {
        for (const extension of candidates) setExtensionOperationError(extension.pkgName, message);
        if (blockedByRuntime) await refreshSetupState();
      } else {
        addToast({
          kind: "error",
          title: translate("ui_couldNotUpdateAllExtensions"),
          body: message,
        });
      }
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
    if (operation === "update") return $_("sources.actions.updating");
    if (operation === "remove") return $_("sources.actions.removing");
    if (operation === "install") return $_("sources.actions.installing");
    if (extension.hasUpdate) return $_("sources.actions.update");
    if (extension.isInstalled) return $_("sources.actions.remove");
    return $_("sources.actions.install");
  }

  function runVariantAction(event: MouseEvent, extension: ManagedExtension) {
    event.stopPropagation();
    if (extension.hasUpdate) {
      void updateExtension(event, extension);
    } else if (extension.isInstalled) {
      void removeExtension(extension, event);
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
    massMigrationExtension = null;
    search = "";
    loading = true;
    refreshing = false;
    extensionLoadError = null;
    const snapshot = untrack(() => mode === "manga" ? lastMangaExtensions : lastNovelExtensions);
    mangaExtensionCatalogLoaded = mode === "manga" && snapshot.length > 0;
    extensions = snapshot.length > 0 ? snapshot : [];
    if (mode === "manga") novelRepositoryState = null;
    untrack(() => {
      void loadExtensions(run).finally(() => {
        if (isCurrentExtensionLoad(run, mode)) loading = false;
      });
      if (mode !== "novels") void refreshSetupState();
    });
  });

  onMount(() => {
    const handleServerReady = () => {
      if (isNovelMode) return;
      const run = ++extensionLoadRun;
      void loadExtensions(run).finally(() => {
        if (isCurrentExtensionLoad(run, "manga")) loading = false;
      });
      void loadRepos();
      void refreshSetupState();
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

<svelte:window onkeydown={handleUtilityPanelKeydown} />

<div
  class="sourcesRoot"
  class:hasSettingsPanel={!!selectedExtension}
  class:updatesMode={filter === "updates"}
  data-sources-workspace
>
  <section class="sourcesMain">
    <div class="sourcesHeader">
      <div class="sourcesTitle">
        <h2>{sourceTitle}</h2>
        <span>{installedCount} {$_("sources.filters.installed")} · {availableCount} {$_("sources.filters.available")}</span>
      </div>

      <div class="headerActions">
        {#if isNovelMode}
          <button class="headerAction" class:active={utilityPanel === "novelRepos"} type="button" title={$_("sources.repositories.manageNovel")} onclick={() => openUtilityPanel("novelRepos")}>
            <GitBranch size={15} weight="bold" />
            <span>{$_("sources.repositories.novelTitle")}</span>
          </button>
        {:else}
          <button class="headerAction" class:active={utilityPanel === "repos"} type="button" title={$_("sources.repositories.manageManga")} onclick={() => openUtilityPanel("repos")}>
            <GitBranch size={15} weight="bold" />
            <span>{$_("sources.repositories.mangaTitle")}</span>
          </button>
          <button class="headerAction headerActionPrimary" class:active={utilityPanel === "apk"} type="button" title={$_("sources.apk.title")} onclick={() => openUtilityPanel("apk")}>
            <Plus size={15} weight="bold" />
            <span>{$_("sources.actions.install")} APK</span>
          </button>
        {/if}
      </div>
    </div>

    <div class="sourcesSurface">
      <div class="sourceTools">
        <div class="tabs">
          {#each activeFilters as item}
            {@const itemCount = item.id === "installed" ? installedCount : item.id === "available" ? availableCount : updateCount}
            <button
              class="tab"
              class:active={filter === item.id}
              type="button"
              aria-label={item.label}
              onclick={() => {
                selectedPkgName = null;
                filter = item.id;
              }}
            >
              {item.label}<small>{itemCount}</small>
            </button>
          {/each}
        </div>

        {#if filter !== "updates"}
          <div class="searchWrap">
            <MagnifyingGlass size={13} weight="bold" />
            <input bind:value={search} placeholder={searchPlaceholder} />
          </div>
        {:else if updateCount > 0}
          <button class="toolbarActionBtn" type="button" disabled={updatingAll} onclick={updateAllExtensions}>
            {#if updatingAll}
              <CircleNotch size={13} weight="bold" class="anim-spin" />
              {$_("sources.actions.updating")}
            {:else}
              {updateAllLabel}
            {/if}
          </button>
        {/if}
      </div>

    {#if isNovelMode && utilityPanel === "novelRepos"}
      <div class="repoOverlay" role="presentation">
        <button class="repoOverlayBackdrop" type="button" aria-label={$_("sources.repositories.closePanel")} onclick={() => (utilityPanel = null)}></button>
        <div class="utilityPanel repoWindow novelRepoPanel" role="dialog" aria-modal="true" aria-label={$_("sources.repositories.novelTitle")}>
        <div class="utilityHeader">
          <div class="utilityHeaderCopy">
            <strong>{$_("sources.repositories.novelTitle")}</strong>
            <span>{novelRepositorySummary}</span>
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
                eyebrow={$_("sources.repositories.novelTitle")}
                title={$_("sources.repositories.emptyTitle")}
                body={$_("sources.repositories.emptyNovelBody")}
              />
            {:else}
              {#each novelRepositoryState.repositories as repo}
                {@const repoState = deriveNovelRepositoryUiState(repo)}
                {@const repoPluginCount = novelRepositoryState.catalogEntries.filter((entry) => entry.repositoryId === repo.id).length}
                <div class="repoRow novelRepoRow">
                  <div class="novelRepoCopy">
                    <strong>{repo.recommendedSeed ? $_("sources.repositories.officialLnreader") : repo.normalizedUrl}</strong>
                    <span>{$_("sources.repositories.pluginSummary", { count: repoPluginCount, state: repoState })}</span>
                    {#if repo.lastError}<small>{repo.lastError}</small>{/if}
                  </div>
                  <div class="novelRepoActions">
                    <button type="button" disabled={refreshingNovelRepositoryId === repo.id} onclick={() => refreshNovelRepo(repo)}>
                      {#if refreshingNovelRepositoryId === repo.id}<CircleNotch size={12} weight="bold" class="anim-spin" />{:else}{$_("sources.actions.refresh")}{/if}
                    </button>
                    <button type="button" disabled={savingRepos} onclick={() => toggleNovelRepo(repo)}>
                      {repo.enabled ? $_("sources.actions.disable") : $_("sources.actions.enable")}
                    </button>
                    <button type="button" disabled={savingRepos} onclick={() => removeNovelRepo(repo)}>
                      {$_("sources.actions.remove")}
                    </button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <div class="inlineForm">
            <input
              class:error={repoError}
              placeholder={$_("ui_httpsExampleComPluginsMinJson")}
              bind:value={newRepoUrl}
              disabled={savingRepos}
              oninput={() => (repoError = null)}
              onkeydown={(event) => event.key === "Enter" && !savingRepos && addNovelRepo(newRepoUrl)}
            />
            <button type="button" disabled={savingRepos || !newRepoUrl.trim()} onclick={() => addNovelRepo(newRepoUrl)}>
              {#if savingRepos}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}{$_("sources.actions.add")}{/if}
            </button>
            <button type="button" disabled={savingRepos} onclick={() => addNovelRepo(LNREADER_AUDITED_OFFICIAL_REPOSITORY_URL, true)}>
              {$_("sources.actions.official")}
            </button>
          </div>
          {#if repoError}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("sources.repositories.errorEyebrow")} title={$_("sources.repositories.errorTitle")} body={repoError} />
          {/if}
        {/if}
        </div>
      </div>
    {/if}

    {#if !isNovelMode && utilityPanel === "apk"}
      <div class="repoOverlay" role="presentation">
        <button class="repoOverlayBackdrop" type="button" aria-label={$_("sources.apk.closePanel")} onclick={() => openUtilityPanel("apk")}></button>
        <div class="utilityPanel repoWindow repoWindowNarrow apkInstallDialog" role="dialog" aria-modal="true" aria-label={$_("sources.apk.title")}>
          <div class="utilityHeader">
            <div class="utilityHeaderCopy">
              <strong>{$_("sources.apk.title")}</strong>
              <span>{$_("sources.apk.subtitle")}</span>
            </div>
            <button class="closeUtility" type="button" aria-label={$_("sources.apk.closePanel")} onclick={() => openUtilityPanel("apk")}><X size={14} weight="bold" /></button>
          </div>
          <p class="apkInstallHint">{$_("sources.apk.hint")}</p>
          <div class="apkFilePicker" class:error={installError}>
            <input
              class="apkFileInput"
              class:error={installError}
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              bind:this={externalFileInput}
              disabled={installingExternal}
              onchange={selectExternalFile}
            />
            <button class="apkChooseFile" type="button" disabled={installingExternal} onclick={() => externalFileInput?.click()}>
              <FileArrowUp size={14} weight="regular" />
              <span>{$_("ui_chooseFile")}</span>
            </button>
            <div class="apkFileCopy">
              <strong>{externalFile?.name ?? $_("sources.apk.noFile")}</strong>
              <span>{externalFile ? $_("ui_selectedFile") : ".apk"}</span>
            </div>
          </div>
          <div class="apkInstallActions">
            <button class="apkInstallButton" type="button" class:success={installSuccess} disabled={installingExternal} onclick={installExternal}>
              {#if installingExternal}
                <CircleNotch size={13} weight="bold" class="anim-spin" />
              {:else if installSuccess}
                <Check size={13} weight="bold" /> {$_("sources.actions.done")}
              {:else}
                {$_("sources.actions.install")}
              {/if}
            </button>
          </div>
          {#if installError}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("sources.apk.errorEyebrow")} title={$_("sources.apk.errorTitle")} body={installError} />
          {/if}
        </div>
      </div>
    {/if}

    {#if !isNovelMode && utilityPanel === "repos"}
      <div class="repoOverlay" role="presentation">
        <button class="repoOverlayBackdrop" type="button" aria-label={$_("sources.repositories.closePanel")} onclick={() => (utilityPanel = null)}></button>
        <div class="utilityPanel repoWindow novelRepoPanel" role="dialog" aria-modal="true" aria-label={$_("sources.repositories.mangaTitle")}>
          <div class="utilityHeader">
            <div class="utilityHeaderCopy">
              <strong>{$_("sources.repositories.mangaTitle")}</strong>
              <span>{$_("sources.repositories.mangaSummary", { count: repos.length })}</span>
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
              eyebrow={$_("sources.repositories.mangaTitle")}
              title={$_("sources.repositories.emptyTitle")}
              body={$_("sources.repositories.emptyMangaBody")}
            />
          {:else}
            <div class="repoList compactRepoList">
              {#each repos as repo}
                <div class="repoRow novelRepoRow">
                  <div class="novelRepoCopy">
                    <strong>{repo}</strong>
                    <span>{$_("sources.repositories.extensionRepository")}</span>
                  </div>
                  <div class="novelRepoActions">
                    <button type="button" disabled={savingRepos} onclick={() => removeRepo(repo)}>
                      {#if savingRepos}<CircleNotch size={12} weight="bold" class="anim-spin" />{:else}{$_("sources.actions.remove")}{/if}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          <div class="inlineForm">
            <input
              class:error={repoError}
              placeholder={$_("ui_httpsExampleComIndexMinJson")}
              bind:value={newRepoUrl}
              disabled={savingRepos}
              oninput={() => (repoError = null)}
              onkeydown={(event) => event.key === "Enter" && !savingRepos && addRepo()}
            />
            <button type="button" disabled={savingRepos || !newRepoUrl.trim()} onclick={addRepo}>
              {#if savingRepos}<CircleNotch size={13} weight="bold" class="anim-spin" />{:else}{$_("sources.actions.add")}{/if}
            </button>
          </div>
          {#if repoError}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("sources.repositories.errorEyebrow")} title={$_("sources.repositories.errorTitle")} body={repoError} />
          {/if}
        {/if}
        </div>
      </div>
    {/if}

    {#if loading || awaitingFirstMangaCatalog}
      <div class="emptyState">
        <CircleNotch size={18} weight="bold" class="anim-spin" />
      </div>
    {:else if showLoadError}
      <div class="emptyState emptyState--panel">
        <NocturneState
          layout="center"
          tone="warning"
          icon="retry"
          eyebrow="Suwayomi"
          title={$_("sources_runtime_sourcesReconnecting")}
          body={extensionLoadError ?? $_("sources_runtime_sourcesReadFailed")}
          actions={[{
            label: $_("sources.actions.refresh"),
            kind: "primary",
            icon: "retry",
            onClick: () => {
              loading = true;
              const run = ++extensionLoadRun;
              void loadExtensions(run).finally(() => {
                if (isCurrentExtensionLoad(run, isNovelMode ? "novels" : "manga")) loading = false;
              });
            },
          }]}
        />
      </div>
    {:else if groups.length === 0}
      <div class="emptyState emptyState--panel">
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
        {:else}
          <NocturneState
            layout="center"
            tone="info"
            icon="search"
            eyebrow={$_("sources.eyebrow")}
            title={isNovelMode ? $_("sources.empty.noNovelSources") : $_("sources.empty.noExtensions")}
            body={isNovelMode ? $_("sources.empty.novelBody") : $_("sources.empty.mangaBody")}
          />
        {/if}
      </div>
    {:else}
      <div class="extensionList" data-sources-updates-view={filter === "updates" ? "" : undefined}>
        {#if filter === "updates"}
          <div class="updatesHeading">
            <div>
              <strong>{$_("sources.filters.updates")}</strong>
              <span>{sourceCountLabel}</span>
            </div>
            <ArrowCircleUp size={17} weight="bold" />
          </div>
        {/if}
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
              <h3>{base}</h3>
              <p>{primary.kind === "novels" ? primary.site || "LNReader" : primary.apkName || "Suwayomi"}</p>
            </div>

            <span class="extensionLanguage">{primary.lang.toUpperCase()}{#if hasVariants} · {variants.length + 1}{/if}</span>

            <div class="extensionState" aria-hidden="true">
              {#if primary.hasUpdate}
                <ArrowCircleUp size={16} weight="bold" />
              {:else if primary.isInstalled}
                <CheckCircle size={16} weight="bold" />
              {:else}
                <Package size={16} weight="bold" />
              {/if}
            </div>

            <div class="cardActions">
              {#if isExtensionWorking(primary.pkgName)}
                <CircleNotch size={16} weight="bold" class="anim-spin" />
              {:else if primary.hasUpdate}
                <button class="actionBtn" type="button" onclick={(event) => updateExtension(event, primary)}>{$_("sources.actions.update")}</button>
              {:else if !primary.isInstalled}
                <button class="actionBtn" type="button" onclick={(event) => installFromList(event, primary)}>{$_("sources.actions.install")}</button>
              {/if}

              {#if hasVariants}
                <button class="variantBtn" type="button" onclick={(event) => toggleExpand(event, base)} title={$_("sources.card.variants", { count: variants.length + 1 })}>
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
                    {#if variant.hasUpdate}<em>{$_("sources.actions.update")}</em>{/if}
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
            {$_("sources.actions.showMore", { count: Math.min(remainingCount, renderLimit) })}
          </button>
        {/if}
      </div>
    {/if}
      <footer class="sourcesFooter">
        <span>{sourceCountLabel}</span>
        <button
          type="button"
          disabled={refreshing}
          onclick={fetchFromRepo}
        >
          {#if refreshing}<CircleNotch size={12} weight="bold" class="anim-spin" />{:else}<ArrowsClockwise size={12} weight="bold" />{/if}
          {$_("sources.actions.refresh")}
        </button>
      </footer>
    </div>
  </section>

  {#if !selectedExtension && filter !== "updates" && !loading}
    <aside class="sourcesOverview" data-sources-overview>
      <div class="overviewHeader">
        <span>{$_("sources.eyebrow")}</span>
        <strong>{sourceTitle}</strong>
      </div>
      <button type="button" onclick={() => (filter = "installed")}>
        <CheckCircle size={16} weight="bold" />
        <span><strong>{$_("sources.filters.installed")}</strong><small>{installedCount}</small></span>
        <CaretRight size={13} weight="bold" />
      </button>
      <button type="button" onclick={() => (filter = "available")}>
        <Package size={16} weight="bold" />
        <span><strong>{$_("sources.filters.available")}</strong><small>{availableCount}</small></span>
        <CaretRight size={13} weight="bold" />
      </button>
      <button class:overviewWarning={updateCount > 0} type="button" onclick={() => (filter = "updates")}>
        <ArrowCircleUp size={16} weight="bold" />
        <span><strong>{$_("sources.filters.updates")}</strong><small>{updateCount}</small></span>
        <CaretRight size={13} weight="bold" />
      </button>
      <button type="button" onclick={() => openUtilityPanel(isNovelMode ? "novelRepos" : "repos")}>
        <GitBranch size={16} weight="bold" />
        <span><strong>{isNovelMode ? $_("sources.repositories.novelTitle") : $_("sources.repositories.mangaTitle")}</strong><small>{isNovelMode ? novelRepositoryCount : repos.length}</small></span>
        <CaretRight size={13} weight="bold" />
      </button>
    </aside>
  {/if}

  {#if selectedExtension}
    <ExtensionSettingsPanel
      extension={selectedExtension}
      busy={isExtensionWorking(selectedExtension.pkgName)}
      onClose={closeExtensionSettings}
      onInstall={installExtension}
      onRemove={(extension) => void removeExtension(extension)}
      onMassMigration={openMassMigration}
      {preferenceGroups}
      {preferenceAccess}
      {preferenceLoading}
      {preferenceLoadError}
      {preferenceBusyKey}
      {preferenceErrors}
      {novelPreferenceKeys}
      {selectedPreferenceSourceId}
      onSelectPreferenceSource={loadPreferenceSource}
      onUpdatePreference={updateSourcePreference}
      compatibilityReport={latestCompatibilityReport(selectedExtension.pkgName)}
      compatibilityBusy={checkingCompatibilityPkg === selectedExtension.pkgName}
      onCheckCompatibility={checkCompatibility}
    />
  {/if}

  {#if massMigrationExtension}
    <MassMigrateModal
      extension={massMigrationExtension}
      installedExtensionPkgNames={extensions.filter((extension) => extension.kind === "manga" && extension.isInstalled).map((extension) => extension.pkgName)}
      onClose={() => (massMigrationExtension = null)}
      onCompleted={() => {
        massMigrationExtension = null;
        void loadExtensions();
      }}
    />
  {/if}
</div>

<style>
  /* Approved Nocturne Sources composition: full-area workspace, flat rows and a quiet rail. */
  .sourcesRoot {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) clamp(218px, 20vw, 258px);
    gap: 22px;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--component-sources-flat-radius);
    background: transparent;
    padding: 14px 18px 12px;
  }

  .sourcesRoot.updatesMode { grid-template-columns: minmax(0, 1fr); }

  .sourcesRoot.hasSettingsPanel {
    grid-template-columns: minmax(0, 1fr) clamp(292px, 23vw, 350px);
    gap: 0;
  }

  .sourcesMain {
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
    min-height: 62px;
    padding: 0 0 12px;
    border-bottom: 0;
    background: transparent;
  }

  .sourcesTitle {
    display: grid;
    gap: 5px;
    min-width: 190px;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: var(--component-sources-title-fg);
    font-size: 21px;
    font-weight: 760;
    line-height: 1.1;
  }

  .sourcesTitle span {
    color: var(--component-sources-muted-fg);
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
  }

  .headerActions { display: flex; align-items: center; gap: 8px; }

  .headerAction {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: var(--component-sources-control-radius);
    color: var(--component-sources-control-fg);
    background: transparent;
    font-size: 10px;
    font-weight: 760;
  }

  .headerAction:hover,
  .headerAction.active {
    color: var(--component-sources-control-hover-fg);
    border-color: var(--component-sources-control-hover-border);
    background: var(--component-sources-control-hover-bg);
  }

  .headerActionPrimary {
    border-color: var(--component-sources-control-border);
    background: var(--component-sources-control-bg);
    color: var(--component-sources-strong-fg);
  }

  .sourcesSurface {
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--component-sources-root-border);
    border-radius: var(--component-sources-root-radius);
    background: var(--component-sources-root-bg);
  }

  .sourceTools {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 0 0 46px;
    justify-content: flex-start;
    padding: 0 13px;
    border-bottom: 1px solid var(--component-sources-header-divider);
  }

  .tabs {
    display: flex;
    align-self: stretch;
    gap: 18px;
    padding: 0;
    border: 0;
    border-radius: var(--component-sources-flat-radius);
    background: transparent;
  }

  .tab {
    position: relative;
    min-height: 100%;
    padding: 0;
    border-radius: var(--component-sources-flat-radius);
    color: var(--component-sources-tab-fg);
    font-size: 11px;
    font-weight: 900;
    transition: color 160ms ease;
  }

  .tab small { margin-left: 6px; color: var(--component-sources-subtle-fg); font-size: 9px; }

  .tab::after {
    content: "";
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 2px;
    background: transparent;
  }

  .tab.active {
    background: transparent;
    color: var(--component-sources-tab-active-fg);
    box-shadow: none;
  }

  .tab.active::after { background: var(--component-sources-primary-bg); }

  .searchWrap {
    display: flex;
    align-items: center;
    gap: 8px;
    width: min(320px, 31vw);
    min-width: 170px;
    height: 30px;
    margin-left: 18px;
    padding: 0 11px;
    border-radius: var(--component-sources-search-radius);
    border: 1px solid var(--component-sources-search-border);
    background: var(--component-sources-search-bg);
    color: var(--component-sources-search-icon-fg);
  }

  .searchWrap input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    color: var(--component-sources-search-fg);
    background: transparent;
    font-size: 13px;
  }

  .searchWrap input::placeholder {
    color: var(--component-sources-search-placeholder);
  }

  .closeUtility,
  .repoRow button {
    display: grid;
    place-items: center;
    width: 29px;
    height: 29px;
    border-radius: var(--component-sources-control-radius);
    color: var(--component-sources-control-fg);
    border: 1px solid var(--component-sources-control-border);
    background: var(--component-sources-control-bg);
    transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
  }

  .closeUtility:hover,
  .repoRow button:hover:not(:disabled) {
    color: var(--component-sources-control-hover-fg);
    border-color: var(--component-sources-control-hover-border);
    background: var(--component-sources-control-hover-bg);
  }

  .setupWrap {
    position: relative;
    z-index: var(--component-sources-setup-z-index);
    width: min(100%, 760px);
    margin: 0;
  }
  .setupWrap :global(.n-state) {
    width: 100%;
    margin: 0;
  }

  .utilityPanel {
    margin: 10px 14px 0;
  }

  .repoOverlay {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: calc(-1 * var(--component-sources-sidebar-width));
    z-index: var(--component-sources-overlay-z-index);
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
    background: var(--component-sources-overlay-bg);
    backdrop-filter: var(--component-sources-overlay-blur);
  }

  :global(body.epigraph-sources-modal-open .n-sidebar::after) {
    content: "";
    position: absolute;
    inset: -1px;
    z-index: var(--component-sources-sidebar-scrim-z-index);
    pointer-events: none;
    border-radius: inherit;
    background: var(--component-sources-sidebar-scrim-bg);
    backdrop-filter: var(--component-sources-sidebar-scrim-blur);
  }

  .repoWindow {
    position: relative;
    z-index: var(--component-sources-window-z-index);
    width: min(720px, 100%);
    max-height: min(78vh, 620px);
    margin: 0;
    overflow: hidden;
    border-color: var(--component-sources-window-border);
    background: var(--component-sources-window-bg);
    box-shadow: var(--component-sources-window-shadow);
    animation: repoWindowIn 150ms ease both;
  }

  .repoWindowNarrow {
    width: min(500px, 100%);
  }

  .utilityPanel {
    display: grid;
    gap: 12px;
    padding: 12px;
    border-radius: var(--component-sources-panel-radius);
    border: 1px solid var(--component-sources-panel-border);
    background: var(--component-sources-panel-bg);
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
    border-bottom: 1px solid var(--component-sources-panel-divider);
  }

  .utilityHeaderCopy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .utilityHeader strong {
    color: var(--component-sources-strong-fg);
    font-size: 14px;
  }

  .utilityHeaderCopy span {
    color: var(--component-sources-subtle-fg);
    font-size: 11px;
    font-weight: 700;
  }

  .apkInstallDialog {
    gap: 0;
    padding: 0;
  }

  .apkInstallDialog .utilityHeader {
    padding: 14px 16px 12px;
  }

  .apkInstallHint {
    margin: 0;
    padding: 13px 16px 0;
    color: var(--component-sources-hint-fg);
    font-size: 11.5px;
    line-height: 1.5;
  }

  .apkFilePicker {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 11px;
    margin: 13px 16px 0;
    min-height: 54px;
    padding: 8px;
    border: 1px solid var(--component-sources-apk-picker-border);
    border-radius: var(--component-sources-apk-picker-radius);
    background: var(--component-sources-apk-picker-bg);
    transition: border-color 140ms ease, background 140ms ease;
  }

  .apkFilePicker:hover {
    border-color: var(--component-sources-apk-picker-hover-border);
    background: var(--component-sources-apk-picker-hover-bg);
  }

  .apkFilePicker.error {
    border-color: var(--component-sources-field-error-border);
  }

  .apkFileInput {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .apkChooseFile {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 36px;
    padding: 0 11px;
    border: 1px solid var(--component-sources-apk-button-border);
    border-radius: var(--component-sources-apk-button-radius);
    background: var(--component-sources-apk-button-bg);
    color: var(--component-sources-apk-button-fg);
    font-size: 10.5px;
    font-weight: 800;
  }

  .apkChooseFile:hover:not(:disabled) {
    border-color: var(--component-sources-apk-button-hover-border);
    background: var(--component-sources-apk-button-hover-bg);
    color: var(--component-sources-apk-button-hover-fg);
  }

  .apkChooseFile:focus-visible,
  .apkInstallButton:focus-visible {
    outline: none;
    box-shadow: var(--component-sources-apk-focus-shadow);
  }

  .apkFileCopy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .apkFileCopy strong {
    overflow: hidden;
    color: var(--component-sources-apk-file-fg);
    font-size: 11.5px;
    font-weight: 750;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .apkFileCopy span {
    color: var(--component-sources-apk-meta-fg);
    font-size: 9.5px;
    font-weight: 700;
  }

  .apkInstallActions {
    display: flex;
    justify-content: flex-end;
    margin-top: 14px;
    padding: 11px 16px 14px;
    border-top: 1px solid var(--component-sources-panel-divider);
  }

  .apkInstallButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 82px;
    min-height: 31px;
    padding: 0 13px;
    border: 1px solid var(--component-sources-apk-install-border);
    border-radius: var(--component-sources-action-radius);
    background: var(--component-sources-apk-install-bg);
    color: var(--component-sources-apk-install-fg);
    font-size: 10.5px;
    font-weight: 900;
  }

  .apkInstallButton:hover:not(:disabled) {
    border-color: var(--component-sources-apk-install-hover-border);
    background: var(--component-sources-apk-install-hover-bg);
    color: var(--component-sources-apk-install-hover-fg);
  }

  .apkInstallButton.success {
    border-color: var(--component-sources-apk-install-success-border);
    background: var(--component-sources-apk-install-success-bg);
    color: var(--component-sources-apk-install-success-fg);
  }

  .apkInstallButton:disabled {
    border-color: var(--component-sources-apk-install-disabled-border);
    background: var(--component-sources-apk-install-disabled-bg);
    color: var(--component-sources-apk-install-disabled-fg);
  }

  .apkChooseFile:disabled {
    cursor: default;
    opacity: 0.52;
  }

  .apkInstallButton:disabled {
    cursor: default;
  }

  .apkInstallDialog :global(.n-state) {
    margin: 12px 16px 0;
  }

  .inlineForm {
    gap: 8px;
  }

  .inlineForm input {
    flex: 1;
    min-width: 0;
    min-height: 33px;
    padding: 0 12px;
    border-radius: var(--component-sources-field-radius);
    border: 1px solid var(--component-sources-field-border);
    background: var(--component-sources-field-bg);
    color: var(--component-sources-field-fg);
    outline: 0;
  }

  .inlineForm input.error {
    border-color: var(--component-sources-field-error-border);
  }

  .inlineForm button,
  .toolbarActionBtn,
  .actionBtn,
  .variantAction {
    min-height: 26px;
    border-radius: var(--component-sources-action-radius);
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
    background: var(--component-sources-primary-bg);
    color: var(--component-sources-primary-ink);
  }

  .inlineForm button:disabled,
  .toolbarActionBtn:disabled,
  .actionBtn:disabled,
  .variantAction:disabled {
    opacity: 0.52;
  }

  .toolbarActionBtn {
    min-height: 29px;
    border-radius: var(--component-sources-tab-radius);
    padding: 0 12px;
    white-space: nowrap;
    margin-left: auto;
  }

  .variantAction {
    min-height: 24px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .extensionOperationError {
    grid-column: 1 / -1;
    margin: -2px 0 0 46px;
    color: var(--component-sources-danger-fg);
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
    scrollbar-color: var(--component-sources-scrollbar-thumb) transparent;
  }

  .repoRow {
    gap: 10px;
    min-height: 36px;
    padding: 0 8px 0 12px;
    border-radius: var(--component-sources-repo-row-radius);
    border: 1px solid var(--component-sources-repo-row-border);
    background: var(--component-sources-repo-row-bg);
  }

  .repoRow span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--component-sources-body-fg);
    font-size: 12px;
  }

  .repoRow button {
    width: 24px;
    height: 24px;
    border-radius: var(--component-sources-repo-action-radius);
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
    color: var(--component-sources-cell-fg);
    font-size: 11.5px;
    font-weight: 850;
  }

  .novelRepoCopy span {
    color: var(--component-sources-muted-fg);
    font-size: 10px;
  }

  .novelRepoCopy small {
    color: var(--component-sources-error-fg);
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
    border-radius: var(--component-sources-novel-repo-action-radius);
    font-size: 9.5px;
    font-weight: 900;
    background: var(--component-sources-repo-action-bg);
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
    color: var(--component-sources-subtle-fg);
  }

  .extensionList {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 0;
    padding: 0 14px;
    scrollbar-width: thin;
    scrollbar-color: var(--component-sources-scrollbar-thumb) transparent;
  }

  .hasSettingsPanel .sourcesSurface { border-radius: var(--component-sources-root-radius) 0 0 var(--component-sources-root-radius); }

  .extensionCard {
    display: grid;
    grid-template-columns: 30px minmax(160px, 1fr) minmax(72px, 110px) 18px minmax(68px, auto);
    gap: 11px;
    align-items: center;
    min-height: 52px;
    padding: 5px 1px;
    border-radius: var(--component-sources-flat-radius);
    border: 0;
    border-bottom: 1px solid var(--component-sources-card-border);
    background: transparent;
    cursor: pointer;
    transition: background 160ms ease, border-color 160ms ease;
  }

  .extensionCard:hover,
  .extensionCard.selected {
    background: var(--component-sources-card-hover-bg);
    border-bottom-color: var(--component-sources-card-hover-border);
  }

  .extensionCard:last-of-type {
    border-bottom-color: transparent;
  }

  .extensionCard:focus-visible {
    outline: 2px solid var(--component-sources-card-focus-outline);
    outline-offset: 2px;
  }

  .extensionCardIcon {
    width: 28px;
    height: 28px;
    border-radius: var(--component-sources-icon-radius);
    object-fit: cover;
    background: var(--component-sources-icon-bg);
    border: 1px solid var(--component-sources-icon-border);
  }

  .extensionCardCopy {
    min-width: 0;
    display: grid;
    gap: 4px;
  }

  .cardActions,
  .variantRow {
    display: flex;
    align-items: center;
  }

  h3 {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--component-sources-strong-fg);
    font-size: 12px;
    font-weight: 760;
    line-height: 1.2;
  }

  .extensionCardCopy p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--component-sources-cell-muted-fg);
    font-size: 9px;
  }

  .extensionLanguage {
    color: var(--component-sources-cell-muted-fg);
    font-size: 9px;
    text-align: right;
  }

  .extensionState {
    display: grid;
    place-items: center;
    color: var(--component-sources-installed-fg);
  }

  .extensionCard:has(.actionBtn) .extensionState { color: var(--component-sources-update-fg); }

  .variantRow span,
  .variantRow small,
  .variantRow em {
    border-radius: var(--component-sources-badge-radius);
    padding: 2px 6px 1px;
    border: 1px solid var(--component-sources-badge-border);
    background: var(--component-sources-badge-bg);
    color: var(--component-sources-badge-fg);
    font-family: var(--font-ui);
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    line-height: 1.2;
  }

  .variantRow em {
    color: var(--component-sources-update-fg);
    background: var(--component-sources-update-bg);
    border-color: var(--component-sources-update-border);
    font-style: normal;
  }

  .cardActions {
    justify-content: flex-end;
    gap: 6px;
    color: var(--component-sources-available-fg);
  }

  .updatesHeading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 58px;
    padding: 0 2px;
    border-bottom: 1px solid var(--component-sources-card-border);
    color: var(--component-sources-update-fg);
  }

  .updatesHeading div { display: grid; gap: 4px; }
  .updatesHeading strong { color: var(--component-sources-strong-fg); font-size: 14px; }
  .updatesHeading span { color: var(--component-sources-cell-muted-fg); font-size: 9px; }

  .sourcesFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 32px;
    padding: 0 14px;
    border-top: 1px solid var(--component-sources-header-divider);
    color: var(--component-sources-subtle-fg);
    font-size: 9px;
  }

  .sourcesFooter button {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    gap: 5px;
    padding: 0 7px;
    border-radius: var(--component-sources-footer-action-radius);
    background: var(--component-sources-footer-action-bg);
    color: var(--component-sources-footer-action-fg);
    font-size: 9px;
    font-weight: 750;
  }

  .sourcesFooter button:hover:not(:disabled) {
    background: var(--component-sources-footer-action-hover-bg);
    color: var(--component-sources-footer-action-hover-fg);
  }

  .sourcesFooter button:disabled {
    color: var(--component-sources-footer-action-disabled-fg);
    opacity: 0.72;
  }

  .sourcesOverview {
    min-width: 0;
    margin-top: 62px;
    padding-left: 18px;
    border-left: 1px solid var(--component-sources-header-divider);
  }

  .overviewHeader { display: grid; gap: 5px; padding: 11px 0 14px; }
  .overviewHeader span { color: var(--component-sources-subtle-fg); font-size: 9px; }
  .overviewHeader strong { color: var(--component-sources-strong-fg); font-size: 13px; }

  .sourcesOverview > button {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) 14px;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 52px;
    padding: 0;
    border-top: 1px solid var(--component-sources-header-divider);
    color: var(--component-sources-control-fg);
    text-align: left;
  }

  .sourcesOverview > button > span { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .sourcesOverview strong { color: var(--component-sources-strong-fg); font-size: 10px; }
  .sourcesOverview small { color: var(--component-sources-subtle-fg); font-size: 9px; }
  .sourcesOverview .overviewWarning { color: var(--component-sources-update-fg); }
  .sourcesOverview > button:hover strong { color: var(--component-sources-primary-ink); }

  .variantBtn {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: var(--component-sources-action-radius);
    color: var(--component-sources-subtle-fg);
    border: 1px solid var(--component-sources-root-border);
    background: var(--component-sources-variant-bg);
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
    border-radius: var(--component-sources-variant-radius);
    background: var(--component-sources-variant-bg);
    border: 1px solid var(--component-sources-variant-border);
    text-align: left;
  }

  .variantRow.selected {
    border-color: var(--component-sources-variant-selected-border);
    background: var(--component-sources-variant-selected-bg);
  }

  .variantRow strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--component-sources-cell-fg);
    font-size: 12px;
  }

  .loadMoreBtn {
    grid-column: 1 / -1;
    justify-self: center;
    min-height: 34px;
    padding: 0 16px;
    border-radius: var(--component-sources-load-more-radius);
    color: var(--component-sources-load-more-fg);
    background: var(--component-sources-load-more-bg);
    border: 1px solid var(--component-sources-load-more-border);
    font-weight: 900;
  }

  .emptyState {
    flex: 1;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 8px;
    color: var(--component-sources-empty-fg);
    text-align: center;
  }

  @media (max-width: 980px) {
    .sourcesRoot { grid-template-columns: minmax(0, 1fr); }
    .sourcesOverview { display: none; }

    .sourcesHeader {
      align-items: center;
      flex-direction: row;
    }

    .sourceTools {
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .searchWrap {
      flex: 1;
      min-width: 220px;
    }

    .extensionCard {
      grid-template-columns: 30px minmax(0, 1fr) minmax(60px, 90px) 18px minmax(68px, auto);
    }
  }

  @media (max-width: 760px) {
    .sourcesRoot {
      position: relative;
      padding: 10px;
    }

    .extensionCard {
      grid-template-columns: 30px minmax(0, 1fr) 18px;
    }

    .extensionLanguage { display: none; }

    .cardActions {
      grid-column: 2 / -1;
      justify-content: flex-end;
    }

    .variantList {
      padding-left: 0;
    }
  }
</style>
