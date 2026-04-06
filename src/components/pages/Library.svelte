<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { MagnifyingGlass, Books, DownloadSimple, Folder, FolderSimplePlus, Trash, Star, CheckSquare, X, SortAscending, Funnel, CaretUp, CaretDown, BookOpen, Stack, FileText } from "phosphor-svelte";
  import { gql, thumbUrl } from "../../lib/client";
  import { GET_CATEGORIES, GET_LIBRARY, GET_LIBRARY_TRACKING_SUMMARY, UPDATE_MANGA, GET_CHAPTERS, DELETE_DOWNLOADED_CHAPTERS, DEQUEUE_DOWNLOAD, CREATE_CATEGORY, DELETE_CATEGORY, UPDATE_MANGA_CATEGORIES, UPDATE_CATEGORY_ORDER } from "../../lib/queries";
  import { cache, CACHE_KEYS, CACHE_GROUPS, DEFAULT_TTL_MS } from "../../lib/cache";
  import { buildCompletedLibraryIds, collectTrackedChapterTotalsByMangaId, collectTrackedCompletedMangaIds, isMangaPublicationCompleted } from "../../lib/library/completion";
  import { COMPLETED_CATEGORY_NAME, getCategoryDisplayName, isCompletedCategory, normalizeCategories } from "../../lib/library/categories";
  import { dedupeMangaById, shouldHideNsfw } from "../../lib/util";
  import { store, setLibraryFilter, setLibrarySection, setLibraryScrollTop, setLibraryVisibleCount, setLibraryReturnToMangaId, checkAndMarkCompleted as storeCheckAndMarkCompleted, updateSettings, setCategories, setLibraryMangaSnapshot } from "../../store/state.svelte";
  import type { LibrarySortMode, LibrarySortDir, LibraryStatusFilter, LibrarySection } from "../../store/state.svelte";
  import type { Manga, Category, Chapter } from "../../lib/types";
  import { getBookSectionCount } from "../../lib/books/summary";
  import ContextMenu, { type MenuEntry } from "../shared/ContextMenu.svelte";
  import BookShelf from "../books/BookShelf.svelte";

  // Drag type discriminators (tab reorder only — manga cards no longer use drag).
  const DT_TAB = "application/x-moku-tab";

  let activeDragKind: "tab" | null = $state(null);
  let dragInsertIdx:  number       = $state(-1);
  let ensureCompletedInFlight: Promise<Category[]> | null = null;

  // ── Sort / filter panel ───────────────────────────────────────────────────

  let sortPanelOpen:   boolean = $state(false);
  let filterPanelOpen: boolean = $state(false);

  function openSortPanel() {
    sortPanelOpen = !sortPanelOpen;
    filterPanelOpen = false;
  }

  function openFilterPanel() {
    filterPanelOpen = !filterPanelOpen;
    sortPanelOpen = false;
  }

  const SORT_LABELS: Record<LibrarySortMode, string> = {
    az:             "A–Z",
    unreadCount:    "Unread chapters",
    totalChapters:  "Total chapters",
    recentlyAdded:  "Recently added",
    recentlyRead:   "Recently read",
    latestFetched:  "Latest fetched chapter",
    latestUploaded: "Latest uploaded chapter",
  };

  const STATUS_LABELS: Record<LibraryStatusFilter, string> = {
    ALL:       "All statuses",
    ONGOING:   "Ongoing",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
    HIATUS:    "Hiatus",
    UNKNOWN:   "Unknown",
  };

  const ALL_SORT_MODES: LibrarySortMode[] = [
    "az", "unreadCount", "totalChapters", "recentlyAdded",
    "recentlyRead", "latestFetched", "latestUploaded",
  ];

  const ALL_STATUS_FILTERS: LibraryStatusFilter[] = [
    "ALL", "ONGOING", "COMPLETED", "CANCELLED", "HIATUS", "UNKNOWN",
  ];

  type BookCollection = "all" | "epub" | "pdf";
  type BookSortMode = "az" | "author" | "recentlyAdded" | "recentlyRead" | "sectionCount";
  type BookReadFilter = "ALL" | "UNOPENED" | "IN_PROGRESS" | "FINISHED";

  const BOOK_SORT_LABELS: Record<BookSortMode, string> = {
    az: "A-Z",
    author: "Author",
    recentlyAdded: "Recently added",
    recentlyRead: "Recently read",
    sectionCount: "Book contents",
  };

  const BOOK_READ_LABELS: Record<BookReadFilter, string> = {
    ALL: "All books",
    UNOPENED: "Unopened",
    IN_PROGRESS: "In progress",
    FINISHED: "Finished",
  };

  const ALL_BOOK_SORT_MODES: BookSortMode[] = [
    "az",
    "author",
    "recentlyAdded",
    "recentlyRead",
    "sectionCount",
  ];

  const ALL_BOOK_READ_FILTERS: BookReadFilter[] = [
    "ALL",
    "UNOPENED",
    "IN_PROGRESS",
    "FINISHED",
  ];

  // Per-tab reactive state — $derived so Svelte tracks changes to libraryFilter and settings
  const tabSortMode = $derived(
    store.settings.libraryTabSort[store.libraryFilter]?.mode ?? "az" as LibrarySortMode
  );
  const tabSortDir = $derived(
    store.settings.libraryTabSort[store.libraryFilter]?.dir ?? "asc" as LibrarySortDir
  );
  const tabStatus = $derived(
    store.settings.libraryTabStatus[store.libraryFilter] ?? "ALL" as LibraryStatusFilter
  );

  function setTabSort(mode: LibrarySortMode, dir?: LibrarySortDir) {
    const prev   = store.settings.libraryTabSort[store.libraryFilter];
    const newDir = dir ?? prev?.dir ?? "asc";
    updateSettings({
      libraryTabSort: {
        ...store.settings.libraryTabSort,
        [store.libraryFilter]: { mode, dir: newDir },
      },
    });
  }

  function toggleTabSortDir() {
    setTabSort(tabSortMode, tabSortDir === "asc" ? "desc" : "asc");
  }

  function setTabStatus(status: LibraryStatusFilter) {
    updateSettings({
      libraryTabStatus: {
        ...store.settings.libraryTabStatus,
        [store.libraryFilter]: status,
      },
    });
    filterPanelOpen = false;
  }

  function setBookSort(mode: BookSortMode, dir?: LibrarySortDir) {
    bookSortMode = mode;
    if (dir) bookSortDir = dir;
  }

  function toggleBookSortDir() {
    bookSortDir = bookSortDir === "asc" ? "desc" : "asc";
  }

  function setBookReadFilterValue(next: BookReadFilter) {
    bookReadFilter = next;
    filterPanelOpen = false;
  }

  let trackedCompletedIds: Set<number> = $state(new Set());
  let trackedChapterTotalsByMangaId: Map<number, number> = $state(new Map());
  let loading:        boolean      = $state(true);
  let error:          string|null  = $state(null);
  let retryCount:     number       = $state(0);
  let comicsSearch:   string       = $state("");
  let booksSearch:    string       = $state("");
  let renderVisible:  number       = $state(0);
  let contentEl:      HTMLDivElement | null = $state(null);
  let ctx:     { x: number; y: number; manga: Manga } | null = $state(null);
  let emptyCtx:{ x: number; y: number } | null               = $state(null);
  let failedCoverIds: Set<number>  = $state(new Set());
  let coverRetryCounts: Map<number, number> = $state(new Map());
  const coverSessionSeed = Math.random().toString(36).slice(2);

  let scrollStateReady = false;
  let pendingScrollRestore = false;
  let pendingCardRestore = false;
  let renderWindowReady = false;
  let prevActiveMangaId: number | null = null;
  const coverRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const coverRecoveryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // ── Multi-select ──────────────────────────────────────────────────────────

  let selectedIds:   Set<number> = $state(new Set());
  let selectMode:    boolean     = $state(false);
  let bulkWorking:   boolean     = $state(false);
  // Which folder-move popup is open (shows inline folder list)
  let bulkMoveOpen:  boolean     = $state(false);

  let bookCollection: BookCollection = $state("all");
  let bookSortMode: BookSortMode = $state("recentlyAdded");
  let bookSortDir: LibrarySortDir = $state("desc");
  let bookReadFilter: BookReadFilter = $state("ALL");
  const allManga = $derived(store.libraryMangaSnapshot);

  function enterSelectMode(id?: number) {
    selectMode = true;
    if (id !== undefined) selectedIds = new Set([id]);
  }

  function exitSelectMode() {
    selectMode  = false;
    selectedIds = new Set();
    bulkMoveOpen = false;
  }

  function toggleSelect(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    selectedIds = next;
    if (next.size === 0) exitSelectMode();
  }

  function selectAll() {
    selectedIds = new Set(visibleManga.map(m => m.id));
  }

  // Long-press to enter select mode on touch devices
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  function onCardPointerDown(e: PointerEvent, m: Manga) {
    if (e.button !== 0) return; // only primary
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      enterSelectMode(m.id);
    }, 500);
  }
  function onCardPointerUp() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }
  function onCardPointerLeave() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }

  function onCardClick(e: MouseEvent, m: Manga) {
    if (selectMode) {
      toggleSelect(m.id);
      return;
    }
    // Cmd/Ctrl+click or Shift+click enters select mode
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault();
      enterSelectMode(m.id);
      return;
    }
    store.activeManga = m;
  }

  // ── Bulk mutations ────────────────────────────────────────────────────────

  async function bulkMoveToCategory(cat: Category) {
    bulkWorking  = true;
    bulkMoveOpen = false;
    try {
      await Promise.all(
        [...selectedIds].map(id => {
          const manga = allManga.find(m => m.id === id);
          if (!manga) return Promise.resolve();
          return toggleMangaCategory(manga, cat);
        })
      );
    } finally {
      bulkWorking = false;
      exitSelectMode();
    }
  }

  async function bulkRemoveFromLibrary() {
    bulkWorking = true;
    try {
      await Promise.all(
        [...selectedIds].map(id => {
          const manga = allManga.find(m => m.id === id);
          if (!manga) return Promise.resolve();
          return removeFromLibrary(manga);
        })
      );
    } finally {
      bulkWorking = false;
      exitSelectMode();
    }
  }

  // ── Completed category auto-create ────────────────────────────────────────

  function normalizeCategoryNodes(nodes: Manga[] | undefined): Manga[] {
    return dedupeMangaById((nodes ?? []).filter((m) => m.inLibrary));
  }

  async function cleanupCompletedDuplicates(cats: Category[]): Promise<Category[]> {
    const completed = cats.filter(isCompletedCategory);
    if (completed.length <= 1) return normalizeCategories(cats);

    const [keep, ...duplicates] = [...completed].sort((a, b) => {
      if (a.default !== b.default) return a.default ? -1 : 1;
      if (a.order !== b.order) return a.order - b.order;
      return a.id - b.id;
    });

    await Promise.all(
      duplicates.map((cat) =>
        gql(DELETE_CATEGORY, { id: cat.id }).catch(console.error)
      )
    );

    const refreshed = await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)
      .then((d) => d.categories.nodes)
      .catch(() => cats.filter((cat) => cat.id === keep.id || !isCompletedCategory(cat)));

    return normalizeCategories(refreshed);
  }

  async function ensureCompletedCategory(cats: Category[]): Promise<Category[]> {
    const normalized = normalizeCategories(cats);
    const cleaned = await cleanupCompletedDuplicates(normalized);
    if (cleaned.some(isCompletedCategory)) return cleaned;
    if (ensureCompletedInFlight) return await ensureCompletedInFlight;

    ensureCompletedInFlight = (async () => {
      try {
        const fresh = await cleanupCompletedDuplicates(
          normalizeCategories((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)).categories.nodes)
        );
        if (fresh.some(isCompletedCategory)) return fresh;

        try {
          await gql(CREATE_CATEGORY, { name: COMPLETED_CATEGORY_NAME });
        } catch {}

        return await cleanupCompletedDuplicates(
          normalizeCategories((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)).categories.nodes)
        );
      } finally {
        ensureCompletedInFlight = null;
      }
    })();

    try {
      return await ensureCompletedInFlight;
    } catch {
      return cleaned;
    }
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  function loadCategoriesSnapshot() {
    return cache.get(
      CACHE_KEYS.CATEGORIES,
      async () => ensureCompletedCategory((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)).categories.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  async function reloadCategories(force = true) {
    try {
      if (force) cache.clear(CACHE_KEYS.CATEGORIES);
      const cats = await loadCategoriesSnapshot();
      setCategories(cats);
      return cats;
    } catch (e) {
      console.error(e);
      return store.categories;
    }
  }

  function loadLibrary() {
    return cache.get(
      CACHE_KEYS.LIBRARY,
      () => gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY).then(d => d.mangas.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  function loadLibraryTrackingSummary() {
    return cache.get(
      CACHE_KEYS.LIBRARY_TRACKING_SUMMARY,
      () => gql(GET_LIBRARY_TRACKING_SUMMARY).then((d: any) => d.trackers.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  async function loadData() {
    try {
      const [nodes, trackingSummary, categories] = await Promise.all([
        loadLibrary(),
        loadLibraryTrackingSummary().catch((trackingError) => {
          console.error(trackingError);
          return null;
        }),
        loadCategoriesSnapshot().catch((categoryError) => {
          console.error(categoryError);
          return store.categories;
        }),
      ]);
      const mapped = nodes.map((m: any) => ({
        ...m,
        chapterCount: m.chapters?.totalCount ?? m.chapterCount ?? 0,
      }));
      for (const timer of coverRetryTimers.values()) clearTimeout(timer);
      coverRetryTimers.clear();
      for (const timer of coverRecoveryTimers.values()) clearTimeout(timer);
      coverRecoveryTimers.clear();
      failedCoverIds = new Set();
      coverRetryCounts = new Map();
      setLibraryMangaSnapshot(dedupeMangaById(mapped));
      trackedCompletedIds = collectTrackedCompletedMangaIds(trackingSummary);
      trackedChapterTotalsByMangaId = collectTrackedChapterTotalsByMangaId(trackingSummary);
      setCategories(normalizeCategories(categories));
      error    = null;
    } catch (e: any) {
      trackedCompletedIds = new Set();
      trackedChapterTotalsByMangaId = new Map();
      error = e.message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    retryCount;
    loading = true; error = null;
    if (retryCount > 0) cache.clearGroup(CACHE_GROUPS.LIBRARY);
    untrack(() => loadData());
  });

  $effect(() => {
    const deps = [
      store.librarySection,
      store.libraryFilter,
      comicsSearch,
      booksSearch,
      tabSortMode,
      tabSortDir,
      tabStatus,
      bookCollection,
      bookSortMode,
      bookSortDir,
      bookReadFilter,
    ];

    deps;
    if (!scrollStateReady) {
      scrollStateReady = true;
      return;
    }

    setLibraryScrollTop(0);
    if (contentEl) contentEl.scrollTo({ top: 0 });
  });

  $effect(() => {
    const f = store.libraryFilter;
    if (store.librarySection !== "comics") return;
    if (f === "library" || f === "downloaded") return;
    const id = Number(f);
    if (!store.categories.some(c => c.id === id)) {
      untrack(() => { store.libraryFilter = "library"; });
    }
  });

  // Exit select mode when the filter changes
  $effect(() => { store.libraryFilter; untrack(() => exitSelectMode()); });
  $effect(() => { store.librarySection; untrack(() => exitSelectMode()); });

  let prevChapterId: number | null = null;
  $effect(() => {
    const wasOpen = prevChapterId !== null;
    prevChapterId = store.activeChapter?.id ?? null;
    if (wasOpen && !store.activeChapter) return;
  });

  // ── Derived ───────────────────────────────────────────────────────────────

  const visibleCategories = $derived((() => {
    const defaultId = store.settings.defaultLibraryCategoryId ?? null;
    return normalizeCategories(store.categories)
      .filter(c => c.id !== 0 && !(store.settings.hiddenCategoryIds ?? []).includes(c.id))
      .sort((a, b) => {
        if (a.id === defaultId) return -1;
        if (b.id === defaultId) return  1;
        return a.order - b.order;
      });
  })());

  const rawCategoryMangaMap = $derived((() => {
    const map = new Map<number, Manga[]>();
    for (const cat of normalizeCategories(store.categories)) {
      const nodes = normalizeCategoryNodes(cat.mangas?.nodes);
      map.set(cat.id, nodes);
    }
    return map;
  })());

  const completedCategory = $derived(
    normalizeCategories(store.categories).find(isCompletedCategory) ?? null
  );

  const completedLibraryIds = $derived((() => {
    const completedCategoryMembers = completedCategory
      ? rawCategoryMangaMap.get(completedCategory.id) ?? []
      : [];
    return buildCompletedLibraryIds(
      allManga,
      completedCategoryMembers,
      trackedCompletedIds,
      trackedChapterTotalsByMangaId,
    );
  })());

  const canonicalLibraryMangaById = $derived((() => {
    const map = new Map<number, Manga>();
    for (const manga of allManga) map.set(manga.id, manga);
    return map;
  })());

  const categoryMangaMap = $derived((() => {
    const map = new Map<number, Manga[]>();

    for (const [categoryId, nodes] of rawCategoryMangaMap) {
      const canonicalNodes = dedupeMangaById(
        nodes.map((manga) => canonicalLibraryMangaById.get(manga.id) ?? manga),
      );
      map.set(categoryId, canonicalNodes);
    }

    if (completedCategory) {
      const completedManga = dedupeMangaById([
        ...allManga.filter((manga) => completedLibraryIds.has(manga.id)),
        ...(map.get(completedCategory.id) ?? []),
      ]);
      map.set(completedCategory.id, completedManga);
    }
    return map;
  })());

  const filtered = $derived((() => {
    const q      = comicsSearch.trim().toLowerCase();
    const mode   = tabSortMode;
    const dir    = tabSortDir;
    const status = tabStatus;

    // 1. Pick the right base list for this tab
    let items: Manga[];
    if (store.libraryFilter === "library") {
      items = allManga;
    } else if (store.libraryFilter === "downloaded") {
      items = allManga.filter(m => (m.downloadCount ?? 0) > 0);
    } else {
      items = categoryMangaMap.get(Number(store.libraryFilter)) ?? [];
    }

    // 2. NSFW filter — always applied before text search or sort
    items = items.filter(m => !shouldHideNsfw(m, store.settings));

    // 3. Text search
    if (q) items = items.filter(m => m.title.toLowerCase().includes(q));

    // 4. Status filter
    if (status !== "ALL") {
      items = items.filter(m => {
        if (status === "COMPLETED") {
          return isMangaPublicationCompleted(m, trackedCompletedIds);
        }
        const s = m.status?.toUpperCase().replace(/\s+/g, "_") ?? "UNKNOWN";
        return s === status;
      });
    }

    // 5. Sort
    const recentlyReadMap = new Map<number, number>();
    if (mode === "recentlyRead") {
      for (const h of store.history) {
        if (!recentlyReadMap.has(h.mangaId)) recentlyReadMap.set(h.mangaId, h.readAt);
      }
    }

    const sorted = [...items].sort((a, b) => {
      if (mode === "unreadCount") {
        const aUnread = a.unreadCount ?? 0;
        const bUnread = b.unreadCount ?? 0;
        const aHasUnread = aUnread > 0;
        const bHasUnread = bUnread > 0;

        // Always isolate fully-read entries at the end, regardless of sort direction.
        if (aHasUnread !== bHasUnread) return aHasUnread ? -1 : 1;
      }

      let cmp = 0;
      switch (mode) {
        case "az":
          cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
          break;
        case "unreadCount":
          cmp = (a.unreadCount ?? 0) - (b.unreadCount ?? 0);
          break;
        case "totalChapters":
          cmp = (a.chapterCount ?? 0) - (b.chapterCount ?? 0);
          break;
        case "recentlyAdded":
          // id is monotonically increasing on Suwayomi — higher = newer
          cmp = a.id - b.id;
          break;
        case "recentlyRead": {
          const ra = recentlyReadMap.get(a.id) ?? 0;
          const rb = recentlyReadMap.get(b.id) ?? 0;
          cmp = ra - rb;
          break;
        }
        // latestFetched / latestUploaded: no per-manga date available at list level;
        // fall back to id ordering so the option still does something sensible.
        case "latestFetched":
        case "latestUploaded":
          cmp = a.id - b.id;
          break;
      }
      return dir === "asc" ? cmp : -cmp;
    });

    return sorted;
  })());

  const effectiveVisibleCount = $derived(Math.max(renderVisible, store.libraryVisibleCount || 0));
  const visibleManga   = $derived(filtered.slice(0, effectiveVisibleCount));
  const hasMore        = $derived(filtered.length > effectiveVisibleCount);
  const remainingCount = $derived(filtered.length - effectiveVisibleCount);

  $effect(() => {
    const deps = [
      store.librarySection,
      store.libraryFilter,
      comicsSearch,
      booksSearch,
      tabSortMode,
      tabSortDir,
      tabStatus,
      bookCollection,
      bookSortMode,
      bookSortDir,
      bookReadFilter,
    ];

    deps;

    const baseCount = store.settings.renderLimit ?? 48;
    if (!renderWindowReady) {
      renderWindowReady = true;
      renderVisible = Math.max(baseCount, store.libraryVisibleCount || 0);
      return;
    }

    renderVisible = baseCount;
    setLibraryVisibleCount(baseCount);
  });

  $effect(() => {
    renderVisible;
    setLibraryVisibleCount(renderVisible);
  });

  $effect(() => {
    const activeMangaId = store.activeManga?.id ?? null;

    if (activeMangaId !== null && contentEl) {
      setLibraryScrollTop(contentEl.scrollTop);
      setLibraryVisibleCount(renderVisible);
      setLibraryReturnToMangaId(activeMangaId);
    }

    if (prevActiveMangaId !== null && activeMangaId === null) {
      if (store.libraryVisibleCount > renderVisible) {
        renderVisible = store.libraryVisibleCount;
      }
      pendingScrollRestore = store.libraryScrollTop > 0;
      pendingCardRestore = !pendingScrollRestore && store.libraryReturnToMangaId !== null;
    }

    prevActiveMangaId = activeMangaId;
  });

  $effect(() => {
    if (!pendingScrollRestore || loading || !contentEl || store.activeManga) return;

    const targetTop = store.libraryScrollTop;
    if (targetTop <= 0) {
      pendingScrollRestore = false;
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!contentEl) return;
        contentEl.scrollTo({ top: targetTop });
        pendingScrollRestore = false;
        pendingCardRestore = false;
      });
    });
  });

  $effect(() => {
    if (!pendingCardRestore || loading || !contentEl || store.activeManga) return;

    const targetId = store.libraryReturnToMangaId;
    if (targetId === null) {
      pendingCardRestore = false;
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!contentEl) return;
        const card = contentEl.querySelector<HTMLElement>(`[data-manga-id="${targetId}"]`);
        if (card) {
          card.scrollIntoView({ block: "center", inline: "nearest" });
          pendingCardRestore = false;
        }
      });
    });
  });

  const counts = $derived((() => {
    const m: Record<string, number> = {
      library:    allManga.length,
      downloaded: allManga.filter(m => (m.downloadCount ?? 0) > 0).length,
    };
    for (const cat of visibleCategories) {
      m[String(cat.id)] = (categoryMangaMap.get(cat.id) ?? []).length;
    }
    return m;
  })());

  const bookCounts = $derived((() => ({
    all: store.books.length,
    epub: store.books.filter((book) => book.subtype === "epub").length,
    pdf: store.books.filter((book) => book.subtype === "pdf").length,
  }))());

  const filteredBooks = $derived((() => {
    const q = booksSearch.trim().toLowerCase();
    const progressByBook = new Map(
      store.bookProgress.map((progress) => [progress.bookId, progress]),
    );
    let items = [...store.books];

    if (bookCollection !== "all") {
      items = items.filter((book) => book.subtype === bookCollection);
    }

    if (q) {
      items = items.filter((book) => {
        const author = book.author?.toLowerCase() ?? "";
        const title = book.title.toLowerCase();
        return title.includes(q) || author.includes(q);
      });
    }

    if (bookReadFilter !== "ALL") {
      items = items.filter((book) => {
        const progress = progressByBook.get(book.id);
        const pct = progress?.progressPercent ?? 0;
        switch (bookReadFilter) {
          case "UNOPENED":
            return pct <= 0.001;
          case "IN_PROGRESS":
            return pct > 0.001 && pct < 0.98;
          case "FINISHED":
            return pct >= 0.98;
          default:
            return true;
        }
      });
    }

    return items.sort((a, b) => {
      const progressA = progressByBook.get(a.id);
      const progressB = progressByBook.get(b.id);

      let cmp = 0;
      switch (bookSortMode) {
        case "az":
          cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
          break;
        case "author":
          cmp = (a.author ?? "").localeCompare(b.author ?? "", undefined, { sensitivity: "base" });
          if (cmp === 0) {
            cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
          }
          break;
        case "recentlyAdded":
          cmp = a.updatedAt - b.updatedAt;
          break;
        case "recentlyRead":
          cmp = (progressA?.lastReadAt ?? 0) - (progressB?.lastReadAt ?? 0);
          break;
        case "sectionCount":
          cmp = getBookSectionCount(a) - getBookSectionCount(b);
          break;
      }

      return bookSortDir === "asc" ? cmp : -cmp;
    });
  })());

  function loadMore() { renderVisible += store.settings.renderLimit ?? 48; }

  function handleCoverError(mangaId: number) {
    if (failedCoverIds.has(mangaId)) return;

    const attempts = coverRetryCounts.get(mangaId) ?? 0;
    if (attempts < 2) {
      if (coverRetryTimers.has(mangaId)) return;

      const timer = setTimeout(() => {
        coverRetryTimers.delete(mangaId);
        const nextRetries = new Map(coverRetryCounts);
        nextRetries.set(mangaId, attempts + 1);
        coverRetryCounts = nextRetries;
      }, 900 * (attempts + 1));

      coverRetryTimers.set(mangaId, timer);
      return;
    }

    const nextFailed = new Set(failedCoverIds);
    nextFailed.add(mangaId);
    failedCoverIds = nextFailed;

    if (coverRecoveryTimers.has(mangaId)) return;

    const recoveryTimer = setTimeout(() => {
      coverRecoveryTimers.delete(mangaId);

      const nextFailures = new Set(failedCoverIds);
      nextFailures.delete(mangaId);
      failedCoverIds = nextFailures;

      const nextRetries = new Map(coverRetryCounts);
      nextRetries.set(mangaId, (nextRetries.get(mangaId) ?? 0) + 1);
      coverRetryCounts = nextRetries;
    }, 15000);

    coverRecoveryTimers.set(mangaId, recoveryTimer);
  }

  function handleCoverLoad(mangaId: number) {
    if (coverRetryTimers.has(mangaId)) {
      clearTimeout(coverRetryTimers.get(mangaId)!);
      coverRetryTimers.delete(mangaId);
    }

    if (failedCoverIds.has(mangaId)) {
      const nextFailed = new Set(failedCoverIds);
      nextFailed.delete(mangaId);
      failedCoverIds = nextFailed;
    }

    if (coverRecoveryTimers.has(mangaId)) {
      clearTimeout(coverRecoveryTimers.get(mangaId)!);
      coverRecoveryTimers.delete(mangaId);
    }

    if (coverRetryCounts.has(mangaId)) {
      const nextRetries = new Map(coverRetryCounts);
      nextRetries.delete(mangaId);
      coverRetryCounts = nextRetries;
    }
  }

  function hasUsableCover(m: Manga): boolean {
    return !!m.thumbnailUrl && !failedCoverIds.has(m.id);
  }

  function getCoverSignature(m: Manga): string {
    const sourceId = typeof m.source?.id === "string" ? m.source.id : "";
    const title = typeof m.title === "string" ? m.title.trim().toLowerCase() : "";
    return encodeURIComponent(`${m.id}:${sourceId}:${title}`);
  }

  function getCoverSrc(m: Manga): string {
    if (!m.thumbnailUrl) return "";
    const base = thumbUrl(m.thumbnailUrl);
    const sig = getCoverSignature(m);
    const retry = coverRetryCounts.get(m.id) ?? 0;
    const params = [`aethon_cover_sig=${sig}`, `aethon_cover_session=${coverSessionSeed}`];
    if (retry > 0) params.push(`aethon_cover_retry=${retry}`);
    return `${base}${base.includes("?") ? "&" : "?"}${params.join("&")}`;
  }

  function handleContentScroll() {
    if (!contentEl) return;
    setLibraryScrollTop(contentEl.scrollTop);
  }

  // ── Drag: tab reorder ─────────────────────────────────────────────────────

  let dragTabId:     number | null = $state(null);
  let dragOverTabId: number | null = $state(null);
  let dropTargetTabId: number | null = $state(null);

  function onTabDragStart(e: DragEvent, cat: Category) {
    activeDragKind = "tab";
    dragTabId = cat.id;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData(DT_TAB, String(cat.id));
    e.dataTransfer!.setData("text/plain", `tab:${cat.id}`);
  }

  function onTabDragOver(e: DragEvent, cat: Category, idx: number) {
    if (activeDragKind !== "tab") return;
    if (dragTabId === null || dragTabId === cat.id) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    dragOverTabId = cat.id;
    dragInsertIdx = idx;
  }

  function onTabDragLeave() {
    dragOverTabId = null;
  }

  async function onTabDrop(e: DragEvent, dropCat: Category) {
    e.preventDefault();
    dragOverTabId = null;
    dragInsertIdx = -1;

    if (activeDragKind !== "tab") return;
    if (dragTabId === null || dragTabId === dropCat.id) { dragTabId = null; return; }

    const dragId = dragTabId;
    dragTabId = null;
    activeDragKind = null;

    const sorted = [...store.categories]
      .filter(c => c.id !== 0)
      .sort((a, b) => a.order - b.order);

    const fromIdx = sorted.findIndex(c => c.id === dragId);
    const toIdx   = sorted.findIndex(c => c.id === dropCat.id);
    if (fromIdx < 0 || toIdx < 0) return;

    const reordered = [...sorted];
    const [moved]   = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const withNewOrder = reordered.map((c, i) => ({ ...c, order: i + 1 }));
    setCategories(store.categories.map(c => withNewOrder.find(u => u.id === c.id) ?? c));

    const newPos = toIdx + 1;
    try {
      await gql<{ updateCategoryOrder: { categories: Category[] } }>(
        UPDATE_CATEGORY_ORDER,
        { id: dragId, position: newPos },
      );
    } catch (err) {
      console.error("Tab reorder failed:", err);
      await reloadCategories();
    }
  }

  function onTabDragEnd() {
    activeDragKind = null;
    dragTabId = null;
    dragOverTabId = null;
    dragInsertIdx = -1;
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  async function removeFromLibrary(manga: Manga) {
    await gql(UPDATE_MANGA, { id: manga.id, inLibrary: false }).catch(console.error);
    setLibraryMangaSnapshot(allManga.filter(m => m.id !== manga.id));
    cache.clearGroup(CACHE_GROUPS.LIBRARY);
    await reloadCategories();
  }

  async function deleteAllDownloads(manga: Manga) {
    try {
      const data = await gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: manga.id });
      const ids = data.chapters.nodes.filter(c => c.isDownloaded).map(c => c.id);
      if (!ids.length) return;
      await gql(DELETE_DOWNLOADED_CHAPTERS, { ids });
      await Promise.allSettled(ids.map(id => gql(DEQUEUE_DOWNLOAD, { chapterId: id })));
      setLibraryMangaSnapshot(allManga.map(m => m.id === manga.id ? { ...m, downloadCount: 0 } : m));
    } catch (e) { console.error(e); }
  }

  async function toggleMangaCategory(manga: Manga, cat: Category) {
    const inCat = (categoryMangaMap.get(cat.id) ?? []).some(m => m.id === manga.id);
    setCategories(store.categories.map(c => {
      if (c.id !== cat.id || !c.mangas) return c;
      const nodes = inCat
        ? c.mangas.nodes.filter(m => m.id !== manga.id)
        : [...c.mangas.nodes, manga];
      return { ...c, mangas: { nodes } };
    }));
    try {
      await gql(UPDATE_MANGA_CATEGORIES, {
        mangaId:    manga.id,
        addTo:      inCat ? [] : [cat.id],
        removeFrom: inCat ? [cat.id] : [],
      });
      await reloadCategories();
    } catch (e) {
      console.error(e);
      await reloadCategories();
    }
  }

  async function createAndAssign(manga: Manga) {
    const name = prompt("Folder name:");
    if (!name?.trim()) return;
    try {
      const res = await gql<{ createCategory: { category: Category } }>(CREATE_CATEGORY, { name: name.trim() });
      const cat = res.createCategory.category;
      await gql(UPDATE_MANGA_CATEGORIES, { mangaId: manga.id, addTo: [cat.id], removeFrom: [] });
      await reloadCategories();
    } catch (e) { console.error(e); }
  }

  // ── Context menu ──────────────────────────────────────────────────────────

  function openCtx(e: MouseEvent, m: Manga) {
    if (selectMode) { toggleSelect(m.id); return; }
    e.preventDefault();
    ctx = { x: e.clientX, y: e.clientY, manga: m };
  }

  function buildCtxItems(m: Manga): MenuEntry[] {
    const catEntries: MenuEntry[] = visibleCategories.map(cat => {
      const inCat = (categoryMangaMap.get(cat.id) ?? []).some(x => x.id === m.id);
      return {
        label: inCat ? `Remove from ${getCategoryDisplayName(cat)}` : `Add to ${getCategoryDisplayName(cat)}`,
        icon:  Folder,
        onClick: () => toggleMangaCategory(m, cat),
      };
    });
    return [
      { label: m.inLibrary ? "Remove from library" : "Add to library", icon: Books, onClick: () => m.inLibrary ? removeFromLibrary(m) : gql(UPDATE_MANGA, { id: m.id, inLibrary: true }).then(() => { setLibraryMangaSnapshot(allManga.map(x => x.id === m.id ? { ...x, inLibrary: true } : x)); cache.clear(CACHE_KEYS.LIBRARY); }).catch(console.error) },
      { label: "Delete all downloads", icon: Trash, danger: true, disabled: !(m.downloadCount && m.downloadCount > 0), onClick: () => deleteAllDownloads(m) },
      { separator: true },
      { label: "Select this manga", icon: CheckSquare, onClick: () => enterSelectMode(m.id) },
      ...(catEntries.length ? [{ separator: true } as MenuEntry, ...catEntries] : []),
      { separator: true },
      { label: "New folder", icon: FolderSimplePlus, onClick: () => createAndAssign(m) },
    ];
  }

  function buildEmptyCtx(): MenuEntry[] {
    return [{
      label: "New folder",
      icon:  FolderSimplePlus,
      onClick: async () => {
        const name = prompt("Folder name:");
        if (!name?.trim()) return;
        try {
          await gql(CREATE_CATEGORY, { name: name.trim() });
          await reloadCategories();
        } catch (e) { console.error(e); }
      },
    }];
  }

  // ── Completed auto-assign ─────────────────────────────────────────────────

  export async function checkAndMarkCompleted(mangaId: number, chaps: Chapter[]) {
    await storeCheckAndMarkCompleted(mangaId, chaps, store.categories, gql, UPDATE_MANGA_CATEGORIES, UPDATE_MANGA);
    await reloadCategories();
  }

  onMount(() => {
    const unsub = cache.subscribe(CACHE_KEYS.LIBRARY, () => loadData());

    const defaultId = store.settings.defaultLibraryCategoryId;
    if (store.librarySection === "comics" && defaultId && store.libraryFilter === "library") {
      store.libraryFilter = String(defaultId);
    }

    // Escape key exits select mode
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && (sortPanelOpen || filterPanelOpen)) {
        sortPanelOpen = false; filterPanelOpen = false; return;
      }
      if (e.key === "Escape" && selectMode) exitSelectMode();
      if ((e.key === "a" && (e.metaKey || e.ctrlKey)) && selectMode) {
        e.preventDefault();
        selectAll();
      }
    }

    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (sortPanelOpen   && !target.closest(".sort-panel-wrap, .sort-panel"))   sortPanelOpen   = false;
      if (filterPanelOpen && !target.closest(".filter-panel-wrap, .filter-panel")) filterPanelOpen = false;
    }

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onDocMouseDown, true);

    queueMicrotask(() => {
      if (store.libraryVisibleCount > renderVisible) {
        renderVisible = store.libraryVisibleCount;
      }
      if (store.libraryScrollTop > 0) {
        pendingScrollRestore = true;
      }
      if (store.libraryScrollTop <= 0 && store.libraryReturnToMangaId !== null) {
        pendingCardRestore = true;
      }
    });

    return () => {
      for (const timer of coverRetryTimers.values()) clearTimeout(timer);
      coverRetryTimers.clear();
      for (const timer of coverRecoveryTimers.values()) clearTimeout(timer);
      coverRecoveryTimers.clear();
      unsub();
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onDocMouseDown, true);
    };
  });
</script>

<div
  class="root"
  role="presentation"
  oncontextmenu={(e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    emptyCtx = { x: e.clientX, y: e.clientY };
  }}
>
  {#if store.settings.libraryBranches ?? true}
    <svg class="branches" viewBox="0 0 400 600" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <g stroke="var(--accent)" stroke-width="0.6" fill="none" opacity="0.13">
        <path d="M380 600 C380 500 340 460 310 400 C280 340 300 280 270 220"/>
        <path d="M270 220 C255 190 230 175 210 150"/>
        <path d="M270 220 C290 195 310 185 330 165"/>
        <path d="M310 400 C290 375 265 368 245 350"/>
        <path d="M310 400 C330 370 355 362 370 340"/>
        <path d="M210 150 C195 128 185 108 175 80"/>
        <path d="M210 150 C225 130 240 122 258 105"/>
        <path d="M245 350 C228 330 215 315 205 290"/>
        <path d="M175 80  C168 60  162 42  158 20"/>
        <path d="M175 80  C185 62  195 50  208 35"/>
        <path d="M205 290 C196 268 190 250 186 225"/>
        <path d="M258 105 C268 88  278 72  292 52"/>
        <path class="anim-branch" d="M186 225 C180 205 176 185 174 160"/>
        <path class="anim-branch" d="M292 52  C300 36  308 20  318 0"/>
      </g>
    </svg>
  {/if}

  {#if error}
    <div class="center">
      <p class="error-msg">Could not reach Suwayomi</p>
      <p class="error-detail">Make sure the server is running, then retry.</p>
      <button class="retry-btn" onclick={() => retryCount++}>Retry</button>
    </div>
  {:else}
    <div class="header">
      <div class="header-left">
        <span class="heading">Library</span>
        <div class="tabs section-tabs">
          {#each [["comics", "Comics"], ["books", "Books"]] as [section, label]}
            <button
              class="tab section-tab"
              class:active={store.librarySection === section}
              onclick={() => setLibrarySection(section as LibrarySection)}
            >
              {#if section === "comics"}
                <Stack size={11} weight="bold" />
              {:else}
                <BookOpen size={11} weight="bold" />
              {/if}
              {label}
            </button>
          {/each}
        </div>
        {#if store.librarySection === "comics"}
          <div class="tabs">
            {#each [["library","Saved"], ["downloaded","Downloaded"]] as [f, label]}
              <button class="tab" class:active={store.libraryFilter === f} onclick={() => store.libraryFilter = f}>
                {#if f === "library"}<Books size={11} weight="bold" />
                {:else if f === "downloaded"}<DownloadSimple size={11} weight="bold" />{/if}
                {label}
                <span class="tab-count">{counts[f] ?? 0}</span>
              </button>
            {/each}
            {#each visibleCategories as cat, idx}
              {@const isDefault = (store.settings.defaultLibraryCategoryId ?? null) === cat.id}
              {#if dragInsertIdx === idx && activeDragKind === "tab"}
                <div class="tab-insert-bar" aria-hidden="true"></div>
              {/if}
              <button
                class="tab"
                class:active={store.libraryFilter === String(cat.id)}
                class:tab-dragging={dragTabId === cat.id}
                class:tab-drop-target={dropTargetTabId === cat.id}
                class:tab-default={isDefault}
                draggable="true"
                onclick={() => store.libraryFilter = String(cat.id)}
                ondragstart={(e) => onTabDragStart(e, cat)}
                ondragover={(e) => onTabDragOver(e, cat, idx)}
                ondragleave={onTabDragLeave}
                ondrop={(e) => onTabDrop(e, cat)}
                ondragend={onTabDragEnd}
              >
                {#if isDefault}
                  <Star size={11} weight="fill" style="color:var(--accent-fg)" />
                {:else}
                  <Folder size={11} weight="bold" />
                {/if}
                {getCategoryDisplayName(cat)}
                <span class="tab-count">{counts[String(cat.id)] ?? 0}</span>
              </button>
              {#if dragInsertIdx === idx + 1 && activeDragKind === "tab" && idx === visibleCategories.length - 1}
                <div class="tab-insert-bar" aria-hidden="true"></div>
              {/if}
            {/each}
          </div>
        {:else}
          <div class="tabs">
            {#each [
              ["all", "All"],
              ["epub", "EPUB"],
              ["pdf", "PDF"],
            ] as [collection, label]}
              <button
                class="tab"
                class:active={bookCollection === collection}
                onclick={() => bookCollection = collection as BookCollection}
              >
                {#if collection === "all"}
                  <Stack size={11} weight="bold" />
                {:else if collection === "epub"}
                  <BookOpen size={11} weight="bold" />
                {:else}
                  <FileText size={11} weight="bold" />
                {/if}
                {label}
                <span class="tab-count">{bookCounts[collection as BookCollection]}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="header-right">
        <div class="search-wrap">
          <MagnifyingGlass size={13} class="search-icon" weight="light" />
          {#if store.librarySection === "comics"}
            <input class="search" placeholder="Search" bind:value={comicsSearch} />
          {:else}
            <input class="search" placeholder="Search books" bind:value={booksSearch} />
          {/if}
        </div>

        <!-- Sort panel -->
        <div class="sort-panel-wrap">
          <button
            class="icon-btn"
            class:icon-btn-active={store.librarySection === "comics"
              ? tabSortMode !== "az" || tabSortDir !== "asc"
              : bookSortMode !== "recentlyAdded" || bookSortDir !== "desc"}
            title="Sort"
            onclick={openSortPanel}
          >
            <SortAscending size={15} weight="bold" />
          </button>
          {#if sortPanelOpen}
            <div class="dropdown-panel sort-panel" role="menu">
              <p class="panel-label">Sort by</p>
              {#if store.librarySection === "comics"}
                {#each ALL_SORT_MODES as m}
                  <button
                    class="panel-item"
                    class:panel-item-active={tabSortMode === m}
                    role="menuitem"
                    onclick={() => { setTabSort(m); sortPanelOpen = false; }}
                  >
                    {SORT_LABELS[m]}
                    {#if tabSortMode === m}
                      {#if tabSortDir === "asc"}
                        <CaretUp size={11} weight="bold" class="sort-caret" />
                      {:else}
                        <CaretDown size={11} weight="bold" class="sort-caret" />
                      {/if}
                    {/if}
                  </button>
                {/each}
              {:else}
                {#each ALL_BOOK_SORT_MODES as m}
                  <button
                    class="panel-item"
                    class:panel-item-active={bookSortMode === m}
                    role="menuitem"
                    onclick={() => { setBookSort(m); sortPanelOpen = false; }}
                  >
                    {BOOK_SORT_LABELS[m]}
                    {#if bookSortMode === m}
                      {#if bookSortDir === "asc"}
                        <CaretUp size={11} weight="bold" class="sort-caret" />
                      {:else}
                        <CaretDown size={11} weight="bold" class="sort-caret" />
                      {/if}
                    {/if}
                  </button>
                {/each}
              {/if}
              <button
                class="panel-item dir-toggle"
                role="menuitem"
                onclick={store.librarySection === "comics" ? toggleTabSortDir : toggleBookSortDir}
              >
                {(store.librarySection === "comics" ? tabSortDir : bookSortDir) === "asc" ? "Ascending" : "Descending"}
                {#if (store.librarySection === "comics" ? tabSortDir : bookSortDir) === "asc"}
                  <CaretUp size={11} weight="bold" />
                {:else}
                  <CaretDown size={11} weight="bold" />
                {/if}
              </button>
            </div>
          {/if}
        </div>

        <!-- Filter panel -->
        <div class="filter-panel-wrap">
          <button
            class="icon-btn"
            class:icon-btn-active={store.librarySection === "comics" ? tabStatus !== "ALL" : bookReadFilter !== "ALL"}
            title={store.librarySection === "comics" ? "Filter by status" : "Filter books"}
            onclick={openFilterPanel}
          >
            <Funnel size={15} weight={(store.librarySection === "comics" ? tabStatus !== "ALL" : bookReadFilter !== "ALL") ? "fill" : "bold"} />
          </button>
          {#if filterPanelOpen}
            <div class="dropdown-panel filter-panel" role="menu">
              <p class="panel-label">{store.librarySection === "comics" ? "Filter by status" : "Filter books"}</p>
              {#if store.librarySection === "comics"}
                {#each ALL_STATUS_FILTERS as s}
                  <button
                    class="panel-item"
                    class:panel-item-active={tabStatus === s}
                    role="menuitem"
                    onclick={() => setTabStatus(s)}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                {/each}
              {:else}
                {#each ALL_BOOK_READ_FILTERS as s}
                  <button
                    class="panel-item"
                    class:panel-item-active={bookReadFilter === s}
                    role="menuitem"
                    onclick={() => setBookReadFilterValue(s)}
                  >
                    {BOOK_READ_LABELS[s]}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>

    <!-- ── Selection toolbar ───────────────────────────────────────────────── -->
    {#if store.librarySection === "comics" && selectMode}
      <div class="select-bar">
        <div class="select-bar-left">
          <button class="sel-btn sel-cancel" onclick={exitSelectMode} title="Cancel (Esc)">
            <X size={13} weight="bold" />
          </button>
          <span class="sel-count">{selectedIds.size} selected</span>
          <button class="sel-btn sel-all" onclick={selectAll} title="Select all (⌘A)">
            Select all
          </button>
        </div>
        <div class="select-bar-right">
          {#if visibleCategories.length}
            <div class="bulk-move-wrap">
              <button
                class="sel-btn sel-move"
                disabled={selectedIds.size === 0 || bulkWorking}
                onclick={() => bulkMoveOpen = !bulkMoveOpen}
              >
                <Folder size={13} weight="bold" />
                Move to folder
              </button>
              {#if bulkMoveOpen}
                <div class="bulk-folder-list">
                  {#each visibleCategories as cat}
                    <button class="bulk-folder-item" onclick={() => bulkMoveToCategory(cat)}>
                      <Folder size={11} weight="bold" />
                      {getCategoryDisplayName(cat)}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
          <button
            class="sel-btn sel-remove"
            disabled={selectedIds.size === 0 || bulkWorking}
            onclick={bulkRemoveFromLibrary}
          >
            <Trash size={13} weight="bold" />
            Remove
          </button>
        </div>
      </div>
    {/if}

    <div class="content" bind:this={contentEl} onscroll={handleContentScroll}>
    {#if store.librarySection === "books"}
      <BookShelf books={filteredBooks} totalBooks={store.books.length} />
    {:else if loading}
      <div class="grid">
        {#each Array(12) as _}
          <div class="card-skeleton">
            <div class="cover-skeleton skeleton"></div>
            <div class="title-skeleton skeleton"></div>
          </div>
        {/each}
      </div>
    {:else if filtered.length === 0}
      <div class="center">
        {store.libraryFilter === "library" ? "No manga saved to library — browse sources to add some."
          : store.libraryFilter === "downloaded" ? "No downloaded manga."
          : "No manga in this folder yet. Right-click manga anywhere to assign them."}
      </div>
    {:else}
      <div class="grid">
        {#each visibleManga as m (m.id)}
          {@const isSelected = selectedIds.has(m.id)}
          <button
            class="card"
            data-manga-id={m.id}
            class:card-selected={isSelected}
            class:select-mode={selectMode}
            onclick={(e) => onCardClick(e, m)}
            oncontextmenu={(e) => openCtx(e, m)}
            onpointerdown={(e) => onCardPointerDown(e, m)}
            onpointerup={onCardPointerUp}
            onpointerleave={onCardPointerLeave}
          >
            <div class="cover-wrap">
              {#if hasUsableCover(m)}
                  <img
                  src={getCoverSrc(m)}
                  alt={m.title}
                  class="cover"
                  style="object-fit:{store.settings.libraryCropCovers ? 'cover' : 'contain'}"
                  loading="eager"
                  decoding="async"
                  draggable="false"
                  onerror={() => handleCoverError(m.id)}
                  onload={() => handleCoverLoad(m.id)}
                />
              {:else}
                <div class="cover-fallback" aria-hidden="true">
                  <Books size={28} weight="duotone" />
                </div>
              {/if}
              {#if m.downloadCount}<span class="badge-dl">{m.downloadCount}</span>{/if}
              {#if m.unreadCount}<span class="badge-unread">{m.unreadCount}</span>{/if}
              {#if selectMode}
                <div class="select-overlay" aria-hidden="true">
                  <div class="select-check" class:checked={isSelected}>
                    {#if isSelected}
                      <CheckSquare size={20} weight="fill" />
                    {:else}
                      <div class="select-check-empty"></div>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
            <p class="title">{m.title}</p>
          </button>
        {/each}
      </div>
      {#if hasMore}
        <div class="load-more-row">
          <button class="load-more-btn" onclick={loadMore}>
            Show {Math.min(remainingCount, store.settings.renderLimit ?? 48)} more
            <span class="load-more-count">({remainingCount} remaining)</span>
          </button>
        </div>
      {/if}
    {/if}
    </div><!-- .content -->
  {/if}
</div>

{#if ctx}
  <ContextMenu x={ctx.x} y={ctx.y} items={buildCtxItems(ctx.manga)} onClose={() => ctx = null} />
{/if}
{#if emptyCtx}
  <ContextMenu x={emptyCtx.x} y={emptyCtx.y} items={buildEmptyCtx()} onClose={() => emptyCtx = null} />
{/if}

<style>
  .root { position: relative; display: flex; flex-direction: column; height: 100%; overflow: visible; animation: fadeIn 0.14s ease both; }
  .content { flex: 1; overflow-y: auto; padding: var(--sp-5) var(--sp-6) var(--sp-6); will-change: scroll-position; -webkit-overflow-scrolling: touch; }
  .branches { position: absolute; top: 0; right: 0; width: 400px; height: 600px; pointer-events: none; z-index: 0; }
  .branches :global(.anim-branch) { stroke-dasharray: 60; stroke-dashoffset: 60; animation: branchGrow 2.4s ease forwards; }
  @keyframes branchGrow { to { stroke-dashoffset: 0; } }
  .header { position: relative; z-index: 4; display: flex; align-items: center; justify-content: space-between; padding: var(--sp-4) var(--sp-6); border-bottom: 1px solid var(--border-dim); gap: var(--sp-4); flex-wrap: wrap; flex-shrink: 0; }
  .header-left { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .heading { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--text-faint); letter-spacing: var(--tracking-wider); text-transform: uppercase; flex-shrink: 0; }
  .tabs { display: flex; gap: 2px; background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); padding: 2px; }
  .section-tabs { background: var(--bg-overlay); border-color: var(--border-base); }
  .section-tab { cursor: pointer; }
  .tab.section-tab { cursor: pointer; }
  .tab { display: flex; align-items: center; gap: 5px; font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); text-transform: uppercase; padding: 4px 10px; border-radius: var(--radius-sm); color: var(--text-faint); white-space: nowrap; transition: background var(--t-base), color var(--t-base); cursor: grab; }
  .tab:hover { color: var(--text-muted); }
  .tab.active { background: var(--accent-muted); color: var(--accent-fg); border: 1px solid var(--accent-dim); }
  .tab-default { color: var(--text-muted); }
  .tab-dragging { opacity: 0.4; cursor: grabbing; }
  .tab-drop-target { background: var(--accent-muted) !important; color: var(--accent-fg) !important; outline: 1px dashed var(--accent); }
  .tab-insert-bar { width: 2px; height: 22px; background: var(--accent); border-radius: 2px; flex-shrink: 0; box-shadow: 0 0 6px var(--accent); pointer-events: none; }
  .tab-count { font-size: var(--text-2xs); opacity: 0.6; }
  .search-wrap { position: relative; display: flex; align-items: center; }
  .search-wrap :global(.search-icon) { position: absolute; left: 10px; color: var(--text-faint); pointer-events: none; }
  .search { background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); padding: 5px 10px 5px 28px; color: var(--text-primary); font-size: var(--text-sm); width: 180px; outline: none; transition: border-color var(--t-base); }
  .search::placeholder { color: var(--text-faint); }
  .search:focus { border-color: var(--border-strong); }

  /* ── Header right cluster ───────────────────────────────────────────────── */
  .header-right { display: flex; align-items: center; gap: var(--sp-2); }

  /* ── Icon buttons (sort / filter triggers) ──────────────────────────────── */
  .icon-btn { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: var(--radius-md); border: 1px solid var(--border-dim); background: var(--bg-raised); color: var(--text-faint); cursor: pointer; flex-shrink: 0; transition: color var(--t-base), border-color var(--t-base), background var(--t-base); }
  .icon-btn:hover { color: var(--text-primary); border-color: var(--border-strong); }
  .icon-btn-active { color: var(--accent-fg); border-color: var(--accent-dim); background: var(--accent-muted); }

  /* ── Dropdown panels (shared) ───────────────────────────────────────────── */
  .sort-panel-wrap,
  .filter-panel-wrap { position: relative; }
  .dropdown-panel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 10; min-width: 220px; background: var(--bg-overlay, #1a1a1a); border: 1px solid var(--border-base); border-radius: var(--radius-md); padding: 6px; box-shadow: 0 12px 36px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3); animation: fadeIn 0.1s ease both; }
  .panel-label { font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wider); text-transform: uppercase; color: var(--text-faint); padding: 4px 8px 8px; }
  .panel-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 7px 10px; border-radius: var(--radius-sm); border: none; background: transparent; color: var(--text-muted); font-family: var(--font-ui); font-size: var(--text-xs); cursor: pointer; text-align: left; transition: background var(--t-base), color var(--t-base); gap: var(--sp-2); }
  .panel-item:hover { background: var(--bg-subtle, #202020); color: var(--text-primary); }
  .panel-item-active { color: var(--accent-fg); background: var(--accent-muted); font-weight: var(--weight-medium, 500); }
  .panel-item-active:hover { background: var(--accent-dim); }
  .panel-divider { height: 1px; background: var(--border-dim); margin: 4px 2px; }
  .dir-toggle { color: var(--text-secondary); justify-content: flex-start; gap: var(--sp-2); border-top: 1px solid var(--border-dim); border-radius: 0 0 var(--radius-sm) var(--radius-sm); margin-top: 2px; padding-top: 9px; }
  .sort-caret { flex-shrink: 0; }

  /* ── Selection toolbar ──────────────────────────────────────────────────── */
  .select-bar { position: relative; z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-2) var(--sp-6); background: var(--bg-raised); border-bottom: 1px solid var(--accent-dim); flex-shrink: 0; animation: fadeIn 0.1s ease both; }
  .select-bar-left { display: flex; align-items: center; gap: var(--sp-3); }
  .select-bar-right { display: flex; align-items: center; gap: var(--sp-2); position: relative; }
  .sel-count { font-family: var(--font-ui); font-size: var(--text-xs); color: var(--accent-fg); letter-spacing: var(--tracking-wide); }
  .sel-btn { display: flex; align-items: center; gap: 5px; font-family: var(--font-ui); font-size: var(--text-2xs); letter-spacing: var(--tracking-wide); text-transform: uppercase; padding: 4px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-dim); background: var(--bg-base); color: var(--text-muted); cursor: pointer; transition: color var(--t-base), border-color var(--t-base), background var(--t-base); white-space: nowrap; }
  .sel-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--border-strong); }
  .sel-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .sel-cancel { border-color: transparent; background: transparent; }
  .sel-cancel:hover { background: var(--bg-raised); border-color: var(--border-dim); }
  .sel-move { color: var(--accent-fg); border-color: var(--accent-dim); background: var(--accent-muted); }
  .sel-move:hover:not(:disabled) { background: var(--accent-dim); }
  .sel-remove { color: var(--color-error, #e05c5c); border-color: color-mix(in srgb, var(--color-error, #e05c5c) 30%, transparent); }
  .sel-remove:hover:not(:disabled) { background: color-mix(in srgb, var(--color-error, #e05c5c) 12%, transparent); }
  .sel-all { border-color: transparent; background: transparent; }

  /* Bulk folder dropdown */
  .bulk-move-wrap { position: relative; }
  .bulk-folder-list { position: absolute; top: calc(100% + 4px); right: 0; z-index: 10; background: var(--bg-raised); border: 1px solid var(--border-dim); border-radius: var(--radius-md); padding: 4px; min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,0.35); animation: fadeIn 0.1s ease both; }
  .bulk-folder-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 10px; border-radius: var(--radius-sm); border: none; background: transparent; color: var(--text-muted); font-family: var(--font-ui); font-size: var(--text-xs); cursor: pointer; text-align: left; transition: background var(--t-base), color var(--t-base); }
  .bulk-folder-item:hover { background: var(--bg-hover, var(--bg-base)); color: var(--text-primary); }

  /* ── Grid & cards ───────────────────────────────────────────────────────── */
  .grid { position: relative; z-index: 1; isolation: isolate; display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: var(--sp-4); align-items: start; }
  .card { background: none; border: none; padding: 0; cursor: pointer; text-align: left; display: flex; flex-direction: column; min-width: 0; }
  .card:hover .cover { filter: brightness(1.07); }
  .card:hover .title { color: var(--text-primary); }
  .card.select-mode { cursor: default; }
  .card.card-selected .cover-wrap { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius-md); }
  .card.card-selected .title { color: var(--accent-fg); }
  .cover-wrap { position: relative; aspect-ratio: 2/3; overflow: hidden; border-radius: var(--radius-md); background: var(--bg-raised); border: 1px solid var(--border-dim); display: flex; align-items: center; justify-content: center; }
  .cover { width: 100%; height: 100%; transition: filter var(--t-base); will-change: filter; display: block; background: var(--bg-raised); }
  .cover-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-faint); background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised) 88%, white 12%), var(--bg-base)); }
  .badge-dl { position: absolute; bottom: var(--sp-1); right: var(--sp-1); min-width: 18px; height: 18px; padding: 0 3px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; background: var(--accent-dim); color: var(--accent-fg); border-radius: var(--radius-sm); border: 1px solid var(--accent-muted); }
  .badge-unread { position: absolute; top: var(--sp-1); left: var(--sp-1); min-width: 18px; height: 18px; padding: 0 4px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; background: var(--bg-void); color: var(--text-primary); border-radius: var(--radius-sm); border: 1px solid var(--border-strong); }

  /* Select overlay (checkbox) */
  .select-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.18); display: flex; align-items: flex-start; justify-content: flex-end; padding: 6px; pointer-events: none; }
  .select-check { color: var(--text-faint); opacity: 0.7; transition: color var(--t-base), opacity var(--t-base); }
  .select-check.checked { color: var(--accent-fg); opacity: 1; }
  .select-check-empty { width: 20px; height: 20px; border-radius: 4px; border: 2px solid var(--text-faint); background: rgba(0,0,0,0.3); }

  .title { margin-top: var(--sp-2); min-height: calc(var(--leading-snug) * 2em); font-size: var(--text-sm); color: var(--text-secondary); line-height: var(--leading-snug); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; transition: color var(--t-base); }
  .card-skeleton { padding: 0; }
  .cover-skeleton { aspect-ratio: 2/3; border-radius: var(--radius-md); }
  .title-skeleton { height: 12px; margin-top: var(--sp-2); width: 80%; border-radius: var(--radius-sm); }
  .load-more-row { display: flex; justify-content: center; padding: var(--sp-5) 0 var(--sp-2); position: relative; z-index: 1; }
  .load-more-btn { display: flex; align-items: center; gap: var(--sp-2); font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); padding: 8px 20px; border-radius: var(--radius-full); border: 1px solid var(--border-dim); background: var(--bg-raised); color: var(--text-muted); cursor: pointer; transition: color var(--t-base), border-color var(--t-base), background var(--t-base); }
  .load-more-btn:hover { color: var(--accent-fg); border-color: var(--accent-dim); background: var(--accent-muted); }
  .load-more-count { color: var(--text-faint); font-size: var(--text-2xs); }
  .center { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 60%; color: var(--text-muted); font-size: var(--text-sm); gap: var(--sp-2); text-align: center; line-height: var(--leading-base); }
  .error-msg { color: var(--color-error); font-size: var(--text-base); }
  .error-detail { color: var(--text-faint); font-size: var(--text-sm); }
  .retry-btn { margin-top: var(--sp-3); padding: 6px 16px; border-radius: var(--radius-md); border: 1px solid var(--border-dim); background: var(--bg-raised); color: var(--text-muted); cursor: pointer; font-family: var(--font-ui); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); }
  @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
</style>
