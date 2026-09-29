<script lang="ts">
  import { onMount } from "svelte";
  import { createNovelReaderPreparation, registerNovelReaderPreparation, type NovelReaderPreparation } from "./lib/reader/restorePreparation";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
  import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { getServerAuthHeader, gql } from "./lib/startupClient";
  import { getServerTargetInfo } from "./lib/serverTarget";
  import {
    shouldAutoStartManagedServer,
    shouldBootFromLibrarySnapshot,
  } from "./lib/serverBootPolicy";
  import {
    DEFAULT_LOCAL_PROFILE_ID,
    type LocalProfileId,
    localProfileDisplayName,
    normalizeLocalProfileId as normalizeLocalProfileIdFromSession,
    normalizeServerUrl as normalizeServerUrlFromSession,
    resolveSessionProfile as resolveSessionProfileFromLocalProfiles,
    type LaunchTargetProfileOverrides,
  } from "./lib/localProfiles";
  import {
    GET_CHAPTERS,
    GET_CATEGORIES_SUMMARY,
    GET_DOWNLOAD_STATUS,
    GET_LIBRARY,
    GET_LIBRARY_TRACKING_SUMMARY,
    GET_RESTORE_STATUS,
    GET_TRACKERS,
    RESTORE_BACKUP,
    UPDATE_EXTENSION,
  } from "./lib/startupQueries";
  import {
    store,
    addToast,
    openBookReader,
    replaceBooksState,
    updateSettings,
    setActiveDownloads,
    setActiveBookId,
    setLibraryBootstrap,
    setCategories,
    setLibrarySection,
    setLibraryMangaSnapshot,
    setLibraryTrackingSummarySnapshot,
    setLibraryUpdateInFlight,
    setLibraryUpdateProgress,
    bumpLibraryCoverCacheGeneration,
    recordComicsUpdateNotifications,
    recordNovelUpdateNotifications,
    recordLibraryUpdateIssues,
    addSystemNotification,
    refreshAppReadingStateFromPersistence,
    setRuntimeSettingsTab,
    setSettingsOpen,
  } from "./store/state.svelte";
  import { applyCustomTheme, clearCustomThemeProperties } from "./lib/theme/provider";
  import type { EpigraphRestorePlan, EpigraphRestorePlannerRuntime } from "./lib/backup/epigraphRestorePlanner";
  import type { BackupLaunchIntent } from "./lib/backup/backupRollout";
  import type { EpigraphNovelRuntimeState } from "./lib/backup/novelsBackup";
  import type { RestoreReadinessSummary } from "./lib/reconciliation/types";
  import { cache, CACHE_GROUPS, CACHE_KEYS, DEFAULT_TTL_MS } from "./lib/cache";
  import { normalizeCategories } from "./lib/library/categories";
  import type { PersistedLibrarySnapshot } from "./lib/library/snapshot";
  import { hasLibrarySnapshot } from "./lib/library/snapshotPresence";
  import { setLibraryMotionEnvironment } from "./lib/library/motionGate";
  import { getLibraryVisibilityRegistryStats } from "./lib/library/visibilityRegistry";
  import { isEditableKeyboardTarget } from "./lib/keybinds";
  import { observeMotionWake } from "./lib/motionWake";
  import { hasActiveReaderCommandScope } from "./lib/reader/commands";
  import {
    configureLocalServerRuntime,
    ensureServerAwakeFor,
    isLoopbackServerUrl,
    maybeStandbyLocalServer,
    notifyServerReady,
    prepareManagedServerStartup,
  } from "./lib/serverLifecycle";
  import type { SyncdReplicationSnapshot } from "./lib/syncdDesktop";
  import type { TrackerCompletionTracker } from "./lib/library/completion";
  import { getBooksUpdateExcludedBookIds } from "./lib/library/bookUpdateExclusions";
  import type { Category, Chapter, DownloadStatus, DownloadQueueItem, Manga, Tracker } from "./lib/types";
  import type { ActiveDownload } from "./store/state.svelte";
  import { traceMediaAudit } from "./lib/mediaAudit";
  import { getImageCacheStats, trimImageCacheIfLoaded } from "./lib/imageCacheMetrics";
  import type { EpigraphUpdateStatus } from "./lib/epigraphUpdater";
  import { _, applyAppLanguage, translate } from "./lib/i18n/runtime";
  import { operationFailure, presentOperationFailure, restorePlanSummary, type OperationFailure } from "./lib/i18n/operationPresentation";
  import { DEFAULT_BUILTIN_THEME_ID, normalizeThemeSelection } from "./lib/theme/contract";
  import SplashScreen from "./components/layout/SplashScreen.svelte";
  import { playShellEntrance, pointerEffects, SPLASH_EXIT_EVENT } from "./lib/motion/motion";
  import { NOVEL_RUNTIME_HOST_LABEL } from "./lib/novels/runtimeConstants";
  import { FIRST_RUN_COMPLETED_EVENT, writeCompletedFirstRunMarker } from "./lib/firstRun";

  type DiscordRuntime = typeof import("./lib/discord");
  let discordRuntimePromise: Promise<DiscordRuntime> | null = null;

  function loadDiscordRuntime() {
    discordRuntimePromise ??= import("./lib/discord");
    return discordRuntimePromise;
  }

  async function initRpc(...args: Parameters<DiscordRuntime["initRpc"]>) {
    return (await loadDiscordRuntime()).initRpc(...args);
  }

  async function setNavigationPresence(...args: Parameters<DiscordRuntime["setNavigationPresence"]>) {
    return (await loadDiscordRuntime()).setNavigationPresence(...args);
  }

  async function setDownloadPresence(...args: Parameters<DiscordRuntime["setDownloadPresence"]>) {
    return (await loadDiscordRuntime()).setDownloadPresence(...args);
  }

  async function destroyRpc() {
    if (!discordRuntimePromise) return;
    return (await discordRuntimePromise).destroyRpc();
  }

  $effect(() => {
    const themeId  = normalizeThemeSelection(store.settings.theme, store.settings.customThemes ?? []);
    const isCustom = themeId.startsWith("custom:");
    const root = document.documentElement;

    if (!isCustom) {
      clearCustomThemeProperties(root);
      root.setAttribute("data-theme", themeId);
      return;
    }

    const custom = store.settings.customThemes?.find(t => t.id === themeId);
    if (!custom || !applyCustomTheme(root, custom)) {
      clearCustomThemeProperties(root);
      root.setAttribute("data-theme", DEFAULT_BUILTIN_THEME_ID);
      return;
    }
  });

  let themeEditorOpen   = $state(false);
  let themeEditorEditId = $state<string | null>(null);
  const activeReaderChapter = $derived(store.activeChapter);
  const activeReaderChapterId = $derived(store.activeChapter?.id ?? null);
  const readerRenderKey = $derived(activeReaderChapterId === null ? null : `${activeReaderChapterId}:${store.readerSessionId}`);

  type LazyModule = { default: any };
  type LazyKey =
    | "novelRuntimeHost"
    | "layout"
    | "toaster"
    | "mangaReader"
    | "bookReader"
    | "novelReader"
    | "themeEditor"
    | "mangaPreview"
    | "searchPalette";

  const lazyLoaders: Record<LazyKey, () => Promise<LazyModule>> = {
    novelRuntimeHost: () => import("./components/novels/NovelRuntimeHost.svelte"),
    layout: () => import("./components/layout/Layout.svelte"),
    toaster: () => import("./components/layout/Toaster.svelte"),
    mangaReader: () => import("./components/reader/Reader.svelte"),
    bookReader: () => import("./components/reader/BookReader.svelte"),
    novelReader: () => import("./components/reader/NovelReader.svelte"),
    themeEditor: () => import("./components/settings/ThemeEditor.svelte"),
    mangaPreview: () => import("./components/shared/MangaPreview.svelte"),
    searchPalette: () => import("./components/search/SearchPalette.svelte"),
  };

  let NovelRuntimeHostComponent = $state<any>(null);
  let LayoutComponent = $state<any>(null);
  let ToasterComponent = $state<any>(null);
  let MangaReaderComponent = $state<any>(null);
  let BookReaderComponent = $state<any>(null);
  let NovelReaderComponent = $state<any>(null);
  let novelReaderInstance = $state<NovelReaderPreparation | null>(null);
  const prepareNovelReader = createNovelReaderPreparation(
    () => novelReaderInstance,
    () => store.activeNovelReader !== null,
  );
  onMount(() => registerNovelReaderPreparation(prepareNovelReader));
  let ThemeEditorComponent = $state<any>(null);
  let MangaPreviewComponent = $state<any>(null);
  let SearchPaletteComponent = $state<any>(null);
  let lazyRetryEpoch = $state(0);
  const lazyComponentPromises = new Map<LazyKey, Promise<any>>();
  const lazyComponentRetryTimers = new Map<LazyKey, ReturnType<typeof setTimeout>>();
  const lazyComponentRetryCounts = new Map<LazyKey, number>();

  function scheduleLazyComponentRetry(key: LazyKey) {
    if (lazyComponentRetryTimers.has(key)) return;
    const retryCount = (lazyComponentRetryCounts.get(key) ?? 0) + 1;
    if (retryCount > 4) return;
    lazyComponentRetryCounts.set(key, retryCount);
    const timer = setTimeout(() => {
      lazyComponentRetryTimers.delete(key);
      lazyRetryEpoch += 1;
    }, 1_500 * (2 ** (retryCount - 1)));
    lazyComponentRetryTimers.set(key, timer);
  }

  async function ensureLazyComponent(key: LazyKey) {
    let pending = lazyComponentPromises.get(key);
    if (!pending) {
      pending = lazyLoaders[key]()
        .then((module) => {
          lazyComponentRetryCounts.delete(key);
          return module.default;
        })
        .catch(async (firstError) => {
          console.warn(`Retrying lazy component "${key}" after load failure:`, firstError);
          await new Promise((resolve) => setTimeout(resolve, 300));
          return lazyLoaders[key]().then((module) => {
            lazyComponentRetryCounts.delete(key);
            return module.default;
          });
        })
        .catch((error) => {
          console.error(`Failed to load lazy component "${key}":`, error);
          lazyComponentPromises.delete(key);
          scheduleLazyComponentRetry(key);
          return null;
        });
      lazyComponentPromises.set(key, pending);
    }
    return pending;
  }

  function openThemeEditor(id?: string | null) {
    themeEditorEditId = id ?? null;
    themeEditorOpen   = true;
  }

  function closeThemeEditor() {
    themeEditorOpen   = false;
    themeEditorEditId = null;
  }

  const STARTUP_FAILSAFE_MS = 300_000;
  let win: TauriWindow | null = null;
  let isNovelRuntimeHostWindow = $state(false);
  let runtimeWindowClassified = $state(false);


  let serverProbeOk = $state(false);
  let shellReady    = $state(false);
  let startupSplashVisible = $state(true);
  let startupLandingApplied = $state(false);
  let failed        = $state(false);
  let notConfigured = $state(false);
  let startupFailureTitle = $state(translate("startup.couldNotStartProfile", { profile: localProfileDisplayName("MAIN", translate) }));
  let startupFailureDetail = $state<string | OperationFailure>(translate("startup.profileUnavailable", {
    profile: localProfileDisplayName("MAIN", translate),
    serverUrl: "http://127.0.0.1:4567",
  }));
  let startupStatusText = $state(translate("startup.initializingProfile", { profile: localProfileDisplayName("MAIN", translate) }));
  let startupHealthWatchInFlight = false;
  let startupFailsafeTimer: number | null = null;
  let idle          = $state(false);
  let uiMotionActive = $state(true);
  let prefersReducedMotion = $state(false);
  let devSplash     = $state(false);
  let bootReadyNotified = false;
  let lastSyncdRevalidatedProfileId = $state<string | null>(null);
  let syncdRevalidationInFlightProfileId = $state<string | null>(null);
  const lockEnabled = $derived(
    store.settings.appLockEnabled && (store.settings.appLockPin?.length ?? 0) >= 4,
  );
  const showIdleSplash = $derived(
    idle
      && lockEnabled
      && !store.activeChapter
      && !store.activeBookReaderId
      && !store.activeNovelReader
      && store.navPage !== "downloads",
  );

  let platformScale = $state(1.0);
  let _appliedZoom = -1;
  let _vhRafId: number | null = null;
  let uiMotionIdleTimer: number | null = null;
  const HUD_BASE_WIDTH = 1440;
  const HUD_BASE_HEIGHT = 900;
  const HUD_MIN_SCALE = 0.82;
  const HUD_MAX_SCALE = 1.08;

  function computeHudScale(uiZoom: number) {
    const visualWidth = window.innerWidth / uiZoom;
    const visualHeight = window.innerHeight / uiZoom;
    const scale = Math.min(visualWidth / HUD_BASE_WIDTH, visualHeight / HUD_BASE_HEIGHT);
    return Math.min(HUD_MAX_SCALE, Math.max(HUD_MIN_SCALE, scale));
  }

  function scheduleViewportMetrics(uiZoom = store.settings.uiZoom ?? 1.0) {
    if (_vhRafId !== null) cancelAnimationFrame(_vhRafId);
    _vhRafId = requestAnimationFrame(() => {
      _vhRafId = null;
      const visualWidth = window.innerWidth / uiZoom;
      const visualHeight = window.innerHeight / uiZoom;
      const hudScaleNumeric = computeHudScale(uiZoom);
      const shellVisualWidth = Math.max(320, visualWidth - (88 * hudScaleNumeric));
      const hudScale = hudScaleNumeric.toFixed(4);
      const contentScale = (1 + (hudScaleNumeric - 1) * 0.6).toFixed(4);
      const resolutionTier =
        shellVisualWidth <= 760 ? "compact" :
        shellVisualWidth <= 1220 ? "cozy" :
        "full";
      document.documentElement.style.setProperty("--visual-vh", `${visualHeight}px`);
      document.documentElement.style.setProperty("--visual-vw", `${visualWidth}px`);
      document.documentElement.style.setProperty("--app-shell-visual-width", `${shellVisualWidth}px`);
      document.documentElement.style.setProperty("--hud-scale", hudScale);
      document.documentElement.style.setProperty("--app-resolution-scale", contentScale);
      document.documentElement.setAttribute("data-app-resolution-tier", resolutionTier);
    });
  }

  function applyZoom() {
    const uiZoom = store.settings.uiZoom ?? 1.0;
    if (uiZoom === _appliedZoom) return;
    _appliedZoom = uiZoom;

    const pct = uiZoom * 100;
    document.documentElement.style.setProperty("--ui-zoom", String(uiZoom));
    document.documentElement.style.setProperty("--ui-scale", String(uiZoom));
    document.documentElement.style.zoom = `${pct}%`;
    scheduleViewportMetrics(uiZoom);
  }

  $effect(() => {
    applyAppLanguage(store.settings.appLanguage);
  });

  $effect(() => {
    const isReaderSurface = !!store.activeChapter || !!store.activeBookReaderId || !!store.activeNovelReader;
    document.body.dataset.appShellMode = isReaderSurface ? "reader" : "standard";
    return () => {
      delete document.body.dataset.appShellMode;
    };
  });

  $effect(() => {
    lazyRetryEpoch;
    if (isNovelRuntimeHostWindow && !NovelRuntimeHostComponent) {
      void ensureLazyComponent("novelRuntimeHost").then((component) => {
        if (component) NovelRuntimeHostComponent = component;
      });
    }
  });

  $effect(() => {
    lazyRetryEpoch;
    if (activeReaderChapter && !MangaReaderComponent) {
      void ensureLazyComponent("mangaReader").then((component) => {
        if (component) MangaReaderComponent = component;
      });
    }
  });

  $effect(() => {
    lazyRetryEpoch;
    if (runtimeWindowClassified && !isNovelRuntimeHostWindow && !LayoutComponent) {
      void ensureLazyComponent("layout").then((component) => {
        if (component) LayoutComponent = component;
      });
    }
  });

  $effect(() => {
    lazyRetryEpoch;
    if ((store.toasts.length || store.libraryUpdateProgress) && !ToasterComponent) {
      void ensureLazyComponent("toaster").then((component) => {
        if (component) ToasterComponent = component;
      });
    }
  });

  $effect(() => {
    lazyRetryEpoch;
    if (store.activeBookReaderId && !BookReaderComponent) {
      void ensureLazyComponent("bookReader").then((component) => {
        if (component) BookReaderComponent = component;
      });
    }
  });

  $effect(() => {
    lazyRetryEpoch;
    if (store.activeNovelReader && !NovelReaderComponent) {
      void ensureLazyComponent("novelReader").then((component) => {
        if (component) NovelReaderComponent = component;
      });
    }
  });

  $effect(() => {
    lazyRetryEpoch;
    if (themeEditorOpen && !ThemeEditorComponent) {
      void ensureLazyComponent("themeEditor").then((component) => {
        if (component) ThemeEditorComponent = component;
      });
    }
  });

  $effect(() => {
    lazyRetryEpoch;
    if (store.previewManga && !MangaPreviewComponent) {
      void ensureLazyComponent("mangaPreview").then((component) => {
        if (component) MangaPreviewComponent = component;
      });
    }
  });

  let prevQueue: DownloadQueueItem[] = [];
  let discordRpcStarted = false;
  let discordDownloadsActive = false;
  let lastDiscordPrivacySignature = "";
  let lastDiscordContextKey: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let libraryUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let lastInteractionAt = Date.now();
  let unlistenDownload: (() => void) | undefined;
  let unlistenSyncdReplicationState: (() => void) | undefined;
  let unlistenSyncdReplicationError: (() => void) | undefined;
  let syncdListenersAttached = false;
  let syncdListenersPromise: Promise<void> | null = null;
  const syncdAppliedMarks = new Map<string, number>();
  let pageHidden = $state(false);
  let appWindowFocused = true;
  let bootStartedAt = Date.now();
  let shellReadyAt = $state<number | null>(null);
  let lastDownloadEventAt = $state(Date.now());
  let lastRuntimeTrimAt = 0;
  let libraryBootstrapScopeKey: string | null = null;
  let libraryBootstrapInFlight: Promise<void> | null = null;
  let automaticLibraryUpdateInFlight: Promise<void> | null = null;
  let standbyInFlight = false;
  let staleLibraryUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let libraryUpdateRuntimePromise: Promise<typeof import("./lib/library/updateRuntime")> | null = null;

  function loadLibraryUpdateRuntime() {
    libraryUpdateRuntimePromise ??= import("./lib/library/updateRuntime");
    return libraryUpdateRuntimePromise;
  }

  async function clearStaleLibraryUpdateInFlight() {
    return (await loadLibraryUpdateRuntime()).clearStaleLibraryUpdateInFlight();
  }

  async function handleReplicationState(payload: SyncdReplicationSnapshot) {
    if (!payload.lastAppliedAtMs || payload.lastAppliedScopes.length === 0) return;
    if (syncdAppliedMarks.get(payload.localProfileId) === payload.lastAppliedAtMs) return;
    syncdAppliedMarks.set(payload.localProfileId, payload.lastAppliedAtMs);

    if (payload.lastAppliedScopes.includes("books:global")) {
      try {
        const { reloadBookLibraryState } = await import("./lib/books/libraryState");
        const next = await reloadBookLibraryState({ profileId: store.runtimeResolvedLocalProfileId });
        replaceBooksState({
          books: next.books,
          bookProgress: next.bookProgress,
          bookBookmarks: next.bookBookmarks,
          booksCategories: next.booksCategories,
          booksCategoryAssignments: next.booksCategoryAssignments,
          booksLibraryUi: next.booksLibraryUi,
        });
      } catch (error) {
        console.warn("Failed to refresh books after syncd replication apply:", error);
      }
    }

    if (payload.lastAppliedScopes.some((scope) => scope.startsWith("novels:profile:"))) {
      const currentProfileId =
        normalizeLocalProfileIdFromSession(store.runtimeResolvedLocalProfileId)
        ?? normalizeLocalProfileIdFromSession(store.settings.defaultLocalProfileId);
      if (currentProfileId && payload.localProfileId === currentProfileId) {
        try {
          const { reloadNovelLibraryState } = await import("./lib/novels/libraryState");
          await reloadNovelLibraryState({ profileId: currentProfileId });
          const { reloadNovelSourceClassificationState } = await import("./lib/novels/sourceClassificationState");
          await reloadNovelSourceClassificationState({ profileId: currentProfileId });
        } catch (error) {
          console.warn("Failed to refresh novels after syncd replication apply:", error);
        }
        store.bumpContentSetupVersion();
      }
    }
  }

  const AUTOMATIC_LIBRARY_UPDATE_SETTLE_MS = 3 * 60 * 1000;

  type RuntimeDiagnosticsSnapshot = {
    bootMs: number | null;
    shellReady: boolean;
    navPage: string;
    pageHidden: boolean;
    activeDownloads: number;
    lastDownloadEventAgeMs: number;
    cache: ReturnType<typeof cache.stats>;
    imageCache: ReturnType<typeof getImageCacheStats>;
    libraryVisibility: ReturnType<typeof getLibraryVisibilityRegistryStats>;
    serverStandbyEligibleReason: string;
  };

  type RuntimeDiagnosticsBridge = {
    getSnapshot: () => RuntimeDiagnosticsSnapshot;
    getBackendSnapshot: () => Promise<unknown>;
  };

  function getRuntimeDiagnosticsSnapshot(): RuntimeDiagnosticsSnapshot {
    return {
      bootMs: shellReadyAt === null ? null : Math.max(0, shellReadyAt - bootStartedAt),
      shellReady,
      navPage: store.navPage,
      pageHidden,
      activeDownloads: store.activeDownloads.length,
      lastDownloadEventAgeMs: Math.max(0, Date.now() - lastDownloadEventAt),
      cache: cache.stats(),
      imageCache: getImageCacheStats(),
      libraryVisibility: getLibraryVisibilityRegistryStats(),
      serverStandbyEligibleReason: serverStandbyEligibilityReason(),
    };
  }

  function attachKnownCategoryMembers(
    categories: Category[],
    mangas: Manga[],
    persistedSnapshot: PersistedLibrarySnapshot | null,
  ): Category[] {
    const mangaById = new Map(mangas.map((manga) => [manga.id, manga]));
    const currentById = new Map(store.categories.map((category) => [category.id, category]));

    return normalizeCategories(categories).map((category) => {
      const currentNodes = currentById.get(category.id)?.mangas?.nodes;
      const memberIds = currentNodes
        ? currentNodes.map((manga) => manga.id)
        : persistedSnapshot?.categoryMembers[String(category.id)];
      if (!memberIds) return category;

      return {
        ...category,
        mangas: {
          nodes: memberIds
            .map((id) => mangaById.get(id))
            .filter((manga): manga is Manga => Boolean(manga)),
        },
      };
    });
  }

  async function preloadLibrarySnapshot(force = false) {
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return null;

    const { loadLibrarySnapshot, saveLibrarySnapshot } = await import("./lib/library/snapshot");

    const scopeKey = `${store.runtimeResolvedLocalProfileId}::${store.runtimeServerUrl}`;
    const persistedSnapshot = loadLibrarySnapshot({
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    });
    if (
      persistedSnapshot
      && store.libraryMangaSnapshot.length === 0
      && store.categories.length === 0
    ) {
      setLibraryMangaSnapshot(persistedSnapshot.mangas.map((manga: any) => ({
        ...manga,
        chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? 0,
      })));
      setCategories(attachKnownCategoryMembers(
        persistedSnapshot.categories,
        persistedSnapshot.mangas,
        persistedSnapshot,
      ));
      // The persisted snapshot is only a warm start. Do not let setCategories()
      // pin its category list and bypass the live profile reconciliation below.
      cache.clear(CACHE_KEYS.CATEGORIES);
      setLibraryTrackingSummarySnapshot(persistedSnapshot.trackingSummary as TrackerCompletionTracker[]);
      setLibraryBootstrap("ready", scopeKey, persistedSnapshot.trackingSummary as TrackerCompletionTracker[]);
    }

    if (libraryBootstrapScopeKey === scopeKey && libraryBootstrapInFlight) {
      return libraryBootstrapInFlight;
    }
    if (
      !force
      && libraryBootstrapScopeKey === scopeKey
      && store.libraryBootstrapScopeKey === scopeKey
      && store.libraryBootstrapStatus === "ready"
      && store.libraryMangaSnapshot.length > 0
      && store.categories.length > 0
    ) {
      return null;
    }

    if (
      libraryBootstrapScopeKey === scopeKey
      && libraryBootstrapInFlight
    ) {
      return libraryBootstrapInFlight;
    }

    libraryBootstrapScopeKey = scopeKey;
    setLibraryBootstrap("loading", scopeKey);
    libraryBootstrapInFlight = (async () => {
      let [mangas, categories, trackingSummary] = await Promise.all([
        cache.get(
          CACHE_KEYS.LIBRARY,
          () => gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY).then((d) => d.mangas.nodes),
          DEFAULT_TTL_MS,
          CACHE_GROUPS.LIBRARY,
        ),
        cache.get(
          CACHE_KEYS.CATEGORIES,
          () => gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY).then((d) => normalizeCategories(d.categories.nodes)),
          DEFAULT_TTL_MS,
          CACHE_GROUPS.LIBRARY,
        ),
        cache.get(
          CACHE_KEYS.LIBRARY_TRACKING_SUMMARY,
          () => gql(GET_LIBRARY_TRACKING_SUMMARY).then((data: any) => data.trackers.nodes as TrackerCompletionTracker[]),
          DEFAULT_TTL_MS,
          CACHE_GROUPS.LIBRARY,
        ),
      ]);

      if (mangas.length === 0) {
        cache.clear(CACHE_KEYS.LIBRARY);
        const liveMangas = await gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY, undefined, undefined, 12000)
          .then((d) => d.mangas.nodes)
          .catch(() => mangas);
        if (liveMangas.length > 0) {
          mangas = liveMangas;
          cache.set(CACHE_KEYS.LIBRARY, liveMangas, CACHE_GROUPS.LIBRARY);
        }
      }

      const previousChapterCountById = new Map(store.libraryMangaSnapshot.map((manga) => [manga.id, manga.chapterCount]));
      const normalizedMangas = mangas.map((manga: any) => ({
        ...manga,
        chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? previousChapterCountById.get(manga.id) ?? 0,
      }));
      const normalizedCategories = attachKnownCategoryMembers(
        categories,
        normalizedMangas,
        persistedSnapshot,
      );
      setLibraryMangaSnapshot(normalizedMangas);
      setCategories(normalizedCategories);
      setLibraryTrackingSummarySnapshot(trackingSummary);
      setLibraryBootstrap("ready", scopeKey, trackingSummary);
      saveLibrarySnapshot(
        {
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        },
        {
          mangas: normalizedMangas,
          categories: normalizedCategories,
          trackingSummary,
        },
      );
    })()
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof Error && /abort/i.test(error.message)) return;
        console.error("Library preload failed:", error);
        setLibraryBootstrap("error", scopeKey);
      })
      .finally(() => {
        libraryBootstrapInFlight = null;
      });

    return libraryBootstrapInFlight;
  }

  function shouldKeepServerAwake() {
    return (
      store.navPage === "search"
      || store.navPage === "downloads"
      || Boolean(store.activeManga)
      || Boolean(store.activeChapter)
      || store.activeDownloads.length > 0
      || Boolean(store.activeSource)
    );
  }

  function serverStandbyEligibilityReason() {
    if (!store.settings.localServerStandbyEnabled) return "standby disabled";
    if (!idle) return "app is active";
    const standbyIdleMin = Math.max(1, Number(store.settings.localServerStandbyIdleMin ?? 10));
    if (Date.now() - lastInteractionAt < standbyIdleMin * 60 * 1000) return "waiting for idle timeout";
    if (msUntilNextLibraryUpdate() <= 5 * 60 * 1000) return "next library update is due soon";
    if (!store.runtimeServerUrl || !isLoopbackServerUrl(store.runtimeServerUrl)) return "server is external or missing";
    if (shouldKeepServerAwake()) return "server-backed surface is active";
    if (automaticLibraryUpdateInFlight || store.libraryUpdateInFlight) return "library update is running";
    return "eligible";
  }

  function nextLibraryUpdateDue(now = Date.now()) {
    if (!store.settings.autoLibraryUpdatesEnabled) return false;
    const intervalHours = Math.max(1, Number(store.settings.libraryUpdateIntervalHours ?? 12));
    const last = Number(store.settings.lastLibraryUpdateAt ?? 0);
    return !last || now - last >= intervalHours * 60 * 60 * 1000;
  }

  function msUntilNextLibraryUpdate(now = Date.now()) {
    if (!store.settings.autoLibraryUpdatesEnabled) return Number.POSITIVE_INFINITY;
    const intervalHours = Math.max(1, Number(store.settings.libraryUpdateIntervalHours ?? 12));
    const last = Number(store.settings.lastLibraryUpdateAt ?? 0);
    if (!last) return 0;
    return Math.max(0, (last + intervalHours * 60 * 60 * 1000) - now);
  }

  async function maybeStandbyAfterIdle(reason: string) {
    if (standbyInFlight) return;
    if (!idle) return;
    if (!store.settings.localServerStandbyEnabled) return;
    const standbyIdleMin = Math.max(1, Number(store.settings.localServerStandbyIdleMin ?? 10));
    if (Date.now() - lastInteractionAt < standbyIdleMin * 60 * 1000) return;
    if (msUntilNextLibraryUpdate() <= 5 * 60 * 1000) return;
    if (!store.runtimeServerUrl || !isLoopbackServerUrl(store.runtimeServerUrl)) return;
    if (shouldKeepServerAwake()) return;
    if (automaticLibraryUpdateInFlight || store.libraryUpdateInFlight) return;

    standbyInFlight = true;
    try {
      await maybeStandbyLocalServer({ serverUrl: store.runtimeServerUrl });
      console.info(`Suwayomi entered standby after ${reason}.`);
    } catch (error) {
      console.warn("Could not put Suwayomi in standby:", error);
    } finally {
      standbyInFlight = false;
    }
  }

  function canRunAutomaticLibraryUpdateNow(reason: "startup" | "focus" | "interval") {
    // Automatic updates should never compete with active navigation or Library menus.
    // Manual updates still use the user's selected intensity and can be started on demand.
    if (!pageHidden && !idle) return false;
    if (Date.now() - bootStartedAt < AUTOMATIC_LIBRARY_UPDATE_SETTLE_MS) {
      return false;
    }
    if (!pageHidden && Date.now() - lastInteractionAt < AUTOMATIC_LIBRARY_UPDATE_SETTLE_MS) {
      return false;
    }
    return true;
  }

  async function runAutomaticLibraryUpdate(reason: "startup" | "focus" | "interval") {
    if (automaticLibraryUpdateInFlight) return automaticLibraryUpdateInFlight;
    const updateRuntime = await loadLibraryUpdateRuntime();
    if (store.libraryUpdateInFlight) {
      await updateRuntime.clearStaleLibraryUpdateInFlight();
    }
    if (store.libraryUpdateInFlight) return null;
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return null;
    if (!nextLibraryUpdateDue()) return null;
    if (!canRunAutomaticLibraryUpdateNow(reason)) return null;
    if (shouldKeepServerAwake() && reason !== "startup") return null;

    setLibraryUpdateInFlight(true);
    automaticLibraryUpdateInFlight = (async () => {
      const beforeUpdate = [...store.libraryMangaSnapshot];
      const updateRun = await updateRuntime.runSharedLibraryUpdate({ reason: "auto-library-update" });
      const updatedAt = updateRun.updatedAt;
      updateSettings({ lastLibraryUpdateAt: updatedAt });
      cache.clearGroup(CACHE_GROUPS.LIBRARY);
      await preloadLibrarySnapshot(true);
      bumpLibraryCoverCacheGeneration();
      if (updateRun.cancelled) {
        updateRuntime.showLibraryUpdateProgress(translate("libraryUpdate.stoppedPlain"), 1800);
        return;
      }
      const comicsReconcile = await reconcileLibrarySnapshotChaptersAfterUpdate(
        beforeUpdate,
        updateRun.changedMangaIds,
        updatedAt,
        updateRun.preloadedChapters,
      );
      const entries = recordComicsUpdateNotifications(comicsReconcile.notifications, updatedAt);
      const {
        groupRefreshedNovelChaptersForNotifications,
        refreshNovelLibraryFromSources,
      } = await import("./lib/novels/libraryRefresh");
      const novelsResult = await refreshNovelLibraryFromSources({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }, {
        concurrency: 1,
        downloadNewChapters: store.settings.downloadNewNovelChapters,
        excludedNovelIds: Array.from(getBooksUpdateExcludedBookIds(
          store.settings.booksCategories,
          store.settings.booksCategoryAssignments,
        )),
        onlyOngoing: store.settings.onlyUpdateOngoingNovels,
        pauseMs: 800,
      });
      const novelNotifications = recordNovelUpdateNotifications(
        groupRefreshedNovelChaptersForNotifications(novelsResult.newChapterEntries),
        updatedAt,
      );
      const comicsReconcileIssues = comicsReconcile.failedIds.map((mangaId) => {
        const manga = store.libraryMangaSnapshot.find((entry) => entry.id === mangaId) ?? beforeUpdate.find((entry) => entry.id === mangaId);
        const sourceName = manga?.source?.displayName || manga?.source?.name || manga?.sourceId || translate("libraryUpdate.unknownSource");
        return {
          runId: `comics-reconcile:${updatedAt}`,
          contentKind: "manga" as const,
          title: manga?.title ?? `Manga ${mangaId}`,
          itemId: String(mangaId),
          sourceId: String(manga?.source?.id ?? manga?.sourceId ?? "unknown"),
          sourceName,
          extensionName: sourceName,
          message: translate("libraryUpdate.chapterListUnverified"),
          errorType: "unknown" as const,
        };
      });
      const novelIssues = novelsResult.failures.map((failure) => ({
        runId: `books-update:${updatedAt}`,
        contentKind: "novel" as const,
        title: failure.title,
        itemId: failure.novelId,
        sourceId: failure.sourceId,
        sourceName: failure.sourceName,
        extensionName: failure.sourceName,
        message: failure.error,
        errorType: failure.error.match(/timeout|timed out|abort/i) ? "timeout" as const
          : failure.error.match(/429|rate.?limit/i) ? "rate-limit" as const
            : failure.error.match(/missing source|source id/i) ? "missing-source" as const
              : "source-error" as const,
      }));
      const updateIssues = recordLibraryUpdateIssues([
        ...updateRun.issues,
        ...comicsReconcileIssues,
        ...novelIssues,
      ], updatedAt);
      const comicsIssueCount = updateRun.issues.length + comicsReconcileIssues.length;
      const totalNewChapters = entries.reduce((sum, entry) => sum + entry.chapterDelta, 0)
        + novelNotifications.reduce((sum, entry) => sum + entry.chapterDelta, 0);
      const totalUpdatedTitles = entries.length + novelNotifications.length;
      addSystemNotification({
        kind: updateIssues.length > 0 ? "info" : "success",
        title: updateIssues.length > 0 ? $_("feedback.librarySyncIssues") : totalUpdatedTitles > 0 ? $_("ui_newChaptersFound") : $_("feedback.librarySyncComplete"),
        body: updateIssues.length > 0
          ? $_("feedback.libraryIssuesBody", { issues: updateIssues.length, sources: new Set(updateIssues.map((issue) => issue.sourceId)).size })
          : totalUpdatedTitles > 0
            ? $_("feedback.newChaptersBody", { chapters: totalNewChapters, titles: totalUpdatedTitles })
            : $_("feedback.automaticUpdatesBody", { hours: store.settings.libraryUpdateIntervalHours ?? 12 }),
        createdAt: updatedAt,
      });
      if (totalUpdatedTitles > 0) {
        addToast({
          kind: "success",
          title: $_("ui_newChaptersFound"),
          body: $_("feedback.newChaptersBody", { chapters: totalNewChapters, titles: totalUpdatedTitles }),
        });
      } else if (updateIssues.length > 0) {
        addToast({
          kind: "info",
          title: $_("feedback.libraryUpdatedIssues"),
          body: $_("feedback.libraryUpdatedIssuesBody", { count: updateIssues.length }),
        });
      }
      updateRuntime.showLibraryUpdateProgress(
        updateRuntime.formatLibraryUpdateFinalSummary($_("feedback.comicsLibrary"), updateRun.jobsInfo, comicsIssueCount),
        1800,
        updateRuntime.libraryUpdateProgressNumbers(updateRun.jobsInfo),
      );
      await maybeStandbyAfterIdle("auto-library-update");
    })()
      .catch((error) => {
        console.warn("Automatic library update failed:", error);
        addSystemNotification({
          kind: "error",
          title: $_("feedback.automaticLibraryUpdateFailed"),
          body: error instanceof Error ? error.message : $_("feedback.libraryRefreshFailed"),
        });
        updateRuntime.showLibraryUpdateProgress($_("feedback.automaticLibraryUpdateFailed"), 2200);
      })
      .finally(() => {
        automaticLibraryUpdateInFlight = null;
        setLibraryUpdateInFlight(false);
      });

    return automaticLibraryUpdateInFlight;
  }

  $effect(() => {
    const hasVisibleLibraryUpdateProgress = store.libraryUpdateInFlight || store.libraryUpdateProgress?.active;
    if (!hasVisibleLibraryUpdateProgress) {
      if (staleLibraryUpdateCheckTimer) {
        clearTimeout(staleLibraryUpdateCheckTimer);
        staleLibraryUpdateCheckTimer = null;
      }
      return;
    }

    if (staleLibraryUpdateCheckTimer) clearTimeout(staleLibraryUpdateCheckTimer);
    staleLibraryUpdateCheckTimer = setTimeout(() => {
      staleLibraryUpdateCheckTimer = null;
      void clearStaleLibraryUpdateInFlight();
    }, 5_000);
  });

  async function reconcileLibrarySnapshotChaptersAfterUpdate(
    beforeUpdate: Manga[],
    candidateMangaIds: Iterable<number>,
    updatedAt: number,
    preloadedChapters?: Map<number, Chapter[]>,
  ) {
    const current = store.libraryMangaSnapshot;
    if (!current.length) return { changedIds: [] as number[], failedIds: [] as number[], notifications: [] };

    const { reconcileComicsChapterSnapshot } = await import("./lib/library/comicsChapterSnapshot");
    const result = await reconcileComicsChapterSnapshot({
      scope: {
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      },
      beforeMangas: beforeUpdate,
      afterMangas: current,
      candidateMangaIds,
      createdAt: updatedAt,
      concurrency: 3,
      preloadedChapters,
      fetchChapters: async (mangaId) => {
        const data = await gql<{ chapters: { nodes: Chapter[] } }>(
          GET_CHAPTERS,
          { mangaId },
          undefined,
          12000,
        );
        return data.chapters.nodes;
      },
    });

    if (result.changedIds.length > 0) {
      setLibraryMangaSnapshot(result.mangas);
      cache.set(CACHE_KEYS.LIBRARY, result.mangas, CACHE_GROUPS.LIBRARY);
      const { saveLibrarySnapshot } = await import("./lib/library/snapshot");
      saveLibrarySnapshot(
        {
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        },
        {
          mangas: result.mangas,
          categories: normalizeCategories(store.categories),
          trackingSummary: store.libraryTrackingSummarySnapshot,
        },
      );
    }

    if (result.failedIds.length > 0) {
      console.warn(`Could not reconcile chapter counts for ${result.failedIds.length} library titles.`);
    }

    return result;
  }

  function updateRuntimeDiagnosticsBridge() {
    (globalThis as typeof globalThis & { __EPIGRAPH_DIAGNOSTICS__?: RuntimeDiagnosticsBridge }).__EPIGRAPH_DIAGNOSTICS__ = {
      getSnapshot: getRuntimeDiagnosticsSnapshot,
      getBackendSnapshot: () => invoke("get_runtime_diagnostics"),
    };
  }

  type EpigraphAuditBridge = {
    showSplash: () => void;
    hideSplash: () => void;
    toggleSplash: () => void;
    bypassStartupSplash: () => void;
    bypassFirstRun: () => Promise<void>;
    openSettings: () => void;
    closeSettings: () => void;
    openLibrary: () => void;
    prepareLibrary: () => Promise<void>;
    openBooksLibrary: () => void;
    openFirstManga: () => void;
    openFirstReader: () => Promise<void>;
    openFirstBook: () => Promise<void>;
    openFirstBookReader: () => Promise<void>;
    openFirstPdfBook: () => Promise<void>;
    openFirstNovel: () => Promise<void>;
    getState: () => {
      navPage: string;
      librarySection: string;
      activeMangaId: number | null;
      activeChapterId: number | null;
      activeBookId: string | null;
      activeBookReaderId: string | null;
      settingsOpen: boolean;
      splashVisible: boolean;
      shellReady: boolean;
      profileId: string | null;
      serverUrl: string | null;
    };
    getSyncdPanelDiagnostics: () => {
      panelReady: string | null;
      hostStatus: string | null;
      hostStatusLive: string | null;
      hostStartStage: string | null;
      hostError: string | null;
      panelError: string | null;
      hostBundleLength: number;
      connectStatus: string | null;
      connectError: string | null;
      connectStateText: string | null;
      persistedCount: number;
    };
    readNovelLibraryPersistence: () => Promise<{
      storageRoot: string | null;
      rawState: string | null;
      state: unknown;
    }>;
    readBookLibraryPersistence: () => Promise<{
      storageRoot: string | null;
      rawState: string | null;
      state: unknown;
    }>;
    importBookFromPath: (sourcePath: string) => Promise<{
      id: string;
      title: string;
      subtype: string;
      categoryId: string;
    } | null>;
    setBookReadingState: (input: {
      bookId: string;
      progressPercent: number;
      bookmarkLabel: string;
    }) => Promise<{ bookId: string; progressCount: number; bookmarkCount: number }>;
    exportBooksBackupToPath: (path: string) => Promise<{
      path: string;
      sha256: string;
      bookCount: number;
      progressCount: number;
      bookmarkCount: number;
    }>;
    restoreBooksBackupFromPath: (path: string) => Promise<{
      bookCount: number;
      progressCount: number;
      bookmarkCount: number;
      issueCount: number;
    }>;
    mutateSyncdAuditBookFixture: (input?: {
      mode?: "progress" | "bookmark" | "clear_bookmarks";
      marker?: string | null;
      progressPercent?: number | null;
    }) => Promise<{
      bookId: string;
      progressPercent: number | null;
      bookmarkLabel: string | null;
      bookmarkCount: number;
    }>;
    mutateSyncdAuditNovelFixture: (input?: {
      mode?: "progress" | "bookmark" | "clear_bookmarks";
      marker?: string | null;
      progressPercent?: number | null;
    }) => Promise<{
      profileId: string | null;
      novelId: string;
      chapterId: string;
      progressPercent: number | null;
      bookmarkLabel: string | null;
      bookmarkCount: number;
    }>;
    enableMediaAudit: () => void;
    disableMediaAudit: () => void;
    showPerformanceToast: () => Promise<void>;
  };

  type EpigraphAuditWindow = globalThis.Window & {
    __epigraphShowSplash?: () => void;
    __epigraphAudit?: EpigraphAuditBridge;
    __epigraphMediaAudit?: boolean;
  };

  function showAuditSplash() {
    devSplash = true;
  }

  function hideAuditSplash() {
    devSplash = false;
  }

  function toggleAuditSplash() {
    devSplash = !devSplash;
  }

  function bypassAuditStartupSplash() {
    handleBypass();
  }

  async function bypassAuditFirstRun() {
    const enabled = await invoke<boolean>("is_webdriver_automation").catch(() => false);
    if (!enabled) throw new Error("WebDriver automation required.");
    writeCompletedFirstRunMarker(localStorage);
    window.dispatchEvent(new Event(FIRST_RUN_COMPLETED_EVENT));
  }

  function openAuditSettings(tab: "security" | "storage" | null | undefined = undefined) {
    if (tab !== undefined) {
      setRuntimeSettingsTab(tab);
    }
    setSettingsOpen(true);
  }

  function closeAuditSettings() {
    setSettingsOpen(false);
  }

  function openAuditLibrary() {
    store.setNavPage("library");
    closeAuditSettings();
    hideAuditSplash();
  }

  function openAuditBooksLibrary() {
    openAuditLibrary();
    setLibrarySection("books");
    updateSettings({
      booksLibraryUi: {
        ...store.settings.booksLibraryUi,
        activeCategoryId: null,
        typeFilter: "all",
        search: "",
      },
    });
  }

  function applyStartupLandingPage() {
    if (startupLandingApplied) return;
    startupLandingApplied = true;
    if (!store.settings.launchIntoLibrary) return;

    store.setNavPage("library");
    if (store.settings.defaultLibrarySection === "books") {
      setLibrarySection("books");
    } else if (store.settings.defaultLibrarySection === "comics") {
      setLibrarySection("comics");
    }
  }

  async function resolveAuditFirstManga(mangaId?: number | null): Promise<Manga | null> {
    if (mangaId && store.activeManga?.id === mangaId) return store.activeManga;
    if (!mangaId && store.activeManga) return store.activeManga;

    const snapshotMatch = mangaId
      ? store.libraryMangaSnapshot.find((manga) => manga.id === mangaId)
      : store.libraryMangaSnapshot[0];
    if (snapshotMatch) return snapshotMatch;

    const data = await gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY).catch(() => null);
    const mangas = data?.mangas.nodes ?? [];
    if (mangas.length) store.setLibraryMangaSnapshot(mangas);
    return mangaId
      ? mangas.find((manga) => manga.id === mangaId) ?? null
      : mangas[0] ?? null;
  }

  async function openAuditFirstManga() {
    const manga = await resolveAuditFirstManga();
    if (manga) store.setActiveManga(manga);
  }

  async function openAuditFirstReader(mangaId?: number | null, chapterId?: number | null) {
    const manga = await resolveAuditFirstManga(mangaId);
    if (!manga) {
      return;
    }

    const data = await gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: manga.id }).catch(() => null);
    const chapters = [...(data?.chapters.nodes ?? [])]
      .sort((left, right) => (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0));
    const chapter = (chapterId ? chapters.find((candidate) => candidate.id === chapterId) : null)
      ?? chapters.find((candidate) => candidate.isDownloaded)
      ?? chapters[0]
      ?? null;
    if (!chapter) {
      return;
    }

    store.openReader(chapter, chapters, manga);
  }

  async function resolveAuditFirstBook(bookId?: string | null) {
    openAuditBooksLibrary();
    const target = typeof bookId === "string" && bookId.trim()
      ? store.books.find((book) => book.id === bookId.trim()) ?? null
      : store.books[0] ?? null;
    return target;
  }

  async function openAuditFirstBook(bookId?: string | null) {
    const book = await resolveAuditFirstBook(bookId);
    if (!book) return;
    setActiveBookId(book.id);
  }

  async function openAuditFirstPdfBook() {
    const pdfBook = store.books.find((book) => book.subtype === "pdf") ?? null;
    await openAuditFirstBook(pdfBook?.id ?? null);
  }

  async function openAuditFirstBookReader(bookId?: string | null) {
    const book = await resolveAuditFirstBook(bookId);
    if (!book) return;
    setActiveBookId(book.id);
    openBookReader(book.id);
  }

  async function openAuditFirstNovel(novelId?: string | null) {
    openAuditBooksLibrary();
    updateSettings({
      booksLibraryUi: {
        ...store.settings.booksLibraryUi,
        activeCategoryId: null,
        typeFilter: "all",
        search: "",
      },
    });

    const { resolveAuditSyncScope } = await import("./lib/release/appAuditDataBridge");
    const scope = resolveAuditSyncScope();
    const { reloadNovelLibraryState, getNovelLibraryChapters, buildNovelDetailRecordFromLibrary } = await import("./lib/novels/libraryState");
    const state = await reloadNovelLibraryState(scope);
    const target = typeof novelId === "string" && novelId.trim()
      ? state.entries.find((entry) => entry.id === novelId.trim()) ?? null
      : state.entries[0] ?? null;
    if (!target) return;

    store.setActiveNovelDetail({
      novel: buildNovelDetailRecordFromLibrary(target, getNovelLibraryChapters(state, target.id)),
      inLibrary: true,
    });
  }

  function getAuditState() {
    return {
      navPage: store.navPage,
      librarySection: store.librarySection,
      activeMangaId: store.activeManga?.id ?? null,
      activeChapterId: store.activeChapter?.id ?? null,
      activeBookId: store.activeBookId,
      activeBookReaderId: store.activeBookReaderId,
      settingsOpen: store.settingsOpen,
      splashVisible: devSplash || startupSplashVisible,
      shellReady,
      profileId: normalizeLocalProfileIdFromSession(store.runtimeResolvedLocalProfileId),
      serverUrl: normalizeServerUrlFromSession(store.runtimeServerUrl),
    };
  }

  function getSyncdPanelDiagnostics() {
    const textByTestId = (testId: string): string | null => {
      const node = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      return node?.innerText?.trim() || node?.textContent?.trim() || null;
    };

    const valueLengthByTestId = (testId: string): number => {
      const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`);
      return typeof node?.value === "string" ? node.value.trim().length : 0;
    };

    return {
      panelReady: document.querySelector("[data-testid='syncd-panel-grid']")?.getAttribute("data-panel-ready") ?? null,
      hostStatus: textByTestId("syncd-host-status"),
      hostStatusLive: textByTestId("syncd-host-status-live"),
      hostStartStage: textByTestId("syncd-host-start-stage"),
      hostError: textByTestId("syncd-host-error"),
      panelError: textByTestId("syncd-panel-error"),
      hostBundleLength: valueLengthByTestId("syncd-bootstrap-bundle-host"),
      connectStatus: textByTestId("syncd-connect-status"),
      connectError: textByTestId("syncd-connect-error"),
      connectStateText: textByTestId("syncd-connect-state"),
      persistedCount: document.querySelectorAll("[data-testid='syncd-persisted-session-item']").length,
    };
  }

  function enableMediaAudit() {
    (window as EpigraphAuditWindow).__epigraphMediaAudit = true;
  }

  function disableMediaAudit() {
    (window as EpigraphAuditWindow).__epigraphMediaAudit = false;
  }

  async function showPerformanceToast() {
    const enabled = await invoke<boolean>("is_webdriver_automation").catch(() => false);
    if (!enabled) throw new Error("WebDriver automation required.");
    addToast({
      id: "release-performance-toast",
      kind: "info",
      title: $_("feedback.performanceCheck"),
      body: $_("feedback.performanceCheckBody"),
      duration: 6_000,
    });
  }

  type AuditDataBridge = ReturnType<(typeof import("./lib/release/appAuditDataBridge"))["createAuditDataBridge"]>;
  let auditDataBridgePromise: Promise<AuditDataBridge> | null = null;

  function loadAuditDataBridge() {
    auditDataBridgePromise ??= import("./lib/release/appAuditDataBridge")
      .then(({ createAuditDataBridge }) => createAuditDataBridge());
    return auditDataBridgePromise;
  }

  function installAuditBridge() {
    const auditWindow = window as EpigraphAuditWindow;
    auditWindow.__epigraphShowSplash = showAuditSplash;
    auditWindow.__epigraphAudit = {
      showSplash: showAuditSplash,
      hideSplash: hideAuditSplash,
      toggleSplash: toggleAuditSplash,
      bypassStartupSplash: bypassAuditStartupSplash,
      bypassFirstRun: bypassAuditFirstRun,
      openSettings: openAuditSettings,
      closeSettings: closeAuditSettings,
      openLibrary: openAuditLibrary,
      prepareLibrary: async () => {
        await preloadLibrarySnapshot(true);
      },
      openBooksLibrary: openAuditBooksLibrary,
      openFirstManga: openAuditFirstManga,
      openFirstReader: openAuditFirstReader,
      openFirstBook: openAuditFirstBook,
      openFirstBookReader: openAuditFirstBookReader,
      openFirstPdfBook: openAuditFirstPdfBook,
      openFirstNovel: openAuditFirstNovel,
      getState: getAuditState,
      getSyncdPanelDiagnostics,
      readNovelLibraryPersistence: () => loadAuditDataBridge().then((bridge) => bridge.readNovelLibraryPersistence()),
      readBookLibraryPersistence: () => loadAuditDataBridge().then((bridge) => bridge.readBookLibraryPersistence()),
      importBookFromPath: (sourcePath) => loadAuditDataBridge().then((bridge) => bridge.importBookFromPath(sourcePath)),
      setBookReadingState: (input) => loadAuditDataBridge().then((bridge) => bridge.setBookReadingState(input)),
      exportBooksBackupToPath: (path) => loadAuditDataBridge().then((bridge) => bridge.exportBooksBackupToPath(path)),
      restoreBooksBackupFromPath: (path) => loadAuditDataBridge().then((bridge) => bridge.restoreBooksBackupFromPath(path)),
      mutateSyncdAuditBookFixture: (input) => loadAuditDataBridge().then((bridge) => bridge.mutateSyncdAuditBookFixture(input)),
      mutateSyncdAuditNovelFixture: (input) => loadAuditDataBridge().then((bridge) => bridge.mutateSyncdAuditNovelFixture(input)),
      enableMediaAudit,
      disableMediaAudit,
      showPerformanceToast,
    };
  }

  function uninstallAuditBridge() {
    const auditWindow = window as EpigraphAuditWindow;
    delete auditWindow.__epigraphShowSplash;
    delete auditWindow.__epigraphAudit;
  }

  function handleAuditShortcut(event: KeyboardEvent) {
    if (!(event.ctrlKey && event.altKey && event.shiftKey)) return;

    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      event.stopPropagation();
      toggleAuditSplash();
      return;
    }

    if (key === "o") {
      event.preventDefault();
      event.stopPropagation();
      openAuditSettings();
      return;
    }

    if (key === "x") {
      event.preventDefault();
      event.stopPropagation();
      hideAuditSplash();
      closeAuditSettings();
      return;
    }

    if (key === "d") {
      event.preventDefault();
      event.stopPropagation();
      void openAuditFirstManga();
      return;
    }

    if (key === "r") {
      event.preventDefault();
      event.stopPropagation();
      void openAuditFirstReader();
      return;
    }

    if (key === "b") {
      event.preventDefault();
      event.stopPropagation();
      openAuditBooksLibrary();
      return;
    }

    if (key === "n") {
      event.preventDefault();
      event.stopPropagation();
      void openAuditFirstBook();
      return;
    }

    if (key === "p") {
      event.preventDefault();
      event.stopPropagation();
      void openAuditFirstPdfBook();
      return;
    }

    if (key === "k") {
      event.preventDefault();
      event.stopPropagation();
      void openAuditFirstBookReader();
      return;
    }

    if (key === "v") {
      event.preventDefault();
      event.stopPropagation();
      void openAuditFirstNovel();
      return;
    }

    if (key === "l") {
      event.preventDefault();
      event.stopPropagation();
      openAuditLibrary();
    }
  }

  function detectCompletions(prev: DownloadQueueItem[], next: DownloadQueueItem[]) {
    for (const item of prev) {
      if (item.state !== "DOWNLOADING") continue;
      if (!next.some(q => q.chapter.id === item.chapter.id)) {
        const manga = item.chapter.manga;
        addToast({ kind: "success", title: $_("feedback.chapterDownloaded"),
          body: manga ? `${manga.title} — ${item.chapter.name}` : item.chapter.name,
          duration: 4000 });
      }
    }
  }

  function mergePausedDownloads(next: ActiveDownload[]): ActiveDownload[] {
    const merged = new Map<number, ActiveDownload>();
    next.forEach((item) => merged.set(item.chapterId, item));
    store.pausedDownloads.forEach((item) => {
      if (!merged.has(item.chapterId)) {
        merged.set(item.chapterId, {
          chapterId: item.chapterId,
          mangaId: item.mangaId,
          progress: item.progress,
          state: "PAUSED",
        });
      }
    });
    return Array.from(merged.values());
  }

  function sameActiveDownloads(left: ActiveDownload[], right: ActiveDownload[]) {
    if (left.length !== right.length) return false;
    return left.every((entry, index) => {
      const other = right[index];
      return !!other
        && entry.chapterId === other.chapterId
        && entry.mangaId === other.mangaId
        && entry.progress === other.progress
        && entry.state === other.state;
    });
  }

  function commitActiveDownloads(next: ActiveDownload[]) {
    if (sameActiveDownloads(next, store.activeDownloads)) return;
    setActiveDownloads(next);
  }

  function applyQueue(next: DownloadQueueItem[]) {
      detectCompletions(prevQueue, next);
      prevQueue = next;
      commitActiveDownloads(mergePausedDownloads(next.map(item => ({
        chapterId: item.chapter.id, mangaId: item.chapter.mangaId, progress: item.progress, state: item.state,
      }))));
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    lastInteractionAt = Date.now();
    idle = false;
    if (store.navPage === "downloads") return;
    const ms = (store.settings.idleTimeoutMin ?? 5) * 60 * 1000;
    if (ms === 0) return;
    idleTimer = setTimeout(() => idle = true, ms);
  }

  const idleEvents = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"] as const;

  function trimRuntimeMemory(options: { minIntervalMs?: number } = {}) {
    const now = Date.now();
    const minIntervalMs = options.minIntervalMs ?? 15_000;
    if (now - lastRuntimeTrimAt < minIntervalMs) return;
    lastRuntimeTrimAt = now;

    cache.trimExpired(now);
    trimImageCacheIfLoaded(false);

  }

  function scheduleUiMotionPause() {
    if (uiMotionIdleTimer) {
      clearTimeout(uiMotionIdleTimer);
      uiMotionIdleTimer = null;
    }

    uiMotionActive = true;
    if (pageHidden) return;

    uiMotionIdleTimer = window.setTimeout(() => {
      if (!pageHidden) {
        uiMotionActive = false;
        trimRuntimeMemory();
      }
    }, 5_000);
  }

  $effect(() => {
    if (!shellReady) return;
    if (store.navPage === "downloads") {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      idle = false;
      scheduleUiMotionPause();
      return;
    }
    const handleFocus = () => {
      scheduleUiMotionPause();
    };
    idleEvents.forEach(e => window.addEventListener(e, resetIdle, { passive: true }));
    idleEvents.forEach(e => window.addEventListener(e, scheduleUiMotionPause, { passive: true }));
    window.addEventListener("focus", handleFocus, { passive: true });
    resetIdle();
    scheduleUiMotionPause();
    return () => {
      idleEvents.forEach(e => window.removeEventListener(e, resetIdle));
      idleEvents.forEach(e => window.removeEventListener(e, scheduleUiMotionPause));
      window.removeEventListener("focus", handleFocus);
      if (uiMotionIdleTimer) {
        clearTimeout(uiMotionIdleTimer);
        uiMotionIdleTimer = null;
      }
    };
  });

  $effect(() => {
    void store.settings.uiZoom;
    applyZoom();
  });

  $effect(() => {
    if (!shellReady) return;
    const poll = () => gql<{ downloadStatus: DownloadStatus }>(GET_DOWNLOAD_STATUS)
      .then(d => applyQueue(d.downloadStatus.queue)).catch(console.error);
    const activeDownloadCount = store.activeDownloads.length;
    const intervalMs =
      store.navPage === "downloads" ? 2000 :
      pageHidden ? 30000 :
      activeDownloadCount > 0 ? 12000 :
      0;
    if (intervalMs <= 0) return;
    poll();
    pollInterval = setInterval(() => {
      const shouldPollAggressively = store.navPage === "downloads";
      const eventAgeMs = Date.now() - lastDownloadEventAt;
      if (!shouldPollAggressively && eventAgeMs < 5000 && store.activeDownloads.length > 0) {
        return;
      }
      void poll();
    }, intervalMs);
    return () => {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = null;
    };
  });

  async function checkForUpdateSilently() {
    try {
      const status = await invoke<EpigraphUpdateStatus>("check_epigraph_update");
      if (status.update_available && status.version) {
        addToast({
          kind: "info",
          title: $_("feedback.updateAvailableVersion", { version: status.version }),
          body: $_("feedback.openAboutToInstall"),
          duration: 8000,
        });
      }
    } catch {}
  }

  let cancelProbe = false;
  let startupProbeRun = 0;
  let pendingAuditOpen: LaunchTargetProfileOverrides["auditOpenOverride"] = null;
  let pendingAuditMangaId: number | null = null;
  let pendingAuditChapterId: number | null = null;
  let pendingAuditBookId: string | null = null;
  let pendingAuditMangaBackupPath: string | null = null;
  let pendingAuditBooksBackupPath: string | null = null;
  let pendingAuditNovelsBackupPath: string | null = null;
  let pendingAuditEpigraphBackupPath: string | null = null;
  let pendingRestoreMangaBackupPath: string | null = null;
  let pendingRestoreEpigraphBackupPath: string | null = null;
  let pendingRestoreHandoff = false;
  let pendingRestoreSourceProfileId: LocalProfileId | null = null;
  let backupAuditPlan = $state<EpigraphRestorePlan | null>(null);
  let backupRestoreLaunchIntent = $state<BackupLaunchIntent | null>(null);
  let runtimeAttachOnly = $state(false);

  interface LaunchTargetInfo extends LaunchTargetProfileOverrides {
    serverAuthEnabledOverride?: boolean | null;
    serverAuthUserOverride?: string | null;
    serverAuthPassOverride?: string | null;
    auditMangaBackupOverride?: string | null;
    auditBooksBackupOverride?: string | null;
    auditNovelsBackupOverride?: string | null;
    auditEpigraphBackupOverride?: string | null;
    restoreMangaBackupOverride?: string | null;
    restoreEpigraphBackupOverride?: string | null;
    restoreHandoffOverride?: boolean | null;
    restoreSourceProfileOverride?: string | null;
  }

  function activeProfileLabel(): string {
    return localProfileDisplayName(
      store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
      translate,
    );
  }

  function startupUnavailableDetail() {
    return translate("startup.profileUnavailable", {
      profile: activeProfileLabel(),
      serverUrl: store.runtimeServerUrl ?? getServerTargetInfo().url,
    });
  }

  function setStartupStatusCopy() {
    const prefix = activeProfileLabel();
    startupStatusText = runtimeAttachOnly
      ? translate("startup.attachingProfile", { profile: prefix })
      : translate("startup.initializingProfile", { profile: prefix });
    startupFailureTitle = translate("startup.couldNotStartProfile", { profile: prefix });
    startupFailureDetail = startupUnavailableDetail();
  }

  function applyLaunchTarget(launchTarget: LaunchTargetInfo | null) {
    pendingAuditOpen = launchTarget?.auditOpenOverride ?? null;
    pendingAuditMangaId = launchTarget?.auditMangaIdOverride ?? null;
    pendingAuditChapterId = launchTarget?.auditChapterIdOverride ?? null;
    pendingAuditBookId = launchTarget?.auditBookIdOverride ?? null;
    pendingAuditMangaBackupPath = launchTarget?.auditMangaBackupOverride ?? null;
    pendingAuditBooksBackupPath = launchTarget?.auditBooksBackupOverride ?? null;
    pendingAuditNovelsBackupPath = launchTarget?.auditNovelsBackupOverride ?? null;
    pendingAuditEpigraphBackupPath = launchTarget?.auditEpigraphBackupOverride ?? null;
    pendingRestoreMangaBackupPath = launchTarget?.restoreMangaBackupOverride ?? null;
    pendingRestoreEpigraphBackupPath = launchTarget?.restoreEpigraphBackupOverride ?? null;
    pendingRestoreHandoff = Boolean(launchTarget?.restoreHandoffOverride);
    pendingRestoreSourceProfileId = normalizeLocalProfileIdFromSession(launchTarget?.restoreSourceProfileOverride);
    runtimeAttachOnly = Boolean(launchTarget?.attachOnlyOverride);
    (window as EpigraphAuditWindow).__epigraphMediaAudit = Boolean(launchTarget?.auditOpenOverride);

    const resolved = resolveSessionProfileFromLocalProfiles(
      launchTarget,
      store.settings.defaultLocalProfileId,
      store.settings.serverUrl,
      store.settings.customLocalProfiles,
    );

    store.runtimeResolvedLocalProfileId = resolved.profileId;
    store.runtimeResolvedLocalProfileMeta = resolved.profileMeta;
    store.runtimeProfileResolutionSource = resolved.resolutionSource;
    store.runtimeLaunchProfileOverride = resolved.launchProfileOverride;
    store.runtimeIsOverrideSession = resolved.isOverrideSession;
    store.runtimeServerUrl = resolved.effectiveServerUrl;
    store.runtimeServerLabel = resolved.displayLabel;

    if (!resolved.isOverrideSession && normalizeLocalProfileIdFromSession(store.settings.defaultLocalProfileId) == null) {
      updateSettings({ defaultLocalProfileId: DEFAULT_LOCAL_PROFILE_ID });
    }

    if (typeof launchTarget?.serverAuthEnabledOverride === "boolean") {
      updateSettings({
        serverAuthEnabled: launchTarget.serverAuthEnabledOverride,
        serverAuthUser: launchTarget.serverAuthUserOverride ?? store.settings.serverAuthUser,
        serverAuthPass: launchTarget.serverAuthPassOverride ?? store.settings.serverAuthPass,
      });
    }

    setStartupStatusCopy();
  }

  function getProbeBases(): string[] {
    const primary = normalizeServerUrlFromSession(
      store.runtimeServerUrl
      ?? store.runtimeResolvedLocalProfileMeta?.serverUrl
      ?? store.settings.serverUrl
    );
    return primary ? [primary] : [];
  }

  async function readFileAsArrayBuffer(path: string): Promise<ArrayBuffer> {
    const storage = await import("./lib/books/storage");
    return storage.readFileAsArrayBuffer(path);
  }

  async function applyPendingAuditBooksRestore() {
    const path = pendingAuditBooksBackupPath?.trim();
    if (!path) return;
    pendingAuditBooksBackupPath = null;

    traceMediaAudit({
      event: "books.restore.audit.started",
      path,
    });

    try {
      const { restoreEpigraphBooksPayload } = await import("./lib/backup/booksBackup");
      const bytes = await readFileAsArrayBuffer(path);
      const restored = await restoreEpigraphBooksPayload(bytes);
      replaceBooksState({
        books: restored.books,
        bookProgress: restored.bookProgress,
        bookBookmarks: restored.bookBookmarks,
        booksCategories: restored.booksCategories,
        booksCategoryAssignments: restored.booksCategoryAssignments,
      });

      traceMediaAudit({
        event: "books.restore.audit.applied",
        path,
        exportMode: restored.exportMode,
        bookCount: restored.books.length,
        progressCount: restored.bookProgress.length,
        bookmarkCount: restored.bookBookmarks.length,
        issueCount: restored.issues.length,
        issues: restored.issues.map((issue) => ({
          code: issue.code,
          bookId: issue.bookId ?? null,
          path: issue.path ?? null,
        })),
        bookPaths: restored.books.map((book) => ({
          id: book.id,
          subtype: book.subtype,
          assetPath: book.assetPath,
          importPath: book.importPath,
          coverPath: book.coverPath ?? null,
        })),
      });

      addToast({
        kind: restored.issues.length ? "info" : "success",
        title: restored.issues.length ? $_("feedback.booksRestoreLoadedWithWarnings") : $_("feedback.booksRestoreLoaded"),
        body: $_("feedback.booksRestoredCount", { count: restored.books.length }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Books restore audit failed.";
      traceMediaAudit({
        event: "books.restore.audit.failed",
        path,
        message,
      });
      addToast({
        kind: "error",
        title: $_("feedback.booksRestoreAuditFailed"),
        body: message,
      });
      throw error;
    }
  }

  type BackupRestoreProgress = {
    mangaProgress: number;
    state: string;
    totalManga: number;
  };

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollAuditRestoreStatus(id: string): Promise<BackupRestoreProgress | null> {
    while (true) {
      const res = await gql<{ restoreStatus: BackupRestoreProgress | null }>(GET_RESTORE_STATUS, { id });
      const status = res.restoreStatus;
      const state = (status?.state ?? "").toUpperCase();
      if (!status || ["SUCCESS", "COMPLETED", "FAILED", "ERROR", "CANCELLED"].includes(state)) {
        return status ?? null;
      }
      await sleep(1200);
    }
  }

  async function installAuditRestoreExtensions(pkgNames: string[]) {
    for (const pkgName of pkgNames) {
      traceMediaAudit({
        event: "manga.restore.audit.extension.installing",
        pkgName,
      });
      await gql(UPDATE_EXTENSION, { id: pkgName, install: true });
    }
  }

  function mangaRestoreBlockedMessage(readiness: RestoreReadinessSummary): string {
    if (readiness.requiresInstallCount > 0) {
      return "Required manga source extensions are not usable on this server yet.";
    }
    if (readiness.unavailableCount > 0) {
      return "Some manga sources in the backup are unavailable on this server.";
    }
    return "Unified manga backup still needs manual source reconciliation before restore.";
  }

  function describeAuditError(error: unknown): string {
    if (error instanceof Error) {
      return error.message || error.name || "Manga restore audit failed.";
    }
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {}
    return String(error || "Manga restore audit failed.");
  }

  async function loadNovelAuditRuntimeState(): Promise<EpigraphNovelRuntimeState> {
    const { loadNovelRepositoryState } = await import("./lib/novels/repositoryState");
    const state = await loadNovelRepositoryState({
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeResolvedLocalProfileMeta?.serverUrl ?? store.runtimeServerUrl,
    });

    return {
      repositoryUrls: state.repositories.map((repository) => repository.normalizedUrl),
      installedPluginIds: state.installedPlugins
        .filter((plugin) => plugin.enabled)
        .map((plugin) => plugin.pluginId),
      availableSourceIds: [...new Set(state.catalogEntries.map((entry) => entry.pluginId))],
    };
  }

  async function loadRestorePlannerRuntime(): Promise<EpigraphRestorePlannerRuntime> {
    const [{ loadSourceInventory }, { readOverlayFile }] = await Promise.all([
      import("./lib/reconciliation/sourceInventory"),
      import("./lib/reconciliation/overlay"),
    ]);
    const [inventory, trackersData, novelsRuntime, overlay] = await Promise.all([
      loadSourceInventory(),
      gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS),
      loadNovelAuditRuntimeState(),
      readOverlayFile(),
    ]);

    return {
      manga: {
        supported: true,
        inventory: inventory.inventory,
        availableExtensions: inventory.availableExtensions,
        trackers: trackersData.trackers.nodes ?? [],
        overlay,
      },
      activeProfileId: store.runtimeResolvedLocalProfileId,
      books: {
        supported: true,
      },
      novels: {
        ...novelsRuntime,
        supported: true,
      },
      app: {
        supported: true,
      },
    };
  }

  function novelsAuditSummaryBody(summary: {
    totalEntries: number;
    restoredUsableCount: number;
    restoredNeedsRepositoryCount: number;
    restoredNeedsPluginCount: number;
    restoredMetadataOnlyCount: number;
  }): string {
    return $_("feedback.novelsRestoreSummary", {
      total: summary.totalEntries,
      usable: summary.restoredUsableCount,
      repository: summary.restoredNeedsRepositoryCount,
      plugin: summary.restoredNeedsPluginCount,
      metadata: summary.restoredMetadataOnlyCount,
    });
  }

  async function applyPendingAuditEpigraphBackupPlan() {
    const path = pendingAuditEpigraphBackupPath?.trim();
    if (!path) return;
    pendingAuditEpigraphBackupPath = null;

    traceMediaAudit({
      event: "backup.plan.audit.started",
      path,
    });

    try {
      const { buildEpigraphRestorePlan } = await import("./lib/backup/epigraphRestorePlanner");
      const rawBytes = await readFileAsArrayBuffer(path);
      const runtime = await loadRestorePlannerRuntime();
      const plan = await buildEpigraphRestorePlan(rawBytes, runtime);
      backupAuditPlan = plan;
      setRuntimeSettingsTab("storage");

      traceMediaAudit({
        event: "backup.plan.audit.summarized",
        path,
        defaultTarget: plan.defaultTarget,
        canProceedWithRecommendedSelection: plan.canProceedWithRecommendedSelection,
        hasBlockedPayloads: plan.hasBlockedPayloads,
        hasUnsupportedPayloads: plan.hasUnsupportedPayloads,
        recommendedSelection: plan.recommendedSelection,
        summary: plan.summary,
        payloads: plan.payloads.map((payload) => ({
          kind: payload.kind,
          status: payload.status,
          canRestoreNow: payload.canRestoreNow,
          needsUserAction: payload.needsUserAction,
          selectedByDefault: payload.selectedByDefault,
          summaryLabel: payload.summaryLabel,
          reasons: payload.reasons,
          warnings: payload.warnings,
        })),
        topLevelSkipped: plan.topLevelSkipped,
      });

      addToast({
        kind: plan.hasBlockedPayloads || plan.hasUnsupportedPayloads
          ? "error"
          : plan.recommendedSelection.length > 0
            ? "success"
            : "info",
        title: $_("feedback.unifiedRestorePlanLoaded"),
        body: restorePlanSummary(plan.summary, $_),
        duration: 20000,
      });
    } catch (error) {
      backupAuditPlan = null;
      const message = describeAuditError(error);
      traceMediaAudit({
        event: "backup.plan.audit.failed",
        path,
        message,
        detail: String(error),
      });
      addToast({
        kind: "error",
        title: $_("feedback.unifiedBackupPlanningFailed"),
        body: message,
        duration: 15000,
      });
      throw error;
    }
  }

  function applyPendingRestoreLaunchIntent() {
    const epigraphPath = pendingRestoreEpigraphBackupPath?.trim();
    const mangaPath = pendingRestoreMangaBackupPath?.trim();
    if (!epigraphPath && !mangaPath) return;

    backupRestoreLaunchIntent = {
      kind: epigraphPath ? "epigraph" : "manga",
      path: epigraphPath ?? mangaPath!,
      handoff: pendingRestoreHandoff,
      sourceProfileId: pendingRestoreSourceProfileId,
    };

    pendingRestoreEpigraphBackupPath = null;
    pendingRestoreMangaBackupPath = null;
    pendingRestoreHandoff = false;
    pendingRestoreSourceProfileId = null;
    setRuntimeSettingsTab("storage");
    setSettingsOpen(true);
  }

  $effect(() => {
    if (!backupRestoreLaunchIntent) return;
    setRuntimeSettingsTab("storage");
    if (!store.settingsOpen) {
      setSettingsOpen(true);
    }
  });

  async function applyPendingAuditNovelsRestore() {
    const path = pendingAuditNovelsBackupPath?.trim();
    if (!path) return;
    pendingAuditNovelsBackupPath = null;

    traceMediaAudit({
      event: "novels.restore.audit.started",
      path,
    });

    try {
      const [{ restoreEpigraphNovelsPayload }, { isLnReaderBackupZip, restoreLnReaderNovelsBackup }] = await Promise.all([
        import("./lib/backup/novelsBackup"),
        import("./lib/backup/lnreaderBackup"),
      ]);
      const rawBytes = await readFileAsArrayBuffer(path);
      const runtime = await loadNovelAuditRuntimeState();
      const restored = await isLnReaderBackupZip(rawBytes)
        ? await restoreLnReaderNovelsBackup(rawBytes, runtime)
        : await restoreEpigraphNovelsPayload(rawBytes, runtime);

      traceMediaAudit({
        event: "novels.restore.audit.classified",
        path,
        exportMode: restored.exportMode,
        runtime: {
          repositoryCount: runtime.repositoryUrls.length,
          installedPluginCount: runtime.installedPluginIds.length,
          availableSourceCount: runtime.availableSourceIds.length,
        },
        summary: restored.summary,
        classifications: restored.classifications.map((item) => ({
          novelId: item.novelId,
          title: item.title,
          outcome: item.outcome,
          requiredRepositoryUrl: item.requiredRepositoryUrl,
          requiredPluginId: item.requiredPluginId,
          requiredSourceId: item.requiredSourceId,
        })),
        issues: restored.issues,
      });

      const hasBlocked = restored.summary.restoredNeedsRepositoryCount > 0 || restored.summary.restoredNeedsPluginCount > 0;
      const toastKind = hasBlocked
        ? "error"
        : restored.summary.restoredMetadataOnlyCount > 0
          ? "info"
          : "success";

      addToast({
        kind: toastKind,
        title: hasBlocked ? $_("feedback.novelsRestoreClassifiedWithRequirements") : $_("feedback.novelsRestoreClassified"),
        body: novelsAuditSummaryBody(restored.summary),
        duration: 20000,
      });
    } catch (error) {
      const message = describeAuditError(error);
      traceMediaAudit({
        event: "novels.restore.audit.failed",
        path,
        message,
        detail: String(error),
      });
      addToast({
        kind: "error",
        title: $_("feedback.novelsRestoreAuditFailed"),
        body: message,
        duration: 15000,
      });
      throw error;
    }
  }

  async function applyPendingAuditMangaRestore() {
    const path = pendingAuditMangaBackupPath?.trim();
    if (!path) return;
    pendingAuditMangaBackupPath = null;

    traceMediaAudit({
      event: "manga.restore.audit.started",
      path,
    });

    try {
      const [
        { analyzeBackupReconciliation, overlayEntryFromAnalysis },
        { readOverlayFile, upsertOverlayEntry },
        { buildRestoreReadiness },
        { buildReconciledBackupFile },
        { loadSourceInventory },
      ] = await Promise.all([
        import("./lib/reconciliation/analyze"),
        import("./lib/reconciliation/overlay"),
        import("./lib/reconciliation/readiness"),
        import("./lib/reconciliation/restore"),
        import("./lib/reconciliation/sourceInventory"),
      ]);
      const rawBytes = await readFileAsArrayBuffer(path);
      const backupName = path.split(/[\\/]/).pop()?.trim() || "manga-backup.tachibk";
      const extractedBackup = new File([rawBytes], backupName, { type: "application/octet-stream" });
      const trackersData = await gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS);

      let inventory = await loadSourceInventory();
      let overlay = await readOverlayFile();
      let restoreBytes = await extractedBackup.arrayBuffer();
      let parsed = await analyzeBackupReconciliation(
        restoreBytes,
        inventory.inventory,
        trackersData.trackers.nodes ?? [],
        overlay,
      );

      await upsertOverlayEntry(overlayEntryFromAnalysis(parsed.analysis));
      let readiness = buildRestoreReadiness(parsed.analysis, {}, inventory.inventory, inventory.availableExtensions);

      traceMediaAudit({
        event: "manga.restore.audit.analysis",
        path,
        exactMatches: parsed.analysis.exactMatches.length,
        autoReconciled: parsed.analysis.autoReconciled.length,
        needsReview: parsed.analysis.needsReview.length,
        unresolved: parsed.analysis.unresolved.length,
        warnings: parsed.analysis.warnings.length,
        readiness: {
          readyNowCount: readiness.readyNowCount,
          requiresInstallCount: readiness.requiresInstallCount,
          unavailableCount: readiness.unavailableCount,
          unresolvedCount: readiness.unresolvedCount,
          blocksRestore: readiness.blocksRestore,
        },
      });

      if (readiness.installableExtensions.length > 0) {
        await installAuditRestoreExtensions(readiness.installableExtensions.map((extension) => extension.pkgName));

        for (let attempt = 0; attempt < 10; attempt += 1) {
          await sleep(1500);
          inventory = await loadSourceInventory();
          overlay = await readOverlayFile();
          restoreBytes = await extractedBackup.arrayBuffer();
          parsed = await analyzeBackupReconciliation(
            restoreBytes,
            inventory.inventory,
            trackersData.trackers.nodes ?? [],
            overlay,
          );
          await upsertOverlayEntry(overlayEntryFromAnalysis(parsed.analysis));
          readiness = buildRestoreReadiness(parsed.analysis, {}, inventory.inventory, inventory.availableExtensions);
          traceMediaAudit({
            event: "manga.restore.audit.analysis.refresh",
            path,
            attempt: attempt + 1,
            exactMatches: parsed.analysis.exactMatches.length,
            autoReconciled: parsed.analysis.autoReconciled.length,
            needsReview: parsed.analysis.needsReview.length,
            unresolved: parsed.analysis.unresolved.length,
            warnings: parsed.analysis.warnings.length,
            readiness: {
              readyNowCount: readiness.readyNowCount,
              requiresInstallCount: readiness.requiresInstallCount,
              unavailableCount: readiness.unavailableCount,
              unresolvedCount: readiness.unresolvedCount,
              blocksRestore: readiness.blocksRestore,
            },
          });
          if (readiness.requiresInstallCount === 0) {
            break;
          }
        }
      }

      if (readiness.blocksRestore) {
        throw new Error(mangaRestoreBlockedMessage(readiness));
      }

      const reconciledFile = buildReconciledBackupFile(
        parsed.parsedBackup,
        parsed.analysis,
        {},
        extractedBackup.name,
      );
      const { gqlUpload } = await import("./lib/client");
      const restoreResponse = await gqlUpload<{
        restoreBackup: { id: string; status: BackupRestoreProgress | null };
      }>(
        RESTORE_BACKUP,
        { backup: null },
        { "variables.backup": reconciledFile },
      );
      const finalStatus = await pollAuditRestoreStatus(restoreResponse.restoreBackup.id);
      const finalState = (finalStatus?.state ?? "").toUpperCase();

      if (!["SUCCESS", "COMPLETED"].includes(finalState)) {
        throw new Error(`Manga restore finished with state: ${finalStatus?.state ?? "unknown"}`);
      }

      traceMediaAudit({
        event: "manga.restore.audit.applied",
        path,
        extractedFilename: extractedBackup.name,
        mangaCount: parsed.parsedBackup.backupManga.length,
        sourceCount: parsed.parsedBackup.backupSources.length,
        trackerCount: parsed.parsedBackup.trackerIds.length,
        restoreId: restoreResponse.restoreBackup.id,
        restoreState: finalStatus?.state ?? null,
        totalManga: finalStatus?.totalManga ?? null,
        mangaProgress: finalStatus?.mangaProgress ?? null,
        readiness: {
          readyNowCount: readiness.readyNowCount,
          requiresInstallCount: readiness.requiresInstallCount,
          unavailableCount: readiness.unavailableCount,
          unresolvedCount: readiness.unresolvedCount,
        },
      });

      addToast({
        kind: "success",
        title: $_("feedback.mangaRestoreLoaded"),
        body: $_("feedback.mangaRestoredCount", { count: finalStatus?.totalManga ?? parsed.parsedBackup.backupManga.length }),
      });
    } catch (error) {
      const message = describeAuditError(error);
      traceMediaAudit({
        event: "manga.restore.audit.failed",
        path,
        message,
        detail: String(error),
      });
      addToast({
        kind: "error",
        title: $_("feedback.mangaRestoreAuditFailed"),
        body: message,
      });
      throw error;
    }
  }

  async function finishStartupAfterProbe() {
    clearStartupFailsafe();
    failed = false;
    serverProbeOk = true;
    shellReady = true;
    shellReadyAt = Date.now();
    releaseStartupSplash();
    notifyServerReady(store.runtimeServerUrl);
    applyStartupLandingPage();
    await applyPendingAuditEpigraphBackupPlan().catch((error) => {
      console.warn("Unified backup planning audit failed:", error);
    });
    await applyPendingAuditBooksRestore().catch((error) => {
      console.warn("Books restore audit failed:", error);
    });
    await applyPendingAuditMangaRestore().catch((error) => {
      console.warn("Manga restore audit failed:", error);
    });
    await applyPendingAuditNovelsRestore().catch((error) => {
      console.warn("Novels restore audit failed:", error);
    });
    applyPendingRestoreLaunchIntent();
    if (pendingAuditOpen) {
      const target = pendingAuditOpen;
      const auditMangaId = pendingAuditMangaId;
      const auditChapterId = pendingAuditChapterId;
      const auditBookId = pendingAuditBookId;
      pendingAuditOpen = null;
      pendingAuditMangaId = null;
      pendingAuditChapterId = null;
      pendingAuditBookId = null;
      setTimeout(() => {
        if (target === "settings") openAuditSettings();
        if (target === "settings-security") openAuditSettings("security");
        if (target === "library") openAuditLibrary();
        if (target === "manga") void openAuditFirstManga();
        if (target === "reader") void openAuditFirstReader(auditMangaId, auditChapterId);
        if (target === "books") openAuditBooksLibrary();
        if (target === "book") void openAuditFirstBook(auditBookId);
        if (target === "book-reader") void openAuditFirstBookReader(auditBookId);
      }, 250);
    }
  }

  function clearStartupFailsafe() {
    if (startupFailsafeTimer === null) return;
    window.clearTimeout(startupFailsafeTimer);
    startupFailsafeTimer = null;
  }

  function armStartupFailsafe() {
    clearStartupFailsafe();
    startupFailsafeTimer = window.setTimeout(() => {
      startupFailsafeTimer = null;
      if (shellReady || failed || notConfigured || !startupSplashVisible || isNovelRuntimeHostWindow) return;
      failed = true;
      startupFailureTitle = runtimeAttachOnly
        ? translate("startup.couldNotAttachProfile", { profile: activeProfileLabel() })
        : translate("startup.couldNotStartProfile", { profile: activeProfileLabel() });
      startupFailureDetail = runtimeAttachOnly
        ? translate("startup.attachOnlyUnavailable", {
            profile: activeProfileLabel(),
            serverUrl: store.runtimeServerUrl ?? getServerTargetInfo().url,
          })
        : translate("startup.profileStillPreparing", {
            profile: activeProfileLabel(),
            serverUrl: store.runtimeServerUrl ?? getServerTargetInfo().url,
          });
    }, STARTUP_FAILSAFE_MS);
  }

  async function probeServerReady(base: string) {
    const healthy = await invoke<boolean>("probe_server_health", { serverUrl: base }).catch(() => false);
    if (healthy) return true;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      const authHeader = getServerAuthHeader();
      const response = await fetch(`${base.replace(/\/$/, "")}/api/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({ query: "query EpigraphStartupReady { __typename }" }),
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const json = await response.json();
      return json?.data?.__typename === "Query";
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function reconcileStartupSplashWithHealthyServer() {
    if (startupHealthWatchInFlight || shellReady || failed || notConfigured || !startupSplashVisible) return;
    const bases = getProbeBases();
    if (!bases.length) return;
    startupHealthWatchInFlight = true;
    try {
      for (const base of bases) {
        const healthy = await probeServerReady(base);
        if (healthy && !shellReady && !failed && !notConfigured && startupSplashVisible) {
          await finishStartupAfterProbe();
          return;
        }
      }
    } finally {
      startupHealthWatchInFlight = false;
    }
  }

  function canBootFromLibrarySnapshot() {
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return false;
    return shouldBootFromLibrarySnapshot({
      standbyEnabled: store.settings.localServerStandbyEnabled,
      attachOnly: runtimeAttachOnly,
      updateDue: nextLibraryUpdateDue(),
      hasSnapshot: hasLibrarySnapshot({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }),
    });
  }

  function startProbe() {
    const run = ++startupProbeRun;
    cancelProbe = false;
    failed      = false;
    shellReadyAt = null;
    bootStartedAt = Date.now();
    setStartupStatusCopy();
    armStartupFailsafe();

    async function probe() {
      if (cancelProbe || run !== startupProbeRun) return;
      if (canBootFromLibrarySnapshot()) {
        cancelProbe = true;
        await finishStartupAfterProbe();
        void preloadLibrarySnapshot();
        return;
      }
      for (const base of getProbeBases()) {
        const healthy = await probeServerReady(base);
        if (healthy && !cancelProbe && run === startupProbeRun) {
          await finishStartupAfterProbe();
          return;
        }
      }

      if (!cancelProbe && run === startupProbeRun) setTimeout(probe, 1000);
    }

    setTimeout(probe, 1250);
  }

  onMount(() => {
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReducedMotion = () => {
      prefersReducedMotion = reducedMotionQuery.matches;
    };
    updateReducedMotion();
    reducedMotionQuery.addEventListener("change", updateReducedMotion);
    try {
      win = getCurrentWindow();
    } catch (error) {
      console.warn("Unable to access current window during startup:", error);
      win = null;
    }

    try {
      isNovelRuntimeHostWindow = getCurrentWebviewWindow().label === NOVEL_RUNTIME_HOST_LABEL;
    } catch (error) {
      console.warn("Unable to inspect current webview during startup:", error);
      isNovelRuntimeHostWindow = false;
    }
    runtimeWindowClassified = true;

    if (isNovelRuntimeHostWindow) {
      startupSplashVisible = false;
      shellReady = false;
      return () => {
        reducedMotionQuery.removeEventListener("change", updateReducedMotion);
      };
    }

    void import("./lib/migration/coordinator")
      .then(({ recoverInterruptedMigrationOperations }) => recoverInterruptedMigrationOperations())
      .catch((error) => {
        console.error("Migration recovery inspection failed:", error);
      });

    const updatePageBackgroundState = () => {
      const webviewFocused = document.hasFocus();
      pageHidden = document.hidden || !(appWindowFocused || webviewFocused);
      uiMotionActive = !pageHidden;
      if (pageHidden) {
        trimRuntimeMemory({ minIntervalMs: 5_000 });
      }
      scheduleUiMotionPause();
      updateRuntimeDiagnosticsBridge();
    };

    const handleVisibilityChange = () => {
      updatePageBackgroundState();
    };
    const handleWindowFocusStateChange = () => {
      updatePageBackgroundState();
    };

    if (win) {
      void win.isFocused()
        .then((focused) => {
          appWindowFocused = focused;
          updatePageBackgroundState();
        })
        .catch((error) => {
          console.warn("Unable to inspect window focus during startup:", error);
        });
    }
    updatePageBackgroundState();
    // Pointer listeners only exist once the shell is ready; first-run steps and late content still
    // need their entrance animations to run while motion is idle.
    const stopMotionWake = observeMotionWake(document.body, () => !uiMotionActive && !pageHidden, scheduleUiMotionPause);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocusStateChange, { passive: true });
    window.addEventListener("blur", handleWindowFocusStateChange, { passive: true });
    window.addEventListener("storage", refreshAppReadingStateFromPersistence, { passive: true });
    libraryUpdateInterval = setInterval(() => {
      void runAutomaticLibraryUpdate("interval");
      void maybeStandbyAfterIdle("periodic-idle-check");
    }, 60_000);

    let cancelled = false;
    let unlistenResize = () => {};
    let unlistenScale = () => {};
    let unlistenFocus = () => {};
    let probeStarted = false;
    const ensureProbeStarted = () => {
      if (probeStarted || cancelled) return;
      probeStarted = true;
      startProbe();
    };
    document.addEventListener("contextmenu", e => e.preventDefault());
    void (async () => {
      const launchTarget = await invoke<LaunchTargetInfo>("get_launch_target").catch(() => null);
      if (cancelled) return;
      applyLaunchTarget(launchTarget);
      const initialTarget = getServerTargetInfo();
      document.title = `Epigraph [${initialTarget.title}]`;
      if (win) {
        await win.setTitle(`Epigraph [${initialTarget.title}]`).catch(() => {});
      }
      if (cancelled) return;
      installAuditBridge();
      window.addEventListener("keydown", handleAuditShortcut, true);

      platformScale = await invoke<number>("get_platform_ui_scale").catch(() => 1.0);
      if (cancelled) return;
      applyZoom();

      store.isFullscreen = win ? await win.isFullscreen().catch(() => false) : false;
      if (cancelled) return;

      const resizeUnlisten = win
        ? await win.onResized(async () => {
            store.isFullscreen = win ? await win.isFullscreen().catch(() => store.isFullscreen) : store.isFullscreen;
            scheduleViewportMetrics();
          }).catch((error) => {
            console.warn("Window resize listener failed during startup:", error);
            return () => {};
          })
        : () => {};
      if (cancelled) {
        resizeUnlisten();
        return;
      }
      unlistenResize = resizeUnlisten;

      const scaleUnlisten = win
        ? await win.onScaleChanged(async (event) => {
            platformScale = event.payload.scaleFactor;
            applyZoom();
          }).catch((error) => {
            console.warn("Window scale listener failed during startup:", error);
            return () => {};
          })
        : () => {};
      if (cancelled) {
        scaleUnlisten();
        return;
      }
      unlistenScale = scaleUnlisten;

      const focusUnlisten = win
        ? await win.onFocusChanged((event) => {
            appWindowFocused = event.payload;
            updatePageBackgroundState();
            if (event.payload) {
              resetIdle();
              void runAutomaticLibraryUpdate("focus");
            }
          }).catch((error) => {
            console.warn("Window focus listener failed during startup:", error);
            return () => {};
          })
        : () => {};
      if (cancelled) {
        focusUnlisten();
        return;
      }
      unlistenFocus = focusUnlisten;

        const effectiveServerUrl = normalizeServerUrlFromSession(store.runtimeServerUrl ?? store.settings.serverUrl)
          ?? store.runtimeResolvedLocalProfileMeta?.serverUrl
          ?? "http://127.0.0.1:4667";
        let shouldAutoStartServer = false;
        try {
          const parsed = new URL(effectiveServerUrl);
          const host = parsed.hostname.toLowerCase();
          const isLoopback = host === "127.0.0.1" || host === "localhost";
          const hasSnapshot = hasLibrarySnapshot({
            profileId: store.runtimeResolvedLocalProfileId,
            serverUrl: effectiveServerUrl,
          });
          shouldAutoStartServer = shouldAutoStartManagedServer({
            attachOnly: runtimeAttachOnly,
            isLoopback,
            autoStartServer: store.settings.autoStartServer,
            standbyEnabled: store.settings.localServerStandbyEnabled,
            hasSnapshot,
            updateDue: nextLibraryUpdateDue(),
          });
        } catch {
          shouldAutoStartServer = false;
        }

      if (store.settings.flareSolverrLocalAutoStart) {
        invoke("start_flaresolverr_local").catch(() => {});
      }

      if (shouldAutoStartServer) {
        try {
          await prepareManagedServerStartup({
            binary: store.settings.serverBinary,
            serverUrl: effectiveServerUrl,
            profileId: store.runtimeResolvedLocalProfileId,
            profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
            updateIntensity: store.settings.libraryUpdateIntensity,
          });
        } catch (err: any) {
          if (err?.kind === "NotConfigured") {
            notConfigured = true;
            startupFailureTitle = translate("startup.profileNotConfigured", { profile: activeProfileLabel() });
            startupFailureDetail = translate("startup.profileNotConfiguredBody");
          } else if (err?.kind === "AttachOnlyTarget") {
            console.info("Attach-only target skipped local server spawn.");
          } else {
            failed = true;
            startupFailureTitle = translate("startup.couldNotStartProfile", { profile: activeProfileLabel() });
            startupFailureDetail = operationFailure(err, "outcomes.runtimeUnavailable");
            console.warn("Could not start server:", err);
          }
        }
      }
      void runAutomaticLibraryUpdate("startup");

      ensureProbeStarted();

      type P = { chapterId: number; mangaId: number; progress: number }[];
        const downloadUnlisten = await listen<P>("download-progress", e => {
          lastDownloadEventAt = Date.now();
          commitActiveDownloads(mergePausedDownloads(e.payload));
        }).catch((error) => {
        console.warn("Download progress listener failed during startup:", error);
        return () => {};
      });
      if (cancelled) {
        downloadUnlisten();
        return;
      }
      unlistenDownload = downloadUnlisten;
    })().catch((error) => {
      console.error("App startup bootstrap failed before profile probe settled:", error);
      if (!cancelled) {
        ensureProbeStarted();
      }
    });

    return () => {
      cancelled = true;
      cancelProbe = true;
      clearStartupFailsafe();
      stopMotionWake();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocusStateChange);
      window.removeEventListener("blur", handleWindowFocusStateChange);
      reducedMotionQuery.removeEventListener("change", updateReducedMotion);
      window.removeEventListener("storage", refreshAppReadingStateFromPersistence);
      unlistenResize();
      unlistenScale();
      unlistenFocus();
      destroyRpc();
      if (idleTimer) clearTimeout(idleTimer);
      if (pollInterval) clearInterval(pollInterval);
      if (libraryUpdateInterval) clearInterval(libraryUpdateInterval);
      unlistenDownload?.();
      unlistenSyncdReplicationState?.();
      unlistenSyncdReplicationError?.();
      window.removeEventListener("keydown", handleAuditShortcut, true);
      uninstallAuditBridge();
      delete (globalThis as typeof globalThis & { __EPIGRAPH_DIAGNOSTICS__?: unknown }).__EPIGRAPH_DIAGNOSTICS__;
    };
  });

  $effect(() => {
    updateRuntimeDiagnosticsBridge();
  });

  $effect(() => {
    if (!shellReady || isNovelRuntimeHostWindow) return;
    void configureLocalServerRuntime({
      serverUrl: store.runtimeServerUrl,
      updateIntensity: store.settings.libraryUpdateIntensity,
      profileId: store.runtimeResolvedLocalProfileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
    }).catch((error) => {
      console.warn("Could not apply local Suwayomi runtime profile:", error);
    });
  });

  $effect(() => {
    if (!shellReady || isNovelRuntimeHostWindow) return;
    if (!store.runtimeServerUrl) return;
    const needsServer =
      store.navPage === "search"
      || store.navPage === "downloads"
      || Boolean(store.activeManga)
      || Boolean(store.activeChapter)
      || Boolean(store.activeSource);
    if (!needsServer) return;
    const reason = store.activeChapter
      ? "reader"
      : store.activeManga
        ? "series-detail"
        : store.navPage === "downloads"
          ? "downloads"
          : "browse";
    void ensureServerAwakeFor(reason, {
      serverUrl: store.runtimeServerUrl,
      binary: store.settings.serverBinary,
      updateIntensity: store.settings.libraryUpdateIntensity,
      profileId: store.runtimeResolvedLocalProfileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
    }).catch((error) => {
      console.warn("Could not wake Suwayomi for active surface:", error);
    });
  });

  $effect(() => {
    if (!shellReady || isNovelRuntimeHostWindow) return;
    if (!idle) return;
    void maybeStandbyAfterIdle("ui-idle");
  });

  $effect(() => {
    if (!shellReady || isNovelRuntimeHostWindow) {
      return;
    }

    const shouldListenToSyncdReplication =
      store.navPage === "settings" ||
      store.librarySection === "books" ||
      !!store.activeBookReaderId ||
      !!store.activeNovelReader ||
      !!store.activeNovelDetail;

    if (shouldListenToSyncdReplication) {
      if (!syncdListenersAttached && !syncdListenersPromise) {
        syncdListenersPromise = (async () => {
          const {
            listenSyncdReplicationError,
            listenSyncdReplicationState,
          } = await import("./lib/syncdDesktop");
          const replicationStateUnlisten = await listenSyncdReplicationState((payload) => {
            void handleReplicationState(payload);
          }).catch((error) => {
            console.warn("syncd replication state listener failed during startup:", error);
            return () => {};
          });
          if (replicationStateUnlisten) {
            unlistenSyncdReplicationState = replicationStateUnlisten;
          }

          const replicationErrorUnlisten = await listenSyncdReplicationError((payload) => {
            console.warn("syncd replication runtime warning:", payload);
          }).catch((error) => {
            console.warn("syncd replication error listener failed during startup:", error);
            return () => {};
          });
          if (replicationErrorUnlisten) {
            unlistenSyncdReplicationError = replicationErrorUnlisten;
          }

          syncdListenersAttached = true;
        })().finally(() => {
          syncdListenersPromise = null;
        });
      }
    } else {
      unlistenSyncdReplicationState?.();
      unlistenSyncdReplicationError?.();
      unlistenSyncdReplicationState = undefined;
      unlistenSyncdReplicationError = undefined;
      syncdListenersAttached = false;
    }
  });

  $effect(() => {
    const target = getServerTargetInfo();
    const title = `Epigraph [${target.title}]`;
    document.title = title;
    if (win) {
      void win.setTitle(title).catch(() => {});
    }
  });

  $effect(() => {
    if (!shellReady) return;
    const timer = setTimeout(checkForUpdateSilently, 5_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    lazyRetryEpoch;
    if ((shellReady || store.searchEngaged) && !SearchPaletteComponent) {
      void ensureLazyComponent("searchPalette").then((component) => {
        if (component) SearchPaletteComponent = component;
      });
    }
  });

  $effect(() => {
    if (!shellReady || isNovelRuntimeHostWindow) return;
    const timer = setTimeout(() => {
      void import("./lib/suwayomiUpdateUx.svelte")
        .then(({ refreshSuwayomiUpdateUx }) => refreshSuwayomiUpdateUx({ notify: true }))
        .catch(() => {});
    }, 7_000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!shellReady || isNovelRuntimeHostWindow) return;
    if (store.navPage !== "home" && store.navPage !== "library") return;
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
    void preloadLibrarySnapshot();
  });

  $effect(() => {
    if (!shellReady) return;
    if (store.navPage !== "home") return;
  });

  // When the splash starts dissolving, the app arrives beneath it instead of simply being uncovered.
  onMount(() => {
    const handleSplashExit = () => playShellEntrance(document.getElementById("app-shell"));
    window.addEventListener(SPLASH_EXIT_EVENT, handleSplashExit);
    return () => window.removeEventListener(SPLASH_EXIT_EVENT, handleSplashExit);
  });

  $effect(() => {
    document.documentElement.dataset.epigraphMotion = uiMotionActive ? "active" : "idle";
    document.body.dataset.epigraphMotion = uiMotionActive ? "active" : "idle";
    document.documentElement.dataset.epigraphIdle = idle ? "true" : "false";
    document.body.dataset.epigraphIdle = idle ? "true" : "false";
  });

  $effect(() => {
    const webviewFocused = typeof document === "undefined" ? true : document.hasFocus();
    setLibraryMotionEnvironment({
      libraryVisible: store.navPage === "library",
      windowFocused: !pageHidden || webviewFocused,
      shellIdle: idle,
      motionEnabled: !prefersReducedMotion,
    });
  });

  $effect(() => {
    if (isNovelRuntimeHostWindow || !shellReady) return;

    const profileId =
          normalizeLocalProfileIdFromSession(store.runtimeResolvedLocalProfileId)
          ?? normalizeLocalProfileIdFromSession(store.settings.defaultLocalProfileId);

    if (!profileId) return;
    if (lastSyncdRevalidatedProfileId === profileId) return;
    if (syncdRevalidationInFlightProfileId === profileId) return;

    syncdRevalidationInFlightProfileId = profileId;
    void invoke("syncd_revalidate_persisted_sync_sessions", { profileId })
      .then(() => {
        if (syncdRevalidationInFlightProfileId === profileId) {
          lastSyncdRevalidatedProfileId = profileId;
        }
      })
      .catch((error) => {
        console.warn("syncd desktop session revalidation failed:", error);
      })
      .finally(() => {
        if (syncdRevalidationInFlightProfileId === profileId) {
          syncdRevalidationInFlightProfileId = null;
        }
      });
  });

  $effect(() => {
    if (store.settings.discordRpc) {
      if (!discordRpcStarted) {
        discordRpcStarted = true;
        void initRpc(store.settings).then(() => {
          const hasActiveReader = Boolean(store.activeChapter || store.activeBookReaderId || store.activeNovelReader);
          if (!hasActiveReader) void setNavigationPresence(store.navPage, store.settings, "app-open");
        });
      }
    } else {
      discordRpcStarted = false;
      void destroyRpc();
    }
  });

  $effect(() => {
    const signature = [
      store.settings.discordRpcPrivateMode,
      store.settings.discordRpcShowTitle,
      store.settings.discordRpcShowCover,
      store.settings.discordRpcImproveCovers,
      store.settings.discordRpcShowProgress,
    ].join(":");
    if (!store.settings.discordRpc || !discordRpcStarted) {
      lastDiscordPrivacySignature = signature;
      return;
    }
    const hasActiveReader = Boolean(store.activeChapter || store.activeBookReaderId || store.activeNovelReader);
    if (lastDiscordPrivacySignature && lastDiscordPrivacySignature !== signature && !hasActiveReader) {
      void setNavigationPresence(store.navPage, store.settings, "privacy-change");
    }
    lastDiscordPrivacySignature = signature;
  });

  $effect(() => {
    const navPage = store.navPage;
    const hasActiveReader = Boolean(store.activeChapter || store.activeBookReaderId || store.activeNovelReader);
    const contextKey = hasActiveReader ? "reader" : `nav:${navPage}`;
    const reason = lastDiscordContextKey && lastDiscordContextKey !== contextKey ? "context-change" : "navigation";
    lastDiscordContextKey = contextKey;
    if (!hasActiveReader && store.settings.discordRpc) {
      void setNavigationPresence(navPage, store.settings, reason);
    }
  });

  $effect(() => {
    const activeDownloadCount = store.activeDownloads.filter((item) => item.state === "QUEUED" || item.state === "DOWNLOADING" || !item.state).length;
    const active = activeDownloadCount > 0;
    const hasActiveReader = Boolean(store.activeChapter || store.activeBookReaderId || store.activeNovelReader);
    if (store.settings.discordRpc && !hasActiveReader && active !== discordDownloadsActive) {
      void setDownloadPresence(activeDownloadCount, store.settings, active ? "download-start" : "download-stop");
    }
    discordDownloadsActive = active;
  });

  function handleZoomKey(e: KeyboardEvent) {
    if (hasActiveReaderCommandScope()) return;
    if (!e.ctrlKey) return;
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      store.settings.uiZoom = Math.min(2.0, Math.round(((store.settings.uiZoom ?? 1.0) + 0.1) * 10) / 10);
    } else if (e.key === "-") {
      e.preventDefault();
      store.settings.uiZoom = Math.max(0.5, Math.round(((store.settings.uiZoom ?? 1.0) - 0.1) * 10) / 10);
    } else if (e.key === "0") {
      e.preventDefault();
      store.settings.uiZoom = 1.0;
    }
  }

  async function exitFullscreen() {
    if (!win) return;
    await win.setFullscreen(false).catch((error) => {
      console.warn("Could not exit fullscreen:", error);
    });
    store.isFullscreen = await win.isFullscreen().catch(() => false);
  }

  async function toggleAppFullscreen() {
    if (!win) return;
    const next = !(await win.isFullscreen().catch(() => store.isFullscreen));
    await win.setFullscreen(next).catch((error) => {
      console.warn("Could not toggle fullscreen:", error);
    });
    store.isFullscreen = await win.isFullscreen().catch(() => next);
  }

  function handleGlobalFullscreenKey(e: KeyboardEvent) {
    if (isEditableKeyboardTarget(e.target)) return;
    if (e.key === "Escape" && store.isFullscreen) {
      e.preventDefault();
      e.stopPropagation();
      void exitFullscreen();
      return;
    }
    if (hasActiveReaderCommandScope()) return;
    const bind = store.settings.keybinds?.toggleFullscreen ?? "f";
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === bind.toLowerCase()) {
      e.preventDefault();
      void toggleAppFullscreen();
    }
  }

  $effect(() => {
    window.addEventListener("keydown", handleZoomKey);
    return () => window.removeEventListener("keydown", handleZoomKey);
  });

  $effect(() => {
    window.addEventListener("keydown", handleGlobalFullscreenKey, true);
    return () => window.removeEventListener("keydown", handleGlobalFullscreenKey, true);
  });

  async function handleRetry() {
    clearStartupFailsafe();
    startupProbeRun += 1;
    cancelProbe = true;
    failed        = false;
    notConfigured = false;
    serverProbeOk = false;
    shellReady    = false;
    startupLandingApplied = false;
    startupSplashVisible = true;
    setStartupStatusCopy();
    if (!runtimeAttachOnly) {
      try {
        await prepareManagedServerStartup({
          binary: store.settings.serverBinary,
          serverUrl: store.runtimeServerUrl ?? store.settings.serverUrl,
          profileId: store.runtimeResolvedLocalProfileId,
          profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
          updateIntensity: store.settings.libraryUpdateIntensity,
        });
      } catch (error) {
        failed = true;
        startupFailureTitle = translate("startup.couldNotStartProfile", { profile: activeProfileLabel() });
        startupFailureDetail = operationFailure(error, "outcomes.runtimeUnavailable");
        return;
      }
    }
    startProbe();
  }

  // A ready server lets the splash finish on its own: it dwells, asks for the PIN when the app is
  // locked, then dissolves while the app arrives (onReady hides it). Removing it here would skip
  // both the handoff and the lock. The fallback only covers an unlocked splash that never reports.
  let startupSplashFallback: ReturnType<typeof setTimeout> | null = null;
  function releaseStartupSplash() {
    if (lockEnabled || startupSplashFallback) return;
    startupSplashFallback = setTimeout(() => {
      startupSplashFallback = null;
      if (shellReady && !failed && !notConfigured) startupSplashVisible = false;
    }, 2500);
  }

  function handleBypass() {
    clearStartupFailsafe();
    startupProbeRun += 1;
    cancelProbe   = true;
    serverProbeOk = true;
    shellReady    = true;
    startupSplashVisible = false;
  }

  $effect(() => {
    if (isNovelRuntimeHostWindow || shellReady || failed || notConfigured || !startupSplashVisible) return;
    void reconcileStartupSplashWithHealthyServer();
    const interval = window.setInterval(() => {
      void reconcileStartupSplashWithHealthyServer();
    }, 1500);
    return () => window.clearInterval(interval);
  });

  $effect(() => {
    if (isNovelRuntimeHostWindow || bootReadyNotified || !shellReady) {
      return;
    }

    bootReadyNotified = true;
    if (!failed && !notConfigured) {
      releaseStartupSplash();
    }
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent("epigraph:boot-ready"));
    });
  });
  </script>

  {#if isNovelRuntimeHostWindow}
    {#if NovelRuntimeHostComponent}
      {@const NovelRuntimeHostView = NovelRuntimeHostComponent}
      <NovelRuntimeHostView />
    {:else}
      <SplashScreen mode="idle" showCards={store.settings.splashCards ?? true} />
    {/if}
  {:else}
    <div id="app-shell" class="root epigraph-app-shell" class:epigraph-motion-idle={!uiMotionActive} use:pointerEffects>
      {#if showIdleSplash}
        <SplashScreen mode="idle" showCards={store.settings.splashCards ?? true}
          onDismiss={() => { idle = false; resetIdle(); }} />
      {/if}
      <div class="content">
        {#if activeReaderChapter}
          {#if MangaReaderComponent}
            {@const MangaReaderView = MangaReaderComponent}
            {#key readerRenderKey}
              <MangaReaderView />
            {/key}
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">{$_("ui_loadingChapters")}</div>
          {/if}
        {:else if store.activeBookReaderId}
          {#if BookReaderComponent}
            {@const BookReaderView = BookReaderComponent}
            <BookReaderView />
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">{$_("ui_loadingBook")}</div>
          {/if}
        {:else if store.activeNovelReader}
          {#if NovelReaderComponent}
            {@const NovelReaderView = NovelReaderComponent}
            <NovelReaderView bind:this={novelReaderInstance} />
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">{$_("ui_loadingNovel")}</div>
          {/if}
        {:else if store.navPage === "settings" || store.navPage === "home" || store.navPage === "library" || store.navPage === "search" || store.navPage === "downloads"}
          {#if LayoutComponent}
            {@const LayoutView = LayoutComponent}
            <LayoutView
              onOpenThemeEditor={openThemeEditor}
              {backupAuditPlan}
              {backupRestoreLaunchIntent}
            />
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">{$_("ui_loading")}</div>
          {/if}
        {:else}
          {#if LayoutComponent}
            {@const LayoutView = LayoutComponent}
            <LayoutView
              onOpenThemeEditor={openThemeEditor}
              {backupAuditPlan}
              {backupRestoreLaunchIntent}
            />
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">{$_("ui_loading")}</div>
          {/if}
        {/if}
      </div>
      <button
        class="epigraph-search-dim-layer"
        type="button"
        tabindex="-1"
        aria-label={$_("ui_close")}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => {
          const activeElement = document.activeElement;
          store.closeSearchPalette(false);
          if (activeElement instanceof HTMLElement) activeElement.blur();
        }}
      ></button>
      {#if SearchPaletteComponent}
        {@const SearchPaletteView = SearchPaletteComponent}
        <SearchPaletteView />
      {/if}
      {#if store.isFullscreen}
        <button
          type="button"
          class="fullscreen-exit-btn"
          title={$_("ui_exitFullscreen")}
          aria-label={$_("ui_exitFullscreen")}
          onclick={() => void exitFullscreen()}
        >
          {$_("ui_exitFullscreen")}
        </button>
      {/if}
      {#if themeEditorOpen}
        {#if ThemeEditorComponent}
          {@const ThemeEditorView = ThemeEditorComponent}
          <ThemeEditorView
            bind:editingId={themeEditorEditId}
            onClose={closeThemeEditor}
          />
        {/if}
      {/if}
      {#if MangaPreviewComponent}
        {@const MangaPreviewView = MangaPreviewComponent}
        <MangaPreviewView />
      {/if}
      {#if ToasterComponent}
        {@const ToasterView = ToasterComponent}
        <ToasterView />
      {/if}
    </div>

  {#if devSplash}
    <SplashScreen mode="idle" showFps showCards={store.settings.splashCards ?? true}
      onDismiss={() => setTimeout(() => devSplash = false, 340)} />
  {:else if startupSplashVisible}
    <SplashScreen mode="loading" interactive={!shellReady} ringFull={serverProbeOk} {failed} {notConfigured}
      failureTitle={startupFailureTitle}
      failureDetail={typeof startupFailureDetail === "string" ? startupFailureDetail : presentOperationFailure(startupFailureDetail, $_)}
      statusText={startupStatusText}
      showCards={store.settings.splashCards ?? true}
      onReady={() => startupSplashVisible = false}
      onRetry={handleRetry}
      onBypass={handleBypass} />
  {/if}
{/if}

<style>
  .root {
    position: relative;
    height: 100%;
    overflow: hidden;
    background: var(--bg-void);
  }

  .content {
    min-width: 0;
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  .page-loading {
    display: grid;
    place-items: center;
    min-height: 100%;
    color: var(--component-app-loading-fg);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .fullscreen-exit-btn {
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: var(--component-app-fullscreen-exit-z-index);
    min-height: var(--component-app-fullscreen-exit-min-height);
    padding: var(--component-app-fullscreen-exit-padding);
    border-radius: var(--component-app-fullscreen-exit-radius);
    border: var(--component-app-fullscreen-exit-border);
    background: var(--component-app-fullscreen-exit-bg);
    color: var(--component-app-fullscreen-exit-fg);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    box-shadow: var(--component-app-fullscreen-exit-shadow);
    cursor: pointer;
  }

  .fullscreen-exit-btn:hover,
  .fullscreen-exit-btn:focus-visible {
    color: var(--component-app-fullscreen-exit-hover-fg);
    border-color: var(--component-app-fullscreen-exit-hover-border);
    background: var(--component-app-fullscreen-exit-hover-bg);
  }

  :global([data-epigraph-motion="idle"] .epigraph-app-shell .settings-theme-preview__tile),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .settings-theme-preview__glow),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .anim-branch) {
    animation-play-state: paused !important;
  }

  :global([data-epigraph-motion="idle"] .epigraph-app-shell *:not(.anim-spin):not(.anim-liquid-progress):not(.toast-life):not(.search-palette)) {
    animation-play-state: paused !important;
  }

  :global([data-epigraph-motion="idle"] .epigraph-app-shell .anim-spin) {
    animation-play-state: paused !important;
  }

  :global([data-epigraph-motion="idle"] .epigraph-app-shell .toast.toast.toast.toast),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .toast.toast.toast.toast *),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .search-palette) {
    animation-play-state: running !important;
  }

  :global([data-epigraph-motion="idle"] .epigraph-app-shell .n-topbar),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .n-sidebar),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .n-search),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .n-popover),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .content-header),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .repoOverlayBackdrop),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .modal),
  :global([data-epigraph-motion="idle"] .epigraph-app-shell .backdrop) {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  :global([data-epigraph-motion="idle"] .epigraph-app-shell .settings-theme-preview__glow) {
    filter: none !important;
  }
</style>
