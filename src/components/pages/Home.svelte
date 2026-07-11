<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { flushSync, onMount } from "svelte";
  import { _ } from "../../lib/i18n/runtime";
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
  import ActivityButton from "../layout/ActivityButton.svelte";
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
    return parts.join(" � ");
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
  let trackedCompletedIds: Set<number> = $state(new Set());
  let trackedChapterTotalsByMangaId: Map<number, number> = $state(new Map());
  let loadingLibrary = $state(true);
  let setupState: SetupState | null = $state(null);
  let loadLibraryRequest: Promise<void> | null = null;
  let loadHomeMetaRequest: Promise<void> | null = null;
  let setupStateController: AbortController | null = null;
  let componentActive = true;
  let scheduledHomeMetaLoad: number | null = null;
  let homeSources: Source[] = $state([]);
  let homeTrackers: Tracker[] = $state([]);
  let homeExtensions: Extension[] = $state([]);
  const libraryManga = $derived(store.libraryMangaSnapshot);
  const libraryBooks = $derived(store.books);
  const bookProgressById = $derived(new Map(store.bookProgress.map((progress) => [progress.bookId, progress] as const)));

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

  function activityReturnLabel() {
    if (store.homePanelReturnPage === "library") return $_("home.activity.backToLibrary");
    if (store.homePanelReturnPage === "search") return $_("home.activity.backToBrowse");
    if (store.homePanelReturnPage === "downloads") return $_("home.activity.backToDownloads");
    if (store.homePanelReturnPage === "settings") return $_("home.activity.backToSettings");
    return $_("home.activity.backToHome");
  }

  function closeActivityPanel() {
    const returnPage = store.homePanelReturnPage;
    if (returnPage && returnPage !== "home") {
      openHomeDashboard();
      window.setTimeout(() => setNavPage(returnPage), 0);
      return;
    }
    openHomeDashboard();
  }

  function activityBackAction(node: HTMLButtonElement) {
    const handleClick = (event: MouseEvent) => {
      event.preventDefault();
      flushSync(closeActivityPanel);
    };
    node.addEventListener("click", handleClick);
    return {
      destroy() {
        node.removeEventListener("click", handleClick);
      },
    };
  }

  onMount(() => {
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
      componentActive = false;
      setupStateController?.abort();
      setupStateController = null;
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
    setupStateController?.abort();
    const controller = new AbortController();
    setupStateController = controller;
    try {
      const nextSetupState = await detectSetupState(store.settings, controller.signal);
      if (componentActive && setupStateController === controller) {
        setupState = nextSetupState;
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error(error);
    } finally {
      if (setupStateController === controller) setupStateController = null;
    }
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
        if (!componentActive) return;
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
        if (!componentActive) return;
        const previousChapterCountById = new Map(store.libraryMangaSnapshot.map((manga) => [manga.id, manga.chapterCount]));
        setLibraryMangaSnapshot(mangas.map((manga: any) => ({
          ...manga,
          chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? previousChapterCountById.get(manga.id) ?? 0,
        })));
        setCategories(normalizeCategories(categories));
        trackedCompletedIds = collectTrackedCompletedMangaIds(trackingSummary);
        trackedChapterTotalsByMangaId = collectTrackedChapterTotalsByMangaId(trackingSummary);
        scheduleHomeMetaLoad();
      })
      .catch(console.error)
      .finally(() => {
        if (componentActive) loadingLibrary = false;
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
          eyebrow: index === 0 ? translate("ui_inProgress") : index === 1 ? translate("home_continue_resume") : translate("library_error_eyebrow"),
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
          eyebrow: presented.readPercent >= 0.8 ? translate("home_continue_resume") : translate("ui_inProgress"),
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
      label: [translate("ui_mon"), translate("ui_tue"), translate("ui_wed"), translate("ui_thu"), translate("ui_fri"), translate("ui_sat"), translate("ui_sun")][index],
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
      ? $_("home.quick.sourcesReady", { values: { count: sourceReadyCount } })
      : $_("home.quick.noSourcesReady"),
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
      ? $_("home.quick.unreadTitles", { values: { count: titlesWithUnreadCount + booksInProgressCount } })
      : $_("home.quick.libraryUpToDate"),
  );
  const startedMangaIds = $derived(new Set(store.history.map((entry) => entry.mangaId)));
  const mangaToReadCount = $derived(
    libraryManga.filter((manga) => !startedMangaIds.has(manga.id) && !finishedIds.has(manga.id)).length,
  );
  const planToReadCount = $derived(
    mangaToReadCount + booksToReadCount,
  );
  const planToReadSummary = $derived(
    planToReadCount > 0
      ? $_("home.quick.titlesWaiting", { values: { count: planToReadCount } })
      : $_("home.quick.nothingQueued"),
  );
  const downloadSummary = $derived(
    activeDownloadCount || queuedDownloadCount || pausedDownloadCount
      ? [
          activeDownloadCount ? $_("home.quick.downloadActive", { values: { count: activeDownloadCount } }) : "",
          queuedDownloadCount ? $_("home.quick.downloadQueued", { values: { count: queuedDownloadCount } }) : "",
          pausedDownloadCount ? $_("home.quick.downloadPaused", { values: { count: pausedDownloadCount } }) : "",
        ].filter(Boolean).join(" � ")
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
          placeholder={$_("home.searchPlaceholder")}
          bind:value={homeSearch}
          onfocus={handleHomeSearchFocus}
          onblur={handleHomeSearchBlur}
          onkeydown={(event) => event.key === "Enter" && submitHomeSearch()}
        />
      </div>
    {/snippet}
    {#snippet right()}
      <ActivityButton />
      <button class="n-icon-btn" type="button" title={$_("shell.navigation.downloads")} aria-label={$_("shell.navigation.downloads")} onclick={() => setNavPage("downloads")}>
        <span class="material-symbols-outlined" aria-hidden="true">download</span>
      </button>
      <WindowControlsInline />
    {/snippet}
  </AppTopbar>

  <div class="body n-content">
    {#if store.homePanelHint === "history"}
      <div class="home-history-view">
        <div class="home-history-view__header">
          <button class="home-history-back" type="button" use:activityBackAction>
            <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
            {activityReturnLabel()}
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
            <h2 class="home-section__title">{$_("home.continue.title")}</h2>
            <button class="home-link-btn" type="button" onclick={() => setNavPage("library")}>
              {$_("home.continue.viewLibrary")}
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
                      <span>{$_("home.continue.resume")}</span>
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
              <strong>{$_("home.quick.browseSources")}</strong>
              <small>{browseSourcesSummary}</small>
            </div>
          </button>
          <button class="home-quick-action" type="button" onclick={() => setNavPage("downloads")}>
            <span class="material-symbols-outlined" aria-hidden="true">download</span>
            <div>
              <strong>{$_("shell.navigation.downloads")}</strong>
              <small>{downloadSummary}</small>
            </div>
          </button>
          <button class="home-quick-action" type="button" onclick={openCheckUpdates}>
            <span class="material-symbols-outlined" aria-hidden="true">sync</span>
            <div>
              <strong>{$_("home.quick.checkUpdates")}</strong>
              <small>{checkUpdatesSummary}</small>
            </div>
          </button>
          <button class="home-quick-action" type="button" onclick={openPlanToRead}>
            <span class="material-symbols-outlined" aria-hidden="true">bookmark_border</span>
            <div>
              <strong>{$_("home.quick.planToRead")}</strong>
              <small>{planToReadSummary}</small>
            </div>
          </button>
        </section>

        <div class="home-main-grid">
          <section class="home-column home-updates">
            <div class="home-column__header">
              <h2 class="home-column__title">
                <span class="material-symbols-outlined" aria-hidden="true">notifications_active</span>
                {$_("home.sections.recentUpdates")}
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
                  {$_("home.sections.thisWeek")}
                </h2>
              </div>
              <div class="home-card home-week-card">
                <div class="home-week-card__stats">
                  <div>
                    <strong>{stats.totalChaptersRead}</strong>
                    <small>{$_("home.metrics.chapters")}</small>
                  </div>
                  <div>
                    <strong>{formatReadTime(stats.totalMinutesRead)}</strong>
                    <small>{$_("home.metrics.readTime")}</small>
                  </div>
                <div>
                    <strong>{Math.max(thisWeekSeriesCount, 1)}</strong>
                    <small>{$_("home.metrics.series")}</small>
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
                  {$_("home.sections.recentlyFinished")}
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
              <h3 class="home-side-card__title">{$_("home.sections.archive")}</h3>
              <div class="home-side-card__metric">
                <strong>{stats.totalChaptersRead}</strong>
                <small>{$_("home.metrics.chaptersRead")}</small>
              </div>
              <div class="home-side-card__separator"></div>
              <div class="home-side-card__progress">
                <div class="home-side-card__progress-head">
                  <span>{$_("home.metrics.completeCount", { values: { count: archiveFinishedCount } })}</span>
                  <small>{archiveCompletionRatio}%</small>
                </div>
                <span class="home-side-card__storage-label">{$_("downloads.summary.storage")}</span>
                <div class="home-side-card__progress-track">
                  <div class="home-side-card__progress-fill" style={`width:${archiveCompletionRatio}%;`}></div>
                </div>
              </div>
              <div class="home-side-card__split">
                <div>
                  <strong>{archiveTotalCount}</strong>
                  <small>{$_("home.metrics.titles")}</small>
                </div>
                <div>
                  <strong>{setupState?.usableSourceCount ?? 0}</strong>
                  <small>{$_("home.metrics.sources")}</small>
                </div>
              </div>
            </section>

            <section class="home-card home-side-card">
              <h3 class="home-side-card__title">{$_("home.sections.sources")}</h3>
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
              <h3 class="home-side-card__title">{$_("home.sections.tracking")}</h3>
              {#if displayTrackers.length > 0}
                <ul class="home-tracking-list">
                  {#each displayTrackers as tracker (tracker.id)}
                    <li>
                      <span>{tracker.name}</span>
                      <small class:is-synced={tracker.isLoggedIn} class:is-muted={!tracker.isLoggedIn}>
                        {tracker.isLoggedIn ? $_("home.tracking.connected") : $_("home.tracking.notConnected")}
                      </small>
                    </li>
                  {/each}
                  {#if trackedTitleCount > 0}
                    <li>
                      <span>{$_("home.tracking.trackedTitles")}</span>
                      <small class="is-synced">{$_("home.tracking.syncedCount", { values: { count: trackedTitleCount } })}</small>
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
    z-index: var(--component-home-search-dim-z-index);
    background: transparent;
    opacity: var(--component-home-search-dim-opacity);
    pointer-events: none;
    transition: var(--component-home-search-dim-transition);
  }

  .home-search-dim.is-active {
    pointer-events: auto;
  }

  :global(body.aethon-home-search-engaged .aethon-app-shell::after) {
    opacity: var(--component-home-search-dim-opacity);
  }

  :global(body.aethon-home-search-engaged .n-topbar .n-topbar__center) {
    position: relative;
    z-index: var(--component-home-search-topbar-z-index);
  }

  :global(body.aethon-home-search-engaged .n-topbar .n-search) {
    position: relative;
    z-index: var(--component-home-search-field-z-index);
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
    padding: var(--app-shell-block-pad) var(--app-shell-inline-pad) calc(46px * var(--component-home-scale));
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
    margin-bottom: calc(18px * var(--component-home-scale));
  }

  .home-section__title,
  .home-column__title {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: calc(8px * var(--component-home-scale));
    font-size: calc(20px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--component-home-fg);
  }
  .home-link-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: calc(32px * var(--component-home-scale));
    padding: 0 calc(14px * var(--component-home-scale));
    border-radius: var(--component-home-thumb-radius);
    border: 1px solid transparent;
    background: transparent;
    color: var(--component-home-accent-fg);
    font-size: calc(12px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    cursor: pointer;
    transition: var(--component-home-link-transition);
  }

  .home-link-btn:hover {
    color: var(--component-home-link-hover-fg);
    border-color: var(--component-home-link-hover-border);
    background: var(--component-home-link-hover-bg);
    box-shadow: var(--component-home-link-hover-shadow);
  }

  .home-link-btn:active {
    transform: var(--component-home-link-active-transform);
  }

  .home-card {
    position: relative;
    overflow: hidden;
  }

  .home-card__eyebrow {
    display: block;
    margin-bottom: 8px;
    color: var(--component-home-accent-fg);
    font-size: calc(10px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .home-continue-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: calc(24px * var(--component-home-scale));
  }

  .home-continue-card {
    display: flex;
    gap: calc(20px * var(--component-home-scale));
    padding: calc(20px * var(--component-home-scale));
    min-height: calc(192px * var(--component-home-scale));
    width: 100%;
    border-radius: var(--component-home-card-radius);
    border: 1px solid var(--component-home-border);
    background: var(--component-home-card-bg);
    transition: var(--component-home-card-transition);
  }

  .home-continue-card:hover {
    transform: var(--component-home-card-hover-transform);
    box-shadow: var(--component-home-card-hover-shadow);
  }

  .home-continue-card__cover {
    position: relative;
    width: clamp(calc(82px * var(--component-home-scale)), 28%, calc(112px * var(--component-home-scale)));
    min-width: clamp(calc(82px * var(--component-home-scale)), 28%, calc(112px * var(--component-home-scale)));
    height: auto;
    aspect-ratio: 0.7;
    padding: 0;
    border: none;
    border-radius: var(--component-home-control-radius);
    overflow: hidden;
    background: var(--component-home-cover-bg);
    cursor: pointer;
  }

  .home-continue-card__cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: var(--component-home-cover-transition);
  }

  .home-continue-card:hover .home-continue-card__cover img {
    transform: var(--component-home-cover-hover-transform);
  }

  .home-continue-card__progress-track {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(5px * var(--component-home-scale));
    background: var(--component-home-progress-track-bg);
  }

  .home-continue-card__progress-fill {
    height: 100%;
    background: var(--component-home-progress-fill-bg);
  }

  .home-continue-card__body {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    justify-content: space-between;
    gap: calc(16px * var(--component-home-scale));
  }

  .home-continue-card__copy h3 {
    margin: 0 0 6px;
    color: var(--component-home-fg);
    font-size: calc(17px * var(--component-home-scale));
    font-weight: 800;
    line-height: 1.2;
  }

  .home-continue-card__copy p {
    margin: 0;
    color: var(--component-home-muted-fg);
    font-size: calc(12px * var(--component-home-scale));
    line-height: 1.4;
  }

  .home-continue-card__metrics {
    display: flex;
    align-items: baseline;
    gap: calc(6px * var(--component-home-scale));
    margin-bottom: calc(12px * var(--component-home-scale));
  }

  .home-continue-card__metrics span {
    color: var(--component-home-strong-accent-fg);
    font-size: calc(24px * var(--component-home-scale));
    font-weight: 800;
    line-height: 1;
  }

  .home-continue-card__metrics small {
    color: var(--component-home-subtle-fg);
    font-size: calc(10px * var(--component-home-scale));
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .home-primary-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(8px * var(--component-home-scale));
    width: 100%;
    min-height: calc(40px * var(--component-home-scale));
    padding: 0 calc(24px * var(--component-home-scale));
    border: none;
    border-radius: var(--component-home-control-radius);
    background: var(--component-home-primary-bg);
    color: var(--component-home-on-accent);
    font-size: calc(12px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    box-shadow: var(--component-home-primary-shadow);
    transition: var(--component-home-primary-transition);
  }

  .home-primary-btn:hover:not(:disabled) {
    filter: var(--component-home-primary-hover-filter);
    box-shadow: var(--component-home-primary-hover-shadow);
    transform: var(--component-home-primary-hover-transform);
  }

  .home-primary-btn:active:not(:disabled) {
    transform: var(--component-home-primary-active-transform);
    box-shadow: var(--component-home-primary-active-shadow);
  }

  .home-secondary-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(8px * var(--component-home-scale));
    min-height: calc(40px * var(--component-home-scale));
    padding: 0 calc(20px * var(--component-home-scale));
    border-radius: var(--component-home-control-radius);
    background: var(--component-home-control-bg);
    color: var(--component-home-secondary-fg);
    border: 1px solid var(--component-home-control-border);
    transition: var(--component-home-control-transition);
  }

  .home-secondary-btn:hover:not(:disabled) {
    background: var(--component-home-control-hover-bg);
    color: var(--component-home-fg);
    border-color: var(--component-home-border-hover);
    transform: var(--component-home-secondary-hover-transform);
    box-shadow: var(--component-home-secondary-shadow-hover);
  }

  .home-secondary-btn:active:not(:disabled) {
    transform: var(--component-home-secondary-active-transform);
  }

  .home-quick-actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: calc(12px * var(--component-home-scale));
  }

  .home-quick-action {
    display: flex;
    align-items: center;
    gap: calc(14px * var(--component-home-scale));
    padding: calc(16px * var(--component-home-scale));
    border-radius: var(--component-home-control-radius);
    border: 1px solid var(--component-home-border);
    background: var(--component-home-panel-bg);
    color: inherit;
    text-align: left;
    cursor: pointer;
    width: 100%;
    transition: var(--component-home-quick-transition);
  }

  .home-quick-action:hover {
    background: var(--component-home-card-bg);
    transform: var(--component-home-quick-hover-transform);
  }

  .home-quick-action .material-symbols-outlined {
    color: var(--component-home-icon-fg);
    font-size: calc(22px * var(--component-home-scale));
  }

  .home-quick-action strong {
    display: block;
    margin-bottom: 2px;
    color: var(--component-home-fg);
    font-size: calc(12px * var(--component-home-scale));
    font-weight: 800;
  }

  .home-quick-action small {
    color: var(--component-home-meta-fg);
    font-size: calc(10px * var(--component-home-scale));
  }

  .home-main-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(calc(260px * var(--component-home-scale)), calc(280px * var(--component-home-scale)));
    gap: calc(30px * var(--component-home-scale));
    align-items: start;
  }

  .home-middle-stack,
  .home-side-stack {
    display: flex;
    flex-direction: column;
    gap: calc(24px * var(--component-home-scale));
  }

  .home-updates-card,
  .home-week-card,
  .home-finished-card,
  .home-side-card {
    padding: calc(16px * var(--component-home-scale));
    border-radius: var(--component-home-control-radius);
    border: 1px solid var(--component-home-border);
    background: var(--component-home-panel-bg);
  }

  .home-updates-list,
  .home-finished-list {
    display: flex;
    flex-direction: column;
    gap: calc(8px * var(--component-home-scale));
  }

  .home-update-row,
  .home-finished-row {
    display: flex;
    align-items: center;
    gap: calc(12px * var(--component-home-scale));
    width: 100%;
    padding: calc(12px * var(--component-home-scale));
    background: transparent;
    border: none;
    border-radius: var(--component-home-control-radius);
    text-align: left;
    cursor: pointer;
    transition: var(--component-home-row-transition);
  }

  .home-update-row:hover,
  .home-finished-row:hover {
    background: var(--component-home-row-hover-bg);
  }

  .home-finished-row--card {
    border: 1px solid var(--component-home-border);
    background: var(--component-home-panel-bg);
    min-height: calc(80px * var(--component-home-scale));
  }

  .home-update-row__thumb,
  .home-finished-row img {
    width: calc(40px * var(--component-home-scale));
    height: calc(56px * var(--component-home-scale));
    border-radius: var(--component-home-thumb-radius);
    object-fit: cover;
    background: var(--component-home-cover-bg);
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
    color: var(--component-home-fg);
    font-size: calc(12px * var(--component-home-scale));
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .home-update-row__copy span,
  .home-finished-row__copy span {
    color: var(--component-home-subtle-fg);
    font-size: calc(11px * var(--component-home-scale));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .home-update-row small {
    color: var(--component-home-faint-fg);
    font-size: calc(9px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .home-week-card__stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: calc(18px * var(--component-home-scale));
    margin-bottom: calc(18px * var(--component-home-scale));
  }

  .home-week-card__stats strong {
    display: block;
    color: var(--component-home-fg);
    font-size: calc(22px * var(--component-home-scale));
    font-weight: 300;
    line-height: 1;
  }

  .home-week-card__stats small {
    color: var(--component-home-label-fg);
    font-size: calc(9px * var(--component-home-scale));
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .home-week-card__bars {
    display: flex;
    align-items: end;
    gap: calc(8px * var(--component-home-scale));
    height: calc(70px * var(--component-home-scale));
  }

  .home-week-card__bar-slot {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: calc(6px * var(--component-home-scale));
    justify-content: end;
    height: 100%;
  }

  .home-week-card__bar {
    width: 100%;
    border-radius: var(--component-home-chart-bar-radius);
    background: var(--component-home-chart-bar-bg);
    min-height: calc(12px * var(--component-home-scale));
  }

  .home-week-card__bar.is-today {
    background: var(--component-home-progress-fill-bg);
  }

  .home-week-card__bar-slot span {
    color: var(--component-home-chart-label-fg);
    font-size: calc(8px * var(--component-home-scale));
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .home-finished-row__tag {
    color: var(--component-home-tag-fg);
    font-size: calc(9px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .home-side-card {
    display: flex;
    flex-direction: column;
    gap: calc(14px * var(--component-home-scale));
    min-height: 0;
  }

  .home-side-card__title {
    margin: 0;
    color: var(--component-home-quiet-fg);
    font-size: calc(10px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .home-side-card__metric strong {
    display: block;
    color: var(--component-home-fg);
    font-size: calc(30px * var(--component-home-scale));
    font-weight: 300;
    line-height: 1;
    letter-spacing: -0.03em;
  }

  .home-side-card__metric small,
  .home-side-card__body,
  .home-side-card__split small {
    color: var(--component-home-quiet-fg);
    font-size: calc(10px * var(--component-home-scale));
    line-height: 1.5;
  }

  .home-side-card__body {
    margin: 0;
  }

  .home-side-card__separator {
    height: 1px;
    background: var(--component-home-divider-bg);
  }

  .home-side-card__progress-head,
  .home-side-card__split {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(12px * var(--component-home-scale));
  }
  .home-side-card__split strong,
  .home-side-card__progress-head span {
    color: var(--component-home-fg);
    font-size: calc(16px * var(--component-home-scale));
    font-weight: 300;
  }

  .home-side-card__progress-head small {
    color: var(--component-home-faint-fg);
    font-size: calc(9px * var(--component-home-scale));
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }

  .home-side-card__progress-track {
    height: calc(5px * var(--component-home-scale));
    overflow: hidden;
    border-radius: var(--component-home-pill-radius);
    background: var(--component-home-side-progress-track-bg);
  }

  .home-side-card__progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--component-home-progress-fill-bg);
  }

  .home-side-card__storage-label {
    display: block;
    margin: 0 0 calc(8px * var(--component-home-scale));
    color: var(--component-home-label-fg);
    font-size: calc(9px * var(--component-home-scale));
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
    gap: calc(10px * var(--component-home-scale));
  }

  .home-source-list li,
  .home-tracking-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(10px * var(--component-home-scale));
    color: var(--component-home-fg);
    font-size: calc(11px * var(--component-home-scale));
  }

  .home-source-list__name,
  .home-tracking-list li span {
    flex: 1;
  }

  .home-source-list li small,
  .home-tracking-list li small {
    color: var(--component-home-source-meta-fg);
    font-size: calc(9px * var(--component-home-scale));
  }

  .home-tracking-list .is-synced {
    color: var(--component-home-tag-fg);
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .home-tracking-list .is-muted {
    color: var(--component-home-tracking-muted-fg);
  }

  .home-empty-slot {
    min-height: calc(80px * var(--component-home-scale));
    width: 100%;
    border: 1px solid var(--component-home-border);
    background: var(--component-home-panel-bg);
    border-radius: var(--component-home-control-radius);
  }

  .home-side-card__blank {
    min-height: calc(88px * var(--component-home-scale));
  }

  .home-resume-btn .material-symbols-outlined {
    font-size: calc(15px * var(--component-home-scale));
    font-variation-settings: "FILL" 1, "wght" 500, "GRAD" 0, "opsz" 20;
    line-height: 1;
  }

  .home-history-view {
    display: flex;
    min-height: 100%;
    flex-direction: column;
    padding: calc(24px * var(--component-home-scale)) calc(28px * var(--component-home-scale));
    gap: calc(20px * var(--component-home-scale));
  }

  .home-history-view__content {
    min-height: 0;
    border-radius: var(--component-home-control-radius);
    border: 0;
    background: transparent;
    overflow: hidden;
  }

  .home-history-back {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--component-home-history-border);
    border-radius: var(--component-home-pill-radius);
    background: var(--component-home-history-control-bg);
    color: var(--component-home-history-fg);
    font-size: calc(11px * var(--component-home-scale));
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: calc(10px * var(--component-home-scale)) calc(16px * var(--component-home-scale));
    cursor: pointer;
  }

  .home-history-back:hover {
    color: var(--component-home-fg);
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
      min-width: calc(220px * var(--component-home-scale));
      align-self: flex-start;
    }
  }

  @media (max-width: 460px) {
    .home-continue-card {
      flex-direction: column;
    }

    .home-continue-card__cover {
      width: min(44%, calc(132px * var(--component-home-scale)));
      min-width: min(44%, calc(132px * var(--component-home-scale)));
    }

    .home-resume-btn {
      width: 100%;
      min-width: 0;
      align-self: stretch;
    }
  }

  .home-status-dot {
    width: calc(6px * var(--component-home-scale));
    height: calc(6px * var(--component-home-scale));
    border-radius: var(--component-home-pill-radius);
    flex-shrink: 0;
  }

  .home-status-dot.is-online {
    background: var(--component-home-status-online-bg);
  }

  .home-status-dot.is-slow {
    background: var(--component-home-status-slow-bg);
  }

  .home-status-dot.is-offline {
    background: var(--component-home-status-offline-bg);
  }

  .home-status-dot.is-neutral {
    background: var(--component-home-status-neutral-bg);
  }
</style>
