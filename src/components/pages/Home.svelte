<script lang="ts">
  import { onMount } from "svelte";
  import { gql } from "../../lib/client";
  import { GET_LIBRARY, GET_CATEGORIES_SUMMARY, GET_LIBRARY_TRACKING_SUMMARY, GET_SOURCES, GET_TRACKERS, GET_EXTENSIONS } from "../../lib/queries";
  import { cache, CACHE_GROUPS, CACHE_KEYS, DEFAULT_TTL_MS } from "../../lib/cache";
  import { buildCompletedLibraryIds, collectTrackedChapterTotalsByMangaId, collectTrackedCompletedMangaIds, type TrackerCompletionTracker } from "../../lib/library/completion";
  import { isCompletedCategory, normalizeCategories } from "../../lib/library/categories";
  import { dedupeSources, shouldHideSource } from "../../lib/util";
  import { presentBook } from "../../lib/books/presentation";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import {
    store,
    openReader,
    openBookReader,
    setActiveBookId,
    setPreviewManga,
    setNavPage,
    setLibraryFilter,
    setLibrarySection,
    addToast,
    openSearchSources,
    openHomeDashboard,
    openHomeHistory,
    setCategories,
    setLibraryMangaSnapshot,
    setSearchPrefill,
    updateSettings,
  } from "../../store/state.svelte";
  import type { HistoryEntry, LibrarySortDir, LibrarySortMode } from "../../store/state.svelte";
  import type { BookEntry, BookProgress } from "../../lib/books/types";
  import type { Manga, Category, Source, Tracker, Extension } from "../../lib/types";
  import RecentActivity from "../layout/RecentActivity.svelte";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import { detectSetupState, type SetupState } from "../../lib/setupState";
  import { SERVER_READY_EVENT } from "../../lib/serverLifecycle";

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function formatReadTime(mins: number): string {
    if (mins < 1) return `${Math.round(mins * 60)}s`;
    if (mins < 60) return `${Math.round(mins)}m`;
    const h = Math.floor(mins / 60);
    const r = Math.round(mins % 60);
    if (h < 24) return r === 0 ? `${h}h` : `${h}h ${r}m`;
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh === 0 ? `${d}d` : `${d}d ${rh}h`;
  }

  function formatHomeSourceName(source: Source): string {
    const raw = (source.name || source.displayName || "").trim();
    if (!raw) return "";
    return raw
      .replace(/\s*\([A-Z0-9-]{2,10}\)\s*$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }

  function formatHomeSourceMeta(source: Source): string {
    const parts: string[] = [];
    if (source.id === "0") {
      parts.push("LOCAL");
    } else if (source.lang) {
      parts.push(source.lang.toUpperCase());
    }
    if (source.isNsfw) {
      parts.push("NSFW");
    }
    return parts.join(" · ");
  }

  function normalizeExtensionSourceKey(name: string): string {
    return name
      .replace(/\s*\([A-Z0-9-]{2,10}\)\s*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  let homeSearch = $state("");
  let homeSearchFocused = $state(false);
  let lastActivitySeenAt = $state(0);
  let trackedCompletedIds: Set<number> = $state(new Set());
  let trackedChapterTotalsByMangaId: Map<number, number> = $state(new Map());
  let loadingLibrary = $state(true);
  let setupState: SetupState | null = $state(null);
  let loadLibraryRequest: Promise<void> | null = null;
  let loadHomeMetaRequest: Promise<void> | null = null;
  let scheduledHomeMetaLoad: number | null = null;
  let homeSources: Source[] = $state([]);
  let homeTrackers: Tracker[] = $state([]);
  let homeExtensions: Extension[] = $state([]);
  const libraryManga = $derived(store.libraryMangaSnapshot);
  const libraryBooks = $derived(store.books);
  const bookProgressById = $derived(new Map(store.bookProgress.map((progress) => [progress.bookId, progress] as const)));
  const ACTIVITY_SEEN_STORAGE_KEY = "aethon.home.activity.lastSeenReadAt";
  const latestActivityAt = $derived(Math.max(
    store.history.reduce((latest, entry) => Math.max(latest, Number(entry.readAt) || 0), 0),
    store.libraryUpdateNotifications.reduce((latest, entry) => Math.max(latest, Number(entry.createdAt) || 0), 0),
    store.systemNotifications.reduce((latest, entry) => Math.max(latest, Number(entry.createdAt) || 0), 0),
  ));
  const newActivityCount = $derived(
    store.history.filter((entry) => (Number(entry.readAt) || 0) > lastActivitySeenAt).length
    + store.libraryUpdateNotifications.filter((entry) => (Number(entry.createdAt) || 0) > lastActivitySeenAt).length
    + store.systemNotifications.filter((entry) => (Number(entry.createdAt) || 0) > lastActivitySeenAt).length
  );
  const newActivityBadge = $derived(newActivityCount > 99 ? "99+" : String(newActivityCount));

  function submitHomeSearch() {
    const query = homeSearch.trim();
    if (!query) return;
    setSearchPrefill(query);
    setNavPage("search");
    homeSearch = "";
  }

  function openLibraryWithSort(sortMode: LibrarySortMode, sortDir: LibrarySortDir) {
    updateSettings({
      libraryTabSort: {
        ...store.settings.libraryTabSort,
        library: {
          mode: sortMode,
          dir: sortDir,
        },
      },
      libraryTabStatus: {
        ...store.settings.libraryTabStatus,
        library: "ALL",
      },
    });
    setLibrarySection("comics");
    setLibraryFilter("library");
    setNavPage("library");
  }

  function openCheckUpdates() {
    if (titlesWithUnreadCount > 0 && titlesWithUnreadCount >= booksInProgressCount) {
      openLibraryWithSort("unreadCount", "desc");
      return;
    }
    if (booksInProgressCount > 0) {
      updateSettings({
        booksLibraryUi: {
          ...store.settings.booksLibraryUi,
          statusFilter: "in_progress",
          sortMode: "recentlyRead",
          sortDir: "desc",
        },
      });
      setLibrarySection("books");
      setNavPage("library");
      return;
    }
    openLibraryWithSort("unreadCount", "desc");
  }

  function openPlanToRead() {
    if (booksToReadCount > 0 && booksToReadCount >= mangaToReadCount) {
      updateSettings({
        booksLibraryUi: {
          ...store.settings.booksLibraryUi,
          statusFilter: "unopened",
          sortMode: "recentlyAdded",
          sortDir: "desc",
        },
      });
      setLibrarySection("books");
      setNavPage("library");
      return;
    }

    openLibraryWithSort("unreadCount", "desc");
  }

  function handleHomeSearchFocus() {
    homeSearchFocused = true;
    document.body.classList.add("aethon-home-search-engaged");
  }

  function handleHomeSearchBlur() {
    homeSearchFocused = false;
    document.body.classList.remove("aethon-home-search-engaged");
  }

  function markActivitySeen() {
    if (latestActivityAt <= 0) return;
    lastActivitySeenAt = latestActivityAt;
    localStorage.setItem(ACTIVITY_SEEN_STORAGE_KEY, String(latestActivityAt));
  }

  function handleOpenHomeHistory() {
    openHomeHistory();
    markActivitySeen();
  }

  onMount(() => {
    const storedLastSeen = Number(localStorage.getItem(ACTIVITY_SEEN_STORAGE_KEY) ?? 0);
    lastActivitySeenAt = Number.isFinite(storedLastSeen) ? storedLastSeen : 0;
    void loadLibrary();
    scheduleHomeMetaLoad();
    void refreshSetupState();
    const handleServerReady = () => {
      void loadLibrary();
      scheduleHomeMetaLoad();
      void refreshSetupState();
    };
    window.addEventListener(SERVER_READY_EVENT, handleServerReady);
    const unsubLibrary = cache.subscribe(CACHE_KEYS.LIBRARY, () => loadLibrary());
    const unsubTracking = cache.subscribe(CACHE_KEYS.LIBRARY_TRACKING_SUMMARY, () => loadLibrary());
    const unsubSources = cache.subscribe(CACHE_KEYS.SOURCES, () => loadHomeMeta());
    return () => {
      document.body.classList.remove("aethon-home-search-engaged");
      cancelScheduledHomeMetaLoad();
      window.removeEventListener(SERVER_READY_EVENT, handleServerReady);
      unsubLibrary();
      unsubTracking();
      unsubSources();
    };
  });

  $effect(() => {
    if (store.navPage !== "home") return;
    store.contentSetupVersion;
    void loadLibrary();
    scheduleHomeMetaLoad();
    void refreshSetupState();
  });

  $effect(() => {
    if (store.homePanelHint !== "history") return;
    markActivitySeen();
  });

  async function refreshSetupState() {
    setupState = await detectSetupState(store.settings);
  }

  function loadCategoriesSnapshot() {
    return cache.get(
      CACHE_KEYS.CATEGORIES,
      () => gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY).then((d) => normalizeCategories(d.categories.nodes)),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  function loadLibraryTrackingSummary() {
    return cache.get(
      CACHE_KEYS.LIBRARY_TRACKING_SUMMARY,
      () => gql<{ trackers: { nodes: TrackerCompletionTracker[] } }>(GET_LIBRARY_TRACKING_SUMMARY).then((d) => d.trackers.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  function loadSourcesSnapshot() {
    return cache.get(
      CACHE_KEYS.SOURCES,
      () => gql<{ sources: { nodes: Source[] } }>(GET_SOURCES).then((d) => d.sources.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.SOURCES,
    );
  }

  function loadTrackersSnapshot() {
    return cache.get(
      "home_trackers",
      () => gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS).then((d) => d.trackers.nodes),
      DEFAULT_TTL_MS,
    );
  }

  function loadExtensionsSnapshot() {
    return cache.get(
      "home_extensions",
      () => gql<{ extensions: { nodes: Extension[] } }>(GET_EXTENSIONS).then((d) => d.extensions.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.SOURCES,
    );
  }

  function cancelScheduledHomeMetaLoad() {
    if (scheduledHomeMetaLoad === null) return;
    if ("cancelIdleCallback" in window) {
      (window as Window & { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback(scheduledHomeMetaLoad);
    } else {
      window.clearTimeout(scheduledHomeMetaLoad);
    }
    scheduledHomeMetaLoad = null;
  }

  function scheduleHomeMetaLoad() {
    if (loadHomeMetaRequest || scheduledHomeMetaLoad !== null || store.navPage !== "home") return;
    const run = () => {
      scheduledHomeMetaLoad = null;
      void loadHomeMeta();
    };
    if ("requestIdleCallback" in window) {
      scheduledHomeMetaLoad = (window as Window & { requestIdleCallback: (callback: IdleRequestCallback, opts?: IdleRequestOptions) => number }).requestIdleCallback(
        () => run(),
        { timeout: 1200 },
      );
      return;
    }
    scheduledHomeMetaLoad = window.setTimeout(run, 120);
  }

  function loadHomeMeta() {
    if (loadHomeMetaRequest) {
      return loadHomeMetaRequest;
    }

    cancelScheduledHomeMetaLoad();
    loadHomeMetaRequest = Promise.all([
      loadSourcesSnapshot().catch((error) => {
        console.error(error);
        return [];
      }),
      loadExtensionsSnapshot().catch((error) => {
        console.error(error);
        return [];
      }),
      loadTrackersSnapshot().catch((error) => {
        console.error(error);
        return [];
      }),
    ])
      .then(([sources, extensions, trackers]) => {
        homeSources = sources.filter((source) => !shouldHideSource(source, store.settings));
        homeExtensions = extensions;
        homeTrackers = trackers;
      })
      .catch(console.error)
      .finally(() => {
        loadHomeMetaRequest = null;
      });

    return loadHomeMetaRequest;
  }

  function loadLibrary() {
    if (loadLibraryRequest) {
      return loadLibraryRequest;
    }

    const libraryP = cache.get(
      CACHE_KEYS.LIBRARY,
      () => gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY).then((d) => d.mangas.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );

    loadLibraryRequest = Promise.all([
      libraryP,
      loadCategoriesSnapshot().catch((error) => {
        console.error(error);
        return store.categories;
      }),
      loadLibraryTrackingSummary().catch((error) => {
        console.error(error);
        return [];
      }),
    ])
      .then(([mangas, categories, trackingSummary]) => {
        setLibraryMangaSnapshot(mangas.map((manga: any) => ({
          ...manga,
          chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? 0,
        })));
        setCategories(normalizeCategories(categories));
        trackedCompletedIds = collectTrackedCompletedMangaIds(trackingSummary);
        trackedChapterTotalsByMangaId = collectTrackedChapterTotalsByMangaId(trackingSummary);
        scheduleHomeMetaLoad();
      })
      .catch(console.error)
      .finally(() => {
        loadingLibrary = false;
        loadLibraryRequest = null;
      });

    return loadLibraryRequest;
  }

  $effect(() => {
    const sessionId = store.readerSessionId;
    if (sessionId === 0) return;
    cache.clear(CACHE_KEYS.LIBRARY);
    loadingLibrary = true;
    void loadLibrary();
  });

  const continueReading = $derived((() => {
    const seen = new Set<number>();
    const out: HistoryEntry[] = [];
    for (const entry of store.history) {
      if (seen.has(entry.mangaId)) continue;
      seen.add(entry.mangaId);
      out.push(entry);
      if (out.length >= 10) break;
    }
    return out;
  })());

  type HomeContinueDisplayCard =
    | {
        kind: "manga";
        ts: number;
        eyebrow: string;
        title: string;
        subtitle: string;
        metricValue: string;
        metricLabel: string;
        coverUrl: string;
        progressPct: number;
        entry: HistoryEntry;
        manga: Manga;
        book: null;
        progress: null;
      }
    | {
        kind: "book";
        ts: number;
        eyebrow: string;
        title: string;
        subtitle: string;
        metricValue: string;
        metricLabel: string;
        coverUrl: string;
        progressPct: number;
        entry: null;
        manga: null;
        book: BookEntry;
        progress: BookProgress;
      }
    | {
        kind: "placeholder";
        ts: number;
        eyebrow: string;
        title: string;
        subtitle: string;
        metricValue: string;
        metricLabel: string;
        coverUrl: "";
        progressPct: 0;
        entry: null;
        manga: null;
        book: null;
        progress: null;
      };

  const continueCards = $derived((() => {
    const mangaCards = continueReading
      .map((entry, index) => {
        const manga = libraryManga.find((candidate) => candidate.id === entry.mangaId) ?? null;
        if (!manga) return null;
        const metric = extractMetricValue(entry, manga, "");
        return {
          kind: "manga" as const,
          ts: entry.readAt,
          eyebrow: index === 0 ? "In Progress" : index === 1 ? "Resume" : "Library",
          title: entry.mangaTitle,
          subtitle: manga.author ?? "",
          metricValue: metric.value,
          metricLabel: metric.label,
          coverUrl: resolveMangaCoverUrl(entry.thumbnailUrl, {
            context: "home",
            persistence: "persistent",
            cacheGeneration: store.libraryCoverCacheGeneration,
          }),
          progressPct: manga.chapterCount ? Math.min(92, Math.max(10, Math.round((Number(metric.value || 0) / Math.max(manga.chapterCount, 1)) * 100))) : 0,
          entry,
          manga,
          book: null,
          progress: null,
        } satisfies HomeContinueDisplayCard;
      })
      .filter((item): item is Extract<HomeContinueDisplayCard, { kind: "manga" }> => Boolean(item));

    const bookCards = libraryBooks
      .map((book) => {
        const progress = bookProgressById.get(book.id);
        if (!progress || (progress.progressPercent ?? 0) <= 0) return null;
        const presented = presentBook(book, progress);
        return {
          kind: "book" as const,
          ts: progress.lastReadAt || book.updatedAt || book.createdAt,
          eyebrow: presented.readPercent >= 0.8 ? "Resume" : "In Progress",
          title: presented.title,
          subtitle: presented.authorLabel,
          metricValue: presented.readPercentLabel,
          metricLabel: presented.sectionCount > 0 ? presented.sectionCountLabel : presented.pageCountLabel,
          coverUrl: presented.coverSrc ?? "",
          progressPct: Math.max(10, Math.round(presented.readPercent * 100)),
          entry: null,
          manga: null,
          book,
          progress,
        } satisfies HomeContinueDisplayCard;
      })
      .filter((item): item is Extract<HomeContinueDisplayCard, { kind: "book" }> => Boolean(item));

    return [...mangaCards, ...bookCards]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 3);
  })());
  const continueDisplayCards: HomeContinueDisplayCard[] = $derived.by(() => {
    const cards = [...continueCards] as HomeContinueDisplayCard[];
    while (cards.length < 3) {
      cards.push({
        kind: "placeholder",
        ts: 0,
        eyebrow: "",
        title: "",
        subtitle: "",
        metricValue: "",
        metricLabel: "",
        coverUrl: "",
        progressPct: 0,
        entry: null,
        manga: null,
        book: null,
        progress: null,
      } satisfies HomeContinueDisplayCard);
    }
    return cards.slice(0, 3) as HomeContinueDisplayCard[];
  });

  type HomeRecentUpdateRow =
    | {
        kind: "manga";
        ts: number;
        title: string;
        subtitle: string;
        meta: string;
        coverUrl: string;
        manga: Manga | null;
        book: null;
        progress: null;
        entry: HistoryEntry | null;
      }
    | {
        kind: "book";
        ts: number;
        title: string;
        subtitle: string;
        meta: string;
        coverUrl: string;
        manga: null;
        book: BookEntry;
        progress: BookProgress;
        entry: null;
      };

  const recentUpdates = $derived((() => {
    const mangaRows = store.history.slice(0, 4).map((real) => ({
      kind: "manga" as const,
      ts: real.readAt,
      title: real.mangaTitle,
      subtitle: real.chapterName,
      meta: timeAgo(real.readAt),
      coverUrl: resolveMangaCoverUrl(real, {
        context: "home",
        persistence: "persistent",
        cacheGeneration: store.libraryCoverCacheGeneration,
      }),
      manga: libraryManga.find((candidate) => candidate.id === real.mangaId) ?? null,
      book: null,
      progress: null,
      entry: real,
    } satisfies HomeRecentUpdateRow));

    const bookRows = libraryBooks
      .map((book) => {
        const progress = bookProgressById.get(book.id);
        if (!progress || (progress.progressPercent ?? 0) <= 0) return null;
        const presented = presentBook(book, progress);
        return {
          kind: "book" as const,
          ts: progress.lastReadAt,
          title: presented.title,
          subtitle: presented.progressSummary,
          meta: timeAgo(progress.lastReadAt),
          coverUrl: presented.coverSrc ?? "",
          manga: null,
          book,
          progress,
          entry: null,
        } satisfies HomeRecentUpdateRow;
      })
      .filter((item): item is Extract<HomeRecentUpdateRow, { kind: "book" }> => Boolean(item));

    return [...mangaRows, ...bookRows]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 4);
  })());
  const recentUpdateDisplayRows = $derived(recentUpdates);
  const completedCategory = $derived(normalizeCategories(store.categories).find(isCompletedCategory) ?? null);
  const finishedIds = $derived(
    buildCompletedLibraryIds(
      libraryManga,
      completedCategory?.mangas?.nodes ?? [],
      trackedCompletedIds,
      trackedChapterTotalsByMangaId,
    ),
  );
  const completedManga = $derived(libraryManga.filter((manga) => finishedIds.has(manga.id)).slice(0, 3));
  const completedBooks = $derived(
    libraryBooks.filter((book) => {
      const progress = bookProgressById.get(book.id);
      return !!progress && progress.progressPercent >= 1;
    }),
  );
  const stats = $derived(store.readingStats);
  const archiveLibraryTitleCount = $derived(libraryManga.length + libraryBooks.length);
  const archiveReadTitleCount = $derived.by(() => {
    const mangaIds = new Set(store.history.map((entry) => entry.mangaId));
    const bookIds = new Set(
      store.bookProgress
        .filter((progress) => progress.progressPercent > 0)
        .map((progress) => progress.bookId),
    );
    return mangaIds.size + bookIds.size;
  });
  const thisWeekSeriesCount = $derived.by(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    const startMs = start.getTime();
    const unique = new Set<string>();
    for (const entry of store.history) {
      if (entry.readAt >= startMs) {
        unique.add(`m:${entry.mangaId}`);
      }
    }
    for (const progress of store.bookProgress) {
      if (progress.lastReadAt >= startMs) {
        unique.add(`b:${progress.bookId}`);
      }
    }
    return unique.size;
  });
  const weeklyActivity = $derived((() => {
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - (6 - index));
      return day.getTime();
    });
    const counts = days.map(() => 0);
    for (const entry of store.history) {
      const stamp = new Date(entry.readAt);
      stamp.setHours(0, 0, 0, 0);
      const idx = days.indexOf(stamp.getTime());
      if (idx >= 0) counts[idx] += 1;
    }
    for (const progress of store.bookProgress) {
      if (!progress.lastReadAt) continue;
      const stamp = new Date(progress.lastReadAt);
      stamp.setHours(0, 0, 0, 0);
      const idx = days.indexOf(stamp.getTime());
      if (idx >= 0) counts[idx] += 1;
    }
    const max = Math.max(...counts, 1);
    return counts.map((count, index) => ({
      label: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index],
      height: `${Math.max(14, Math.round((count / max) * 100))}%`,
      isToday: index === 6,
    }));
  })());

  function extractMetricValue(entry: HistoryEntry, manga: Manga | null, fallback: string): { value: string; label: string } {
    const numeric = entry.chapterName.match(/(\d+(?:\.\d+)?)/)?.[1] ?? fallback;
    const total = manga?.chapterCount ? `/ ${manga.chapterCount} chapters` : "/ chapters";
    return { value: numeric, label: total };
  }

  type HomeFinishedRow =
    | { kind: "manga"; title: string; subtitle: string; meta: string; coverUrl: string; manga: Manga | null; book: null; progress: null }
    | { kind: "book"; title: string; subtitle: string; meta: string; coverUrl: string; manga: null; book: BookEntry; progress: BookProgress };

  const finishedDisplayRows = $derived((() => {
    const mangaRows = completedManga.map((real) => ({
      kind: "manga" as const,
      title: real.title,
      subtitle: `${real.chapterCount ?? 0} chapters`,
      meta: "Done",
      coverUrl: resolveMangaCoverUrl(real, {
        context: "home",
        persistence: "persistent",
        cacheGeneration: store.libraryCoverCacheGeneration,
      }),
      manga: real,
      book: null,
      progress: null,
    } satisfies HomeFinishedRow));

    const bookRows = libraryBooks
      .map((book) => {
        const progress = bookProgressById.get(book.id);
        if (!progress || progress.progressPercent < 100) return null;
        const presented = presentBook(book, progress);
        return {
          kind: "book" as const,
          title: presented.title,
          subtitle: presented.progressSummary,
          meta: "Done",
          coverUrl: presented.coverSrc ?? "",
          manga: null,
          book,
          progress,
        } satisfies HomeFinishedRow;
      })
      .filter((item): item is Extract<HomeFinishedRow, { kind: "book" }> => Boolean(item));

    return [...mangaRows, ...bookRows].slice(0, 2);
  })());

  const archiveFinishedCount = $derived(Math.max(stats.totalMangaRead, archiveReadTitleCount));
  const archiveTotalCount = $derived(Math.max(archiveLibraryTitleCount, archiveReadTitleCount, stats.totalMangaRead));
  const archiveCompletionRatio = $derived(
    archiveTotalCount > 0 ? Math.round((archiveFinishedCount / archiveTotalCount) * 100) : 0,
  );
  type HomeSourceDisplay = {
    source: Source;
    extension: Extension | null;
    state: "online" | "slow" | "offline" | "neutral";
  };

  const visibleHomeSources = $derived((() => {
    const deduped = dedupeSources(homeSources, store.settings.preferredExtensionLang || "en");
    const extensionsByKey = new Map(
      homeExtensions.map((extension) => {
        const key = `${normalizeExtensionSourceKey(extension.name)}::${(extension.lang || "").toLowerCase()}`;
        return [key, extension] as const;
      }),
    );

    return deduped.slice(0, 4).map((source) => {
      const baseKey = normalizeExtensionSourceKey(source.name || source.displayName || source.id);
      const langKey = (source.lang || "").toLowerCase();
      const extension =
        extensionsByKey.get(`${baseKey}::${langKey}`) ??
        extensionsByKey.get(`${baseKey}::all`) ??
        [...extensionsByKey.entries()].find(([key]) => key.startsWith(`${baseKey}::`))?.[1] ??
        null;

      const state: HomeSourceDisplay["state"] =
        source.id === "0"
          ? "neutral"
          : !extension
            ? "offline"
            : extension.isObsolete
              ? "offline"
              : extension.hasUpdate
                ? "slow"
                : extension.isInstalled
                  ? "online"
                  : "offline";

      return { source, extension, state } satisfies HomeSourceDisplay;
    });
  })());
  const connectedTrackers = $derived(homeTrackers.filter((tracker) => tracker.isLoggedIn));
  const displayTrackers = $derived(homeTrackers.slice(0, 3));
  const trackedTitleCount = $derived(trackedCompletedIds.size);

  const activeDownloadCount = $derived(store.activeDownloads.filter((item) => item.state === "DOWNLOADING").length);
  const queuedDownloadCount = $derived(store.activeDownloads.filter((item) => item.state === "QUEUED").length);
  const pausedDownloadCount = $derived(store.activeDownloads.filter((item) => item.state === "PAUSED").length);
  const sourceReadyCount = $derived.by(() => {
    const count = setupState && "usableSourceCount" in setupState ? setupState.usableSourceCount : null;
    return count ?? visibleHomeSources.length;
  });
  const browseSourcesSummary = $derived(
    sourceReadyCount > 0
      ? `${sourceReadyCount} sources ready`
      : "No sources ready",
  );
  const titlesWithUnreadCount = $derived(
    libraryManga.filter((manga) => (manga.unreadCount ?? 0) > 0).length,
  );
  const booksInProgressCount = $derived(
    libraryBooks.filter((book) => {
      const progress = bookProgressById.get(book.id);
      return !!progress && progress.progressPercent > 0 && progress.progressPercent < 100;
    }).length,
  );
  const booksToReadCount = $derived(
    libraryBooks.filter((book) => {
      const progress = bookProgressById.get(book.id);
      return !progress || progress.progressPercent <= 0;
    }).length,
  );
  const checkUpdatesSummary = $derived(
    titlesWithUnreadCount + booksInProgressCount > 0
      ? `${titlesWithUnreadCount + booksInProgressCount} titles with unread chapters/pages`
      : "Library is up to date",
  );
  const startedMangaIds = $derived(new Set(store.history.map((entry) => entry.mangaId)));
  const mangaToReadCount = $derived(
    libraryManga.filter((manga) => !startedMangaIds.has(manga.id) && !finishedIds.has(manga.id)).length,
  );
  const planToReadCount = $derived(
    mangaToReadCount + booksToReadCount,
  );
  const planToReadSummary = $derived(
    planToReadCount > 0 ? `${planToReadCount} titles waiting` : "Nothing queued to start",
  );
  const downloadSummary = $derived(
    activeDownloadCount || queuedDownloadCount || pausedDownloadCount
      ? [
          activeDownloadCount ? `${activeDownloadCount} active` : "",
          queuedDownloadCount ? `${queuedDownloadCount} queued` : "",
          pausedDownloadCount ? `${pausedDownloadCount} paused` : "",
        ].filter(Boolean).join(" · ")
      : "",
  );

  async function resumeEntry(entry: HistoryEntry) {
    try {
      const data = await gql<{ chapters: { nodes: any[] } }>(
        `query($mangaId:LongString!){ chapters(condition:{mangaId:$mangaId}){ nodes { id mangaId chapterNumber sourceOrder url name isRead uploadDate pageCount pagesFetched scanlator sourceId } } }`,
        { mangaId: entry.mangaId },
      );
      const chapters = [...data.chapters.nodes].sort((a, b) => a.sourceOrder - b.sourceOrder);
      const chapter = chapters.find((candidate) => candidate.id === entry.chapterId) ?? chapters[0];
      if (chapter) {
        const mangaContext = {
          id: entry.mangaId,
          title: entry.mangaTitle,
          thumbnailUrl: entry.thumbnailUrl,
        } as any;
        openReader(chapter, chapters as any, mangaContext);
      }
    } catch {
      store.activeManga = {
        id: entry.mangaId,
        title: entry.mangaTitle,
        thumbnailUrl: entry.thumbnailUrl,
      } as any;
    }
  }

  function openBookEntry(book: BookEntry, progress: BookProgress) {
    void progress;
    setActiveBookId(book.id);
    openBookReader(book.id);
  }

  function openContinueItem(item: HomeContinueDisplayCard) {
    if (item.kind === "manga" && item.manga) {
      setPreviewManga(item.manga);
      return;
    }
    if (item.kind === "book" && item.book && item.progress) {
      openBookEntry(item.book, item.progress);
    }
  }

  function openRecentItem(row: HomeRecentUpdateRow) {
    if (row.kind === "manga" && row.entry) {
      void resumeEntry(row.entry);
      return;
    }
    if (row.kind === "book" && row.book && row.progress) {
      openBookEntry(row.book, row.progress);
    }
  }

  function openFinishedItem(row: HomeFinishedRow) {
    if (row.kind === "manga" && row.manga) {
      setPreviewManga(row.manga);
      return;
    }
    if (row.kind === "book" && row.book && row.progress) {
      openBookEntry(row.book, row.progress);
    }
  }

</script>

<div class="root n-page-shell home-nocturne" class:is-search-engaged={homeSearchFocused}>
  <AppTopbar className="home-topbar">
    {#snippet center()}
      <div class="n-search" data-component="search-bar">
        <span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>
        <input
          class="n-search__input"
          type="text"
          placeholder="Search archive..."
          bind:value={homeSearch}
          onfocus={handleHomeSearchFocus}
          onblur={handleHomeSearchBlur}
          onkeydown={(event) => event.key === "Enter" && submitHomeSearch()}
        />
      </div>
    {/snippet}
    {#snippet right()}
      <button
        class="n-icon-btn home-notification-btn"
        class:has-new-activity={newActivityCount > 0}
        type="button"
        title="Recent activity"
        aria-label={newActivityCount > 0 ? `Recent activity, ${newActivityCount} new` : "Recent activity"}
        onclick={handleOpenHomeHistory}
      >
        <span class="material-symbols-outlined" aria-hidden="true">notifications</span>
        {#if newActivityCount > 0}
          <span class="home-notification-badge" aria-hidden="true">{newActivityBadge}</span>
        {/if}
      </button>
      <button class="n-icon-btn" type="button" title="Downloads" aria-label="Downloads" onclick={() => setNavPage("downloads")}>
        <span class="material-symbols-outlined" aria-hidden="true">download</span>
      </button>
      <WindowControlsInline />
    {/snippet}
  </AppTopbar>

  <div class="body n-content">
    {#if store.homePanelHint === "history"}
      <div class="home-history-view">
        <div class="home-history-view__header">
          <button class="home-history-back" onclick={openHomeDashboard}>
            <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
            Back to Home
          </button>
        </div>
        <div class="home-history-view__content">
          <RecentActivity />
        </div>
      </div>
    {:else}
      <div class="home-dashboard">
        <section class="home-section">
          <div class="home-section__header">
            <h2 class="home-section__title">Continue Reading</h2>
            <button class="home-link-btn" type="button" onclick={() => setNavPage("library")}>
              View Library
            </button>
          </div>
          <div class="home-continue-grid">
            {#each continueDisplayCards as item, index (index)}
              <article class="home-card home-continue-card">
                {#if item.kind === "placeholder"}
                  <div class="home-continue-card__cover home-continue-card__cover--blank" aria-hidden="true">
                    <div class="home-continue-card__progress-track">
                      <div class="home-continue-card__progress-fill" style="width:0%;"></div>
                    </div>
                  </div>
                {:else if item.coverUrl && (item.manga || item.book)}
                  <button
                    class="home-continue-card__cover"
                    type="button"
                    onclick={() => openContinueItem(item)}
                  >
                    <img src={item.coverUrl} alt={`${item.title} cover`} loading="lazy" decoding="async" />
                    <div class="home-continue-card__progress-track">
                      <div class="home-continue-card__progress-fill" style={`width:${item.progressPct}%;`}></div>
                    </div>
                  </button>
                {:else}
                  <div class="home-continue-card__cover home-continue-card__cover--blank" aria-hidden="true">
                    <div class="home-continue-card__progress-track">
                      <div class="home-continue-card__progress-fill" style="width:0%;"></div>
                    </div>
                  </div>
                {/if}
                <div class="home-continue-card__body">
                  {#if item.kind === "placeholder"}
                    <div class="home-continue-card__copy home-continue-card__copy--blank" aria-hidden="true"></div>
                  {:else}
                    <div class="home-continue-card__copy">
                      <span class="home-card__eyebrow">{item.eyebrow}</span>
                      <h3>{item.title}</h3>
                      <p>{item.subtitle}</p>
                    </div>
                  {/if}
                  <div>
                    <div class="home-continue-card__metrics">
                      <span>{item.metricValue}</span>
                      <small>{item.metricLabel}</small>
                    </div>
                    <button
                      class="n-btn n-btn-primary n-btn--md home-primary-btn home-resume-btn"
                      type="button"
                      onclick={() => openContinueItem(item)}
                      data-inert-control={item.kind === "placeholder" ? "home-continue-placeholder" : undefined}
                    >
                      <span class="material-symbols-outlined" aria-hidden="true">play_arrow</span>
                      <span>Resume</span>
                    </button>
                  </div>
                </div>
              </article>
            {/each}
          </div>
        </section>

        <section class="home-quick-actions">
          <button class="home-quick-action" type="button" onclick={() => openSearchSources("browse")}>
            <span class="material-symbols-outlined" aria-hidden="true">explore</span>
            <div>
              <strong>Browse Sources</strong>
              <small>{browseSourcesSummary}</small>
            </div>
          </button>
          <button class="home-quick-action" type="button" onclick={() => setNavPage("downloads")}>
            <span class="material-symbols-outlined" aria-hidden="true">download</span>
            <div>
              <strong>Downloads</strong>
              <small>{downloadSummary}</small>
            </div>
          </button>
          <button class="home-quick-action" type="button" onclick={openCheckUpdates}>
            <span class="material-symbols-outlined" aria-hidden="true">sync</span>
            <div>
              <strong>Check Updates</strong>
              <small>{checkUpdatesSummary}</small>
            </div>
          </button>
          <button class="home-quick-action" type="button" onclick={openPlanToRead}>
            <span class="material-symbols-outlined" aria-hidden="true">bookmark_border</span>
            <div>
              <strong>Plan to Read</strong>
              <small>{planToReadSummary}</small>
            </div>
          </button>
        </section>

        <div class="home-main-grid">
          <section class="home-column home-updates">
            <div class="home-column__header">
              <h2 class="home-column__title">
                <span class="material-symbols-outlined" aria-hidden="true">notifications_active</span>
                Recent Updates
              </h2>
            </div>
            <div class="home-updates-list">
            {#if recentUpdateDisplayRows.length > 0}
                {#each recentUpdateDisplayRows as row, index (index)}
                  <button
                    class="home-update-row home-finished-row--card"
                    type="button"
                    onclick={() => openRecentItem(row)}
                  >
                    <img class="home-update-row__thumb" src={row.coverUrl} alt={row.title} loading="lazy" decoding="async" />
                    <div class="home-update-row__copy">
                      <strong>{row.title}</strong>
                      <span>{row.subtitle}</span>
                    </div>
                    <small>{row.meta}</small>
                  </button>
                {/each}
              {:else}
                <div class="home-empty-slot home-finished-row--card" aria-hidden="true"></div>
                <div class="home-empty-slot home-finished-row--card" aria-hidden="true"></div>
                <div class="home-empty-slot home-finished-row--card" aria-hidden="true"></div>
              {/if}
            </div>
          </section>

          <div class="home-column home-middle-stack">
            <section>
              <div class="home-column__header">
                <h2 class="home-column__title">
                  <span class="material-symbols-outlined" aria-hidden="true">bar_chart</span>
                  This Week
                </h2>
              </div>
              <div class="home-card home-week-card">
                <div class="home-week-card__stats">
                  <div>
                    <strong>{stats.totalChaptersRead}</strong>
                    <small>Chapters</small>
                  </div>
                  <div>
                    <strong>{formatReadTime(stats.totalMinutesRead)}</strong>
                    <small>Read time</small>
                  </div>
                <div>
                    <strong>{Math.max(thisWeekSeriesCount, 1)}</strong>
                    <small>Series</small>
                  </div>
                </div>
                <div class="home-week-card__bars">
                  {#each weeklyActivity as day}
                    <div class="home-week-card__bar-slot">
                      <div class="home-week-card__bar" class:is-today={day.isToday} style={`height:${day.height};`}></div>
                      <span>{day.label}</span>
                    </div>
                  {/each}
                </div>
              </div>
            </section>

            <section>
              <div class="home-column__header">
                <h2 class="home-column__title">
                  <span class="material-symbols-outlined" aria-hidden="true">check_circle</span>
                  Recently Finished
                </h2>
              </div>
              <div class="home-finished-list">
                {#if finishedDisplayRows.length > 0}
                {#each finishedDisplayRows as row, index (index)}
                  <button
                    class="home-finished-row home-finished-row--card"
                    type="button"
                    onclick={() => openFinishedItem(row)}
                  >
                    <img src={row.coverUrl} alt={row.title} loading="lazy" decoding="async" />
                    <div class="home-finished-row__copy">
                      <strong>{row.title}</strong>
                        <span>{row.subtitle}</span>
                      </div>
                      <span class="home-finished-row__tag">{row.meta}</span>
                    </button>
                  {/each}
                {:else}
                  <div class="home-empty-slot home-finished-row--card" aria-hidden="true"></div>
                  <div class="home-empty-slot home-finished-row--card" aria-hidden="true"></div>
                {/if}
              </div>
            </section>
          </div>

          <aside class="home-column home-side-stack">
            <section class="home-card home-side-card">
              <h3 class="home-side-card__title">Archive</h3>
              <div class="home-side-card__metric">
                <strong>{stats.totalChaptersRead}</strong>
                <small>Chapters read</small>
              </div>
              <div class="home-side-card__separator"></div>
              <div class="home-side-card__progress">
                <div class="home-side-card__progress-head">
                  <span>{archiveFinishedCount} complete</span>
                  <small>{archiveCompletionRatio}%</small>
                </div>
                <span class="home-side-card__storage-label">Storage</span>
                <div class="home-side-card__progress-track">
                  <div class="home-side-card__progress-fill" style={`width:${archiveCompletionRatio}%;`}></div>
                </div>
              </div>
              <div class="home-side-card__split">
                <div>
                  <strong>{archiveTotalCount}</strong>
                  <small>Titles</small>
                </div>
                <div>
                  <strong>{setupState?.usableSourceCount ?? 0}</strong>
                  <small>Sources</small>
                </div>
              </div>
            </section>

            <section class="home-card home-side-card">
              <h3 class="home-side-card__title">Sources</h3>
              {#if visibleHomeSources.length > 0}
                <ul class="home-source-list">
                  {#each visibleHomeSources as item (item.source.id)}
                    <li>
                      <span class={`home-status-dot is-${item.state}`}></span>
                      <span class="home-source-list__name">{formatHomeSourceName(item.source)}</span>
                      <small>{formatHomeSourceMeta(item.source)}</small>
                    </li>
                  {/each}
                </ul>
              {:else}
                <div class="home-side-card__blank"></div>
              {/if}
            </section>

            <section class="home-card home-side-card">
              <h3 class="home-side-card__title">Tracking</h3>
              {#if displayTrackers.length > 0}
                <ul class="home-tracking-list">
                  {#each displayTrackers as tracker (tracker.id)}
                    <li>
                      <span>{tracker.name}</span>
                      <small class:is-synced={tracker.isLoggedIn} class:is-muted={!tracker.isLoggedIn}>
                        {tracker.isLoggedIn ? "Connected" : "Not connected"}
                      </small>
                    </li>
                  {/each}
                  {#if trackedTitleCount > 0}
                    <li>
                      <span>Tracked titles</span>
                      <small class="is-synced">{trackedTitleCount} synced</small>
                    </li>
                  {/if}
                </ul>
              {:else}
                <div class="home-side-card__blank"></div>
              {/if}
            </section>
          </aside>
        </div>
      </div>
    {/if}
  </div>
  <div class="n-search-dim home-search-dim" class:is-active={homeSearchFocused}></div>
</div>

<style>
  .root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .home-nocturne {
    background: transparent;
  }

  .home-continue-card__cover--blank {
    cursor: default;
  }

  .home-search-dim {
    position: fixed;
    inset: 0;
    z-index: 61;
    background: transparent;
    opacity: 1;
    pointer-events: none;
    transition: opacity 250ms ease;
  }

  .home-search-dim.is-active {
    pointer-events: auto;
  }

  :global(body.aethon-home-search-engaged .aethon-app-shell::after) {
    opacity: 1;
  }

  :global(body.aethon-home-search-engaged .n-topbar .n-topbar__center) {
    position: relative;
    z-index: 62;
  }

  :global(body.aethon-home-search-engaged .n-topbar .n-search) {
    position: relative;
    z-index: 63;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .home-dashboard {
    width: min(1600px, 100%);
    margin: 0 auto;
    padding: var(--app-shell-block-pad) var(--app-shell-inline-pad) calc(46px * var(--n-hud-scale));
    display: flex;
    flex-direction: column;
    gap: var(--app-shell-section-gap);
  }

  .home-section,
  .home-column {
    min-width: 0;
  }

  .home-section__header,
  .home-column__header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: calc(18px * var(--n-hud-scale));
  }

  .home-section__title,
  .home-column__title {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: calc(8px * var(--n-hud-scale));
    font-size: calc(20px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--n-on-surface);
  }
  .home-link-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: calc(32px * var(--n-hud-scale));
    padding: 0 calc(14px * var(--n-hud-scale));
    border-radius: calc(10px * var(--n-hud-scale));
    border: 1px solid transparent;
    background: transparent;
    color: var(--n-primary-container);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 140ms ease, border-color 140ms ease, background 140ms ease, transform 120ms ease;
  }

  .home-link-btn:hover {
    color: rgba(239, 235, 245, 0.96);
    border-color: rgba(72, 69, 79, 0.18);
    background: rgba(255, 255, 255, 0.035);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }

  .home-link-btn:active {
    transform: scale(0.97);
  }

  .home-card {
    position: relative;
    overflow: hidden;
  }

  .home-card__eyebrow {
    display: block;
    margin-bottom: 8px;
    color: var(--n-primary-container);
    font-size: calc(10px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .home-continue-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: calc(24px * var(--n-hud-scale));
  }

  .home-continue-card {
    display: flex;
    gap: calc(20px * var(--n-hud-scale));
    padding: calc(20px * var(--n-hud-scale));
    min-height: calc(192px * var(--n-hud-scale));
    width: 100%;
    border-radius: calc(16px * var(--n-hud-scale));
    border: 1px solid rgba(72, 69, 79, 0.05);
    background: rgba(28, 27, 27, 0.8);
    transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms ease, background 200ms ease;
  }

  .home-continue-card:hover {
    transform: translateY(calc(-4px * var(--n-hud-scale)));
    box-shadow: 0 calc(12px * var(--n-hud-scale)) calc(32px * var(--n-hud-scale)) rgba(0, 0, 0, 0.25), 0 0 calc(20px * var(--n-hud-scale)) rgba(184, 167, 234, 0.04);
  }

  .home-continue-card__cover {
    position: relative;
    width: clamp(calc(82px * var(--n-hud-scale)), 28%, calc(112px * var(--n-hud-scale)));
    min-width: clamp(calc(82px * var(--n-hud-scale)), 28%, calc(112px * var(--n-hud-scale)));
    height: auto;
    aspect-ratio: 0.7;
    padding: 0;
    border: none;
    border-radius: calc(12px * var(--n-hud-scale));
    overflow: hidden;
    background: rgba(36, 33, 43, 0.7);
    cursor: pointer;
  }

  .home-continue-card__cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 380ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .home-continue-card:hover .home-continue-card__cover img {
    transform: scale(1.05);
  }

  .home-continue-card__progress-track {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(5px * var(--n-hud-scale));
    background: rgba(255, 255, 255, 0.1);
  }

  .home-continue-card__progress-fill {
    height: 100%;
    background: linear-gradient(135deg, #b8a7ea 0%, #d3c4ff 100%);
  }

  .home-continue-card__body {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    justify-content: space-between;
    gap: calc(16px * var(--n-hud-scale));
  }

  .home-continue-card__copy h3 {
    margin: 0 0 6px;
    color: var(--n-on-surface);
    font-size: calc(17px * var(--n-hud-scale));
    font-weight: 800;
    line-height: 1.2;
  }

  .home-continue-card__copy p {
    margin: 0;
    color: rgba(202, 196, 208, 0.55);
    font-size: calc(12px * var(--n-hud-scale));
    line-height: 1.4;
  }

  .home-continue-card__metrics {
    display: flex;
    align-items: baseline;
    gap: calc(6px * var(--n-hud-scale));
    margin-bottom: calc(12px * var(--n-hud-scale));
  }

  .home-continue-card__metrics span {
    color: var(--n-primary);
    font-size: calc(24px * var(--n-hud-scale));
    font-weight: 800;
    line-height: 1;
  }

  .home-continue-card__metrics small {
    color: rgba(202, 196, 208, 0.46);
    font-size: calc(10px * var(--n-hud-scale));
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .home-primary-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(8px * var(--n-hud-scale));
    width: 100%;
    min-height: calc(40px * var(--n-hud-scale));
    padding: 0 calc(24px * var(--n-hud-scale));
    border: none;
    border-radius: calc(12px * var(--n-hud-scale));
    background: var(--n-gradient-primary);
    color: var(--n-on-primary);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    box-shadow: 0 calc(4px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale)) rgba(184, 167, 234, 0.18);
    transition: filter 140ms ease, box-shadow 140ms ease, transform 140ms ease;
  }

  .home-primary-btn:hover:not(:disabled) {
    filter: brightness(1.1);
    box-shadow: 0 calc(6px * var(--n-hud-scale)) calc(20px * var(--n-hud-scale)) rgba(184, 167, 234, 0.28);
    transform: translateY(-1px);
  }

  .home-primary-btn:active:not(:disabled) {
    transform: scale(0.95) translateY(0);
    box-shadow: 0 calc(2px * var(--n-hud-scale)) calc(8px * var(--n-hud-scale)) rgba(184, 167, 234, 0.15);
  }

  .home-secondary-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(8px * var(--n-hud-scale));
    min-height: calc(40px * var(--n-hud-scale));
    padding: 0 calc(20px * var(--n-hud-scale));
    border-radius: calc(12px * var(--n-hud-scale));
    background: rgba(255, 255, 255, 0.02);
    color: var(--n-on-surface-variant);
    border: 1px solid rgba(202, 196, 208, 0.12);
    transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 120ms ease, box-shadow 140ms ease;
  }

  .home-secondary-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.04);
    color: var(--n-on-surface);
    border-color: rgba(184, 167, 234, 0.14);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  .home-secondary-btn:active:not(:disabled) {
    transform: scale(0.96);
  }

  .home-quick-actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: calc(12px * var(--n-hud-scale));
  }

  .home-quick-action {
    display: flex;
    align-items: center;
    gap: calc(14px * var(--n-hud-scale));
    padding: calc(16px * var(--n-hud-scale));
    border-radius: calc(12px * var(--n-hud-scale));
    border: 1px solid rgba(72, 69, 79, 0.05);
    background: rgba(28, 27, 27, 0.4);
    color: inherit;
    text-align: left;
    cursor: pointer;
    width: 100%;
    transition: background 140ms ease, transform 180ms ease;
  }

  .home-quick-action:hover {
    background: rgba(28, 27, 27, 0.8);
    transform: translateY(calc(-1px * var(--n-hud-scale)));
  }

  .home-quick-action .material-symbols-outlined {
    color: rgba(202, 196, 208, 0.54);
    font-size: calc(22px * var(--n-hud-scale));
  }

  .home-quick-action strong {
    display: block;
    margin-bottom: 2px;
    color: var(--n-on-surface);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 800;
  }

  .home-quick-action small {
    color: rgba(202, 196, 208, 0.42);
    font-size: calc(10px * var(--n-hud-scale));
  }

  .home-main-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(calc(260px * var(--n-hud-scale)), calc(280px * var(--n-hud-scale)));
    gap: calc(30px * var(--n-hud-scale));
    align-items: start;
  }

  .home-middle-stack,
  .home-side-stack {
    display: flex;
    flex-direction: column;
    gap: calc(24px * var(--n-hud-scale));
  }

  .home-updates-card,
  .home-week-card,
  .home-finished-card,
  .home-side-card {
    padding: calc(16px * var(--n-hud-scale));
    border-radius: calc(12px * var(--n-hud-scale));
    border: 1px solid rgba(72, 69, 79, 0.05);
    background: rgba(28, 27, 27, 0.4);
  }

  .home-updates-list,
  .home-finished-list {
    display: flex;
    flex-direction: column;
    gap: calc(8px * var(--n-hud-scale));
  }

  .home-update-row,
  .home-finished-row {
    display: flex;
    align-items: center;
    gap: calc(12px * var(--n-hud-scale));
    width: 100%;
    padding: calc(12px * var(--n-hud-scale));
    background: transparent;
    border: none;
    border-radius: calc(12px * var(--n-hud-scale));
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }

  .home-update-row:hover,
  .home-finished-row:hover {
    background: rgba(184, 167, 234, 0.04);
  }

  .home-finished-row--card {
    border: 1px solid rgba(72, 69, 79, 0.05);
    background: rgba(28, 27, 27, 0.4);
    min-height: calc(80px * var(--n-hud-scale));
  }

  .home-update-row__thumb,
  .home-finished-row img {
    width: calc(40px * var(--n-hud-scale));
    height: calc(56px * var(--n-hud-scale));
    border-radius: calc(10px * var(--n-hud-scale));
    object-fit: cover;
    background: rgba(36, 33, 43, 0.7);
    flex-shrink: 0;
  }

  .home-update-row__copy,
  .home-finished-row__copy {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 4px;
  }

  .home-update-row__copy strong,
  .home-finished-row__copy strong {
    color: var(--n-on-surface);
    font-size: calc(12px * var(--n-hud-scale));
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .home-update-row__copy span,
  .home-finished-row__copy span {
    color: rgba(202, 196, 208, 0.46);
    font-size: calc(11px * var(--n-hud-scale));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .home-update-row small {
    color: rgba(202, 196, 208, 0.32);
    font-size: calc(9px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .home-week-card__stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: calc(18px * var(--n-hud-scale));
    margin-bottom: calc(18px * var(--n-hud-scale));
  }

  .home-week-card__stats strong {
    display: block;
    color: var(--n-on-surface);
    font-size: calc(22px * var(--n-hud-scale));
    font-weight: 300;
    line-height: 1;
  }

  .home-week-card__stats small {
    color: rgba(202, 196, 208, 0.34);
    font-size: calc(9px * var(--n-hud-scale));
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .home-week-card__bars {
    display: flex;
    align-items: end;
    gap: calc(8px * var(--n-hud-scale));
    height: calc(70px * var(--n-hud-scale));
  }

  .home-week-card__bar-slot {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: calc(6px * var(--n-hud-scale));
    justify-content: end;
    height: 100%;
  }

  .home-week-card__bar {
    width: 100%;
    border-radius: calc(10px * var(--n-hud-scale)) calc(10px * var(--n-hud-scale)) 0 0;
    background: rgba(184, 167, 234, 0.18);
    min-height: calc(12px * var(--n-hud-scale));
  }

  .home-week-card__bar.is-today {
    background: linear-gradient(135deg, #b8a7ea 0%, #d3c4ff 100%);
  }

  .home-week-card__bar-slot span {
    color: rgba(202, 196, 208, 0.26);
    font-size: calc(8px * var(--n-hud-scale));
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .home-finished-row__tag {
    color: rgba(184, 167, 234, 0.68);
    font-size: calc(9px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .home-side-card {
    display: flex;
    flex-direction: column;
    gap: calc(14px * var(--n-hud-scale));
    min-height: 0;
  }

  .home-side-card__title {
    margin: 0;
    color: rgba(202, 196, 208, 0.38);
    font-size: calc(10px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .home-side-card__metric strong {
    display: block;
    color: var(--n-on-surface);
    font-size: calc(30px * var(--n-hud-scale));
    font-weight: 300;
    line-height: 1;
    letter-spacing: -0.03em;
  }

  .home-side-card__metric small,
  .home-side-card__body,
  .home-side-card__split small {
    color: rgba(202, 196, 208, 0.38);
    font-size: calc(10px * var(--n-hud-scale));
    line-height: 1.5;
  }

  .home-side-card__body {
    margin: 0;
  }

  .home-side-card__separator {
    height: 1px;
    background: rgba(72, 69, 79, 0.12);
  }

  .home-side-card__progress-head,
  .home-side-card__split {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(12px * var(--n-hud-scale));
  }
  .home-side-card__split strong,
  .home-side-card__progress-head span {
    color: var(--n-on-surface);
    font-size: calc(16px * var(--n-hud-scale));
    font-weight: 300;
  }

  .home-side-card__progress-head small {
    color: rgba(202, 196, 208, 0.32);
    font-size: calc(9px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .home-side-card__progress-track {
    height: calc(5px * var(--n-hud-scale));
    overflow: hidden;
    border-radius: 999px;
    background: rgba(148, 143, 154, 0.08);
  }

  .home-side-card__progress-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(135deg, #b8a7ea 0%, #d3c4ff 100%);
  }

  .home-side-card__storage-label {
    display: block;
    margin: 0 0 calc(8px * var(--n-hud-scale));
    color: rgba(202, 196, 208, 0.34);
    font-size: calc(9px * var(--n-hud-scale));
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .home-source-list,
  .home-tracking-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: calc(10px * var(--n-hud-scale));
  }

  .home-source-list li,
  .home-tracking-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(10px * var(--n-hud-scale));
    color: var(--n-on-surface);
    font-size: calc(11px * var(--n-hud-scale));
  }

  .home-source-list__name,
  .home-tracking-list li span {
    flex: 1;
  }

  .home-source-list li small,
  .home-tracking-list li small {
    color: rgba(202, 196, 208, 0.35);
    font-size: calc(9px * var(--n-hud-scale));
  }

  .home-tracking-list .is-synced {
    color: rgba(184, 167, 234, 0.68);
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .home-tracking-list .is-muted {
    color: rgba(229, 226, 225, 0.52);
  }

  .home-empty-slot {
    min-height: calc(80px * var(--n-hud-scale));
    width: 100%;
    border: 1px solid rgba(72, 69, 79, 0.05);
    background: rgba(28, 27, 27, 0.4);
    border-radius: calc(12px * var(--n-hud-scale));
  }

  .home-side-card__blank {
    min-height: calc(88px * var(--n-hud-scale));
  }

  .home-resume-btn .material-symbols-outlined {
    font-size: calc(15px * var(--n-hud-scale));
    font-variation-settings: "FILL" 1, "wght" 500, "GRAD" 0, "opsz" 20;
    line-height: 1;
  }

  :global(.home-topbar) .home-notification-btn {
    position: relative;
    width: calc(38px * var(--n-hud-scale));
    min-width: calc(38px * var(--n-hud-scale));
    padding-inline: 0;
  }

  .home-notification-badge {
    position: absolute;
    top: calc(6px * var(--n-hud-scale));
    right: calc(7px * var(--n-hud-scale));
    display: block;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: #c9adff;
    text-shadow:
      0 0 calc(7px * var(--n-hud-scale)) rgba(190, 164, 255, 0.95),
      0 0 calc(14px * var(--n-hud-scale)) rgba(155, 117, 255, 0.58);
    font-family: var(--font-sans);
    font-size: calc(13px * var(--n-hud-scale));
    font-weight: 900;
    letter-spacing: 0;
    line-height: 1;
    pointer-events: none;
  }

  :global(.home-topbar) .home-notification-btn.has-new-activity .material-symbols-outlined {
    color: #c9adff;
    text-shadow:
      0 0 calc(8px * var(--n-hud-scale)) rgba(190, 164, 255, 0.95),
      0 0 calc(18px * var(--n-hud-scale)) rgba(155, 117, 255, 0.64);
    font-variation-settings: "FILL" 0, "wght" 500, "GRAD" 0, "opsz" 20;
  }

  .home-history-view {
    display: flex;
    min-height: 100%;
    flex-direction: column;
    padding: calc(24px * var(--n-hud-scale)) calc(28px * var(--n-hud-scale));
    gap: calc(20px * var(--n-hud-scale));
  }

  .home-history-view__content {
    min-height: 0;
    border-radius: calc(12px * var(--n-hud-scale));
    border: 0;
    background: transparent;
    overflow: hidden;
  }

  .home-history-back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 1px solid rgba(72, 69, 79, 0.14);
    border-radius: 999px;
    background: rgba(28, 27, 27, 0.45);
    color: rgba(202, 196, 208, 0.6);
    font-size: calc(11px * var(--n-hud-scale));
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: calc(10px * var(--n-hud-scale)) calc(16px * var(--n-hud-scale));
    cursor: pointer;
  }

  .home-history-back:hover {
    color: var(--n-on-surface);
  }

  @media (max-width: 1440px) {
    .home-main-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }

    .home-side-stack {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (max-width: 1180px) {
    .home-continue-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .home-quick-actions {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .home-main-grid,
    .home-side-stack {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 520px) {
    .home-continue-grid,
    .home-quick-actions {
      grid-template-columns: 1fr;
      justify-items: stretch;
    }

    .home-continue-card,
    .home-quick-action {
      width: 100%;
    }

    .home-resume-btn {
      width: auto;
      min-width: calc(220px * var(--n-hud-scale));
      align-self: flex-start;
    }
  }

  @media (max-width: 460px) {
    .home-continue-card {
      flex-direction: column;
    }

    .home-continue-card__cover {
      width: min(44%, calc(132px * var(--n-hud-scale)));
      min-width: min(44%, calc(132px * var(--n-hud-scale)));
    }

    .home-resume-btn {
      width: 100%;
      min-width: 0;
      align-self: stretch;
    }
  }

  .home-status-dot {
    width: calc(6px * var(--n-hud-scale));
    height: calc(6px * var(--n-hud-scale));
    border-radius: 999px;
    flex-shrink: 0;
  }

  .home-status-dot.is-online {
    background: #4ade80;
  }

  .home-status-dot.is-slow {
    background: #f59e0b;
  }

  .home-status-dot.is-offline {
    background: rgba(239, 68, 68, 0.72);
  }

  .home-status-dot.is-neutral {
    background: rgba(202, 196, 208, 0.42);
  }
</style>
