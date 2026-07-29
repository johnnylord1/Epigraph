<script lang="ts">
  import { onMount, tick } from "svelte";
  import { ArrowLeft, ArrowRight, X } from "phosphor-svelte";
  import { _ , translate } from "../../lib/i18n/runtime";
  import { getManagedSourceRuntime, type SourceRef } from "../../lib/manga/runtime";
  import { fetchSourceMangaSearchWithFallback } from "../../lib/manga/sourceSearch";
  import { resolveMangaCoverUrl, type MangaCoverContext } from "../../lib/manga/coverResolver";
  import { BookAssetResolver } from "../../lib/books/assets";
  import { shouldHideNsfw, shouldHideSource } from "../../lib/util";
  import { isConfirmedAntibotChallengeMessage, isSourceChallengeMessage, sourceAccessErrorMessage } from "../../lib/sourceAccess";
  import {
    loadTrustedInstalledNovelSources,
    readInstalledNovelDetails,
    searchInstalledNovelSource,
  } from "../../lib/novels/sources";
  import { createNovelLibraryId } from "../../lib/novels/domain";
  import {
    buildNovelDetailRecordFromLibrary,
    isNovelInLibrary,
    peekNovelLibraryState,
  } from "../../lib/novels/libraryState";
  import { normalizeSearchText } from "../../lib/search/normalize";
  import { rankSearchResults } from "../../lib/search/ranking";
  import {
    createBrowseNovelResult,
    createBrowseResult,
    createCatalogProvider,
  } from "../../lib/search/providers";
  import { SearchController } from "../../lib/search/controller";
  import { SETTINGS_SEARCH_CATALOG } from "../../lib/search/settingsCatalog";
  import type { SearchBrowseContentType, SearchCatalog, SearchContext, SearchResult } from "../../lib/search/types";
  import type { Manga, Source } from "../../lib/types";
  import {
    addToast,
    openMangaDetail,
    setActiveBookId,
    setActiveNovelDetail,
    setLibraryFilter,
    setLibrarySection,
    setNavPage,
    setRuntimeSettingsTab,
    setSearchQuery,
    setSearchTabHint,
    store,
    updateSettings,
  } from "../../store/state.svelte";

  type PaletteView = "global" | "browse";
  type BrowseSourceGroup = {
    id: string;
    label: string;
    lang: string;
    results: SearchResult[];
    loading: boolean;
    error: string | null;
  };

  let activeResultId = $state<string | null>(null);
  let keyboardNavigationStarted = $state(false);
  let localResults = $state<SearchResult[]>([]);
  let remoteResults = $state<SearchResult[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let previousFocus: HTMLElement | null = null;
  let focusOriginContext: SearchContext | null = null;
  let focusOriginNavPage: string | null = null;
  let focusOriginLibrarySection: string | null = null;
  let paletteRoot = $state<HTMLElement | null>(null);
  let localSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastQueryKey = "";
  let activeController: SearchController | null = null;
  let controllerScopeKey = "";
  let controllerCatalogDependencies: unknown[] = [];
  let queryRequestId = 0;
  let renderedQuery = $state("");
  let renderedContext = $state<SearchContext>("home");
  let failedImages = $state(new Set<string>());
  let paletteView = $state<PaletteView>("global");
  let browseCanGoBack = $state(false);
  let browseQuery = $state("");
  let browseContentType = $state<SearchBrowseContentType>("manga");
  let browseGroups = $state<BrowseSourceGroup[]>([]);
  let browseLoadingSources = $state(false);
  let browseLoadError = $state<string | null>(null);
  let browseAbortController: AbortController | null = null;
  let browseRequestId = 0;
  let browseStartHeight = $state(0);
  let browseViewExpanded = $state(false);

  function resolveWithin<T>(
    promise: Promise<T>,
    fallback: T,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(fallback);
        return;
      }
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish(fallback);
      const timer = setTimeout(() => finish(fallback), timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(finish, () => finish(fallback));
    });
  }

  function currentContext(): SearchContext {
    if (store.searchOpen) return store.searchContext;
    if (store.navPage === "library") return "library";
    if (store.navPage === "search") return "browse";
    if (store.navPage === "settings") return "settings";
    if (store.navPage === "downloads") return "downloads";
    return "home";
  }

  function buildCatalog(): SearchCatalog {
    const chaptersByNovelId = new Map<string, typeof store.searchNovelLibraryChapters>();
    for (const chapter of store.searchNovelLibraryChapters) {
      const chapters = chaptersByNovelId.get(chapter.novelId) ?? [];
      chapters.push(chapter);
      chaptersByNovelId.set(chapter.novelId, chapters);
    }
    return {
      libraryManga: store.libraryMangaSnapshot,
      books: store.books,
      bookProgress: store.bookProgress,
      novels: store.searchNovelLibraryEntries.map((entry) => ({
        entry,
        chapters: chaptersByNovelId.get(entry.id) ?? [],
      })),
      collections: [
        ...store.categories.map((category) => ({
          id: String(category.id),
          title: category.name,
          librarySection: "comics" as const,
        })),
        ...store.settings.booksCategories.map((category) => ({
          id: category.id,
          title: category.name,
          librarySection: "books" as const,
        })),
      ],
      settings: SETTINGS_SEARCH_CATALOG.map((entry) => ({
        ...entry,
        title: translate(entry.titleKey),
        description: translate(entry.descriptionKey),
        groupLabel: translate(entry.groupKey),
      })),
      downloads: store.searchDownloads,
      pages: [
        { id: "page:library", title: translate("library.eyebrow"), description: translate("library.search.comics"), action: { kind: "navigate", page: "library" } },
        { id: "page:browse", title: translate("browse.tabs.search"), description: translate("browse.search.placeholderKeyword"), action: { kind: "navigate", page: "browse", searchTab: "keyword" } },
        { id: "page:downloads", title: translate("downloads.title"), description: translate("downloads.searchPlaceholder"), action: { kind: "navigate", page: "downloads" } },
        { id: "page:settings", title: translate("settings.nav.general"), description: translate("settings_inline.searchSettings"), action: { kind: "navigate", page: "settings" } },
      ],
    };
  }

  function browseErrorMessage(cause: unknown, contentKind: "manga" | "novels") {
    const message = sourceAccessErrorMessage(cause);
    const challenge = contentKind === "manga"
      ? isConfirmedAntibotChallengeMessage(message)
      : isSourceChallengeMessage(message);
    if (!challenge) return message;
    return store.settings.flareSolverrEnabled
      ? translate("novelSources.errors.blockedFlareEnabled")
      : translate("novelSources.errors.blockedFlareDisabled");
  }

  function preferredLanguageSources<T extends { lang: string }>(sources: T[]): T[] {
    const preferred = store.settings.preferredExtensionLang?.trim().toLowerCase();
    if (preferred && sources.some((source) => source.lang.toLowerCase() === preferred)) {
      return sources.filter((source) => source.lang.toLowerCase() === preferred);
    }
    const firstLanguage = [...new Set(sources.map((source) => source.lang))].sort()[0];
    return firstLanguage ? sources.filter((source) => source.lang === firstLanguage) : sources;
  }

  function withMangaSource(manga: Manga, source: Source): Manga {
    return {
      ...manga,
      sourceId: manga.sourceId ?? source.id,
      source: manga.source ?? source,
    };
  }

  function runtimeSourceToSource(source: SourceRef): Source {
    return {
      id: source.id,
      name: source.name,
      lang: source.language,
      displayName: source.displayName,
      iconUrl: source.iconUrl ?? "",
      isNsfw: source.isNsfw,
      extension: source.extensionPackageName
        ? {
            pkgName: source.extensionPackageName,
            name: source.displayName,
            lang: source.language,
          }
        : null,
    };
  }

  async function runBrowseConcurrent<T>(
    items: T[],
    signal: AbortSignal,
    work: (item: T) => Promise<void>,
  ) {
    let index = 0;
    async function worker() {
      while (index < items.length && !signal.aborted) {
        const item = items[index++];
        await work(item).catch(() => {});
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
  }

  function updateBrowseGroup(
    id: string,
    next: Partial<Pick<BrowseSourceGroup, "results" | "loading" | "error">>,
    requestId: number,
  ) {
    if (requestId !== browseRequestId) return;
    browseGroups = browseGroups.map((group) => group.id === id ? { ...group, ...next } : group);
  }

  async function searchBrowseManga(query: string, controller: AbortController, requestId: number) {
    const runtime = await getManagedSourceRuntime();
    const sourceRefs = await runtime.listSources(controller.signal);
    if (controller.signal.aborted || requestId !== browseRequestId) return;
    const sources = preferredLanguageSources(
      sourceRefs
        .map(runtimeSourceToSource)
        .filter((source) => source.id !== "0")
        .filter((source) => !shouldHideSource(source, store.settings)),
    );
    browseGroups = sources.map((source) => ({
      id: source.id,
      label: source.displayName,
      lang: source.lang,
      results: [],
      loading: true,
      error: null,
    }));
    browseLoadingSources = false;
    await runBrowseConcurrent(sources, controller.signal, async (source) => {
      try {
        const mangas = await fetchSourceMangaSearchWithFallback({
          sourceId: source.id,
          query,
          signal: controller.signal,
          timeoutMs: 8000,
        });
        if (controller.signal.aborted) return;
        const results = mangas
          .filter((manga) => !shouldHideNsfw(manga, store.settings))
          .map((manga) => createBrowseResult(withMangaSource(manga, source)));
        updateBrowseGroup(source.id, { results, loading: false }, requestId);
      } catch (cause) {
        if (controller.signal.aborted || (cause as { name?: string })?.name === "AbortError") return;
        updateBrowseGroup(source.id, {
          loading: false,
          error: browseErrorMessage(cause, "manga"),
        }, requestId);
      }
    });
  }

  async function searchBrowseNovels(query: string, controller: AbortController, requestId: number) {
    const scope = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };
    const loaded = await resolveWithin(
      loadTrustedInstalledNovelSources(scope),
      [],
      controller.signal,
      3000,
    );
    if (controller.signal.aborted || requestId !== browseRequestId) return;
    const enabled = loaded.filter((source) => source.enabled);
    const sources = preferredLanguageSources(enabled);
    browseGroups = sources.map((source) => ({
      id: source.pluginId,
      label: source.name,
      lang: source.lang,
      results: [],
      loading: true,
      error: null,
    }));
    browseLoadingSources = false;
    await runBrowseConcurrent(sources, controller.signal, async (source) => {
      try {
        const novels = await resolveWithin(
          searchInstalledNovelSource(scope, source.pluginId, query, 1),
          [],
          controller.signal,
          8000,
        );
        if (controller.signal.aborted) return;
        updateBrowseGroup(source.pluginId, {
          results: novels.map((novel) => createBrowseNovelResult({ source, novel })),
          loading: false,
        }, requestId);
      } catch (cause) {
        if (controller.signal.aborted || (cause as { name?: string })?.name === "AbortError") return;
        updateBrowseGroup(source.pluginId, {
          loading: false,
          error: browseErrorMessage(cause, "novels"),
        }, requestId);
      }
    });
  }

  function scopeKey() {
    return [
      currentContext(),
      store.librarySection,
      store.searchBrowseContentType,
      store.searchBrowseSurface,
    ].join(":");
  }

  function catalogDependencies(): unknown[] {
    return [
      store.libraryMangaSnapshot,
      store.books,
      store.bookProgress,
      store.searchNovelLibraryEntries,
      store.searchNovelLibraryChapters,
      store.categories,
      store.settings,
      store.searchDownloads,
    ];
  }

  function controllerForContext() {
    const nextScopeKey = scopeKey();
    const nextDependencies = catalogDependencies();
    const catalogUnchanged =
      controllerCatalogDependencies.length === nextDependencies.length
      && nextDependencies.every((dependency, index) => dependency === controllerCatalogDependencies[index]);
    if (activeController && controllerScopeKey === nextScopeKey && catalogUnchanged) {
      return activeController;
    }
    activeController?.cancel();
    controllerScopeKey = nextScopeKey;
    controllerCatalogDependencies = nextDependencies;
    activeController = new SearchController([
      createCatalogProvider(buildCatalog()),
    ]);
    return activeController;
  }

  function resultIdentity(result: SearchResult) {
    if (["comic", "browse-item"].includes(result.type)) {
      return `comic:${normalizeSearchText(result.title)}`;
    }
    if (["book", "novel-library", "novel-source"].includes(result.type)) {
      return `book:${normalizeSearchText(result.title)}`;
    }
    return result.id;
  }

  const rankedResults = $derived.by(() => {
    const ranked = rankSearchResults(
      [...localResults, ...remoteResults],
      renderedQuery,
      renderedContext,
    );
    const seen = new Set<string>();
    return ranked.filter((result) => {
      const identity = resultIdentity(result);
      if (!identity || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).slice(0, 40);
  });

  const groupedResults = $derived.by(() => {
    const groups = new Map<string, SearchResult[]>();
    for (const result of rankedResults) {
      const entries = groups.get(result.group) ?? [];
      entries.push(result);
      groups.set(result.group, entries);
    }
    return [...groups.entries()].map(([key, entries]) => ({ key, label: entries[0].groupLabel, entries }));
  });

  const browseDisplayResults = $derived(browseGroups.flatMap((group) => group.results));
  const browseSearching = $derived(
    browseLoadingSources || browseGroups.some((group) => group.loading),
  );
  const browseSearchAction: SearchResult | null = $derived.by(() => {
    const query = renderedQuery.trim();
    if (!query || renderedContext === "browse" || paletteView === "browse") return null;
    return {
      id: "action:search-in-browse",
      type: "action",
      title: translate("browse.search.searchInBrowse"),
      description: translate("browse.search.placeholderKeyword"),
      group: "browse-scope",
      groupLabel: translate("browse.tabs.search"),
      action: {
        kind: "browse",
        query,
        contentType: store.librarySection === "books" ? "novels" : "manga",
      },
    };
  });
  const globalDisplayResults = $derived.by(() => [
    ...groupedResults.flatMap((group) => group.entries),
    ...(browseSearchAction ? [browseSearchAction] : []),
  ]);
  const displayResults = $derived(
    paletteView === "browse" ? browseDisplayResults : globalDisplayResults,
  );
  const selectedResult = $derived(
    displayResults.find((result) => result.id === activeResultId) ?? displayResults[0] ?? null,
  );
  const liveStatusMessage = $derived.by(() => {
    if (!store.searchEngaged) return "";
    if (paletteView === "browse") {
      if (browseLoadError) return browseLoadError;
      if (browseSearching) return $_("ui_loading");
      if (browseDisplayResults.length === 0) return $_("ui_noResults");
      return "";
    }
    if (error) return error;
    if (!store.searchQuery.trim()) return $_("ui_typeATitleToSearch");
    if (store.searchOpen && rankedResults.length === 0 && !loading) return $_("ui_noResults");
    return "";
  });

  function isWorkResult(result: SearchResult): boolean {
    return ["comic", "browse-item", "book", "novel-library", "novel-source"].includes(result.type);
  }

  function resultIcon(result: SearchResult): string {
    if (result.type === "setting") return "tune";
    if (result.type === "download") return "download";
    if (["book", "novel-library", "novel-source"].includes(result.type)) return "book_2";
    if (["comic", "browse-item"].includes(result.type)) return "menu_book";
    return "arrow_forward";
  }

  function resultWorkSource(result: SearchResult): string {
    const source = result.metadata?.source;
    return typeof source === "string" && source.trim() ? source : translate("ui_source");
  }

  function resultWorkStatus(result: SearchResult): string {
    const status = result.metadata?.status;
    return typeof status === "string" && status.trim() ? status : translate("library.status.unknown");
  }

  function sourceLabelAlreadyIncludesLanguage(label: string, language: string): boolean {
    const normalizedLanguage = language.trim().toLocaleUpperCase();
    const trimmedLabel = label.trim();
    if (!normalizedLanguage || !trimmedLabel.endsWith(")")) return false;
    const markerStart = trimmedLabel.lastIndexOf("(");
    if (markerStart < 0) return false;
    return trimmedLabel.slice(markerStart + 1, -1).trim().toLocaleUpperCase() === normalizedLanguage;
  }

  function canRestoreSearchFocus(target: HTMLElement): boolean {
    if (
      !target.isConnected
      || focusOriginContext !== store.searchContext
      || focusOriginNavPage !== store.navPage
      || focusOriginLibrarySection !== store.librarySection
      || target.closest("[inert]")
      || target.matches(":disabled")
    ) {
      return false;
    }
    const style = getComputedStyle(target);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function dismissSearchPalette() {
    store.closeSearchPalette(true);
  }

  function activeResult() {
    return selectedResult;
  }

  function mangaCoverContext(): MangaCoverContext {
    if (paletteView === "browse") return "browse";
    const context = renderedContext;
    if (context === "browse") return "browse";
    if (context === "downloads") return "downloads";
    if (context === "library") return "library";
    return "home";
  }

  function resultImageUrl(result: SearchResult): string {
    if (result.action.kind === "manga") {
      return resolveMangaCoverUrl(result.action.manga, {
        context: mangaCoverContext(),
        persistence: result.action.manga.inLibrary ? "persistent" : "memory",
        cacheGeneration: store.libraryCoverCacheGeneration,
      });
    }
    if (result.action.kind === "download") {
      return resolveMangaCoverUrl(result.image, {
        context: "downloads",
        persistence: "persistent",
        cacheGeneration: store.libraryCoverCacheGeneration,
      });
    }
    if (result.action.kind === "book") {
      const bookId = result.action.bookId;
      const book = store.books.find((entry) => entry.id === bookId);
      return book ? BookAssetResolver.resolveCoverSrc(book) ?? book.hardcoverCoverUrl ?? book.coverUrl ?? "" : "";
    }
    return result.image?.trim() ?? "";
  }

  async function runBrowseSubviewSearch(query: string) {
    const trimmed = query.trim();
    if (!trimmed) return;
    browseAbortController?.abort();
    const controller = new AbortController();
    browseAbortController = controller;
    const requestId = ++browseRequestId;
    browseQuery = trimmed;
    browseGroups = [];
    browseLoadError = null;
    browseLoadingSources = true;
    activeResultId = null;
    keyboardNavigationStarted = false;
    failedImages = new Set();
    try {
      if (browseContentType === "novels") {
        await searchBrowseNovels(trimmed, controller, requestId);
      } else {
        await searchBrowseManga(trimmed, controller, requestId);
      }
    } catch (cause) {
      if (controller.signal.aborted || requestId !== browseRequestId) return;
      browseLoadError = browseErrorMessage(cause, browseContentType);
    } finally {
      if (requestId === browseRequestId) browseLoadingSources = false;
    }
  }

  function openBrowseSubview(result: SearchResult) {
    if (result.action.kind !== "browse" || paletteView === "browse") return;
    browseStartHeight = paletteRoot?.getBoundingClientRect().height ?? 0;
    browseViewExpanded = false;
    browseContentType = result.action.contentType
      ?? (store.librarySection === "books" ? "novels" : "manga");
    browseCanGoBack = renderedContext !== "browse";
    paletteView = "browse";
    void tick().then(() => {
      if (paletteView !== "browse" || !store.searchOpen) return;
      paletteRoot?.getBoundingClientRect();
      requestAnimationFrame(() => {
        if (paletteView === "browse" && store.searchOpen) browseViewExpanded = true;
      });
    });
    void runBrowseSubviewSearch(result.action.query);
  }

  async function returnToGlobalSearch() {
    browseAbortController?.abort();
    browseRequestId += 1;
    browseGroups = [];
    browseLoadError = null;
    browseLoadingSources = false;
    paletteView = "global";
    browseCanGoBack = false;
    browseViewExpanded = false;
    browseStartHeight = 0;
    lastQueryKey = "";
    runQuery(renderedQuery);
    activeResultId = "action:search-in-browse";
    keyboardNavigationStarted = true;
    await tick();
    if (previousFocus && canRestoreSearchFocus(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
  }

  async function selectResult(result: SearchResult | null) {
    if (!result) return;
    if (result.action.kind === "browse") {
      openBrowseSubview(result);
      return;
    }
    browseAbortController?.abort();
    store.closeSearchPalette(false);
    switch (result.action.kind) {
      case "collection":
        setLibrarySection(result.action.librarySection);
        setNavPage("library");
        if (result.action.librarySection === "books") {
          updateSettings({
            booksLibraryUi: {
              ...store.settings.booksLibraryUi,
              activeCategoryId: result.action.collectionId,
            },
          });
        } else {
          setLibraryFilter(result.action.collectionId);
        }
        break;
      case "manga":
        openMangaDetail(result.action.manga);
        break;
      case "book":
        setLibrarySection("books");
        setNavPage("library");
        setActiveBookId(result.action.bookId);
        break;
      case "novel-library":
        setLibrarySection("books");
        setNavPage("library");
        setActiveNovelDetail({
          novel: buildNovelDetailRecordFromLibrary(result.action.entry, result.action.chapters),
          inLibrary: true,
        });
        break;
      case "novel-source":
        try {
          const scope = {
            profileId: store.runtimeResolvedLocalProfileId,
            serverUrl: store.runtimeServerUrl,
          };
          const detail = await readInstalledNovelDetails(
            scope,
            result.action.source.pluginId,
            result.action.novel.path,
            {
              title: result.action.novel.title,
              coverUrl: result.action.novel.coverUrl,
            },
          );
          const libraryState = peekNovelLibraryState(scope);
          setActiveNovelDetail({
            novel: detail,
            inLibrary: isNovelInLibrary(
              libraryState,
              createNovelLibraryId(result.action.novel.sourceId, result.action.novel.path),
            ),
          });
        } catch (cause) {
          addToast({
            kind: "error",
            title: translate("novelSources_errors_openDetailTitle"),
            body: cause instanceof Error ? cause.message : translate("ui_aethonCouldnTOpenThisNovel"),
          });
        }
        break;
      case "setting":
        store.setSettingsOpen(true);
        setRuntimeSettingsTab(result.action.tab);
        if (result.action.targetId) {
          const targetId = result.action.targetId;
          void tick().then(() => {
            const target = document.getElementById(targetId);
            target?.scrollIntoView({ block: "center" });
            target?.focus({ preventScroll: true });
          });
        }
        break;
      case "download":
        const chapterId = result.action.chapterId;
        setNavPage("downloads");
        void tick().then(() => {
          const target = document.querySelector<HTMLElement>(
            `[data-download-chapter-id="${chapterId}"]`,
          );
          target?.scrollIntoView({ block: "center" });
          target?.focus({ preventScroll: true });
        });
        break;
      case "navigate":
        if (result.action.librarySection) setLibrarySection(result.action.librarySection);
        if (result.action.searchTab) setSearchTabHint(result.action.searchTab);
        setNavPage(result.action.page === "browse" ? "search" : result.action.page);
        break;
    }
  }

  function updateQuery(value: string) {
    renderedQuery = value;
    renderedContext = currentContext();
    setSearchQuery(value);
    if (!value.trim()) {
      dismissSearchPalette();
      return;
    }
    if (paletteView === "browse") {
      browseQuery = value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        void runBrowseSubviewSearch(value);
      }, 250);
      return;
    }
    if (localSearchTimer) clearTimeout(localSearchTimer);
    localSearchTimer = setTimeout(() => {
      localSearchTimer = null;
      runQuery(value);
    }, 180);
  }

  function runQuery(value: string) {
    const queryKey = `${scopeKey()}:${normalizeSearchText(value)}`;
    if (queryKey === lastQueryKey) return;
    lastQueryKey = queryKey;
    activeResultId = null;
    keyboardNavigationStarted = false;
    error = null;
    failedImages = new Set();
    queryRequestId += 1;
    activeController?.cancel();
    const controller = controllerForContext();
    localResults = controller.searchLocal(
      currentContext(),
      value,
      store.librarySection,
      store.searchBrowseContentType,
      store.searchBrowseSurface,
    );
    remoteResults = [];
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    loading = false;
  }

  function keepWithinContainer(
    container: HTMLElement,
    item: HTMLElement,
    axis: "horizontal" | "vertical",
  ) {
    const containerRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (axis === "horizontal") {
      if (itemRect.left < containerRect.left) {
        container.scrollLeft -= containerRect.left - itemRect.left;
      } else if (itemRect.right > containerRect.right) {
        container.scrollLeft += itemRect.right - containerRect.right;
      }
      return;
    }
    if (itemRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - itemRect.top;
    } else if (itemRect.bottom > containerRect.bottom) {
      container.scrollTop += itemRect.bottom - containerRect.bottom;
    }
  }

  async function moveActiveResult(nextId: string | null) {
    keyboardNavigationStarted = true;
    activeResultId = nextId;
    await tick();
    if (!nextId || activeResultId !== nextId || !paletteRoot) return;
    const activeItem = paletteRoot.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    const resultsContainer = paletteRoot.querySelector<HTMLElement>(".search-palette__results");
    if (!activeItem || !resultsContainer) return;
    const horizontalContainer = activeItem.closest<HTMLElement>(
      ".search-palette__group-results.is-work-grid",
    );
    if (horizontalContainer) {
      keepWithinContainer(horizontalContainer, activeItem, "horizontal");
    }
    keepWithinContainer(resultsContainer, activeItem, "vertical");
  }

  function moveBrowseResult(key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown") {
    const rows = browseGroups.filter((group) => group.results.length > 0);
    if (rows.length === 0) return;
    const currentId = activeResult()?.id;
    let rowIndex = rows.findIndex((group) => group.results.some((result) => result.id === currentId));
    if (rowIndex < 0) rowIndex = 0;
    let itemIndex = Math.max(0, rows[rowIndex].results.findIndex((result) => result.id === currentId));
    if (key === "ArrowLeft") itemIndex = Math.max(0, itemIndex - 1);
    if (key === "ArrowRight") itemIndex = Math.min(rows[rowIndex].results.length - 1, itemIndex + 1);
    if (key === "ArrowUp") rowIndex = Math.max(0, rowIndex - 1);
    if (key === "ArrowDown") rowIndex = Math.min(rows.length - 1, rowIndex + 1);
    const target = rows[rowIndex].results[Math.min(itemIndex, rows[rowIndex].results.length - 1)];
    if (target) void moveActiveResult(target.id);
  }

  function handleKeydown(event: KeyboardEvent) {
    const searchInputTarget = event.target instanceof HTMLInputElement
      && event.target.matches(".n-search__input");
    if (event.key === "Escape" && store.searchEngaged && !store.searchOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      dismissSearchPalette();
      if (searchInputTarget) event.target.blur();
      return;
    }
    if (!store.searchOpen) return;
    if (event.key === "Tab") {
      const focusable = [...(paletteRoot?.querySelectorAll<HTMLElement>(
        'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      event.stopPropagation();
      focusable[next].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      if (paletteView === "browse" && browseCanGoBack && searchInputTarget) {
        void returnToGlobalSearch();
        return;
      }
      if (store.searchQuery.trim() && searchInputTarget) {
        store.clearSearchPaletteQuery();
        return;
      }
      dismissSearchPalette();
    } else if (
      paletteView === "browse"
      && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      moveBrowseResult(event.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      const current = displayResults.findIndex((result) => result.id === activeResult()?.id);
      void moveActiveResult(
        displayResults[Math.min(current + 1, Math.max(displayResults.length - 1, 0))]?.id ?? null,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const current = displayResults.findIndex((result) => result.id === activeResult()?.id);
      void moveActiveResult(displayResults[Math.max(current - 1, 0)]?.id ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      selectResult(activeResult());
    }
  }

  $effect(() => {
    store.searchActiveResultId = store.searchOpen && activeResult()
      ? `search-result-${activeResult()?.id}`
      : null;
  });

  $effect(() => {
    const open = store.searchOpen;
    if (open) {
      if (!previousFocus) {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        focusOriginContext = store.searchContext;
        focusOriginNavPage = store.navPage;
        focusOriginLibrarySection = store.librarySection;
      }
      if (currentContext() === "browse" && paletteView === "global") {
        paletteView = "browse";
        browseCanGoBack = false;
        browseContentType = store.searchBrowseContentType;
      }
      document.body.classList.add("aethon-search-engaged");
      updateQuery(store.searchQuery);
    } else {
      if (localSearchTimer) clearTimeout(localSearchTimer);
      if (searchTimer) clearTimeout(searchTimer);
      queryRequestId += 1;
      activeController?.cancel();
      browseAbortController?.abort();
      browseRequestId += 1;
      lastQueryKey = "";
      keyboardNavigationStarted = false;
      loading = false;
      browseGroups = [];
      browseLoadError = null;
      browseLoadingSources = false;
      paletteView = "global";
      browseCanGoBack = false;
      browseViewExpanded = false;
      browseStartHeight = 0;
      if (
        store.searchRestoreFocusOnClose
        && previousFocus
        && canRestoreSearchFocus(previousFocus)
      ) {
        store.restoreSearchFocus(previousFocus);
      }
      previousFocus = null;
      focusOriginContext = null;
      focusOriginNavPage = null;
      focusOriginLibrarySection = null;
    }
  });

  onMount(() => {
    window.addEventListener("keydown", handleKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleKeydown, true);
      if (localSearchTimer) clearTimeout(localSearchTimer);
      if (searchTimer) clearTimeout(searchTimer);
      activeController?.cancel();
      browseAbortController?.abort();
      document.body.classList.remove("aethon-search-engaged");
    };
  });
</script>

<div
  class="search-palette__live-status"
  role="status"
  aria-live="polite"
  aria-atomic="true"
>{liveStatusMessage}</div>
<button
  class="search-palette-backdrop"
  class:is-open={store.searchOpen}
  type="button"
  aria-label={$_("ui_close")}
  aria-hidden={!store.searchOpen}
  disabled={!store.searchOpen}
  onclick={dismissSearchPalette}
></button>
<div
  class="search-palette n-popover-surface"
  class:is-open={store.searchOpen}
  class:is-browse-view={paletteView === "browse"}
  class:is-browse-expanded={browseViewExpanded}
  style={`--search-palette-start-height: ${browseStartHeight}px;`}
  role="dialog"
  aria-label={$_("ui_searchTitles")}
  aria-hidden={!store.searchOpen}
  inert={!store.searchOpen}
  tabindex="-1"
  bind:this={paletteRoot}
>
    <div class="search-palette__actions" class:is-browse={paletteView === "browse"}>
      {#if paletteView === "browse"}
        {#if browseCanGoBack}
          <button
            class="n-icon-btn search-palette__back"
            type="button"
            aria-label={$_("browse.search.backToGlobal")}
            title={$_("browse.search.backToGlobal")}
            onclick={returnToGlobalSearch}
          >
            <ArrowLeft size={16} weight="bold" aria-hidden="true" />
          </button>
        {/if}
        <div class="search-palette__context">
          <strong>{$_("browse.search.resultsTitle")}</strong>
          <small>{browseContentType === "novels" ? $_("common.books") : $_("common.comics")}</small>
        </div>
      {/if}
      {#if loading || browseSearching}<span class="search-palette__status" aria-live="polite">{$_("ui_loading")}</span>{/if}
      <button class="n-icon-btn" type="button" aria-label={$_("ui_close")} onclick={dismissSearchPalette}>
        <X size={16} weight="bold" aria-hidden="true" />
      </button>
    </div>
    <div id="aethon-search-results" class="search-palette__results" role="listbox" aria-label={$_("ui_searchTitles")}>
      {#if paletteView === "browse"}
        {#if browseLoadError}
          <div class="search-palette__state">{browseLoadError}</div>
        {:else if browseLoadingSources}
          <div class="search-palette__state">{$_("ui_loading")}</div>
        {:else if browseGroups.length === 0}
          <div class="search-palette__state">
            {browseContentType === "novels" ? $_("browse.search.noNovelData") : $_("browse.search.noMangaData")}
          </div>
        {:else}
          {#each browseGroups as group (group.id)}
            {@const groupIsCompact = Boolean(group.error) || (!group.loading && group.results.length === 0)}
            <section
              class="search-palette__group search-palette__browse-group"
              class:is-compact={groupIsCompact}
              data-browse-source={group.id}
            >
              <div class="search-palette__group-label">
                <span class="search-palette__source-label">
                  <strong>{group.label}</strong>
                  {#if !sourceLabelAlreadyIncludesLanguage(group.label, group.lang)}
                    <small>{group.lang.toUpperCase()}</small>
                  {/if}
                </span>
                {#if group.error}
                  <span class="search-palette__source-state is-error">{$_("ui_error")}</span>
                {:else if group.loading}
                  <span class="search-palette__source-state">{$_("ui_loading")}</span>
                {:else if group.results.length > 0}
                  <span class="search-palette__source-state">{group.results.length} {$_("ui_results")}</span>
                {:else}
                  <span class="search-palette__source-state is-empty">
                    {$_("browse.source.noResultsFor", { query: browseQuery })}
                  </span>
                {/if}
              </div>
              {#if group.error}
                <div class="search-palette__compact-state" title={group.error}>{group.error}</div>
              {:else if group.loading}
                <div class="search-palette__browse-loading" aria-hidden="true">
                  {#each Array(5) as _, index (index)}
                    <span class="search-palette__skeleton-card">
                      <span class="search-palette__skeleton-cover"></span>
                      <span class="search-palette__skeleton-copy">
                        <span class="search-palette__skeleton-title">
                          <i></i>
                          <i></i>
                        </span>
                        <span class="search-palette__skeleton-meta">
                          <i></i>
                          <i></i>
                        </span>
                      </span>
                    </span>
                  {/each}
                </div>
              {:else if group.results.length > 0}
                <div
                  class="search-palette__group-results is-work-grid"
                  data-browse-source-row={group.id}
                >
                  {#each group.results.slice(0, store.settings.renderLimit ?? 48) as result (result.id)}
                    {@const imageUrl = resultImageUrl(result)}
                    <button
                      class="search-palette__result is-work-card"
                      class:is-active={keyboardNavigationStarted && result.id === activeResult()?.id}
                      id={`search-result-${result.id}`}
                      data-browse-result-key={result.id}
                      role="option"
                      aria-selected={result.id === activeResult()?.id}
                      type="button"
                      onclick={() => selectResult(result)}
                    >
                      <span class="search-palette__result-media">
                        {#if imageUrl && !failedImages.has(result.id)}
                          <img
                            src={imageUrl}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            onerror={() => {
                              failedImages = new Set(failedImages).add(result.id);
                            }}
                          />
                        {:else}
                          <span class="search-palette__result-icon material-symbols-outlined" aria-hidden="true">{resultIcon(result)}</span>
                        {/if}
                      </span>
                      <span class="search-palette__result-copy">
                        <strong>{result.title}</strong>
                        <small class="search-palette__result-work-meta">
                          <span title={resultWorkSource(result)}>{resultWorkSource(result)}</span>
                          <span title={resultWorkStatus(result)}>{resultWorkStatus(result)}</span>
                        </small>
                      </span>
                    </button>
                  {/each}
                </div>
              {/if}
            </section>
          {/each}
        {/if}
      {:else if error && rankedResults.length === 0}
        <div class="search-palette__state">{error}</div>
      {:else if !renderedQuery.trim()}
        <div class="search-palette__state">{$_("ui_typeATitleToSearch")}</div>
      {:else if rankedResults.length === 0 && !loading && !browseSearchAction}
        <div class="search-palette__state">{$_("ui_noResults")}</div>
      {:else}
        {#if error}
          <div class="search-palette__notice">{error}</div>
        {/if}
        {#if rankedResults.length === 0 && !loading}
          <div class="search-palette__state search-palette__state--compact">{$_("ui_noResults")}</div>
        {/if}
        {#each groupedResults as group}
          <div class="search-palette__group" data-search-group={group.key}>
            <div class="search-palette__group-label">{group.label}<span>{group.entries.length}</span></div>
            <div
              class="search-palette__group-results"
              class:is-work-grid={group.entries.every(isWorkResult)}
            >
              {#each group.entries as result}
                {@const imageUrl = resultImageUrl(result)}
                <button
                  class="search-palette__result"
                  class:is-work-card={isWorkResult(result)}
                  class:is-active={keyboardNavigationStarted && result.id === activeResult()?.id}
                  id={`search-result-${result.id}`}
                  role="option"
                  aria-selected={result.id === activeResult()?.id}
                  type="button"
                  onclick={() => selectResult(result)}
                >
                  <span class="search-palette__result-media">
                    {#if imageUrl && !failedImages.has(result.id)}
                      <img
                        src={imageUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onerror={() => {
                          failedImages = new Set(failedImages).add(result.id);
                        }}
                      />
                    {:else}
                      <span class="search-palette__result-icon material-symbols-outlined" aria-hidden="true">{resultIcon(result)}</span>
                    {/if}
                  </span>
                  <span class="search-palette__result-copy">
                    <strong>{result.title}</strong>
                    {#if isWorkResult(result)}
                      <small class="search-palette__result-work-meta">
                        <span title={resultWorkSource(result)}>{resultWorkSource(result)}</span>
                        <span title={resultWorkStatus(result)}>{resultWorkStatus(result)}</span>
                      </small>
                    {:else}
                      <small>{result.description ?? result.breadcrumb ?? result.groupLabel}</small>
                    {/if}
                  </span>
                  {#if result.metadata?.progress !== undefined}<span class="search-palette__result-meta">{result.metadata.progress}%</span>{/if}
                </button>
              {/each}
            </div>
          </div>
        {/each}
        {#if browseSearchAction}
          <div class="search-palette__scope-action-wrap">
            <button
              class="search-palette__result search-palette__scope-action"
              class:is-active={keyboardNavigationStarted && browseSearchAction.id === activeResult()?.id}
              id={`search-result-${browseSearchAction.id}`}
              role="option"
              aria-selected={browseSearchAction.id === activeResult()?.id}
              type="button"
              onclick={() => selectResult(browseSearchAction)}
            >
              <span class="search-palette__result-copy">
                <strong>{browseSearchAction.title}</strong>
                <small>{browseSearchAction.description}</small>
              </span>
              <ArrowRight class="search-palette__scope-action-icon" size={16} weight="bold" aria-hidden="true" />
            </button>
          </div>
        {/if}
      {/if}
    </div>
</div>

<style>
  .search-palette-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--z-popover);
    border: 0;
    background: transparent;
    pointer-events: none;
  }
  .search-palette-backdrop.is-open {
    pointer-events: auto;
  }
  .search-palette__live-status {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .search-palette {
    --search-work-card-width: clamp(116px, 10vw, 128px);
    --search-palette-max-height: min(640px, calc(100vh - var(--shell-topbar-height) - var(--sp-8)));
    position: fixed;
    top: calc(var(--shell-topbar-height) + var(--sp-3));
    left: 50%;
    width: min(900px, calc(100vw - var(--sp-8)));
    max-height: var(--search-palette-max-height);
    transform: translateX(-50%);
    z-index: calc(var(--z-popover) + 1);
    overflow: hidden;
    border: 1px solid var(--component-search-border);
    border-radius: var(--component-popover-radius);
    background: var(--component-popover-bg);
    color: var(--text-primary);
    box-shadow: var(--component-popover-shadow);
    opacity: 0;
    pointer-events: none;
    contain: layout paint style;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }
  .search-palette.is-browse-view {
    height: var(--search-palette-start-height);
    transition: height var(--duration-normal) var(--easing-emphasized);
  }
  .search-palette.is-browse-view.is-browse-expanded {
    height: var(--search-palette-max-height);
  }
  .search-palette.is-open {
    opacity: 1;
    pointer-events: auto;
    animation: search-palette-in var(--duration-normal) var(--easing-emphasized) both;
  }
  .search-palette__actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); min-height: 38px; padding: var(--sp-1) var(--sp-2) 0; }
  .search-palette__actions.is-browse {
    justify-content: flex-start;
    border-bottom: 1px solid var(--divider);
    padding-bottom: var(--sp-2);
  }
  .search-palette__actions.is-browse > .n-icon-btn:last-child { margin-left: auto; }
  .search-palette__context { display: grid; min-width: 0; gap: 2px; flex: 1; }
  .search-palette__context strong { color: var(--text-primary); font-size: var(--font-size-sm); }
  .search-palette__context small { color: var(--text-tertiary); font-size: var(--font-size-xs); }
  .search-palette__status { color: var(--text-tertiary); font-size: var(--font-size-xs); }
  .search-palette__results {
    min-height: 0;
    overflow-y: auto;
    padding: var(--sp-1) var(--sp-2) var(--sp-2);
    scrollbar-color: var(--component-popover-scrollbar-thumb-bg) transparent;
    scrollbar-width: thin;
  }
  .search-palette__group + .search-palette__group { margin-top: var(--sp-3); }
  .search-palette__group-label { display: flex; justify-content: space-between; padding: var(--sp-2) var(--sp-3); color: var(--text-tertiary); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); text-transform: uppercase; }
  .search-palette__group-label span { color: var(--text-tertiary); }
  .search-palette__browse-group + .search-palette__browse-group {
    margin-top: var(--sp-2);
    padding-top: var(--sp-2);
    border-top: 1px solid var(--divider);
  }
  .search-palette__browse-group.is-compact + .search-palette__browse-group {
    margin-top: var(--sp-1);
    padding-top: var(--sp-1);
  }
  .search-palette__browse-group .search-palette__group-label {
    min-height: calc(var(--text-sm) * var(--leading-snug) + var(--sp-2));
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2);
    text-transform: none;
  }
  .search-palette__source-label { display: flex; min-width: 0; align-items: baseline; gap: var(--sp-2); }
  .search-palette__source-label strong { overflow: hidden; color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }
  .search-palette__source-label small { color: var(--text-tertiary); font-size: var(--font-size-xs); }
  .search-palette__source-state {
    min-width: 0;
    max-width: 52%;
    flex: 0 1 auto;
    overflow: hidden;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-palette__source-state.is-error { color: var(--color-danger); }
  .search-palette__source-state.is-empty { font-weight: var(--weight-normal); }
  .search-palette__compact-state {
    margin: 0 var(--sp-2) var(--sp-2);
    overflow: hidden;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    line-height: var(--leading-snug);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-palette__group-results.is-work-grid {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    padding: 0 var(--sp-2) var(--sp-2);
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-inline: contain;
    scroll-snap-type: inline proximity;
    scrollbar-color: var(--component-popover-scrollbar-thumb-bg) transparent;
    scrollbar-width: thin;
  }
  .search-palette__result { display: flex; align-items: center; gap: var(--sp-3); width: 100%; min-height: 56px; padding: var(--sp-2) var(--sp-3); border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--text-primary); text-align: left; }
  .search-palette__result:hover {
    background: var(--component-popover-item-hover-bg);
  }
  .search-palette__result.is-active,
  .search-palette__result:focus-visible,
  .search-palette__result.is-active:hover {
    border-color: var(--component-search-border-focus);
    background: var(--component-menu-item-hover-bg);
  }
  .search-palette__result-media { display: grid; place-items: center; width: 34px; height: 44px; flex: 0 0 auto; overflow: hidden; border-radius: var(--radius-sm); background: var(--component-library-card-cover-bg); }
  .search-palette__result-media img { width: 100%; height: 100%; display: block; object-fit: cover; }
  .search-palette__result-icon { display: grid; place-items: center; width: 100%; height: 100%; color: var(--text-tertiary); }
  .search-palette__result-copy { display: grid; min-width: 0; gap: 3px; flex: 1; }
  .search-palette__result-copy strong, .search-palette__result-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .search-palette__result-copy small { color: var(--text-secondary); }
  .search-palette__result-meta { color: var(--accent); font-size: var(--font-size-xs); }
  .search-palette__result.is-work-card {
    width: var(--search-work-card-width);
    min-width: var(--search-work-card-width);
    min-height: 0;
    flex: 0 0 var(--search-work-card-width);
    padding: var(--sp-1);
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-1);
    border-radius: var(--radius-lg);
    scroll-snap-align: start;
    transition:
      border-color var(--duration-fast) var(--easing-standard),
      background-color var(--duration-fast) var(--easing-standard),
      box-shadow var(--duration-fast) var(--easing-standard);
  }
  .search-palette__result.is-work-card:hover { background: var(--component-popover-item-hover-bg); }
  .search-palette__result.is-work-card .search-palette__result-media {
    width: 100%;
    height: auto;
    aspect-ratio: 2 / 3;
    border: 1px solid var(--component-library-card-cover-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--component-library-card-cover-shadow);
  }
  .search-palette__result.is-work-card .search-palette__result-copy {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .search-palette__result.is-work-card .search-palette__result-copy strong {
    display: -webkit-box;
    min-height: calc(var(--leading-snug) * 2em);
    color: var(--component-library-card-title-fg);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    white-space: normal;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .search-palette__result.is-work-card .search-palette__result-copy small { color: var(--component-library-card-meta-fg); font-size: var(--text-2xs); }
  .search-palette__result-work-meta {
    display: grid;
    min-height: calc(var(--leading-tight) * 2em);
    gap: 1px;
    font-family: var(--font-ui);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }
  .search-palette__result-work-meta span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-palette__result-work-meta span:last-child {
    color: var(--component-library-card-meta-strong-fg);
    text-align: left;
  }
  .search-palette__result.is-work-card.is-active,
  .search-palette__result.is-work-card:focus-visible,
  .search-palette__result.is-work-card.is-active:hover {
    border-color: var(--component-search-border-focus);
    background: var(--component-menu-item-hover-bg);
    box-shadow: inset 0 0 0 1px var(--component-search-border-focus);
  }
  .search-palette__scope-action-wrap {
    margin: var(--sp-2);
    padding-top: var(--sp-2);
    border-top: 1px solid var(--divider);
  }
  .search-palette__scope-action {
    min-height: 0;
    padding: var(--sp-2) var(--sp-3);
  }
  .search-palette__scope-action .search-palette__result-copy {
    gap: var(--sp-1);
  }
  .search-palette__scope-action .search-palette__result-copy strong {
    color: var(--component-search-icon-focus-fg);
  }
  :global(.search-palette__scope-action-icon) {
    flex: 0 0 auto;
    color: var(--component-search-icon-focus-fg);
  }
  .search-palette__browse-loading {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    padding: 0 var(--sp-2) var(--sp-2);
    overflow: hidden;
  }
  .search-palette__skeleton-card {
    display: flex;
    width: var(--search-work-card-width);
    min-width: var(--search-work-card-width);
    flex: 0 0 var(--search-work-card-width);
    flex-direction: column;
    gap: var(--sp-1);
    padding: var(--sp-1);
    border: 1px solid transparent;
    border-radius: var(--radius-lg);
  }
  .search-palette__skeleton-cover {
    width: 100%;
    aspect-ratio: 2 / 3;
    border: 1px solid var(--component-library-card-cover-border);
    border-radius: var(--radius-xl);
    background: var(--component-library-card-cover-bg);
    box-shadow: var(--component-library-card-cover-shadow);
    opacity: var(--opacity-disabled);
  }
  .search-palette__skeleton-copy {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .search-palette__skeleton-title,
  .search-palette__skeleton-meta {
    display: grid;
    align-content: center;
  }
  .search-palette__skeleton-title {
    min-height: calc(var(--leading-snug) * 2em);
    gap: var(--sp-1);
    font-size: var(--text-xs);
  }
  .search-palette__skeleton-meta {
    min-height: calc((var(--leading-tight) * 2em) + 1px);
    gap: 1px;
    font-size: var(--text-2xs);
  }
  .search-palette__skeleton-copy i {
    display: block;
    height: calc(var(--text-2xs) * 0.55);
    border-radius: var(--radius-full);
    background: var(--component-library-card-cover-bg);
    opacity: var(--opacity-disabled);
  }
  .search-palette__skeleton-title i:nth-child(1) { width: 92%; }
  .search-palette__skeleton-title i:nth-child(2) { width: 68%; }
  .search-palette__skeleton-meta i:nth-child(1) { width: 78%; }
  .search-palette__skeleton-meta i:nth-child(2) { width: 48%; }
  .search-palette__results::-webkit-scrollbar,
  .search-palette__group-results.is-work-grid::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .search-palette__results::-webkit-scrollbar-track,
  .search-palette__group-results.is-work-grid::-webkit-scrollbar-track {
    background: transparent;
  }
  .search-palette__results::-webkit-scrollbar-thumb,
  .search-palette__group-results.is-work-grid::-webkit-scrollbar-thumb {
    border-radius: var(--radius-full);
    background: var(--component-popover-scrollbar-thumb-bg);
  }
  .search-palette__results::-webkit-scrollbar-thumb:hover,
  .search-palette__group-results.is-work-grid::-webkit-scrollbar-thumb:hover {
    background: var(--component-popover-scrollbar-color);
  }
  @keyframes search-palette-in {
    from { opacity: 0; transform: translate(-50%, -6px) scale(0.985); }
    to { opacity: 1; transform: translate(-50%, 0) scale(1); }
  }
  .search-palette__state { padding: var(--sp-8) var(--sp-4); color: var(--text-secondary); text-align: center; }
  .search-palette__state--compact { padding-block: var(--sp-4); }
  .search-palette__notice { padding: var(--sp-2) var(--sp-3); color: var(--text-secondary); font-size: var(--font-size-xs); }
  @keyframes search-palette-in-narrow {
    from { opacity: 0; transform: translateY(-6px) scale(0.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (max-width: 980px) {
    .search-palette {
      left: calc(var(--shell-sidebar-width) + var(--sp-2));
      right: var(--sp-3);
      width: auto;
      transform: none;
    }
    .search-palette.is-open {
      animation-name: search-palette-in-narrow;
    }
  }
  @media (max-width: 720px) {
    .search-palette {
      --search-work-card-width: clamp(108px, 18vw, 116px);
      top: var(--sp-3);
      max-height: calc(100vh - var(--sp-6));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .search-palette,
    .search-palette.is-open,
    .search-palette__result.is-work-card {
      animation: none;
      transition: none;
    }
  }
</style>
