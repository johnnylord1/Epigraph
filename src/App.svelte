<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { gql, gqlUpload } from "./lib/client";
  import { getServerTargetInfo } from "./lib/serverTarget";
  import ReaderPage from "./components/reader/Reader.svelte";
  import {
    DEFAULT_LOCAL_PROFILE_ID,
    type LocalProfileId,
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
    GET_LIBRARY_UPDATE_STATUS,
    GET_LIBRARY_TRACKING_SUMMARY,
    GET_RESTORE_STATUS,
    GET_TRACKERS,
    RESTORE_BACKUP,
    UPDATE_LIBRARY,
    UPDATE_EXTENSION,
  } from "./lib/queries";
  import {
    store,
    addToast,
    openBookReader,
    replaceBooksState,
    upsertBook,
    updateSettings,
    setActiveDownloads,
    setActiveBookId,
    setLibraryBootstrap,
    setCategories,
    setLibrarySection,
    setLibraryMangaSnapshot,
    setLibraryTrackingSummarySnapshot,
    refreshAppReadingStateFromPersistence,
    setRuntimeSettingsTab,
    setSettingsOpen,
    DEFAULT_HUD_THEME_TOKENS,
    THEME_MOTION_VARS,
  } from "./store/state.svelte";
  import { readFileAsArrayBuffer } from "./lib/books/storage";
  import { importLocalBookFile } from "./lib/books/importFile";
  import type { AethonRestorePlan, AethonRestorePlannerRuntime } from "./lib/backup/aethonRestorePlanner";
  import type { BackupLaunchIntent } from "./lib/backup/backupRollout";
  import type { AethonNovelRuntimeState } from "./lib/backup/novelsBackup";
  import type { RestoreReadinessSummary } from "./lib/reconciliation/types";
  import { initRpc, setIdle, clearReading, destroyRpc } from "./lib/discord";
  import { cache, CACHE_GROUPS, CACHE_KEYS, DEFAULT_TTL_MS } from "./lib/cache";
  import { normalizeCategories } from "./lib/library/categories";
  import { loadLibrarySnapshot, saveLibrarySnapshot } from "./lib/library/snapshot";
  import {
    ensureServerAwakeFor,
    isLoopbackServerUrl,
    maybeStandbyLocalServer,
  } from "./lib/serverLifecycle";
  import { loadNovelRepositoryState } from "./lib/novels/repositoryState";
  import {
    listenSyncdReplicationError,
    listenSyncdReplicationState,
    type TrackerCompletionTracker,
    type SyncdReplicationSnapshot,
  } from "./lib/syncdDesktop";
  import { createBooksCategory, sortBooksCategories } from "./lib/library/domainCategories";
  import type { Category, Chapter, DownloadStatus, DownloadQueueItem, Manga, Tracker } from "./lib/types";
  import type { ActiveDownload } from "./store/state.svelte";
  import { traceMediaAudit } from "./lib/mediaAudit";
  import { getImageCacheStats, trimImageCache } from "./lib/imageCache";
  import Toaster      from "./components/layout/Toaster.svelte";
  import SplashScreen from "./components/layout/SplashScreen.svelte";
  import Layout from "./components/layout/Layout.svelte";
  import { NOVEL_RUNTIME_HOST_LABEL } from "./lib/novels/runtimeHost";

  let themeStyleEl: HTMLStyleElement | null = null;

  $effect(() => {
    const themeId  = store.settings.theme ?? "dark";
    const isCustom = themeId.startsWith("custom:");

    if (!isCustom) {
      themeStyleEl?.remove();
      themeStyleEl = null;
      document.documentElement.setAttribute("data-theme", themeId);
      return;
    }

    const custom = store.settings.customThemes?.find(t => t.id === themeId);
    if (!custom) {
      themeStyleEl?.remove();
      themeStyleEl = null;
      document.documentElement.setAttribute("data-theme", "dark");
      return;
    }

    const hudTokens = { ...DEFAULT_HUD_THEME_TOKENS, ...(custom.hud ?? {}) };
    const motionVars = custom.motion ? (THEME_MOTION_VARS[custom.motion] ?? {}) : {};
    const vars = [
      ...Object.entries(custom.tokens).map(([k, v]) => `  --${k}: ${v};`),
      ...Object.entries(hudTokens).map(([k, v]) => `  --${k}: ${v};`),
      ...Object.entries(motionVars).map(([k, v]) => `  ${k}: ${v};`),
      "  --sidebar-width: var(--hud-sidebar-width);",
    ]
      .join("\n");
    const css = `[data-theme="custom"] {\n${vars}\n}`;

    if (!themeStyleEl) {
      themeStyleEl = document.createElement("style");
      themeStyleEl.id = "moku-custom-theme";
      document.head.appendChild(themeStyleEl);
    }
    themeStyleEl.textContent = css;
    document.documentElement.setAttribute("data-theme", "custom");
  });

  let themeEditorOpen   = $state(false);
  let themeEditorEditId = $state<string | null>(null);
  const activeReaderChapter = $derived(store.activeChapter);
  const activeReaderChapterId = $derived(store.activeChapter?.id ?? null);
  const readerRenderKey = $derived(activeReaderChapterId === null ? null : `${activeReaderChapterId}:${store.readerSessionId}`);

  type LazyModule = { default: any };
  type LazyKey =
    | "novelRuntimeHost"
    | "bookReader"
    | "novelDetail"
    | "novelReader"
    | "themeEditor"
    | "mangaPreview";

  const lazyLoaders: Record<LazyKey, () => Promise<LazyModule>> = {
    novelRuntimeHost: () => import("./components/novels/NovelRuntimeHost.svelte"),
    bookReader: () => import("./components/reader/BookReader.svelte"),
    novelDetail: () => import("./components/pages/NovelDetail.svelte"),
    novelReader: () => import("./components/reader/NovelReader.svelte"),
    themeEditor: () => import("./components/settings/ThemeEditor.svelte"),
    mangaPreview: () => import("./components/shared/MangaPreview.svelte"),
  };

  let NovelRuntimeHostComponent = $state<any>(null);
  let BookReaderComponent = $state<any>(null);
  let NovelDetailComponent = $state<any>(null);
  let NovelReaderComponent = $state<any>(null);
  let ThemeEditorComponent = $state<any>(null);
  let MangaPreviewComponent = $state<any>(null);
  const lazyComponentPromises = new Map<LazyKey, Promise<any>>();

  async function ensureLazyComponent(key: LazyKey) {
    let pending = lazyComponentPromises.get(key);
    if (!pending) {
      pending = lazyLoaders[key]().then((module) => module.default);
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

  const MAX_ATTEMPTS = 10;
  let win: Window | null = null;
  let isNovelRuntimeHostWindow = $state(false);


  let serverProbeOk = $state(false);
  let shellReady    = $state(false);
  let startupSplashVisible = $state(true);
  let startupLandingApplied = $state(false);
  let failed        = $state(false);
  let notConfigured = $state(false);
  let startupFailureTitle = $state("Could not reach server");
  let startupFailureDetail = $state("Aethon couldn't reach the selected local profile.");
  let startupStatusText = $state("Initializing profile");
  let idle          = $state(false);
  let uiMotionActive = $state(true);
  let devSplash     = $state(false);
  let bootReadyNotified = false;
  let lastSyncdRevalidatedProfileId = $state<string | null>(null);
  let syncdRevalidationInFlightProfileId = $state<string | null>(null);
  const showIdleSplash = $derived(
    idle
      && lockEnabled
      && !store.activeChapter
      && !store.activeBookReaderId
      && store.navPage !== "downloads",
  );

  let platformScale = $state(1.0);
  let _appliedZoom = -1;
  let _vhRafId: number | null = null;
  let uiMotionIdleTimer: ReturnType<typeof window.setTimeout> | null = null;
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
      document.documentElement.style.setProperty("--n-hud-scale", hudScale);
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
    const isReaderSurface = !!store.activeChapter || !!store.activeBookReaderId || !!store.activeNovelReader;
    document.body.dataset.appShellMode = isReaderSurface ? "reader" : "standard";
    return () => {
      delete document.body.dataset.appShellMode;
    };
  });

  $effect(() => {
    if (isNovelRuntimeHostWindow && !NovelRuntimeHostComponent) {
      void ensureLazyComponent("novelRuntimeHost").then((component) => {
        if (component) NovelRuntimeHostComponent = component;
      });
    }
  });

  $effect(() => {
    if (store.activeBookReaderId && !BookReaderComponent) {
      void ensureLazyComponent("bookReader").then((component) => {
        if (component) BookReaderComponent = component;
      });
    }
  });

  $effect(() => {
    if (store.activeNovelReader && !NovelReaderComponent) {
      void ensureLazyComponent("novelReader").then((component) => {
        if (component) NovelReaderComponent = component;
      });
    }
  });

  $effect(() => {
    if (store.activeNovelDetail && !NovelDetailComponent) {
      void ensureLazyComponent("novelDetail").then((component) => {
        if (component) NovelDetailComponent = component;
      });
    }
  });

  $effect(() => {
    if (themeEditorOpen && !ThemeEditorComponent) {
      void ensureLazyComponent("themeEditor").then((component) => {
        if (component) ThemeEditorComponent = component;
      });
    }
  });

  $effect(() => {
    if (!MangaPreviewComponent) {
      void ensureLazyComponent("mangaPreview").then((component) => {
        if (component) MangaPreviewComponent = component;
      });
    }
  });

  let prevQueue: DownloadQueueItem[] = [];
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
  let libraryBootstrapScopeKey: string | null = null;
  let libraryBootstrapInFlight: Promise<void> | null = null;
  let automaticLibraryUpdateInFlight: Promise<void> | null = null;
  let standbyInFlight = false;

  type RuntimeDiagnosticsSnapshot = {
    bootMs: number | null;
    shellReady: boolean;
    navPage: string;
    pageHidden: boolean;
    activeDownloads: number;
    lastDownloadEventAgeMs: number;
    cache: ReturnType<typeof cache.stats>;
    imageCache: ReturnType<typeof getImageCacheStats>;
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
    };
  }

  function preloadLibrarySnapshot() {
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return null;

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
      setCategories(normalizeCategories(persistedSnapshot.categories));
      setLibraryTrackingSummarySnapshot(persistedSnapshot.trackingSummary as TrackerCompletionTracker[]);
      setLibraryBootstrap("ready", scopeKey, persistedSnapshot.trackingSummary as TrackerCompletionTracker[]);
    }

    if (libraryBootstrapScopeKey === scopeKey && libraryBootstrapInFlight) {
      return libraryBootstrapInFlight;
    }
    if (
      libraryBootstrapScopeKey === scopeKey
      && store.libraryBootstrapScopeKey === scopeKey
      && store.libraryBootstrapStatus === "ready"
      && store.libraryMangaSnapshot.length > 0
      && store.categories.length > 0
    ) {
      return null;
    }

    libraryBootstrapScopeKey = scopeKey;
    setLibraryBootstrap("loading", scopeKey);
    libraryBootstrapInFlight = (async () => {
      const [mangas, categories, trackingSummary] = await Promise.all([
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

      const normalizedMangas = mangas.map((manga: any) => ({
        ...manga,
        chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? 0,
      }));
      const normalizedCategories = normalizeCategories(categories);
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
    if (automaticLibraryUpdateInFlight) return;

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

  async function runAutomaticLibraryUpdate(reason: "startup" | "focus" | "interval") {
    if (automaticLibraryUpdateInFlight) return automaticLibraryUpdateInFlight;
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return null;
    if (!nextLibraryUpdateDue()) return null;
    if (shouldKeepServerAwake() && reason !== "startup") return null;

    automaticLibraryUpdateInFlight = (async () => {
      const awake = await ensureServerAwakeFor("auto-library-update", {
        serverUrl: store.runtimeServerUrl,
        binary: store.settings.serverBinary,
      });
      if (!awake) return;
      await gql(UPDATE_LIBRARY, { categories: undefined });
      await waitForLibraryUpdateToSettle();
      updateSettings({ lastLibraryUpdateAt: Date.now() });
      cache.clearGroup(CACHE_GROUPS.LIBRARY);
      await preloadLibrarySnapshot();
      await maybeStandbyAfterIdle("auto-library-update");
    })()
      .catch((error) => {
        console.warn("Automatic library update failed:", error);
      })
      .finally(() => {
        automaticLibraryUpdateInFlight = null;
      });

    return automaticLibraryUpdateInFlight;
  }

  async function waitForLibraryUpdateToSettle(timeoutMs = 8 * 60 * 1000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await gql<any>(GET_LIBRARY_UPDATE_STATUS).catch(() => null);
      const jobsInfo = status?.libraryUpdateStatus?.jobsInfo;
      if (!jobsInfo?.isRunning) return jobsInfo ?? null;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    return null;
  }

  function updateRuntimeDiagnosticsBridge() {
    (globalThis as typeof globalThis & { __AETHON_DIAGNOSTICS__?: RuntimeDiagnosticsBridge }).__AETHON_DIAGNOSTICS__ = {
      getSnapshot: getRuntimeDiagnosticsSnapshot,
      getBackendSnapshot: () => invoke("get_runtime_diagnostics"),
    };
  }

  type AethonAuditBridge = {
    showSplash: () => void;
    hideSplash: () => void;
    toggleSplash: () => void;
    bypassStartupSplash: () => void;
    openSettings: () => void;
    closeSettings: () => void;
    openLibrary: () => void;
    openBooksLibrary: () => void;
    openFirstManga: () => void;
    openFirstReader: () => Promise<void>;
    openFirstBook: () => Promise<void>;
    openFirstBookReader: () => Promise<void>;
    getState: () => {
      navPage: string;
      librarySection: string;
      activeMangaId: number | null;
      activeChapterId: number | null;
      activeBookId: string | null;
      activeBookReaderId: string | null;
      settingsOpen: boolean;
      splashVisible: boolean;
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
  };

  type AethonAuditWindow = Window & {
    __mokuShowSplash?: () => void;
    __aethonAudit?: AethonAuditBridge;
    __aethonMediaAudit?: boolean;
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

  const AUDIT_SYNCD_BOOK_ID = "audit-sync-book";
  const AUDIT_SYNCD_NOVEL_SOURCE_ID = "audit-sync-source";
  const AUDIT_SYNCD_NOVEL_PATH = "/audit-sync-novel";
  const AUDIT_SYNCD_NOVEL_CHAPTER_PATH = "/chapter-1";

  function resolveAuditSyncScope() {
    const profileId = normalizeLocalProfileIdFromSession(store.runtimeResolvedLocalProfileId);
    const serverUrl = normalizeServerUrlFromSession(store.runtimeResolvedLocalProfileMeta?.serverUrl ?? store.runtimeServerUrl);
    return { profileId, serverUrl };
  }

  async function readAuditNovelLibraryPersistence() {
    const scope = {
      profileId: normalizeLocalProfileIdFromSession(store.runtimeResolvedLocalProfileId),
      serverUrl: normalizeServerUrlFromSession(store.runtimeServerUrl),
    };
    const [{ reloadNovelLibraryState }, rawState, storageRoot] = await Promise.all([
      import("./lib/novels/libraryState"),
      invoke<string | null>("read_novel_library_state", scope).catch(() => null),
      invoke<string>("resolve_novel_storage_root", scope).catch(() => null),
    ]);

    return {
      storageRoot,
      rawState,
      state: await reloadNovelLibraryState(scope),
    };
  }

  async function readAuditBookLibraryPersistence() {
    const [{ reloadBookLibraryState }, rawState, storageRoot] = await Promise.all([
      import("./lib/books/libraryState"),
      invoke<string | null>("read_book_library_state").catch(() => null),
      invoke<string>("resolve_book_storage_root").catch(() => null),
    ]);

    return {
      storageRoot,
      rawState,
      state: await reloadBookLibraryState(),
    };
  }

  async function importAuditBookFromPath(sourcePath: string) {
    const imported = await importLocalBookFile(sourcePath, { existingBooks: store.books });
    upsertBook(imported.entry);

    const category = store.settings.booksCategories.find((entry) => entry.name === "Audit Shelf")
      ?? createBooksCategory(store.settings.booksCategories, "Audit Shelf");

    const booksCategories = sortBooksCategories([
      ...store.settings.booksCategories.filter((entry) => entry.id !== category.id),
      category,
    ]);
    const previousAssignments = store.settings.booksCategoryAssignments[imported.entry.id] ?? [];
    const booksCategoryAssignments = {
      ...store.settings.booksCategoryAssignments,
      [imported.entry.id]: Array.from(new Set([...previousAssignments, category.id])),
    };

    updateSettings({
      booksCategories,
      booksCategoryAssignments,
      booksLibraryUi: {
        ...store.settings.booksLibraryUi,
        activeCategoryId: category.id,
        typeFilter: imported.entry.subtype,
        search: imported.entry.title,
      },
    });

    return {
      id: imported.entry.id,
      title: imported.entry.title,
      subtype: imported.entry.subtype,
      categoryId: category.id,
    };
  }

  async function mutateSyncdAuditBookFixture(input?: {
    mode?: "progress" | "bookmark" | "clear_bookmarks";
    marker?: string | null;
    progressPercent?: number | null;
  }) {
    const { reloadBookLibraryState, saveBookLibraryState } = await import("./lib/books/libraryState");
    const mode = input?.mode ?? "progress";
    const marker = input?.marker?.trim() || "audit";
    const now = Date.now();
    const progressPercent = typeof input?.progressPercent === "number"
      ? Math.max(0, Math.min(1, input.progressPercent))
      : 0.5;

    const state = await reloadBookLibraryState();
    const books = state.books.some((entry) => entry.id === AUDIT_SYNCD_BOOK_ID)
      ? state.books
      : [
          ...state.books,
          {
            id: AUDIT_SYNCD_BOOK_ID,
            title: "Audit Sync Book",
            author: "Aethon",
            description: "Automation-only sync replication fixture.",
            coverPath: null,
            subtype: "epub" as const,
            createdAt: now,
            updatedAt: now,
            importPath: "audit://sync-book.epub",
            assetPath: "audit://sync-book.epub",
            sectionCount: 1,
          },
        ];

    let bookProgress = state.bookProgress.filter((entry) => entry.bookId !== AUDIT_SYNCD_BOOK_ID);
    let bookBookmarks = state.bookBookmarks.filter((entry) => !(entry.bookId === AUDIT_SYNCD_BOOK_ID && entry.location === "audit-sync-bookmark"));

    if (mode === "progress") {
      bookProgress = [
        ...bookProgress,
        {
          bookId: AUDIT_SYNCD_BOOK_ID,
          location: `audit-progress-${marker}`,
          href: `/audit/${marker}`,
          progressPercent,
          lastReadAt: now,
          pageIndex: 1,
          totalPages: 10,
          sectionLabel: `Audit ${marker}`,
          renderer: "epub" as const,
        },
      ];
    } else if (mode === "bookmark") {
      bookBookmarks = [
        ...bookBookmarks,
        {
          bookId: AUDIT_SYNCD_BOOK_ID,
          location: "audit-sync-bookmark",
          href: `/audit/bookmark/${marker}`,
          pageIndex: 1,
          progressPercent,
          label: `Audit bookmark ${marker}`,
          savedAt: now,
        },
      ];
    }

    const saved = await saveBookLibraryState({
      ...state,
      books,
      bookProgress,
      bookBookmarks,
      updatedAtMs: now,
    });

    return {
      bookId: AUDIT_SYNCD_BOOK_ID,
      progressPercent: mode === "progress" ? progressPercent : null,
      bookmarkLabel: mode === "bookmark" ? `Audit bookmark ${marker}` : null,
      bookmarkCount: saved.bookBookmarks.filter((entry) => entry.bookId === AUDIT_SYNCD_BOOK_ID).length,
    };
  }

  async function mutateSyncdAuditNovelFixture(input?: {
    mode?: "progress" | "bookmark" | "clear_bookmarks";
    marker?: string | null;
    progressPercent?: number | null;
  }) {
    const scope = resolveAuditSyncScope();
    if (!scope.profileId) {
      throw new Error("No active local profile is available for the syncd novel audit fixture.");
    }

    const {
      reloadNovelLibraryState,
      saveNovelLibraryState,
      upsertNovelInLibrary,
      markNovelChapterRead,
    } = await import("./lib/novels/libraryState");
    const {
      createNovelLibraryId,
      createNovelChapterId,
    } = await import("./lib/novels/domain");

    const mode = input?.mode ?? "progress";
    const marker = input?.marker?.trim() || "audit";
    const now = Date.now();
    const requestedProgressPercent = typeof input?.progressPercent === "number"
      ? Math.max(0, Math.min(1, input.progressPercent))
      : 1;

    const novelId = createNovelLibraryId(AUDIT_SYNCD_NOVEL_SOURCE_ID, AUDIT_SYNCD_NOVEL_PATH);
    const chapterId = createNovelChapterId(novelId, AUDIT_SYNCD_NOVEL_CHAPTER_PATH);
    const chapterTitle = "Audit Chapter 1";

    let state = await reloadNovelLibraryState(scope);
    state = upsertNovelInLibrary(state, {
      id: novelId,
      sourceId: AUDIT_SYNCD_NOVEL_SOURCE_ID,
      title: "Audit Sync Novel",
      path: AUDIT_SYNCD_NOVEL_PATH,
      coverUrl: null,
      author: "Aethon",
      description: "Automation-only sync replication fixture.",
      status: "ongoing",
      tags: ["audit", "syncd"],
      chapterCount: 1,
      chapters: [
        {
          id: chapterId,
          novelId,
          path: AUDIT_SYNCD_NOVEL_CHAPTER_PATH,
          title: chapterTitle,
          order: 1,
          releaseTime: null,
          unread: true,
        },
      ],
      source: {
        repositoryUrl: "https://audit.invalid/repo",
        repositoryName: "Audit Repository",
        pluginId: "audit-sync-plugin",
        pluginName: "Audit Sync Plugin",
        pluginVersion: "1.0.0",
        sourceId: AUDIT_SYNCD_NOVEL_SOURCE_ID,
        sourceName: "Audit Source",
        lang: "en",
      },
    });

    if (mode === "progress") {
      state = markNovelChapterRead(state, {
        novelId,
        chapterId,
        chapterTitle,
      });
      if (requestedProgressPercent < 1) {
        state = {
          ...state,
          progress: state.progress.map((entry) => entry.novelId === novelId
            ? { ...entry, progressPercent: requestedProgressPercent, updatedAt: now }
            : entry),
          updatedAtMs: now,
        };
      }
    } else if (mode === "bookmark") {
      state = {
        ...state,
        bookmarks: [
          ...state.bookmarks.filter((entry) => !(entry.novelId === novelId && entry.locator === "audit-sync-novel-bookmark")),
          {
            novelId,
            chapterId,
            chapterTitle,
            locator: "audit-sync-novel-bookmark",
            label: `Audit novel bookmark ${marker}`,
            savedAt: now,
          },
        ],
        updatedAtMs: now,
      };
    } else {
      state = {
        ...state,
        bookmarks: state.bookmarks.filter((entry) => !(entry.novelId === novelId && entry.locator === "audit-sync-novel-bookmark")),
        updatedAtMs: now,
      };
    }

    const saved = await saveNovelLibraryState(state, scope);
    return {
      profileId: scope.profileId,
      novelId,
      chapterId,
      progressPercent: mode === "progress" ? requestedProgressPercent : null,
      bookmarkLabel: mode === "bookmark" ? `Audit novel bookmark ${marker}` : null,
      bookmarkCount: saved.bookmarks.filter((entry) => entry.novelId === novelId).length,
    };
  }

  function enableMediaAudit() {
    (window as AethonAuditWindow).__aethonMediaAudit = true;
  }

  function disableMediaAudit() {
    (window as AethonAuditWindow).__aethonMediaAudit = false;
  }

  function installAuditBridge() {
    const auditWindow = window as AethonAuditWindow;
    auditWindow.__mokuShowSplash = showAuditSplash;
    auditWindow.__aethonAudit = {
      showSplash: showAuditSplash,
      hideSplash: hideAuditSplash,
      toggleSplash: toggleAuditSplash,
      bypassStartupSplash: bypassAuditStartupSplash,
      openSettings: openAuditSettings,
      closeSettings: closeAuditSettings,
      openLibrary: openAuditLibrary,
      openBooksLibrary: openAuditBooksLibrary,
      openFirstManga: openAuditFirstManga,
      openFirstReader: openAuditFirstReader,
      openFirstBook: openAuditFirstBook,
      openFirstBookReader: openAuditFirstBookReader,
      openFirstPdfBook: openAuditFirstPdfBook,
      openFirstNovel: openAuditFirstNovel,
      getState: getAuditState,
      getSyncdPanelDiagnostics,
      readNovelLibraryPersistence: readAuditNovelLibraryPersistence,
      readBookLibraryPersistence: readAuditBookLibraryPersistence,
      importBookFromPath: importAuditBookFromPath,
      mutateSyncdAuditBookFixture,
      mutateSyncdAuditNovelFixture,
      enableMediaAudit,
      disableMediaAudit,
    };
  }

  function uninstallAuditBridge() {
    const auditWindow = window as AethonAuditWindow;
    delete auditWindow.__mokuShowSplash;
    delete auditWindow.__aethonAudit;
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
        addToast({ kind: "success", title: "Chapter downloaded",
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

  function trimIdleMemory() {
    cache.trimExpired();
    trimImageCache(false);
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
        trimIdleMemory();
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
      const [currentVersion, releases] = await Promise.all([
        getVersion(),
        invoke<Array<{ tag_name: string; html_url: string }>>("list_releases"),
      ]);

      const valid = releases.filter(r => typeof r.tag_name === "string" && r.tag_name.trim());
      if (!valid.length) return;

      const parse = (tag: string): number[] =>
        tag.replace(/^v/, "").split(".").map(Number);

      const compare = (a: number[], b: number[]): number => {
        for (let i = 0; i < 3; i++) {
          if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
        }
        return 0;
      };

      const latestTag = valid
        .map(r => r.tag_name)
        .sort((a, b) => compare(parse(a), parse(b)))[0]
        .replace(/^v/, "");

      const isNewer = compare(parse(latestTag), parse(currentVersion)) < 0;
      if (isNewer) {
        addToast({
          kind: "info",
          title: `Update available — v${latestTag}`,
          body: "Open Settings → About to install.",
          duration: 8000,
        });
      }
    } catch {}
  }

  let cancelProbe = false;
  let pendingAuditOpen: LaunchTargetProfileOverrides["auditOpenOverride"] = null;
  let pendingAuditMangaId: number | null = null;
  let pendingAuditChapterId: number | null = null;
  let pendingAuditBookId: string | null = null;
  let pendingAuditMangaBackupPath: string | null = null;
  let pendingAuditBooksBackupPath: string | null = null;
  let pendingAuditNovelsBackupPath: string | null = null;
  let pendingAuditAethonBackupPath: string | null = null;
  let pendingRestoreMangaBackupPath: string | null = null;
  let pendingRestoreAethonBackupPath: string | null = null;
  let pendingRestoreHandoff = false;
  let pendingRestoreSourceProfileId: LocalProfileId | null = null;
  let backupAuditPlan = $state<AethonRestorePlan | null>(null);
  let backupRestoreLaunchIntent = $state<BackupLaunchIntent | null>(null);
  let runtimeAttachOnly = $state(false);

  interface LaunchTargetInfo extends LaunchTargetProfileOverrides {
    serverAuthEnabledOverride?: boolean | null;
    serverAuthUserOverride?: string | null;
    serverAuthPassOverride?: string | null;
    auditMangaBackupOverride?: string | null;
    auditBooksBackupOverride?: string | null;
    auditNovelsBackupOverride?: string | null;
    auditAethonBackupOverride?: string | null;
    restoreMangaBackupOverride?: string | null;
    restoreAethonBackupOverride?: string | null;
    restoreHandoffOverride?: boolean | null;
    restoreSourceProfileOverride?: string | null;
  }

  function activeProfileLabel(): string {
    return store.runtimeResolvedLocalProfileMeta?.label
      ?? store.runtimeServerLabel
      ?? "CUSTOM";
  }

  function setStartupStatusCopy() {
    const prefix = activeProfileLabel();
    startupStatusText = runtimeAttachOnly
      ? `Attaching to ${prefix} profile`
      : `Initializing ${prefix} profile`;
    startupFailureTitle = `Could not start ${prefix} profile`;
    startupFailureDetail = `Aethon couldn't reach the ${prefix} profile for this session.`;
  }

  function applyLaunchTarget(launchTarget: LaunchTargetInfo | null) {
    pendingAuditOpen = launchTarget?.auditOpenOverride ?? null;
    pendingAuditMangaId = launchTarget?.auditMangaIdOverride ?? null;
    pendingAuditChapterId = launchTarget?.auditChapterIdOverride ?? null;
    pendingAuditBookId = launchTarget?.auditBookIdOverride ?? null;
    pendingAuditMangaBackupPath = launchTarget?.auditMangaBackupOverride ?? null;
    pendingAuditBooksBackupPath = launchTarget?.auditBooksBackupOverride ?? null;
    pendingAuditNovelsBackupPath = launchTarget?.auditNovelsBackupOverride ?? null;
    pendingAuditAethonBackupPath = launchTarget?.auditAethonBackupOverride ?? null;
    pendingRestoreMangaBackupPath = launchTarget?.restoreMangaBackupOverride ?? null;
    pendingRestoreAethonBackupPath = launchTarget?.restoreAethonBackupOverride ?? null;
    pendingRestoreHandoff = Boolean(launchTarget?.restoreHandoffOverride);
    pendingRestoreSourceProfileId = normalizeLocalProfileIdFromSession(launchTarget?.restoreSourceProfileOverride);
    runtimeAttachOnly = Boolean(launchTarget?.attachOnlyOverride);
    (window as AethonAuditWindow).__aethonMediaAudit = Boolean(launchTarget?.auditOpenOverride);

    const resolved = resolveSessionProfileFromLocalProfiles(
      launchTarget,
      store.settings.defaultLocalProfileId,
      store.settings.serverUrl,
    );

    store.runtimeResolvedLocalProfileId = resolved.profileId;
    store.runtimeResolvedLocalProfileMeta = resolved.profileMeta;
    store.runtimeProfileResolutionSource = resolved.resolutionSource;
    store.runtimeLaunchProfileOverride = resolved.launchProfileOverride;
    store.runtimeIsOverrideSession = resolved.isOverrideSession;
    store.runtimeServerUrl = resolved.effectiveServerUrl;
    store.runtimeServerLabel = resolved.displayLabel;

    if (resolved.isOverrideSession && !resolved.attachOnly && resolved.profileId) {
      updateSettings({
      defaultLocalProfileId: resolved.profileId,
        serverUrl: resolved.effectiveServerUrl,
      });
    }

    if (!resolved.isOverrideSession && normalizeLocalProfileIdFromSession(store.settings.defaultLocalProfileId) == null) {
      store.settings = { ...store.settings, defaultLocalProfileId: DEFAULT_LOCAL_PROFILE_ID };
    }

    if (typeof launchTarget?.serverAuthEnabledOverride === "boolean") {
      store.settings = {
        ...store.settings,
        serverAuthEnabled: launchTarget.serverAuthEnabledOverride,
        serverAuthUser: launchTarget.serverAuthUserOverride ?? store.settings.serverAuthUser,
        serverAuthPass: launchTarget.serverAuthPassOverride ?? store.settings.serverAuthPass,
      };
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

  async function applyPendingAuditBooksRestore() {
    const path = pendingAuditBooksBackupPath?.trim();
    if (!path) return;
    pendingAuditBooksBackupPath = null;

    traceMediaAudit({
      event: "books.restore.audit.started",
      path,
    });

    try {
      const { restoreAethonBooksPayload } = await import("./lib/backup/booksBackup");
      const bytes = await readFileAsArrayBuffer(path);
      const restored = await restoreAethonBooksPayload(bytes);
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
        title: restored.issues.length ? "Books restore loaded with warnings" : "Books restore loaded",
        body: `${restored.books.length} restored book${restored.books.length === 1 ? "" : "s"}.`,
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
        title: "Books restore audit failed",
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

  async function loadNovelAuditRuntimeState(): Promise<AethonNovelRuntimeState> {
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

  async function loadRestorePlannerRuntime(): Promise<AethonRestorePlannerRuntime> {
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
    return [
      `${summary.totalEntries} entries`,
      `${summary.restoredUsableCount} usable`,
      `${summary.restoredNeedsRepositoryCount} need repo`,
      `${summary.restoredNeedsPluginCount} need plugin`,
      `${summary.restoredMetadataOnlyCount} metadata-only`,
    ].join(" · ");
  }

  async function applyPendingAuditAethonBackupPlan() {
    const path = pendingAuditAethonBackupPath?.trim();
    if (!path) return;
    pendingAuditAethonBackupPath = null;

    traceMediaAudit({
      event: "backup.plan.audit.started",
      path,
    });

    try {
      const { buildAethonRestorePlan } = await import("./lib/backup/aethonRestorePlanner");
      const rawBytes = await readFileAsArrayBuffer(path);
      const runtime = await loadRestorePlannerRuntime();
      const plan = await buildAethonRestorePlan(rawBytes, runtime);
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
        title: "Unified backup restore plan loaded",
        body: plan.summary.summaryLabel,
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
        title: "Unified backup planning failed",
        body: message,
        duration: 15000,
      });
      throw error;
    }
  }

  function applyPendingRestoreLaunchIntent() {
    const aethonPath = pendingRestoreAethonBackupPath?.trim();
    const mangaPath = pendingRestoreMangaBackupPath?.trim();
    if (!aethonPath && !mangaPath) return;

    backupRestoreLaunchIntent = {
      kind: aethonPath ? "aethon" : "manga",
      path: aethonPath ?? mangaPath!,
      handoff: pendingRestoreHandoff,
      sourceProfileId: pendingRestoreSourceProfileId,
    };

    pendingRestoreAethonBackupPath = null;
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
      const { restoreAethonNovelsPayload } = await import("./lib/backup/novelsBackup");
      const rawBytes = await readFileAsArrayBuffer(path);
      const runtime = await loadNovelAuditRuntimeState();
      const restored = await restoreAethonNovelsPayload(rawBytes, runtime);

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
        title: hasBlocked ? "Novels restore classified with requirements" : "Novels restore classified",
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
        title: "Novels restore audit failed",
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
        { extractAethonMangaPayloadFile },
        { analyzeBackupReconciliation, overlayEntryFromAnalysis },
        { readOverlayFile, upsertOverlayEntry },
        { buildRestoreReadiness },
        { buildReconciledBackupFile },
        { loadSourceInventory },
      ] = await Promise.all([
        import("./lib/backup/mangaBackup"),
        import("./lib/reconciliation/analyze"),
        import("./lib/reconciliation/overlay"),
        import("./lib/reconciliation/readiness"),
        import("./lib/reconciliation/restore"),
        import("./lib/reconciliation/sourceInventory"),
      ]);
      const rawBytes = await readFileAsArrayBuffer(path);
      const extractedBackup = await extractAethonMangaPayloadFile(rawBytes);
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
        title: "Manga restore loaded",
        body: `${finalStatus?.totalManga ?? parsed.parsedBackup.backupManga.length} manga restored into the current profile.`,
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
        title: "Manga restore audit failed",
        body: message,
      });
      throw error;
    }
  }

  async function finishStartupAfterProbe() {
    failed = false;
    serverProbeOk = true;
    shellReady = true;
    shellReadyAt = Date.now();
    startupSplashVisible = false;
    applyStartupLandingPage();
    await applyPendingAuditAethonBackupPlan().catch((error) => {
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

  function canBootFromLibrarySnapshot() {
    if (!store.settings.localServerStandbyEnabled) return false;
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return false;
    if (runtimeAttachOnly) return false;
    return Boolean(loadLibrarySnapshot({
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    }));
  }

  function startProbe() {
    cancelProbe = false;
    failed      = false;
    shellReadyAt = null;
    bootStartedAt = Date.now();
    setStartupStatusCopy();
    let tries   = 0;

    async function probe() {
      if (cancelProbe) return;
      if (canBootFromLibrarySnapshot() && !nextLibraryUpdateDue()) {
        cancelProbe = true;
        await finishStartupAfterProbe();
        void preloadLibrarySnapshot();
        return;
      }
      tries++;

      for (const base of getProbeBases()) {
        try {
          const healthy = await invoke<boolean>("probe_server_health", { serverUrl: base });
          if (healthy && !cancelProbe) {
            await finishStartupAfterProbe();
            return;
          }
        } catch {}
      }

      if (tries >= MAX_ATTEMPTS && !cancelProbe) {
        failed = true;
        if (!notConfigured) {
          startupFailureTitle = runtimeAttachOnly
            ? `Could not attach to ${activeProfileLabel()} profile`
            : `Could not start ${activeProfileLabel()} profile`;
          startupFailureDetail = runtimeAttachOnly
            ? `This session is attach-only, and the ${activeProfileLabel()} profile was not reachable on ${store.runtimeServerUrl ?? "its expected local server"}.`
            : `Aethon couldn't reach the ${activeProfileLabel()} profile on ${store.runtimeServerUrl ?? "its expected local server"}.`;
        }
        setTimeout(probe, 4000);
        return;
      }
      if (!cancelProbe) setTimeout(probe, 1000);
    }

    setTimeout(probe, 1250);
  }

  onMount(() => {
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

    if (isNovelRuntimeHostWindow) {
      startupSplashVisible = false;
      shellReady = false;
      return () => {};
    }

    const updatePageBackgroundState = () => {
      pageHidden = document.hidden || !appWindowFocused;
      uiMotionActive = !pageHidden;
      if (pageHidden) {
        trimIdleMemory();
      }
      scheduleUiMotionPause();
      updateRuntimeDiagnosticsBridge();
    };

    const handleVisibilityChange = () => {
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
    document.addEventListener("visibilitychange", handleVisibilityChange);
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
    async function handleReplicationState(payload: SyncdReplicationSnapshot) {
      if (!payload.lastAppliedAtMs || payload.lastAppliedScopes.length === 0) return;
      if (syncdAppliedMarks.get(payload.localProfileId) === payload.lastAppliedAtMs) return;
      syncdAppliedMarks.set(payload.localProfileId, payload.lastAppliedAtMs);

      if (payload.lastAppliedScopes.includes("books:global")) {
        try {
          const { reloadBookLibraryState } = await import("./lib/books/libraryState");
          const next = await reloadBookLibraryState();
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
    const ensureProbeStarted = () => {
      if (probeStarted || cancelled) return;
      probeStarted = true;
      startProbe();
    };
    document.addEventListener("contextmenu", e => e.preventDefault());
    ensureProbeStarted();
    void (async () => {
      const launchTarget = await invoke<LaunchTargetInfo>("get_launch_target").catch(() => null);
      if (cancelled) return;
      applyLaunchTarget(launchTarget);

      const initialTarget = getServerTargetInfo();
      document.title = `Aethon [${initialTarget.title}]`;
      if (win) {
        await win.setTitle(`Aethon [${initialTarget.title}]`).catch(() => {});
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
          const hasSnapshot = Boolean(loadLibrarySnapshot({
            profileId: store.runtimeResolvedLocalProfileId,
            serverUrl: effectiveServerUrl,
          }));
          shouldAutoStartServer =
            !runtimeAttachOnly &&
            isLoopback &&
            store.settings.autoStartServer &&
            (!store.settings.localServerStandbyEnabled || !hasSnapshot || nextLibraryUpdateDue());
        } catch {
          shouldAutoStartServer = false;
        }

      if (store.settings.flareSolverrLocalAutoStart) {
        invoke("start_flaresolverr_local").catch(() => {});
      }

      if (shouldAutoStartServer) {
        invoke<void>("spawn_server", {
          binary: store.settings.serverBinary,
          serverUrl: effectiveServerUrl,
        }).catch((err: any) => {
          if (err?.kind === "NotConfigured") {
            notConfigured = true;
            startupFailureTitle = `Server not configured for ${activeProfileLabel()} profile`;
            startupFailureDetail = "Set up a local Suwayomi server before booting this profile.";
          } else if (err?.kind === "AttachOnlyTarget") {
            console.info("Attach-only target skipped local server spawn.");
          } else {
            startupFailureTitle = `Could not start ${activeProfileLabel()} profile`;
            startupFailureDetail = err?.message ?? "The selected profile did not complete a healthy local boot.";
            console.warn("Could not start server:", err);
          }
        });
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
      document.removeEventListener("visibilitychange", handleVisibilityChange);
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
      delete (globalThis as typeof globalThis & { __AETHON_DIAGNOSTICS__?: unknown }).__AETHON_DIAGNOSTICS__;
    };
  });

  $effect(() => {
    updateRuntimeDiagnosticsBridge();
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
    const title = `Aethon [${target.title}]`;
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
    if (!shellReady || isNovelRuntimeHostWindow) return;
    if (store.navPage !== "home" && store.navPage !== "library") return;
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
    void preloadLibrarySnapshot();
  });

  $effect(() => {
    if (!shellReady) return;
    if (store.navPage !== "home") return;
  });

  $effect(() => {
    document.documentElement.dataset.aethonMotion = uiMotionActive ? "active" : "idle";
    document.body.dataset.aethonMotion = uiMotionActive ? "active" : "idle";
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
      initRpc();
    } else {
      clearReading();
      destroyRpc();
    }
  });

  $effect(() => {
    if (!store.activeChapter) {
      if (store.settings.discordRpc) setIdle();
    }
  });

  function handleZoomKey(e: KeyboardEvent) {
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

  $effect(() => {
    window.addEventListener("keydown", handleZoomKey);
    return () => window.removeEventListener("keydown", handleZoomKey);
  });

  function handleRetry() {
    failed        = false;
    notConfigured = false;
    serverProbeOk = false;
    shellReady    = false;
    startupLandingApplied = false;
    startupSplashVisible = true;
    setStartupStatusCopy();
    startProbe();
  }

  function handleBypass() {
    cancelProbe   = true;
    serverProbeOk = true;
    shellReady    = true;
    startupSplashVisible = false;
  }

  $effect(() => {
    if (isNovelRuntimeHostWindow || bootReadyNotified || !shellReady) {
      return;
    }

    bootReadyNotified = true;
    if (!failed && !notConfigured) {
      startupSplashVisible = false;
    }
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent("aethon:boot-ready"));
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
    <div id="app-shell" class="root aethon-app-shell" class:aethon-motion-idle={!uiMotionActive}>
      {#if showIdleSplash}
        <SplashScreen mode="idle" showCards={store.settings.splashCards ?? true}
          onDismiss={() => { idle = false; resetIdle(); }} />
      {/if}
      <div class="content">
        {#if activeReaderChapter}
          {#key readerRenderKey}
            <ReaderPage />
          {/key}
        {:else if store.activeBookReaderId}
          {#if BookReaderComponent}
            {@const BookReaderView = BookReaderComponent}
            <BookReaderView />
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">Loading book...</div>
          {/if}
        {:else if store.activeNovelReader}
          {#if NovelReaderComponent}
            {@const NovelReaderView = NovelReaderComponent}
            <NovelReaderView />
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">Loading novel...</div>
          {/if}
        {:else if store.activeNovelDetail}
          {#if NovelDetailComponent}
            {@const NovelDetailView = NovelDetailComponent}
            <NovelDetailView />
          {:else}
            <div class="page-loading" aria-busy="true" aria-live="polite">Loading details...</div>
          {/if}
        {:else if store.navPage === "settings" || store.navPage === "home" || store.navPage === "library" || store.navPage === "search" || store.navPage === "downloads"}
          <Layout
            onOpenThemeEditor={openThemeEditor}
            {backupAuditPlan}
            {backupRestoreLaunchIntent}
          />
        {:else}
          <Layout
            onOpenThemeEditor={openThemeEditor}
            {backupAuditPlan}
            {backupRestoreLaunchIntent}
          />
        {/if}
      </div>
      <div class="aethon-search-dim-layer" aria-hidden="true"></div>
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
      <Toaster />
    </div>

  {#if devSplash}
    <SplashScreen mode="idle" showFps showCards={store.settings.splashCards ?? true}
      onDismiss={() => setTimeout(() => devSplash = false, 340)} />
  {:else if startupSplashVisible}
    <SplashScreen mode="loading" interactive={!shellReady} ringFull={serverProbeOk} {failed} {notConfigured}
      failureTitle={startupFailureTitle}
      failureDetail={startupFailureDetail}
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
    color: var(--n-text-muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  :global([data-aethon-motion="idle"] .aethon-app-shell .aethon-search-dim-layer) {
    opacity: 0 !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }

  :global([data-aethon-motion="idle"] .aethon-app-shell .settings-theme-preview__tile),
  :global([data-aethon-motion="idle"] .aethon-app-shell .settings-theme-preview__glow),
  :global([data-aethon-motion="idle"] .aethon-app-shell .anim-branch) {
    animation-play-state: paused !important;
  }

  :global([data-aethon-motion="idle"] .aethon-app-shell *:not(.anim-spin)) {
    animation-play-state: paused !important;
  }

  :global([data-aethon-motion="idle"] .aethon-app-shell .settings-theme-preview__glow) {
    filter: none !important;
  }
</style>
