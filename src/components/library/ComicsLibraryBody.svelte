<script module lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { createComicsLibraryCardVmCache } from "../../lib/library/comicsSection";

  let sessionComicsScrollTop = 0;
  const comicsCardVmCache = createComicsLibraryCardVmCache();
  const ENABLE_LIBRARY_PERF_LOGS = false;
</script>

<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { onMount, type ComponentProps } from "svelte";
  import { Books, CheckSquare, Folder, FolderSimplePlus, Trash, X } from "phosphor-svelte";
  import { createComicLibraryCardId } from "../../lib/library/cardIdentity";
  import {
    cacheLibraryCoverFromServer,
    clearSessionLibraryCoverUrl,
    getCachedLibraryCoverUrl,
    getSessionLibraryCoverUrl,
    libraryCoverCacheKey,
    setSessionLibraryCoverUrl,
  } from "../../lib/library/coverCache";
  import {
    clearLibraryCoverFailed,
    createLibraryCoverStateKey,
    hasLibraryCoverFailed,
    markLibraryCoverFailed,
  } from "../../lib/library/coverFailure";
  import { computeLibraryLayout, type LibraryPreferredGridColumns, type LibraryViewMode } from "../../lib/libraryDisplay";
  import type { ComicsSectionVM } from "../../lib/library/contracts";
  import { getCategoryDisplayName } from "../../lib/library/categories";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import type { Category, Manga, Source } from "../../lib/types";
  import {
    openMangaDetail,
    setLibraryReturnToMangaId,
    setLibraryScrollTop,
    store,
  } from "../../store/state.svelte";
  import ContextMenu from "../shared/ContextMenu.svelte";
  import VirtualLibraryCardGrid from "./VirtualLibraryCardGrid.svelte";
  import { estimateLibraryVirtualRowSize } from "../../lib/library/virtualGrid";

  type MenuEntry = ComponentProps<typeof ContextMenu>["items"][number];

  type Props = {
    vm: ComicsSectionVM;
    active?: boolean;
    mangas: Manga[];
    categories: Category[];
    categoryMangaMap: Map<number, Manga[]>;
    trackedCompletedIds?: ReadonlySet<number>;
    trackedChapterTotalsByMangaId?: ReadonlyMap<number, number>;
    sources?: Source[];
    renderLimit?: number;
    viewKey: string;
    viewMode?: LibraryViewMode;
    preferredColumns?: LibraryPreferredGridColumns;
    showProgress?: boolean;
    showOutline?: boolean;
    onRemoveFromLibrary?: (manga: Manga) => Promise<void> | void;
    onAddToLibrary?: (manga: Manga) => Promise<void> | void;
    onDeleteAllDownloads?: (manga: Manga) => Promise<void> | void;
    onToggleCategory?: (manga: Manga, category: Category) => Promise<void> | void;
    onBulkRemoveFromLibrary?: (mangaIds: number[]) => Promise<void> | void;
    onBulkToggleCategory?: (mangaIds: number[], category: Category) => Promise<void> | void;
    onCreateAndAssign?: (manga: Manga) => Promise<void> | void;
    onCreateCategory?: () => Promise<void> | void;
    onCoverErrorDetected?: (mangaId: number) => void;
    coverRecoveryVersions?: ReadonlyMap<number, number>;
    coverCacheGeneration?: number;
  };

  let {
    vm,
    active = true,
    mangas,
    categories,
    categoryMangaMap,
    trackedCompletedIds = new Set(),
    trackedChapterTotalsByMangaId = new Map(),
    sources = [],
    renderLimit = 48,
    viewKey,
    viewMode = "grid",
    preferredColumns = "auto",
    showProgress = true,
    showOutline = true,
    onRemoveFromLibrary = async () => {},
    onAddToLibrary = async () => {},
    onDeleteAllDownloads = async () => {},
    onToggleCategory = async () => {},
    onBulkRemoveFromLibrary = undefined,
    onBulkToggleCategory = undefined,
    onCreateAndAssign = async () => {},
    onCreateCategory = async () => {},
    onCoverErrorDetected = () => {},
    coverRecoveryVersions = new Map(),
    coverCacheGeneration = 0,
  }: Props = $props();

  let contentEl: HTMLDivElement | null = $state(null);
  let contentWidth = $state(0);
  let ctx: { x: number; y: number; manga: Manga } | null = $state(null);
  let emptyCtx: { x: number; y: number } | null = $state(null);
  let selectMode = $state(false);
  let selectedIds = $state(new Set<number>());
  let bulkWorking = $state(false);
  let bulkMoveOpen = $state(false);
  let failedCoverKeys = $state(new Set<string>());
  let coverRetryCounts = $state(new Map<string, number>());
  let coverWakeAttemptedKeys = $state(new Set<string>());
  let cachedCoverUrls = $state(new Map<string, string>());
  let coverCacheCheckedKeys = $state(new Set<string>());
  let prewarmStartIndex = $state(0);
  let prewarmEndIndex = $state(0);
  let viewStateReady = false;
  let previousViewKey: string | null = null;
  let previousActive = false;
  let pendingScrollRestore = false;
  let pendingCardRestore = false;
  let prevActiveMangaId: number | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const coverRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const coverRecoveryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const coverCacheInflight = new Set<string>();
  const pendingCachedCoverUrls = new Map<string, string>();
  const pendingCheckedCoverKeys = new Set<string>();
  let coverCacheFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let coverPrewarmQueue: Manga[] = [];
  let coverPrewarmHandle: ReturnType<typeof setTimeout> | number | null = null;
  let coverPrewarmUsesIdleCallback = false;
  let lastCoverRecoveryVersions = new Map<number, number>();
  let lastCoverCacheScopeKey = "";
  let scrollPersistTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingScrollTop = 0;
  let isScrolling = $state(false);
  let lastVisibleCardsBuildMs = 0;
  let lastVisibleCardsCount = 0;
  const mountStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const lazyVirtualizeAfter = 48;

  const mangaByCardId = $derived(
    new Map(mangas.map((manga) => [createComicLibraryCardId(manga.id), manga])),
  );
  const sourcesById = $derived(new Map(sources.map((source) => [String(source.id), source])));

  const prewarmLimit = $derived(Math.max(1, renderLimit || 48));
  const layout = $derived(
    computeLibraryLayout({
      availableWidth: contentWidth,
      preferredColumns,
      mode: viewMode,
    }),
  );

  function syncContentWidth() {
    if (!contentEl) return;
    const nextWidth = contentEl.clientWidth;
    if (nextWidth > 0 && nextWidth !== contentWidth) contentWidth = nextWidth;
  }
  const visibleCards = $derived.by(() => {
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    const cards = mangas.length > lazyVirtualizeAfter
      ? []
      : mangas.map((manga) => getComicsCardVm(manga));
    comicsCardVmCache.prune(mangas.map((manga) => manga.id));
    lastVisibleCardsBuildMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start;
    lastVisibleCardsCount = cards.length;
    if (ENABLE_LIBRARY_PERF_LOGS) {
      console.info("[LibraryPerf] Comics VM build", {
        cards: cards.length,
        ms: Number(lastVisibleCardsBuildMs.toFixed(2)),
      });
    }
    return cards;
  });

  function getComicsCardVm(manga: Manga) {
    const coverSrc = hasUsableCover(manga) ? getCoverSrc(manga) : null;
    return comicsCardVmCache.get(manga, {
      cropCovers: store.settings.libraryCropCovers,
      selectedIds,
      trackedCompletedIds,
      trackedChapterTotalsByMangaId,
      sourcesById,
      coverSrcOverride: coverSrc,
    });
  }

  function getComicsCardAt(index: number) {
    const manga = mangas[index];
    return manga ? getComicsCardVm(manga) : null;
  }

  function getComicsCardIdAt(index: number) {
    const manga = mangas[index];
    return manga ? createComicLibraryCardId(manga.id) : String(index);
  }

  function logLibraryPerf(label: string, data: Record<string, unknown> = {}) {
    if (!ENABLE_LIBRARY_PERF_LOGS) return;
    console.info(`[LibraryPerf] ${label}`, data);
  }

  function scheduleGridVisiblePerfLog(reason: string) {
    if (!ENABLE_LIBRARY_PERF_LOGS) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        logLibraryPerf(`Comics ${reason}`, {
          cards: lastVisibleCardsCount,
          vmBuildMs: Number(lastVisibleCardsBuildMs.toFixed(2)),
          mountToGridMs: Number((now - mountStartedAt).toFixed(2)),
          domNodes: contentEl?.querySelectorAll("*").length ?? 0,
          scrollTop: contentEl?.scrollTop ?? 0,
        });
      });
    });
  }

  function enterSelectMode(id?: number) {
    selectMode = true;
    if (id !== undefined) selectedIds = new Set([id]);
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds = new Set();
    bulkMoveOpen = false;
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    if (next.size === 0) exitSelectMode();
  }

  function selectAll() {
    selectedIds = new Set(mangas.map((manga) => manga.id));
  }

  function onCardPointerDown(cardId: string, event: PointerEvent) {
    const manga = mangaByCardId.get(cardId);
    if (!manga || event.button !== 0) return;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      enterSelectMode(manga.id);
    }, 500);
  }

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onOpenCard(cardId: string, event: MouseEvent | KeyboardEvent) {
    clearLongPress();
    const manga = mangaByCardId.get(cardId);
    if (!manga) return;

    if (selectMode) {
      toggleSelect(manga.id);
      return;
    }

    if (event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.shiftKey)) {
      event.preventDefault();
      enterSelectMode(manga.id);
      return;
    }

    openMangaDetail(manga);
  }

  async function bulkMoveToCategory(category: Category) {
    bulkWorking = true;
    bulkMoveOpen = false;
    try {
      if (onBulkToggleCategory) {
        await onBulkToggleCategory([...selectedIds], category);
      } else {
        for (const id of selectedIds) {
          const manga = mangas.find((entry) => entry.id === id);
          if (manga) await onToggleCategory(manga, category);
        }
      }
    } finally {
      bulkWorking = false;
      exitSelectMode();
    }
  }

  async function bulkRemoveFromLibrary() {
    bulkWorking = true;
    try {
      if (onBulkRemoveFromLibrary) {
        await onBulkRemoveFromLibrary([...selectedIds]);
      } else {
        for (const id of selectedIds) {
          const manga = mangas.find((entry) => entry.id === id);
          if (manga) await onRemoveFromLibrary(manga);
        }
      }
    } finally {
      bulkWorking = false;
      exitSelectMode();
    }
  }

  function handleCoverError(cardId: string) {
    const manga = mangaByCardId.get(cardId);
    if (!manga) return;
    const coverKey = getCoverStateKey(manga);
    if (isCoverFailed(manga)) return;

    if (cachedCoverUrls.has(coverKey)) {
      const nextCached = new Map(cachedCoverUrls);
      nextCached.delete(coverKey);
      cachedCoverUrls = nextCached;
      clearSessionLibraryCoverUrl(coverCacheScope(), manga);
    }

    if (!coverWakeAttemptedKeys.has(coverKey)) {
      const nextWakeAttempted = new Set(coverWakeAttemptedKeys);
      nextWakeAttempted.add(coverKey);
      coverWakeAttemptedKeys = nextWakeAttempted;
      onCoverErrorDetected(manga.id);
    }

    markLibraryCoverFailed(coverKey);
    const nextFailed = new Set(failedCoverKeys);
    nextFailed.add(coverKey);
    failedCoverKeys = nextFailed;
  }

  function handleCoverLoad(cardId: string) {
    const manga = mangaByCardId.get(cardId);
    if (!manga) return;
    const coverKey = getCoverStateKey(manga);

    if (coverRetryTimers.has(manga.id)) {
      clearTimeout(coverRetryTimers.get(manga.id)!);
      coverRetryTimers.delete(manga.id);
    }

    if (isCoverFailed(manga)) {
      clearLibraryCoverFailed(coverKey);
      const nextFailed = new Set(failedCoverKeys);
      nextFailed.delete(coverKey);
      failedCoverKeys = nextFailed;
    }

    if (coverRecoveryTimers.has(manga.id)) {
      clearTimeout(coverRecoveryTimers.get(manga.id)!);
      coverRecoveryTimers.delete(manga.id);
    }

    if (coverRetryCounts.has(coverKey)) {
      const nextRetries = new Map(coverRetryCounts);
      nextRetries.delete(coverKey);
      coverRetryCounts = nextRetries;
    }

    if (coverWakeAttemptedKeys.has(coverKey)) {
      const nextWakeAttempted = new Set(coverWakeAttemptedKeys);
      nextWakeAttempted.delete(coverKey);
      coverWakeAttemptedKeys = nextWakeAttempted;
    }

  }

  function hasUsableCover(manga: Manga): boolean {
    return !!manga.thumbnailUrl && !isCoverFailed(manga);
  }

  function getCoverStateKey(manga: Manga): string {
    return createLibraryCoverStateKey(manga, coverScopeKey());
  }

  function isCoverFailed(manga: Manga): boolean {
    const coverKey = getCoverStateKey(manga);
    return failedCoverKeys.has(coverKey) || hasLibraryCoverFailed(coverKey);
  }

  function getCoverSrc(manga: Manga): string {
    if (!manga.thumbnailUrl) return "";
    const coverKey = getCoverStateKey(manga);
    const retry = coverRetryCounts.get(coverKey) ?? 0;
    if (retry === 0) {
      const cached = cachedCoverUrls.get(coverKey);
      if (cached) return cached;
      const sessionCached = getSessionLibraryCoverUrl(coverCacheScope(), manga);
      if (sessionCached) return sessionCached;
    }
    const direct = resolveMangaCoverUrl(manga, {
      context: "library",
      persistence: "persistent",
      cacheGeneration: coverCacheGeneration,
    });
    const params = [
      `aethon_cover_recovery=${coverRecoveryVersions.get(manga.id) ?? 0}`,
    ];
    if (retry > 0) params.push(`aethon_cover_retry=${retry}`);
    return direct ? `${direct}${direct.includes("?") ? "&" : "?"}${params.join("&")}` : "";
  }

  function coverCacheScope() {
    return {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
      coverCacheGeneration,
    };
  }

  function coverScopeKey() {
    return `${store.runtimeResolvedLocalProfileId ?? ""}::${store.runtimeServerUrl ?? ""}::${coverCacheGeneration}`;
  }

  async function loadCachedCoverForManga(manga: Manga) {
    const scope = coverCacheScope();
    const key = libraryCoverCacheKey(scope, manga);
    const coverKey = getCoverStateKey(manga);
    if (coverCacheInflight.has(key)) return;
    coverCacheInflight.add(key);
    try {
      const cached = await getCachedLibraryCoverUrl(scope, manga)
        ?? await cacheLibraryCoverFromServer(scope, manga);
      if (coverKey !== getCoverStateKey(manga)) return;
      if (cached) {
        const decoded = await decodeCoverUrl(cached);
        if (coverKey !== getCoverStateKey(manga)) return;
        if (!decoded) return;
        pendingCachedCoverUrls.set(coverKey, cached);
        setSessionLibraryCoverUrl(scope, manga, cached);
        pendingCheckedCoverKeys.add(coverKey);
        scheduleCoverCacheFlush();
      }
    } finally {
      coverCacheInflight.delete(key);
    }
  }

  async function decodeCoverUrl(url: string): Promise<boolean> {
    if (typeof Image === "undefined") return true;
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    if (typeof image.decode !== "function") return true;
    try {
      await image.decode();
      return true;
    } catch {
      return await new Promise<boolean>((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 1200);
      });
    }
  }

  function scheduleCoverCacheFlush() {
    if (coverCacheFlushTimer !== null) return;
    coverCacheFlushTimer = setTimeout(flushCoverCacheUpdates, isScrolling ? 220 : 80);
  }

  function flushCoverCacheUpdates() {
    coverCacheFlushTimer = null;
    if (isScrolling) {
      scheduleCoverCacheFlush();
      return;
    }
    if (!pendingCachedCoverUrls.size && !pendingCheckedCoverKeys.size) return;

    if (pendingCachedCoverUrls.size) {
      const nextCached = new Map(cachedCoverUrls);
      for (const [coverKey, url] of pendingCachedCoverUrls) nextCached.set(coverKey, url);
      pendingCachedCoverUrls.clear();
      cachedCoverUrls = nextCached;
    }

    if (pendingCheckedCoverKeys.size) {
      const nextChecked = new Set(coverCacheCheckedKeys);
      for (const coverKey of pendingCheckedCoverKeys) nextChecked.add(coverKey);
      pendingCheckedCoverKeys.clear();
      coverCacheCheckedKeys = nextChecked;
    }
  }

  function clearCoverPrewarmSchedule() {
    if (coverPrewarmHandle === null) return;
    if (
      coverPrewarmUsesIdleCallback
      && typeof window !== "undefined"
      && typeof window.cancelIdleCallback === "function"
    ) {
      window.cancelIdleCallback(coverPrewarmHandle as number);
    } else {
      clearTimeout(coverPrewarmHandle as ReturnType<typeof setTimeout>);
    }
    coverPrewarmHandle = null;
    coverPrewarmUsesIdleCallback = false;
  }

  function scheduleNextCoverPrewarmBatch() {
    if (coverPrewarmHandle !== null || coverPrewarmQueue.length === 0) return;

    const run = () => {
      coverPrewarmHandle = null;
      coverPrewarmUsesIdleCallback = false;
      if (isScrolling) {
        scheduleNextCoverPrewarmBatch();
        return;
      }
      const batch = coverPrewarmQueue.splice(0, 4);
      for (const manga of batch) {
        void loadCachedCoverForManga(manga);
      }
      scheduleNextCoverPrewarmBatch();
    };

    if (
      typeof window !== "undefined"
      && typeof window.requestIdleCallback === "function"
    ) {
      coverPrewarmUsesIdleCallback = true;
      coverPrewarmHandle = window.requestIdleCallback(run, { timeout: 300 });
      return;
    }

    coverPrewarmUsesIdleCallback = false;
    coverPrewarmHandle = setTimeout(run, 32);
  }

  function scheduleCoverPrewarm(mangasToPrewarm: Manga[]) {
    coverPrewarmQueue = mangasToPrewarm;
    clearCoverPrewarmSchedule();
    scheduleNextCoverPrewarmBatch();
  }

  function handleContentScroll() {
    if (!active || !contentEl) return;
    scheduleScrollTopPersistence(contentEl.scrollTop);
  }

  function scheduleScrollTopPersistence(scrollTop: number) {
    sessionComicsScrollTop = scrollTop;
    isScrolling = true;
    pendingScrollTop = scrollTop;

    if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      scrollIdleTimer = null;
      isScrolling = false;
    }, 160);

    if (Math.abs(scrollTop - store.libraryScrollTop) < 24) return;
    if (scrollPersistTimer !== null) clearTimeout(scrollPersistTimer);
    scrollPersistTimer = setTimeout(() => {
      scrollPersistTimer = null;
      setLibraryScrollTop(pendingScrollTop);
    }, 180);
  }

  function restoreContentScrollTop(targetTop: number) {
    if (targetTop <= 0) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!active || !contentEl) return;
        if (Math.abs(contentEl.scrollTop - targetTop) < 2) return;
        if (typeof contentEl.scrollTo === "function") {
          contentEl.scrollTo({ top: targetTop });
        } else {
          contentEl.scrollTop = targetTop;
        }
      });
    });
  }

  function scrollToMangaIndex(mangaIndex: number) {
    if (!contentEl || mangaIndex < 0) return;
    const rowIndex = Math.floor(mangaIndex / Math.max(1, layout.effectiveColumns));
    const targetTop = rowIndex * estimateLibraryVirtualRowSize(viewMode);
    if (typeof contentEl.scrollTo === "function") {
      contentEl.scrollTo({ top: targetTop });
    } else {
      contentEl.scrollTop = targetTop;
    }
  }

  function restoreCardIntoView(targetId: number, attempts = 0) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!active || !contentEl) return;
        const card = contentEl.querySelector<HTMLElement>(`[data-card-id="${createComicLibraryCardId(targetId)}"]`);
        if (card) {
          card.scrollIntoView({ block: "center", inline: "nearest" });
          pendingCardRestore = false;
          return;
        }

        const mangaIndex = mangas.findIndex((entry) => entry.id === targetId);
        if (mangaIndex >= 0 && attempts === 0) {
          scrollToMangaIndex(mangaIndex);
          restoreCardIntoView(targetId, attempts + 1);
          return;
        }

        if (attempts < 6) {
          restoreCardIntoView(targetId, attempts + 1);
          return;
        }

        pendingCardRestore = false;
      });
    });
  }

  function handleVisibleRangeChange(startIndex: number, endIndex: number) {
    if (prewarmStartIndex === startIndex && prewarmEndIndex === endIndex) return;
    prewarmStartIndex = startIndex;
    prewarmEndIndex = endIndex;
  }

  function openCtx(cardId: string, event: MouseEvent) {
    const manga = mangaByCardId.get(cardId);
    if (!manga) return;
    if (selectMode) {
      toggleSelect(manga.id);
      return;
    }
    event.preventDefault();
    ctx = { x: event.clientX, y: event.clientY, manga };
  }

  function buildCtxItems(manga: Manga): MenuEntry[] {
    const categoryEntries: MenuEntry[] = categories.map((category) => {
      const inCategory = (categoryMangaMap.get(category.id) ?? []).some((entry) => entry.id === manga.id);
      return {
        label: inCategory
          ? `Remove from ${getCategoryDisplayName(category)}`
          : `Add to ${getCategoryDisplayName(category)}`,
        icon: Folder,
        onClick: () => onToggleCategory(manga, category),
      };
    });

    return [
      {
        label: manga.inLibrary ? translate("ui_removeFromLibrary") : translate("ui_addToLibrary"),
        icon: Books,
        onClick: () => (manga.inLibrary ? onRemoveFromLibrary(manga) : onAddToLibrary(manga)),
      },
      {
        label: translate("ui_deleteAllDownloads"),
        icon: Trash,
        danger: true,
        disabled: !(manga.downloadCount && manga.downloadCount > 0),
        onClick: () => onDeleteAllDownloads(manga),
      },
      { separator: true },
      { label: translate("ui_selectThisManga"), icon: CheckSquare, onClick: () => enterSelectMode(manga.id) },
      ...(categoryEntries.length ? ([{ separator: true } as MenuEntry, ...categoryEntries]) : []),
      { separator: true },
      { label: translate("ui_newFolder"), icon: FolderSimplePlus, onClick: () => onCreateAndAssign(manga) },
    ];
  }

  function buildEmptyCtx(): MenuEntry[] {
    return [{
      label: translate("ui_newFolder"),
      icon: FolderSimplePlus,
      onClick: () => onCreateCategory(),
    }];
  }

  $effect(() => {
    if (!active) {
      coverPrewarmQueue = [];
      clearCoverPrewarmSchedule();
      return;
    }

    const profileId = store.runtimeResolvedLocalProfileId;
    const serverUrl = store.runtimeServerUrl;
    const scopeKey = `${profileId ?? ""}::${serverUrl ?? ""}::${coverCacheGeneration}`;
    if (lastCoverCacheScopeKey && lastCoverCacheScopeKey !== scopeKey) {
      comicsCardVmCache.clear();
      cachedCoverUrls = new Map();
      coverCacheCheckedKeys = new Set();
      failedCoverKeys = new Set();
      coverRetryCounts = new Map();
      coverWakeAttemptedKeys = new Set();
      coverCacheInflight.clear();
      pendingCachedCoverUrls.clear();
      pendingCheckedCoverKeys.clear();
      if (coverCacheFlushTimer !== null) {
        clearTimeout(coverCacheFlushTimer);
        coverCacheFlushTimer = null;
      }
      coverPrewarmQueue = [];
      clearCoverPrewarmSchedule();
    }
    lastCoverCacheScopeKey = scopeKey;
    const visibleEnd = Math.max(prewarmEndIndex, Math.min(mangas.length, prewarmLimit));
    const visiblePrewarmMangas = mangas.slice(prewarmStartIndex, visibleEnd);
    const queuedForCache: Manga[] = [];
    for (const manga of visiblePrewarmMangas) {
      const coverKey = getCoverStateKey(manga);
      if (
        !manga.thumbnailUrl
        || cachedCoverUrls.has(coverKey)
        || coverCacheCheckedKeys.has(coverKey)
        || (coverRetryCounts.get(coverKey) ?? 0) > 0
      ) continue;
      queuedForCache.push(manga);
    }
    scheduleCoverPrewarm(queuedForCache);
  });

  $effect(() => {
    const changedIds: number[] = [];
    for (const [mangaId, version] of coverRecoveryVersions) {
      if ((lastCoverRecoveryVersions.get(mangaId) ?? 0) !== version) {
        changedIds.push(mangaId);
      }
    }
    lastCoverRecoveryVersions = new Map(coverRecoveryVersions);
    if (!changedIds.length) return;

    const nextFailures = new Set(failedCoverKeys);
    const nextRetries = new Map(coverRetryCounts);
    for (const mangaId of changedIds) {
      const manga = mangas.find((entry) => entry.id === mangaId);
      if (!manga) continue;
      const coverKey = getCoverStateKey(manga);
      const retryTimer = coverRetryTimers.get(mangaId);
      if (retryTimer) {
        clearTimeout(retryTimer);
        coverRetryTimers.delete(mangaId);
      }
      const recoveryTimer = coverRecoveryTimers.get(mangaId);
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        coverRecoveryTimers.delete(mangaId);
      }
      const attempts = nextRetries.get(coverKey) ?? 0;
      if (attempts < 1) {
        clearLibraryCoverFailed(coverKey);
        nextFailures.delete(coverKey);
        nextRetries.set(coverKey, attempts + 1);
      }
    }
    failedCoverKeys = nextFailures;
    coverRetryCounts = nextRetries;
  });

  $effect(() => {
    const nextViewKey = viewKey;
    if (!viewStateReady) {
      viewStateReady = true;
      previousViewKey = nextViewKey;
      return;
    }
    if (nextViewKey === previousViewKey) return;
    previousViewKey = nextViewKey;

    exitSelectMode();
    prewarmStartIndex = 0;
    prewarmEndIndex = Math.min(mangas.length, prewarmLimit);
    sessionComicsScrollTop = 0;
    if (active) {
      setLibraryScrollTop(0);
      if (typeof contentEl?.scrollTo === "function") contentEl.scrollTo({ top: 0 });
    }
  });

  $effect(() => {
    const activeMangaId = store.activeManga?.id ?? null;

    if (active && activeMangaId !== null && contentEl) {
      clearLongPress();
      setLibraryScrollTop(contentEl.scrollTop);
      setLibraryReturnToMangaId(activeMangaId);
    }

    if (prevActiveMangaId !== null && activeMangaId === null) {
      pendingScrollRestore = store.libraryScrollTop > 0;
      pendingCardRestore = !pendingScrollRestore && store.libraryReturnToMangaId !== null;
    }

    prevActiveMangaId = activeMangaId;
  });

  $effect(() => {
    if (!active || !pendingScrollRestore || vm.loading || !contentEl || store.activeManga) return;

    const targetTop = store.libraryScrollTop > 0 ? store.libraryScrollTop : sessionComicsScrollTop;
    if (targetTop <= 0) {
      pendingScrollRestore = false;
      return;
    }

    restoreContentScrollTop(targetTop);
    pendingScrollRestore = false;
    pendingCardRestore = false;
  });

  $effect(() => {
    if (!active || !pendingCardRestore || vm.loading || !contentEl || store.activeManga) return;

    const targetId = store.libraryReturnToMangaId;
    if (targetId === null) {
      pendingCardRestore = false;
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        restoreCardIntoView(targetId);
      });
    });
  });

  $effect(() => {
    if (!active || !contentEl) {
      previousActive = false;
      return;
    }
    syncContentWidth();
    if (previousActive) return;
    previousActive = true;

    const targetTop = sessionComicsScrollTop > 0 ? sessionComicsScrollTop : store.libraryScrollTop;
    if (targetTop > 0) {
      restoreContentScrollTop(targetTop);
    } else if (store.libraryReturnToMangaId !== null) {
      pendingCardRestore = true;
    }
  });

  $effect(() => {
    if (!active || vm.loading || !contentEl) return;
    mangas.length;
    scheduleGridVisiblePerfLog("grid visible");
  });

  $effect(() => {
    const el = contentEl;
    if (!active || !el) return;

    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(syncContentWidth);

    syncContentWidth();
    resizeObserver?.observe(el);
    window.addEventListener("resize", syncContentWidth, { passive: true });
    window.visualViewport?.addEventListener("resize", syncContentWidth, { passive: true });
    firstFrame = requestAnimationFrame(() => {
      firstFrame = null;
      syncContentWidth();
      secondFrame = requestAnimationFrame(() => {
        secondFrame = null;
        syncContentWidth();
      });
    });

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncContentWidth);
      window.visualViewport?.removeEventListener("resize", syncContentWidth);
      if (firstFrame !== null) cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
    };
  });

  onMount(() => {
    let longTaskObserver: PerformanceObserver | null = null;
    let longTaskCount = 0;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && selectMode) exitSelectMode();
      if ((event.key === "a" && (event.metaKey || event.ctrlKey)) && selectMode) {
        event.preventDefault();
        selectAll();
      }
    }

    syncContentWidth();
    queueMicrotask(() => {
      if (contentEl) {
        syncContentWidth();
      }
      if (store.libraryScrollTop > 0) {
        pendingScrollRestore = true;
      } else if (sessionComicsScrollTop > 0) {
        pendingScrollRestore = true;
      }
      if (store.libraryScrollTop <= 0 && store.libraryReturnToMangaId !== null) {
        pendingCardRestore = true;
      }

      scheduleGridVisiblePerfLog("mount");
    });

    if (
      ENABLE_LIBRARY_PERF_LOGS
      && typeof PerformanceObserver !== "undefined"
    ) {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          longTaskCount += list.getEntries().length;
          logLibraryPerf("Comics long tasks", { count: longTaskCount });
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });
      } catch {
        longTaskObserver = null;
      }
    }

    logLibraryPerf("Comics mounted", {
      cards: mangas.length,
      active,
      cacheGeneration: coverCacheGeneration,
    });

    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearLongPress();
      for (const timer of coverRetryTimers.values()) clearTimeout(timer);
      coverRetryTimers.clear();
      for (const timer of coverRecoveryTimers.values()) clearTimeout(timer);
      coverRecoveryTimers.clear();
      if (contentEl) sessionComicsScrollTop = contentEl.scrollTop;
      coverPrewarmQueue = [];
      pendingCachedCoverUrls.clear();
      pendingCheckedCoverKeys.clear();
      if (coverCacheFlushTimer !== null) {
        clearTimeout(coverCacheFlushTimer);
        coverCacheFlushTimer = null;
      }
      clearCoverPrewarmSchedule();
      if (scrollPersistTimer !== null) {
        clearTimeout(scrollPersistTimer);
        scrollPersistTimer = null;
        setLibraryScrollTop(pendingScrollTop);
      }
      if (scrollIdleTimer !== null) {
        clearTimeout(scrollIdleTimer);
        scrollIdleTimer = null;
      }
      longTaskObserver?.disconnect();
      logLibraryPerf("Comics unmounted", {
        cards: mangas.length,
        longTasks: longTaskCount,
        lifetimeMs: Number(((typeof performance !== "undefined" ? performance.now() : Date.now()) - mountStartedAt).toFixed(2)),
      });
      window.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

{#if selectMode}
  <div class="select-bar">
    <div class="select-bar-left">
      <button type="button" class="sel-btn sel-cancel" onclick={exitSelectMode} title={$_("ui_cancelEsc")}>
        <X size={13} weight="bold" />
      </button>
      <span class="sel-count">{selectedIds.size} {$_("ui_selected")}</span>
      <button type="button" class="sel-btn sel-all" onclick={selectAll} title={$_("ui_selectAll")}>
        {$_("ui_selectAll")}
      </button>
    </div>
    <div class="select-bar-right">
      {#if categories.length}
        <div class="bulk-move-wrap">
          <button
            type="button"
            class="sel-btn sel-move"
            disabled={selectedIds.size === 0 || bulkWorking}
            onclick={() => bulkMoveOpen = !bulkMoveOpen}
          >
            <Folder size={13} weight="bold" />
            {$_("ui_moveToFolder")}
          </button>
          {#if bulkMoveOpen}
            <div class="bulk-folder-list">
              {#each categories as category}
                <button type="button" class="bulk-folder-item" onclick={() => bulkMoveToCategory(category)}>
                  <Folder size={11} weight="bold" />
                  {getCategoryDisplayName(category)}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <button
        type="button"
        class="sel-btn sel-remove"
        disabled={selectedIds.size === 0 || bulkWorking}
        onclick={bulkRemoveFromLibrary}
      >
        <Trash size={13} weight="bold" />
        {$_("sources_actions_remove")}
      </button>
    </div>
  </div>
{/if}

<div
  class="content"
  class:library-scroll-active={isScrolling}
  role="presentation"
  bind:this={contentEl}
  onscroll={handleContentScroll}
  oncontextmenu={(event) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    emptyCtx = { x: event.clientX, y: event.clientY };
  }}
>
  {#if vm.loading}
    <div class="grid-skeleton">
      {#each Array(12) as _}
        <div class="card-skeleton">
          <div class="cover-skeleton skeleton"></div>
          <div class="title-skeleton skeleton"></div>
        </div>
      {/each}
    </div>
  {:else if mangas.length === 0}
    <div class="center">{vm.emptyMessage}</div>
  {:else}
    {#if mangas.length > lazyVirtualizeAfter}
      <VirtualLibraryCardGrid
        itemCount={mangas.length}
        getItem={getComicsCardAt}
        getItemId={getComicsCardIdAt}
        {viewMode}
        effectiveColumns={layout.effectiveColumns}
        scrollElement={contentEl}
        {showProgress}
        {showOutline}
        showSelectableState={selectMode}
        onOpen={onOpenCard}
        onContextMenu={openCtx}
        onPointerDown={onCardPointerDown}
        onPointerUp={() => clearLongPress()}
        onPointerLeave={() => clearLongPress()}
        onCoverLoad={handleCoverLoad}
        onCoverError={handleCoverError}
        onVisibleRangeChange={handleVisibleRangeChange}
        virtualizeAfter={lazyVirtualizeAfter}
        {active}
        panelMotionEnabled={!isScrolling}
      />
    {:else}
      <VirtualLibraryCardGrid
        items={visibleCards}
        {viewMode}
        effectiveColumns={layout.effectiveColumns}
        scrollElement={contentEl}
        {showProgress}
        {showOutline}
        showSelectableState={selectMode}
        onOpen={onOpenCard}
        onContextMenu={openCtx}
        onPointerDown={onCardPointerDown}
        onPointerUp={() => clearLongPress()}
        onPointerLeave={() => clearLongPress()}
        onCoverLoad={handleCoverLoad}
        onCoverError={handleCoverError}
        onVisibleRangeChange={handleVisibleRangeChange}
        virtualizeAfter={lazyVirtualizeAfter}
        {active}
        panelMotionEnabled={!isScrolling}
      />
    {/if}
  {/if}
</div>

{#if ctx}
  <ContextMenu x={ctx.x} y={ctx.y} items={buildCtxItems(ctx.manga)} onClose={() => ctx = null} />
{/if}
{#if emptyCtx}
  <ContextMenu x={emptyCtx.x} y={emptyCtx.y} items={buildEmptyCtx()} onClose={() => emptyCtx = null} />
{/if}

<style>
  .content {
    flex: 1;
    overflow-y: auto;
    padding:
      var(--library-content-padding-top, var(--sp-5))
      var(--library-shell-padding-x, var(--sp-6))
      var(--library-content-padding-bottom, var(--sp-6));
    min-height: 0;
    -webkit-overflow-scrolling: touch;
  }

  .grid-skeleton {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: var(--library-grid-column-gap, var(--sp-4));
  }

  .card-skeleton {
    padding: 0;
  }

  .cover-skeleton {
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-md);
  }

  .title-skeleton {
    height: 12px;
    margin-top: var(--sp-2);
    width: 80%;
    border-radius: var(--radius-sm);
  }

  .center {
    position: relative;
    z-index: var(--component-library-panel-z-index);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60%;
    color: var(--text-muted);
    font-size: var(--text-sm);
    gap: var(--sp-2);
    text-align: center;
    line-height: var(--leading-base);
  }

  .select-bar {
    position: relative;
    z-index: var(--component-library-header-z-index);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-6);
    background: var(--component-library-select-bar-bg);
    border-bottom: 1px solid var(--component-library-accent-border);
    flex-shrink: 0;
    animation: fadeIn 0.1s ease both;
  }

  .select-bar-left {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .select-bar-right {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    position: relative;
  }

  .sel-count {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--component-library-accent-fg);
    letter-spacing: var(--tracking-wide);
  }

  .sel-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    background: var(--component-button-bg);
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
    white-space: nowrap;
  }

  .sel-btn:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--component-library-border-strong);
  }

  .sel-btn:disabled {
    opacity: var(--component-library-disabled-opacity);
    cursor: not-allowed;
  }

  .sel-cancel {
    border-color: transparent;
    background: transparent;
  }

  .sel-cancel:hover {
    background: var(--component-button-bg-hover);
    border-color: var(--component-library-border-dim);
  }

  .sel-move {
    color: var(--component-library-accent-fg);
    border-color: var(--component-library-accent-border);
    background: var(--component-library-accent-muted-bg);
  }

  .sel-move:hover:not(:disabled) {
    background: var(--component-library-accent-border);
  }

  .sel-remove {
    color: var(--component-library-danger-fg);
    border-color: var(--component-library-danger-border);
  }

  .sel-remove:hover:not(:disabled) {
    background: var(--component-library-danger-bg-hover);
  }

  .sel-all {
    border-color: transparent;
    background: transparent;
  }

  .bulk-move-wrap {
    position: relative;
  }

  .bulk-folder-list {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: var(--component-library-dropdown-z-index);
    background: var(--component-library-select-menu-bg);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    padding: 4px;
    min-width: 160px;
    box-shadow: var(--component-library-select-menu-shadow);
    animation: fadeIn 0.1s ease both;
  }

  .bulk-folder-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    transition: background var(--t-base), color var(--t-base);
  }

  .bulk-folder-item:hover {
    background: var(--bg-hover, var(--bg-base));
    color: var(--text-primary);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
