<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { gql } from "../../lib/client";
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
    UPDATE_LIBRARY,
    UPDATE_MANGA,
    DELETE_DOWNLOADED_CHAPTERS,
    DEQUEUE_DOWNLOAD,
    CREATE_CATEGORY,
    DELETE_CATEGORY,
    UPDATE_MANGA_CATEGORIES,
    UPDATE_CATEGORY_ORDER,
  } from "../../lib/queries";
  import type { Category, Chapter, Manga } from "../../lib/types";
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
  function hasWarmLibrarySnapshot() {
    return store.libraryMangaSnapshot.length > 0 && store.categories.length > 0;
  }

  let loading = $state(!hasWarmLibrarySnapshot());
  let error: string | null = $state(null);
  let retryCount = $state(0);
  let comicsSearch = $state("");
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
      async () => ensureCompletedCategory((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES_WITH_MANGA_IDS)).categories.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  function categoriesHaveMangaMembers(categories = store.categories) {
    return categories.some((category) => Array.isArray(category.mangas?.nodes));
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

  function loadLibraryTrackingSummary() {
    return cache.get(
      CACHE_KEYS.LIBRARY_TRACKING_SUMMARY,
      () => gql(GET_LIBRARY_TRACKING_SUMMARY, undefined, undefined, 8000).then((data: any) => data.trackers.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
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
      const [nodes, categories, trackingSummary] = await Promise.all([
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
      ]);

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
  const comicsViewKey = $derived(`${store.libraryFilter}|${comicsSearch}|${tabSortMode}|${tabSortDir}|${tabStatus}`);
  const booksViewKey = $derived(`${bookActiveCategoryId ?? "all"}|${bookTypeFilter}|${booksSearch}|${bookSortMode}|${bookSortDir}|${bookStatusFilter}`);
  const displaySettings = $derived({
    viewMode: store.settings.libraryViewMode,
    preferredColumns: store.settings.libraryPreferredGridColumns,
    showProgress: store.settings.libraryShowProgress,
    showOutline: store.settings.libraryShowCardOutline,
  });

  type GenreChipVM = { label: string; count: number; active: boolean };

  const comicsGenreChips = $derived(
    Array.from(
      allManga
        .flatMap((manga) => manga.genre ?? [])
        .reduce((map, rawGenre) => {
          const genre = rawGenre.trim();
          if (!genre) return map;
          map.set(genre, (map.get(genre) ?? 0) + 1);
          return map;
        }, new Map<string, number>()),
    )
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 2)
      .map(([label, count]) => ({
        label,
        count,
        active: false,
      } satisfies GenreChipVM)),
  );

  const activeHeroTitle = $derived(store.librarySection === "books" ? "Books" : "Comics");
  const activeHeroCountLabel = $derived(
    store.librarySection === "books"
      ? `${store.books.length + novelsLibraryState.entries.length} Books Saved`
      : `${comicsSectionState?.counts.library ?? 0} Titles`,
  );
  const activeHeroCollections = $derived(activeSectionVm?.collections ?? []);
  const heroSystemCollections = $derived(activeHeroCollections.filter((collection) => isSystemHeroCollection(collection)));
  const heroUserCollections = $derived(activeHeroCollections.filter((collection) => !isSystemHeroCollection(collection)));

  const comicsByCardId = $derived(new Map(allManga.map((manga) => [createComicLibraryCardId(manga.id), manga])));
  const booksByCardId = $derived(new Map(store.books.map((book) => [createBookLibraryCardId(book.id), book])));

  function isSystemHeroCollection(collection: LibraryCollectionVM) {
    const id = collection.id.toLowerCase();
    const label = collection.label.trim().toLowerCase();
    return id === "all" || id === "library" || id === "downloaded" || label === "saved" || label === "downloaded" || label === "finished" || label === "all";
  }

  const comicsActions = $derived(createComicsLibraryActions({
    openSection: (section) => setLibrarySection(section),
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
    openSection: (section) => setLibrarySection(section),
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

  function handleSectionChange(section: string) {
    if (store.librarySection === section) return;
    setLibrarySection(section);
  }

  function handleCollectionSelect(id: string) {
    if (store.librarySection === "books") booksActions.selectCollection(id);
    else comicsActions.selectCollection(id);
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
    if (store.librarySection !== "comics") return undefined;
    const id = Number(store.libraryFilter);
    return Number.isFinite(id) && id > 0 ? [id] : undefined;
  }

  async function refreshLibraryManually() {
    if (manualRefreshInFlight) return;
    manualRefreshInFlight = true;
    try {
      if (store.librarySection === "comics") {
        const awake = await ensureServerAwakeFor("manual-library-update", {
          serverUrl: store.runtimeServerUrl,
          binary: store.settings.serverBinary,
        });
        if (!awake) throw new Error("Suwayomi is not reachable.");

        await gql(UPDATE_LIBRARY, { categories: manualUpdateCategoryIds() });
        await waitForLibraryUpdateToSettle();
        updateSettings({ lastLibraryUpdateAt: Date.now() });
        cache.clearGroup(CACHE_GROUPS.LIBRARY);
        await loadData();
        addToast({ kind: "success", title: "Library updated", body: "Aethon refreshed your comics library." });
      } else {
        novelsLibraryState = await loadNovelLibraryState({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        });
        addToast({ kind: "success", title: "Library refreshed", body: "Aethon refreshed local books and novels." });
      }
    } catch (refreshError) {
      console.error(refreshError);
      addToast({
        kind: "error",
        title: "Could not update library",
        body: refreshError instanceof Error ? refreshError.message : "Aethon could not reach Suwayomi.",
      });
    } finally {
      manualRefreshInFlight = false;
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
    refreshPending={manualRefreshInFlight}
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
                    onclick={() => {
                      if (store.librarySection === "books") booksActions.selectCollection(collection.id);
                      else comicsActions.selectCollection(collection.id);
                    }}
                  >
                    {collection.label}
                  </button>
                {/each}

                {#if store.librarySection === "comics" && comicsGenreChips.length}
                  <div class="chip-divider" aria-hidden="true"></div>
                  {#each comicsGenreChips as chip}
                    <button type="button" class="n-genre-chip">
                      {chip.label}
                    </button>
                  {/each}
                {/if}
              </div>

              {#if heroSystemCollections.length}
                <div class="library-chip-row library-chip-row--system">
                  {#each heroSystemCollections as collection}
                    <button
                      type="button"
                      class="n-chip n-chip--system"
                      class:is-active={collection.active}
                      onclick={() => {
                        if (store.librarySection === "books") booksActions.selectCollection(collection.id);
                        else comicsActions.selectCollection(collection.id);
                      }}
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
                refreshPending={manualRefreshInFlight}
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
        books={booksSectionState?.filteredBooks ?? []}
        totalBooks={(booksSectionState?.filteredBooks.length ?? 0) + visibleNovelCards.length}
        viewKey={`${booksViewKey}|novels:${visibleNovelCards.map((card) => card.novelId).join(",")}`}
        viewMode={displaySettings.viewMode}
        preferredColumns={displaySettings.preferredColumns}
        showProgress={displaySettings.showProgress}
        showOutline={displaySettings.showOutline}
        novelCards={visibleNovelCards}
        onOpenNovel={openNovelCard}
      />
    {:else}
      <ComicsLibraryBody
        vm={comicsSectionState?.vm}
        mangas={comicsSectionState?.filteredManga ?? []}
        categories={comicsSectionState?.visibleCategories ?? []}
        categoryMangaMap={comicsSectionState?.categoryMangaMap ?? new Map()}
        trackedCompletedIds={trackedCompletedIds}
        trackedChapterTotalsByMangaId={trackedChapterTotalsByMangaId}
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

  .library-chip-row--system {
    gap: var(--library-system-chip-gap, 8px);
    padding-left: var(--library-system-chip-indent, 18px);
  }

  .library-chip-row--system :global(.n-chip) {
    min-height: 24px;
    padding: 0 10px;
    font-size: 10px;
    opacity: 0.85;
    letter-spacing: 0.06em;
  }

  .library-chip-row--system :global(.n-chip.is-active) {
    opacity: 1;
  }

  .library-chip-row--system :global(.n-chip--system) {
    transform: scale(0.92);
    transform-origin: left center;
  }

  .chip-divider {
    width: 1px;
    height: var(--library-chip-divider-height, 16px);
    margin: 0 var(--library-chip-divider-margin, 2px);
    border-radius: 999px;
    background: rgba(202, 196, 208, 0.14);
  }

  .library-chip-row :global(.n-chip),
  .library-chip-row :global(.n-genre-chip) {
    flex-shrink: 0;
    min-height: var(--library-chip-height, 32px);
    padding-inline: var(--library-chip-padding-x, 18px);
    font-size: var(--library-chip-font-size, 11px);
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
  }

</style>
