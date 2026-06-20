<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { BookmarkSimple, Download, CheckCircle, Circle, ArrowSquareOut, CircleNotch, Play, SortAscending, SortDescending, CaretDown, ArrowsClockwise, ArrowsLeftRight, List, SquaresFour, FolderSimplePlus, Trash, DownloadSimple, X, LinkSimpleHorizontalBreak, ChartLineUp } from "phosphor-svelte";
  import { gql } from "../../lib/client";
  import { GET_MANGA, GET_CHAPTERS, FETCH_CHAPTERS, ENQUEUE_DOWNLOAD, UPDATE_MANGA, MARK_CHAPTER_READ, MARK_CHAPTERS_READ, DELETE_DOWNLOADED_CHAPTERS, ENQUEUE_CHAPTERS_DOWNLOAD, GET_ALL_MANGA, GET_CATEGORIES, CREATE_CATEGORY, UPDATE_MANGA_CATEGORIES, GET_DOWNLOAD_STATUS, START_DOWNLOADER } from "../../lib/queries";
  import { cache, CACHE_KEYS, recordSourceAccess } from "../../lib/cache";
  import { getCategoryDisplayName, isCompletedCategory, normalizeCategories } from "../../lib/library/categories";
  import { dedupeMangaById, dedupeMangaByTitle } from "../../lib/util";
  import { buildReaderChapterList, effectiveScanlator, listScanlators, normalizeMangaReaderPreference, resolveReaderChapterTarget } from "../../lib/reader/scanlator";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { store, addToast, updateSettings, openReader, setActiveManga, setSettingsOpen, openSearchBrowseFeatured, linkManga, unlinkManga, checkAndMarkCompleted as storeCheckAndMarkCompleted, syncLibraryMangaFromDetail } from "../../store/state.svelte";
  import type { Manga, Chapter, Category, DownloadStatus } from "../../lib/types";
  import ContextMenu from "../shared/ContextMenu.svelte";
  import MigrateModal from "./MigrateModal.svelte";
  import NocturneState from "../shared/NocturneState.svelte";
  import TrackingPanel from "../shared/TrackingPanel.svelte";
  import SeriesDetailV3Shell from "../shared/SeriesDetailV3Shell.svelte";
  import { isSourceChallengeMessage, sourceAccessErrorMessage } from "../../lib/sourceAccess";

  type MenuEntry = any;

  const CHAPTERS_PER_PAGE = 25;
  const MANGA_TTL_MS      = 5 * 60 * 1000;
  const CHAPTER_TTL_MS    = 2 * 60 * 1000;
  const DOWNLOAD_POLL_ATTEMPTS = 10;
  const DOWNLOAD_POLL_MS = 800;

  const mangaStore:   Map<number, { data: Manga;     fetchedAt: number }> = new Map();
  const chapterStore: Map<number, { data: Chapter[]; fetchedAt: number }> = new Map();

  let manga:           Manga | null     = $state(null);
  let chapters:        Chapter[]        = $state([]);
  let loadingManga:    boolean          = $state(false);
  let loadingChapters: boolean          = $state(true);
  let enqueueing:      Set<number>      = $state(new Set());
  let downloadQueueItems: DownloadStatus["queue"] = $state([]);
  let downloadStatusPoll: ReturnType<typeof setTimeout> | null = null;
  let downloadStatusRefreshInFlight = false;
  let dlOpen:          boolean          = $state(false);
  let detailsOpen:     boolean          = $state(false);
  let togglingLibrary: boolean          = $state(false);
  let chapterPage:     number           = $state(1);
  let ctx: { x: number; y: number; chapter: Chapter; idx: number } | null = $state(null);
  let jumpOpen:        boolean          = $state(false);
  let jumpInput:       string           = $state("");
  let viewMode: "list" | "grid"         = $state("list");
  let deletingAll:     boolean          = $state(false);
  let refreshing:      boolean          = $state(false);
  let downloadErroredAt: number         = $state(0);
  let genresExpanded:  boolean          = $state(false);
  let folderPickerOpen: boolean         = $state(false);
  let folderCreating:  boolean          = $state(false);
  let folderNewName:   string           = $state("");
  let mangaCategories: Category[]       = $state([]);
  let allCategories:   Category[]       = $state([]);
  let catsLoading:     boolean          = $state(false);
  let rangeFrom:       string           = $state("");
  let rangeTo:         string           = $state("");
  let showRange:       boolean          = $state(false);
  let migrateOpen:     boolean          = $state(false);
  let dlDropRef:       HTMLDivElement | undefined = $state();
  let folderPickerRef: HTMLDivElement | undefined = $state();
  // Series link
  let linkPickerOpen:   boolean   = $state(false);
  let linkSearch:       string    = $state("");
  let allMangaForLink:  Manga[]   = $state([]);
  let loadingLinkList:  boolean   = $state(false);

  // Tracking modal
  let trackingOpen: boolean = $state(false);

  // Multi-select
  let selectedIds: Set<number> = $state(new Set());
  const hasSelection = $derived(selectedIds.size > 0);

  function toggleSelect(id: number, e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedIds = next;
  }

  function clearSelection() { selectedIds = new Set(); }

  async function deleteSelected() {
    const ids = [...selectedIds].filter(id => chapters.find(c => c.id === id)?.isDownloaded);
    if (ids.length) {
      await gql(DELETE_DOWNLOADED_CHAPTERS, { ids }).catch(console.error);
      chapters = chapters.map(c => ids.includes(c.id) ? { ...c, isDownloaded: false } : c);
      if (store.activeManga) chapterStore.set(store.activeManga.id, { data: chapters, fetchedAt: Date.now() });
    }
    clearSelection();
  }

  async function downloadSelected() {
    const ids = [...selectedIds].filter(id => !chapters.find(c => c.id === id)?.isDownloaded);
    await enqueueMultiple(ids);
    clearSelection();
  }

  async function markSelectedRead(isRead: boolean) {
    await markBulk([...selectedIds], isRead);
    clearSelection();
  }

  let mangaAbort:  AbortController | null = null;
  let chapterAbort: AbortController | null = null;
  let loadingFor:  number | null = null;
  let loadedMangaId: number | null = $state(null);

  function formatDate(ts: string | null | undefined): string {
    if (!ts) return "";
    const n = Number(ts);
    const d = new Date(n > 1e10 ? n : n * 1000);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  function mangaChapterNumberLabel(chapter: Chapter): string {
    const value = Number.isFinite(chapter.chapterNumber) && chapter.chapterNumber > 0
      ? chapter.chapterNumber
      : chapter.sourceOrder;
    return `Chapter ${value}`;
  }

  function mangaChapterTitle(chapter: Chapter): string {
    return chapter.name?.trim() || mangaChapterNumberLabel(chapter);
  }

  function mangaChapterHasDistinctTitle(chapter: Chapter): boolean {
    return mangaChapterTitle(chapter).trim().toLowerCase() !== mangaChapterNumberLabel(chapter).toLowerCase();
  }

  function mangaChapterPrimaryLabel(chapter: Chapter): string {
    return mangaChapterHasDistinctTitle(chapter) ? mangaChapterNumberLabel(chapter) : mangaChapterTitle(chapter);
  }

  function mangaChapterSecondaryLabel(chapter: Chapter): string {
    return mangaChapterHasDistinctTitle(chapter) ? mangaChapterTitle(chapter) : "";
  }

  function updateScanlatorPrefs(next: Partial<{ preferredScanlator: string; scanlatorFilter: string[] }>) {
    const mangaId = store.activeManga?.id;
    if (!mangaId) return;

    const current = normalizeMangaReaderPreference(store.settings.mangaReaderPrefs[String(mangaId)]);
    updateSettings({
      mangaReaderPrefs: {
        ...store.settings.mangaReaderPrefs,
        [String(mangaId)]: normalizeMangaReaderPreference({
          ...current,
          ...next,
        }),
      },
    });
    chapterPage = 1;
    clearSelection();
  }

  function toggleScanlatorFilter(name: string) {
    const current = new Set(mangaReaderPrefs.scanlatorFilter);
    if (current.has(name)) {
      current.delete(name);
    } else {
      current.add(name);
    }
    updateScanlatorPrefs({ scanlatorFilter: [...current] });
  }

  function openChapterReader(chapter: Chapter) {
    const target = resolveReaderChapterTarget(chapter, chaptersAsc);
    if (target) {
      openReader(target, chaptersAsc);
      return;
    }

    const fallbackChapters = [...chapters].sort((left, right) => left.sourceOrder - right.sourceOrder);
    const fallbackTarget = resolveReaderChapterTarget(chapter, fallbackChapters);
    if (!fallbackTarget) return;
    openReader(fallbackTarget, fallbackChapters);
  }

  function applyChapters(nodes: Chapter[]) {
    chapters = nodes;
    const currentManga = manga ?? store.activeManga;
    if (currentManga && nodes.length > 0) syncLibraryMangaFromDetail(currentManga, nodes);
    if (store.activeManga && nodes.length > 0) checkAndMarkCompleted(store.activeManga.id, nodes);
  }

  function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function setEnqueueing(ids: number[], enabled: boolean) {
    const next = new Set(enqueueing);
    for (const id of ids) {
      if (enabled) next.add(id);
      else next.delete(id);
    }
    enqueueing = next;
  }

  function downloadErrorBody(error?: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!message) return store.settings.flareSolverrEnabled ? "Check the source and retry." : "This source may need FlareSolverr.";
    const cloudflare = /cloudflare|challenge|flaresolverr/i.test(message);
    if (cloudflare) return store.settings.flareSolverrEnabled ? "Check FlareSolverr and retry." : "This source needs FlareSolverr.";
    if (/http|network|fetch/i.test(message)) return "Could not reach Suwayomi.";
    return "Check the source and retry.";
  }

  function showDownloadFailure(error?: unknown) {
    const body = downloadErrorBody(error);
    const needsFlareSolverr = /FlareSolverr/i.test(body);
    addToast({
      kind: "error",
      title: "Download failed",
      body,
      duration: needsFlareSolverr ? 6000 : undefined,
      action: needsFlareSolverr ? { label: "Open settings", run: () => setSettingsOpen(true) } : undefined,
    });
  }

  function queuedLabel(count: number, fallback?: string) {
    if (count === 1) return fallback ?? "1 chapter";
    return `${count} chapters`;
  }

  function shouldKeepDownloadQueueWarm() {
    return dlOpen || enqueueing.size > 0 || downloadQueueItems.length > 0 || activeSeriesDownloadCount > 0;
  }

  function clearDownloadQueuePoll() {
    if (downloadStatusPoll) {
      clearTimeout(downloadStatusPoll);
      downloadStatusPoll = null;
    }
  }

  function scheduleDownloadQueueRefresh(delayMs = shouldKeepDownloadQueueWarm() ? 1800 : 15000) {
    clearDownloadQueuePoll();
    downloadStatusPoll = setTimeout(() => {
      void refreshDownloadQueue({ reschedule: true });
    }, delayMs);
  }

  async function refreshDownloadQueue(options: { reschedule?: boolean } = {}) {
    if (downloadStatusRefreshInFlight) return;
    downloadStatusRefreshInFlight = true;
    try {
      const status = await gql<{ downloadStatus: DownloadStatus }>(GET_DOWNLOAD_STATUS).catch(() => null);
      if (status) downloadQueueItems = status.downloadStatus.queue ?? [];
    } finally {
      downloadStatusRefreshInFlight = false;
      if (options.reschedule) scheduleDownloadQueueRefresh();
    }
  }

  async function waitForDownloadFailure(chapterIds: number[]) {
    const watched = new Set(chapterIds);
    for (let attempt = 0; attempt < DOWNLOAD_POLL_ATTEMPTS; attempt += 1) {
      await sleep(DOWNLOAD_POLL_MS);
      const status = await gql<{ downloadStatus: DownloadStatus }>(GET_DOWNLOAD_STATUS).catch(() => null);
      const queue = status?.downloadStatus.queue ?? [];
      downloadQueueItems = queue;
      const watchedItems = queue.filter(item => watched.has(item.chapter.id));
      if (watchedItems.some(item => item.state === "ERROR")) return true;
      if (watchedItems.length === 0) return false;
    }
    return false;
  }

  async function enqueueChapterIds(chapterIds: number[], label?: string) {
    const ids = [...new Set(chapterIds)].filter(id => !chapters.find(c => c.id === id)?.isDownloaded);
    if (!ids.length) return false;

    setEnqueueing(ids, true);
    try {
      if (ids.length === 1) await gql(ENQUEUE_DOWNLOAD, { chapterId: ids[0] });
      else await gql(ENQUEUE_CHAPTERS_DOWNLOAD, { chapterIds: ids });

      await gql(START_DOWNLOADER);
      void refreshDownloadQueue();
      scheduleDownloadQueueRefresh(800);
      addToast({ kind: "download", title: "Download started", body: queuedLabel(ids.length, label) });

      const failed = await waitForDownloadFailure(ids);
      if (failed) {
        downloadErroredAt = Date.now();
        showDownloadFailure();
      }
      return !failed;
    } catch (error) {
      downloadErroredAt = Date.now();
      showDownloadFailure(error);
      return false;
    } finally {
      setEnqueueing(ids, false);
      if (store.activeManga) reloadChapters(store.activeManga.id);
    }
  }

  const sortDir        = $derived(store.settings.chapterSortDir);
  const sortMode       = $derived(store.settings.chapterSortMode ?? "source");
  const sortModeLabels = {
    source: "Source order",
    chapterNumber: "Ch. number",
    uploadDate: "Upload date",
  } as const;
  let sortMenuOpen     = $state(false);
  let scanlatorMenuOpen = $state(false);

  const sourceScanlatorFallback = $derived(manga?.source?.displayName ?? store.activeManga?.source?.displayName ?? "");
  const scanlatorOptions = $derived(listScanlators(chapters, sourceScanlatorFallback));
  const mangaReaderPrefs = $derived.by(() => {
    const activeMangaId = store.activeManga?.id;
    if (!activeMangaId) return normalizeMangaReaderPreference(null);
    return normalizeMangaReaderPreference(store.settings.mangaReaderPrefs[String(activeMangaId)]);
  });
  const hasScanlatorPreference = $derived(
    mangaReaderPrefs.scanlatorFilter.length > 0 || !!mangaReaderPrefs.preferredScanlator,
  );
  const scanlatorButtonText = $derived.by(() => {
    if (mangaReaderPrefs.scanlatorFilter.length === 1) return mangaReaderPrefs.scanlatorFilter[0];
    if (mangaReaderPrefs.scanlatorFilter.length > 1) return `${mangaReaderPrefs.scanlatorFilter.length} selected`;
    if (mangaReaderPrefs.preferredScanlator) return `Prefer ${mangaReaderPrefs.preferredScanlator}`;
    return "All Scanlators";
  });
  const filteredChaptersAsc = $derived(buildReaderChapterList(chapters, mangaReaderPrefs, sourceScanlatorFallback));

  const sortedChapters = $derived.by(() => {
    const base = [...filteredChaptersAsc];
    if (sortMode === "chapterNumber") {
      base.sort((a, b) => a.chapterNumber - b.chapterNumber);
    } else if (sortMode === "uploadDate") {
      base.sort((a, b) => Number(a.uploadDate ?? 0) - Number(b.uploadDate ?? 0));
    } else {
      base.sort((a, b) => a.sourceOrder - b.sourceOrder);
    }
    return sortDir === "desc" ? base.reverse() : base;
  });

  /**
   * Chapter list in canonical reading order (ch1 -> ch2 -> ch3).
   * Always passed to openReader so the Reader's idx-based prev/next
   * navigation is direction-independent of the user's display sort.
   */
  const chaptersAsc = $derived(filteredChaptersAsc);
  const totalPages     = $derived(Math.ceil(sortedChapters.length / CHAPTERS_PER_PAGE));
  const pageChapters   = $derived(sortedChapters.slice((chapterPage - 1) * CHAPTERS_PER_PAGE, chapterPage * CHAPTERS_PER_PAGE));

  function countValue(value: number | null | undefined): number {
    return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
  }

  function optionalCountValue(value: number | null | undefined): number | null {
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
  }

  const summaryChapterCount = $derived(countValue(manga?.chapterCount ?? store.activeManga?.chapterCount));
  const summaryUnreadCount = $derived(optionalCountValue(manga?.unreadCount ?? store.activeManga?.unreadCount));
  const summaryDownloadedCount = $derived(countValue(manga?.downloadCount ?? store.activeManga?.downloadCount));
  const totalCount     = $derived(chapters.length > 0 ? chapters.length : summaryChapterCount);
  const unreadCount    = $derived(chapters.length > 0 ? chapters.filter(c => !c.isRead).length : Math.min(summaryUnreadCount ?? totalCount, totalCount));
  const readCount      = $derived(Math.max(0, totalCount - unreadCount));
  const progressPct    = $derived(totalCount > 0 ? (readCount / totalCount) * 100 : 0);
  const downloadedCount = $derived(chapters.length > 0 ? chapters.filter(c => c.isDownloaded).length : Math.min(summaryDownloadedCount, totalCount));
  const currentChapterIds = $derived(new Set(chapters.map(c => c.id)));
  const seriesDownloadItems = $derived(downloadQueueItems.filter(item => currentChapterIds.has(item.chapter.id)));
  const seriesDownloadErrorCount = $derived(seriesDownloadItems.filter(item => item.state === "ERROR").length);
  const activeSeriesDownloadIds = $derived.by(() => {
    const ids = new Set<number>();
    for (const item of seriesDownloadItems) {
      if (item.state === "QUEUED" || item.state === "DOWNLOADING") ids.add(item.chapter.id);
    }
    for (const ch of chapters) {
      if (enqueueing.has(ch.id) && !ch.isDownloaded) ids.add(ch.id);
    }
    return ids;
  });
  const activeSeriesDownloadCount = $derived(activeSeriesDownloadIds.size);
  const downloadButtonState = $derived.by(() => {
    if (activeSeriesDownloadCount > 0) return "active";
    if (seriesDownloadErrorCount > 0 || Date.now() - downloadErroredAt < 5000) return "error";
    if (downloadedCount > 0) return "downloaded";
    return "idle";
  });

  const continueChapter = $derived((() => {
    if (!chaptersAsc.length) return null;
    const asc        = chaptersAsc;
    const anyRead    = asc.some(c => c.isRead);
    const inProgress = asc.find(c => !c.isRead && (c.lastPageRead ?? 0) > 0);
    if (inProgress) return { chapter: inProgress, type: "continue" as const };
    const firstUnread = asc.find(c => !c.isRead);
    if (firstUnread) {
      const type = anyRead ? "continue" : "start";
      return { chapter: firstUnread, type };
    }
    return { chapter: asc[0], type: "reread" as const };
  })());

  const statusLabel     = $derived.by(() => {
    const current = manga;
    if (!current?.status || current.status.toUpperCase() === "UNKNOWN") return null;
    return current.status.charAt(0) + current.status.slice(1).toLowerCase();
  });
  const assignedFolders = $derived(normalizeCategories(mangaCategories).filter(c => c.id !== 0));
  const hasFolders      = $derived(assignedFolders.length > 0);

  function loadCategories(mangaId: number) {
    catsLoading = true;
    gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)
      .then(d => {
        allCategories   = normalizeCategories(d.categories.nodes.filter(c => c.id !== 0));
        mangaCategories = normalizeCategories(allCategories.filter(c => c.mangas?.nodes.some(m => m.id === mangaId)));
      })
      .catch(console.error)
      .finally(() => { catsLoading = false; });
  }

  async function checkAndMarkCompleted(mangaId: number, chaps: Chapter[]) {
    await storeCheckAndMarkCompleted(mangaId, chaps, allCategories, gql, UPDATE_MANGA_CATEGORIES, UPDATE_MANGA);
    // Sync local mangaCategories state after the mutation
    if (chaps.length) {
      const allRead   = chaps.every(c => c.isRead);
      const completed = allCategories.find(isCompletedCategory);
      if (completed) {
        const inCompleted = mangaCategories.some(c => c.id === completed.id);
        if (allRead && !inCompleted)  mangaCategories = normalizeCategories([...mangaCategories, completed]);
        else if (!allRead && inCompleted) mangaCategories = mangaCategories.filter(c => c.id !== completed.id);
      }
    }
  }

  function loadManga(id: number) {
    mangaAbort?.abort();
    const ctrl = new AbortController();
    mangaAbort = ctrl;
    loadingFor = id;
    const cached = mangaStore.get(id);
    if (cached) {
      manga = cached.data; loadingManga = false;
      if (cached.data.thumbnailUrl) store.bumpLibraryCoverCacheGeneration();
      syncLibraryMangaFromDetail(cached.data, chapters.length > 0 ? chapters : undefined);
      if (Date.now() - cached.fetchedAt < MANGA_TTL_MS) return;
      gql<{ manga: Manga }>(GET_MANGA, { id }, ctrl.signal).then(d => {
        if (ctrl.signal.aborted || loadingFor !== id) return;
        mangaStore.set(id, { data: d.manga, fetchedAt: Date.now() });
        manga = d.manga;
        if (d.manga.thumbnailUrl) store.bumpLibraryCoverCacheGeneration();
        syncLibraryMangaFromDetail(d.manga, chapters.length > 0 ? chapters : undefined);
        if (d.manga.source?.id) recordSourceAccess(d.manga.source.id);
      }).catch(() => {});
      return;
    }
    loadingManga = true;
    gql<{ manga: Manga }>(GET_MANGA, { id }, ctrl.signal).then(d => {
      if (ctrl.signal.aborted || loadingFor !== id) return;
      mangaStore.set(id, { data: d.manga, fetchedAt: Date.now() });
      manga = d.manga;
      if (d.manga.thumbnailUrl) store.bumpLibraryCoverCacheGeneration();
      syncLibraryMangaFromDetail(d.manga, chapters.length > 0 ? chapters : undefined);
      if (d.manga.source?.id) recordSourceAccess(d.manga.source.id);
    }).catch(() => {}).finally(() => { if (!ctrl.signal.aborted && loadingFor === id) loadingManga = false; });
  }

  function loadChapters(id: number) {
    chapterAbort?.abort();
    const ctrl = new AbortController();
    chapterAbort = ctrl;
    const cached = chapterStore.get(id);
    if (cached) {
      applyChapters(cached.data); loadingChapters = false;
      if (Date.now() - cached.fetchedAt < CHAPTER_TTL_MS) return;
      gql(FETCH_CHAPTERS, { mangaId: id }, ctrl.signal)
        .then(() => gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: id }, ctrl.signal))
        .then(d => {
          if (ctrl.signal.aborted || loadingFor !== id) return;
          chapterStore.set(id, { data: d.chapters.nodes, fetchedAt: Date.now() });
          applyChapters(d.chapters.nodes);
        }).catch(() => {});
      return;
    }
    chapters = []; loadingChapters = true;
    gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: id }, ctrl.signal).then(d => {
      if (ctrl.signal.aborted || loadingFor !== id) return;
      applyChapters(d.chapters.nodes); loadingChapters = false;
      return gql(FETCH_CHAPTERS, { mangaId: id }, ctrl.signal)
        .then(() => gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: id }, ctrl.signal))
        .then(fresh => {
          if (ctrl.signal.aborted || loadingFor !== id) return;
          chapterStore.set(id, { data: fresh.chapters.nodes, fetchedAt: Date.now() });
          applyChapters(fresh.chapters.nodes);
        });
    }).catch(() => { if (!ctrl.signal.aborted) loadingChapters = false; });
  }

  const activeMangaId = $derived(store.activeManga?.id ?? null);

  $effect(() => {
    const id = activeMangaId;
    if (!id) {
      loadedMangaId = null;
      return;
    }
    if (loadedMangaId === id) return;
    loadedMangaId = id;
    chapterPage = 1;
    clearSelection();
    ctx = null;
    untrack(() => { loadManga(id); loadChapters(id); loadCategories(id); });
  });

  let prevChapterId: number | null = null;
  $effect(() => {
    const wasOpen = prevChapterId !== null;
    prevChapterId = store.activeChapter?.id ?? null;
    if (wasOpen && !store.activeChapter && store.activeManga) {
      const id = store.activeManga.id;
      untrack(() => { loadChapters(id); });
    }
  });

  async function toggleLibrary() {
    if (!manga) return;
    togglingLibrary = true;
    const next = !manga.inLibrary;
    await gql(UPDATE_MANGA, { id: manga.id, inLibrary: next }).catch(console.error);
    manga = { ...manga, inLibrary: next };
    if (mangaStore.has(manga.id)) { const e = mangaStore.get(manga.id)!; mangaStore.set(manga.id, { ...e, data: manga }); }
    cache.clear(CACHE_KEYS.LIBRARY);
    togglingLibrary = false;
  }

  async function reloadChapters(id: number) {
    const d = await gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: id });
    chapterStore.set(id, { data: d.chapters.nodes, fetchedAt: Date.now() });
    applyChapters(d.chapters.nodes);
  }

  async function enqueue(ch: Chapter, e: MouseEvent) {
    e.stopPropagation();
    await enqueueChapterIds([ch.id], ch.name);
  }

  async function enqueueMultiple(chapterIds: number[]) {
    await enqueueChapterIds(chapterIds);
  }

  async function markRead(chapterId: number, isRead: boolean) {
    await gql(MARK_CHAPTER_READ, { id: chapterId, isRead }).catch(console.error);
    chapters = chapters.map(c => c.id === chapterId ? { ...c, isRead } : c);
    if (store.activeManga) {
      chapterStore.set(store.activeManga.id, { data: chapters, fetchedAt: Date.now() });
      await checkAndMarkCompleted(store.activeManga.id, chapters);
    }
  }

  async function markBulk(ids: number[], isRead: boolean) {
    if (!ids.length) return;
    await gql(MARK_CHAPTERS_READ, { ids, isRead }).catch(console.error);
    const idSet = new Set(ids);
    chapters = chapters.map(c => idSet.has(c.id) ? { ...c, isRead } : c);
    if (store.activeManga) {
      chapterStore.set(store.activeManga.id, { data: chapters, fetchedAt: Date.now() });
      await checkAndMarkCompleted(store.activeManga.id, chapters);
    }
  }

  const markAboveRead   = (i: number) => markBulk(sortedChapters.slice(0, i + 1).filter(c => !c.isRead).map(c => c.id), true);
  const markBelowRead   = (i: number) => markBulk(sortedChapters.slice(i).filter(c => !c.isRead).map(c => c.id), true);
  const markAboveUnread = (i: number) => markBulk(sortedChapters.slice(0, i + 1).filter(c => c.isRead).map(c => c.id), false);
  const markBelowUnread = (i: number) => markBulk(sortedChapters.slice(i).filter(c => c.isRead).map(c => c.id), false);

  async function deleteDownloaded(chapterId: number) {
    await gql(DELETE_DOWNLOADED_CHAPTERS, { ids: [chapterId] }).catch(console.error);
    chapters = chapters.map(c => c.id === chapterId ? { ...c, isDownloaded: false } : c);
    if (store.activeManga) chapterStore.set(store.activeManga.id, { data: chapters, fetchedAt: Date.now() });
  }

  async function deleteAllDownloads() {
    const ids = chapters.filter(c => c.isDownloaded).map(c => c.id);
    if (!ids.length) return;
    deletingAll = true;
    await gql(DELETE_DOWNLOADED_CHAPTERS, { ids }).catch(console.error);
    chapters = chapters.map(c => ({ ...c, isDownloaded: false }));
    if (store.activeManga) chapterStore.set(store.activeManga.id, { data: chapters, fetchedAt: Date.now() });
    deletingAll = false;
  }

  async function refreshChapters() {
    if (!store.activeManga || refreshing) return;
    refreshing = true;
    chapterStore.delete(store.activeManga.id);
    gql(FETCH_CHAPTERS, { mangaId: store.activeManga.id })
      .then(() => reloadChapters(store.activeManga!.id))
      .then(() => addToast({ kind: "success", title: "Chapters refreshed" }))
      .catch((error) => {
        const message = sourceAccessErrorMessage(error);
        const challenge = isSourceChallengeMessage(message);
        addToast({
          kind: "error",
          title: "Refresh failed",
          body: challenge
            ? store.settings.flareSolverrEnabled
              ? "Check FlareSolverr and retry this source."
              : "This source needs FlareSolverr for Cloudflare or anti-bot protection."
            : message,
          duration: challenge ? 7000 : undefined,
          action: challenge ? { label: "Open settings", run: () => setSettingsOpen(true) } : undefined,
        });
      })
      .finally(() => refreshing = false);
  }

  function buildCtxItems(ch: Chapter, idx: number): MenuEntry[] {
    const above = sortedChapters.slice(0, idx + 1), below = sortedChapters.slice(idx), last = sortedChapters.length - 1;
    return [
      { label: ch.isRead ? "Mark as unread" : "Mark as read", icon: ch.isRead ? Circle : CheckCircle, onClick: () => markRead(ch.id, !ch.isRead) },
      { separator: true },
      { label: "Mark above as read",   icon: CheckCircle, onClick: () => markAboveRead(idx),   disabled: above.filter(c => !c.isRead).length === 0 },
      { label: "Mark above as unread", icon: Circle,      onClick: () => markAboveUnread(idx), disabled: above.filter(c => c.isRead).length === 0 },
      { separator: true },
      { label: "Mark below as read",   icon: CheckCircle, onClick: () => markBelowRead(idx),   disabled: idx === last || below.filter(c => !c.isRead).length === 0 },
      { label: "Mark below as unread", icon: Circle,      onClick: () => markBelowUnread(idx), disabled: idx === last || below.filter(c => c.isRead).length === 0 },
      { separator: true },
      { label: ch.isDownloaded ? "Delete download" : "Download", icon: ch.isDownloaded ? Trash : Download, danger: ch.isDownloaded, onClick: () => ch.isDownloaded ? deleteDownloaded(ch.id) : enqueueChapterIds([ch.id], ch.name) },
      { separator: true },
      { label: "Download next 5 from here", icon: DownloadSimple, onClick: () => enqueueMultiple(sortedChapters.slice(idx, idx + 5).filter(c => !c.isDownloaded).map(c => c.id)) },
      { label: "Download all from here",    icon: DownloadSimple, onClick: () => enqueueMultiple(sortedChapters.slice(idx).filter(c => !c.isDownloaded).map(c => c.id)) },
    ];
  }

  function handleDlOutside(e: MouseEvent) { if (dlDropRef && !dlDropRef.contains(e.target as Node)) dlOpen = false; }
  function handleFolderOutside(e: MouseEvent) { if (folderPickerRef && !folderPickerRef.contains(e.target as Node)) { folderPickerOpen = false; folderCreating = false; folderNewName = ""; } }

  $effect(() => {
    if (dlOpen) { setTimeout(() => document.addEventListener("mousedown", handleDlOutside, true), 0); }
    else document.removeEventListener("mousedown", handleDlOutside, true);
    if (dlOpen) scheduleDownloadQueueRefresh(0);
  });
  $effect(() => {
    if (folderPickerOpen) { setTimeout(() => document.addEventListener("mousedown", handleFolderOutside, true), 0); }
    else document.removeEventListener("mousedown", handleFolderOutside, true);
  });

  function enqueueNext(n: number) {
    if (!continueChapter) return;
    const idx = sortedChapters.indexOf(continueChapter.chapter);
    if (idx < 0) return;
    enqueueMultiple(sortedChapters.slice(idx, idx + n).filter(c => !c.isDownloaded).map(c => c.id));
  }

  function enqueueRange() {
    const from = parseFloat(rangeFrom), to = parseFloat(rangeTo);
    if (isNaN(from) || isNaN(to)) return;
    const lo = Math.min(from, to), hi = Math.max(from, to);
    enqueueMultiple(sortedChapters.filter(c => c.chapterNumber >= lo && c.chapterNumber <= hi && !c.isDownloaded).map(c => c.id));
  }

  async function createCategory() {
    const name = folderNewName.trim();
    if (!name || !store.activeManga) return;
    try {
      const res = await gql<{ createCategory: { category: Category } }>(CREATE_CATEGORY, { name });
      const cat = res.createCategory.category;
      await gql(UPDATE_MANGA_CATEGORIES, { mangaId: store.activeManga.id, addTo: [cat.id], removeFrom: [] });
      allCategories   = normalizeCategories([...allCategories, cat]);
      mangaCategories = normalizeCategories([...mangaCategories, cat]);
    } catch (e) { console.error(e); }
    folderNewName = ""; folderCreating = false;
  }

  async function toggleCategory(cat: Category) {
    if (!store.activeManga) return;
    const inCat = mangaCategories.some(c => c.id === cat.id);
    try {
      await gql(UPDATE_MANGA_CATEGORIES, {
        mangaId:    store.activeManga.id,
        addTo:      inCat ? [] : [cat.id],
        removeFrom: inCat ? [cat.id] : [],
      });
      mangaCategories = normalizeCategories(
        inCat
          ? mangaCategories.filter(c => c.id !== cat.id)
          : [...mangaCategories, cat]
      );
    } catch (e) { console.error(e); }
  }

  onMount(() => {
    void refreshDownloadQueue({ reschedule: true });
    return () => {
      mangaAbort?.abort();
      chapterAbort?.abort();
      clearDownloadQueuePoll();
    };
  });

  // Series link

  const linkedIds = $derived(
    store.activeManga ? (store.settings.mangaLinks?.[store.activeManga.id] ?? []) : []
  );

  const linkPickerResults = $derived.by(() => {
    const id       = store.activeManga?.id;
    const others   = allMangaForLink.filter(m => m.id !== id);
    const q        = linkSearch.trim().toLowerCase();
    const filtered = q ? others.filter(m => m.title.toLowerCase().includes(q)) : others;
    const linked   = filtered.filter(m => linkedIds.includes(m.id));
    const rest     = filtered.filter(m => !linkedIds.includes(m.id)).slice(0, 30);
    return [...linked, ...rest];
  });

  async function openLinkPicker() {
    linkPickerOpen = true; linkSearch = "";
    if (allMangaForLink.length) return;
    loadingLinkList = true;
    gql<{ mangas: { nodes: Manga[] } }>(GET_ALL_MANGA)
      .then(d => { allMangaForLink = d.mangas.nodes; })
      .catch(console.error)
      .finally(() => { loadingLinkList = false; });
  }

  function closeLinkPicker() { linkPickerOpen = false; linkSearch = ""; }

  function handleLink(other: Manga) {
    if (!store.activeManga) return;
    if (linkedIds.includes(other.id)) unlinkManga(store.activeManga.id, other.id);
    else linkManga(store.activeManga.id, other.id);
  }
</script>

{#if store.activeManga}
  <SeriesDetailV3Shell
    mediaKind="manga"
    title={manga?.title ?? store.activeManga.title}
    subtitle={[manga?.author, manga?.artist].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" / ") || null}
    coverUrl={resolveMangaCoverUrl(store.activeManga, {
      context: "detail",
      persistence: store.activeManga.inLibrary ? "persistent" : "memory",
      cacheGeneration: store.libraryCoverCacheGeneration,
    })}
    fallbackLabel="Manga"
    statusLabel={statusLabel}
    sourceLabel={manga?.source?.displayName ?? null}
    sourceLine={(manga?.source?.displayName ?? store.activeManga.source?.displayName) ? `Manga - ${manga?.source?.displayName ?? store.activeManga.source?.displayName}` : null}
    description={manga?.description ?? null}
    tags={manga?.genre ?? []}
    loading={loadingManga}
    progressLabel={totalCount > 0 ? `${readCount} / ${totalCount} read` : null}
    progressPercent={progressPct}
    detailsOpen={detailsOpen}
    onBack={() => setActiveManga(null)}
    onTagClick={(g) => { openSearchBrowseFeatured(g); setActiveManga(null); }}
    onDetailsToggle={() => detailsOpen = !detailsOpen}
    metrics={[
      { label: "Chapters", value: String(totalCount) },
      { label: "Unread", value: String(unreadCount) },
      { label: "Downloaded", value: String(downloadedCount) },
    ]}
  >
    {#snippet topbarActions()}
      {#if manga?.realUrl}
        <a href={manga.realUrl} target="_blank" rel="noreferrer" class="series-icon" title="Open in browser">
          <ArrowSquareOut size={14} weight="light" />
        </a>
      {/if}
      <button class="series-icon" type="button" onclick={refreshChapters} disabled={refreshing} title="Refresh chapters">
        <ArrowsClockwise size={14} weight="light" class={refreshing ? "anim-spin" : ""} />
      </button>
    {/snippet}

    {#snippet primaryAction()}
      <button class="series-primary" disabled={!continueChapter} onclick={() => continueChapter && openChapterReader(continueChapter.chapter)}>
        <Play size={13} weight="fill" />
        {#if continueChapter}
          {continueChapter.type === "continue"
            ? `Continue Ch.${continueChapter.chapter.chapterNumber}${(continueChapter.chapter.lastPageRead ?? 0) > 0 ? ` p.${continueChapter.chapter.lastPageRead}` : ""}`
            : continueChapter.type === "reread" ? "Read again" : "Start reading"}
        {:else}
          No chapters
        {/if}
      </button>
    {/snippet}

    {#snippet secondaryActions()}
      <button class="series-action series-icon-action" class:active={manga?.inLibrary} onclick={toggleLibrary} disabled={togglingLibrary || loadingManga} title={manga?.inLibrary ? "In Library" : "Add to Library"} aria-label={manga?.inLibrary ? "In Library" : "Add to Library"}>
        <BookmarkSimple size={13} weight={manga?.inLibrary ? "fill" : "light"} />
      </button>
      <button class="series-action series-icon-action" onclick={() => trackingOpen = true} disabled={!store.activeManga} title="Tracking" aria-label="Tracking">
        <ChartLineUp size={13} weight="light" />
      </button>
    {/snippet}

    {#snippet utilityActions()}
      <div class="fp-wrap" bind:this={folderPickerRef}>
        <button class="series-utility" class:active={hasFolders} onclick={() => folderPickerOpen = !folderPickerOpen} title="Folders"><FolderSimplePlus size={14} weight={hasFolders ? "fill" : "light"} /> Folder</button>
        {#if folderPickerOpen}
          <div class="fp-menu">
            {#if catsLoading}
              <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Folders" title="Loading folders" />
            {:else if allCategories.length === 0 && !folderCreating}
              <NocturneState layout="compact" tone="info" icon="folder" eyebrow="Folders" title="No folders yet" body="Create a folder in Settings to organize this series." />
            {/if}
            {#each allCategories as cat}
              {@const isIn = mangaCategories.some(c => c.id === cat.id)}
              <button class="fp-item" class:fp-item-active={isIn} onclick={() => toggleCategory(cat)}><span class="fp-check">{isIn ? "On" : ""}</span>{getCategoryDisplayName(cat)}</button>
            {/each}
            <div class="fp-div"></div>
            {#if folderCreating}
              <div class="fp-create"><input class="fp-input" placeholder="Folder name..." bind:value={folderNewName} onkeydown={(e) => { if (e.key === "Enter") createCategory(); if (e.key === "Escape") { folderCreating = false; folderNewName = ""; } }} use:focusOnMount /><button class="fp-confirm" onclick={createCategory} disabled={!folderNewName.trim()}>Add</button><button class="fp-cancel" onclick={() => { folderCreating = false; folderNewName = ""; }}><X size={12} weight="light" /></button></div>
            {:else}
              <button class="fp-new" onclick={() => folderCreating = true}>+ New folder</button>
            {/if}
          </div>
        {/if}
      </div>
      <button class="series-utility" class:active={linkedIds.length > 0} onclick={openLinkPicker}>
        <LinkSimpleHorizontalBreak size={13} weight={linkedIds.length > 0 ? "fill" : "light"} />
        Link{linkedIds.length > 0 ? ` (${linkedIds.length})` : ""}
      </button>
      {#if chapters.length > 0}
        <div class="dl-wrap" bind:this={dlDropRef}>
          <button class="series-utility dl-unified-btn" class:active={dlOpen} class:dl-has-count={downloadedCount > 0} class:dl-downloading={downloadButtonState === "active"} class:dl-error={downloadButtonState === "error"} onclick={() => dlOpen = !dlOpen} title="Download options">
            {#if downloadButtonState === "active"}<CircleNotch size={13} weight="light" class="anim-spin" />{:else}<Download size={13} weight={downloadedCount > 0 ? "fill" : "light"} />{/if}
            Download
            <span class="dl-unified-count" class:dl-unified-alert={downloadButtonState === "error"} class:dl-unified-count-empty={downloadButtonState !== "error" && activeSeriesDownloadCount === 0 && downloadedCount === 0}>
              {#if downloadButtonState === "error"}!{:else if activeSeriesDownloadCount > 0}{activeSeriesDownloadCount}{:else if downloadedCount > 0}{downloadedCount}{:else}0{/if}
            </span>
          </button>
          {#if dlOpen}
            <div class="dl-dropdown">
              <div class="dl-pop-head">
                <div>
                  <span class="dl-kicker">Downloads</span>
                  <strong>{downloadedCount} / {totalCount}</strong>
                </div>
                <span class="dl-state-label">{activeSeriesDownloadCount > 0 ? `${activeSeriesDownloadCount} active` : "Ready"}</span>
              </div>
              {#if continueChapter}
                {@const contIdx = sortedChapters.indexOf(continueChapter.chapter)}
                {#if contIdx >= 0}
                  <div class="dl-section">
                    <p class="dl-section-label">From Ch.{continueChapter.chapter.chapterNumber}</p>
                    <div class="dl-next-row">
                      {#each [5, 10, 25] as n}
                        {@const avail = sortedChapters.slice(contIdx, contIdx + n).filter(c => !c.isDownloaded).length}
                        <button class="dl-next-btn" disabled={avail === 0} onclick={() => { enqueueNext(n); dlOpen = false; }}>
                          <span>Next {n}</span>
                          <span class="dl-next-sub">{avail} new</span>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/if}
              {/if}
              <div class="dl-section dl-section-compact">
                {#if !showRange}
                  <button class="dl-item dl-range-trigger" onclick={() => showRange = true}>
                    <span>Custom range</span>
                    <span class="dl-item-sub">Choose chapters</span>
                  </button>
                {:else}
                  <div class="dl-range-row">
                    <button class="dl-range-back" onclick={() => showRange = false} aria-label="Close custom range">&lt;</button>
                    <input class="dl-range-input" placeholder="From" bind:value={rangeFrom} onkeydown={(e) => e.key === "Enter" && enqueueRange()} use:focusOnMount />
                    <span class="dl-range-sep">-</span>
                    <input class="dl-range-input" placeholder="To" bind:value={rangeTo} onkeydown={(e) => e.key === "Enter" && enqueueRange()} />
                    <button class="dl-range-go" disabled={!rangeFrom.trim() || !rangeTo.trim()} onclick={enqueueRange}>Go</button>
                  </div>
                {/if}
              </div>
              <div class="dl-section dl-actions">
                <button class="dl-item" onclick={() => { enqueueMultiple(sortedChapters.filter(c => !c.isRead && !c.isDownloaded).map(c => c.id)); dlOpen = false; }}>
                  <span>Unread chapters</span>
                  <span class="dl-item-sub">{sortedChapters.filter(c => !c.isRead && !c.isDownloaded).length} remaining</span>
                </button>
                <button class="dl-item dl-item-primary" onclick={() => { enqueueMultiple(sortedChapters.filter(c => !c.isDownloaded).map(c => c.id)); dlOpen = false; }}>
                  <span>Download all</span>
                  <span class="dl-item-sub">{sortedChapters.filter(c => !c.isDownloaded).length} not downloaded</span>
                </button>
              </div>
              <div class="dl-section dl-danger-zone" class:dl-danger-zone-empty={downloadedCount === 0}>
                <button class="dl-item dl-item-danger" onclick={() => { deleteAllDownloads(); dlOpen = false; }} disabled={downloadedCount === 0 || deletingAll}>
                  <span>{deletingAll ? "Deleting..." : "Delete all downloads"}</span>
                  <span class="dl-item-sub">{downloadedCount} downloaded</span>
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
      <button class="series-utility" onclick={() => migrateOpen = true} disabled={!manga} title="Switch source" aria-label="Switch source">
        <ArrowsLeftRight size={15} weight="light" />
        Migrate
      </button>
    {/snippet}

    {#snippet detailsExtra()}
      <div class="v3-details-stack">
        {#if manga?.source}<div class="detail-row"><span class="detail-key">Source</span><span class="detail-val">{manga.source.displayName}</span></div>{/if}
        {#if manga?.status}<div class="detail-row"><span class="detail-key">Status</span><span class="detail-val">{statusLabel}</span></div>{/if}
        {#if manga?.author}<div class="detail-row"><span class="detail-key">Author</span><span class="detail-val">{manga.author}</span></div>{/if}
        {#if manga?.artist && manga.artist !== manga.author}<div class="detail-row"><span class="detail-key">Artist</span><span class="detail-val">{manga.artist}</span></div>{/if}
        {#if hasFolders}<div class="detail-row"><span class="detail-key">Folders</span><span class="detail-val">{assignedFolders.map(getCategoryDisplayName).join(", ")}</span></div>{/if}
      </div>
    {/snippet}

    {#snippet chapterControls()}
      <div class="list-header-left">
        {#if hasSelection}
          <span class="sel-count">{selectedIds.size} selected</span>
          <button class="series-select-btn" onclick={downloadSelected} title="Download selected"><Download size={13} weight="light" /></button>
          <button class="series-select-btn sel-action-danger" onclick={deleteSelected} title="Delete selected downloads"><Trash size={13} weight="light" /></button>
          <button class="series-select-btn" onclick={() => markSelectedRead(true)} title="Mark selected as read"><CheckCircle size={13} weight="light" /></button>
          <button class="series-select-btn" onclick={() => markSelectedRead(false)} title="Mark selected as unread"><Circle size={13} weight="light" /></button>
          <button class="series-select-btn" onclick={clearSelection} title="Clear selection"><X size={13} weight="light" /></button>
        {:else}
          {#if scanlatorOptions.length > 0}
            <div class="sort-wrap">
              <button class="series-toolbar-btn" class:active={hasScanlatorPreference} onclick={() => { scanlatorMenuOpen = !scanlatorMenuOpen; sortMenuOpen = false; }}>
                <BookmarkSimple size={14} weight={hasScanlatorPreference ? "fill" : "light"} />
                {scanlatorButtonText}
                <CaretDown size={10} weight="light" />
              </button>
              {#if scanlatorMenuOpen}
                <div class="sort-menu scanlator-menu" role="presentation" onmouseleave={() => scanlatorMenuOpen = false}>
                  <p class="sort-section-label">Filter</p>
                  <button class="sort-option" class:active={mangaReaderPrefs.scanlatorFilter.length === 0} onclick={() => { updateScanlatorPrefs({ scanlatorFilter: [] }); scanlatorMenuOpen = false; }}>Any scanlator</button>
                  {#each scanlatorOptions as scanlator}
                    <button class="sort-option" class:active={mangaReaderPrefs.scanlatorFilter.includes(scanlator)} onclick={() => toggleScanlatorFilter(scanlator)}>{scanlator}</button>
                  {/each}
                  <div class="sort-divider"></div>
                  <p class="sort-section-label">Prefer</p>
                  <button class="sort-option" class:active={!mangaReaderPrefs.preferredScanlator} onclick={() => { updateScanlatorPrefs({ preferredScanlator: "" }); scanlatorMenuOpen = false; }}>No preference</button>
                  {#each scanlatorOptions as scanlator}
                    <button class="sort-option" class:active={mangaReaderPrefs.preferredScanlator === scanlator} onclick={() => { updateScanlatorPrefs({ preferredScanlator: scanlator }); scanlatorMenuOpen = false; }}>{scanlator}</button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
          <div class="sort-wrap">
            <button class="series-toolbar-btn" onclick={() => { sortMenuOpen = !sortMenuOpen; scanlatorMenuOpen = false; }}>
              {#if sortDir === "desc"}<SortDescending size={14} weight="light" />{:else}<SortAscending size={14} weight="light" />{/if}
              Sort
              <CaretDown size={10} weight="light" />
            </button>
            {#if sortMenuOpen}
              <div class="sort-menu" role="presentation" onmouseleave={() => sortMenuOpen = false}>
                {#each [["source","Source order"],["chapterNumber","Chapter number"],["uploadDate","Upload date"]] as [val, label]}
                  <button class="sort-option" class:active={sortMode === val} onclick={() => { updateSettings({ chapterSortMode: val as any }); chapterPage = 1; sortMenuOpen = false; }}>{label}</button>
                {/each}
                <div class="sort-divider"></div>
                <button class="sort-option" class:active={sortDir === "desc"} onclick={() => { updateSettings({ chapterSortDir: "desc" }); chapterPage = 1; sortMenuOpen = false; }}>Descending</button>
                <button class="sort-option" class:active={sortDir === "asc"} onclick={() => { updateSettings({ chapterSortDir: "asc" }); chapterPage = 1; sortMenuOpen = false; }}>Ascending</button>
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <div class="list-header-right">
        {#if !hasSelection}
          <div class="view-segmented" aria-label="Chapter view">
            <button class="series-icon" class:active={viewMode === "list"} onclick={() => viewMode = "list"} title="List view"><List size={14} weight="light" /></button>
            <button class="series-icon" class:active={viewMode === "grid"} onclick={() => viewMode = "grid"} title="Grid view"><SquaresFour size={14} weight="light" /></button>
          </div>
        {/if}
      </div>
    {/snippet}

    {#snippet chapterList()}
      <div class={viewMode === "grid" ? "ch-grid v3-ch-grid" : "ch-list v3-ch-list"}>
        {#if loadingChapters && chapters.length === 0}
          {#if viewMode === "grid"}{#each Array(24) as _}<div class="grid-cell-skeleton skeleton"></div>{/each}{:else}{#each Array(8) as _}<div class="row-skeleton"><div class="skeleton sk-line" style="width:55%;height:12px"></div><div class="skeleton sk-line" style="width:25%;height:11px"></div></div>{/each}{/if}
        {:else if sortedChapters.length === 0}
          <NocturneState layout="compact" tone="info" icon="search" eyebrow="Chapters" title="No chapters match this filter" body="Try another scanlator or clear the current chapter filters." />
        {:else if viewMode === "grid"}
          {#each sortedChapters as ch, i}
            {@const inProgress = !ch.isRead && (ch.lastPageRead ?? 0) > 0}
            {@const gridProgress = ch.isRead ? 100 : (ch.pageCount > 0 ? Math.min(100, ((ch.lastPageRead ?? 0) / ch.pageCount) * 100) : 0)}
            <button class="grid-cell" class:read={ch.isRead} class:in-progress={inProgress} onclick={() => openChapterReader(ch)} oncontextmenu={(e) => { e.preventDefault(); ctx = { x: e.clientX, y: e.clientY, chapter: ch, idx: i }; }} title={mangaChapterTitle(ch)}>
              <span class="grid-cell-title">{mangaChapterPrimaryLabel(ch)}</span>
              {#if mangaChapterSecondaryLabel(ch)}<span class="grid-cell-sub">{mangaChapterSecondaryLabel(ch)}</span>{/if}
              <span class="chapter-progress"><span class="chapter-progress__fill" style={`width: ${gridProgress}%`}></span></span>
              {#if ch.isDownloaded}<span class="grid-cell-dl" title="Downloaded"></span>{/if}
              {#if ch.isRead}<span class="grid-cell-dot"></span>{/if}
              {#if enqueueing.has(ch.id)}<span class="grid-cell-spinner"><CircleNotch size={10} weight="light" class="anim-spin" /></span>{/if}
            </button>
          {/each}
        {:else}
          <div class="chapter-table-header">
            <span>Chapter</span>
            <span>Scanlator</span>
            <span>Date</span>
            <span>Status</span>
          </div>
          {#each pageChapters as ch}
            {@const idxInSorted = sortedChapters.indexOf(ch)}{@const isSelected = selectedIds.has(ch.id)}{@const rowProgress = ch.isRead ? 100 : (ch.pageCount > 0 ? Math.min(100, ((ch.lastPageRead ?? 0) / ch.pageCount) * 100) : 0)}
            <div role="button" tabindex="0" class="ch-row v3-ch-row" class:read={ch.isRead} class:ch-selected={isSelected} onclick={(e) => hasSelection ? toggleSelect(ch.id, e) : openChapterReader(ch)} onkeydown={(e) => e.key === "Enter" && (hasSelection ? toggleSelect(ch.id, e) : openChapterReader(ch))} oncontextmenu={(e) => { e.preventDefault(); ctx = { x: e.clientX, y: e.clientY, chapter: ch, idx: idxInSorted }; }}>
              <div class="ch-left">
                <button class="ch-check" class:ch-check-visible={hasSelection} onclick={(e) => toggleSelect(ch.id, e)} title="Select">{#if isSelected}<CheckCircle size={15} weight="fill" />{:else}<Circle size={15} weight="light" />{/if}</button>
                <span class="ch-name">{mangaChapterPrimaryLabel(ch)}</span>
                {#if mangaChapterSecondaryLabel(ch)}
                  <div class="ch-meta">
                    <span class="ch-meta-item">{mangaChapterSecondaryLabel(ch)}</span>
                  </div>
                {/if}
                {#if ch.lastPageRead && ch.lastPageRead > 0 && !ch.isRead}
                  <div class="ch-meta">
                    <span class="ch-meta-item">Page {ch.lastPageRead}</span>
                  </div>
                {/if}
                <div class="chapter-progress"><div class="chapter-progress__fill" style={`width: ${rowProgress}%`}></div></div>
              </div>
              <span class="ch-provider">{effectiveScanlator(ch, sourceScanlatorFallback)}</span>
              <span class="ch-date">{ch.uploadDate ? formatDate(ch.uploadDate) : ""}</span>
              <div class="ch-status" class:ch-status-downloaded-row={ch.isDownloaded} class:ch-status-read-row={ch.isRead}>
                <span class="ch-status-read">{#if ch.isRead}<CheckCircle size={14} weight="fill" class="read-icon" />{/if}</span>
                <span class="ch-status-main">
                  {#if ch.isDownloaded}
                    <Download size={13} weight="fill" title="Downloaded" />
                  {:else if enqueueing.has(ch.id)}
                    <CircleNotch size={14} weight="light" class="anim-spin enqueue-icon" />
                  {:else}
                    <button class="dl-btn" onclick={(e) => { e.stopPropagation(); enqueue(ch, e); }} title="Download"><Download size={13} weight="light" /></button>
                  {/if}
                </span>
                <span class="ch-status-action">
                  {#if ch.isDownloaded}
                    <button class="dl-btn dl-btn-delete" onclick={(e) => { e.stopPropagation(); deleteDownloaded(ch.id); }} title="Delete download"><Trash size={13} weight="light" /></button>
                  {/if}
                </span>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/snippet}

    {#snippet chapterFooter()}
      {#if totalPages >= 1}<div class="pagination-bottom v3-pagination"><button class="series-page-btn" onclick={() => chapterPage = Math.max(1, chapterPage - 1)} disabled={chapterPage === 1}>Prev</button><span class="page-num">{chapterPage} / {totalPages}</span><button class="series-page-btn" onclick={() => chapterPage = Math.min(totalPages, chapterPage + 1)} disabled={chapterPage === totalPages}>Next</button></div>{/if}
    {/snippet}
  </SeriesDetailV3Shell>

  {#if ctx}<ContextMenu x={ctx.x} y={ctx.y} items={buildCtxItems(ctx.chapter, ctx.idx)} onClose={() => ctx = null} />{/if}
  {#if migrateOpen && manga}<MigrateModal {manga} currentChapters={chapters} onClose={() => migrateOpen = false} onMigrated={(newManga) => { setActiveManga(newManga); migrateOpen = false; cache.clear(CACHE_KEYS.LIBRARY); }} />{/if}
  {#if trackingOpen && store.activeManga}<TrackingPanel mangaId={store.activeManga.id} mangaTitle={store.activeManga.title} onClose={() => trackingOpen = false} />{/if}

  {#if linkPickerOpen}
    <div class="link-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) closeLinkPicker(); }} onkeydown={(e) => e.key === "Escape" && closeLinkPicker()}>
      <div class="link-modal">
        <div class="link-header">
          <span class="link-title">Link as same series</span>
          <button class="link-close" onclick={closeLinkPicker}><X size={14} weight="light" /></button>
        </div>
        <p class="link-hint">Mark two manga as the same series so duplicates are merged in search and discover. Click a linked entry again to unlink.</p>
        <div class="link-search-wrap">
          <input class="link-search" placeholder="Search your library..." bind:value={linkSearch} use:focusOnMount />
        </div>
        <div class="link-list">
          {#if loadingLinkList}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Links" title="Loading library" />
          {:else if linkPickerResults.length === 0}
            <NocturneState layout="compact" tone="info" icon="search" eyebrow="Links" title="No matching series" body="Try another title from your library." />
          {:else}
            {#each linkPickerResults as m (m.id)}
              {@const isLinked = linkedIds.includes(m.id)}
              <button class="link-row" class:link-row-linked={isLinked} onclick={() => handleLink(m)}>
                <img src={resolveMangaCoverUrl(m, { context: "detail", persistence: "persistent", cacheGeneration: store.libraryCoverCacheGeneration })} alt={m.title} class="link-thumb" loading="lazy" decoding="async" />
                <div class="link-info">
                  <span class="link-manga-title">{m.title}</span>
                  {#if m.source?.displayName}<span class="link-source">{m.source.displayName}</span>{/if}
                </div>
                <span class="link-status">{isLinked ? "Linked" : "Link"}</span>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  {/if}
{/if}
<style>
  .sort-menu,
  .fp-menu,
  .dl-dropdown { display: flex; flex-direction: column; gap: 6px; color: #e5e2e1; }
  .sort-option, .fp-item, .fp-new, .dl-item, .dl-next-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 34px;
    width: 100%;
    padding: 0 10px;
    border: 0;
    border-radius: 10px;
    color: rgba(202, 196, 208, 0.72);
    background: transparent;
    font: 700 11px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.03em;
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease;
  }
  .dl-pop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 42px;
    padding: 2px 2px 9px;
    border-bottom: 1px solid rgba(202, 196, 208, 0.075);
    background: transparent;
  }
  .dl-pop-head > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  }
  .dl-pop-head strong {
    color: #e8e4eb;
    font: 800 15px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
  }
  .dl-kicker,
  .dl-state-label {
    color: rgba(202, 196, 208, 0.46);
    font: 800 9px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .dl-state-label {
    flex: 0 0 auto;
    width: 76px;
    padding: 5px 9px;
    border: 1px solid rgba(201, 181, 255, 0.18);
    border-radius: 999px;
    background: rgba(13, 13, 16, 0.28);
    color: rgba(216, 203, 255, 0.78);
    text-align: center;
    white-space: nowrap;
  }
  .dl-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 0 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .dl-section-compact {
    padding-top: 9px;
    border-top: 1px solid rgba(202, 196, 208, 0.055);
  }
  .dl-actions {
    gap: 4px;
    border-top: 1px solid rgba(202, 196, 208, 0.055);
  }
  .dl-danger-zone {
    border-top: 1px solid rgba(240, 143, 155, 0.095);
  }
  .dl-danger-zone-empty {
    border-top-color: rgba(202, 196, 208, 0.045);
  }
  .sort-option:hover, .sort-option.active, .fp-item:hover, .fp-item-active, .fp-new:hover, .dl-item:hover, .dl-next-btn:hover:not(:disabled) {
    color: #e8e4eb;
    background: rgba(201, 181, 255, 0.12);
  }
  .sort-option:active, .fp-item:active, .fp-new:active, .dl-item:active, .dl-next-btn:active:not(:disabled) { transform: scale(0.985); }
  .sort-section-label, .dl-section-label, .dl-item-sub, .dl-next-sub {
    margin: 5px 8px;
    color: rgba(202, 196, 208, 0.44);
    font: 800 9px/1 "Manrope", "Inter", system-ui, sans-serif;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .dl-section-label {
    margin: 0 2px 3px;
  }
  .sort-divider, .fp-div { height: 1px; margin: 7px 2px; background: rgba(202, 196, 208, 0.075); }
  .fp-create, .dl-range-row, .dl-next-row { display: flex; align-items: center; gap: 6px; padding: 0; }
  .dl-next-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .dl-next-btn {
    min-height: 46px;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 4px;
    padding: 0 10px;
    border: 1px solid rgba(92, 88, 103, 0.26);
    background: rgba(13, 13, 16, 0.18);
  }
  .dl-next-btn:disabled {
    opacity: 0.38;
    cursor: default;
  }
  .dl-next-sub {
    margin: 0;
    color: rgba(202, 196, 208, 0.42);
    font-size: 8px;
  }
  .dl-item {
    min-height: 36px;
    padding: 0 8px;
  }
  .dl-item-sub {
    margin: 0;
    flex: 0 0 auto;
    color: rgba(202, 196, 208, 0.42);
    font-size: 8px;
  }
  .dl-range-trigger {
    border: 1px solid transparent;
  }
  .dl-item-primary {
    color: #d8cbff;
  }
  .dl-item-primary .dl-item-sub {
    color: rgba(216, 203, 255, 0.54);
  }
  .fp-input, .dl-range-input {
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 10px;
    color: #e5e2e1;
    background: rgba(13, 13, 16, 0.92);
    font-size: 11px;
    outline: none;
  }
  .fp-input:focus, .dl-range-input:focus { border-color: rgba(201, 181, 255, 0.45); box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08); }
  .dl-range-row {
    padding: 3px;
    border-radius: 11px;
    background: rgba(13, 13, 16, 0.2);
  }
  .dl-range-sep {
    color: rgba(202, 196, 208, 0.36);
    font-size: 12px;
    font-weight: 800;
  }
  .fp-confirm, .fp-cancel, .dl-range-back, .dl-range-go {
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 10px;
    color: rgba(202, 196, 208, 0.76);
    background: rgba(25, 24, 29, 0.92);
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 140ms ease;
  }
  .fp-confirm:hover, .fp-cancel:hover, .dl-range-back:hover, .dl-range-go:hover:not(:disabled) { color: #e8e4eb; background: rgba(201, 181, 255, 0.12); }
  .fp-confirm:active, .fp-cancel:active, .dl-range-back:active, .dl-range-go:active:not(:disabled) { transform: scale(0.97); }
  .dl-range-go:disabled { opacity: 0.4; cursor: default; }
  .dl-unified-btn { min-width: 0; }
  .dl-unified-count { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: rgba(0, 0, 0, 0.22); font-size: 9px; font-variant-numeric: tabular-nums; }
  .dl-unified-count-empty { display: none; }
  .dl-unified-alert, .dl-item-danger, .sel-action-danger { color: #ffb3b3; }
  .dl-item-danger {
    border: 1px solid transparent;
    background: transparent;
  }
  .dl-item-danger:disabled {
    color: rgba(202, 196, 208, 0.34);
    cursor: default;
  }
  .dl-item-danger:disabled .dl-item-sub {
    color: rgba(202, 196, 208, 0.28);
  }
  .dl-item-danger:hover:not(:disabled) {
    color: #ffd1d1;
    background: rgba(240, 143, 155, 0.09);
  }
  .grid-cell, .grid-cell-skeleton { cursor: pointer; }
  .grid-cell-skeleton { min-height: 74px; border: 1px solid rgba(202, 196, 208, 0.06); border-radius: 12px; background: rgba(28, 27, 27, 0.34); }
  .grid-cell-dl, .grid-cell-dot { width: 5px; height: 5px; border-radius: 999px; background: #d3c4ff; }
  .grid-cell-dl, .grid-cell-dot, .grid-cell-spinner { position: absolute; top: 8px; right: 8px; }
  .grid-cell-dot { right: 18px; opacity: 0.65; }
  .grid-cell-spinner { color: #d3c4ff; }
  .row-skeleton { min-height: 54px; padding: 14px 56px; border-bottom: 1px solid rgba(72, 69, 79, 0.14); }
  .skeleton, .sk-line { border-radius: 999px; background: linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.16), rgba(255,255,255,0.08)); background-size: 220% 100%; animation: shimmer 1.2s ease infinite; }
  .link-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.64);
    backdrop-filter: blur(14px) saturate(118%);
    animation: overlayFadeIn 140ms ease both;
  }
  .link-modal {
    width: min(560px, calc(100vw - 32px));
    max-height: min(720px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid rgba(92, 88, 103, 0.42);
    border-radius: 18px;
    background: rgba(21, 20, 25, 0.98);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.025), 0 28px 80px rgba(0, 0, 0, 0.54);
    animation: modalRiseIn 160ms ease both;
  }
  .link-header, .link-row { display: flex; align-items: center; gap: 12px; }
  .link-header { justify-content: space-between; padding: 15px 18px; border-bottom: 1px solid rgba(92, 88, 103, 0.34); }
  .link-title { color: #e8e4eb; font-size: 13px; font-weight: 800; letter-spacing: 0.02em; }
  .link-close { width: 32px; height: 32px; border: 1px solid rgba(92, 88, 103, 0.42); border-radius: 10px; color: rgba(202, 196, 208, 0.74); background: rgba(255,255,255,0.018); transition: background 140ms ease, color 140ms ease, transform 140ms ease; }
  .link-close:hover { color: #e8e4eb; background: rgba(201, 181, 255, 0.1); }
  .link-close:active { transform: scale(0.96); }
  .link-hint { margin: 0; padding: 12px 16px 0; color: rgba(202, 196, 208, 0.7); font-size: 12px; line-height: 1.5; }
  .link-search-wrap { padding: 12px 16px; }
  .link-search { width: 100%; height: 38px; padding: 0 12px; border: 1px solid rgba(92, 88, 103, 0.42); border-radius: 12px; color: #e8e4eb; background: rgba(13, 13, 16, 0.92); outline: none; }
  .link-search:focus { border-color: rgba(201, 181, 255, 0.45); box-shadow: 0 0 0 3px rgba(201, 181, 255, 0.08); }
  .link-list { min-height: 0; overflow: auto; padding: 0 8px 10px; }
  .link-row { width: 100%; min-height: 60px; padding: 8px; border: 1px solid transparent; border-radius: 12px; color: #e5e2e1; background: transparent; text-align: left; transition: background 140ms ease, border-color 140ms ease, transform 140ms ease; }
  .link-row:hover, .link-row-linked { background: rgba(201, 181, 255, 0.12); }
  .link-row:hover { border-color: rgba(201, 181, 255, 0.16); }
  .link-row:active { transform: scale(0.995); }
  .link-thumb { width: 34px; height: 48px; border-radius: 6px; object-fit: cover; }
  .link-info { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
  .link-manga-title, .link-source, .link-status { overflow: hidden; color: rgba(202, 196, 208, 0.7); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .link-manga-title { color: #e5e2e1; font-size: 12px; font-weight: 700; }
  :global(.anim-spin) { animation: spin 0.85s linear infinite; }
  @keyframes overlayFadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes modalRiseIn { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes shimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }
</style>
<script module lang="ts">
  function focusOnMount(node: HTMLElement) { node.focus(); }
</script>
