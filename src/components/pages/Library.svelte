<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getServerAuthHeader, getServerUrl, gql } from "../../lib/client";
  import { cache, CACHE_GROUPS, CACHE_KEYS, DEFAULT_TTL_MS } from "../../lib/cache";
  import {
    BOOKS_FILTER_OPTIONS,
    BOOKS_SORT_OPTIONS,
    buildBooksSectionState,
    createBooksLibraryActions,
    type BooksLibrarySortMode,
    normalizeBooksCategorySelection,
  } from "../../lib/library/booksSection";
  import { buildNovelLibraryCards } from "../../lib/novels/libraryShelf";
  import { hasBookLocalAsset } from "../../lib/books/availability";
  import {
    buildNovelDetailRecordFromLibrary,
    getNovelLibraryChapters,
    getNovelLibraryEntry,
    loadNovelLibraryState,
    peekNovelLibraryState,
  } from "../../lib/novels/libraryState";
  import { collectTrackedChapterTotalsByMangaId, collectTrackedCompletedMangaIds } from "../../lib/library/completion";
  import {
    COMPLETED_CATEGORY_NAME,
    getCategoryDisplayName,
    isCompletedCategory,
    normalizeCategories,
  } from "../../lib/library/categories";
  import { sortBooksCategories } from "../../lib/library/domainCategories";
  import { reconcileMangaCountsFromChapters } from "../../lib/library/chapterCounts";
  import {
    subscribeLibraryUpdateStatus,
    type LibraryUpdateMangaPatch,
    type LibraryUpdateSubscription,
  } from "../../lib/suwayomiUpdaterSubscription";
  import {
    applyLibraryUpdateMangaPatches as applySharedLibraryUpdateMangaPatches,
    ensureAethonLibraryUpdateRules as ensureSharedAethonLibraryUpdateRules,
    formatLibraryUpdateProgress as formatSharedLibraryUpdateProgress,
    formatLibraryUpdateWaiting as formatSharedLibraryUpdateWaiting,
    libraryUpdateProgressNumbers as sharedLibraryUpdateProgressNumbers,
    showLibraryUpdateProgress as showSharedLibraryUpdateProgress,
    waitForLibraryUpdateToSettle as waitForSharedLibraryUpdateToSettle,
  } from "../../lib/library/updateRuntime";
  import {
    buildComicsSectionState,
    COMICS_SORT_OPTIONS,
    COMICS_STATUS_OPTIONS,
    createComicsLibraryActions,
  } from "../../lib/library/comicsSection";
  import type { LibraryCollectionVM, LibraryCollectionsReorderApi } from "../../lib/library/contracts";
  import { dedupeMangaById } from "../../lib/util";
  import { createBookLibraryCardId, createComicLibraryCardId } from "../../lib/library/cardIdentity";
  import {
    GET_CATEGORIES_SUMMARY,
    GET_CATEGORIES_WITH_MANGA_IDS,
    GET_CHAPTERS,
    GET_LIBRARY,
    GET_LIBRARY_UPDATE_STATUS,
    GET_LIBRARY_TRACKING_SUMMARY,
    GET_SOURCES,
    SET_LIBRARY_UPDATE_RULES,
    UPDATE_LIBRARY,
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
    setActiveManga,
    setActiveBookId,
    setCategories,
    setLibraryFilter,
    setLibrarySection,
    setLibraryMangaSnapshot,
    setLibraryUpdateProgress,
    setLibraryUpdateInFlight,
    recordLibraryUpdateNotifications,
    addSystemNotification,
    store,
    updateSettings,
    type BooksLibraryStatusFilter,
    type BooksLibraryTypeFilter,
    type BooksLibraryUiState,
    type LibrarySortDir,
    type LibrarySortMode,
    type LibraryStatusFilter,
    type Settings,
  } from "../../store/state.svelte";
  import {
    buildCategoryMembers,
    loadLibrarySnapshot,
    saveLibrarySnapshot,
    type PersistedLibrarySnapshot,
  } from "../../lib/library/snapshot";
  import { ensureServerAwakeFor } from "../../lib/serverLifecycle";
  import BooksLibraryBody from "../library/BooksLibraryBody.svelte";
  import ComicsLibraryBody from "../library/ComicsLibraryBody.svelte";
  import LibraryToolbar from "../library/LibraryToolbar.svelte";
  import LibraryShell from "../library/LibraryShell.svelte";
  import NocturneState from "../shared/NocturneState.svelte";

  const DT_TAB = "application/x-moku-tab";
  const CATEGORY_MEMBERS_CACHE_KEY = `${CACHE_KEYS.CATEGORIES}:members`;
  const LEGACY_CATEGORIES_WITH_MANGA_CACHE_KEY = `${CACHE_KEYS.CATEGORIES}:with-manga`;

  let ensureCompletedInFlight: Promise<Category[]> | null = null;
  let hydrateCategoriesInFlight: Promise<Category[]> | null = null;
  let trackedCompletedIds: Set<number> = $state(new Set());
  let trackedChapterTotalsByMangaId: Map<number, number> = $state(new Map());
  let allSources: Source[] = $state([]);
  function hasWarmLibrarySnapshot() {
    return store.libraryMangaSnapshot.length > 0 && store.categories.length > 0;
  }

  let loading = $state(!hasWarmLibrarySnapshot());
  let error: string | null = $state(null);
  let retryCount = $state(0);
  let comicsSearch = $state("");
  let activeLibraryGenre: string | null = $state(null);
  let activeBooksStandardFilter: "saved" | "downloaded" | "finished" = $state("saved");
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
  let coverWakeInFlight: Promise<void> | null = null;
  let coverRecoveryVersions = $state(new Map<number, number>());
  const pendingCoverRecoveryIds = new Set<number>();
  let libraryLoadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let libraryLoadRetryCount = 0;
  let lastLoadedScopeKey: string | null = null;
  const libraryLoadRetryLimit = 30;
  let novelsLibraryState = $state(peekNovelLibraryState({
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  }));
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

  const allManga = $derived(store.libraryMangaSnapshot);
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

  function normalizeLoadedLibrary(nodes: Manga[]): Manga[] {
    return dedupeMangaById(nodes.map((manga: any) => ({
      ...manga,
      chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? 0,
    })));
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
      async () => ensureCompletedCategory((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_SUMMARY)).categories.nodes),
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

  function persistCurrentLibrarySnapshot(categories = store.categories) {
    if (!store.runtimeResolvedLocalProfileId || !store.runtimeServerUrl) return;
    saveLibrarySnapshot(currentSnapshotScope(), {
      mangas: store.libraryMangaSnapshot,
      categories: normalizeCategories(categories.map((category) => {
        const { mangas: _mangas, ...summary } = category;
        return summary;
      })),
      categoryMembers: buildCategoryMembers(categories),
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
        persistCurrentLibrarySnapshot(categories);
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
        return await hydrateCategoryMembers(force);
      }
      return categories;
    } catch (reloadError) {
      console.error(reloadError);
      return store.categories;
    }
  }

  function loadLibrary() {
    return cache.get(
      CACHE_KEYS.LIBRARY,
      () => gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY, undefined, undefined, 8000).then((data) => data.mangas.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  async function refreshLibrarySnapshotLive() {
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
    return normalized;
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
      const [nodes, categories, trackingSummary, sources] = await Promise.all([
        loadLibrary().catch((libraryError) => {
          console.error(libraryError);
          return store.libraryMangaSnapshot;
        }),
        loadCategoriesSnapshot().catch((categoryError) => {
          console.error(categoryError);
          return store.categories;
        }),
        loadLibraryTrackingSummary().catch((trackingError) => {
          console.error(trackingError);
          return store.libraryTrackingSummarySnapshot;
        }),
        loadSourcesSnapshot().catch((sourcesError) => {
          console.error(sourcesError);
          return [];
        }),
      ]);

      allSources = sources;
      setLibraryMangaSnapshot(normalizeLoadedLibrary(nodes));
      setCategories(normalizeCategories(categories));
      store.setLibraryTrackingSummarySnapshot(trackingSummary);
      persistCurrentLibrarySnapshot(normalizeCategories(categories));
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
      console.error(loadError);
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
      if (shouldBlockForLoad) loading = false;
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
      if (!loadDataInFlight) loading = !warmSnapshot && bootstrapStatus === "loading";
      return;
    }
    lastLoadedScopeKey = scopeKey;
    libraryLoadRetryCount = 0;
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
    if (categoryHasMangaMembers(id)) return;

    untrack(() => {
      void hydrateCategoryMembers(false).catch((memberError) => {
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
      void loadNovelLibraryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }).then((state) => {
        novelsLibraryState = state;
      });
    });
  });

  const comicsSectionState = $derived(
    store.librarySection === "comics"
      ? buildComicsSectionState({
          librarySection: store.librarySection,
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
        })
      : null,
  );

  const novelEntriesForActiveCategory = $derived(
    bookActiveCategoryId
      ? novelsLibraryState.entries.filter((entry) => (store.settings.booksCategoryAssignments[entry.id] ?? []).includes(bookActiveCategoryId))
      : novelsLibraryState.entries,
  );
  const booksSectionState = $derived(
    store.librarySection === "books"
      ? buildBooksSectionState({
          librarySection: store.librarySection,
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
        })
      : null,
  );
  const novelsShelf = $derived(
    store.librarySection === "books"
      ? buildNovelLibraryCards({
          entries: novelEntriesForActiveCategory,
          chapters: novelsLibraryState.chapters,
          progress: novelsLibraryState.progress,
          search: booksSearch,
          sortMode: bookSortMode,
          sortDir: bookSortDir,
          statusFilter: bookStatusFilter,
        })
      : null,
  );
  const visibleNovelCards = $derived(
    store.librarySection === "books" && (bookTypeFilter === "all" || bookTypeFilter === "sources")
      ? novelsShelf?.cards ?? []
      : [],
  );
  const bookProgressByBookId = $derived(new Map(store.bookProgress.map((progress) => [progress.bookId, progress])));
  const novelEntryById = $derived(new Map(novelsLibraryState.entries.map((entry) => [entry.id, entry])));
  const novelProgressByNovelId = $derived(new Map(novelsLibraryState.progress.map((progress) => [progress.novelId, progress])));

  const activeSectionVm = $derived(
    store.librarySection === "books"
      ? booksSectionState?.vm
      : comicsSectionState?.vm,
  );
  const activeSortDefaultMode = $derived(store.librarySection === "books" ? "recentlyAdded" : "az");
  const activeSortDefaultDir = $derived(store.librarySection === "books" ? "desc" as const : "asc" as const);
  const activeFilterDefaultValue = $derived(store.librarySection === "books" ? "all" : "ALL");
  const activeSortLabel = $derived(store.librarySection === "books" ? "Sort books" : "Sort by");
  const activeFilterLabel = $derived(store.librarySection === "books" ? "Reading status" : "Filter by status");
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
    genreChipsFromCounts(collectGenreCounts(novelsLibraryState.entries.flatMap((entry) => entry.tags ?? []))),
  );
  const activeGenreChips = $derived(store.librarySection === "books" ? booksGenreChips : comicsGenreChips);
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
  const standardFilteredNovelCards = $derived.by(() => {
    if (activeBooksStandardFilter === "downloaded") return [];
    if (activeBooksStandardFilter === "finished") return visibleNovelCards.filter((card) => isFinishedNovel(card.novelId));
    return visibleNovelCards;
  });
  const genreFilteredBooks = $derived(activeLibraryGenre ? [] : standardFilteredBooks);
  const genreFilteredNovelCards = $derived(
    activeLibraryGenre
      ? standardFilteredNovelCards.filter((card) => {
          const entry = novelEntryById.get(card.novelId);
          return genreListMatches(entry?.tags, activeLibraryGenre);
        })
      : standardFilteredNovelCards,
  );
  const genreFilteredBooksTotal = $derived(genreFilteredBooks.length + genreFilteredNovelCards.length);

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

  const activeHeroTitle = $derived(store.librarySection === "books" ? "Books" : "Comics");
  const activeHeroCountLabel = $derived(
    store.librarySection === "books"
      ? `${store.books.length + novelsLibraryState.entries.length} Books Saved`
      : `${comicsSectionState?.counts.library ?? 0} Titles`,
  );
  const booksStandardCollections = $derived<LibraryCollectionVM[]>([
    {
      id: "books:saved",
      label: "Saved",
      count: store.books.length + novelsLibraryState.entries.length,
      icon: "books",
      active: activeBooksStandardFilter === "saved",
      reorderable: false,
      isDefault: true,
    },
    {
      id: "books:downloaded",
      label: "Downloaded",
      count: store.books.filter(hasBookLocalAsset).length,
      icon: "download",
      active: activeBooksStandardFilter === "downloaded",
      reorderable: false,
      isDefault: false,
    },
    {
      id: "books:finished",
      label: "Finished",
      count: store.books.filter((book) => isFinishedBook(book.id)).length
        + novelsLibraryState.entries.filter((entry) => isFinishedNovel(entry.id)).length,
      icon: "folder",
      active: activeBooksStandardFilter === "finished",
      reorderable: false,
      isDefault: false,
    },
  ]);
  const activeHeroCollections = $derived(activeSectionVm?.collections ?? []);
  const heroSystemCollections = $derived(
    store.librarySection === "books"
      ? booksStandardCollections
      : activeHeroCollections.filter((collection) => isSystemHeroCollection(collection)),
  );
  const heroUserCollections = $derived(
    store.librarySection === "books"
      ? activeHeroCollections.filter((collection) => !isSystemHeroCollection(collection))
      : activeHeroCollections.filter((collection) => !isSystemHeroCollection(collection)),
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
      if (manga) setActiveManga(manga);
    },
  }));

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
    setLibrarySection(section);
  }

  function handleSectionChange(section: string) {
    if (store.librarySection === section) return;
    switchLibrarySection(section);
  }

  function handleCollectionSelect(id: string) {
    if (store.librarySection === "books") {
      activeBooksStandardFilter = "saved";
      booksActions.selectCollection(id);
    } else {
      comicsActions.selectCollection(id);
    }
  }

  function handleHeroSystemCollectionSelect(id: string) {
    if (store.librarySection !== "books") {
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
    if (store.librarySection === "books") booksActions.setSearch(value);
    else comicsActions.setSearch(value);
  }

  function handleSortModeChange(mode: string) {
    if (store.librarySection === "books") booksActions.setSortMode(mode);
    else comicsActions.setSortMode(mode);
  }

  function handleSortDirToggle() {
    if (store.librarySection === "books") toggleBookSortDir();
    else toggleTabSortDir();
  }

  function handleFilterChange(value: string) {
    if (store.librarySection === "books") booksActions.setFilter(value);
    else comicsActions.setFilter(value);
  }

  function handleBookTypeChange(id: string) {
    booksActions.selectType(id);
  }

  function handleViewModeChange(mode: string) {
    updateSettings({ libraryViewMode: mode as Settings["libraryViewMode"] });
  }

  function handlePreferredColumnsChange(value: string) {
    updateSettings({ libraryPreferredGridColumns: value as Settings["libraryPreferredGridColumns"] });
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

  function libraryUpdateProgressNumbers(jobsInfo: any) {
    const total = Number(jobsInfo?.totalJobs ?? 0);
    if (!Number.isFinite(total) || total <= 0) return undefined;
    const current = Math.max(0, Math.min(total, Number(jobsInfo?.finishedJobs ?? 0)));
    return {
      current,
      total,
      percent: Math.max(0, Math.min(100, Math.round((current / total) * 100))),
    };
  }

  function applyLiveMangaUpdatePatches(patches: LibraryUpdateMangaPatch[]) {
    if (!patches.length) return [] as number[];
    const patchById = new Map<number, LibraryUpdateMangaPatch["manga"]>();
    for (const patch of patches) {
      const manga = patch.manga;
      if (!manga?.id) continue;
      patchById.set(Number(manga.id), manga);
    }
    if (!patchById.size) return [] as number[];

    const changedIds: number[] = [];
    const patched = store.libraryMangaSnapshot.map((manga) => {
      const patch = patchById.get(manga.id);
      if (!patch) return manga;
      changedIds.push(manga.id);
      return {
        ...manga,
        title: patch.title ?? manga.title,
        thumbnailUrl: patch.thumbnailUrl ?? manga.thumbnailUrl,
        unreadCount: patch.unreadCount ?? manga.unreadCount,
        downloadCount: patch.downloadCount ?? manga.downloadCount,
        chapterCount: patch.chapters?.totalCount ?? manga.chapterCount,
      };
    });

    if (changedIds.length) {
      setLibraryMangaSnapshot(patched);
      cache.set(CACHE_KEYS.LIBRARY, patched, CACHE_GROUPS.LIBRARY);
    }
    return changedIds;
  }

  function formatLibraryUpdateWaiting(elapsedMs: number) {
    void elapsedMs;
    return "Waiting for Suwayomi progress.";
  }

  async function fetchLibraryUpdateStatusDirect(timeoutMs = 3500) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const auth = getServerAuthHeader();
    try {
      const response = await fetch(`${getServerUrl()}/api/graphql`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({
          query: `
            query LibraryUpdateStatusLive {
              libraryUpdateStatus {
                jobsInfo {
                  isRunning
                  finishedJobs
                  totalJobs
                  skippedCategoriesCount
                  skippedMangasCount
                }
              }
            }
          `,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Suwayomi HTTP ${response.status}`);
      const json = await response.json();
      if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "Could not read library update status.");
      return json.data?.libraryUpdateStatus?.jobsInfo ?? null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readLibraryUpdateStatusLive() {
    const directStatus = await fetchLibraryUpdateStatusDirect(2500).catch((directError) => {
      console.warn("Could not poll Library update status directly:", directError);
      return null;
    });
    if (directStatus) return directStatus;

    return gql<any>(GET_LIBRARY_UPDATE_STATUS, undefined, undefined, 2500)
      .then((status) => status?.libraryUpdateStatus?.jobsInfo ?? null)
      .catch((clientError) => {
        console.warn("Could not poll Library update status through app client:", clientError);
        return null;
      });
  }

  async function ensureAethonLibraryUpdateRules() {
    await gql(SET_LIBRARY_UPDATE_RULES, {
      excludeCompleted: false,
      excludeEntryWithUnreadChapters: false,
      excludeNotStarted: false,
      excludeUnreadChapters: false,
    }).catch((settingsError) => {
      console.warn("Could not update Suwayomi library update rules:", settingsError);
    });
  }

  async function refreshLibraryManually() {
    if (manualRefreshInFlight || store.libraryUpdateInFlight) {
      showSharedLibraryUpdateProgress("Library update already running.");
      addToast({
        kind: "info",
        title: "Library update already running",
        body: "Aethon is already checking your library.",
        duration: 2400,
      });
      return;
    }
    manualRefreshInFlight = true;
    setLibraryUpdateInFlight(true);
    let progressSubscription: LibraryUpdateSubscription | null = null;
    try {
      if (store.librarySection === "comics") {
        const beforeUpdate = [...store.libraryMangaSnapshot];
        const liveChangedMangaIds = new Set<number>();
        showSharedLibraryUpdateProgress("Waking Suwayomi and preparing update.");
        const awake = await ensureServerAwakeFor("manual-library-update", {
          serverUrl: store.runtimeServerUrl,
          binary: store.settings.serverBinary,
          updateIntensity: store.settings.libraryUpdateIntensity,
        });
        if (!awake) throw new Error("Suwayomi is not reachable.");

        showSharedLibraryUpdateProgress("Applying Aethon update rules.");
        await ensureSharedAethonLibraryUpdateRules();
        showSharedLibraryUpdateProgress("Suwayomi is checking your library.");
        progressSubscription = subscribeLibraryUpdateStatus(
          (event) => {
            const { jobsInfo, mangaUpdates } = event;
            showSharedLibraryUpdateProgress(
              formatSharedLibraryUpdateProgress(jobsInfo),
              0,
              sharedLibraryUpdateProgressNumbers(jobsInfo),
            );
            for (const mangaId of applySharedLibraryUpdateMangaPatches(mangaUpdates)) {
              liveChangedMangaIds.add(mangaId);
            }
          },
          (subscriptionError) => {
            console.warn("Could not receive live Library update progress:", subscriptionError);
          },
        );
        const updateResult = await gql<any>(UPDATE_LIBRARY, { categories: manualUpdateCategoryIds() });
        const initialJobsInfo = updateResult?.updateLibrary?.updateStatus?.jobsInfo;
        let lastLiveLibraryRefreshAt = 0;
        await waitForSharedLibraryUpdateToSettle(
          initialJobsInfo,
          8 * 60 * 1000,
          (jobsInfo) => {
            showSharedLibraryUpdateProgress(
              formatSharedLibraryUpdateProgress(jobsInfo),
              0,
              sharedLibraryUpdateProgressNumbers(jobsInfo),
            );
            const now = Date.now();
            if (jobsInfo?.isRunning && now - lastLiveLibraryRefreshAt >= 5000) {
              lastLiveLibraryRefreshAt = now;
              void refreshLibrarySnapshotLive().catch((liveRefreshError) => {
                console.warn("Could not refresh Library during update:", liveRefreshError);
              });
            }
          },
          (elapsedMs) => {
            void elapsedMs;
            showSharedLibraryUpdateProgress(formatSharedLibraryUpdateWaiting());
          },
        );
        progressSubscription?.close();
        progressSubscription = null;
        const updatedAt = Date.now();
        updateSettings({ lastLibraryUpdateAt: updatedAt });
        showSharedLibraryUpdateProgress("Refreshing local Library data.");
        cache.clearGroup(CACHE_GROUPS.LIBRARY);
        await waitForLibraryLoadIdle();
        await loadData();
        if (liveChangedMangaIds.size > 0) {
          showSharedLibraryUpdateProgress("Reconciling changed titles.");
          await reconcileCurrentLibraryCountsFromChapters(liveChangedMangaIds);
        }
        const entries = recordLibraryUpdateNotifications(beforeUpdate, store.libraryMangaSnapshot, updatedAt);
        showSharedLibraryUpdateProgress("Library update finished.", 1800);
        addSystemNotification({
          kind: "success",
          title: entries.length > 0 ? "New chapters found" : "Library sync completed",
          body: entries.length > 0
            ? `${entries.reduce((sum, entry) => sum + entry.chapterDelta, 0)} new chapters added across ${entries.length} titles.`
            : "Aethon refreshed your comics library.",
          createdAt: updatedAt,
        });
        addToast({
          kind: "success",
          title: entries.length > 0 ? "New chapters found" : "Library updated",
          body: entries.length > 0
            ? `${entries.reduce((sum, entry) => sum + entry.chapterDelta, 0)} new chapters added across ${entries.length} titles.`
            : "Aethon refreshed your comics library.",
        });
      } else {
        novelsLibraryState = await loadNovelLibraryState({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        });
        addToast({ kind: "success", title: "Library refreshed", body: "Aethon refreshed local books and novels." });
      }
    } catch (refreshError) {
      console.error(refreshError);
      showSharedLibraryUpdateProgress("Library update failed.", 1800);
      addToast({
        kind: "error",
        title: "Could not update library",
        body: refreshError instanceof Error ? refreshError.message : "Aethon could not reach Suwayomi.",
      });
      addSystemNotification({
        kind: "error",
        title: "Could not update library",
        body: refreshError instanceof Error ? refreshError.message : "Aethon could not reach Suwayomi.",
      });
    } finally {
      progressSubscription?.close();
      manualRefreshInFlight = false;
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

  async function waitForLibraryUpdateToSettle(
    initialJobsInfo: any = null,
    timeoutMs = 8 * 60 * 1000,
    onProgress?: (jobsInfo: any) => void,
    onWaiting?: (elapsedMs: number) => void,
  ) {
    const startedAt = Date.now();
    let observedRunning = Boolean(initialJobsInfo?.isRunning);
    let observedJobs = Number(initialJobsInfo?.totalJobs ?? 0) > 0 || Number(initialJobsInfo?.finishedJobs ?? 0) > 0;
    if (initialJobsInfo) onProgress?.(initialJobsInfo);

    while (Date.now() - startedAt < timeoutMs) {
      const jobsInfo = await readLibraryUpdateStatusLive();
      if (jobsInfo) {
        observedRunning ||= Boolean(jobsInfo.isRunning);
        observedJobs ||= Number(jobsInfo.totalJobs ?? 0) > 0 || Number(jobsInfo.finishedJobs ?? 0) > 0;
        onProgress?.(jobsInfo);
      }
      if (!jobsInfo) {
        onWaiting?.(Date.now() - startedAt);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      if (!jobsInfo.isRunning && (observedRunning || observedJobs)) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return jobsInfo ?? initialJobsInfo ?? null;
      }
      if (!jobsInfo.isRunning && Date.now() - startedAt > 5000) return jobsInfo ?? initialJobsInfo ?? null;
      await new Promise((resolve) => setTimeout(jobsInfo.isRunning ? 750 : 500));
    }
    return null;
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
    const unsubscribe = cache.subscribe(CACHE_KEYS.LIBRARY, () => {
      void loadData();
    });

    if (store.settings.defaultLibrarySection !== "last-used") {
      setLibrarySection(store.settings.defaultLibrarySection);
    }

    const defaultId = store.settings.defaultLibraryCategoryId;
    if (store.librarySection === "comics" && defaultId && store.libraryFilter === "library") {
      store.libraryFilter = String(defaultId);
    }

    return () => {
      unsubscribe();
      if (libraryLoadRetryTimer) {
        clearTimeout(libraryLoadRetryTimer);
        libraryLoadRetryTimer = null;
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
      eyebrow="Library"
      title="Could not reach Suwayomi"
      body="Make sure the server is running, then retry."
      actions={[{ label: "Retry", kind: "primary", icon: "retry", onClick: () => retryCount++ }]}
    />
  </div>
{:else}
      <LibraryShell
        sectionTabs={activeSectionVm?.sectionTabs ?? []}
    collections={[]}
    toolbar={activeSectionVm.toolbar}
    displaySettings={displaySettings}
    branchesEnabled={false}
    sortDefaultMode={activeSortDefaultMode}
    sortDefaultDir={activeSortDefaultDir}
    filterDefaultValue={activeFilterDefaultValue}
    sortLabel={activeSortLabel}
    filterLabel={activeFilterLabel}
        bookTypeOptions={store.librarySection === "books" ? booksSectionState?.vm?.typeOptions ?? [] : []}
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
    onRefresh={refreshLibraryManually}
    refreshPending={manualRefreshInFlight || store.libraryUpdateInFlight}
  >
    {#snippet hero()}
      <section class="library-hero">
        <div class="library-hero__stack">
          <div class="library-hero__top">
            <div>
              <p class="n-eyebrow library-hero__eyebrow">Library</p>
              <h1 class="n-title-xl library-hero__title">{activeHeroTitle}</h1>
            </div>
            <div class="n-soft-pill library-count-pill">
              <span class="material-symbols-outlined text-sm" style="color: var(--n-primary-container);">shelves</span>
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
                  <div class="chip-divider" aria-hidden="true"></div>
                  <div
                    class="library-genre-frame"
                    class:has-overflow={hasScrollableGenreChips}
                    class:is-dragging={genreDragActive}
                  >
                    <div
                      class="library-genre-scroll"
                      role="group"
                      aria-label="Library genres"
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
                toolbar={activeSectionVm.toolbar}
                displaySettings={displaySettings}
                sortDefaultMode={activeSortDefaultMode}
                sortDefaultDir={activeSortDefaultDir}
                filterDefaultValue={activeFilterDefaultValue}
                bookTypeOptions={store.librarySection === "books" ? booksSectionState?.vm?.typeOptions ?? [] : []}
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
                onRefresh={refreshLibraryManually}
                refreshPending={manualRefreshInFlight || store.libraryUpdateInFlight}
                showSearch={false}
              />
            </div>
          </div>
        </div>
      </section>
    {/snippet}
    {#if store.librarySection === "books"}
      <BooksLibraryBody
        vm={booksSectionState?.vm}
        books={genreFilteredBooks}
        totalBooks={genreFilteredBooksTotal}
        viewKey={`${booksViewKey}|novels:${genreFilteredNovelCards.map((card) => card.novelId).join(",")}`}
        viewMode={displaySettings.viewMode}
        preferredColumns={displaySettings.preferredColumns}
        showProgress={displaySettings.showProgress}
        showOutline={displaySettings.showOutline}
        novelCards={genreFilteredNovelCards}
        onOpenNovel={openNovelCard}
      />
    {:else}
      <ComicsLibraryBody
        vm={comicsSectionState?.vm}
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
        onCreateAndAssign={createAndAssign}
        onCreateCategory={createCategoryOnly}
        onCoverErrorDetected={wakeServerForLibraryCovers}
        coverRecoveryVersions={coverRecoveryVersions}
      />
    {/if}
  </LibraryShell>
{/if}

<style>
  .library-hero {
    position: relative;
    z-index: 6;
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
    z-index: 7;
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
    border-radius: 999px;
    background: rgba(202, 196, 208, 0.14);
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
    color: rgba(202, 196, 208, 0.38);
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
    pointer-events: none;
    opacity: 0.74;
    transition: color var(--t-base), opacity var(--t-base), transform var(--t-base);
  }

  .library-genre-frame.has-overflow.is-dragging::after {
    color: rgba(211, 196, 255, 0.72);
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
    z-index: 1;
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
