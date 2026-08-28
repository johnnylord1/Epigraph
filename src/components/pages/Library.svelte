<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { onMount, untrack } from "svelte";
  import { gql } from "../../lib/client";
  import { cache, CACHE_GROUPS, CACHE_KEYS, DEFAULT_TTL_MS } from "../../lib/cache";
  import {
    buildBooksSectionState,
    createBooksLibraryActions,
    type BooksLibrarySortMode,
    normalizeBooksCategorySelection,
  } from "../../lib/library/booksSection";
  import { buildNovelShelf } from "../../lib/novels/libraryShelf";
  import { getHardcoverUserBooks, loadHardcoverState, type HardcoverNovelTrackRecord } from "../../lib/novels/hardcover";
  import { hasBookLocalAsset } from "../../lib/books/availability";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelLibraryChapters,
    getNovelLibraryEntry,
    loadNovelLibraryState,
    peekNovelLibraryState,
  } from "../../lib/novels/libraryState";
  import {
    groupRefreshedNovelChaptersForNotifications,
    refreshNovelLibraryFromSources,
  } from "../../lib/novels/libraryRefresh";
  import { collectTrackedChapterTotalsByMangaId, collectTrackedCompletedMangaIds } from "../../lib/library/completion";
  import {
    COMPLETED_CATEGORY_NAME,
    getCategoryDisplayName,
    isCompletedCategory,
    normalizeCategories,
  } from "../../lib/library/categories";
  import { getBooksUpdateExcludedBookIds, sortBooksCategories } from "../../lib/library/domainCategories";
  import { reconcileMangaCountsFromChapters } from "../../lib/library/chapterCounts";
  import { reconcileComicsChapterSnapshot } from "../../lib/library/comicsChapterSnapshot";
  import {
    clearStaleLibraryUpdateInFlight,
    formatLibraryUpdateFinalSummary,
    libraryUpdateProgressNumbers,
    runSharedLibraryUpdate,
    showLibraryUpdateProgress as showSharedLibraryUpdateProgress,
  } from "../../lib/library/updateRuntime";
  import {
    buildComicsSectionState,
    createComicsLibraryActions,
  } from "../../lib/library/comicsSection";
  import type {
    BooksTypeFilterId,
    BooksTypeOptionVM,
    LibraryCollectionVM,
    LibraryCollectionsReorderApi,
    LibrarySectionKind,
    LibrarySectionTabVM,
    LibrarySectionVM,
    LibraryToolbarVM,
  } from "../../lib/library/contracts";
  import type { LibraryPreferredGridColumns, LibraryViewMode } from "../../lib/libraryDisplay";
  import { _ } from "../../lib/i18n/runtime";
  import { dedupeMangaById } from "../../lib/util";
  import { createBookLibraryCardId, createComicLibraryCardId } from "../../lib/library/cardIdentity";
  import {
    GET_CATEGORIES_SUMMARY,
    GET_CATEGORIES_WITH_MANGA_IDS,
    GET_CHAPTERS,
    GET_LIBRARY,
    GET_LIBRARY_CHAPTER_COUNTS,
    GET_LIBRARY_TRACKING_SUMMARY,
    GET_SOURCES,
    UPDATE_MANGA,
    DELETE_DOWNLOADED_CHAPTERS,
    DEQUEUE_DOWNLOAD,
    CREATE_CATEGORY,
    DELETE_CATEGORY,
    UPDATE_MANGA_CATEGORIES,
    UPDATE_CATEGORY_ORDER,
  } from "../../lib/queries";
  import type { Category, Chapter, Manga, Source } from "../../lib/types";
  import {
    addToast,
    checkAndMarkCompleted as storeCheckAndMarkCompleted,
    setActiveNovelDetail,
    setActiveBookId,
    setCategories,
    setLibraryFilter,
    setLibrarySection,
    setLibraryMangaSnapshot,
    setSearchNovelLibrarySnapshot,
    setLibraryUpdateInFlight,
    bumpLibraryCoverCacheGeneration,
    recordComicsUpdateNotifications,
    recordNovelUpdateNotifications,
    recordLibraryUpdateIssues,
    addSystemNotification,
    openMangaDetail,
    store,
    updateSettings,
    type BooksLibraryStatusFilter,
    type BooksLibraryTypeFilter,
    type BooksLibraryUiState,
    type LibrarySortDir,
    type LibrarySortMode,
    type LibraryStatusFilter,
  } from "../../store/state.svelte";
  import {
    buildCategoryMembers,
    loadLibrarySnapshot,
    resolveLibrarySnapshotCategoryState,
    saveLibrarySnapshot,
    type PersistedLibrarySnapshot,
  } from "../../lib/library/snapshot";
  import { ensureServerAwakeFor } from "../../lib/serverLifecycle";
  import BooksLibraryBody from "../library/BooksLibraryBody.svelte";
  import ComicsLibraryBody from "../library/ComicsLibraryBody.svelte";
  import LibraryToolbar from "../library/LibraryToolbar.svelte";
  import LibraryShell from "../library/LibraryShell.svelte";
  import NocturneState from "../shared/NocturneState.svelte";

  const DT_TAB = "application/x-epigraph-tab";
  const CATEGORY_MEMBERS_CACHE_KEY = `${CACHE_KEYS.CATEGORIES}:members`;
  const LEGACY_CATEGORIES_WITH_MANGA_CACHE_KEY = `${CACHE_KEYS.CATEGORIES}:with-manga`;
  const LIBRARY_CHAPTER_COUNTS_CACHE_KEY = `${CACHE_KEYS.LIBRARY}:chapter-counts`;

  function isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === "AbortError") ||
      (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")
    );
  }

  let ensureCompletedInFlight: Promise<Category[]> | null = null;
  let hydrateCategoriesInFlight: Promise<Category[]> | null = null;
  let libraryChapterCountsInFlight: Promise<void> | null = null;
  let liveLibrarySnapshotRefreshInFlight: Promise<Manga[]> | null = null;
  let lastLiveLibrarySnapshotRefreshAt = 0;
  let trackedCompletedIds: Set<number> = $state(new Set());
  let trackedChapterTotalsByMangaId: Map<number, number> = $state(new Map());
  let allSources: Source[] = $state([]);
  function hasWarmLibrarySnapshot() {
    return store.libraryMangaSnapshot.length > 0 || store.categories.length > 0;
  }

  let loading = $state(!hasWarmLibrarySnapshot());
  let error: string | null = $state(null);
  let retryCount = $state(0);
  let comicsSearch = $state("");
  let activeLibraryGenre: string | null = $state(null);
  let activeBooksStandardFilter: "saved" | "downloaded" | "finished" = $state("saved");
  let settledLibrarySection: LibrarySectionKind = $state(store.librarySection);
  let genreScrollEl: HTMLDivElement | null = $state(null);
  let genreDragStartX = 0;
  let genreDragStartScrollLeft = 0;
  let genreDragActive = $state(false);
  let suppressNextGenreClick = false;
  let pendingGenreClickLabel: string | null = null;
  let activeDragKind: "tab" | null = $state(null);
  let dragInsertIdx = $state<number | null>(null);
  let dragTabId = $state<string | null>(null);
  let dropTargetTabId = $state<string | null>(null);
  let loadDataInFlight = false;
  let manualRefreshInFlight = $state(false);
  let refreshDialogOpen = $state(false);
  let refreshDialogBusy = $state<"active" | "all" | null>(null);
  let coverWakeInFlight: Promise<void> | null = null;
  let coverRecoveryVersions = $state(new Map<number, number>());
  const pendingCoverRecoveryIds = new Set<number>();
  let libraryLoadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let libraryLoadRetryCount = 0;
  let categoryLoadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let categoryLoadRetryCount = 0;
  let recoveredEmptyStartupCategory = false;
  const categoryMemberRefreshAttempts = new Set<number>();
  let lastLoadedScopeKey: string | null = null;
  const libraryLoadRetryLimit = 30;
  const categoryLoadRetryLimit = 12;
  let novelsLibraryState = $state(peekNovelLibraryState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
  let hardcoverTrackingRecords: HardcoverNovelTrackRecord[] = $state(
    loadHardcoverState({
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    }).records,
  );
  let hardcoverRecordsRefreshInFlight = false;
  const libraryRuntimeReady = $derived(
    !!store.runtimeResolvedLocalProfileId && !!store.runtimeServerUrl,
  );
  const libraryBootstrapScopeKey = $derived(
    `${store.runtimeResolvedLocalProfileId ?? ""}::${store.runtimeServerUrl ?? ""}`,
  );
  const activeLibraryBootstrapStatus = $derived(
    store.libraryBootstrapScopeKey === libraryBootstrapScopeKey
      ? store.libraryBootstrapStatus
      : "idle",
  );

  $effect(() => {
    libraryBootstrapScopeKey;
    categoryMemberRefreshAttempts.clear();
  });

  $effect(() => {
    settledLibrarySection = store.librarySection;
  });

  const allManga = $derived(store.libraryMangaSnapshot);
  const visualLibrarySection = $derived(settledLibrarySection);
  const booksUi = $derived(store.settings.booksLibraryUi);
  const bookActiveCategoryId = $derived(booksUi.activeCategoryId);
  const bookTypeFilter = $derived(booksUi.typeFilter);
  const booksSearch = $derived(booksUi.search);
  const bookSortMode = $derived(booksUi.sortMode);
  const bookSortDir = $derived(booksUi.sortDir);
  const bookStatusFilter = $derived(booksUi.statusFilter);

  const tabSortMode = $derived(
    store.settings.libraryTabSort[store.libraryFilter]?.mode ?? "az" as LibrarySortMode,
  );
  const tabSortDir = $derived(
    store.settings.libraryTabSort[store.libraryFilter]?.dir ?? "asc" as LibrarySortDir,
  );
  const tabStatus = $derived(
    store.settings.libraryTabStatus[store.libraryFilter] ?? "ALL" as LibraryStatusFilter,
  );

  function updateBooksLibraryUi(patch: Partial<BooksLibraryUiState>) {
    updateSettings({
      booksLibraryUi: {
        ...store.settings.booksLibraryUi,
        ...patch,
      },
    });
  }

  function setTabSort(mode: LibrarySortMode, dir?: LibrarySortDir) {
    const prev = store.settings.libraryTabSort[store.libraryFilter];
    updateSettings({
      libraryTabSort: {
        ...store.settings.libraryTabSort,
        [store.libraryFilter]: {
          mode,
          dir: dir ?? prev?.dir ?? "asc",
        },
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
  }

  function setBookSort(mode: BooksLibrarySortMode, dir?: LibrarySortDir) {
    updateBooksLibraryUi({
      sortMode: mode,
      ...(dir ? { sortDir: dir } : {}),
    });
  }

  function toggleBookSortDir() {
    updateBooksLibraryUi({ sortDir: bookSortDir === "asc" ? "desc" : "asc" });
  }

  function setBookStatusFilterValue(next: BooksLibraryStatusFilter) {
    updateBooksLibraryUi({ statusFilter: next });
  }

  function normalizeLoadedLibrary(nodes: Manga[], previous: Manga[] = store.libraryMangaSnapshot): Manga[] {
    const previousChapterCountById = new Map(previous.map((manga) => [manga.id, manga.chapterCount]));
    return dedupeMangaById(nodes.map((manga: any) => ({
      ...manga,
      chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? previousChapterCountById.get(manga.id) ?? 0,
    })));
  }

  function mergeLibraryChapterCounts(mangas: Manga[], counts: Manga[]): Manga[] {
    const chapterCountById = new Map(
      counts.map((manga: any) => [manga.id, manga.chapters?.totalCount ?? manga.chapterCount]),
    );
    return mangas.map((manga) => {
      const chapterCount = chapterCountById.get(manga.id);
      return typeof chapterCount === "number" && Number.isFinite(chapterCount)
        ? { ...manga, chapterCount }
        : manga;
    });
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
      duplicates.map((cat) => gql(DELETE_CATEGORY, { id: cat.id }).catch(console.error)),
    );

    const refreshed = await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY)
      .then((data) => data.categories.nodes)
      .catch(() => cats.filter((cat) => cat.id === keep.id || !isCompletedCategory(cat)));

    return normalizeCategories(refreshed);
  }

  async function ensureCompletedCategory(cats: Category[]): Promise<Category[]> {
    const normalized = normalizeCategories(cats);
    const cleaned = await cleanupCompletedDuplicates(normalized);
    if (cleaned.some(isCompletedCategory)) return cleaned;
    if (ensureCompletedInFlight) return ensureCompletedInFlight;

    ensureCompletedInFlight = (async () => {
      try {
        const fresh = await cleanupCompletedDuplicates(
          normalizeCategories((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY)).categories.nodes),
        );
        if (fresh.some(isCompletedCategory)) return fresh;

        try {
          await gql(CREATE_CATEGORY, { name: COMPLETED_CATEGORY_NAME });
        } catch {}

        return await cleanupCompletedDuplicates(
          normalizeCategories((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY)).categories.nodes),
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

  function loadCategoriesSnapshot() {
    return cache.get(
      CACHE_KEYS.CATEGORIES,
      async () => {
        await ensureServerAwakeFor("library-category-members", {
          serverUrl: store.runtimeServerUrl,
          binary: store.settings.serverBinary,
          updateIntensity: store.settings.libraryUpdateIntensity,
          profileId: store.runtimeResolvedLocalProfileId,
          profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
        });
        return ensureCompletedCategory(
          (await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY)).categories.nodes,
        );
      },
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  function currentSnapshotScope() {
    return {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };
  }

  function reloadHardcoverTrackingRecords() {
    hardcoverTrackingRecords = loadHardcoverState(currentSnapshotScope()).records;
  }

  async function refreshHardcoverTrackingRecords() {
    const scope = currentSnapshotScope();
    const state = loadHardcoverState(scope);
    hardcoverTrackingRecords = state.records;
    if (!state.auth.connected || !state.auth.token || hardcoverRecordsRefreshInFlight) return;

    hardcoverRecordsRefreshInFlight = true;
    try {
      hardcoverTrackingRecords = await getHardcoverUserBooks(scope);
    } catch (refreshError) {
      console.warn("Could not refresh Hardcover tracking records for Books library.", refreshError);
      hardcoverTrackingRecords = loadHardcoverState(scope).records;
    } finally {
      hardcoverRecordsRefreshInFlight = false;
    }
  }

  function categoriesWithSnapshotMembers(snapshot: PersistedLibrarySnapshot) {
    const mangaById = new Map(snapshot.mangas.map((manga) => [manga.id, manga]));
    return snapshot.categories.map((category) => {
      const ids = snapshot.categoryMembers[String(category.id)] ?? [];
      if (!ids.length) return category;
      return {
        ...category,
        mangas: {
          nodes: ids.map((id) => mangaById.get(id)).filter((manga): manga is Manga => Boolean(manga)),
        },
      };
    });
  }

  function hydrateFromPersistedSnapshot() {
    const snapshot = loadLibrarySnapshot(currentSnapshotScope());
    if (!snapshot) return false;
    setLibraryMangaSnapshot(normalizeLoadedLibrary(snapshot.mangas));
    setCategories(normalizeCategories(categoriesWithSnapshotMembers(snapshot)));
    store.setLibraryTrackingSummarySnapshot(snapshot.trackingSummary as any);
    return true;
  }

  function persistCurrentLibrarySnapshot(
    categories = store.categories,
    options: { allowEmptyCategories?: boolean } = {},
  ) {
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
    const previous = loadLibrarySnapshot(currentSnapshotScope());
    const normalizedCategories = normalizeCategories(categories);
    const nextCategoryState = resolveLibrarySnapshotCategoryState(
      previous,
      normalizeCategories(normalizedCategories.map((category) => {
        const { mangas: _mangas, ...summary } = category;
        return summary;
      })),
      buildCategoryMembers(normalizedCategories),
      options.allowEmptyCategories,
    );

    saveLibrarySnapshot(currentSnapshotScope(), {
      mangas: store.libraryMangaSnapshot,
      categories: nextCategoryState.categories,
      categoryMembers: nextCategoryState.categoryMembers,
      trackingSummary: store.libraryTrackingSummarySnapshot,
    });
  }

  function loadCategoryMembersSnapshot() {
    return cache.get(
      CATEGORY_MEMBERS_CACHE_KEY,
      async () => {
        await ensureServerAwakeFor("library-category-members", {
          serverUrl: store.runtimeServerUrl,
          binary: store.settings.serverBinary,
          updateIntensity: store.settings.libraryUpdateIntensity,
      profileId: store.runtimeResolvedLocalProfileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
        });
        return ensureCompletedCategory((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_WITH_MANGA_IDS)).categories.nodes);
      },
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  function categoriesHaveMangaMembers(categories = store.categories) {
    return categories.some((category) => Array.isArray(category.mangas?.nodes));
  }

  function categoryHasMangaMembers(categoryId: number, categories = store.categories) {
    const category = categories.find((entry) => entry.id === categoryId);
    return Array.isArray(category?.mangas?.nodes);
  }

  async function hydrateCategoryMembers(force = false) {
    if (hydrateCategoriesInFlight) return hydrateCategoriesInFlight;
    hydrateCategoriesInFlight = (async () => {
      try {
        if (force) cache.clear(CATEGORY_MEMBERS_CACHE_KEY);
        cache.clear(LEGACY_CATEGORIES_WITH_MANGA_CACHE_KEY);
        const categories = normalizeCategories(await loadCategoryMembersSnapshot());
        setCategories(categories);
        persistCurrentLibrarySnapshot(categories, { allowEmptyCategories: true });
        return categories;
      } finally {
        hydrateCategoriesInFlight = null;
      }
    })();
    return hydrateCategoriesInFlight;
  }

  async function reloadCategories(force = true) {
    try {
      if (force) cache.clear(CACHE_KEYS.CATEGORIES);
      if (force) cache.clear(CATEGORY_MEMBERS_CACHE_KEY);
      cache.clear(LEGACY_CATEGORIES_WITH_MANGA_CACHE_KEY);
      const categories = await loadCategoriesSnapshot();
      setCategories(categories);
      if (!categoriesHaveMangaMembers(categories)) {
        const hydrated = await hydrateCategoryMembers(force);
        categoryLoadRetryCount = 0;
        return hydrated;
      }
      categoryLoadRetryCount = 0;
      return categories;
    } catch (reloadError) {
      if (!isAbortError(reloadError)) console.error(reloadError);
      return store.categories;
    }
  }

  function clearCategoryLoadRetry() {
    categoryLoadRetryCount = 0;
    if (categoryLoadRetryTimer) {
      clearTimeout(categoryLoadRetryTimer);
      categoryLoadRetryTimer = null;
    }
  }

  function scheduleCategoryLoadRetry() {
    if (categoryLoadRetryTimer || categoryLoadRetryCount >= categoryLoadRetryLimit) return;
    categoryLoadRetryCount += 1;
    categoryLoadRetryTimer = setTimeout(() => {
      categoryLoadRetryTimer = null;
      if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
      void reloadCategories(true).then((categories) => {
        if (categories.length > 0) {
          clearCategoryLoadRetry();
          return;
        }
        scheduleCategoryLoadRetry();
      });
    }, Math.min(5000, 500 * categoryLoadRetryCount));
  }

  async function loadLibrary() {
    const nodes = await cache.get(
      CACHE_KEYS.LIBRARY,
      () => gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY, undefined, undefined, 8000).then((data) => data.mangas.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
    if (nodes.length > 0) return nodes;

    cache.clear(CACHE_KEYS.LIBRARY);
    const live = await gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY, undefined, undefined, 12000)
      .then((data) => data.mangas.nodes)
      .catch(() => nodes);
    if (live.length > 0) cache.set(CACHE_KEYS.LIBRARY, live, CACHE_GROUPS.LIBRARY);
    return live;
  }

  function loadLibraryChapterCounts() {
    return cache.get(
      LIBRARY_CHAPTER_COUNTS_CACHE_KEY,
      () => gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY_CHAPTER_COUNTS, undefined, undefined, 12000).then((data) => data.mangas.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  async function refreshLibraryChapterCounts() {
    if (libraryChapterCountsInFlight) return libraryChapterCountsInFlight;
    libraryChapterCountsInFlight = (async () => {
    try {
      const counts = await loadLibraryChapterCounts();
      const merged = mergeLibraryChapterCounts(store.libraryMangaSnapshot, counts);
      setLibraryMangaSnapshot(merged);
      cache.set(CACHE_KEYS.LIBRARY, merged, CACHE_GROUPS.LIBRARY);
      persistCurrentLibrarySnapshot(store.categories);
    } catch (countsError) {
      console.warn("Could not refresh Comics chapter counts:", countsError);
    } finally {
      libraryChapterCountsInFlight = null;
    }
    })();
    return libraryChapterCountsInFlight;
  }

  async function refreshLibrarySnapshotLive() {
    const now = Date.now();
    if (liveLibrarySnapshotRefreshInFlight) return liveLibrarySnapshotRefreshInFlight;
    if (now - lastLiveLibrarySnapshotRefreshAt < 10_000) return store.libraryMangaSnapshot;
    lastLiveLibrarySnapshotRefreshAt = now;
    liveLibrarySnapshotRefreshInFlight = (async () => {
    const data = await gql<{ mangas: { nodes: Manga[] } }>(
      GET_LIBRARY,
      undefined,
      undefined,
      12000,
    );
    const normalized = normalizeLoadedLibrary(data.mangas.nodes);
    setLibraryMangaSnapshot(normalized);
    cache.set(CACHE_KEYS.LIBRARY, normalized, CACHE_GROUPS.LIBRARY);
    persistCurrentLibrarySnapshot(store.categories);
    void refreshLibraryChapterCounts();
    return normalized;
    })();
    try {
      return await liveLibrarySnapshotRefreshInFlight;
    } finally {
      liveLibrarySnapshotRefreshInFlight = null;
    }
  }

  function loadLibraryTrackingSummary() {
    return cache.get(
      CACHE_KEYS.LIBRARY_TRACKING_SUMMARY,
      () => gql(GET_LIBRARY_TRACKING_SUMMARY, undefined, undefined, 8000).then((data: any) => data.trackers.nodes),
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

  async function loadData() {
    if (!libraryRuntimeReady) return;
    if (loadDataInFlight) return;
    loadDataInFlight = true;
    const shouldBlockForLoad = store.libraryMangaSnapshot.length === 0
      && store.categories.length === 0
      && activeLibraryBootstrapStatus !== "ready";
    if (shouldBlockForLoad) loading = true;
    try {
      let categoriesLoadFailed = false;
      const [nodes, categories, trackingSummary, sources] = await Promise.all([
        loadLibrary().catch((libraryError) => {
          if (!isAbortError(libraryError)) console.error(libraryError);
          return store.libraryMangaSnapshot;
        }),
        loadCategoriesSnapshot().catch((categoryError) => {
          if (!isAbortError(categoryError)) console.error(categoryError);
          categoriesLoadFailed = true;
          return store.categories;
        }),
        loadLibraryTrackingSummary().catch((trackingError) => {
          if (!isAbortError(trackingError)) console.error(trackingError);
          return store.libraryTrackingSummarySnapshot;
        }),
        loadSourcesSnapshot().catch((sourcesError) => {
          if (!isAbortError(sourcesError)) console.error(sourcesError);
          return [];
        }),
      ]);

      allSources = sources;
      setLibraryMangaSnapshot(normalizeLoadedLibrary(nodes));
      setCategories(normalizeCategories(categories));
      if (categoriesLoadFailed) {
        scheduleCategoryLoadRetry();
      } else {
        clearCategoryLoadRetry();
      }
      store.setLibraryTrackingSummarySnapshot(trackingSummary);
      persistCurrentLibrarySnapshot(normalizeCategories(categories), {
        allowEmptyCategories: !categoriesLoadFailed,
      });
      void refreshLibraryChapterCounts();
      void hydrateCategoryMembers(false).catch(console.error);
      error = null;
      if (nodes.length > 0 || categories.length > 0 || hasWarmLibrarySnapshot()) {
        if (libraryLoadRetryTimer) {
          clearTimeout(libraryLoadRetryTimer);
          libraryLoadRetryTimer = null;
        }
        libraryLoadRetryCount = 0;
      } else if (libraryLoadRetryCount < libraryLoadRetryLimit && !libraryLoadRetryTimer) {
        libraryLoadRetryCount += 1;
        libraryLoadRetryTimer = setTimeout(() => {
          libraryLoadRetryTimer = null;
          if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
          cache.clearGroup(CACHE_GROUPS.LIBRARY);
          void loadData();
        }, 700 * libraryLoadRetryCount);
      }

    } catch (loadError: any) {
      if (hydrateFromPersistedSnapshot()) {
        error = null;
        return;
      }
      trackedCompletedIds = new Set();
      trackedChapterTotalsByMangaId = new Map();
      error = null;
      if (!isAbortError(loadError)) console.error(loadError);
      if (
        store.runtimeResolvedLocalProfileId
        && store.runtimeServerUrl
      && libraryLoadRetryCount < libraryLoadRetryLimit
      && !libraryLoadRetryTimer
      ) {
        libraryLoadRetryCount += 1;
        libraryLoadRetryTimer = setTimeout(() => {
          libraryLoadRetryTimer = null;
          cache.clearGroup(CACHE_GROUPS.LIBRARY);
          void loadData();
        }, 700 * libraryLoadRetryCount);
      }
    } finally {
      loading = false;
      loadDataInFlight = false;
    }
  }

  async function waitForLibraryLoadIdle(timeoutMs = 12000) {
    const startedAt = Date.now();
    while (loadDataInFlight && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function reconcileCurrentLibraryCountsFromChapters(mangaIds?: Iterable<number>) {
    const onlyIds = mangaIds ? new Set([...mangaIds].map(Number).filter(Number.isFinite)) : null;
    const current = onlyIds
      ? store.libraryMangaSnapshot.filter((manga) => onlyIds.has(manga.id))
      : store.libraryMangaSnapshot;
    if (!current.length) return { changedIds: [] as number[], failedIds: [] as number[] };

    const result = await reconcileMangaCountsFromChapters(
      current,
      async (mangaId) => {
        const data = await gql<{ chapters: { nodes: Chapter[] } }>(
          GET_CHAPTERS,
          { mangaId },
          undefined,
          12000,
        );
        return data.chapters.nodes;
      },
      { concurrency: 6 },
    );

    if (result.changedIds.length > 0) {
      const nextMangas = onlyIds
        ? store.libraryMangaSnapshot.map((manga) => result.mangas.find((entry) => entry.id === manga.id) ?? manga)
        : result.mangas;
      setLibraryMangaSnapshot(nextMangas);
      cache.set(CACHE_KEYS.LIBRARY, nextMangas, CACHE_GROUPS.LIBRARY);
      persistCurrentLibrarySnapshot(store.categories);
    }

    if (result.failedIds.length > 0) {
      console.warn(`Could not reconcile chapter counts for ${result.failedIds.length} library titles.`);
    }

    return { changedIds: result.changedIds, failedIds: result.failedIds };
  }

  async function reconcileCurrentLibraryChaptersAfterUpdate(
    beforeUpdate: Manga[],
    candidateMangaIds: Iterable<number>,
    updatedAt: number,
    preloadedChapters?: Map<number, Chapter[]>,
  ) {
    const current = store.libraryMangaSnapshot;
    if (!current.length) return { changedIds: [] as number[], failedIds: [] as number[], notifications: [] };

    const result = await reconcileComicsChapterSnapshot({
      scope: currentSnapshotScope(),
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
      persistCurrentLibrarySnapshot(store.categories);
    }

    if (result.failedIds.length > 0) {
      console.warn(`Could not reconcile chapter updates for ${result.failedIds.length} library titles.`);
    }

    return result;
  }

  $effect(() => {
    const trackingSummary = store.libraryTrackingSummarySnapshot;
    trackedCompletedIds = collectTrackedCompletedMangaIds(trackingSummary);
    trackedChapterTotalsByMangaId = collectTrackedChapterTotalsByMangaId(trackingSummary);
  });

  $effect(() => {
    const scopeKey = libraryBootstrapScopeKey;
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
    if (store.libraryMangaSnapshot.length > 0 || store.categories.length > 0) return;
    scopeKey;
    untrack(() => {
      hydrateFromPersistedSnapshot();
    });
  });

  $effect(() => {
    retryCount;
    if (retryCount <= 0) return;
    loading = true;
    error = null;
    cache.clearGroup(CACHE_GROUPS.LIBRARY);
    untrack(() => loadData());
  });

  $effect(() => {
    const scopeKey = libraryBootstrapScopeKey;
    const bootstrapStatus = activeLibraryBootstrapStatus;
    const warmSnapshot = hasWarmLibrarySnapshot();
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
    if (scopeKey === lastLoadedScopeKey && retryCount <= 0) {
      if (bootstrapStatus === "ready" && !warmSnapshot && !loadDataInFlight) {
        untrack(() => loadData());
        return;
      }
      if (!loadDataInFlight) loading = !warmSnapshot && bootstrapStatus === "loading";
      return;
    }
    lastLoadedScopeKey = scopeKey;
    libraryLoadRetryCount = 0;
    clearCategoryLoadRetry();
    if (libraryLoadRetryTimer) {
      clearTimeout(libraryLoadRetryTimer);
      libraryLoadRetryTimer = null;
    }
    error = null;
    if (!loadDataInFlight) loading = !warmSnapshot && bootstrapStatus === "loading";
    if (bootstrapStatus === "ready" && !warmSnapshot) {
      untrack(() => loadData());
    }
  });

  $effect(() => {
    const filter = store.libraryFilter;
    if (store.librarySection !== "comics") return;
    if (filter === "library" || filter === "downloaded") return;

    const id = Number(filter);
    if (!store.categories.some((category) => category.id === id)) {
      untrack(() => setLibraryFilter("library"));
    }
  });

  $effect(() => {
    const filter = store.libraryFilter;
    if (store.librarySection !== "comics") return;
    if (filter === "library" || filter === "downloaded") return;

    const id = Number(filter);
    if (!Number.isFinite(id) || id <= 0) return;
    if (!store.categories.some((category) => category.id === id)) return;
    const category = store.categories.find((entry) => entry.id === id);
    if ((category?.mangas?.nodes.length ?? 0) > 0) return;
    if (categoryMemberRefreshAttempts.has(id)) return;
    categoryMemberRefreshAttempts.add(id);

    untrack(() => {
      void hydrateCategoryMembers(true).catch((memberError) => {
        categoryMemberRefreshAttempts.delete(id);
        console.warn("Could not hydrate category members:", memberError);
      });
    });
  });

  $effect(() => {
    store.runtimeResolvedLocalProfileId;
    store.runtimeServerUrl;
    store.contentSetupVersion;
    if (store.librarySection !== "books") return;

    untrack(() => {
      void refreshHardcoverTrackingRecords();
      void loadNovelLibraryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }).then((state) => {
        novelsLibraryState = state;
      });
    });
  });

  const comicsSectionState = $derived(
    buildComicsSectionState({
      librarySection: "comics",
      libraryFilter: store.libraryFilter,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? null,
      mangas: allManga,
      categories: store.categories,
      defaultCategoryId: store.settings.defaultLibraryCategoryId ?? null,
      hiddenCategoryIds: store.settings.hiddenCategoryIds ?? [],
      search: comicsSearch,
      sortMode: tabSortMode,
      sortDir: tabSortDir,
      statusFilter: tabStatus,
      recentReads: store.history,
      trackedCompletedIds,
      trackedChapterTotalsByMangaId,
      settings: {
        showNsfw: store.settings.showNsfw,
        nsfwFilteredTags: store.settings.nsfwFilteredTags,
        nsfwAllowedSourceIds: store.settings.nsfwAllowedSourceIds,
        nsfwBlockedSourceIds: store.settings.nsfwBlockedSourceIds,
        libraryCropCovers: store.settings.libraryCropCovers,
      },
      loading,
      error,
      buildCards: false,
    }),
  );

  const novelEntriesForActiveCategory = $derived(
    bookActiveCategoryId
      ? novelsLibraryState.entries.filter((entry) => (store.settings.booksCategoryAssignments[entry.id] ?? []).includes(bookActiveCategoryId))
      : novelsLibraryState.entries,
  );
  const booksSectionState = $derived(
    buildBooksSectionState({
      librarySection: "books",
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? null,
      books: store.books,
      sourceCount: novelEntriesForActiveCategory.length,
      progressByBookId: new Map(store.bookProgress.map((progress) => [progress.bookId, progress])),
      categories: store.settings.booksCategories,
      categoryAssignments: store.settings.booksCategoryAssignments,
      activeCategoryId: bookActiveCategoryId,
      typeFilter: bookTypeFilter,
      search: booksSearch,
      sortMode: bookSortMode,
      sortDir: bookSortDir,
      statusFilter: bookStatusFilter,
      loading: false,
      error: null,
      buildCards: false,
    }),
  );
  const novelsShelf = $derived(
    buildNovelShelf({
      entries: novelEntriesForActiveCategory,
      chapters: novelsLibraryState.chapters,
      progress: novelsLibraryState.progress,
      search: booksSearch,
      sortMode: bookSortMode,
      sortDir: bookSortDir,
      statusFilter: bookStatusFilter,
      hardcoverRecords: hardcoverTrackingRecords,
    }),
  );

  $effect(() => {
    if (recoveredEmptyStartupCategory) return;
    if (store.librarySection !== "comics") return;
    if (loading || comicsSearch.trim() || activeLibraryGenre) return;
    const filter = store.libraryFilter;
    if (filter === "library" || filter === "downloaded") return;
    if (allManga.length === 0) return;

    const category = comicsSectionState.visibleCategories.find((entry) => String(entry.id) === filter);
    if (!category) return;
    const count = comicsSectionState.counts[filter] ?? 0;
    if (count > 0) return;

    recoveredEmptyStartupCategory = true;
    untrack(() => setLibraryFilter("library"));
  });
  const visibleNovelEntries = $derived(
    (bookTypeFilter === "all" || bookTypeFilter === "sources")
      ? novelsShelf.entries
      : [],
  );
  const bookProgressByBookId = $derived(new Map(store.bookProgress.map((progress) => [progress.bookId, progress])));
  const novelProgressByNovelId = $derived(new Map(novelsLibraryState.progress.map((progress) => [progress.novelId, progress])));

  function localizeSectionTabs(tabs: LibrarySectionTabVM[]): LibrarySectionTabVM[] {
    return tabs.map((tab) => ({
      ...tab,
      label: tab.id === "books" ? $_("library.sections.books") : $_("library.sections.comics"),
    }));
  }

  function localizeCollection(collection: LibraryCollectionVM): LibraryCollectionVM {
    const keyById: Record<string, string> = {
      all: "library.collections.all",
      library: "library.collections.saved",
      downloaded: "library.collections.downloaded",
      "books:saved": "library.collections.saved",
      "books:downloaded": "library.collections.downloaded",
      "books:finished": "library.collections.finished",
    };
    const key = keyById[collection.id.toLowerCase()];
    return key ? { ...collection, label: $_(key) } : collection;
  }

  function localizeSortOptionLabel(id: string, section: LibrarySectionKind): string {
    const keyById: Record<string, string> = section === "books"
      ? {
          az: "library.sort.az",
          author: "library.sort.author",
          recentlyAdded: "library.sort.recentlyAdded",
          recentlyRead: "library.sort.recentlyRead",
          sectionCount: "library.sort.bookContents",
        }
      : {
          az: "library.sort.az",
          unreadCount: "library.sort.unreadChapters",
          totalChapters: "library.sort.totalChapters",
          recentlyAdded: "library.sort.recentlyAdded",
          recentlyRead: "library.sort.recentlyRead",
          latestFetched: "library.sort.latestFetchedChapter",
          latestUploaded: "library.sort.latestUploadedChapter",
        };
    return keyById[id] ? $_(keyById[id]) : id;
  }

  function localizeFilterOptionLabel(id: string, section: LibrarySectionKind): string {
    const keyById: Record<string, string> = section === "books"
      ? {
          all: "library.filter.allBooks",
          unopened: "library.filter.unopened",
          in_progress: "library.filter.inProgress",
          finished: "library.filter.finished",
        }
      : {
          ALL: "library.status.all",
          UNOPENED: "library.status.unopened",
          ONGOING: "library.status.ongoing",
          COMPLETED: "library.status.completed",
          CANCELLED: "library.status.cancelled",
          HIATUS: "library.status.hiatus",
          UNKNOWN: "library.status.unknown",
        };
    return keyById[id] ? $_(keyById[id]) : id;
  }

  function localizeToolbar(toolbar: LibraryToolbarVM, section: LibrarySectionKind): LibraryToolbarVM {
    return {
      ...toolbar,
      searchPlaceholder: section === "books" ? $_("library.search.books") : $_("library.search.comics"),
      sortOptions: toolbar.sortOptions.map((option) => ({
        ...option,
        label: localizeSortOptionLabel(option.id, section),
      })),
      filterOptions: toolbar.filterOptions.map((option) => ({
        ...option,
        label: localizeFilterOptionLabel(option.id, section),
      })),
    };
  }

  function localizeBookTypeOptions(options: BooksTypeOptionVM[]): BooksTypeOptionVM[] {
    const keyById: Record<BooksTypeOptionVM["id"], string> = {
      all: "library.books.types.all",
      epub: "library.books.types.epub",
      pdf: "library.books.types.pdf",
      sources: "library.books.types.sources",
    };
    return options.map((option) => ({
      ...option,
      label: $_(keyById[option.id]),
    }));
  }

  function localizeSectionVm<T extends LibrarySectionVM>(vm: T): T {
    return {
      ...vm,
      sectionTabs: localizeSectionTabs(vm.sectionTabs),
      collections: vm.collections.map(localizeCollection),
      toolbar: localizeToolbar(vm.toolbar, vm.kind),
    };
  }

  const localizedBooksSectionVm = $derived(localizeSectionVm(booksSectionState.vm));
  const localizedComicsSectionVm = $derived(localizeSectionVm(comicsSectionState.vm));
  const displaySectionVm = $derived(
    visualLibrarySection === "books"
      ? localizedBooksSectionVm
      : localizedComicsSectionVm,
  );
  const activeSortDefaultMode = $derived(visualLibrarySection === "books" ? "recentlyAdded" : "az");
  const activeSortDefaultDir = $derived(visualLibrarySection === "books" ? "desc" as const : "asc" as const);
  const activeFilterDefaultValue = $derived(visualLibrarySection === "books" ? "all" : "ALL");
  const activeSortLabel = $derived(visualLibrarySection === "books" ? $_("library.sort.books") : $_("library.sort.by"));
  const activeFilterLabel = $derived(visualLibrarySection === "books" ? $_("library.filter.readingStatus") : $_("library.filter.byStatus"));
  const comicsViewKey = $derived(`${store.libraryFilter}|${comicsSearch}|${tabSortMode}|${tabSortDir}|${tabStatus}|genre:${activeLibraryGenre ?? "all"}`);
  const booksViewKey = $derived(`${bookActiveCategoryId ?? "all"}|${bookTypeFilter}|${booksSearch}|${bookSortMode}|${bookSortDir}|${bookStatusFilter}|genre:${activeLibraryGenre ?? "all"}`);
  const displaySettings = $derived({
    viewMode: store.settings.libraryViewMode,
    preferredColumns: store.settings.libraryPreferredGridColumns,
    showProgress: store.settings.libraryShowProgress,
    showOutline: store.settings.libraryShowCardOutline,
  });

  type GenreChipVM = { label: string; count: number; active: boolean };

  function normalizeGenreKey(value: string): string {
    return value.trim().toLowerCase();
  }

  function collectGenreCounts(values: Iterable<string | null | undefined>): Map<string, { label: string; count: number }> {
    const counts = new Map<string, { label: string; count: number }>();
    for (const rawGenre of values) {
      const label = rawGenre?.trim();
      if (!label) continue;
      const key = normalizeGenreKey(label);
      const current = counts.get(key);
      if (current) {
        current.count += 1;
      } else {
        counts.set(key, { label, count: 1 });
      }
    }
    return counts;
  }

  function genreListMatches(genres: readonly string[] | null | undefined, selectedGenre: string | null): boolean {
    if (!selectedGenre) return true;
    const selectedKey = normalizeGenreKey(selectedGenre);
    return (genres ?? []).some((genre) => {
      const genreKey = normalizeGenreKey(genre);
      return genreKey === selectedKey || genreKey.includes(selectedKey);
    });
  }

  function genreChipsFromCounts(counts: Map<string, { label: string; count: number }>): GenreChipVM[] {
    const activeKey = activeLibraryGenre ? normalizeGenreKey(activeLibraryGenre) : null;
    return Array.from(counts.entries())
      .sort((left, right) => right[1].count - left[1].count || left[1].label.localeCompare(right[1].label))
      .map(([key, value]) => ({
        label: value.label,
        count: value.count,
        active: key === activeKey,
      } satisfies GenreChipVM));
  }

  const comicsGenreChips = $derived(
    genreChipsFromCounts(collectGenreCounts(allManga.flatMap((manga) => manga.genre ?? []))),
  );
  const booksGenreChips = $derived(
    genreChipsFromCounts(collectGenreCounts([
      ...(booksSectionState?.filteredBooks ?? []).flatMap((book) => book.genres ?? []),
      ...visibleNovelEntries.flatMap((entry) => entry.tags ?? []),
    ])),
  );
  const activeGenreChips = $derived(visualLibrarySection === "books" ? booksGenreChips : comicsGenreChips);
  const hasScrollableGenreChips = $derived(activeGenreChips.length > 4);
  const genreFilteredComicsManga = $derived(
    activeLibraryGenre
      ? (comicsSectionState?.filteredManga ?? []).filter((manga) => genreListMatches(manga.genre, activeLibraryGenre))
      : comicsSectionState?.filteredManga ?? [],
  );
  function isFinishedBook(bookId: string): boolean {
    return (bookProgressByBookId.get(bookId)?.progressPercent ?? 0) >= 0.98;
  }

  function isFinishedNovel(novelId: string): boolean {
    return (novelProgressByNovelId.get(novelId)?.progressPercent ?? 0) >= 0.98;
  }

  const standardFilteredBooks = $derived.by(() => {
    const books = booksSectionState?.filteredBooks ?? [];
    if (activeBooksStandardFilter === "downloaded") return books.filter(hasBookLocalAsset);
    if (activeBooksStandardFilter === "finished") return books.filter((book) => isFinishedBook(book.id));
    return books;
  });
  const standardFilteredNovelEntries = $derived.by(() => {
    if (activeBooksStandardFilter === "downloaded") return [];
    if (activeBooksStandardFilter === "finished") return visibleNovelEntries.filter((entry) => isFinishedNovel(entry.id));
    return visibleNovelEntries;
  });
  const genreFilteredBooks = $derived(
    activeLibraryGenre
      ? standardFilteredBooks.filter((book) => genreListMatches(book.genres, activeLibraryGenre))
      : standardFilteredBooks,
  );
  const genreFilteredNovelEntries = $derived(
    activeLibraryGenre
      ? standardFilteredNovelEntries.filter((entry) => genreListMatches(entry.tags, activeLibraryGenre))
      : standardFilteredNovelEntries,
  );
  const genreFilteredBooksTotal = $derived(genreFilteredBooks.length + genreFilteredNovelEntries.length);
  const booksBodyViewKey = $derived(
    `${booksViewKey}|standard:${activeBooksStandardFilter}|novels:${novelsLibraryState.updatedAtMs ?? 0}:${genreFilteredNovelEntries.length}`,
  );

  $effect(() => {
    const selectedGenre = activeLibraryGenre;
    if (!selectedGenre) return;
    if (activeGenreChips.some((chip) => normalizeGenreKey(chip.label) === normalizeGenreKey(selectedGenre))) return;
    untrack(() => {
      activeLibraryGenre = null;
    });
  });

  function toggleLibraryGenre(label: string) {
    activeLibraryGenre = activeLibraryGenre && normalizeGenreKey(activeLibraryGenre) === normalizeGenreKey(label)
      ? null
      : label;
  }

  function handleGenrePointerDown(event: PointerEvent) {
    if (!genreScrollEl) return;
    genreDragActive = true;
    suppressNextGenreClick = false;
    pendingGenreClickLabel = getGenreButtonLabel(event.target);
    genreDragStartX = event.clientX;
    genreDragStartScrollLeft = genreScrollEl.scrollLeft;
    genreScrollEl.setPointerCapture(event.pointerId);
  }

  function handleGenrePointerMove(event: PointerEvent) {
    if (!genreDragActive || !genreScrollEl) return;
    const delta = event.clientX - genreDragStartX;
    if (Math.abs(delta) > 4) {
      suppressNextGenreClick = true;
      pendingGenreClickLabel = null;
    }
    genreScrollEl.scrollLeft = genreDragStartScrollLeft - delta;
  }

  function handleGenrePointerUp(event: PointerEvent) {
    if (!genreScrollEl) return;
    if (!suppressNextGenreClick && pendingGenreClickLabel) {
      toggleLibraryGenre(pendingGenreClickLabel);
      suppressNextGenreClick = true;
    }
    pendingGenreClickLabel = null;
    genreDragActive = false;
    if (genreScrollEl.hasPointerCapture(event.pointerId)) {
      genreScrollEl.releasePointerCapture(event.pointerId);
    }
  }

  function handleGenreClick(label: string, event: MouseEvent) {
    if (suppressNextGenreClick) {
      suppressNextGenreClick = false;
      return;
    }
    if (event.detail > 0) return;
    toggleLibraryGenre(label);
  }

  function getGenreButtonLabel(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLButtonElement>("[data-library-genre]")?.dataset.genreLabel ?? null;
  }

  function genreChipFitClass(label: string): string {
    const length = label.trim().length;
    if (length >= 15) return "fit-xs";
    if (length >= 12) return "fit-sm";
    return "";
  }

  const activeHeroTitle = $derived(visualLibrarySection === "books" ? $_("library.sections.books") : $_("library.sections.comics"));
  const activeHeroCountLabel = $derived(
    visualLibrarySection === "books"
      ? $_("library.count.booksSaved", { count: store.books.length + novelsLibraryState.entries.length })
      : $_("library.count.titles", { count: comicsSectionState?.counts.library ?? 0 }),
  );
  const booksStandardCollections = $derived<LibraryCollectionVM[]>([
    {
      id: "books:saved",
      label: $_("library.collections.saved"),
      count: store.books.length + novelsLibraryState.entries.length,
      icon: "books",
      active: isActiveBooksStandardFilter("saved"),
      reorderable: false,
      isDefault: true,
    },
    {
      id: "books:downloaded",
      label: $_("library.collections.downloaded"),
      count: store.books.filter(hasBookLocalAsset).length,
      icon: "download",
      active: isActiveBooksStandardFilter("downloaded"),
      reorderable: false,
      isDefault: false,
    },
    {
      id: "books:finished",
      label: $_("library.collections.finished"),
      count: store.books.filter((book) => isFinishedBook(book.id)).length
        + novelsLibraryState.entries.filter((entry) => isFinishedNovel(entry.id)).length,
      icon: "folder",
      active: isActiveBooksStandardFilter("finished"),
      reorderable: false,
      isDefault: false,
    },
  ]);

  function isActiveBooksStandardFilter(filter: typeof activeBooksStandardFilter): boolean {
    return activeBooksStandardFilter === filter;
  }
  const activeHeroCollections = $derived(displaySectionVm?.collections ?? []);
  const heroSystemCollections = $derived(
    visualLibrarySection === "books"
      ? booksStandardCollections
      : activeHeroCollections.filter((collection) => isSystemHeroCollection(collection)),
  );
  const heroUserCollections = $derived(
    visualLibrarySection === "books"
      ? activeHeroCollections.filter((collection) => !isSystemHeroCollection(collection))
      : activeHeroCollections.filter((collection) => !isSystemHeroCollection(collection)),
  );
  const activeBookTypeOptions = $derived(
    visualLibrarySection === "books" ? localizeBookTypeOptions(booksSectionState?.vm?.typeOptions ?? []) : [],
  );

  const comicsByCardId = $derived(new Map(allManga.map((manga) => [createComicLibraryCardId(manga.id), manga])));
  const booksByCardId = $derived(new Map(store.books.map((book) => [createBookLibraryCardId(book.id), book])));

  function isSystemHeroCollection(collection: LibraryCollectionVM) {
    const id = collection.id.toLowerCase();
    const label = collection.label.trim().toLowerCase();
    return id === "all" || id === "library" || id === "downloaded" || label === "saved" || label === "downloaded" || label === "finished" || label === "all";
  }

  const comicsActions = $derived(createComicsLibraryActions({
    openSection: (section) => switchLibrarySection(section),
    selectCollection: (id) => setLibraryFilter(id),
    setSearch: (value) => { comicsSearch = value; },
    setSortMode: (mode) => setTabSort(mode as LibrarySortMode),
    setSortDir: (dir) => setTabSort(tabSortMode, dir),
    setFilter: (value) => setTabStatus(value as LibraryStatusFilter),
    onOpen: (id) => {
      const manga = comicsByCardId.get(id);
      if (manga) openMangaDetail(manga);
    },
  }));

  $effect(() => {
    setSearchNovelLibrarySnapshot(novelsLibraryState.entries, novelsLibraryState.chapters);
  });

  const booksActions = $derived(createBooksLibraryActions({
    openSection: (section) => switchLibrarySection(section),
    selectCollection: (id) => updateBooksLibraryUi({
      activeCategoryId: normalizeBooksCategorySelection(id),
    }),
    selectType: (id) => updateBooksLibraryUi({ typeFilter: id as BooksLibraryUiState["typeFilter"] }),
    setSearch: (value) => updateBooksLibraryUi({ search: value }),
    setSortMode: (mode) => setBookSort(mode as BooksLibrarySortMode),
    setSortDir: (dir) => updateBooksLibraryUi({ sortDir: dir }),
    setFilter: (value) => setBookStatusFilterValue(value as BooksLibraryStatusFilter),
    onOpen: (id) => {
      const book = booksByCardId.get(id);
      if (book) setActiveBookId(book.id);
    },
  }));

  function openNovelCard(novelId: string) {
    const entry = getNovelLibraryEntry(novelsLibraryState, novelId);
    if (!entry) return;
    setActiveNovelDetail({
      novel: buildNovelDetailRecordFromLibrary(entry, getNovelLibraryChapters(novelsLibraryState, novelId)),
      inLibrary: true,
    });
  }

  function createCollectionsReorderApi(): LibraryCollectionsReorderApi | null {
    const domain = store.librarySection;
    if (domain !== "comics" && domain !== "books") return null;

    return {
      activeId: dragTabId,
      targetId: dropTargetTabId,
      insertIndex: dragInsertIdx,
      onDragStart: (id, event) => {
        activeDragKind = "tab";
        dragTabId = id;
        event.dataTransfer!.effectAllowed = "move";
        event.dataTransfer!.setData(DT_TAB, id);
        event.dataTransfer!.setData("text/plain", `tab:${id}`);
      },
      onDragOver: (id, index, event) => {
        if (activeDragKind !== "tab") return;
        if (dragTabId === null || dragTabId === id) return;
        event.preventDefault();
        event.dataTransfer!.dropEffect = "move";
        dropTargetTabId = id;
        dragInsertIdx = index;
      },
      onDragLeave: (id) => {
        if (dropTargetTabId === id) {
          dropTargetTabId = null;
        }
      },
      onDrop: async (id, _index, event) => {
        event.preventDefault();
        dropTargetTabId = null;
        dragInsertIdx = null;

        if (activeDragKind !== "tab") return;
        if (dragTabId === null || dragTabId === id) {
          dragTabId = null;
          return;
        }

        const dragId = dragTabId;
        const dropId = id;
        dragTabId = null;
        activeDragKind = null;

        if (domain === "comics") {
          const numericDragId = Number(dragId);
          const numericDropId = Number(dropId);

          const sorted = [...store.categories]
            .filter((category) => category.id !== 0)
            .sort((left, right) => left.order - right.order);

          const fromIdx = sorted.findIndex((category) => category.id === numericDragId);
          const toIdx = sorted.findIndex((category) => category.id === numericDropId);
          if (fromIdx < 0 || toIdx < 0) return;

          const reordered = [...sorted];
          const [moved] = reordered.splice(fromIdx, 1);
          reordered.splice(toIdx, 0, moved);
          const withNewOrder = reordered.map((category, index) => ({ ...category, order: index + 1 }));
          setCategories(store.categories.map((category) => withNewOrder.find((updated) => updated.id === category.id) ?? category));

          try {
            await gql<{ updateCategoryOrder: { categories: Category[] } }>(
              UPDATE_CATEGORY_ORDER,
              { id: numericDragId, position: toIdx + 1 },
            );
          } catch (reorderError) {
            console.error("Tab reorder failed:", reorderError);
            await reloadCategories();
          }
          return;
        }

        const sorted = sortBooksCategories(store.settings.booksCategories);
        const fromIdx = sorted.findIndex((category) => category.id === dragId);
        const toIdx = sorted.findIndex((category) => category.id === dropId);
        if (fromIdx < 0 || toIdx < 0) return;

        const reordered = [...sorted];
        const [moved] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, moved);
        updateSettings({
          booksCategories: reordered.map((category, index) => ({
            ...category,
            order: index + 1,
          })),
        });
      },
      onDragEnd: () => {
        activeDragKind = null;
        dragTabId = null;
        dropTargetTabId = null;
        dragInsertIdx = null;
      },
    };
  }

  const collectionsReorderApi = $derived(createCollectionsReorderApi());

  function switchLibrarySection(section: string) {
    if (section !== "comics" && section !== "books") return;
    activeLibraryGenre = null;
    if (section === "books") activeBooksStandardFilter = "saved";
    settledLibrarySection = section;
    setLibrarySection(section);
  }

  function handleSectionChange(section: string) {
    if (visualLibrarySection === section) return;
    switchLibrarySection(section);
  }

  function handleCollectionSelect(id: string) {
    if (visualLibrarySection === "books") {
      activeBooksStandardFilter = "saved";
      booksActions.selectCollection(id);
    } else {
      comicsActions.selectCollection(id);
    }
  }

  function handleHeroSystemCollectionSelect(id: string) {
    if (visualLibrarySection !== "books") {
      comicsActions.selectCollection(id);
      return;
    }

    const nextFilter =
      id === "books:downloaded"
        ? "downloaded"
        : id === "books:finished"
          ? "finished"
          : "saved";

    activeBooksStandardFilter = nextFilter;
    updateBooksLibraryUi({
      activeCategoryId: null,
      typeFilter: "all",
      statusFilter: "all",
    });
  }

  function handleSearchChange(value: string) {
    if (visualLibrarySection === "books") booksActions.setSearch(value);
    else comicsActions.setSearch(value);
  }

  function handleSortModeChange(mode: string) {
    if (visualLibrarySection === "books") booksActions.setSortMode(mode);
    else comicsActions.setSortMode(mode);
  }

  function handleSortDirToggle() {
    if (visualLibrarySection === "books") toggleBookSortDir();
    else toggleTabSortDir();
  }

  function handleFilterChange(value: string) {
    if (visualLibrarySection === "books") booksActions.setFilter(value);
    else comicsActions.setFilter(value);
  }

  function handleBookTypeChange(id: BooksTypeFilterId) {
    booksActions.selectType(id);
  }

  function handleViewModeChange(mode: LibraryViewMode) {
    updateSettings({ libraryViewMode: mode });
  }

  function handlePreferredColumnsChange(value: LibraryPreferredGridColumns) {
    updateSettings({ libraryPreferredGridColumns: value });
  }

  function handleShowProgressChange(value: boolean) {
    updateSettings({ libraryShowProgress: value });
  }

  function handleShowOutlineChange(value: boolean) {
    updateSettings({ libraryShowCardOutline: value });
  }

  function manualUpdateCategoryIds() {
    return undefined;
  }

  function formatLibraryUpdateProgress(jobsInfo: any) {
    const finished = Number(jobsInfo?.finishedJobs ?? 0);
    const total = Number(jobsInfo?.totalJobs ?? 0);
    const skippedMangas = Number(jobsInfo?.skippedMangasCount ?? 0);
    if (total > 0) {
      const skipped = skippedMangas > 0 ? `, ${skippedMangas} skipped by folder rules` : "";
      if (finished <= 0 && jobsInfo?.isRunning) {
        return `Starting update for ${total} titles${skipped}.`;
      }
      const current = Math.min(finished, total);
      const percent = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
      return `Checking titles ${current}/${total} · ${percent}%${skipped}.`;
    }
    if (jobsInfo?.isRunning) return "Suwayomi is checking your library.";
    return "Preparing library update.";
  }

  async function openLibraryRefreshDialog() {
    if (store.libraryUpdateInFlight) {
      await clearStaleLibraryUpdateInFlight();
    }
    if (manualRefreshInFlight || store.libraryUpdateInFlight) {
      showSharedLibraryUpdateProgress("Library update already running.", 1800);
      addToast({
        kind: "info",
        title: translate("ui_libraryUpdateAlreadyRunning"),
        body: translate("ui_epigraphIsAlreadyCheckingYourLibrary"),
        duration: 2400,
      });
      return;
    }
    refreshDialogOpen = true;
  }

  function closeLibraryRefreshDialog() {
    if (manualRefreshInFlight || store.libraryUpdateInFlight || refreshDialogBusy) return;
    refreshDialogOpen = false;
  }

  async function refreshComicsLibrary() {
    const beforeUpdate = [...store.libraryMangaSnapshot];
    const updateRun = await runSharedLibraryUpdate({
      reason: "manual-library-update",
      categories: manualUpdateCategoryIds(),
      onLiveRefresh: async () => {
        await refreshLibrarySnapshotLive();
      },
    });
    const updatedAt = updateRun.updatedAt;
    updateSettings({ lastLibraryUpdateAt: updatedAt });
    showSharedLibraryUpdateProgress("Refreshing local Comics data.");
    cache.clearGroup(CACHE_GROUPS.LIBRARY);
    await waitForLibraryLoadIdle();
    await loadData();
    bumpLibraryCoverCacheGeneration();
    if (updateRun.cancelled) {
      showSharedLibraryUpdateProgress("Comics library update stopped.", 1800);
      addToast({
        kind: "info",
        title: translate("ui_comicsUpdateStopped"),
        body: translate("ui_epigraphKeptTheTitlesThatSuwayomiAlreadyRefreshed"),
      });
      return updateRun;
    }
    if (updateRun.changedMangaIds.length > 0) {
      showSharedLibraryUpdateProgress("Reconciling changed titles.");
    }
    const comicsReconcile = await reconcileCurrentLibraryChaptersAfterUpdate(
      beforeUpdate,
      updateRun.changedMangaIds,
      updatedAt,
      updateRun.preloadedChapters,
    );
    const entries = recordComicsUpdateNotifications(comicsReconcile.notifications, updatedAt);
    const reconcileIssues = comicsReconcile.failedIds.map((mangaId) => {
      const manga = store.libraryMangaSnapshot.find((entry) => entry.id === mangaId) ?? beforeUpdate.find((entry) => entry.id === mangaId);
      const sourceName = manga?.source?.displayName || manga?.source?.name || manga?.sourceId || "Unknown source";
      return {
        runId: `comics-reconcile:${updatedAt}`,
        contentKind: "manga" as const,
        title: manga?.title ?? `Manga ${mangaId}`,
        itemId: String(mangaId),
        sourceId: String(manga?.source?.id ?? manga?.sourceId ?? "unknown"),
        sourceName,
        extensionName: sourceName,
        message: "Epigraph could not verify this title's chapter list after the update.",
        errorType: "unknown" as const,
      };
    });
    const issues = recordLibraryUpdateIssues([...updateRun.issues, ...reconcileIssues], updatedAt);
    showSharedLibraryUpdateProgress(
      formatLibraryUpdateFinalSummary("Comics library", updateRun.jobsInfo, issues.length),
      1800,
      libraryUpdateProgressNumbers(updateRun.jobsInfo),
    );
    addSystemNotification({
      kind: issues.length > 0 ? "info" : "success",
      title: issues.length > 0 ? translate("ui_comicsLibraryRefreshedWithIssues") : entries.length > 0 ? translate("ui_newChaptersFound") : translate("ui_comicsLibrarySyncCompleted"),
      body: issues.length > 0
        ? `${issues.length} title${issues.length === 1 ? "" : "s"} could not update across ${new Set(issues.map((issue) => issue.sourceId)).size} source${new Set(issues.map((issue) => issue.sourceId)).size === 1 ? "" : "s"}.`
        : entries.length > 0
          ? `${entries.reduce((sum, entry) => sum + entry.chapterDelta, 0)} new chapters added across ${entries.length} titles.`
          : translate("ui_epigraphRefreshedYourComicsLibrary"),
      createdAt: updatedAt,
    });
    addToast({
      kind: issues.length > 0 ? "info" : "success",
      title: issues.length > 0 ? translate("ui_comicsUpdatedWithIssues") : entries.length > 0 ? translate("ui_newChaptersFound") : translate("ui_comicsLibraryUpdated"),
      body: issues.length > 0
        ? `${issues.length} title${issues.length === 1 ? "" : "s"} could not update. See Recent Activity.`
        : entries.length > 0
          ? `${entries.reduce((sum, entry) => sum + entry.chapterDelta, 0)} new chapters added across ${entries.length} titles.`
          : translate("ui_epigraphRefreshedYourComicsLibrary"),
    });
    return updateRun;
  }

  function manualUpdateNovelIds() {
    if (!bookActiveCategoryId) return null;
    return novelsLibraryState.entries
      .filter((entry) => (store.settings.booksCategoryAssignments[entry.id] ?? []).includes(bookActiveCategoryId))
      .map((entry) => entry.id);
  }

  function updateExcludedNovelIds() {
    return Array.from(getBooksUpdateExcludedBookIds(
      store.settings.booksCategories,
      store.settings.booksCategoryAssignments,
    ));
  }

  async function refreshBooksLibrary(options: { categoryNovelIds?: readonly string[] | null } = {}) {
    showSharedLibraryUpdateProgress("Refreshing Books and source novels.");
    const updatedAt = Date.now();
    updateSettings({ lastLibraryUpdateAt: updatedAt });
    const result = await refreshNovelLibraryFromSources({
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    }, {
      categoryNovelIds: options.categoryNovelIds ?? null,
      concurrency: 1,
      downloadNewChapters: store.settings.downloadNewNovelChapters,
      excludedNovelIds: updateExcludedNovelIds(),
      onlyOngoing: store.settings.onlyUpdateOngoingNovels,
      pauseMs: 800,
      onProgress: ({ checked, total, currentTitle, newChapters, failed }) => {
        if (total <= 0) return;
        const current = Math.max(0, Math.min(total, checked));
        const percent = current >= total ? 100 : Math.max(0, Math.min(99, Math.floor((current / total) * 100)));
        const titlePart = currentTitle ? ` - ${currentTitle}` : "";
        const newPart = newChapters > 0 ? `, ${newChapters} new` : "";
        const failedPart = failed > 0 ? `, ${failed} failed` : "";
        showSharedLibraryUpdateProgress(
          `Checking source novels ${current}/${total}${newPart}${failedPart}${titlePart}.`,
          0,
          { current, total, percent },
        );
      },
    });
    novelsLibraryState = result.state;
    bumpLibraryCoverCacheGeneration();
    const novelNotifications = recordNovelUpdateNotifications(groupRefreshedNovelChaptersForNotifications(result.newChapterEntries), updatedAt);
    const novelIssues = recordLibraryUpdateIssues(result.failures.map((failure) => ({
      runId: `books-update:${updatedAt}`,
      contentKind: "novel" as const,
      title: failure.title,
      itemId: failure.novelId,
      sourceId: failure.sourceId,
      sourceName: failure.sourceName,
      extensionName: failure.sourceName,
      message: failure.error,
      errorType: failure.errorType ?? (failure.error.match(/timeout|timed out|abort/i) ? "timeout" as const
        : failure.error.match(/429|rate.?limit/i) ? "rate-limit" as const
          : failure.error.match(/missing source|source id/i) ? "missing-source" as const
            : "source-error" as const),
      actionUrl: failure.actionUrl,
      retrySourceId: failure.retrySourceId,
      retryKind: failure.retryKind,
      recoveryHint: failure.recoveryHint,
    })), updatedAt);
    const title = result.failed > 0 ? "Books library refreshed with warnings" : "Books library updated";
    const body = result.checked > 0
      ? `${result.updated}/${result.checked} source novels refreshed${result.newChapters > 0 ? `, ${result.newChapters} new chapters found` : ""}${result.failed > 0 ? `, ${result.failed} failed` : ""}.`
      : "No source novels were available to refresh.";
    showSharedLibraryUpdateProgress(
      "Books library update finished.",
      1800,
      result.total > 0 ? { current: result.checked, total: result.total, percent: 100 } : undefined,
    );
    addSystemNotification({
      kind: result.failed > 0 ? "info" : "success",
      title: novelNotifications.length > 0 ? translate("ui_newNovelChaptersFound") : title,
      body: novelIssues.length > 0
        ? `${body} ${novelIssues.length} issue${novelIssues.length === 1 ? "" : "s"} were saved to Recent Activity.`
        : body,
    });
    addToast({
      kind: result.failed > 0 ? "info" : "success",
      title,
      body,
    });
  }

  async function runLibraryRefresh(target: "active" | "all") {
    if (store.libraryUpdateInFlight) {
      await clearStaleLibraryUpdateInFlight();
    }
    if (manualRefreshInFlight || store.libraryUpdateInFlight) {
      showSharedLibraryUpdateProgress("Library update already running.", 1800);
      addToast({
        kind: "info",
        title: translate("ui_libraryUpdateAlreadyRunning"),
        body: translate("ui_epigraphIsAlreadyCheckingYourLibrary"),
        duration: 2400,
      });
      return;
    }
    manualRefreshInFlight = true;
    refreshDialogBusy = target;
    setLibraryUpdateInFlight(true);
    try {
      refreshDialogOpen = false;
      if (target === "all") {
        const comicsRun = await refreshComicsLibrary();
        if (comicsRun.cancelled) return;
        await refreshBooksLibrary();
      } else if (store.librarySection === "comics") {
        await refreshComicsLibrary();
      } else {
        await refreshBooksLibrary({ categoryNovelIds: manualUpdateNovelIds() });
      }
    } catch (refreshError) {
      console.error(refreshError);
      showSharedLibraryUpdateProgress("Library update failed.", 1800);
      addToast({
        kind: "error",
        title: translate("ui_couldNotUpdateLibrary"),
        body: refreshError instanceof Error ? refreshError.message : translate("ui_epigraphCouldNotReachSuwayomi"),
      });
      addSystemNotification({
        kind: "error",
        title: translate("ui_couldNotUpdateLibrary"),
        body: refreshError instanceof Error ? refreshError.message : translate("ui_epigraphCouldNotReachSuwayomi"),
      });
    } finally {
      manualRefreshInFlight = false;
      refreshDialogBusy = null;
      setLibraryUpdateInFlight(false);
    }
  }

  function bumpCoverRecoveryVersions(mangaIds: Iterable<number>) {
    const next = new Map(coverRecoveryVersions);
    for (const mangaId of mangaIds) {
      next.set(mangaId, (next.get(mangaId) ?? 0) + 1);
    }
    coverRecoveryVersions = next;
  }

  function wakeServerForLibraryCovers(mangaId: number) {
    if (store.librarySection !== "comics") return;
    pendingCoverRecoveryIds.add(mangaId);
    if (coverWakeInFlight) return;
    coverWakeInFlight = (async () => {
      const awake = await ensureServerAwakeFor("library-covers", {
        serverUrl: store.runtimeServerUrl,
        binary: store.settings.serverBinary,
        updateIntensity: store.settings.libraryUpdateIntensity,
      profileId: store.runtimeResolvedLocalProfileId,
      profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
      });
      if (awake) {
        bumpCoverRecoveryVersions(pendingCoverRecoveryIds);
        pendingCoverRecoveryIds.clear();
      }
    })()
      .catch((coverError) => {
        console.warn("Could not wake Suwayomi for library covers:", coverError);
      })
      .finally(() => {
        coverWakeInFlight = null;
      });
  }

  async function addToLibrary(manga: Manga) {
    await gql(UPDATE_MANGA, { id: manga.id, inLibrary: true }).catch(console.error);
    setLibraryMangaSnapshot(allManga.map((entry) => (entry.id === manga.id ? { ...entry, inLibrary: true } : entry)));
    cache.clear(CACHE_KEYS.LIBRARY);
  }

  async function removeFromLibrary(manga: Manga) {
    await gql(UPDATE_MANGA, { id: manga.id, inLibrary: false }).catch(console.error);
    setLibraryMangaSnapshot(allManga.filter((entry) => entry.id !== manga.id));
    cache.clearGroup(CACHE_GROUPS.LIBRARY);
    await reloadCategories();
  }

  async function bulkRemoveFromLibrary(mangaIds: number[]) {
    const ids = Array.from(new Set(mangaIds.filter((id) => Number.isFinite(id))));
    if (!ids.length) return;
    const idSet = new Set(ids);
    const results = await Promise.allSettled(ids.map((id) => gql(UPDATE_MANGA, { id, inLibrary: false })));
    const failedIds = ids.filter((_, index) => results[index]?.status === "rejected");
    const successfulIds = ids.filter((id) => !failedIds.includes(id));
    if (successfulIds.length) {
      const successSet = new Set(successfulIds);
      setLibraryMangaSnapshot(allManga.filter((entry) => !successSet.has(entry.id)));
      cache.clearGroup(CACHE_GROUPS.LIBRARY);
      await reloadCategories();
    }
    if (failedIds.length) {
      addToast({
        kind: "error",
        title: translate("ui_couldNotRemoveEveryTitle"),
        body: `${failedIds.length} of ${idSet.size} selected titles could not be removed.`,
      });
    }
  }

  async function deleteAllDownloads(manga: Manga) {
    try {
      const data = await gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId: manga.id });
      const ids = data.chapters.nodes.filter((chapter) => chapter.isDownloaded).map((chapter) => chapter.id);
      if (!ids.length) return;
      await gql(DELETE_DOWNLOADED_CHAPTERS, { ids });
      await Promise.allSettled(ids.map((id) => gql(DEQUEUE_DOWNLOAD, { chapterId: id })));
      setLibraryMangaSnapshot(allManga.map((entry) => entry.id === manga.id ? { ...entry, downloadCount: 0 } : entry));
    } catch (deleteError) {
      console.error(deleteError);
    }
  }

  async function toggleMangaCategory(manga: Manga, category: Category) {
    const categories = categoriesHaveMangaMembers()
      ? store.categories
      : await hydrateCategoryMembers(false).catch(() => store.categories);
    const currentCategory = categories.find((entry) => entry.id === category.id);
    const inCategory = (currentCategory?.mangas?.nodes ?? []).some((entry) => entry.id === manga.id);
    setCategories(categories.map((entry) => {
      if (entry.id !== category.id || !entry.mangas) return entry;
      const nodes = inCategory
        ? entry.mangas.nodes.filter((node) => node.id !== manga.id)
        : [...entry.mangas.nodes, manga];
      return { ...entry, mangas: { nodes } };
    }));

    try {
      await gql(UPDATE_MANGA_CATEGORIES, {
        mangaId: manga.id,
        addTo: inCategory ? [] : [category.id],
        removeFrom: inCategory ? [category.id] : [],
      });
      await reloadCategories();
    } catch (toggleError) {
      console.error(toggleError);
      await reloadCategories();
    }
  }

  async function bulkToggleMangaCategory(mangaIds: number[], category: Category) {
    const ids = Array.from(new Set(mangaIds.filter((id) => Number.isFinite(id))));
    if (!ids.length) return;
    const categories = categoriesHaveMangaMembers()
      ? store.categories
      : await hydrateCategoryMembers(false).catch(() => store.categories);
    const currentCategory = categories.find((entry) => entry.id === category.id);
    const currentIds = new Set((currentCategory?.mangas?.nodes ?? []).map((entry) => entry.id));
    const addIds = ids.filter((id) => !currentIds.has(id));
    const removeIds = ids.filter((id) => currentIds.has(id));
    const mangaById = new Map(allManga.map((entry) => [entry.id, entry]));

    setCategories(categories.map((entry) => {
      if (entry.id !== category.id || !entry.mangas) return entry;
      const removeSet = new Set(removeIds);
      const nodes = [
        ...entry.mangas.nodes.filter((node) => !removeSet.has(node.id)),
        ...addIds.map((id) => mangaById.get(id)).filter((manga): manga is Manga => Boolean(manga)),
      ];
      return { ...entry, mangas: { nodes } };
    }));

    const mutations = [
      ...addIds.map((mangaId) => gql(UPDATE_MANGA_CATEGORIES, { mangaId, addTo: [category.id], removeFrom: [] })),
      ...removeIds.map((mangaId) => gql(UPDATE_MANGA_CATEGORIES, { mangaId, addTo: [], removeFrom: [category.id] })),
    ];
    const results = await Promise.allSettled(mutations);
    await reloadCategories();
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) {
      addToast({
        kind: "error",
        title: translate("ui_couldNotUpdateEveryFolderItem"),
        body: `${failed} of ${ids.length} selected titles could not be updated.`,
      });
    }
  }

  async function createAndAssign(manga: Manga) {
    const name = prompt("Folder name:");
    if (!name?.trim()) return;

    try {
      const response = await gql<{ createCategory: { category: Category } }>(CREATE_CATEGORY, { name: name.trim() });
      const category = response.createCategory.category;
      await gql(UPDATE_MANGA_CATEGORIES, { mangaId: manga.id, addTo: [category.id], removeFrom: [] });
      await reloadCategories();
    } catch (createError) {
      console.error(createError);
    }
  }

  async function createCategoryOnly() {
    const name = prompt("Folder name:");
    if (!name?.trim()) return;

    try {
      await gql(CREATE_CATEGORY, { name: name.trim() });
      await reloadCategories();
    } catch (createError) {
      console.error(createError);
    }
  }

  onMount(() => {
    const handleHardcoverStateChanged = () => {
      reloadHardcoverTrackingRecords();
    };
    globalThis.addEventListener?.("epigraph-hardcover-state-changed", handleHardcoverStateChanged);

    if (store.settings.defaultLibrarySection !== "last-used") {
      setLibrarySection(store.settings.defaultLibrarySection);
    }

    const defaultId = store.settings.defaultLibraryCategoryId;
    if (store.librarySection === "comics" && defaultId && store.libraryFilter === "library") {
      store.libraryFilter = String(defaultId);
    }

    return () => {
      globalThis.removeEventListener?.("epigraph-hardcover-state-changed", handleHardcoverStateChanged);
      if (libraryLoadRetryTimer) {
        clearTimeout(libraryLoadRetryTimer);
        libraryLoadRetryTimer = null;
      }
      if (categoryLoadRetryTimer) {
        clearTimeout(categoryLoadRetryTimer);
        categoryLoadRetryTimer = null;
      }
    };
  });

  export async function checkAndMarkCompleted(mangaId: number, chapters: Chapter[]) {
    await storeCheckAndMarkCompleted(mangaId, chapters, store.categories, gql, UPDATE_MANGA_CATEGORIES, UPDATE_MANGA);
    await reloadCategories();
  }
</script>

{#if error}
  <div class="center">
    <NocturneState
      layout="center"
      tone="danger"
      icon="plug"
      eyebrow={$_("library.error.eyebrow")}
      title={$_("library.error.title")}
      body={$_("library.error.body")}
      actions={[{ label: $_("library.error.retry"), kind: "primary", icon: "retry", onClick: () => retryCount++ }]}
    />
  </div>
{:else}
      <LibraryShell
        sectionTabs={displaySectionVm?.sectionTabs ?? []}
    collections={[]}
    toolbar={displaySectionVm.toolbar}
    displaySettings={displaySettings}
    branchesEnabled={false}
    sortDefaultMode={activeSortDefaultMode}
    sortDefaultDir={activeSortDefaultDir}
    filterDefaultValue={activeFilterDefaultValue}
    sortLabel={activeSortLabel}
    filterLabel={activeFilterLabel}
        bookTypeOptions={activeBookTypeOptions}
    collectionsReorderApi={collectionsReorderApi}
    onSectionChange={handleSectionChange}
    onCollectionSelect={handleCollectionSelect}
    onSearchChange={handleSearchChange}
    onSortModeChange={handleSortModeChange}
    onSortDirToggle={handleSortDirToggle}
    onFilterChange={handleFilterChange}
    onBookTypeChange={handleBookTypeChange}
    onViewModeChange={handleViewModeChange}
    onPreferredColumnsChange={handlePreferredColumnsChange}
    onShowProgressChange={handleShowProgressChange}
    onShowOutlineChange={handleShowOutlineChange}
  >
    {#snippet hero()}
      <section class="library-hero">
        <div class="library-hero__stack">
          <div class="library-hero__top">
            <div>
              <p class="n-eyebrow library-hero__eyebrow">{$_("library.eyebrow")}</p>
              <h1 class="n-title-xl library-hero__title">{activeHeroTitle}</h1>
            </div>
            <div class="n-soft-pill library-count-pill">
              <span class="material-symbols-outlined text-sm" style="color: var(--component-library-accent-fg);">shelves</span>
              <span>{activeHeroCountLabel}</span>
            </div>
          </div>

          <div class="library-hero__collections-row">
            <div class="library-hero__collections-stack">
              <div class="library-chip-row library-chip-row--user">
                {#each heroUserCollections as collection}
                  <button
                    type="button"
                    class="n-chip"
                    class:is-active={collection.active}
                    onclick={() => handleCollectionSelect(collection.id)}
                  >
                    {collection.label}
                  </button>
                {/each}

                {#if activeGenreChips.length}
                  {#if heroUserCollections.length}
                    <div class="chip-divider" aria-hidden="true"></div>
                  {/if}
                  <div
                    class="library-genre-frame"
                    class:has-overflow={hasScrollableGenreChips}
                    class:is-dragging={genreDragActive}
                  >
                    <div
                      class="library-genre-scroll"
                      role="group"
                      aria-label={$_("library.genres.aria")}
                      bind:this={genreScrollEl}
                      onpointerdown={handleGenrePointerDown}
                      onpointermove={handleGenrePointerMove}
                      onpointerup={handleGenrePointerUp}
                      onpointercancel={handleGenrePointerUp}
                      onpointerleave={handleGenrePointerUp}
                    >
                      {#each activeGenreChips as chip}
                        <button
                          type="button"
                          class="n-genre-chip library-genre-chip"
                          class:fit-sm={genreChipFitClass(chip.label) === "fit-sm"}
                          class:fit-xs={genreChipFitClass(chip.label) === "fit-xs"}
                          class:is-active={chip.active}
                          data-library-genre
                          data-genre-label={chip.label}
                          title={`${chip.label} (${chip.count})`}
                          onclick={(event) => handleGenreClick(chip.label, event)}
                        >
                          {chip.label}
                        </button>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>

              {#if heroSystemCollections.length}
                <div class="library-chip-row library-chip-row--system">
                  {#each heroSystemCollections as collection}
                    <button
                      type="button"
                      class="n-chip n-chip--system"
                      class:is-active={collection.active}
                      onclick={() => handleHeroSystemCollectionSelect(collection.id)}
                    >
                      {collection.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="library-hero__toolbar">
                <LibraryToolbar
                toolbar={displaySectionVm.toolbar}
                displaySettings={displaySettings}
                sortDefaultMode={activeSortDefaultMode}
                sortDefaultDir={activeSortDefaultDir}
                filterDefaultValue={activeFilterDefaultValue}
                bookTypeOptions={activeBookTypeOptions}
                sortLabel={activeSortLabel}
                filterLabel={activeFilterLabel}
                onSearchChange={handleSearchChange}
                onSortModeChange={handleSortModeChange}
                onSortDirToggle={handleSortDirToggle}
                onFilterChange={handleFilterChange}
                onBookTypeChange={handleBookTypeChange}
                onViewModeChange={handleViewModeChange}
                onPreferredColumnsChange={handlePreferredColumnsChange}
                onShowProgressChange={handleShowProgressChange}
                onShowOutlineChange={handleShowOutlineChange}
                onRefresh={openLibraryRefreshDialog}
                refreshPending={manualRefreshInFlight || store.libraryUpdateInFlight}
                showSearch={false}
              />
            </div>
          </div>
        </div>
      </section>
    {/snippet}
    <div
      class="library-section-panel"
      class:is-active={visualLibrarySection === "books"}
      aria-hidden={visualLibrarySection !== "books"}
    >
      <BooksLibraryBody
        vm={localizedBooksSectionVm}
        active={store.navPage === "library" && visualLibrarySection === "books"}
        books={genreFilteredBooks}
        totalBooks={genreFilteredBooksTotal}
        viewKey={booksBodyViewKey}
        viewMode={displaySettings.viewMode}
        preferredColumns={displaySettings.preferredColumns}
        showProgress={displaySettings.showProgress}
        showOutline={displaySettings.showOutline}
        novelEntries={genreFilteredNovelEntries}
        novelCardContext={novelsShelf.cardContext}
        onOpenNovel={openNovelCard}
      />
    </div>

    <div
      class="library-section-panel"
      class:is-active={visualLibrarySection === "comics"}
      aria-hidden={visualLibrarySection !== "comics"}
    >
      <ComicsLibraryBody
        vm={localizedComicsSectionVm}
        active={store.navPage === "library" && visualLibrarySection === "comics"}
        mangas={genreFilteredComicsManga}
        categories={comicsSectionState?.visibleCategories ?? []}
        categoryMangaMap={comicsSectionState?.categoryMangaMap ?? new Map()}
        trackedCompletedIds={trackedCompletedIds}
        trackedChapterTotalsByMangaId={trackedChapterTotalsByMangaId}
        sources={allSources}
        renderLimit={store.settings.renderLimit ?? 48}
        viewKey={comicsViewKey}
        viewMode={displaySettings.viewMode}
        preferredColumns={displaySettings.preferredColumns}
        showProgress={displaySettings.showProgress}
        showOutline={displaySettings.showOutline}
        onRemoveFromLibrary={removeFromLibrary}
        onAddToLibrary={addToLibrary}
        onDeleteAllDownloads={deleteAllDownloads}
        onToggleCategory={toggleMangaCategory}
        onBulkRemoveFromLibrary={bulkRemoveFromLibrary}
        onBulkToggleCategory={bulkToggleMangaCategory}
        onCreateAndAssign={createAndAssign}
        onCreateCategory={createCategoryOnly}
        onCoverErrorDetected={wakeServerForLibraryCovers}
        coverRecoveryVersions={coverRecoveryVersions}
        coverCacheGeneration={store.libraryCoverCacheGeneration}
      />
    </div>
  </LibraryShell>
  {#if refreshDialogOpen}
    <div class="library-refresh-backdrop" role="presentation" onclick={closeLibraryRefreshDialog}>
      <div
        class="library-refresh-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-refresh-title"
        tabindex="-1"
        onclick={(event) => event.stopPropagation()}
        onkeydown={(event) => event.stopPropagation()}
      >
        <div class="library-refresh-modal__head">
          <div>
            <p class="n-eyebrow">{$_("library.refresh.eyebrow")}</p>
            <h2 id="library-refresh-title">{store.librarySection === "comics" ? $_("library.refresh.updateComics") : $_("library.refresh.updateBooks")}</h2>
          </div>
          <button class="n-icon-btn library-refresh-modal__close" type="button" aria-label={$_("library.refresh.close")} onclick={closeLibraryRefreshDialog} disabled={manualRefreshInFlight || store.libraryUpdateInFlight}>
            <span aria-hidden="true">x</span>
          </button>
        </div>
        <div class="library-refresh-options">
          <button
            type="button"
            class="library-refresh-option"
            disabled={manualRefreshInFlight || store.libraryUpdateInFlight}
            onclick={() => runLibraryRefresh("active")}
          >
            <span>{store.librarySection === "comics" ? $_("library.refresh.updateComics") : $_("library.refresh.updateBooks")}</span>
            <small>{store.librarySection === "comics" ? $_("library.refresh.updateComicsHint") : $_("library.refresh.updateBooksHint")}</small>
          </button>
          <button
            type="button"
            class="library-refresh-option library-refresh-option--primary"
            disabled={manualRefreshInFlight || store.libraryUpdateInFlight}
            onclick={() => runLibraryRefresh("all")}
          >
            <span>{$_("library.refresh.updateAll")}</span>
            <small>{$_("library.refresh.updateAllHint")}</small>
          </button>
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .library-section-panel {
    position: absolute;
    inset: calc(12px * var(--component-library-scale)) 0 0;
    z-index: var(--component-library-panel-hidden-z-index);
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    overflow: hidden;
  }

  .library-section-panel.is-active {
    position: relative;
    inset: auto;
    z-index: var(--component-library-panel-z-index);
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    overflow: visible;
  }

  .library-refresh-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--component-library-refresh-z-index);
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--component-library-refresh-backdrop-bg);
    backdrop-filter: var(--component-library-refresh-backdrop-blur);
  }

  .library-refresh-modal {
    width: min(390px, calc(100vw - 42px));
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 18px;
    border: 1px solid var(--component-library-refresh-modal-border);
    border-radius: var(--component-library-refresh-modal-radius);
    background: var(--component-library-refresh-modal-bg);
    box-shadow: var(--component-library-refresh-modal-shadow);
    color: var(--component-library-fg);
    font-family: var(--component-library-font);
    animation: refreshModalIn 0.14s ease both;
  }

  .library-refresh-modal__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .library-refresh-modal__head h2 {
    margin: 4px 0 0;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 1.02rem;
    font-weight: 800;
    letter-spacing: 0;
  }

  .library-refresh-modal__close {
    width: 32px;
    height: 32px;
    flex: 0 0 auto;
    border-color: var(--component-library-refresh-option-border);
    background: var(--component-library-refresh-option-bg);
  }

  .library-refresh-modal__close span {
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
  }

  .library-refresh-options {
    display: grid;
    gap: 8px;
  }

  .library-refresh-option {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    min-height: 74px;
    padding: 13px 14px 13px 18px;
    border: 1px solid var(--component-library-refresh-option-border);
    border-radius: var(--radius-lg);
    background: var(--component-library-refresh-option-bg);
    color: var(--component-library-fg);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--t-base), background var(--t-base), transform var(--t-fast), box-shadow var(--t-base);
  }

  .library-refresh-option::before {
    content: "";
    position: absolute;
    left: 0;
    top: 14px;
    bottom: 14px;
    width: 2px;
    border-radius: var(--radius-full);
    background: var(--component-library-refresh-option-accent-bg);
    opacity: 0.72;
  }

  .library-refresh-option:hover:not(:disabled) {
    border-color: var(--component-library-refresh-option-hover-border);
    background: var(--component-library-refresh-option-hover-bg);
    box-shadow: var(--component-library-refresh-option-hover-shadow);
    transform: translateY(-1px);
  }

  .library-refresh-option:disabled {
    opacity: var(--component-library-disabled-opacity);
    cursor: default;
  }

  .library-refresh-option span {
    font-family: var(--font-sans);
    font-size: 0.82rem;
    font-weight: 800;
    letter-spacing: 0;
  }

  .library-refresh-option small {
    max-width: 34rem;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 0.75rem;
    line-height: 1.45;
    letter-spacing: 0;
  }

  .library-refresh-option--primary {
    border-color: var(--component-library-accent-border);
    background: var(--component-library-accent-muted-bg);
  }

  .library-refresh-option--primary::before {
    background: var(--accent-bright);
    box-shadow: var(--component-library-refresh-option-accent-shadow);
  }

  @keyframes refreshModalIn {
    from { opacity: 0; transform: translateY(8px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .library-hero {
    position: relative;
    z-index: var(--component-library-header-z-index);
    padding: var(--library-hero-padding-top, 14px) var(--library-shell-padding-x, 40px) 0;
  }

  .library-hero__stack {
    display: flex;
    flex-direction: column;
    gap: var(--library-hero-stack-gap, 16px);
  }

  .library-hero__top {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--library-hero-top-gap, 32px);
  }

  .library-hero__eyebrow {
    margin: 0 0 var(--library-eyebrow-gap, 8px);
  }

  .library-hero__title {
    margin: 0;
    font-size: var(--library-title-size, 2.2rem);
  }

  .library-count-pill {
    white-space: nowrap;
  }

  .library-hero__collections-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--library-collections-row-gap, 24px);
    width: 100%;
    min-width: 0;
  }

  .library-hero__collections-stack {
    display: flex;
    flex-direction: column;
    gap: var(--library-chip-stack-gap, 8px);
    min-width: 0;
    flex: 1 1 auto;
  }

  .library-hero__toolbar {
    position: relative;
    z-index: var(--component-library-dropdown-z-index);
    flex: 0 0 auto;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding-top: 2px;
  }

  .library-chip-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--library-chip-gap, 12px);
  }

  .library-chip-row--user {
    flex-wrap: nowrap;
  }

  .library-chip-row--system {
    gap: var(--library-system-chip-gap, 12px);
    padding-left: var(--library-system-chip-indent, 18px);
  }

  .library-chip-row--system :global(.n-chip.is-active) {
    opacity: 1;
  }

  .chip-divider {
    width: 1px;
    height: var(--library-chip-divider-height, 16px);
    margin: 0 var(--library-chip-divider-margin, 2px);
    border-radius: var(--radius-full);
    background: var(--component-library-chip-divider-bg);
    flex: 0 0 auto;
  }

  .library-chip-row :global(.n-chip),
  .library-chip-row :global(.n-genre-chip) {
    flex-shrink: 0;
    min-height: var(--library-chip-height, 32px);
    padding-inline: var(--library-chip-padding-x, 18px);
    font-size: var(--library-chip-font-size, 11px);
  }

  .library-chip-row--system :global(.n-chip.n-chip--system) {
    min-height: 28px;
    padding-inline: 14px;
    font-size: 10px;
    opacity: 0.88;
    letter-spacing: 0.055em;
  }

  .library-chip-row--system :global(.n-chip.n-chip--system.is-active) {
    opacity: 1;
  }

  .library-genre-frame {
    container-type: inline-size;
    --library-genre-chip-width: clamp(78px, 7.8vw, 92px);
    --library-genre-gap: 8px;
    position: relative;
    align-self: center;
    flex: 0 1 calc((var(--library-genre-chip-width) * 4) + (var(--library-genre-gap) * 3));
    width: calc((var(--library-genre-chip-width) * 4) + (var(--library-genre-gap) * 3));
    max-width: calc((var(--library-genre-chip-width) * 4) + (var(--library-genre-gap) * 3));
    min-width: 0;
  }

  .library-genre-frame.has-overflow::after {
    content: ">";
    position: absolute;
    top: 50%;
    right: -13px;
    transform: translateY(-50%);
    color: var(--component-library-overflow-indicator-fg);
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
    pointer-events: none;
    opacity: 0.74;
    transition: color var(--t-base), opacity var(--t-base), transform var(--t-base);
  }

  .library-genre-frame.has-overflow.is-dragging::after {
    color: var(--component-library-overflow-indicator-active-fg);
    opacity: 1;
    transform: translate(1px, -50%);
  }

  .library-genre-scroll {
    display: flex;
    align-items: center;
    gap: var(--library-genre-gap);
    height: var(--library-chip-height, 32px);
    min-width: 0;
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0;
    scrollbar-width: none;
    overscroll-behavior-inline: contain;
    cursor: grab;
    touch-action: pan-y;
    user-select: none;
  }

  .library-genre-frame.is-dragging .library-genre-scroll {
    cursor: grabbing;
  }

  .library-genre-scroll::-webkit-scrollbar {
    display: none;
  }

  .library-genre-chip {
    width: var(--library-genre-chip-width);
    flex: 0 0 var(--library-genre-chip-width);
    min-height: 27px !important;
    padding-inline: 7px !important;
    font-size: clamp(7px, 2.55cqw, 10px) !important;
    line-height: 1.15 !important;
    min-width: 0;
    justify-content: center;
    overflow: hidden;
    text-overflow: clip;
    white-space: nowrap;
    transition-property: background-color, border-color, color, box-shadow, transform, opacity;
  }

  .library-genre-chip.fit-sm {
    font-size: clamp(6.5px, 2.15cqw, 8.4px) !important;
    padding-inline: 6px !important;
  }

  .library-genre-chip.fit-xs {
    font-size: clamp(5.7px, 1.86cqw, 7.2px) !important;
    padding-inline: 5px !important;
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

  @media (max-width: 620px) {
    .chip-divider {
      display: none;
    }

    .library-genre-frame {
      --library-genre-chip-width: clamp(62px, 20vw, 76px);
      max-width: 100%;
    }
  }

</style>
