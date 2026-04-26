<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { gql, thumbUrl } from "../../lib/client";
  import { GET_SOURCES, FETCH_SOURCE_MANGA, GET_TRACKERS, SEARCH_TRACKER } from "../../lib/queries";
  import { fetchSourceMangaSearchWithFallback } from "../../lib/manga/sourceSearch";
  import { cache, CACHE_KEYS, getPageSet } from "../../lib/cache";
  import { dedupeSources, dedupeMangaById, dedupeMangaByTitle, shouldHideNsfw, shouldHideSource } from "../../lib/util";
  import { store, updateSettings, setSearchPrefill, setPreviewManga, setExtensionsPanelHint, addToast, setSearchTabHint, setSearchBrowseHint, setSearchSourcesPaneHint, setSearchVisibilityDismissed, setActiveNovelDetail } from "../../store/state.svelte";
  import type { Manga, Source, Tracker, TrackSearch } from "../../lib/types";
  import SetupStatusCard from "../shared/SetupStatusCard.svelte";
  import SourcesView from "./SourcesView.svelte";
  import { detectSetupState, type SetupState } from "../../lib/setupState";
  import { ensureExtensionRepo, RECOMMENDED_EXTENSION_REPO } from "../../lib/defaultRepos";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import { browseInstalledNovelSource, loadTrustedInstalledNovelSources, readInstalledNovelDetails, searchInstalledNovelSource, shutdownInstalledNovelSourcesRuntime } from "../../lib/novels/sources";
  import { createNovelLibraryId, type InstalledNovelSourceDescriptor, type NovelSourceSearchResult } from "../../lib/novels/domain";
  import { isNovelInLibrary, loadNovelLibraryState, peekNovelLibraryState } from "../../lib/novels/libraryState";

  type SearchTab  = "keyword" | "browse" | "source";
  type BrowseTab  = "featured" | "tag";
  type TagMode    = "AND" | "OR";
  type CatalogFeed = "all" | "popular" | "latest";

  interface SourceResult {
    source:  Source;
    mangas:  Manga[];
    loading: boolean;
    error:   string | null;
  }

  interface BrowseSourceEntry {
    id: string;
    name: string;
    displayName: string;
    lang: string;
    iconUrl: string | null;
    isNsfw: boolean;
    contentKind: "manga" | "novels";
    mangaSource?: Source;
    novelSource?: InstalledNovelSourceDescriptor;
  }

  type BrowseTrackerEntry = Tracker;

  function safePeekNovelLibraryState() {
    try {
      return peekNovelLibraryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      });
    } catch {
      return null;
    }
  }

  const CONCURRENCY = 6;

  const COMMON_GENRES = [
    "Action","Adventure","Comedy","Drama","Fantasy","Romance",
    "Sci-Fi","Slice of Life","Horror","Mystery","Thriller","Sports",
    "Supernatural","Mecha","Historical","Psychological","School Life",
    "Shounen","Seinen","Josei","Shoujo","Isekai","Martial Arts",
    "Magic","Music","Cooking","Medical","Military","Harem","Ecchi","Doujinshi","Yaoi","Yuri",
  ];

  const ADULT_GENRES = [
    "Adult","Suggestive","Hentai","Mature","Smut","Erotica",
  ];

  function genreMatchesBlockedTag(genre: string, blockedTags: string[]): boolean {
    const normalizedGenre = genre.toLowerCase().trim();
    return blockedTags.some((tag) => {
      const normalizedTag = tag.toLowerCase().trim();
      return normalizedTag.length > 0
        && (normalizedGenre === normalizedTag || normalizedGenre.includes(normalizedTag));
    });
  }

  const TRACKER_CATALOG_PAGE_SIZE = 24;

  const GENRE_ALIASES: Record<string, string[]> = {
    Adult: ["Adult", "Mature", "18+", "Smut", "Erotica", "Explicit", "Pornographic"],
    Suggestive: ["Suggestive", "Fanservice", "Mature", "Smut"],
    Hentai: ["Hentai", "Adult", "Erotica", "Pornographic"],
    Mature: ["Mature", "Adult", "18+", "Seinen"],
    Smut: ["Smut", "Adult", "Erotica"],
    Erotica: ["Erotica", "Erotic", "Adult", "Smut"],
    Doujinshi: ["Doujinshi", "Doujin", "Fan Comic"],
    Yaoi: ["Yaoi", "Boys Love", "BL"],
    Yuri: ["Yuri", "Girls Love", "GL"],
  };

  function getGenreAliases(tag: string): string[] {
    return GENRE_ALIASES[tag] ?? [tag];
  }

  function getGenreSearchTerm(tag: string): string {
    return getGenreAliases(tag)[0] ?? tag;
  }
  async function runConcurrent<T>(items: T[], fn: (item: T) => Promise<void>, signal: AbortSignal): Promise<void> {
    let i = 0;
    async function worker() {
      while (i < items.length) {
        if (signal.aborted) return;
        const item = items[i++];
        await fn(item).catch(() => {});
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  }

  function matchesAllTags(m: Manga, tags: string[]): boolean {
    const genres = (m.genre ?? []).map((g: string) => g.toLowerCase());
    return tags.every((tag) =>
      getGenreAliases(tag).some((alias) => {
        const normalized = alias.toLowerCase();
        return genres.some((genre) => genre === normalized || genre.includes(normalized));
      }),
    );
  }

  function buildGenreFilter(tags: string[], mode: TagMode): Record<string, unknown> {
    if (tags.length === 0) return {};
    const filters = tags.map((tag) => {
      const aliases = getGenreAliases(tag);
      return aliases.length === 1
        ? { genre: { includesInsensitive: aliases[0] } }
        : { or: aliases.map((alias) => ({ genre: { includesInsensitive: alias } })) };
    });
    if (mode === "AND") return { and: filters };
    return { or: filters };
  }

  const MANGAS_BY_GENRE = `
    query MangasByGenre($filter: MangaFilterInput, $first: Int, $offset: Int) {
      mangas(filter: $filter, first: $first, offset: $offset, orderBy: IN_LIBRARY_AT, orderByType: DESC) {
        nodes {
          id title thumbnailUrl inLibrary genre status
          source { id displayName }
        }
        pageInfo { hasNextPage }
        totalCount
      }
    }
  `;

  let browseTab: BrowseTab = $state("featured");
  let activeContentType = $state<"manga" | "novels">("manga");
  let activeBrowseTab = $state<SearchTab>("browse");
  let browseSearchFocused = $state(false);
  let searchQuery = $state("");
  let selectedSource = $state("");
  let discoverSelectedSource = $state("");
  let discoverSelectedTracker = $state<number | null>(null);
  let genreMode = $state<TagMode>("AND");
  let selectedGenres = $state<string[]>([]);
  let preferredLang = store.settings?.preferredExtensionLang ?? "";
  let catalogFeed: CatalogFeed = $state("all");
  const includeNsfwSources = $derived(store.settings.showNsfw);
  let includeInLibrary = $state(true);
  let catalogGenresOpen = $state(true);
  let catalogSourcePickerOpen = $state(false);
  let catalogLanguagePickerOpen = $state(false);
  let catalogTrackingPickerOpen = $state(false);
  let consumedGenreHint = $state("");
  let setupState: SetupState | null = $state(null);
  let setupLoading = $state(true);
  let setupActionBusy = $state(false);
  let discoverLoading = $state(false);
  let discoverLoadedKey = $state("");
  let discoverMangaResults: Manga[] = $state([]);
  let discoverNovelResults: NovelSourceSearchResult[] = $state([]);
  let discoverError = $state("");
  let discoverAbortCtrl: AbortController | null = null;
  let discoverCurrentPage = $state(1);
  let discoverHasNextPage = $state(false);
  let discoverLoadingMore = $state(false);

  let allSources:  Source[] = $state([]);
  let allNovelSources: InstalledNovelSourceDescriptor[] = $state([]);
  let allTrackers: BrowseTrackerEntry[] = $state([]);
  let loadingSources         = $state(false);
  let loadingTrackers        = $state(false);
  let trackerCatalogResults = $state<TrackSearch[]>([]);
  let trackerCatalogLoading = $state(false);
  let trackerCatalogLoadingMore = $state(false);
  let trackerCatalogPage = $state(1);
  let trackerCatalogLoadedKey = $state("");
  let trackerCatalogError = $state("");
  let pendingPrefill         = $state("");
  let novelLibraryState = $state(safePeekNovelLibraryState());

  refreshSetupState();

  async function refreshSetupState() {
    setupLoading = true;
    setupState = await detectSetupState(store.settings);
    setupLoading = false;
  }

  async function addRecommendedRepo() {
    setupActionBusy = true;
    try {
      const result = await ensureExtensionRepo(RECOMMENDED_EXTENSION_REPO);
      addToast({
        kind: result.status === "added" ? "success" : "info",
        title: result.status === "added" ? "Recommended repo added" : "Recommended repo already added",
        body: result.status === "added"
          ? `${result.repo.name} is ready. Next, install your first extension.`
          : `${result.repo.name} is already configured. Next, install your first extension.`,
      });
      await refreshSetupState();
      activeBrowseTab = "source";
    } catch (error) {
      addToast({
        kind: "error",
        title: "Could not add the recommended repo",
        body: error instanceof Error ? error.message : "Aethon couldn't save the recommended repo.",
      });
    } finally {
      setupActionBusy = false;
    }
  }

  function openRepoManagerFlow() {
    activeBrowseTab = "source";
    setExtensionsPanelHint("repos");
  }

  function selectContentType(next: "manga" | "novels") {
    if (activeContentType === next) return;
    activeContentType = next;
    resetContentTypeScopedState();
  }

  function resetSourceBrowseState() {
    src_abortCtrl?.abort();
    selectedSource = "";
    src_activeSource = null;
    src_activeNovelSource = null;
    src_browseResults = [];
    src_novelBrowseResults = [];
    src_submitted = "";
    src_browseQuery = "";
    src_hasNextPage = false;
    src_currentPage = 1;
    src_loadingBrowse = false;
  }

  function resetContentTypeScopedState() {
    resetSourceBrowseState();
    discoverAbortCtrl?.abort();
    discoverSelectedSource = "";
    discoverSelectedTracker = null;
    resetTrackerCatalogState();
    discoverLoadedKey = "";
    discoverMangaResults = [];
    discoverNovelResults = [];
    discoverError = "";
    discoverLoading = false;
    discoverCurrentPage = 1;
    discoverHasNextPage = false;
    discoverLoadingMore = false;
    src_selectedLang = "all";
    catalogSourcePickerOpen = false;
    catalogLanguagePickerOpen = false;
    tag_searchSources = false;
    tag_sourceResults = [];
    tag_srcNextPage = new Map();
    tag_loadingSourceSearch = false;
    tag_loadingMoreSource = false;
    void shutdownInstalledNovelSourcesRuntime().catch(() => {});
  }

  function selectBrowseTab(next: SearchTab) {
    activeBrowseTab = next;
    if (next === "browse") {
      resetSourceBrowseState();
    }
  }

  function handleSearch(query: string) {
    searchQuery = query;
    const normalized = query.trim();

    if (activeBrowseTab === "browse") {
      if (!normalized) return;
        activeBrowseTab = "keyword";
    }

    kw_query = normalized;
    if (normalized) kwDoSearch(normalized);
  }

  function handleBrowseSearchFocus() {
    browseSearchFocused = true;
    document.body.classList.add("aethon-browse-search-engaged");
  }

  function handleBrowseSearchBlur() {
    browseSearchFocused = false;
    document.body.classList.remove("aethon-browse-search-engaged");
  }

  $effect(() => {
    if (activeBrowseTab === "browse" && (src_activeSource || src_activeNovelSource)) {
      resetSourceBrowseState();
    }
  });

  function loadMore() {
    if (activeBrowseTab === "browse") {
      if (!tag_hasActiveTags && discoverFocusedTracker) {
        void loadTrackerCatalogMore();
        return;
      }
      if (tag_hasActiveTags && tag_sourceHasMore) {
        void tagLoadMoreSource();
        return;
      }
      if (tag_hasActiveTags && tag_localHasNext) {
        void tagLoadMoreLocal();
        return;
      }
      if (!tag_hasActiveTags && !discoverFocusedTracker && discoverHasNextPage && !discoverLoadingMore && !discoverLoading) {
        void loadDiscoverMore();
      }
    }
  }

  function handleCatalogGridScroll(event: Event) {
    const target = event.currentTarget as HTMLElement;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 420) {
      loadMore();
    }
  }

  $effect(() => {
    if (store.searchTabHint) {
      activeBrowseTab = store.searchTabHint === "sources" ? "source" : store.searchTabHint;
      setSearchTabHint(null);
    }
    if (store.searchBrowseHint) {
      browseTab = store.searchBrowseHint === "tags" ? "tag" : "featured";
      catalogFeed = "all";
      if (store.searchBrowseHint === "tags") catalogGenresOpen = true;
      setSearchBrowseHint(null);
    }
    if (store.searchSourcesPaneHint) setSearchSourcesPaneHint(null);
  });

  $effect(() => {
    const hintedGenre = store.genreFilter?.trim() ?? "";
    if (!hintedGenre || hintedGenre === consumedGenreHint) return;
    if (!tag_activeTags.includes(hintedGenre)) {
      tag_srcNextPage = new Map();
      tag_sourceResults = [];
      tag_activeTags = [hintedGenre];
    }
    activeBrowseTab = "browse";
    browseTab = "tag";
    catalogFeed = "all";
    catalogGenresOpen = true;
    consumedGenreHint = hintedGenre;
  });

  $effect(() => {
    if (store.searchPrefill) {
      const prefill = store.searchPrefill;
      untrack(() => {
        pendingPrefill = prefill;
      activeBrowseTab = "keyword";
        setSearchPrefill("");
      });
    }
  });

  async function refreshSources() {
    loadingSources = true;
    try {
      const [d, novels] = await Promise.all([
        gql<{ sources: { nodes: Source[] } }>(GET_SOURCES),
        loadTrustedInstalledNovelSources({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        }).catch(() => [] as InstalledNovelSourceDescriptor[]),
      ]);
      allSources = d.sources.nodes.filter((src: Source) => src.id !== "0");
      allNovelSources = novels;
    } catch (error) {
      console.error(error);
    } finally {
      loadingSources = false;
    }
  }

  async function refreshTrackers() {
    loadingTrackers = true;
    try {
      const d = await gql<{ trackers: { nodes: BrowseTrackerEntry[] } }>(GET_TRACKERS);
      allTrackers = d.trackers.nodes ?? [];
    } catch (error) {
      console.error(error);
      allTrackers = [];
    } finally {
      loadingTrackers = false;
    }
  }

  $effect(() => {
    store.contentSetupVersion;
    store.runtimeResolvedLocalProfileId;
    store.runtimeServerUrl;
    untrack(() => {
      refreshSetupState();
      refreshSources();
      refreshTrackers();
      loadNovelLibraryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }).then((state) => {
        novelLibraryState = state;
      }).catch(() => {});
    });
  });

  const availableLangs   = $derived(Array.from(new Set<string>(allSources.map((s) => s.lang))).sort());
  const hasMultipleLangs = $derived(availableLangs.length > 1);

  let kw_query        = $state("");
  let kw_submitted    = $state("");
  let kw_results:     SourceResult[] = $state([]);
  let kw_showAdvanced = $state(false);
  let kw_selectedLangs: Set<string>  = $state(new Set());
  let kw_inputEl:     HTMLInputElement | null = $state(null);
  let kw_abortCtrl:   AbortController | null  = null;

  $effect(() => {
    if (allSources.length) {
      const available = new Set(allSources.map((s) => s.lang));
      kw_selectedLangs = available.has(preferredLang)
        ? new Set([preferredLang])
        : new Set(availableLangs.slice(0, 1));
    }
  });

  $effect(() => {
    if (!loadingSources && pendingPrefill && !kw_submitted && allSources.length) {
      const q = pendingPrefill;
      pendingPrefill = "";
      kw_query = q;
      kwDoSearch(q);
    }
  });

  function kwGetVisibleSources(): Source[] {
    let filtered = allSources;
    if (kw_selectedLangs.size > 0)
      filtered = filtered.filter((s) => kw_selectedLangs.has(s.lang));
    if (!store.settings.showNsfw)
      filtered = filtered.filter((s) => !shouldHideSource(s, store.settings));
    return filtered;
  }

  async function kwDoSearch(q: string) {
    if (setupState?.kind && setupState.kind !== "ready") return;
    const trimmed = q.trim();
    if (!trimmed) return;
    const visible = kwGetVisibleSources();
    if (!visible.length) return;
    kw_abortCtrl?.abort();
    const ctrl = new AbortController();
    kw_abortCtrl = ctrl;
    kw_submitted = trimmed;
    kw_results   = visible.map((src) => ({ source: src, mangas: [], loading: true, error: null }));
    await runConcurrent(visible, async (src) => {
      if (ctrl.signal.aborted) return;
      try {
        const mangas = await fetchSourceMangaSearchWithFallback({
          sourceId: src.id,
          query: trimmed,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        const visibleMangas = mangas.filter((m) => !shouldHideNsfw(m, store.settings));
        kw_results = kw_results.map((r) =>
          r.source.id === src.id ? { ...r, mangas: visibleMangas, loading: false } : r,
        );
      } catch (e: any) {
        if (ctrl.signal.aborted || e?.name === "AbortError") return;
        kw_results = kw_results.map((r) =>
          r.source.id === src.id ? { ...r, loading: false, error: e.message ?? "Error" } : r,
        );
      }
    }, ctrl.signal);
  }

  function kwToggleLang(lang: string) {
    const next = new Set(kw_selectedLangs);
    if (next.has(lang)) { if (next.size === 1) return; next.delete(lang); }
    else next.add(lang);
    kw_selectedLangs = next;
  }

  const kw_visibleCount = $derived(kwGetVisibleSources().length);
  const kw_hasResults   = $derived(kw_results.some((r) => r.mangas.length > 0));
  const kw_allDone      = $derived(kw_results.length > 0 && kw_results.every((r) => !r.loading));
  const setupReady      = $derived.by(() => setupState != null && setupState.kind === "ready");
  const installedContentExtensionCount = $derived.by(() => setupState?.installedContentExtensionCount ?? 0);
  const kw_contentVisibleSources = $derived(allSources.filter((source) => !shouldHideSource(source, store.settings)));
  const kw_hiddenByContentCount = $derived(Math.max(0, allSources.length - kw_contentVisibleSources.length));
  const kw_hiddenByLanguageCount = $derived(kw_contentVisibleSources.filter((source) => !kw_selectedLangs.has(source.lang)).length);
  const kw_hasVisibilityMismatch = $derived(
    setupReady
    && installedContentExtensionCount > 0
    && (kw_hiddenByContentCount > 0 || kw_hiddenByLanguageCount > 0 || kw_visibleCount < installedContentExtensionCount),
  );
  const kw_visibilitySummary = $derived.by(() => {
    if (!kw_hasVisibilityMismatch) return null;

    const languageCount = kw_selectedLangs.size;
    const likelyCause = kw_hiddenByContentCount > 0 && kw_hiddenByLanguageCount > 0
      ? "Current language and content visibility rules are hiding part of the installed source set."
      : kw_hiddenByContentCount > 0
        ? "Current content visibility rules are hiding part of the installed source set."
        : kw_hiddenByLanguageCount > 0
          ? "Current language selection is hiding part of the installed source set."
          : "Some installed extensions may not currently appear as visible sources here.";

    return {
      title: "Installed extensions and visible sources are different counts",
      body: `You have ${installedContentExtensionCount} installed content extension${installedContentExtensionCount !== 1 ? "s" : ""}, but only ${kw_visibleCount} source${kw_visibleCount !== 1 ? "s are" : " is"} visible for this search view. ${likelyCause}`,
      detail: kw_hiddenByContentCount > 0 && kw_hiddenByLanguageCount > 0
        ? `${kw_hiddenByContentCount} source${kw_hiddenByContentCount !== 1 ? "s are" : " is"} hidden by current content visibility, and ${kw_hiddenByLanguageCount} more ${kw_hiddenByLanguageCount !== 1 ? "are" : "is"} outside the ${languageCount} selected language${languageCount !== 1 ? "s" : ""}.`
        : kw_hiddenByContentCount > 0
          ? `${kw_hiddenByContentCount} source${kw_hiddenByContentCount !== 1 ? "s are" : " is"} hidden by current content visibility.`
          : kw_hiddenByLanguageCount > 0
            ? `${kw_hiddenByLanguageCount} source${kw_hiddenByLanguageCount !== 1 ? "s are" : " is"} outside the ${languageCount} selected language${languageCount !== 1 ? "s" : ""}.`
            : "One extension can expose zero, one, or many sources, so these counts will not always match exactly.",
    };
  });
  const kw_showVisibilitySummary = $derived(!!kw_visibilitySummary && !store.searchVisibilityDismissed);

  function openSearchVisibilityFilters() {
    activeBrowseTab = "keyword";
    kw_showAdvanced = true;
    kw_inputEl?.focus();
  }

  function dismissSearchVisibilitySummary() {
    setSearchVisibilityDismissed(true);
  }

  let tag_activeTags:       string[] = $state([]);
  let tag_tagMode:          TagMode  = $state("AND");
  let tag_tagFilter                  = $state("");

  let tag_localResults:     Manga[]  = $state([]);
  let tag_totalCount                 = $state(0);
  let tag_loadingLocal               = $state(false);
  let tag_loadingMoreLocal           = $state(false);
  let tag_localOffset                = $state(0);
  let tag_localHasNext               = $state(false);
  let tag_abortLocal:       AbortController | null = null;

  let tag_searchSources              = $state(false);
  let tag_sourceResults:    Manga[]  = $state([]);
  let tag_loadingSourceSearch        = $state(false);
  let tag_loadingMoreSource          = $state(false);
  let tag_srcNextPage: Map<string, number> = $state(new Map());
  let tag_abortSource: AbortController | null = null;

  const tag_filteredGenres = $derived.by(() => {
    const q = tag_tagFilter.trim().toLowerCase();
    const blockedTags = store.settings.filterBlockedTags ? (store.settings.nsfwFilteredTags ?? []) : [];
    const genres = (includeNsfwSources ? [...COMMON_GENRES, ...ADULT_GENRES] : COMMON_GENRES)
      .filter((genre) => !genreMatchesBlockedTag(genre, blockedTags));
    return q ? genres.filter((g) => g.toLowerCase().includes(q)) : genres;
  });

  function toggleGenre(genre: string) {
    tagToggleTag(genre);
  }

  const tag_hasActiveTags = $derived(tag_activeTags.length > 0);
  const tag_localIds      = $derived(new Set(tag_localResults.map((m) => m.id)));
  const tag_mergedResults = $derived(dedupeMangaByTitle(dedupeMangaById(
    tag_searchSources
      ? [...tag_localResults, ...tag_sourceResults.filter((m) => !tag_localIds.has(m.id))]
      : tag_localResults
  ), store.settings.mangaLinks));
  const tag_totalVisible  = $derived(tag_mergedResults.length);
  const tag_sourceHasMore = $derived(tag_searchSources && [...tag_srcNextPage.values()].some((p) => p > 0));

  $effect(() => {
    const _activeTags = tag_activeTags;
    const _tagMode    = tag_tagMode;
    untrack(() => tagFetchLocal(_activeTags, _tagMode));
  });

  let tag_autoSearchFired = $state(false);
  $effect(() => {
    if (!tag_loadingLocal && tag_activeTags.length > 0 && !tag_autoSearchFired && !tag_searchSources && !loadingSources) {
      if (tag_localResults.length < 20) {
        untrack(() => { tag_autoSearchFired = true; tag_searchSources = true; });
      }
    }
  });
  $effect(() => { const _ = tag_activeTags; untrack(() => { tag_autoSearchFired = false; }); });
  $effect(() => {
    const blockedTags = store.settings.filterBlockedTags ? (store.settings.nsfwFilteredTags ?? []) : [];
    if (blockedTags.length === 0 || tag_activeTags.length === 0) return;
    const visibleTags = tag_activeTags.filter((tag) => !genreMatchesBlockedTag(tag, blockedTags));
    if (visibleTags.length !== tag_activeTags.length) {
      untrack(() => {
        tag_srcNextPage = new Map();
        tag_sourceResults = [];
        tag_activeTags = visibleTags;
      });
    }
  });
  $effect(() => {
    if (tag_searchSources && tag_activeTags.length > 0 && !loadingSources) {
      const tags = tag_activeTags;
      untrack(() => tagFetchSources(tags));
    }
  });

  async function tagFetchLocal(activeTags: string[], tagMode: TagMode) {
    if (activeTags.length === 0) {
      tag_localResults = []; tag_totalCount = 0; tag_localHasNext = false; tag_localOffset = 0;
      return;
    }
    tag_abortLocal?.abort();
    const ctrl = new AbortController();
    tag_abortLocal = ctrl;
    tag_localResults = []; tag_totalCount = 0; tag_localOffset = 0; tag_localHasNext = false;
    tag_loadingLocal = true;
    gql<{ mangas: { nodes: Manga[]; pageInfo: { hasNextPage: boolean }; totalCount: number } }>(
      MANGAS_BY_GENRE,
      { filter: buildGenreFilter(activeTags, tagMode), first: (store.settings.renderLimit ?? 48), offset: 0 },
      ctrl.signal,
    ).then((d) => {
      if (ctrl.signal.aborted) return;
      const nsfwFilter = (m: Manga) => !shouldHideNsfw(m, store.settings);
      tag_localResults  = d.mangas.nodes.filter(nsfwFilter);
      tag_totalCount    = d.mangas.totalCount;
      tag_localHasNext  = d.mangas.pageInfo.hasNextPage;
      tag_localOffset   = (store.settings.renderLimit ?? 48);
    }).catch((e: any) => {
      if (e?.name !== "AbortError") console.error(e);
    }).finally(() => {
      if (!ctrl.signal.aborted) tag_loadingLocal = false;
    });
  }

  async function tagFetchSources(activeTags: string[]) {
    tag_abortSource?.abort();
    const ctrl = new AbortController();
    tag_abortSource = ctrl;
    tag_srcNextPage       = new Map();
    tag_loadingSourceSearch = true;
    const sources    = dedupeSources(allSources, preferredLang);
    const primaryTag = getGenreSearchTerm(activeTags[0]);
    for (const src of sources) tag_srcNextPage.set(src.id, -1);
    runConcurrent(sources, async (src) => {
      if (ctrl.signal.aborted) return;
      const ps      = getPageSet(src.id, "SEARCH", activeTags);
      const pageKey = CACHE_KEYS.sourceMangaPage(src.id, "SEARCH", 1, activeTags);
      const result = await cache
        .get<{ mangas: Manga[]; hasNextPage: boolean }>(
          pageKey,
          () => gql<{ fetchSourceManga: { mangas: Manga[]; hasNextPage: boolean } }>(
            FETCH_SOURCE_MANGA, { source: src.id, type: "SEARCH", page: 1, query: primaryTag }, ctrl.signal,
          ).then((d) => d.fetchSourceManga),
        )
        .catch((e: any) => { if (e?.name !== "AbortError") console.error(e); return null; });
      if (!result || ctrl.signal.aborted) return;
      ps.add(1);
      tag_srcNextPage.set(src.id, result.hasNextPage ? 2 : -1);
      tag_srcNextPage = new Map(tag_srcNextPage);
      const matching = (activeTags.length > 1
        ? result.mangas.filter((m) => matchesAllTags(m, activeTags))
        : result.mangas
      ).filter((m) => !shouldHideNsfw(m, store.settings));
      if (matching.length > 0) {
        tag_sourceResults = dedupeMangaByTitle(dedupeMangaById([...tag_sourceResults, ...matching]), store.settings.mangaLinks);
        tag_loadingSourceSearch = false;
      }
    }, ctrl.signal).finally(() => {
      if (!ctrl.signal.aborted) tag_loadingSourceSearch = false;
    });
  }

  async function tagLoadMoreLocal() {
    if (tag_loadingMoreLocal || !tag_localHasNext) return;
    tag_loadingMoreLocal = true;
    tag_abortLocal?.abort();
    const ctrl = new AbortController();
    tag_abortLocal = ctrl;
    try {
      const d = await gql<{ mangas: { nodes: Manga[]; pageInfo: { hasNextPage: boolean } } }>(
        MANGAS_BY_GENRE,
        { filter: buildGenreFilter(tag_activeTags, tag_tagMode), first: (store.settings.renderLimit ?? 48), offset: tag_localOffset },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      const nsfwFilter = (m: Manga) => !shouldHideNsfw(m, store.settings);
      tag_localResults = dedupeMangaByTitle(
        dedupeMangaById([...tag_localResults, ...d.mangas.nodes.filter(nsfwFilter)]),
        store.settings.mangaLinks,
      );
      tag_localHasNext  = d.mangas.pageInfo.hasNextPage;
      tag_localOffset  += (store.settings.renderLimit ?? 48);
    } catch (e: any) {
      if (e?.name !== "AbortError") console.error(e);
    } finally {
      if (!ctrl.signal.aborted) tag_loadingMoreLocal = false;
    }
  }

  async function tagLoadMoreSource() {
    if (tag_loadingMoreSource || !tag_sourceHasMore) return;
    tag_loadingMoreSource = true;
    tag_abortSource?.abort();
    const ctrl = new AbortController();
    tag_abortSource = ctrl;
    const sources    = dedupeSources(allSources, preferredLang).filter((src) => (tag_srcNextPage.get(src.id) ?? -1) > 0);
    const primaryTag = getGenreSearchTerm(tag_activeTags[0]);
    try {
      await runConcurrent(sources, async (src) => {
        const page    = tag_srcNextPage.get(src.id)!;
        if (ctrl.signal.aborted) return;
        const ps      = getPageSet(src.id, "SEARCH", tag_activeTags);
        const pageKey = CACHE_KEYS.sourceMangaPage(src.id, "SEARCH", page, tag_activeTags);
        const result = await cache
          .get<{ mangas: Manga[]; hasNextPage: boolean }>(
            pageKey,
            () => gql<{ fetchSourceManga: { mangas: Manga[]; hasNextPage: boolean } }>(
              FETCH_SOURCE_MANGA, { source: src.id, type: "SEARCH", page, query: primaryTag }, ctrl.signal,
            ).then((d) => d.fetchSourceManga),
          )
          .catch((e: any) => { if (e?.name !== "AbortError") tag_srcNextPage.set(src.id, -1); return null; });
        if (!result || ctrl.signal.aborted) return;
        ps.add(page);
        tag_srcNextPage.set(src.id, result.hasNextPage ? page + 1 : -1);
        tag_srcNextPage = new Map(tag_srcNextPage);
        const matching = (tag_activeTags.length > 1
          ? result.mangas.filter((m) => matchesAllTags(m, tag_activeTags))
          : result.mangas
        ).filter((m) => !shouldHideNsfw(m, store.settings));
        if (matching.length > 0) {
          tag_sourceResults = dedupeMangaByTitle(dedupeMangaById([...tag_sourceResults, ...matching]), store.settings.mangaLinks);
        }
      }, ctrl.signal);
    } finally {
      if (!ctrl.signal.aborted) tag_loadingMoreSource = false;
    }
  }

  function tagToggleTag(tag: string) {
    tag_srcNextPage   = new Map();
    tag_sourceResults = [];
    tag_activeTags    = tag_activeTags.includes(tag)
      ? tag_activeTags.filter((t) => t !== tag)
      : [...tag_activeTags, tag];
  }

  function tagToggleSearchSources() {
    tag_searchSources = !tag_searchSources;
    if (tag_searchSources && tag_activeTags.length > 0 && !loadingSources) {
      tagFetchSources(tag_activeTags);
    }
  }

  function selectCatalogFeed(feed: CatalogFeed) {
    catalogFeed = feed;
    browseTab = "featured";
  }

  function resetBrowseSidebarFilters() {
    catalogFeed = "all";
    includeInLibrary = true;
    discoverSelectedSource = "";
    discoverSelectedTracker = null;
    resetTrackerCatalogState();
    src_selectedLang = "all";
    tag_activeTags = [];
    tag_tagFilter = "";
    catalogSourcePickerOpen = false;
    catalogLanguagePickerOpen = false;
    catalogTrackingPickerOpen = false;
  }

  function closeCatalogPickers() {
    catalogSourcePickerOpen = false;
    catalogLanguagePickerOpen = false;
    catalogTrackingPickerOpen = false;
  }

  function resetTrackerCatalogState() {
    trackerCatalogResults = [];
    trackerCatalogLoading = false;
    trackerCatalogLoadingMore = false;
    trackerCatalogPage = 1;
    trackerCatalogLoadedKey = "";
    trackerCatalogError = "";
  }

  function handleBrowsePointerDown(event: PointerEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.closest(".browsePickerField")) {
      closeCatalogPickers();
      return;
    }
    if (!target.closest(".browseLanguageField")) catalogLanguagePickerOpen = false;
    if (!target.closest(".browseSourceField")) catalogSourcePickerOpen = false;
    if (!target.closest(".browseTrackingField")) catalogTrackingPickerOpen = false;
  }

  onMount(() => {
    document.addEventListener("pointerdown", handleBrowsePointerDown);
    return () => document.removeEventListener("pointerdown", handleBrowsePointerDown);
  });

  const browseVisibilitySettings = $derived(
    includeNsfwSources ? { ...store.settings, showNsfw: true } : store.settings,
  );
  const browseHiddenBySafetyCount = $derived(
    allSources.filter((source) => shouldHideSource(source, store.settings)).length,
  );
  const showBrowseVisibilityCard = $derived(!includeNsfwSources && browseHiddenBySafetyCount > 0);

  function toggleIncludeNsfwSources() {
    const nextShowNsfw = !store.settings.showNsfw;
    updateSettings({ showNsfw: nextShowNsfw });
    if (!nextShowNsfw) {
      const adultGenres = new Set(ADULT_GENRES.map((genre) => genre.toLowerCase()));
      tag_activeTags = tag_activeTags.filter((tag) => !adultGenres.has(tag.toLowerCase()));
    }
  }

  function shouldShowCatalogManga(manga: Manga) {
    return includeInLibrary || !manga.inLibrary;
  }

  const catalogActiveSummary = $derived.by(() => {
    if (!tag_activeTags.length) return "All";
    if (tag_activeTags.length === 1) return tag_activeTags[0];
    return `${tag_activeTags.length} tags (${tag_tagMode})`;
  });

  let src_selectedLang  = $state("all");
  let src_activeSource: Source | null = $state(null);
  let src_activeNovelSource: InstalledNovelSourceDescriptor | null = $state(null);
  let src_browseResults: Manga[]       = $state([]);
  let src_novelBrowseResults: NovelSourceSearchResult[] = $state([]);
  let src_loadingBrowse                = $state(false);
  let src_browseQuery                  = $state("");
  let src_submitted                    = $state("");
  let src_hasNextPage                  = $state(false);
  let src_currentPage                  = $state(1);
  let src_abortCtrl: AbortController | null = null;
  let src_openingNovelPath: string | null = $state(null);

  const src_mangaSources = $derived.by(() =>
    allSources.map((source) => ({
      id: source.id,
      name: source.name,
      displayName: source.displayName,
      lang: source.lang,
      iconUrl: source.iconUrl,
      isNsfw: source.isNsfw,
      contentKind: "manga" as const,
      mangaSource: source,
    })),
  );

  const src_novelSources = $derived.by(() =>
    allNovelSources.map((source) => ({
      id: source.pluginId,
      name: source.name,
      displayName: source.name,
      lang: source.lang,
      iconUrl: source.iconUrl,
      isNsfw: false,
      contentKind: "novels" as const,
      novelSource: source,
    })),
  );

  const src_catalogSources = $derived(
    activeContentType === "novels" ? src_novelSources : src_mangaSources,
  );

  const src_availableLangs = $derived(Array.from(new Set<string>(
    src_catalogSources.map((s) => s.lang).filter((lang) => lang && lang !== "all"),
  )).sort());

  $effect(() => {
    if (!src_catalogSources.length) return;
    const langs = new Set(src_catalogSources.map((s) => s.lang));
    if (src_selectedLang !== "all" && !langs.has(src_selectedLang)) {
      src_selectedLang = langs.has(preferredLang) ? preferredLang : "all";
    }
  });

  const src_visibleSources = $derived.by(() => {
    let sources = activeContentType === "novels"
      ? src_novelSources.filter((entry) => entry.contentKind === "novels")
      : src_mangaSources.filter((entry) =>
          entry.contentKind === "manga"
          && entry.mangaSource
          && !shouldHideSource(entry.mangaSource, browseVisibilitySettings),
        );
    if (src_selectedLang !== "all") {
      return sources.filter((s) => s.lang === src_selectedLang);
    }
    const map = new Map<string, BrowseSourceEntry>();
    for (const source of sources) {
      const key = source.name;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, source);
        continue;
      }
      if (source.lang === preferredLang || (existing.lang !== preferredLang && source.lang < existing.lang)) {
        map.set(key, source);
      }
    }
    return Array.from(map.values());
  });
  const discoverFocusedSource = $derived(src_visibleSources.find((source) => source.id === discoverSelectedSource));
  const trackingFilterOptions = $derived.by(() => allTrackers.filter((tracker) => tracker.isLoggedIn));
  const discoverFocusedTracker = $derived(
    trackingFilterOptions.find((tracker) => tracker.id === discoverSelectedTracker),
  );
  const discoverFeedSources = $derived.by(() => {
    const limit = activeContentType === "novels" ? 4 : 12;
    if (!discoverFocusedSource) return src_visibleSources.slice(0, limit);
    return [
      discoverFocusedSource,
      ...src_visibleSources.filter((source) => source.id !== discoverFocusedSource.id),
    ].slice(0, limit);
  });
  const discoverResultCount = $derived(
    discoverFocusedTracker
      ? trackerCatalogResults.length
      : activeContentType === "novels" ? discoverNovelResults.length : discoverMangaResults.length,
  );
  const discoverSourceLabel = $derived(
    discoverFocusedTracker
      ? `${discoverFocusedTracker.name} catalog`
      : discoverFocusedSource
      ? discoverFocusedSource.name
      : discoverFeedSources.length > 1
        ? `${discoverFeedSources.length} sources`
        : discoverFeedSources[0]?.name ?? "All sources",
  );

  function sourceNameWithoutLanguage(entry: BrowseSourceEntry) {
    const langSuffix = `(${entry.lang.toUpperCase()})`;
    return entry.displayName.endsWith(langSuffix)
      ? entry.displayName.slice(0, -langSuffix.length).trim()
      : entry.displayName;
  }

  function selectDiscoverSourceFilter(entry: BrowseSourceEntry) {
    discoverSelectedSource = discoverSelectedSource === entry.id ? "" : entry.id;
    if (discoverSelectedSource) {
      discoverSelectedTracker = null;
      resetTrackerCatalogState();
    }
    catalogSourcePickerOpen = false;
  }

  function selectDiscoverTrackerFilter(tracker: BrowseTrackerEntry) {
    discoverSelectedTracker = discoverSelectedTracker === tracker.id ? null : tracker.id;
    if (discoverSelectedTracker !== null) discoverSelectedSource = "";
    resetTrackerCatalogState();
    catalogTrackingPickerOpen = false;
  }

  function dedupeTrackSearches(items: TrackSearch[]) {
    const seen = new Set<string>();
    const next: TrackSearch[] = [];
    for (const item of items) {
      const key = item.remoteId || `${item.trackerId}:${item.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(item);
    }
    return next;
  }

  function trackerProviderKind(tracker: BrowseTrackerEntry) {
    const name = tracker.name.toLowerCase();
    if (name.includes("anilist")) return "anilist";
    if (name.includes("myanimelist") || name === "mal") return "mal";
    return "generic";
  }

  function anilistSortForFeed() {
    if (catalogFeed === "popular") return ["POPULARITY_DESC"];
    if (catalogFeed === "latest") return ["START_DATE_DESC"];
    return ["TRENDING_DESC", "POPULARITY_DESC"];
  }

  async function fetchAniListTrackerCatalog(tracker: BrowseTrackerEntry, page: number) {
    const adultFilter = includeNsfwSources ? "" : ", isAdult: false";
    const query = `
      query BrowseTrackerCatalog($page: Int!, $perPage: Int!, $sort: [MediaSort]) {
        Page(page: $page, perPage: $perPage) {
          media(type: MANGA, sort: $sort${adultFilter}) {
            id
            title { romaji english native }
            coverImage { large extraLarge }
            siteUrl
            status
            format
            chapters
            startDate { year month day }
          }
        }
      }
    `;
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query,
        variables: {
          page,
          perPage: TRACKER_CATALOG_PAGE_SIZE,
          sort: anilistSortForFeed(),
        },
      }),
    });
    if (!response.ok) throw new Error(`AniList catalog failed (${response.status})`);
    const data = await response.json();
    const media = data?.data?.Page?.media ?? [];
    return media.map((item: any) => ({
      id: Number(item.id),
      trackerId: tracker.id,
      remoteId: String(item.id),
      title: item.title?.english ?? item.title?.romaji ?? item.title?.native ?? "Untitled",
      coverUrl: item.coverImage?.extraLarge ?? item.coverImage?.large ?? null,
      summary: null,
      publishingStatus: item.status ?? null,
      publishingType: item.format ?? null,
      startDate: item.startDate?.year
        ? `${item.startDate.year}-${String(item.startDate.month ?? 1).padStart(2, "0")}-${String(item.startDate.day ?? 1).padStart(2, "0")}`
        : null,
      totalChapters: item.chapters ?? 0,
      trackingUrl: item.siteUrl ?? null,
    })) as TrackSearch[];
  }

  async function fetchMalTrackerCatalog(tracker: BrowseTrackerEntry, page: number) {
    const url = catalogFeed === "latest"
      ? `https://api.jikan.moe/v4/manga?page=${page}&limit=${TRACKER_CATALOG_PAGE_SIZE}&order_by=start_date&sort=desc`
      : `https://api.jikan.moe/v4/top/manga?page=${page}&limit=${TRACKER_CATALOG_PAGE_SIZE}${catalogFeed === "popular" ? "&filter=bypopularity" : ""}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`MyAnimeList catalog failed (${response.status})`);
    const data = await response.json();
    const items = (data?.data ?? []).filter((item: any) => item.mal_id && item.type !== "Anime");
    return items.map((item: any) => ({
      id: Number(item.mal_id),
      trackerId: tracker.id,
      remoteId: String(item.mal_id),
      title: item.title_english ?? item.title ?? item.title_japanese ?? "Untitled",
      coverUrl: item.images?.webp?.large_image_url ?? item.images?.jpg?.large_image_url ?? item.images?.jpg?.image_url ?? null,
      summary: item.synopsis ?? null,
      publishingStatus: item.status ?? null,
      publishingType: item.type ?? null,
      startDate: item.published?.from ?? null,
      totalChapters: item.chapters ?? 0,
      trackingUrl: item.url ?? `https://myanimelist.net/manga/${item.mal_id}`,
    })) as TrackSearch[];
  }

  async function fetchGenericTrackerCatalog(tracker: BrowseTrackerEntry, page: number) {
    const query = catalogFeed === "latest" ? "latest manga" : catalogFeed === "popular" ? "popular manga" : "manga";
    const d = await gql<{ searchTracker: { trackSearches: TrackSearch[] } }>(
      SEARCH_TRACKER,
      { trackerId: tracker.id, query: page === 1 ? query : `${query} ${page}` },
    );
    return d.searchTracker.trackSearches ?? [];
  }

  async function fetchTrackerCatalogPage(tracker: BrowseTrackerEntry, page: number) {
    const provider = trackerProviderKind(tracker);
    if (provider === "anilist") return fetchAniListTrackerCatalog(tracker, page);
    if (provider === "mal") return fetchMalTrackerCatalog(tracker, page);
    return fetchGenericTrackerCatalog(tracker, page);
  }

  async function loadTrackerCatalogFeed(key: string) {
    const tracker = discoverFocusedTracker;
    if (!tracker) return;

    trackerCatalogLoadedKey = key;
    trackerCatalogLoading = true;
    trackerCatalogLoadingMore = false;
    trackerCatalogError = "";
    trackerCatalogResults = [];
    trackerCatalogPage = 1;

    try {
      const incoming = await fetchTrackerCatalogPage(tracker, 1);
      if (trackerCatalogLoadedKey !== key) return;
      trackerCatalogResults = dedupeTrackSearches(incoming);
    } catch (error) {
      if (trackerCatalogLoadedKey !== key) return;
      trackerCatalogError = error instanceof Error ? error.message : "Could not load tracker catalog.";
    } finally {
      if (trackerCatalogLoadedKey === key) trackerCatalogLoading = false;
    }
  }

  async function loadTrackerCatalogMore() {
    const tracker = discoverFocusedTracker;
    if (!tracker || trackerCatalogLoading || trackerCatalogLoadingMore) return;

    const nextPage = trackerCatalogPage + 1;
    trackerCatalogLoadingMore = true;
    try {
      const incoming = await fetchTrackerCatalogPage(tracker, nextPage);
      trackerCatalogResults = dedupeTrackSearches([...trackerCatalogResults, ...incoming]);
      if (incoming.length > 0) trackerCatalogPage = nextPage;
    } catch (error) {
      console.error(error);
    } finally {
      trackerCatalogLoadingMore = false;
    }
  }

  async function loadDiscoverFeed(key: string) {
    discoverAbortCtrl?.abort();
    const ctrl = new AbortController();
    discoverAbortCtrl = ctrl;
    discoverLoadedKey = key;
    discoverLoading = true;
    discoverError = "";
    discoverMangaResults = [];
    discoverNovelResults = [];
    discoverCurrentPage = 1;
    discoverHasNextPage = false;
    discoverLoadingMore = false;

    try {
      if (activeContentType === "novels") {
        const settled = await Promise.allSettled(discoverFeedSources.map(async (entry) => {
          if (!entry.novelSource || ctrl.signal.aborted) return [] as NovelSourceSearchResult[];
          return browseInstalledNovelSource({
            profileId: store.runtimeResolvedLocalProfileId,
            serverUrl: store.runtimeServerUrl,
          }, entry.novelSource.pluginId, 1);
        }));
        const results = settled.flatMap((result) =>
          result.status === "fulfilled" ? result.value : [],
        );
        if (discoverLoadedKey !== key) return;
        discoverNovelResults = results.slice(0, 48);
        discoverHasNextPage = results.length > 0;
        return;
      }

      const fetchType = catalogFeed === "latest" ? "LATEST" : "POPULAR";
      const fallbackTerms = catalogFeed === "latest"
        ? ["new", "latest", "chapter", "update"]
        : ["action", "romance", "fantasy", "adventure"];
      const settled = await Promise.allSettled(discoverFeedSources.map(async (entry) => {
        if (!entry.mangaSource || ctrl.signal.aborted) return [] as Manga[];
        try {
          const d = await gql<{ fetchSourceManga: { mangas: Manga[]; hasNextPage: boolean } }>(
            FETCH_SOURCE_MANGA,
            { source: entry.mangaSource.id, type: fetchType, page: 1, query: null },
            ctrl.signal,
          );
          const popular = d.fetchSourceManga.mangas.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings));
          if (popular.length > 0) {
            return popular;
          }
        } catch (error) {
          if (ctrl.signal.aborted) return [] as Manga[];
          console.warn(`Discover ${fetchType} failed for ${entry.displayName}; trying keyword fallback.`, error);
        }

        for (const term of fallbackTerms) {
          if (ctrl.signal.aborted) return [] as Manga[];
          const fallback = await fetchSourceMangaSearchWithFallback({
            sourceId: entry.mangaSource.id,
            query: term,
            signal: ctrl.signal,
          });
          const visible = fallback.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings));
          if (visible.length > 0) {
            return visible;
          }
        }
        return [] as Manga[];
      }));
      const results = settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      if (discoverLoadedKey !== key) return;
      discoverMangaResults = dedupeMangaByTitle(dedupeMangaById(results), store.settings.mangaLinks).slice(0, 48);
      discoverHasNextPage = settled.some((result) =>
        result.status === "fulfilled" && result.value.length > 0,
      );
      const failures = settled.filter((result) => result.status === "rejected");
      if (discoverMangaResults.length === 0 && failures.length > 0) {
        const firstFailure = failures[0] as PromiseRejectedResult;
        discoverError = firstFailure.reason instanceof Error
          ? firstFailure.reason.message
          : "Could not load discovery results.";
      }
    } catch (error) {
      if (discoverLoadedKey !== key) return;
      discoverError = error instanceof Error ? error.message : "Could not load discovery results.";
    } finally {
      if (discoverLoadedKey === key && discoverAbortCtrl === ctrl) discoverLoading = false;
      if (activeContentType === "novels") {
        void shutdownInstalledNovelSourcesRuntime().catch(() => {});
      }
    }
  }

  async function loadDiscoverMore() {
    if (discoverFocusedTracker || discoverLoadingMore || discoverLoading || !discoverHasNextPage || discoverFeedSources.length === 0) return;
    const page = discoverCurrentPage + 1;
    const key = discoverLoadedKey;
    discoverLoadingMore = true;
    try {
      if (activeContentType === "novels") {
        const settled = await Promise.allSettled(discoverFeedSources.map(async (entry) => {
          if (!entry.novelSource) return [] as NovelSourceSearchResult[];
          return browseInstalledNovelSource({
            profileId: store.runtimeResolvedLocalProfileId,
            serverUrl: store.runtimeServerUrl,
          }, entry.novelSource.pluginId, page);
        }));
        if (discoverLoadedKey !== key) return;
        const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
        discoverNovelResults = [...discoverNovelResults, ...incoming];
        discoverCurrentPage = page;
        discoverHasNextPage = incoming.length > 0;
        return;
      }

      const fetchType = catalogFeed === "latest" ? "LATEST" : "POPULAR";
      const settled = await Promise.allSettled(discoverFeedSources.map(async (entry) => {
        if (!entry.mangaSource) return { mangas: [] as Manga[], hasNextPage: false };
        const d = await gql<{ fetchSourceManga: { mangas: Manga[]; hasNextPage: boolean } }>(
          FETCH_SOURCE_MANGA,
          { source: entry.mangaSource.id, type: fetchType, page, query: null },
        );
        return {
          mangas: d.fetchSourceManga.mangas.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings)),
          hasNextPage: d.fetchSourceManga.hasNextPage,
        };
      }));
      if (discoverLoadedKey !== key) return;
      const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value.mangas : []);
      discoverMangaResults = dedupeMangaByTitle(
        dedupeMangaById([...discoverMangaResults, ...incoming]),
        store.settings.mangaLinks,
      );
      discoverCurrentPage = page;
      discoverHasNextPage = settled.some((result) => result.status === "fulfilled" && result.value.hasNextPage);
    } catch (error) {
      console.error(error);
    } finally {
      discoverLoadingMore = false;
      if (activeContentType === "novels") {
        void shutdownInstalledNovelSourcesRuntime().catch(() => {});
      }
    }
  }

  $effect(() => {
    const key = [
      activeBrowseTab,
      activeContentType,
      catalogFeed,
      includeNsfwSources ? "nsfw" : "safe",
      src_selectedLang,
      discoverSelectedSource,
      discoverSelectedTracker ?? "all-tracking",
      discoverFeedSources.map((source) => source.id).join(","),
      tag_activeTags.join(","),
    ].join("|");

    if (activeBrowseTab !== "browse" || tag_hasActiveTags || discoverFocusedTracker || discoverFeedSources.length === 0) return;
    if (discoverLoadedKey === key) return;
    void loadDiscoverFeed(key);
  });

  $effect(() => {
    const key = [
      activeBrowseTab,
      activeContentType,
      catalogFeed,
      includeNsfwSources ? "nsfw" : "safe",
      discoverSelectedTracker ?? "all-tracking",
    ].join("|");

    if (activeBrowseTab !== "browse" || tag_hasActiveTags || !discoverFocusedTracker) return;
    if (trackerCatalogLoadedKey === key) return;
    void loadTrackerCatalogFeed(key);
  });

  $effect(() => {
    if (genreMode !== tag_tagMode) {
      tag_tagMode = genreMode;
    }
  });

  $effect(() => {
    if (tag_tagMode !== genreMode) {
      genreMode = tag_tagMode;
    }
  });

  $effect(() => {
    if (selectedGenres !== tag_activeTags) {
      selectedGenres = tag_activeTags;
    }
  });
  const src_hiddenByLanguageCount = $derived(
    src_selectedLang === "all"
      ? 0
      : kw_contentVisibleSources.filter((source) => source.lang !== src_selectedLang).length,
  );
  async function srcFetchBrowse(src: Source, type: "POPULAR" | "SEARCH", q?: string, page = 1) {
    src_abortCtrl?.abort();
    const ctrl = new AbortController();
    src_abortCtrl = ctrl;
    src_loadingBrowse = true;
    if (page === 1) { src_browseResults = []; }
    try {
      const d = await gql<{ fetchSourceManga: { mangas: Manga[]; hasNextPage: boolean } }>(
        FETCH_SOURCE_MANGA, { source: src.id, type, page, query: q ?? null }, ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      const incoming = d.fetchSourceManga.mangas.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings));
      src_browseResults = page === 1 ? incoming : [...src_browseResults, ...incoming];
      src_hasNextPage = d.fetchSourceManga.hasNextPage;
      src_currentPage = page;
    } catch (e: any) {
      if (e?.name !== "AbortError") console.error(e);
    } finally {
      if (!ctrl.signal.aborted) src_loadingBrowse = false;
    }
  }

  function srcSelectSource(src: Source | BrowseSourceEntry) {
    if ("contentKind" in src) {
      srcSelectBrowseSource(src);
      return;
    }
    src_activeSource = src; src_browseQuery = ""; src_submitted = "";
    src_activeNovelSource = null;
    src_novelBrowseResults = [];
    selectedSource = src.id;
    srcFetchBrowse(src, "POPULAR");
  }

  async function srcFetchNovelBrowse(src: InstalledNovelSourceDescriptor, type: "POPULAR" | "SEARCH", q?: string, page = 1) {
    src_abortCtrl?.abort();
    const ctrl = new AbortController();
    src_abortCtrl = ctrl;
    src_loadingBrowse = true;
    if (page === 1) {
      src_novelBrowseResults = [];
    }
    try {
      const incoming = type === "SEARCH" && q
        ? await searchInstalledNovelSource({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        }, src.pluginId, q, page)
        : await browseInstalledNovelSource({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        }, src.pluginId, page);
      if (ctrl.signal.aborted) return;
      src_novelBrowseResults = page === 1 ? incoming : [...src_novelBrowseResults, ...incoming];
      src_hasNextPage = incoming.length > 0;
      src_currentPage = page;
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== "AbortError") console.error(e);
    } finally {
      await shutdownInstalledNovelSourcesRuntime().catch(() => {});
      if (!ctrl.signal.aborted) src_loadingBrowse = false;
    }
  }

  function srcSelectBrowseSource(entry: BrowseSourceEntry) {
    if (entry.contentKind === "novels" && entry.novelSource) {
      src_activeSource = null;
      src_activeNovelSource = entry.novelSource;
      src_browseResults = [];
      src_browseQuery = "";
      src_submitted = "";
      selectedSource = entry.id;
      void srcFetchNovelBrowse(entry.novelSource, "POPULAR");
      return;
    }
    if (entry.mangaSource) {
      srcSelectSource(entry.mangaSource);
    }
  }

  function srcHandleSearch() {
    if ((!src_activeSource && !src_activeNovelSource) || !src_browseQuery.trim()) return;
    src_submitted = src_browseQuery.trim();
    if (src_activeSource) {
      srcFetchBrowse(src_activeSource, "SEARCH", src_browseQuery.trim());
      return;
    }
    if (src_activeNovelSource) {
      void srcFetchNovelBrowse(src_activeNovelSource, "SEARCH", src_browseQuery.trim());
    }
  }

  function srcClearSearch() {
    src_browseQuery = ""; src_submitted = "";
    if (src_activeSource) srcFetchBrowse(src_activeSource, "POPULAR");
    if (src_activeNovelSource) void srcFetchNovelBrowse(src_activeNovelSource, "POPULAR");
  }

  async function srcOpenNovelDetail(result: NovelSourceSearchResult) {
    if (!src_activeNovelSource) return;
    src_openingNovelPath = result.path;
    try {
      const detail = await readInstalledNovelDetails({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }, src_activeNovelSource.pluginId, result.path, {
        title: result.title,
        coverUrl: result.coverUrl,
      });
      setActiveNovelDetail({
        novel: detail,
        inLibrary: novelLibraryState ? isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path)) : false,
      });
    } catch (error) {
      addToast({
        kind: "error",
        title: "Could not open novel details",
        body: error instanceof Error ? error.message : "Aethon couldn't open this novel.",
      });
    } finally {
      src_openingNovelPath = null;
    }
  }

  $effect(() => {
    const nextId = src_activeSource?.id ?? src_activeNovelSource?.pluginId ?? "";
    if (selectedSource !== nextId) {
      selectedSource = nextId;
    }
  });

  onDestroy(() => {
    kw_abortCtrl?.abort();
    tag_abortLocal?.abort();
    tag_abortSource?.abort();
    src_abortCtrl?.abort();
    void shutdownInstalledNovelSourcesRuntime();
    document.body.classList.remove("aethon-browse-search-engaged");
  });
</script>

<div class="root" class:is-search-engaged={browseSearchFocused}>
  <AppTopbar className="browse-topbar">
    {#snippet left()}
      <nav class="n-segmented" data-active={activeContentType === "novels" ? "novels" : "manga"} aria-label="Content type">
        <span class="n-segmented__thumb" aria-hidden="true"></span>
        <button
          type="button"
          class="n-segmented__btn"
          class:is-active={activeContentType === "manga"}
          onclick={() => selectContentType("manga")}
        >
          Manga
        </button>
        <button
          type="button"
          class="n-segmented__btn"
          class:is-active={activeContentType === "novels"}
          onclick={() => selectContentType("novels")}
        >
          Novels
        </button>
      </nav>
    {/snippet}

    {#snippet center()}
      <div class="browse-topbar__center">
        <div class="n-search n-search--browse">
          <span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>
          <input
            bind:value={searchQuery}
            class="n-search__input"
            placeholder={activeContentType === "novels" ? "Search installed novel sources..." : "Search sources..."}
            onfocus={handleBrowseSearchFocus}
            onblur={handleBrowseSearchBlur}
            onkeydown={(event) => event.key === "Enter" && handleSearch(searchQuery)}
          />
        </div>
      </div>
    {/snippet}

    {#snippet right()}
      <div class="browse-topbar__right">
        <WindowControlsInline />
      </div>
    {/snippet}
  </AppTopbar>

  <div class="browseSubtabs">
    <button class="browseSubtab" class:browseSubtabActive={activeBrowseTab === "keyword"} onclick={() => selectBrowseTab("keyword")}>
      Search
    </button>
    <button class="browseSubtab" class:browseSubtabActive={activeBrowseTab === "browse"} onclick={() => selectBrowseTab("browse")}>
      Discover
    </button>
    <button class="browseSubtab" class:browseSubtabActive={activeBrowseTab === "source"} onclick={() => selectBrowseTab("source")}>
      Sources
    </button>
  </div>

  {#if setupState && setupState.kind !== "ready"}
    <div class="setup-banner">
      <SetupStatusCard
        state={setupState}
        surface="search"
        actionBusy={setupActionBusy}
        onAddRecommendedRepo={addRecommendedRepo}
        onAddManually={openRepoManagerFlow}
        onOpenExtensions={() => { activeBrowseTab = "source"; }}
        onRetry={refreshSetupState}
      />
    </div>
  {/if}

  {#if activeBrowseTab === "keyword"}
    <div class="keywordBar">
      <div class="searchBar">
        <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" class="searchIcon" aria-hidden="true">
          <path d="M229.66,218.34l-50.07-50.07a88,88,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.31ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"/>
        </svg>
        
        <input
          bind:this={kw_inputEl}
          bind:value={kw_query}
          use:focusOnMount
          class="searchInput"
          placeholder="Search across sources…"
          onkeydown={(e) => e.key === "Enter" && kwDoSearch(kw_query)}
        />
        {#if kw_query}
          <button
            class="clearBtn"
            title="Clear"
            onclick={() => { kw_query = ""; kw_inputEl?.focus(); }}
          >×</button>
        {/if}
        {#if hasMultipleLangs}
          <button
            class="advancedBtn"
            class:advancedBtnActive={kw_showAdvanced}
            title="Language & filter options"
            onclick={() => (kw_showAdvanced = !kw_showAdvanced)}
          >
            
            <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M40,88H73a32,32,0,0,0,62,0h81a8,8,0,0,0,0-16H135a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16Zm64-24A16,16,0,1,1,88,80,16,16,0,0,1,104,64ZM216,168H183a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16h81a32,32,0,0,0,62,0h33a8,8,0,0,0,0-16Zm-64,24a16,16,0,1,1,16-16A16,16,0,0,1,152,192Z"/>
            </svg>
          </button>
        {/if}
        <button
          class="searchBtn"
          onclick={() => kwDoSearch(kw_query)}
          disabled={!kw_query.trim() || loadingSources || setupLoading || !setupReady}
        >
          {#if loadingSources}
            <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" aria-hidden="true">
              <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
            </svg>
          {:else}
            Search
          {/if}
        </button>
      </div>

      {#if hasMultipleLangs && kw_showAdvanced}
        <div class="advancedPanel">
          <div class="advancedHeader">
            <span class="advancedTitle">Languages</span>
            <div class="advancedActions">
              <button class="advancedLink" onclick={() => (kw_selectedLangs = new Set(availableLangs))}>All</button>
              <button class="advancedLink" onclick={() => (kw_selectedLangs = new Set([preferredLang]))}>Reset</button>
            </div>
          </div>
          <div class="langGrid">
            {#each availableLangs as lang (lang)}
              <button
                class="langChip"
                class:langChipActive={kw_selectedLangs.has(lang)}
                onclick={() => kwToggleLang(lang)}
              >
                {lang === preferredLang ? `${lang.toUpperCase()} ★` : lang.toUpperCase()}
              </button>
            {/each}
          </div>
          <div class="advancedDivider"></div>
          <div class="advancedFooter">
            Searching <strong>{kw_visibleCount}</strong> source{kw_visibleCount !== 1 ? "s" : ""}
          </div>
        </div>
      {/if}

      {#if kw_showVisibilitySummary && kw_visibilitySummary}
        <section class="visibilityCard">
          <div class="visibilityCopy">
            <p class="visibilityLabel">Source visibility</p>
            <h2 class="visibilityTitle">{kw_visibilitySummary.title}</h2>
            <p class="visibilityBody">{kw_visibilitySummary.body}</p>
            <p class="visibilityNote">{kw_visibilitySummary.detail}</p>
          </div>
          <div class="visibilityActions">
            <button class="visibilityBtn" onclick={openSearchVisibilityFilters}>
              Review language filters
            </button>
            <button class="visibilityBtn visibilityBtnSecondary" onclick={() => (activeBrowseTab = "source")}>
              Open Sources tab
            </button>
            <button class="visibilityBtn visibilityBtnGhost" onclick={dismissSearchVisibilitySummary}>
              Dismiss
            </button>
          </div>
        </section>
      {/if}
    </div>

    {#if !kw_submitted}
      <div class="empty">
        <svg width="36" height="36" viewBox="0 0 256 256" fill="currentColor" class="emptyIcon" aria-hidden="true">
          <path d="M229.66,218.34l-50.07-50.07a88,88,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.31ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"/>
        </svg>
        <p class="emptyText">Search across sources</p>
        <p class="emptyHint">
          {#if hasMultipleLangs}
            {kw_visibleCount} source{kw_visibleCount !== 1 ? "s" : ""} · {kw_selectedLangs.size} language{kw_selectedLangs.size !== 1 ? "s" : ""}
          {:else}
            {kw_visibleCount} source{kw_visibleCount !== 1 ? "s" : ""}
          {/if}
        </p>
        {#if hasMultipleLangs && !kw_showAdvanced}
          <button class="advancedLinkStandalone" onclick={() => (kw_showAdvanced = true)}>
            <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M40,88H73a32,32,0,0,0,62,0h81a8,8,0,0,0,0-16H135a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16Zm64-24A16,16,0,1,1,88,80,16,16,0,0,1,104,64ZM216,168H183a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16h81a32,32,0,0,0,62,0h33a8,8,0,0,0,0-16Zm-64,24a16,16,0,1,1,16-16A16,16,0,0,1,152,192Z"/>
            </svg>
            Adjust language filters
          </button>
        {/if}
      </div>
    {:else}
      <div class="results">
        {#if kw_results.length === 0}
          <div class="empty">
            <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint)" aria-hidden="true">
              <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
            </svg>
          </div>
        {/if}

        {#each kw_results.filter((r) => r.mangas.length > 0 || r.loading || r.error) as { source, mangas, loading, error } (source.id)}
          <div class="sourceSection">
            <div class="sourceHeader">
              <img
                src={thumbUrl(source.iconUrl)}
                alt={source.displayName}
                class="sourceIcon"
                loading="lazy"
                decoding="async"
                onerror={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
              <span class="sourceName">{source.displayName}</span>
              {#if hasMultipleLangs}
                <span class="sourceLang">{source.lang.toUpperCase()}</span>
              {/if}
              {#if loading}
                <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint);margin-left:auto" aria-hidden="true">
                  <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
                </svg>
              {:else if mangas.length > 0}
                <span class="resultCount">{mangas.length} results</span>
              {/if}
            </div>

            {#if error}
              <p class="sourceError">{error}</p>
            {:else if loading}
              
              <div class="sourceRow">
                {#each Array(4) as _, i (i)}
                  <div class="skCard">
                    <div class="skeleton skCover"></div>
                    <div class="skeleton skTitle"></div>
                  </div>
                {/each}
              </div>
            {:else if mangas.length > 0}
              <div class="sourceRow">
                {#each mangas.filter(shouldShowCatalogManga).slice(0, (store.settings.renderLimit ?? 48)) as m (m.id)}
                  <button class="n-library-card" onclick={() => setPreviewManga(m)}>
                    <div class="n-library-card__cover">
                      <img
                        src={thumbUrl(m.thumbnailUrl)}
                        alt={m.title}
                        loading="lazy"
                        decoding="async"
                      />
                      {#if m.inLibrary}<span class="n-library-card__badge">In Library</span>{/if}
                    </div>
                    <div class="n-library-card__info">
                      <p class="n-library-card__title">{m.title}</p>
                      <div class="n-library-card__meta">
                        <span class="n-library-card__author">{m.source?.displayName ?? "Browse"}</span>
                        <span class="n-library-card__vol">{m.chapterCount ? `CH ${m.chapterCount}` : m.status ?? ""}</span>
                      </div>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/each}

        {#if kw_allDone && !kw_hasResults}
          <div class="empty">
            <p class="emptyText">No results for "{kw_submitted}"</p>
            <p class="emptyHint">Try a different spelling or fewer words</p>
          </div>
        {/if}
      </div>
    {/if}

  

  {:else if activeBrowseTab === "browse"}
    <div class="browseShell">
      <div class="catalogShell">
    <div class="splitRoot catalogRoot">

      <div class="splitSidebar catalogSidebar">
        <section class="browseFilterSection browseFilterCard">
          <div class="browseCardHeader">
            <h3 class="browseCardTitle">Filters</h3>
            <button class="browseResetButton" type="button" onclick={resetBrowseSidebarFilters}>
              Reset
              <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
            </button>
          </div>
          <div class="browseField">
            <p class="browseFieldLabel">Status</p>
            <div class="browseSegment">
              <button class:is-active={catalogFeed === "all"} onclick={() => selectCatalogFeed("all")}>All</button>
              <button class:is-active={catalogFeed === "popular"} onclick={() => selectCatalogFeed("popular")}>Popular</button>
              <button class:is-active={catalogFeed === "latest"} onclick={() => selectCatalogFeed("latest")}>Latest</button>
            </div>
          </div>
          <div class="browseField browsePickerField browseLanguageField">
            <p class="browseFieldLabel">Language</p>
            <button class="browseSelectRow" class:is-open={catalogLanguagePickerOpen} type="button" onclick={() => { catalogLanguagePickerOpen = !catalogLanguagePickerOpen; catalogSourcePickerOpen = false; catalogTrackingPickerOpen = false; }}>
              <span>{src_selectedLang === "all" ? "All languages" : src_selectedLang.toUpperCase()}</span>
              <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
            </button>
            {#if catalogLanguagePickerOpen}
              <div class="browseInlinePicker browseLanguagePicker">
                {#if src_selectedLang !== "all"}
                  <button onclick={() => { src_selectedLang = "all"; catalogLanguagePickerOpen = false; }}>All languages</button>
                {/if}
                {#each src_availableLangs.filter((lang) => lang !== src_selectedLang) as lang (lang)}
                  <button onclick={() => { src_selectedLang = lang; catalogLanguagePickerOpen = false; }}>{lang.toUpperCase()}</button>
                {/each}
              </div>
            {/if}
          </div>
          <div class="browseField browsePickerField browseSourceField">
            <p class="browseFieldLabel">Source</p>
            <button class="browseSelectRow" class:is-open={catalogSourcePickerOpen} class:is-paused={!!discoverFocusedTracker} type="button" onclick={() => { if (discoverFocusedTracker) return; catalogSourcePickerOpen = !catalogSourcePickerOpen; catalogLanguagePickerOpen = false; catalogTrackingPickerOpen = false; }}>
              <span>{discoverFocusedTracker ? "Using tracking catalog" : discoverFocusedSource ? sourceNameWithoutLanguage(discoverFocusedSource) : "All sources"}</span>
              <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
            </button>
            {#if catalogSourcePickerOpen}
              <div class="browseInlinePicker browseSourcePicker">
                {#if discoverSelectedSource}
                  <button onclick={() => { discoverSelectedSource = ""; catalogSourcePickerOpen = false; }}>
                    <span>All sources</span>
                    <span>ALL</span>
                  </button>
                {/if}
                {#each src_visibleSources.filter((src) => src.id !== discoverSelectedSource) as src (src.id)}
                  <button onclick={() => selectDiscoverSourceFilter(src)}>
                    <span>{sourceNameWithoutLanguage(src)}</span>
                    <span>{src.lang.toUpperCase()}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
          <div class="browseField browsePickerField browseTrackingField">
            <p class="browseFieldLabel">Tracking</p>
            <button class="browseSelectRow" class:is-open={catalogTrackingPickerOpen} type="button" onclick={() => { catalogTrackingPickerOpen = !catalogTrackingPickerOpen; catalogLanguagePickerOpen = false; catalogSourcePickerOpen = false; }}>
              <span>{discoverFocusedTracker?.name ?? "Off"}</span>
              <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
            </button>
            <p class="browseFieldHint">{discoverFocusedTracker ? "Browsing this tracker catalog instead of extension sources." : "Turn on a tracker catalog when you want AniList/MAL discovery."}</p>
            {#if catalogTrackingPickerOpen}
              <div class="browseInlinePicker browseTrackingPicker">
                {#if discoverSelectedTracker !== null}
                  <button onclick={() => { discoverSelectedTracker = null; catalogTrackingPickerOpen = false; }}>
                    <span>Tracking off</span>
                    <span>OFF</span>
                  </button>
                {/if}
                {#if loadingTrackers}
                  <button disabled>
                    <span>Loading tracking...</span>
                    <span></span>
                  </button>
                {:else if trackingFilterOptions.length === 0}
                  <button disabled>
                    <span>No tracking ready</span>
                    <span></span>
                  </button>
                {:else}
                  {#each trackingFilterOptions.filter((tracker) => tracker.id !== discoverSelectedTracker) as tracker (tracker.id)}
                    <button onclick={() => selectDiscoverTrackerFilter(tracker)}>
                      <span>{tracker.name}</span>
                      <span>ON</span>
                    </button>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
          <button
            class="browseToggleRow"
            class:is-active={includeNsfwSources}
            type="button"
            aria-pressed={includeNsfwSources}
            onclick={toggleIncludeNsfwSources}
          >
            <span>Include NSFW extensions</span>
            <span class="browseSwitch" aria-hidden="true"></span>
          </button>
          <button
            class="browseToggleRow"
            class:is-active={includeInLibrary}
            type="button"
            aria-pressed={includeInLibrary}
            onclick={() => (includeInLibrary = !includeInLibrary)}
          >
            <span>Include In Library</span>
            <span class="browseSwitch" aria-hidden="true"></span>
          </button>
        </section>

        <section class="browseFilterSection browseGenresSection">
          <div class="browseSectionHeader">
            <h3 class="browseCardTitle">Genres</h3>
          </div>
          <div class="browseSectionBody">
            <div class="splitSearchWrap catalogSearchWrap">
          <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" class="splitSearchIcon" aria-hidden="true">
            <path d="M229.66,218.34l-50.07-50.07a88,88,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.31ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"/>
          </svg>
          <input
            bind:value={tag_tagFilter}
            class="splitSearchInput"
            placeholder="Filter genres..."
          />
          {#if tag_tagFilter}
            <button class="splitSearchClear" title="Clear" onclick={() => (tag_tagFilter = "")}>×</button>
          {/if}
            </div>
            <div class="catalogTagList">
          {#each tag_filteredGenres as tag (tag)}
            <button
              class="catalogOption"
              class:catalogOptionActive={tag_activeTags.includes(tag)}
              onclick={() => tagToggleTag(tag)}
            >
              <span>{tag}</span>
              {#if tag_activeTags.includes(tag)}<span class="tagCheckMark">✓</span>{/if}
            </button>
          {/each}
          {#if tag_filteredGenres.length === 0}
            <p class="splitEmpty">No matching genres</p>
          {/if}
            </div>
          </div>
        </section>

        {#if showBrowseVisibilityCard}
          <div class="browseVisibility">
            <span class="material-symbols-outlined browseVisibilityIcon" aria-hidden="true">visibility_off</span>
            <div>
              <p class="browseVisibilityLabel">Visibility Filter</p>
              <p class="browseVisibilityBody">Some titles hidden by safety preferences.</p>
            </div>
          </div>
        {/if}
      </div>

      
      <div class="splitContent">
        {#if src_activeSource || src_activeNovelSource}
          <div class="splitContentHeader">
            <div class="splitSourceTitle">
              {#if src_activeSource}
                <img
                  src={thumbUrl(src_activeSource.iconUrl)}
                  alt=""
                  class="splitSourceIcon"
                  loading="lazy"
                  decoding="async"
                  onerror={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <span class="splitContentTitle">{src_activeSource.displayName}</span>
                {#if src_activeSource.isNsfw}<span class="nsfwBadge">18+</span>{/if}
              {:else if src_activeNovelSource}
                {#if src_activeNovelSource.iconUrl}
                  <img
                    src={thumbUrl(src_activeNovelSource.iconUrl)}
                    alt=""
                    class="splitSourceIcon"
                    loading="lazy"
                    decoding="async"
                    onerror={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                {/if}
                <span class="splitContentTitle">{src_activeNovelSource.name}</span>
              {/if}
              {#if src_loadingBrowse}
                <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint)" aria-hidden="true">
                  <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
                </svg>
              {:else if src_activeSource && src_browseResults.length > 0}
                <span class="splitResultCount">{src_browseResults.length} results</span>
              {:else if src_activeNovelSource && src_novelBrowseResults.length > 0}
                <span class="splitResultCount">{src_novelBrowseResults.length} results</span>
              {/if}
            </div>
          </div>

          <div class="sourceBrowseBar">
            <div class="searchBar" style="flex:1">
              <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" class="searchIcon" aria-hidden="true">
                <path d="M229.66,218.34l-50.07-50.07a88,88,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.31ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"/>
              </svg>
              <input
                bind:value={src_browseQuery}
                class="searchInput"
                placeholder={src_activeSource ? `Search ${src_activeSource.displayName}…` : src_activeNovelSource ? `Search ${src_activeNovelSource.name}…` : "Search source…"}
                onkeydown={(e) => e.key === "Enter" && srcHandleSearch()}
              />
              {#if src_submitted}
                <button class="clearBtn" title="Clear search" onclick={srcClearSearch}>×</button>
              {/if}
            </div>
            <button
              class="searchBtn"
              onclick={srcHandleSearch}
              disabled={!src_browseQuery.trim() || src_loadingBrowse}
            >
              Search
            </button>
          </div>

          {#if src_loadingBrowse && src_browseResults.length === 0 && src_novelBrowseResults.length === 0}
            <div class="tagGrid" onscroll={handleCatalogGridScroll}>
              {#each Array(18) as _, i (i)}
                <div class="skCard">
                  <div class="skeleton skCover"></div>
                  <div class="skeleton skTitle"></div>
                </div>
              {/each}
            </div>
          {:else if src_activeSource && src_browseResults.length > 0}
            <div class="tagGrid" onscroll={handleCatalogGridScroll}>
              {#each src_browseResults.filter(shouldShowCatalogManga) as m (m.id)}
                <button class="n-library-card" onclick={() => setPreviewManga(m)}>
                  <div class="n-library-card__cover">
                    <img src={thumbUrl(m.thumbnailUrl)} alt={m.title} loading="lazy" decoding="async" />
                    {#if m.inLibrary}<span class="n-library-card__badge">In Library</span>{/if}
                  </div>
                  <div class="n-library-card__info">
                    <p class="n-library-card__title">{m.title}</p>
                    <div class="n-library-card__meta">
                      <span class="n-library-card__author">{m.source?.displayName ?? src_activeSource?.displayName ?? "Source"}</span>
                      <span class="n-library-card__vol">{m.chapterCount ? `CH ${m.chapterCount}` : m.status ?? ""}</span>
                    </div>
                  </div>
                </button>
              {/each}
            </div>
            {#if src_hasNextPage}
              <div class="loadMoreRow">
                <button
                  class="showMoreBtn"
                  disabled={src_loadingBrowse}
                  onclick={() => src_activeSource && srcFetchBrowse(
                    src_activeSource,
                    src_submitted ? "SEARCH" : "POPULAR",
                    src_submitted || undefined,
                    src_currentPage + 1,
                  )}
                >
                  {#if src_loadingBrowse}Loading…{:else}Load more{/if}
                </button>
              </div>
            {/if}
          {:else if src_activeNovelSource && src_novelBrowseResults.length > 0}
            <div class="tagGrid" onscroll={handleCatalogGridScroll}>
              {#each src_novelBrowseResults as result (result.path)}
                <button class="n-library-card" disabled={src_openingNovelPath !== null} onclick={() => srcOpenNovelDetail(result)}>
                  <div class="n-library-card__cover">
                    {#if result.coverUrl}
                      <img src={thumbUrl(result.coverUrl)} alt={result.title} loading="lazy" decoding="async" />
                    {:else}
                      <div class="coverFallback">📘</div>
                    {/if}
                    {#if novelLibraryState && isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path))}
                      <span class="n-library-card__badge">In Library</span>
                    {/if}
                  </div>
                  <div class="n-library-card__info">
                    <p class="n-library-card__title">{result.title}</p>
                    <div class="n-library-card__meta">
                      <span class="n-library-card__author">{src_activeNovelSource.name}</span>
                      <span class="n-library-card__vol">{src_openingNovelPath === result.path ? "Opening…" : src_activeNovelSource.lang.toUpperCase()}</span>
                    </div>
                  </div>
                </button>
              {/each}
            </div>
            {#if src_hasNextPage}
              <div class="loadMoreRow">
                <button
                  class="showMoreBtn"
                  disabled={src_loadingBrowse}
                  onclick={() => src_activeNovelSource && srcFetchNovelBrowse(
                    src_activeNovelSource,
                    src_submitted ? "SEARCH" : "POPULAR",
                    src_submitted || undefined,
                    src_currentPage + 1,
                  )}
                >
                  {#if src_loadingBrowse}Loading…{:else}Load more{/if}
                </button>
              </div>
            {/if}
          {:else if !src_loadingBrowse}
            <div class="empty">
              <p class="emptyText">
                {src_submitted ? `No results for "${src_submitted}"` : "No results"}
              </p>
            </div>
          {/if}
        {:else}
          <section class="discoverPanel">
            <div class="splitContentHeader discoverPanelHeader">
              <div class="catalogHeaderCopy">
                <span class="n-eyebrow">Discover New Series</span>
                <p class="catalogSubtitle">
                  {#if tag_hasActiveTags}
                    {catalogActiveSummary} - Genres - Manga{#if tag_searchSources} - Sources enabled{/if}
                  {:else if discoverFocusedTracker}
                    {discoverFocusedTracker.name} - {catalogFeed === "latest" ? "Latest" : catalogFeed === "popular" ? "Popular" : "All"} - Manga catalog
                  {:else}
                  {discoverSourceLabel} · {catalogFeed === "latest" ? "Latest" : catalogFeed === "popular" ? "Popular" : "All"} · {activeContentType === "novels" ? "Novels" : "Manga"}
                  {/if}
                </p>
              </div>
              {#if tag_hasActiveTags ? (tag_loadingLocal || tag_loadingSourceSearch) : (discoverFocusedTracker ? trackerCatalogLoading : discoverLoading)}
                <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint)" aria-hidden="true">
                  <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
                </svg>
              {:else}
                <span class="catalogCountBadge">
                  {#if tag_hasActiveTags}
                    {tag_totalVisible}{tag_localHasNext || tag_sourceHasMore ? "+" : ""} titles
                  {:else if discoverFocusedTracker}
                    {discoverResultCount} titles
                  {:else}
                    {discoverResultCount}{discoverHasNextPage ? "+" : ""} titles
                  {/if}
                </span>
              {/if}
            </div>

            {#if tag_hasActiveTags && tag_loadingLocal}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each Array(18) as _, i (i)}
                  <div class="skCard">
                    <div class="skeleton skCover"></div>
                    <div class="skeleton skTitle"></div>
                  </div>
                {/each}
              </div>
            {:else if tag_hasActiveTags && tag_mergedResults.length > 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each tag_mergedResults.filter(shouldShowCatalogManga) as m (m.id)}
                  <button class="n-library-card" onclick={() => setPreviewManga(m)}>
                    <div class="n-library-card__cover">
                      <img src={thumbUrl(m.thumbnailUrl)} alt={m.title} loading="lazy" decoding="async" />
                      {#if m.inLibrary}<span class="n-library-card__badge">In Library</span>{/if}
                    </div>
                    <div class="n-library-card__info">
                      <p class="n-library-card__title">{m.title}</p>
                      <div class="n-library-card__meta">
                        <span class="n-library-card__author">{m.source?.displayName ?? "Browse"}</span>
                        <span class="n-library-card__vol">{m.chapterCount ? `CH ${m.chapterCount}` : m.status ?? ""}</span>
                      </div>
                    </div>
                  </button>
                {/each}
                {#if tag_loadingSourceSearch}
                  {#each Array(8) as _, i (i)}
                    <div class="skCard">
                      <div class="skeleton skCover"></div>
                      <div class="skeleton skTitle"></div>
                    </div>
                  {/each}
                {/if}
                {#if tag_loadingMoreLocal || tag_loadingMoreSource}
                  <div class="showMoreCell">
                    <span class="inlineLoading">Loading more...</span>
                  </div>
                {/if}
              </div>
            {:else if tag_hasActiveTags}
              <div class="empty">
                <p class="emptyText">Nothing found for this Discover view</p>
                <p class="emptyHint">Try another genre, source, or language.</p>
              </div>
            {:else if discoverFocusedTracker && trackerCatalogResults.length > 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each trackerCatalogResults as item (`${item.trackerId}:${item.remoteId}`)}
                  <a class="n-library-card" href={item.trackingUrl ?? undefined} target="_blank" rel="noreferrer">
                    <div class="n-library-card__cover">
                      {#if item.coverUrl}
                        <img src={thumbUrl(item.coverUrl)} alt={item.title} loading="lazy" decoding="async" />
                      {:else}
                        <div class="coverFallback">Manga</div>
                      {/if}
                    </div>
                    <div class="n-library-card__info">
                      <p class="n-library-card__title">{item.title}</p>
                      <div class="n-library-card__meta">
                        <span class="n-library-card__author">{discoverFocusedTracker.name}</span>
                        <span class="n-library-card__vol">{item.publishingStatus ?? item.publishingType ?? (item.totalChapters ? `${item.totalChapters} CH` : "Reading")}</span>
                      </div>
                    </div>
                  </a>
                {/each}
                {#if trackerCatalogLoadingMore}
                  <div class="showMoreCell">
                    <span class="inlineLoading">Loading more...</span>
                  </div>
                {/if}
              </div>
            {:else if discoverFocusedTracker && trackerCatalogError}
              <div class="empty">
                <p class="emptyText">Could not load tracker catalog</p>
                <p class="emptyHint">{trackerCatalogError}</p>
              </div>
            {:else if discoverFocusedTracker}
              <div class="empty">
                <p class="emptyText">No reading titles found</p>
                <p class="emptyHint">Try Popular, Latest, or another connected tracker.</p>
              </div>
            {:else if discoverLoading && discoverResultCount === 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each Array(18) as _, i (i)}
                  <div class="skCard">
                    <div class="skeleton skCover"></div>
                    <div class="skeleton skTitle"></div>
                  </div>
                {/each}
              </div>
            {:else if discoverError}
              <div class="empty">
                <p class="emptyText">Could not load Discover</p>
                <p class="emptyHint">{discoverError}</p>
              </div>
            {:else if activeContentType === "novels" && discoverNovelResults.length > 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each discoverNovelResults as result (`${result.sourceId}:${result.path}`)}
                  <button class="n-library-card" disabled={src_openingNovelPath !== null} onclick={() => srcOpenNovelDetail(result)}>
                    <div class="n-library-card__cover">
                      {#if result.coverUrl}
                        <img src={thumbUrl(result.coverUrl)} alt={result.title} loading="lazy" decoding="async" />
                      {:else}
                        <div class="coverFallback">Book</div>
                      {/if}
                      {#if novelLibraryState && isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path))}
                        <span class="n-library-card__badge">In Library</span>
                      {/if}
                    </div>
                    <div class="n-library-card__info">
                      <p class="n-library-card__title">{result.title}</p>
                      <div class="n-library-card__meta">
                        <span class="n-library-card__author">{discoverFocusedSource?.name ?? "Discover"}</span>
                        <span class="n-library-card__vol">{src_openingNovelPath === result.path ? "Opening..." : "Novel"}</span>
                      </div>
                    </div>
                  </button>
                {/each}
                {#if discoverLoadingMore}
                  <div class="showMoreCell">
                    <span class="inlineLoading">Loading more...</span>
                  </div>
                {/if}
              </div>
            {:else if activeContentType === "manga" && discoverMangaResults.length > 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each discoverMangaResults.filter(shouldShowCatalogManga) as m (m.id)}
                  <button class="n-library-card" onclick={() => setPreviewManga(m)}>
                    <div class="n-library-card__cover">
                      <img src={thumbUrl(m.thumbnailUrl)} alt={m.title} loading="lazy" decoding="async" />
                      {#if m.inLibrary}<span class="n-library-card__badge">In Library</span>{/if}
                    </div>
                    <div class="n-library-card__info">
                      <p class="n-library-card__title">{m.title}</p>
                      <div class="n-library-card__meta">
                        <span class="n-library-card__author">{m.source?.displayName ?? "Discover"}</span>
                        <span class="n-library-card__vol">{m.chapterCount ? `CH ${m.chapterCount}` : m.status ?? ""}</span>
                      </div>
                    </div>
                  </button>
                {/each}
                {#if discoverLoadingMore}
                  <div class="showMoreCell">
                    <span class="inlineLoading">Loading more...</span>
                  </div>
                {/if}
              </div>
            {:else}
              <div class="empty">
                <p class="emptyText">Nothing found for this Discover view</p>
                <p class="emptyHint">Try another source, language, or switch to Search for a keyword lookup.</p>
              </div>
            {/if}
          </section>
        {/if}
      </div>
    </div>
    </div>
    </div>

  {:else if activeBrowseTab === "source"}
    <div class="browseShell">
      <SourcesView contentType={activeContentType} />
    </div>
  {/if}
</div>

<style>
  .root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    animation: fadeIn 0.14s ease both;
    padding-top: var(--n-topbar-height);
  }
  .root :global(.browse-topbar) {
    display: grid;
    grid-template-columns:
      minmax(0, 1fr)
      minmax(calc(380px * var(--n-hud-scale)), calc(640px * var(--n-hud-scale)))
      minmax(0, 1fr);
    align-items: center;
    gap: calc(16px * var(--n-hud-scale));
  }
  .browse-topbar__center {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    width: 100%;
  }
  .browse-topbar__right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: calc(8px * var(--n-hud-scale));
    width: 100%;
    min-width: 0;
  }
  .root :global(.browse-topbar .n-search) {
    width: min(100%, var(--n-search-width));
    margin: 0;
  }
  .root.is-search-engaged :global(.browse-topbar .n-search),
  .root :global(.browse-topbar .n-search:focus-within) {
    width: min(100%, var(--n-search-width-focus));
  }
  .browseSubtabs {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: var(--sp-3) var(--sp-5) var(--sp-2);
    flex-shrink: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .browseSubtab {
    background: none;
    border: none;
    padding: 0;
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(202, 196, 208, 0.4);
    cursor: pointer;
    transition: color 180ms ease, opacity 180ms ease, border-color 180ms ease;
  }
  .browseSubtab:hover { color: rgba(229, 226, 225, 0.72); }
  .browseSubtabActive {
    color: var(--n-primary);
    padding-bottom: 2px;
    border-bottom: 1px solid var(--n-primary);
  }
  .setup-banner {
    padding: var(--sp-3) var(--sp-4) 0;
    flex-shrink: 0;
  }
  .catalogSidebar {
    width: calc(230px * var(--n-hud-scale));
    gap: calc(12px * var(--n-hud-scale));
    padding: calc(16px * var(--n-hud-scale)) calc(12px * var(--n-hud-scale));
    overflow-y: auto;
    overflow-x: hidden;
    border-right: 1px solid rgba(255, 255, 255, 0.05);
    background:
      linear-gradient(180deg, rgba(24, 22, 31, 0.58), rgba(12, 12, 16, 0.18)),
      rgba(13, 13, 18, 0.38);
    backdrop-filter: none;
  }
  .catalogSidebar.splitSidebar {
    overflow-y: auto;
    overflow-x: hidden;
  }
  .browseFilterSection {
    display: flex;
    flex-direction: column;
    gap: calc(10px * var(--n-hud-scale));
  }
  .catalogTagList {
    padding: var(--sp-2);
    gap: 4px;
    min-height: 0;
    flex: none;
    overflow: visible;
    display: flex;
    flex-wrap: wrap;
  }
  .browseVisibility {
    margin-top: auto;
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    padding: var(--sp-3);
    border-radius: var(--radius-lg);
    border: 1px solid rgba(255, 180, 171, 0.12);
    background: rgba(255, 180, 171, 0.04);
  }
  .browseVisibilityIcon {
    color: rgba(255, 180, 171, 0.7);
    font-size: 18px;
    margin-top: 1px;
  }
  .browseVisibilityLabel {
    font-family: var(--font-ui);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255, 180, 171, 0.84);
  }
  .browseVisibilityBody {
    margin-top: 2px;
    font-family: var(--font-ui);
    font-size: 9px;
    line-height: 1.45;
    color: rgba(229, 226, 225, 0.48);
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    background: none;
    border: 1px solid transparent;
    color: var(--text-faint);
    cursor: pointer;
    transition: background var(--t-base), color var(--t-base);
    white-space: nowrap;
  }
  .tab:hover { color: var(--text-muted); }
  .tabActive {
    background: var(--accent-muted);
    color: var(--accent-fg);
    border: 1px solid var(--accent-dim);
  }
  .tabActive:hover { color: var(--accent-fg); }
  .keywordBar {
    padding: var(--sp-3) var(--sp-4);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .searchBar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    padding: 0 var(--sp-3) 0 var(--sp-2);
    transition: border-color var(--t-base);
  }
  .searchBar:focus-within { border-color: var(--border-strong); }
  .searchIcon { color: var(--text-faint); flex-shrink: 0; }
  .searchInput {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-size: var(--text-sm);
    padding: 7px 0;
  }
  .searchInput::placeholder { color: var(--text-faint); }
  .clearBtn {
    color: var(--text-faint);
    font-size: 14px;
    line-height: 1;
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    transition: color var(--t-base);
  }
  .clearBtn:hover { color: var(--text-muted); }
  .advancedBtn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    background: none;
    border: none;
    color: var(--text-faint);
    flex-shrink: 0;
    cursor: pointer;
    transition: color var(--t-base), background var(--t-base);
  }
  .advancedBtn:hover { color: var(--text-muted); background: var(--bg-overlay); }
  .advancedBtnActive { color: var(--accent-fg); background: var(--accent-muted); }
  .advancedBtnActive:hover { color: var(--accent-fg); background: var(--accent-muted); }
  .searchBtn {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    padding: 6px 12px;
    border-radius: var(--radius-md);
    background: var(--accent-muted);
    color: var(--accent-fg);
    border: 1px solid var(--accent-dim);
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    transition: filter var(--t-base);
  }
  .searchBtn:hover:not(:disabled) { filter: brightness(1.1); }
  .searchBtn:disabled { opacity: 0.4; cursor: default; }
  .advancedPanel {
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-md);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    animation: fadeIn 0.1s ease both;
  }
  .advancedHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .advancedTitle {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .advancedActions { display: flex; gap: var(--sp-1); }
  .advancedLink {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: var(--accent-fg);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity var(--t-base);
  }
  .advancedLink:hover { opacity: 1; }
  .langGrid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  .langChip {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    background: none;
    color: var(--text-faint);
    cursor: pointer;
    transition: color var(--t-base), border-color var(--t-base), background var(--t-base);
  }
  .langChip:hover { color: var(--text-muted); border-color: var(--border-strong); }
  .langChipActive {
    background: var(--accent-muted);
    border-color: var(--accent-dim);
    color: var(--accent-fg);
  }
  .langChipActive:hover { background: var(--accent-muted); color: var(--accent-fg); }
  .advancedDivider {
    height: 1px;
    background: var(--border-dim);
    margin: 2px 0;
  }
  .advancedFooter {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }
  .advancedLinkStandalone {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: var(--accent-fg);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity var(--t-base);
  }
  .advancedLinkStandalone:hover { opacity: 1; }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
  }
  .emptyIcon { color: var(--text-faint); }
  .emptyText { font-size: var(--text-base); color: var(--text-muted); }
  .emptyHint { font-size: var(--text-sm); color: var(--text-faint); }
  .results {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .sourceSection {
    padding: var(--sp-1) var(--sp-4) var(--sp-3);
    border-bottom: 1px solid var(--border-dim);
  }
  .sourceSection:last-child { border-bottom: none; }
  .sourceHeader {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) 0;
  }
  .sourceIcon {
    width: 18px;
    height: 18px;
    border-radius: var(--radius-sm);
    object-fit: cover;
    flex-shrink: 0;
    background: var(--bg-raised);
  }
  .sourceName {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-secondary);
  }
  .sourceLang {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
    background: var(--bg-raised);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-sm);
    padding: 1px 5px;
  }
  .resultCount {
    margin-left: auto;
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
  }
  .sourceError {
    font-size: var(--text-xs);
    color: var(--color-error);
    padding: var(--sp-1) 0;
    margin: 0;
  }
  .sourceRow {
    display: flex;
    gap: var(--sp-3);
    overflow-x: auto;
    padding-bottom: var(--sp-1);
    scrollbar-width: none;
  }
  .sourceRow::-webkit-scrollbar { display: none; }
  .skCard {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    flex-shrink: 0;
    width: 110px;
  }
  .tagGrid .skCard { width: 100%; }
  .skeleton { border-radius: var(--radius-sm); }
  .skCover {
    aspect-ratio: 2 / 3;
    width: 100%;
    border-radius: var(--radius-md);
  }
  .skTitle { height: 10px; width: 80%; }
  .splitRoot {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .splitSidebar {
    width: 180px;
    flex-shrink: 0;
    border-right: 1px solid var(--border-dim);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .splitSearchWrap {
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--border-dim);
    flex-shrink: 0;
  }
  .splitSearchIcon { color: var(--text-faint); flex-shrink: 0; }
  .splitSearchInput {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-size: var(--text-xs);
    color: var(--text-primary);
    font-family: var(--font-ui);
    min-width: 0;
  }
  .splitSearchInput::placeholder { color: var(--text-faint); }
  .splitSearchClear {
    color: var(--text-faint);
    font-size: 13px;
    line-height: 1;
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    transition: color var(--t-base);
  }
  .splitSearchClear:hover { color: var(--text-muted); }
  .splitList {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-1);
    scrollbar-width: thin;
    scrollbar-color: var(--border-dim) transparent;
  }
  .splitItem {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: 7px var(--sp-3);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: none;
    text-align: left;
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast);
  }
  .splitItem:hover { background: var(--bg-raised); border-color: var(--border-dim); }
  .splitItemActive {
    background: var(--accent-muted);
    border-color: var(--accent-dim);
  }
  .splitItemActive:hover { background: var(--accent-muted); }
  .splitItemLabel {
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .splitItemActive .splitItemLabel { color: var(--accent-fg); font-weight: var(--weight-medium); }
  .splitItemSource { gap: var(--sp-2); }
  .splitEmpty {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    padding: var(--sp-3);
    margin: 0;
  }
  .splitLoading {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-6);
  }
  .splitContent {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .splitContentHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
    flex-shrink: 0;
    gap: var(--sp-2);
  }
  .splitSourceTitle {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    min-width: 0;
  }
  .splitContentTitle {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: var(--tracking-tight);
  }
  .splitResultCount {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wide);
    flex-shrink: 0;
  }
  .catalogCountBadge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 24px;
    padding: 0 9px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.018);
    color: rgba(229, 226, 225, 0.44);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.02em;
  }
  .splitSourceIcon {
    width: 18px;
    height: 18px;
    border-radius: var(--radius-sm);
    object-fit: cover;
    flex-shrink: 0;
    background: var(--bg-raised);
  }
  .tagCheckMark {
    font-size: var(--text-xs);
    color: rgba(218, 207, 255, 0.92);
    margin-left: auto;
  }
  .catalogOptionActive .tagCheckMark {
    color: rgba(218, 207, 255, 0.96);
  }
  .tagGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: var(--sp-4);
    padding: var(--sp-4);
    overflow-y: auto;
    flex: 1;
    align-content: start;
  }
  .showMoreCell {
    grid-column: 1 / -1;
    display: flex;
    justify-content: center;
    gap: var(--sp-2);
    padding: var(--sp-2) 0;
  }
  .inlineLoading {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
  }
  .showMoreBtn {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 5px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: none;
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--t-base), color var(--t-base), border-color var(--t-base);
  }
  .showMoreBtn:hover:not(:disabled) {
    background: var(--bg-raised);
    color: var(--text-secondary);
    border-color: var(--border-strong);
  }
  .showMoreBtn:disabled { opacity: 0.4; cursor: default; }
  .loadMoreRow {
    display: none;
    justify-content: center;
    padding: var(--sp-3) var(--sp-4);
    flex-shrink: 0;
    border-top: 1px solid var(--border-dim);
  }
  .sourceBrowseBar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
    flex-shrink: 0;
  }
  .srcLangRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--sp-2) var(--sp-3);
    border-bottom: 1px solid var(--border-dim);
    flex-shrink: 0;
    gap: var(--sp-2);
  }
  .langPocketLabel {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }
  .langSelect {
    appearance: none;
    -webkit-appearance: none;
    background: var(--bg-overlay);
    border: 1px solid var(--border-dim);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    padding: 4px 24px 4px 8px;
    cursor: pointer;
    max-width: 110px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 256 256'%3E%3Cpath fill='%23888' d='M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 7px center;
    transition: border-color var(--t-base), background var(--t-base), color var(--t-base);
  }
  .langSelect:hover {
    border-color: var(--border-strong);
    background-color: var(--bg-raised);
    color: var(--text-primary);
  }
  .langSelect:focus {
    outline: none;
    border-color: var(--accent-dim);
    color: var(--text-primary);
  }
  .langSelect option {
    background: var(--bg-surface);
    color: var(--text-secondary);
  }
  .nsfwBadge {
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    color: var(--color-error);
    background: var(--color-error-bg, rgba(180, 60, 60, 0.08));
    border: 1px solid rgba(180, 60, 60, 0.25);
    border-radius: var(--radius-sm);
    padding: 1px 5px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .browseShell {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding:
      clamp(10px, 1.1vw, 18px)
      clamp(14px, 1.8vw, 28px)
      clamp(14px, 1.7vw, 26px);
    overflow: hidden;
  }
  .catalogShell {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
    border-radius: calc(24px * var(--n-hud-scale));
    border: 1px solid rgba(255, 255, 255, 0.055);
    background:
      radial-gradient(circle at 18% 8%, rgba(184, 167, 234, 0.065), transparent 34%),
      rgba(18, 18, 22, 0.72);
    box-shadow: 0 22px 60px rgba(0, 0, 0, 0.18);
  }
  .browseShell > .browseSubtabs {
    width: fit-content;
    gap: 4px;
    margin: 0 0 calc(12px * var(--n-hud-scale));
    padding: 3px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-radius: calc(14px * var(--n-hud-scale));
    background: rgba(26, 24, 34, 0.72);
  }
  .browseShell .tab {
    min-height: calc(28px * var(--n-hud-scale));
    padding: 0 calc(12px * var(--n-hud-scale));
    border-radius: calc(10px * var(--n-hud-scale));
  }
  .browseShell .tabActive {
    background: rgba(184, 167, 234, 0.18);
    border-color: rgba(184, 167, 234, 0.2);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
  }
  .catalogRoot,
  .browseShell > .splitRoot {
    flex: 1;
    min-height: 0;
    border-radius: clamp(18px, 1.6vw, 26px);
    border: 1px solid rgba(255, 255, 255, 0.055);
    background:
      radial-gradient(circle at 20% 0%, rgba(184, 167, 234, 0.055), transparent 30%),
      rgba(18, 18, 22, 0.7);
    overflow: hidden;
  }
  .catalogRoot {
    flex-direction: row;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .catalogSidebar,
  .browseShell > .splitRoot > .splitSidebar {
    flex: 0 0 clamp(226px, 13vw, 248px);
    width: clamp(226px, 13vw, 248px);
    min-width: 0;
    padding: clamp(13px, 0.85vw, 16px) clamp(11px, 0.7vw, 14px);
    border-right: 1px solid rgba(255, 255, 255, 0.055);
    background:
      linear-gradient(180deg, rgba(20, 19, 27, 0.72), rgba(10, 10, 14, 0.28)),
      rgba(10, 10, 14, 0.48);
    isolation: isolate;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    -webkit-font-smoothing: auto;
    text-rendering: auto;
    font-family: var(--font-sans);
  }
  .catalogSidebar button,
  .catalogSidebar input {
    font-family: var(--font-sans) !important;
    font-synthesis-weight: none;
  }
  .browseFilterSection {
    position: relative;
    overflow: visible;
    margin-bottom: clamp(12px, 0.75vw, 15px);
    padding: clamp(13px, 0.8vw, 16px);
    border: 1px solid rgba(255, 255, 255, 0.065);
    border-radius: clamp(14px, 1vw, 19px);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.022), rgba(255, 255, 255, 0.004)),
      rgba(13, 13, 18, 0.58);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.025),
      0 12px 28px rgba(0, 0, 0, 0.18);
  }
  .browseCardHeader,
  .browseSectionHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0 0 14px;
  }
  .browseCardTitle {
    margin: 0;
    color: rgba(238, 235, 242, 0.9);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0;
    text-transform: none;
  }
  .browseResetButton {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(184, 167, 234, 0.68);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .browseResetButton .material-symbols-outlined {
    font-size: 15px;
  }
  .browseField {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-bottom: 13px;
  }
  .browseField:has(.browseInlinePicker) {
    z-index: 80;
  }
  .browseFieldLabel {
    margin: 0;
    color: rgba(229, 226, 225, 0.78);
    font-size: 12px;
    font-weight: 700;
  }
  .browseFieldHint {
    margin: -2px 1px 0;
    color: rgba(229, 226, 225, 0.42);
    font-size: 11px;
    font-weight: 500;
    line-height: 1.35;
  }
  .browseSegment {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 3px;
    min-height: 38px;
    padding: 4px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px;
    background: rgba(8, 8, 12, 0.46);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.018);
  }
  .browseSegment button {
    min-height: 30px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: rgba(202, 196, 208, 0.66);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease,
      color 140ms ease,
      box-shadow 140ms ease,
      transform 120ms ease;
  }
  .browseSegment button:hover:not(.is-active) {
    color: rgba(239, 235, 245, 0.9);
    background: rgba(255, 255, 255, 0.035);
    border-color: rgba(255, 255, 255, 0.055);
  }
  .browseSegment button.is-active {
    color: var(--n-on-primary);
    border-color: rgba(211, 196, 255, 0.34);
    background: var(--n-gradient-primary);
    box-shadow:
      0 4px 14px rgba(184, 167, 234, 0.18),
      inset 0 1px 0 rgba(255, 255, 255, 0.18);
  }
  .browseSegment button:active {
    transform: scale(0.97);
  }
  .browseSelectRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 11px;
    background: rgba(8, 8, 12, 0.46);
    color: rgba(229, 226, 225, 0.72);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
  }
  .browseSelectRow .material-symbols-outlined {
    font-size: 18px;
    color: rgba(229, 226, 225, 0.4);
  }
  .browseSelectRow:hover {
    border-color: rgba(184, 167, 234, 0.16);
    background: rgba(184, 167, 234, 0.055);
  }
  .browseSelectRow.is-paused {
    cursor: default;
    color: rgba(229, 226, 225, 0.34);
    border-color: rgba(255, 255, 255, 0.045);
    background: rgba(8, 8, 12, 0.32);
  }
  .browseSelectRow.is-paused:hover {
    border-color: rgba(255, 255, 255, 0.045);
    background: rgba(8, 8, 12, 0.32);
  }
  .browseSelectRow.is-paused .material-symbols-outlined {
    opacity: 0.22;
  }
  .browseSelectRow.is-open .material-symbols-outlined {
    transform: rotate(180deg);
  }
  .browseField:has(.browseSelectRow.is-open) .browseSelectRow {
    border-color: rgba(184, 167, 234, 0.24);
    border-bottom-color: rgba(184, 167, 234, 0.1);
    border-radius: 11px 11px 8px 8px;
    background: rgba(20, 18, 27, 0.72);
  }
  .browseInlinePicker {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 90;
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: min(204px, 38vh);
    overflow-y: auto;
    padding: 5px;
    border: 1px solid rgba(184, 167, 234, 0.22);
    border-radius: 11px;
    background:
      linear-gradient(180deg, rgba(18, 17, 23, 0.99), rgba(10, 10, 14, 0.99)),
      rgba(10, 10, 14, 0.99);
    box-shadow:
      0 12px 26px rgba(0, 0, 0, 0.48),
      0 0 0 1px rgba(255, 255, 255, 0.014);
    animation: browsePickerIn 130ms ease both;
    scrollbar-width: thin;
    scrollbar-color: rgba(184, 167, 234, 0.34) transparent;
  }
  .browseInlinePicker::-webkit-scrollbar {
    width: 5px;
  }
  .browseInlinePicker::-webkit-scrollbar-track {
    background: transparent;
  }
  .browseInlinePicker::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: rgba(184, 167, 234, 0.28);
  }
  .browseInlinePicker button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: rgba(229, 226, 225, 0.64);
    font-size: 11px;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .browseInlinePicker button span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .browseInlinePicker button span:last-child {
    flex-shrink: 0;
    color: rgba(229, 226, 225, 0.34);
    font-size: 10px;
    letter-spacing: 0.08em;
  }
  .browseInlinePicker button:hover {
    background: rgba(184, 167, 234, 0.09);
    color: rgba(238, 235, 242, 0.94);
  }
  .browseLanguagePicker {
    display: flex;
    flex-direction: column;
  }
  .browseLanguagePicker button {
    justify-content: flex-start;
    text-align: left;
    font-size: 11px;
  }
  @keyframes browsePickerIn {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  .browseToggleRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(229, 226, 225, 0.72);
    font-size: 12px;
    font-weight: 650;
    text-align: left;
    cursor: pointer;
  }
  .browseSwitch {
    position: relative;
    width: 28px;
    height: 16px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.16);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    transition: background 160ms ease;
  }
  .browseSwitch::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: rgba(238, 235, 242, 0.86);
    transition: transform 160ms ease, background 160ms ease;
  }
  .browseToggleRow.is-active .browseSwitch {
    background: rgba(184, 167, 234, 0.82);
  }
  .browseToggleRow.is-active .browseSwitch::after {
    transform: translateX(12px);
    background: #ffffff;
  }
  .browseSectionBody {
    max-height: none;
    opacity: 1;
    overflow: visible;
    transition:
      max-height 220ms ease,
      opacity 170ms ease;
  }
  .splitSourceIcon,
  .sourceIcon {
    width: calc(18px * var(--n-hud-scale));
    height: calc(18px * var(--n-hud-scale));
    border-radius: calc(5px * var(--n-hud-scale));
  }
  .splitItemLabel {
    font-size: 10px;
  }
  .browseGenresSection {
    margin-top: 0;
    margin-bottom: clamp(12px, 0.75vw, 15px);
    gap: 4px;
  }
  .browseGenresSection .browseSectionHeader {
    margin-bottom: 0;
  }
  .browseGenresSection .browseSectionBody {
    margin-top: -5px;
  }
  .catalogTagList {
    max-height: clamp(122px, 21vh, 190px);
    overflow-y: auto;
    padding: 0 clamp(3px, 0.3vw, 5px) 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    scrollbar-width: thin;
    scrollbar-color: rgba(184, 167, 234, 0.18) transparent;
  }
  .catalogTagList::-webkit-scrollbar {
    width: 5px;
  }
  .catalogTagList::-webkit-scrollbar-track {
    background: transparent;
  }
  .catalogTagList::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: rgba(184, 167, 234, 0.18);
  }
  .catalogOption {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 31px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.026);
    color: rgba(229, 226, 225, 0.66) !important;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0;
    cursor: pointer;
    transition: color var(--t-base), background var(--t-base), border-color var(--t-base), transform var(--t-fast);
  }
  .catalogOption:hover {
    color: rgba(229, 226, 225, 0.78) !important;
    border-color: rgba(184, 167, 234, 0.14);
    background: rgba(184, 167, 234, 0.055);
  }
  .catalogOptionActive {
    color: #efe9ff !important;
    border-color: rgba(184, 167, 234, 0.42);
    background: linear-gradient(180deg, rgba(184, 167, 234, 0.28), rgba(145, 126, 204, 0.16));
  }
  .catalogSearchWrap {
    display: flex;
    margin: 0 0 calc(7px * var(--n-hud-scale));
    min-height: calc(29px * var(--n-hud-scale));
    padding: 0 calc(10px * var(--n-hud-scale));
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-radius: calc(12px * var(--n-hud-scale));
    background: rgba(8, 8, 12, 0.42);
  }
  .catalogSearchWrap .splitSearchInput {
    font-size: calc(11px * var(--n-hud-scale));
    color: rgba(229, 226, 225, 0.64);
  }
  .catalogSearchWrap .splitSearchInput::placeholder {
    color: rgba(229, 226, 225, 0.32);
  }
  .catalogSearchWrap .splitSearchIcon {
    color: rgba(229, 226, 225, 0.28);
  }
  .splitContent {
    min-width: 0;
    background: rgba(10, 10, 13, 0.12);
  }
  .splitContentHeader,
  .sourceBrowseBar {
    border-bottom-color: rgba(255, 255, 255, 0.045);
  }
  .tagGrid {
    grid-template-columns: repeat(auto-fill, minmax(clamp(104px, 7.1vw, 138px), 1fr));
    gap: clamp(14px, 1.05vw, 20px) clamp(12px, 0.9vw, 17px);
    padding: clamp(8px, 0.75vw, 14px) clamp(10px, 0.8vw, 16px) clamp(14px, 1vw, 20px);
  }
  .tagGrid :global(.n-library-card),
  .sourceRow :global(.n-library-card) {
    width: 100%;
    min-width: 0;
  }
  .sourceRow :global(.n-library-card) {
    flex: 0 0 clamp(108px, 7.4vw, 136px);
  }
  .sourceSection {
    margin: 0 calc(22px * var(--n-hud-scale)) calc(12px * var(--n-hud-scale));
    padding: calc(10px * var(--n-hud-scale)) calc(14px * var(--n-hud-scale)) calc(14px * var(--n-hud-scale));
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: calc(18px * var(--n-hud-scale));
    background: rgba(18, 18, 22, 0.64);
  }
  .results {
    padding-top: calc(10px * var(--n-hud-scale));
  }
  .keywordBar {
    width: min(calc(880px * var(--n-hud-scale)), calc(100% - 48px));
    margin: calc(14px * var(--n-hud-scale)) auto calc(8px * var(--n-hud-scale));
    padding: 0;
  }
  .keywordBar .searchBar,
  .sourceBrowseBar .searchBar {
    min-height: calc(40px * var(--n-hud-scale));
    border-color: rgba(255, 255, 255, 0.055);
    background: rgba(27, 25, 34, 0.7);
  }
  .advancedPanel,
  .visibilityCard {
    border-color: rgba(255, 255, 255, 0.055);
    background: rgba(18, 18, 22, 0.72);
  }
  .browseVisibility {
    margin-top: 0;
    border-color: rgba(255, 255, 255, 0.055);
    background: rgba(255, 255, 255, 0.02);
    min-height: 66px;
    padding: 13px;
    border-radius: 15px;
  }
  .browseVisibilityIcon,
  .browseVisibilityLabel {
    color: rgba(184, 167, 234, 0.74) !important;
  }
  .browseVisibilityBody {
    color: rgba(229, 226, 225, 0.48);
    font-size: 11px;
    line-height: 1.35;
  }
  .splitList {
    padding: calc(8px * var(--n-hud-scale));
  }
  .splitItem {
    min-height: calc(34px * var(--n-hud-scale));
    padding: 0 calc(9px * var(--n-hud-scale));
    border-radius: calc(12px * var(--n-hud-scale));
  }
  .srcLangRow {
    padding: 0 0 calc(12px * var(--n-hud-scale));
    border-bottom-color: rgba(255, 255, 255, 0.055);
  }
  .discoverPanel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: clamp(10px, 0.8vw, 14px);
    padding: clamp(12px, 1vw, 18px) clamp(18px, 1.55vw, 28px) clamp(16px, 1.35vw, 24px);
    overflow: auto;
  }
  .discoverPanelHeader {
    min-height: 36px;
    padding: 0 0 6px;
    border: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.045);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .catalogHeaderCopy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
  }
  .catalogHeaderCopy .n-eyebrow {
    color: rgba(238, 235, 242, 0.8);
    font-size: 12px;
    font-weight: 760;
    letter-spacing: 0.13em;
    line-height: 1;
    text-transform: uppercase;
  }
  .catalogSubtitle {
    margin: 0;
    color: rgba(229, 226, 225, 0.48);
    font-size: 12px;
    font-weight: 520;
    line-height: 1.25;
  }

  @media (max-width: 900px) {
    .browseShell {
      padding-inline: 10px;
    }
    .catalogRoot,
    .browseShell > .splitRoot {
      flex-direction: row !important;
    }
    .catalogSidebar,
    .browseShell > .splitRoot > .splitSidebar {
      flex: 0 0 clamp(204px, 28vw, 220px);
      width: clamp(204px, 28vw, 220px);
      max-height: none;
      border-right: 1px solid rgba(255, 255, 255, 0.055);
      border-bottom: 0;
      padding: 12px 10px;
    }
    .browseFilterSection {
      padding: 12px;
    }
    .browseSegment {
      gap: 5px;
    }
    .browseSegment button {
      min-height: 30px;
      font-size: 11.5px;
    }
    .browseSelectRow {
      min-height: 33px;
      font-size: 11px;
    }
    .browseToggleRow {
      min-height: 30px;
      font-size: 11px;
    }
    .catalogTagList {
      max-height: 132px;
    }
    .catalogOption {
      min-height: 27px;
      padding-inline: 10px;
      font-size: 11px;
    }
    .tagGrid {
      grid-template-columns: repeat(auto-fill, minmax(clamp(92px, 15vw, 116px), 1fr));
      gap: 12px 10px;
      padding: 12px;
    }
  }

  @media (max-width: 700px) {
    .catalogSidebar,
    .browseShell > .splitRoot > .splitSidebar {
      flex-basis: 188px;
      width: 188px;
    }
    .browseCardTitle {
      font-size: 13px;
    }
    .browseResetButton,
    .browseFieldLabel,
    .browseSegment button,
    .browseSelectRow,
    .browseToggleRow,
    .catalogOption {
      font-size: 11.5px;
    }
    .tagGrid {
      grid-template-columns: repeat(auto-fill, minmax(86px, 1fr));
    }
  }
</style>

<script context="module" lang="ts">
  function focusOnMount(node: HTMLElement) { node.focus(); }
</script>
