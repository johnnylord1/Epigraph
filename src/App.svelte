<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { gql, gqlUpload } from "./lib/client";
  import { getServerTargetInfo } from "./lib/serverTarget";
  import {
    DEFAULT_LOCAL_PROFILE_ID,
    type LocalProfileId,
    normalizeLocalProfileId,
    normalizeServerUrl,
    resolveSessionProfile,
    type LaunchTargetProfileOverrides,
  } from "./lib/localProfiles";
  import {
    GET_CHAPTERS,
    GET_DOWNLOAD_STATUS,
    GET_LIBRARY,
    GET_RESTORE_STATUS,
    GET_EXTENSIONS,
    GET_SETTINGS,
    GET_SOURCES,
    GET_TRACKERS,
    RESTORE_BACKUP,
    UPDATE_EXTENSION,
  } from "./lib/queries";
  import {
    store,
    addToast,
    openBookReader,
    replaceBooksState,
    setActiveDownloads,
    setActiveBookId,
    setLibrarySection,
    setRuntimeSettingsTab,
    setSettingsOpen,
    DEFAULT_HUD_THEME_TOKENS,
    THEME_MOTION_VARS,
  } from "./store/state.svelte";
  import { readFileAsArrayBuffer } from "./lib/books/storage";
  import { buildAethonRestorePlan, type AethonRestorePlan, type AethonRestorePlannerRuntime } from "./lib/backup/aethonRestorePlanner";
  import type { BackupLaunchIntent } from "./lib/backup/backupRollout";
  import { restoreAethonBooksPayload } from "./lib/backup/booksBackup";
  import { extractAethonMangaPayloadFile } from "./lib/backup/mangaBackup";
  import { restoreAethonNovelsPayload, type AethonNovelRuntimeState } from "./lib/backup/novelsBackup";
  import { analyzeBackupReconciliation, overlayEntryFromAnalysis } from "./lib/reconciliation/analyze";
  import { readOverlayFile, upsertOverlayEntry } from "./lib/reconciliation/overlay";
  import { buildRestoreReadiness } from "./lib/reconciliation/readiness";
  import { buildReconciledBackupFile } from "./lib/reconciliation/restore";
  import { loadSourceInventory } from "./lib/reconciliation/sourceInventory";
  import { initRpc, setIdle, clearReading, destroyRpc } from "./lib/discord";
  import type { Chapter, DownloadStatus, DownloadQueueItem, Extension, Manga, Source, Tracker } from "./lib/types";
  import { traceMediaAudit } from "./lib/mediaAudit";
  import Layout       from "./components/layout/Layout.svelte";
  import Reader       from "./components/reader/Reader.svelte";
  import BookReader   from "./components/reader/BookReader.svelte";
  import Settings     from "./components/settings/Settings.svelte";
  import ThemeEditor  from "./components/settings/ThemeEditor.svelte";
  import TitleBar     from "./components/layout/TitleBar.svelte";
  import Toaster      from "./components/layout/Toaster.svelte";
  import SplashScreen from "./components/layout/SplashScreen.svelte";
  import MangaPreview from "./components/shared/MangaPreview.svelte";

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

  function openThemeEditor(id?: string | null) {
    themeEditorEditId = id ?? null;
    themeEditorOpen   = true;
  }

  function closeThemeEditor() {
    themeEditorOpen   = false;
    themeEditorEditId = null;
  }

  const MAX_ATTEMPTS = 10;
  const win = getCurrentWindow();

  let serverProbeOk = $state(false);
  let shellReady    = $state(false);
  let startupSplashVisible = $state(true);
  let failed        = $state(false);
  let notConfigured = $state(false);
  let startupFailureTitle = $state("Could not reach server");
  let startupFailureDetail = $state("Aethon couldn't reach the selected local profile.");
  let startupStatusText = $state("Initializing profile");
  let idle          = $state(false);
  let devSplash     = $state(false);

  let platformScale = $state(1.0);
  let _appliedZoom = -1;
  let _vhRafId: number | null = null;

  function applyZoom() {
    const uiZoom = store.settings.uiZoom ?? 1.0;
    if (uiZoom === _appliedZoom) return;
    _appliedZoom = uiZoom;

    const pct = uiZoom * 100;
    document.documentElement.style.setProperty("--ui-zoom", String(uiZoom));
    document.documentElement.style.setProperty("--ui-scale", String(uiZoom));
    document.documentElement.style.zoom = `${pct}%`;

    if (_vhRafId !== null) cancelAnimationFrame(_vhRafId);
    _vhRafId = requestAnimationFrame(() => {
      _vhRafId = null;
      document.documentElement.style.setProperty("--visual-vh", `${window.innerHeight / uiZoom}px`);
    });
  }

  let prevQueue: DownloadQueueItem[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let pollInterval: ReturnType<typeof setInterval>;
  let unlistenDownload: (() => void) | undefined;

  type AethonAuditBridge = {
    showSplash: () => void;
    hideSplash: () => void;
    toggleSplash: () => void;
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
    };
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

  async function openAuditFirstBookReader(bookId?: string | null) {
    const book = await resolveAuditFirstBook(bookId);
    if (!book) return;
    setActiveBookId(book.id);
    openBookReader(book.id);
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
      openSettings: openAuditSettings,
      closeSettings: closeAuditSettings,
      openLibrary: openAuditLibrary,
      openBooksLibrary: openAuditBooksLibrary,
      openFirstManga: openAuditFirstManga,
      openFirstReader: openAuditFirstReader,
      openFirstBook: openAuditFirstBook,
      openFirstBookReader: openAuditFirstBookReader,
      getState: getAuditState,
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

    if (key === "k") {
      event.preventDefault();
      event.stopPropagation();
      void openAuditFirstBookReader();
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

  function applyQueue(next: DownloadQueueItem[]) {
    detectCompletions(prevQueue, next);
    prevQueue = next;
    setActiveDownloads(next.map(item => ({
      chapterId: item.chapter.id, mangaId: item.chapter.mangaId, progress: item.progress, state: item.state,
    })));
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    if (idle) return;
    const ms = (store.settings.idleTimeoutMin ?? 5) * 60 * 1000;
    if (ms === 0) return;
    idleTimer = setTimeout(() => idle = true, ms);
  }

  const idleEvents = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"] as const;

  $effect(() => {
    if (!shellReady) return;
    idleEvents.forEach(e => window.addEventListener(e, resetIdle, { passive: true }));
    resetIdle();
    return () => idleEvents.forEach(e => window.removeEventListener(e, resetIdle));
  });

  $effect(() => {
    void store.settings.uiZoom;
    applyZoom();
  });

  $effect(() => {
    if (!shellReady) return;
    const poll = () => gql<{ downloadStatus: DownloadStatus }>(GET_DOWNLOAD_STATUS)
      .then(d => applyQueue(d.downloadStatus.queue)).catch(console.error);
    poll();
    pollInterval = setInterval(poll, 2000);
    return () => clearInterval(pollInterval);
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
    pendingRestoreSourceProfileId = normalizeLocalProfileId(launchTarget?.restoreSourceProfileOverride);
    runtimeAttachOnly = Boolean(launchTarget?.attachOnlyOverride);
    (window as AethonAuditWindow).__aethonMediaAudit = Boolean(launchTarget?.auditOpenOverride);

    const resolved = resolveSessionProfile(
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

    if (!resolved.isOverrideSession && normalizeLocalProfileId(store.settings.defaultLocalProfileId) == null) {
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
    const primary = normalizeServerUrl(
      store.runtimeResolvedLocalProfileMeta?.serverUrl
      ?? store.runtimeServerUrl
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
          archivePath: issue.archivePath ?? null,
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

  function mangaRestoreBlockedMessage(readiness: ReturnType<typeof buildRestoreReadiness>): string {
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
    const [settingsData, extensionsData, sourcesData] = await Promise.all([
      gql<{ settings: { extensionRepos: string[] } }>(GET_SETTINGS),
      gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS),
      gql<{ sources: { nodes: Source[] } }>(GET_SOURCES),
    ]);

    return {
      repositoryUrls: settingsData.settings.extensionRepos ?? [],
      installedPluginIds: (extensionsData.extensions.nodes ?? [])
        .filter((extension) => extension.isInstalled)
        .map((extension) => extension.pkgName),
      availableSourceIds: (sourcesData.sources.nodes ?? [])
        .map((source) => source.id)
        .filter((sourceId) => sourceId !== "0"),
    };
  }

  async function loadRestorePlannerRuntime(): Promise<AethonRestorePlannerRuntime> {
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
          ? "warning"
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
        ? "warning"
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

  function startProbe() {
    cancelProbe = false;
    failed      = false;
    setStartupStatusCopy();
    let tries   = 0;

    async function probe() {
      if (cancelProbe) return;
      tries++;
      const s = store.settings;
      const auth: Record<string, string> = s.serverAuthEnabled && s.serverAuthUser && s.serverAuthPass
        ? { Authorization: `Basic ${btoa(`${s.serverAuthUser.trim()}:${s.serverAuthPass.trim()}`)}` }
        : {};

      for (const base of getProbeBases()) {
        try {
          const res = await fetch(`${base}/api/graphql`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ query: "{ __typename }" }),
            signal: AbortSignal.timeout(2000),
          });
          if (res.ok && !cancelProbe) {
            failed = false;
            serverProbeOk = true;
            shellReady = true;
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
        setTimeout(probe, 2000);
        return;
      }
      if (!cancelProbe) setTimeout(probe, 750);
    }

    setTimeout(probe, 800);
  }

  onMount(async () => {
    document.addEventListener("contextmenu", e => e.preventDefault());
    const launchTarget = await invoke<LaunchTargetInfo>("get_launch_target").catch(() => null);
    applyLaunchTarget(launchTarget);

    const initialTarget = getServerTargetInfo();
    document.title = `Aethon [${initialTarget.title}]`;
    await win.setTitle(`Aethon [${initialTarget.title}]`).catch(() => {});
    installAuditBridge();
    window.addEventListener("keydown", handleAuditShortcut, true);

    platformScale = await invoke<number>("get_platform_ui_scale").catch(() => 1.0);
    applyZoom();

    store.isFullscreen = await win.isFullscreen();

    const unlistenResize = await win.onResized(async () => {
      store.isFullscreen = await win.isFullscreen();
    });

    const unlistenScale = await win.onScaleChanged(async (event) => {
      platformScale = event.payload.scaleFactor;
      applyZoom();
    });

    const effectiveServerUrl = normalizeServerUrl(store.runtimeServerUrl ?? store.settings.serverUrl)
      ?? store.runtimeResolvedLocalProfileMeta?.serverUrl
      ?? "http://127.0.0.1:4667";
    let shouldAutoStartServer = false;
    try {
      const parsed = new URL(effectiveServerUrl);
      const host = parsed.hostname.toLowerCase();
      const isLoopback = host === "127.0.0.1" || host === "localhost";
      shouldAutoStartServer = store.settings.autoStartServer && isLoopback && !runtimeAttachOnly;
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

    startProbe();

    type P = { chapterId: number; mangaId: number; progress: number }[];
    unlistenDownload = await listen<P>("download-progress", e => { setActiveDownloads(e.payload); });

    return () => {
      cancelProbe = true;
      unlistenResize();
      unlistenScale();
      destroyRpc();
      if (idleTimer) clearTimeout(idleTimer);
      if (pollInterval) clearInterval(pollInterval);
      unlistenDownload?.();
      window.removeEventListener("keydown", handleAuditShortcut, true);
      uninstallAuditBridge();
    };
  });

  $effect(() => {
    const target = getServerTargetInfo();
    const title = `Aethon [${target.title}]`;
    document.title = title;
    void win.setTitle(title).catch(() => {});
  });

  $effect(() => {
    if (!shellReady) return;
    const timer = setTimeout(checkForUpdateSilently, 5_000);
    return () => clearTimeout(timer);
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
</script>

{#if shellReady}
  <div id="app-shell" class="root">
    {#if idle && !store.activeChapter && !store.activeBookReaderId}
      <SplashScreen mode="idle" showCards={store.settings.splashCards ?? true}
        onDismiss={() => { idle = false; resetIdle(); }} />
    {/if}
    {#if !store.activeChapter && !store.activeBookReaderId}<TitleBar />{/if}
    <div class="content">
      {#if store.activeChapter}<Reader />{:else if store.activeBookReaderId}<BookReader />{:else}<Layout />{/if}
    </div>
    {#if store.settingsOpen}<Settings onOpenThemeEditor={openThemeEditor} backupAuditPlan={backupAuditPlan} backupRestoreLaunchIntent={backupRestoreLaunchIntent} />{/if}
    {#if themeEditorOpen}
      <ThemeEditor
        bind:editingId={themeEditorEditId}
        onClose={closeThemeEditor}
      />
    {/if}
    <MangaPreview />
    <Toaster />
  </div>
{/if}

{#if devSplash}
  <SplashScreen mode="idle" showFps showCards={store.settings.splashCards ?? true}
    onDismiss={() => setTimeout(() => devSplash = false, 340)} />
{:else if startupSplashVisible}
  <SplashScreen mode="loading" ringFull={serverProbeOk} {failed} {notConfigured}
    failureTitle={startupFailureTitle}
    failureDetail={startupFailureDetail}
    statusText={startupStatusText}
    showCards={store.settings.splashCards ?? true}
    onReady={() => startupSplashVisible = false}
    onRetry={handleRetry}
    onBypass={handleBypass} />
{/if}

<style>
  .root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .content { flex: 1; overflow: hidden; }
</style>
