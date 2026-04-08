<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { gql } from "../../lib/client";
  import { cache, CACHE_GROUPS, CACHE_KEYS, DEFAULT_TTL_MS } from "../../lib/cache";
  import { BookAssetResolver } from "../../lib/books/assets";
  import {
    BOOKS_FILTER_OPTIONS,
    BOOKS_SORT_OPTIONS,
    buildBooksSectionState,
    createBooksLibraryActions,
    type BooksLibrarySortMode,
    normalizeBooksCategorySelection,
  } from "../../lib/library/booksSection";
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
  import type { LibraryCollectionsReorderApi } from "../../lib/library/contracts";
  import { dedupeMangaById } from "../../lib/util";
  import {
    GET_CATEGORIES,
    GET_CHAPTERS,
    GET_LIBRARY,
    GET_LIBRARY_TRACKING_SUMMARY,
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
    checkAndMarkCompleted as storeCheckAndMarkCompleted,
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
  } from "../../store/state.svelte";
  import BooksLibraryBody from "../library/BooksLibraryBody.svelte";
  import BooksTypeSelector from "../library/BooksTypeSelector.svelte";
  import ComicsLibraryBody from "../library/ComicsLibraryBody.svelte";
  import LibraryShell from "../library/LibraryShell.svelte";

  const DT_TAB = "application/x-moku-tab";

  let ensureCompletedInFlight: Promise<Category[]> | null = null;
  let trackedCompletedIds: Set<number> = $state(new Set());
  let trackedChapterTotalsByMangaId: Map<number, number> = $state(new Map());
  let loading = $state(true);
  let error: string | null = $state(null);
  let retryCount = $state(0);
  let comicsSearch = $state("");
  let activeDragKind: "tab" | null = $state(null);
  let dragInsertIdx = $state<number | null>(null);
  let dragTabId = $state<string | null>(null);
  let dropTargetTabId = $state<string | null>(null);

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

    const refreshed = await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)
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
          normalizeCategories((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)).categories.nodes),
        );
        if (fresh.some(isCompletedCategory)) return fresh;

        try {
          await gql(CREATE_CATEGORY, { name: COMPLETED_CATEGORY_NAME });
        } catch {}

        return await cleanupCompletedDuplicates(
          normalizeCategories((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)).categories.nodes),
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
      async () => ensureCompletedCategory((await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES)).categories.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  async function reloadCategories(force = true) {
    try {
      if (force) cache.clear(CACHE_KEYS.CATEGORIES);
      const categories = await loadCategoriesSnapshot();
      setCategories(categories);
      return categories;
    } catch (reloadError) {
      console.error(reloadError);
      return store.categories;
    }
  }

  function loadLibrary() {
    return cache.get(
      CACHE_KEYS.LIBRARY,
      () => gql<{ mangas: { nodes: Manga[] } }>(GET_LIBRARY).then((data) => data.mangas.nodes),
      DEFAULT_TTL_MS,
      CACHE_GROUPS.LIBRARY,
    );
  }

  function loadLibraryTrackingSummary() {
    return cache.get(
      CACHE_KEYS.LIBRARY_TRACKING_SUMMARY,
      () => gql(GET_LIBRARY_TRACKING_SUMMARY).then((data: any) => data.trackers.nodes),
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

      setLibraryMangaSnapshot(normalizeLoadedLibrary(nodes));
      trackedCompletedIds = collectTrackedCompletedMangaIds(trackingSummary);
      trackedChapterTotalsByMangaId = collectTrackedChapterTotalsByMangaId(trackingSummary);
      setCategories(normalizeCategories(categories));
      error = null;
    } catch (loadError: any) {
      trackedCompletedIds = new Set();
      trackedChapterTotalsByMangaId = new Map();
      error = loadError.message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    retryCount;
    loading = true;
    error = null;
    if (retryCount > 0) cache.clearGroup(CACHE_GROUPS.LIBRARY);
    untrack(() => loadData());
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

  const bookCoverSrcById = $derived(
    new Map(store.books.map((book) => [book.id, BookAssetResolver.resolveCoverSrc(book)])),
  );

  const comicsSectionState = $derived(buildComicsSectionState({
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
  }));

  const booksSectionState = $derived(buildBooksSectionState({
    librarySection: store.librarySection,
    profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? null,
    books: store.books,
    progressByBookId: new Map(store.bookProgress.map((progress) => [progress.bookId, progress])),
    coverSrcByBookId: bookCoverSrcById,
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
  }));

  const activeSectionVm = $derived(store.librarySection === "books" ? booksSectionState.vm : comicsSectionState.vm);
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

  const comicsActions = $derived(createComicsLibraryActions({
    openSection: (section) => setLibrarySection(section),
    selectCollection: (id) => setLibraryFilter(id),
    setSearch: (value) => { comicsSearch = value; },
    setSortMode: (mode) => setTabSort(mode as LibrarySortMode),
    setSortDir: (dir) => setTabSort(tabSortMode, dir),
    setFilter: (value) => setTabStatus(value as LibraryStatusFilter),
    openCard: () => {},
    openContextMenu: () => {},
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
    openCard: () => {},
  }));

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
    const inCategory = (comicsSectionState.categoryMangaMap.get(category.id) ?? []).some((entry) => entry.id === manga.id);
    setCategories(store.categories.map((entry) => {
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
    const unsubscribe = cache.subscribe(CACHE_KEYS.LIBRARY, () => loadData());

    if (store.settings.defaultLibrarySection !== "last-used") {
      setLibrarySection(store.settings.defaultLibrarySection);
    }

    const defaultId = store.settings.defaultLibraryCategoryId;
    if (store.librarySection === "comics" && defaultId && store.libraryFilter === "library") {
      store.libraryFilter = String(defaultId);
    }

    return () => {
      unsubscribe();
    };
  });

  export async function checkAndMarkCompleted(mangaId: number, chapters: Chapter[]) {
    await storeCheckAndMarkCompleted(mangaId, chapters, store.categories, gql, UPDATE_MANGA_CATEGORIES, UPDATE_MANGA);
    await reloadCategories();
  }
</script>

{#if error}
  <div class="center">
    <p class="error-msg">Could not reach Suwayomi</p>
    <p class="error-detail">Make sure the server is running, then retry.</p>
    <button type="button" class="retry-btn" onclick={() => retryCount++}>Retry</button>
  </div>
{:else}
  <LibraryShell
    sectionTabs={activeSectionVm.sectionTabs}
    collections={activeSectionVm.collections}
    toolbar={activeSectionVm.toolbar}
    displaySettings={displaySettings}
    branchesEnabled={store.settings.libraryBranches ?? true}
    sortDefaultMode={activeSortDefaultMode}
    sortDefaultDir={activeSortDefaultDir}
    filterDefaultValue={activeFilterDefaultValue}
    sortLabel={activeSortLabel}
    filterLabel={activeFilterLabel}
    collectionsReorderApi={collectionsReorderApi}
    onSectionChange={(section) => {
      if (store.librarySection === section) return;
      setLibrarySection(section);
    }}
    onCollectionSelect={(id) => {
      if (store.librarySection === "books") booksActions.selectCollection(id);
      else comicsActions.selectCollection(id);
    }}
    onSearchChange={(value) => {
      if (store.librarySection === "books") booksActions.setSearch(value);
      else comicsActions.setSearch(value);
    }}
    onSortModeChange={(mode) => {
      if (store.librarySection === "books") booksActions.setSortMode(mode);
      else comicsActions.setSortMode(mode);
    }}
    onSortDirToggle={() => {
      if (store.librarySection === "books") toggleBookSortDir();
      else toggleTabSortDir();
    }}
    onFilterChange={(value) => {
      if (store.librarySection === "books") booksActions.setFilter(value);
      else comicsActions.setFilter(value);
    }}
    onViewModeChange={(mode) => updateSettings({ libraryViewMode: mode })}
    onPreferredColumnsChange={(value) => updateSettings({ libraryPreferredGridColumns: value })}
    onShowProgressChange={(value) => updateSettings({ libraryShowProgress: value })}
    onShowOutlineChange={(value) => updateSettings({ libraryShowCardOutline: value })}
  >
    {#snippet headerControls()}
      {#if store.librarySection === "books"}
        <BooksTypeSelector
          options={booksSectionState.vm.typeOptions}
          onSelect={(id) => booksActions.selectType(id)}
        />
      {/if}
    {/snippet}
    {#if store.librarySection === "books"}
      <BooksLibraryBody
        vm={booksSectionState.vm}
        books={booksSectionState.filteredBooks}
        totalBooks={store.books.length}
        viewKey={booksViewKey}
        viewMode={displaySettings.viewMode}
        preferredColumns={displaySettings.preferredColumns}
        showProgress={displaySettings.showProgress}
        showOutline={displaySettings.showOutline}
      />
    {:else}
      <ComicsLibraryBody
        vm={comicsSectionState.vm}
        mangas={comicsSectionState.filteredManga}
        categories={comicsSectionState.visibleCategories}
        categoryMangaMap={comicsSectionState.categoryMangaMap}
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
      />
    {/if}
  </LibraryShell>
{/if}

<style>
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

  .error-msg {
    color: var(--color-error);
    font-size: var(--text-base);
  }

  .error-detail {
    color: var(--text-faint);
    font-size: var(--text-sm);
  }

  .retry-btn {
    margin-top: var(--sp-3);
    padding: 6px 16px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
  }
</style>
