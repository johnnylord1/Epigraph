<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { gql } from "../../lib/client";
  import { _ } from "../../lib/i18n/runtime";
  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { resolveMangaCoverUrl } from "../../lib/manga/coverResolver";
  import { GET_SOURCES, FETCH_SOURCE_MANGA, GET_TRACKERS, SEARCH_TRACKER, GET_LIBRARY, GET_ALL_TRACKER_RECORDS } from "../../lib/queries";
  import { fetchSourceMangaSearchWithFallback } from "../../lib/manga/sourceSearch";
  import { cache, CACHE_KEYS, getPageSet } from "../../lib/cache";
  import { loadLibrarySnapshot } from "../../lib/library/snapshot";
  import { dedupeSources, dedupeMangaById, dedupeMangaByTitle, shouldHideNsfw, shouldHideSource } from "../../lib/util";
  import { store, updateSettings, setSearchPrefill, setPreviewManga, setExtensionsPanelHint, addToast, setSearchTabHint, setSearchBrowseHint, setSearchSourcesPaneHint, setActiveNovelDetail, setActiveBookId, setActiveManga, setNavPage } from "../../store/state.svelte";
  import type { Manga, Source, Tracker, TrackRecord, TrackSearch } from "../../lib/types";
  import NocturneState from "../shared/NocturneState.svelte";
  import SetupStatusCard from "../shared/SetupStatusCard.svelte";
  import SourcesView from "./SourcesView.svelte";
  import TasteInsightsModal from "./TasteInsightsModal.svelte";
  import { detectSetupState, isSuwayomiSchemaInitializingError, type SetupState } from "../../lib/setupState";
  import { SERVER_READY_EVENT } from "../../lib/serverLifecycle";
  import { ensureExtensionRepo, RECOMMENDED_EXTENSION_REPO } from "../../lib/defaultRepos";
  import AppTopbar from "../layout/AppTopbar.svelte";
  import ActivityButton from "../layout/ActivityButton.svelte";
  import WindowControlsInline from "../layout/WindowControlsInline.svelte";
  import { browseInstalledNovelSource, loadTrustedInstalledNovelSources, readInstalledNovelDetails, searchInstalledNovelSource, shutdownInstalledNovelSourcesRuntime } from "../../lib/novels/sources";
  import { createNovelLibraryId, type InstalledNovelSourceDescriptor, type NovelDetailRecord, type NovelSourceSearchResult } from "../../lib/novels/domain";
  import { isNovelInLibrary, loadNovelLibraryState, peekNovelLibraryState } from "../../lib/novels/libraryState";
  import { NOVEL_TITLE_ALIAS_VERSION, canonicalNovelTitleCandidates } from "../../lib/novels/titleAliases";
  import { classifySourceAccessError, isSourceChallengeMessage, sourceAccessErrorMessage } from "../../lib/sourceAccess";
  import {
    getHardcoverUserBooks,
    getHardcoverRateLimitRemainingMs,
    hardcoverBookToProvider,
    hardcoverRecordToRecommendationCandidate,
    hardcoverRecordToTasteProfileSeed,
    isHardcoverRateLimitError,
    loadHardcoverState,
    matchHardcoverBook,
    searchHardcoverBooks,
    type HardcoverBookSearchResult,
    type HardcoverNovelTrackRecord,
  } from "../../lib/novels/hardcover";
  import {
    buildSearchRecommendations,
    buildTasteProfile,
    mangaToTasteProfileSeed,
    novelToTasteProfileSeed,
    bookToTasteProfileSeed,
    mangaToRecommendationCandidate,
    novelSourceResultToRecommendationCandidate,
    recommendationTitleKey,
    recommendationTrackerRemoteKey,
    type RecommendationCandidate,
    type RecommendationItem,
    type RecommendationProviderSignal,
    type TasteProfileSeedItem,
  } from "../../lib/recommendations";

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

  interface NovelSourceResult {
    source: InstalledNovelSourceDescriptor;
    novels: NovelSourceSearchResult[];
    loading: boolean;
    error: string | null;
  }

  interface BrowseSourceEntry {
    id: string;
    name: string;
    displayName: string;
    lang: string;
    iconUrl: string | null;
    isNsfw: boolean;
    contentKind: "manga" | "novels" | "hardcover";
    mangaSource?: Source;
    novelSource?: InstalledNovelSourceDescriptor;
  }

  type BrowseTrackerEntry = Tracker;

  const loggedSearchRecommendationSourceIssues = new Set<string>();

  function browseTabLabel(tab: SearchTab) {
    if (tab === "keyword") return $_("browse.tabs.search");
    if (tab === "browse") return $_("browse.tabs.discover");
    return $_("browse.tabs.sources");
  }

  function browseSearchPlaceholder() {
    if (activeBrowseTab === "keyword") return $_("browse.search.placeholderKeyword");
    if (activeBrowseTab === "browse") return $_("browse.search.placeholderDiscover");
    return activeContentType === "novels"
      ? $_("browse.search.placeholderNovelSources")
      : $_("browse.search.placeholderExtensions");
  }

  function catalogFeedLabel(feed: CatalogFeed) {
    if (feed === "latest") return $_("ui_latest");
    if (feed === "popular") return $_("ui_popular");
    return $_("ui_all");
  }

  function activeContentTypeLabel() {
    return activeContentType === "novels" ? $_("ui_novels") : $_("ui_manga");
  }

  function sourceSearchPlaceholder() {
    if (src_activeSource) return $_("browse.source.searchPlaceholderNamed", { name: src_activeSource.displayName });
    if (src_activeNovelSource) return $_("browse.source.searchPlaceholderNamed", { name: src_activeNovelSource.name });
    return $_("browse.source.searchPlaceholder");
  }

  function logSearchRecommendationSourceIssue(context: string, sourceName: string, error: unknown) {
    const classification = classifySourceAccessError(error);
    const message = sourceAccessErrorMessage(error);
    const key = `${context}:${sourceName}:${classification.errorType}:${message}`;
    if (loggedSearchRecommendationSourceIssues.has(key)) return;
    loggedSearchRecommendationSourceIssues.add(key);

    const detail = `${context} for ${sourceName}: ${classification.errorType} - ${message}`;
    if (classification.errorType === "unknown") {
      console.warn(`Search recommendations source issue: ${detail}`, error);
      return;
    }
    console.info(`Search recommendations skipped source: ${detail}`);
  }

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
  const SEARCH_SEED_SOURCE_LIMIT_MANGA = 8;
  const SEARCH_SEED_SOURCE_LIMIT_NOVELS = 6;
  const SEARCH_RECOMMENDATION_BASE_LIMIT = 18;
  const SEARCH_RECOMMENDATION_LIMIT_STEP = 7;
  const SEARCH_RECOMMENDATION_MAX_LIMIT = 420;
  const SEARCH_RECOMMENDATION_MIN_SECTION_FILL = 6;
  const SEARCH_RECOMMENDATION_AUTOFILL_TARGET = 32;
  const SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT = 3;
  const SEARCH_RECOMMENDATION_PER_SOURCE_CAP = 60;
  const SEARCH_RECOMMENDATION_MANGA_SEED_CAP = 240;
  const SEARCH_RECOMMENDATION_NOVEL_SEED_CAP = 180;
  const SEARCH_RECOMMENDATION_PROVIDER_RESULT_CAP = 120;
  const SEARCH_RECOMMENDATION_SCROLL_THROTTLE_MS = 160;
  const SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT = 18;
  const SEARCH_RECOMMENDATION_MANGA_AUTOFILL_DUPLICATE_RETRY_LIMIT = 3;
  const TRACKER_SCORE_ENRICHMENT_LIMIT = 32;
  const TRACKER_SCORE_BATCH_SIZE = 12;
  const TRACKER_SCORE_MAL_FALLBACK_LIMIT = 3;
  const TRACKER_SCORE_MAL_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
  const HARDCOVER_SCORE_ENRICHMENT_LIMIT = 6;
  const HARDCOVER_SCORE_ENRICHMENT_CONCURRENCY = 1;
  const HARDCOVER_SCORE_ENRICHMENT_TIMEOUT_MS = 750;
  const HARDCOVER_DISCOVERY_QUERY_LIMIT = 2;
  const HARDCOVER_DISCOVERY_RESULTS_PER_QUERY = 7;
  const HARDCOVER_DISCOVERY_TIMEOUT_MS = 950;
  const HARDCOVER_DISCOVERY_MIN_RATING = 3.25;
  const HARDCOVER_RECORD_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
  const HARDCOVER_BACKGROUND_ENRICHMENT_ENABLED = true;
  const HARDCOVER_BACKGROUND_ENRICHMENT_DELAY_MS = 4500;
  const HARDCOVER_BACKGROUND_ENRICHMENT_MIN_GAP_MS = 15 * 60 * 1000;
  const HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS = 10 * 60 * 1000;
  const NOVEL_SOURCE_REQUEST_TIMEOUT_MS = 850;
  const NOVEL_DETAIL_ENRICHMENT_LIMIT = 3;
  const NOVEL_DETAIL_ENRICHMENT_CONCURRENCY = 1;
  const NOVEL_DETAIL_ENRICHMENT_TIMEOUT_MS = 850;
  const trackerScoreSearchCache = new Map<string, TrackSearch[]>();
  let malTrackerPausedUntil = 0;
  const hardcoverScoreSearchCache = new Map<string, RecommendationProviderSignal | null>();
  let searchHardcoverRecordsRefreshInFlight = false;
  let searchHardcoverRecordsRefreshFailedAt = 0;
  let searchHardcoverRecordsRefreshScopeKey = "";
  let searchHardcoverOnline = $state(false);
  let searchHardcoverAutoPausedUntil = 0;
  let searchHardcoverBackgroundTimer: ReturnType<typeof setTimeout> | null = null;
  const searchHardcoverBackgroundStartedAtByKey = new Map<string, number>();

  function capMangaRecommendationSeeds(items: Manga[]) {
    return items.slice(0, SEARCH_RECOMMENDATION_MANGA_SEED_CAP);
  }

  function capNovelRecommendationSeeds(items: NovelSourceSearchResult[]) {
    return items.slice(0, SEARCH_RECOMMENDATION_NOVEL_SEED_CAP);
  }

  function capProviderResults<T>(items: T[]) {
    return items.slice(0, SEARCH_RECOMMENDATION_PROVIDER_RESULT_CAP);
  }

  function isUsefulHardcoverDiscoveryTag(tag: string) {
    const normalized = tag.trim().toLowerCase();
    if (normalized.length < 4) return false;
    if (!/[a-z]/i.test(normalized)) return false;
    if (/^\d+$/.test(normalized)) return false;
    return ![
      "book",
      "books",
      "novel",
      "novels",
      "webnovel",
      "web novel",
      "light novel",
      "epub",
      "pdf",
      "hardcover",
      "syncd",
      "audit",
      "unknown",
      "source",
      "sources",
      "reading",
      "ongoing",
      "completed",
    ].includes(normalized);
  }

  function capProviderSignalMap(map: Map<string, RecommendationProviderSignal>) {
    return new Map([...map].slice(0, SEARCH_RECOMMENDATION_PROVIDER_RESULT_CAP));
  }

  function clearHardcoverBackgroundTimer() {
    if (!searchHardcoverBackgroundTimer) return;
    clearTimeout(searchHardcoverBackgroundTimer);
    searchHardcoverBackgroundTimer = null;
  }

  function hardcoverScopeInput() {
    return {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };
  }

  function hardcoverAutoCooldownRemainingMs() {
    const localRemaining = Math.max(0, searchHardcoverAutoPausedUntil - Date.now());
    let remoteRemaining = 0;
    try {
      remoteRemaining = getHardcoverRateLimitRemainingMs(hardcoverScopeInput());
    } catch {
      remoteRemaining = 0;
    }
    return Math.max(localRemaining, remoteRemaining);
  }

  function pauseHardcoverBackgroundEnrichment(error?: unknown) {
    const cooldownMs = isHardcoverRateLimitError(error)
      ? HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS
      : Math.min(HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS, HARDCOVER_RECORD_REFRESH_COOLDOWN_MS);
    searchHardcoverAutoPausedUntil = Date.now() + cooldownMs;
    searchHardcoverOnline = false;
    clearHardcoverBackgroundTimer();
  }

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

  async function runConcurrentLimited<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let i = 0;
    async function worker() {
      while (i < items.length) {
        if (signal.aborted) return;
        const item = items[i++];
        await fn(item).catch(() => {});
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(fallback);
      }, timeoutMs);
      promise.then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      }).catch(() => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(fallback);
      });
    });
  }

  function normalizeBrowseSourceName(value: string) {
    return value
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\b(novel|novels|source|sources|lnreader|extension)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function interleaveNovelRecommendationSources(sources: BrowseSourceEntry[]) {
    const buckets = new Map<string, BrowseSourceEntry[]>();
    for (const source of sources) {
      if (!source.novelSource) continue;
      const nameKey = normalizeBrowseSourceName(source.displayName || source.name) || source.id;
      const bucket = buckets.get(nameKey) ?? [];
      bucket.push(source);
      buckets.set(nameKey, bucket);
    }

    const preferredLanguageRank = (source: BrowseSourceEntry) => {
      if (src_selectedLang !== "all") return source.lang === src_selectedLang ? 0 : 1;
      if (source.lang === preferredLang) return 0;
      if (source.lang === "en") return 1;
      if (source.lang === "pt" || source.lang === "pt-BR") return 2;
      return 3;
    };

    for (const bucket of buckets.values()) {
      bucket.sort((left, right) =>
        (preferredLanguageRank(left) - preferredLanguageRank(right))
        || left.displayName.localeCompare(right.displayName)
        || left.id.localeCompare(right.id),
      );
    }

    const orderedBuckets = [...buckets.entries()]
      .sort((a, b) => {
        const left = a[1][0];
        const right = b[1][0];
        if (!left || !right) return 0;
        return (preferredLanguageRank(left) - preferredLanguageRank(right))
          || a[0].localeCompare(b[0]);
      })
      .map(([, bucket]) => bucket);

    const interleaved: BrowseSourceEntry[] = [];
    let added = true;
    while (added) {
      added = false;
      for (const bucket of orderedBuckets) {
        const next = bucket.shift();
        if (!next) continue;
        interleaved.push(next);
        added = true;
      }
    }
    return interleaved;
  }

  function novelRecommendationFallbackTerms() {
    const genericTerms = ["fantasy", "romance", "adventure", "action"];
    const profileTerms = activeContentType === "novels"
      ? searchNovelProfileOnly.topTags
        .map((tag) => formatTasteTag(tag).trim())
        .filter((tag) => tag.length > 2)
        .filter((tag) => !["book", "novel", "webnovel", "epub", "pdf", "hardcover"].includes(tag.toLowerCase()))
      : [];
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const term of [...profileTerms, ...genericTerms]) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(term);
      if (terms.length >= 4) break;
    }
    return terms;
  }

  function novelSourceLocalizedFallbackTerms(source: BrowseSourceEntry, baseTerms: string[]) {
    const lang = `${source.lang} ${source.name} ${source.displayName}`.toLowerCase();
    const localized = lang.includes("portugu")
      || lang.includes("pt")
      || lang.includes("br")
      ? ["fantasia", "romance", "ação", "aventura"]
      : lang.includes("中文") || lang.includes("汉语") || lang.includes("漢語") || lang.includes("chinese")
        ? ["玄幻", "都市", "仙侠", "奇幻"]
        : [];
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const term of [...localized, ...baseTerms]) {
      const normalized = term.trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(normalized);
      if (terms.length >= 5) break;
    }
    return terms;
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
          source { id name lang displayName }
        }
        pageInfo { hasNextPage }
        totalCount
      }
    }
  `;

  let browseTab: BrowseTab = $state("featured");
  let activeContentType = $state<"manga" | "novels">("manga");
  let activeBrowseTab = $state<SearchTab>("keyword");
  let searchRecommendationsReady = $state(false);
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
  let searchTrackerScoreResults = $state<TrackSearch[]>([]);
  let searchTrackerTrendingResults = $state<TrackSearch[]>([]);
  let searchTrackerTrendingLoading = $state(false);
  let searchTrackerTrendingKey = $state("");
  let searchTrackerTrendingPage = $state(2);
  let searchTrackerScoreLoading = $state(false);
  let searchTrackerScoreKey = $state("");
  let searchTrackerScoreAbortCtrl: AbortController | null = null;
  let pendingPrefill         = $state("");
  let novelLibraryState = $state(safePeekNovelLibraryState());
  let searchLibraryManga: Manga[] = $state([]);
  let searchTrackRecordsByMangaId: Map<number, TrackRecord[]> = $state(new Map());
  let searchTrackRecords: TrackRecord[] = $state([]);
  let searchTrackerSeedItems: TasteProfileSeedItem[] = $state([]);
  let searchTrackerRecordCandidates: RecommendationCandidate[] = $state([]);
  let searchSourceSeedResults: Manga[] = $state([]);
  let searchFreshSourceSeedResults: Manga[] = $state([]);
  let searchSourceSeedFetchedAt: number | null = $state(null);
  let searchNovelSourceSeedResults: NovelSourceSearchResult[] = $state([]);
  let searchHardcoverRecords: HardcoverNovelTrackRecord[] = $state([]);
  let searchHardcoverDiscoveryResults: RecommendationCandidate[] = $state([]);
  let searchHardcoverDiscoveryLoading = $state(false);
  let searchHardcoverDiscoveryKey = $state("");
  let searchHardcoverDiscoveryRun = 0;
  let searchHardcoverScoreResults: Map<string, RecommendationProviderSignal> = $state(new Map());
  let searchHardcoverScoreLoading = $state(false);
  let searchHardcoverScoreKey = $state("");
  let searchHardcoverScoreRun = 0;
  let searchNovelDetailTagsByKey: Map<string, string[]> = $state(new Map());
  let searchNovelDetailUpdatedAtByKey: Map<string, number> = $state(new Map());
  let searchNovelDetailTagsKey = $state("");
  let searchNovelDetailTagsRun = 0;
  let searchSourceSeedLoading = $state(false);
  let searchSourceSeedKey = $state("");
  let searchSourceSeedAbortCtrl: AbortController | null = null;
  let searchMangaSeedAutofillKey = $state("");
  let searchMangaSeedAutofillPage = $state(1);
  let searchMangaSeedAutofillLoading = $state(false);
  let searchMangaSeedAutofillExhausted = $state(false);
  let searchNovelSeedAutofillKey = $state("");
  let searchNovelSeedAutofillPage = $state(1);
  let searchNovelSeedAutofillLoading = $state(false);
  let searchNovelSeedAutofillExhausted = $state(false);
  let searchIncludeLibrary = $state(false);
  let failedSearchCoverKeys: Set<string> = $state(new Set());
  let searchRecommendationVisibleLimits: Map<string, number> = $state(new Map());
  let searchRecommendationMoreLoadingKeys: Set<string> = $state(new Set());
  let searchRecommendationMoreExhaustedKeys: Set<string> = $state(new Set());
  let searchRecommendationMorePages: Map<string, number> = $state(new Map());
  let searchRecommendationMoreTriggeredAt: Map<string, number> = $state(new Map());
  let searchRecommendationMoreRequestedWidths: Map<string, number> = $state(new Map());
  let searchRecommendationSectionOrder: Map<string, string[]> = $state(new Map());
  let lastSearchRuntimeScopeKey = $state("");

  const searchRuntimeScopeKey = $derived([
    store.runtimeResolvedLocalProfileId ?? "default",
    store.runtimeServerUrl ?? "",
  ].join("::"));

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
        title: result.status === translate("ui_added") ? translate("ui_recommendedRepoAdded") : translate("ui_recommendedRepoAlreadyAdded"),
        body: result.status === translate("ui_added")
          ? `${result.repo.name} is ready. Next, install your first extension.`
          : `${result.repo.name} is already configured. Next, install your first extension.`,
      });
      await refreshSetupState();
      activeBrowseTab = "source";
    } catch (error) {
      addToast({
        kind: "error",
        title: translate("ui_couldNotAddTheRecommendedRepo"),
        body: error instanceof Error ? error.message : translate("ui_aethonCouldnTSaveTheRecommendedRepo"),
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
    releaseSearchRecommendationTransientState();
    activeContentType = next;
    resetContentTypeTransientState();
    if (activeBrowseTab !== "keyword") {
      searchQuery = "";
    }
    if (activeBrowseTab === "keyword" && kw_submitted) {
      const hasCachedResults = next === "novels" ? kw_novelResults.length > 0 : kw_results.length > 0;
      if (!hasCachedResults) void kwDoSearch(kw_submitted);
    }
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

  function resetSearchRecommendationSeedState() {
    searchSourceSeedAbortCtrl?.abort();
    searchSourceSeedAbortCtrl = null;
    searchSourceSeedResults = [];
    searchFreshSourceSeedResults = [];
    searchNovelSourceSeedResults = [];
    searchNovelDetailTagsByKey = new Map();
    searchNovelDetailUpdatedAtByKey = new Map();
    searchNovelDetailTagsKey = "";
    searchSourceSeedKey = "";
    searchSourceSeedLoading = false;
    searchTrackerTrendingResults = [];
    searchTrackerTrendingLoading = false;
    searchTrackerTrendingKey = "";
    searchTrackerTrendingPage = 2;
    searchMangaSeedAutofillKey = "";
    searchMangaSeedAutofillPage = 1;
    searchMangaSeedAutofillLoading = false;
    searchMangaSeedAutofillExhausted = false;
    searchNovelSeedAutofillKey = "";
    searchNovelSeedAutofillPage = 1;
    searchNovelSeedAutofillLoading = false;
    searchNovelSeedAutofillExhausted = false;
    searchRecommendationVisibleLimits = new Map();
    searchRecommendationMoreLoadingKeys = new Set();
    searchRecommendationMoreExhaustedKeys = new Set();
    searchRecommendationMorePages = new Map();
    searchRecommendationMoreTriggeredAt = new Map();
    searchRecommendationMoreRequestedWidths = new Map();
    searchRecommendationSectionOrder = new Map();
  }

  function releaseSearchRecommendationTransientState() {
    clearHardcoverBackgroundTimer();
    searchTrackerScoreAbortCtrl?.abort();
    searchSourceSeedAbortCtrl?.abort();
    searchTrackerScoreAbortCtrl = null;
    searchSourceSeedAbortCtrl = null;

    searchTrackerScoreResults = [];
    searchTrackerTrendingResults = [];
    searchTrackerRecordCandidates = [];
    searchTrackerSeedItems = [];
    searchSourceSeedResults = [];
    searchFreshSourceSeedResults = [];
    searchNovelSourceSeedResults = [];
    searchHardcoverRecords = [];
    searchHardcoverDiscoveryResults = [];
    searchHardcoverScoreResults = new Map();
    searchNovelDetailTagsByKey = new Map();
    searchNovelDetailUpdatedAtByKey = new Map();
    failedSearchCoverKeys = new Set();
    searchRecommendationVisibleLimits = new Map();
    searchRecommendationMoreLoadingKeys = new Set();
    searchRecommendationMoreExhaustedKeys = new Set();
    searchRecommendationMorePages = new Map();
    searchRecommendationMoreTriggeredAt = new Map();
    searchRecommendationMoreRequestedWidths = new Map();
    searchRecommendationSectionOrder = new Map();

    searchTrackerScoreLoading = false;
    searchTrackerTrendingLoading = false;
    searchHardcoverDiscoveryLoading = false;
    searchHardcoverScoreLoading = false;
    searchSourceSeedLoading = false;
    searchMangaSeedAutofillLoading = false;
    searchNovelSeedAutofillLoading = false;
    searchMangaSeedAutofillKey = "";
    searchMangaSeedAutofillPage = 1;
    searchMangaSeedAutofillExhausted = false;
    searchNovelSeedAutofillKey = "";
    searchNovelSeedAutofillPage = 1;
    searchNovelSeedAutofillExhausted = false;
  }

  function releaseBrowseTransientState() {
    clearHardcoverBackgroundTimer();
    kw_abortCtrl?.abort();
    tag_abortLocal?.abort();
    tag_abortSource?.abort();
    src_abortCtrl?.abort();
    discoverAbortCtrl?.abort();
    searchTrackerScoreAbortCtrl?.abort();
    searchSourceSeedAbortCtrl?.abort();

    kw_abortCtrl = null;
    tag_abortLocal = null;
    tag_abortSource = null;
    src_abortCtrl = null;
    discoverAbortCtrl = null;
    searchTrackerScoreAbortCtrl = null;
    searchSourceSeedAbortCtrl = null;

    kw_results = [];
    kw_novelResults = [];
    tag_localResults = [];
    tag_sourceResults = [];
    tag_srcNextPage = new Map();
    src_browseResults = [];
    src_novelBrowseResults = [];
    discoverMangaResults = [];
    discoverNovelResults = [];
    trackerCatalogResults = [];
    searchTrackerScoreResults = [];
    searchTrackerTrendingResults = [];
    searchTrackerRecordCandidates = [];
    searchTrackerSeedItems = [];
    searchSourceSeedResults = [];
    searchFreshSourceSeedResults = [];
    searchNovelSourceSeedResults = [];
    searchHardcoverRecords = [];
    searchHardcoverDiscoveryResults = [];
    searchHardcoverScoreResults = new Map();
    searchNovelDetailTagsByKey = new Map();
    searchNovelDetailUpdatedAtByKey = new Map();
    failedSearchCoverKeys = new Set();
    searchRecommendationVisibleLimits = new Map();
    searchRecommendationMoreLoadingKeys = new Set();
    searchRecommendationMoreExhaustedKeys = new Set();
    searchRecommendationMorePages = new Map();
    searchRecommendationMoreTriggeredAt = new Map();
    searchRecommendationMoreRequestedWidths = new Map();
    searchRecommendationSectionOrder = new Map();

    discoverLoading = false;
    discoverLoadingMore = false;
    trackerCatalogLoading = false;
    trackerCatalogLoadingMore = false;
    searchTrackerScoreLoading = false;
    searchTrackerTrendingLoading = false;
    searchHardcoverDiscoveryLoading = false;
    searchHardcoverScoreLoading = false;
    searchSourceSeedLoading = false;
    searchMangaSeedAutofillLoading = false;
    searchNovelSeedAutofillLoading = false;
    tag_loadingLocal = false;
    tag_loadingMoreLocal = false;
    tag_loadingSourceSearch = false;
    tag_loadingMoreSource = false;
    src_loadingBrowse = false;
  }

  $effect(() => {
    const scopeKey = searchRuntimeScopeKey;
    if (!scopeKey || scopeKey === lastSearchRuntimeScopeKey) return;
    const previousScopeKey = lastSearchRuntimeScopeKey;
    lastSearchRuntimeScopeKey = scopeKey;
    if (!previousScopeKey) return;

    untrack(() => {
      releaseBrowseTransientState();
      setupState = null;
      setupLoading = true;
      allSources = [];
      allNovelSources = [];
      allTrackers = [];
      searchLibraryManga = [];
      searchTrackRecords = [];
      searchTrackRecordsByMangaId = new Map();
      novelLibraryState = null;
      void refreshSetupState();
      void refreshSources();
      void refreshTrackers();
      void refreshSearchProfileLibrary();
      void refreshSearchTrackRecords();
      void refreshSearchHardcoverRecords();
      void loadNovelLibraryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }).then((state) => {
        novelLibraryState = state;
      }).catch(() => {});
    });
  });

  function resetContentTypeTransientState() {
    src_abortCtrl?.abort();
    src_activeSource = null;
    src_activeNovelSource = null;
    src_browseQuery = "";
    src_submitted = "";
    src_loadingBrowse = false;
    selectedSource = "";
    discoverSelectedSource = "";
    discoverSelectedTracker = null;
    discoverMangaResults = [];
    discoverNovelResults = [];
    discoverLoadedKey = "";
    discoverError = "";
    discoverCurrentPage = 1;
    discoverHasNextPage = false;
    discoverLoading = false;
    discoverLoadingMore = false;
    catalogSourcePickerOpen = false;
    catalogLanguagePickerOpen = false;
    catalogTrackingPickerOpen = false;
    tag_loadingSourceSearch = false;
    tag_loadingMoreSource = false;
    if (searchSourceSeedLoading) {
      searchSourceSeedAbortCtrl?.abort();
      searchSourceSeedAbortCtrl = null;
      searchSourceSeedLoading = false;
      searchSourceSeedKey = "";
    }
    searchMangaSeedAutofillKey = "";
    searchMangaSeedAutofillPage = 1;
    searchMangaSeedAutofillLoading = false;
    searchMangaSeedAutofillExhausted = false;
    searchNovelSeedAutofillKey = "";
    searchNovelSeedAutofillPage = 1;
    searchNovelSeedAutofillLoading = false;
    searchNovelSeedAutofillExhausted = false;
    searchTrackerTrendingResults = [];
    searchTrackerTrendingLoading = false;
    searchTrackerTrendingKey = "";
    searchTrackerTrendingPage = 2;
  }

  function selectBrowseTab(next: SearchTab) {
    if (activeBrowseTab === "keyword" && next !== "keyword") {
      releaseSearchRecommendationTransientState();
    }
    activeBrowseTab = next;
    if (next === "keyword") {
      searchQuery = kw_query || kw_submitted;
    } else if (next === "browse") {
      searchQuery = tag_tagFilter;
    } else {
      searchQuery = "";
    }
    if (next === "browse") {
      resetSourceBrowseState();
    }
  }

  function handleSearch(query: string) {
    const normalized = query.trim();
    searchQuery = normalized;

    if (activeBrowseTab === "keyword") {
      kw_query = normalized;
      if (normalized) kwDoSearch(normalized);
      return;
    }

    if (activeBrowseTab === "browse") {
      tag_tagFilter = normalized;
      return;
    }

    searchQuery = normalized;
  }

  function handleTopbarSearchInput(query: string) {
    if (activeBrowseTab === "keyword") {
      kw_query = query;
      if (!query.trim()) {
        kw_abortCtrl?.abort();
        kw_submitted = "";
        kw_results = [];
        kw_novelResults = [];
      }
      return;
    }

    if (activeBrowseTab === "browse") {
      tag_tagFilter = query;
      return;
    }

    searchQuery = query;
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
      const [mangaSources, novelSources] = await Promise.allSettled([
        gql<{ sources: { nodes: Source[] } }>(GET_SOURCES),
        loadTrustedInstalledNovelSources({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        }),
      ]);
      if (mangaSources.status === "fulfilled") {
        allSources = mangaSources.value.sources.nodes.filter((src: Source) => src.id !== "0");
      } else {
        if (!isSuwayomiSchemaInitializingError(mangaSources.reason)) {
          console.warn("Could not refresh manga sources for Browse.", mangaSources.reason);
        }
        allSources = [];
      }
      if (novelSources.status === "fulfilled") {
        allNovelSources = novelSources.value;
      } else {
        console.warn("Could not refresh novel sources for Browse.", novelSources.reason);
        allNovelSources = [];
      }
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
      if (!isSuwayomiSchemaInitializingError(error)) console.error(error);
      allTrackers = [];
    } finally {
      loadingTrackers = false;
    }
  }

  async function refreshSearchProfileLibrary() {
    const scope = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };
    const persistedSnapshot = loadLibrarySnapshot(scope);
    const snapshot = persistedSnapshot?.mangas ?? [];
    if (snapshot.length > 0) {
      searchLibraryManga = snapshot;
    } else {
      searchLibraryManga = [];
    }

    try {
      const data = await gql<{ mangas?: { nodes?: Manga[] } }>(GET_LIBRARY);
      const previousChapterCountById = new Map(snapshot.map((manga) => [manga.id, manga.chapterCount]));
      searchLibraryManga = (data.mangas?.nodes ?? []).map((manga: any) => ({
        ...manga,
        chapterCount: manga.chapters?.totalCount ?? manga.chapterCount ?? previousChapterCountById.get(manga.id) ?? 0,
      }));
      store.setLibraryMangaSnapshot(searchLibraryManga);
    } catch (error) {
      if (!isSuwayomiSchemaInitializingError(error)) console.error(error);
      searchLibraryManga = [];
    }
  }

  async function refreshSearchTrackRecords() {
    try {
      const data = await gql<{
        trackers: {
          nodes: Array<BrowseTrackerEntry & {
            trackRecords?: { nodes: Array<TrackRecord & { manga?: Manga | null }> };
          }>;
        };
      }>(GET_ALL_TRACKER_RECORDS);

      const byMangaId = new Map<number, TrackRecord[]>();
      const candidateByMangaId = new Map<number, RecommendationCandidate>();
      const allRecords: TrackRecord[] = [];
      const trackerSeeds: TasteProfileSeedItem[] = [];
      for (const tracker of data.trackers.nodes ?? []) {
        for (const record of tracker.trackRecords?.nodes ?? []) {
          const normalizedRecord: TrackRecord = {
            ...record,
            trackerId: record.trackerId ?? tracker.id,
            remoteId: record.remoteId ?? "",
            score: Number.isFinite(record.score) ? record.score : 0,
            displayScore: record.displayScore ?? "",
            startDate: record.startDate ?? null,
            finishDate: record.finishDate ?? null,
          };
          allRecords.push(normalizedRecord);
          trackerSeeds.push(trackRecordToTasteProfileSeed(normalizedRecord, record.manga ?? null, tracker));

          const mangaId = record.manga?.id;
          if (typeof mangaId !== "number") continue;
          const next = byMangaId.get(mangaId) ?? [];
          next.push(normalizedRecord);
          byMangaId.set(mangaId, next);

          if (!record.manga?.inLibrary) {
            candidateByMangaId.set(mangaId, trackerRecordToRecommendationCandidate(normalizedRecord, record.manga, tracker));
          }
        }
      }
      searchTrackRecordsByMangaId = byMangaId;
      searchTrackRecords = allRecords;
      searchTrackerSeedItems = trackerSeeds;
      searchTrackerRecordCandidates = [...candidateByMangaId.values()];
    } catch (error) {
      console.error(error);
      searchTrackRecordsByMangaId = new Map();
      searchTrackRecords = [];
      searchTrackerSeedItems = [];
      searchTrackerRecordCandidates = [];
    }
  }

  async function refreshSearchHardcoverRecords() {
    const scopeInput = hardcoverScopeInput();
    const scopeKey = `${scopeInput.profileId ?? ""}:${scopeInput.serverUrl ?? ""}`;
    if (scopeKey !== searchHardcoverRecordsRefreshScopeKey) {
      searchHardcoverRecordsRefreshScopeKey = scopeKey;
      searchHardcoverRecordsRefreshFailedAt = 0;
      searchHardcoverOnline = false;
    }
    let state;
    try {
      state = loadHardcoverState(scopeInput);
    } catch (error) {
      console.warn("Could not read Hardcover cache for search recommendations.", error);
      searchHardcoverRecords = [];
      return;
    }
    if (!state.auth.connected) {
      searchHardcoverRecords = state.records;
      searchHardcoverOnline = false;
      return;
    }
    if (hardcoverAutoCooldownRemainingMs() > 0) {
      searchHardcoverRecords = state.records;
      searchHardcoverOnline = false;
      return;
    }
    if (searchHardcoverRecordsRefreshInFlight) return;
    if (searchHardcoverRecordsRefreshFailedAt > 0 && Date.now() - searchHardcoverRecordsRefreshFailedAt < HARDCOVER_RECORD_REFRESH_COOLDOWN_MS) {
      searchHardcoverRecords = state.records;
      return;
    }

    try {
      searchHardcoverRecordsRefreshInFlight = true;
      searchHardcoverRecords = await getHardcoverUserBooks(scopeInput);
      searchHardcoverRecordsRefreshFailedAt = 0;
      searchHardcoverOnline = true;
    } catch (error) {
      console.warn("Could not refresh Hardcover user books; using cached novel tracking.", error);
      searchHardcoverRecordsRefreshFailedAt = Date.now();
      pauseHardcoverBackgroundEnrichment(error);
      searchHardcoverRecords = state.records;
    } finally {
      searchHardcoverRecordsRefreshInFlight = false;
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
      refreshSearchProfileLibrary();
      refreshSearchTrackRecords();
      refreshSearchHardcoverRecords();
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
  let kw_novelResults: NovelSourceResult[] = $state([]);
  let kw_selectedLangs: Set<string>  = $state(new Set());
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

  function kwGetVisibleNovelSources(): InstalledNovelSourceDescriptor[] {
    let filtered = allNovelSources.filter((source) => source.enabled);
    const hasSelectedNovelLang = filtered.some((source) => kw_selectedLangs.has(source.lang));
    if (kw_selectedLangs.size > 0 && hasSelectedNovelLang) {
      filtered = filtered.filter((source) => kw_selectedLangs.has(source.lang));
    }
    return filtered;
  }

  async function kwDoSearch(q: string) {
    if (setupState?.kind && setupState.kind !== "ready") return;
    const trimmed = q.trim();
    if (!trimmed) return;
    if (activeContentType === "novels") {
      await kwDoNovelSearch(trimmed);
      return;
    }
    const visible = kwGetVisibleSources();
    if (!visible.length) return;
    kw_abortCtrl?.abort();
    const ctrl = new AbortController();
    kw_abortCtrl = ctrl;
    kw_submitted = trimmed;
    kw_results   = visible.map((src) => ({ source: src, mangas: [], loading: true, error: null }));
    kw_novelResults = [];
    await runConcurrent(visible, async (src) => {
      if (ctrl.signal.aborted) return;
      try {
        const mangas = await fetchSourceMangaSearchWithFallback({
          sourceId: src.id,
          query: trimmed,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        const visibleMangas = withMangaSourceMetadata(
          mangas.filter((m) => !shouldHideNsfw(m, store.settings)),
          src,
        );
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

  async function kwDoNovelSearch(trimmed: string) {
    const visible = kwGetVisibleNovelSources();
    kw_abortCtrl?.abort();
    const ctrl = new AbortController();
    kw_abortCtrl = ctrl;
    kw_submitted = trimmed;
    kw_results = [];
    if (!visible.length) {
      kw_novelResults = [];
      return;
    }
    kw_novelResults = visible.map((source) => ({ source, novels: [], loading: true, error: null }));
    await runConcurrent(visible, async (source) => {
      if (ctrl.signal.aborted) return;
      try {
        const novels = await searchInstalledNovelSource({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        }, source.pluginId, trimmed, 1);
        if (ctrl.signal.aborted) return;
        kw_novelResults = kw_novelResults.map((result) =>
          result.source.pluginId === source.pluginId ? { ...result, novels, loading: false } : result,
        );
      } catch (error: any) {
        if (ctrl.signal.aborted || error?.name === "AbortError") return;
        kw_novelResults = kw_novelResults.map((result) =>
          result.source.pluginId === source.pluginId ? { ...result, loading: false, error: sourceBrowseErrorBody(error) } : result,
        );
      }
    }, ctrl.signal);
  }

  const kw_hasResults   = $derived(kw_results.some((r) => r.mangas.length > 0));
  const kw_hasNovelResults = $derived(kw_novelResults.some((r) => r.novels.length > 0));
  const kw_allDone      = $derived(
    activeContentType === "novels"
      ? kw_novelResults.length > 0 && kw_novelResults.every((r) => !r.loading)
      : kw_results.length > 0 && kw_results.every((r) => !r.loading),
  );
  const kw_contentVisibleSources = $derived(allSources.filter((source) => !shouldHideSource(source, store.settings)));

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

  const searchFallbackCandidates: RecommendationCandidate[] = [
    makeFallbackCandidate("A Returner's Magic Should Be Special", ["Action", "Fantasy", "Regression"], "manga", "https://lh3.googleusercontent.com/aida-public/AB6AXuDYXs83Kw7tM_YZ4Z7DQ1wI_8yfsRvwNQZbkp9vBgnG20lmsGqRSDw4Rfpg_uSkIdNdMBEwxRsSpEcq-_o-xwd9QmPiTIPIcwUbO7k9yfwTKB7tJ1iE0_0gZa5wJLQcPuivhj9_1yaWk2uwzQsN4ew7vVwMjdAAFD27231M40yv_8pL-t3z_24BYoYUWNyl0eSNHSECipCGDUEvMS00OZg9iLXQZkAYb3bKjuyONj3oFbJLJr3k7awUPIvF6rqsWDGP-EM10Ej9VU4", 0.87, 0.72),
    makeFallbackCandidate("The Beginning After the End", ["Action", "Fantasy", "Reincarnation"], "manhwa", "https://lh3.googleusercontent.com/aida-public/AB6AXuBkieSfCi7cZtbEQoZ3OCmtxNtWmbg-fla9hAK2lmx24CveX9qgthQox0F5Us_3l9ftd8-6JdCp0ragSXMDp-zT3jxMy_XbCFjEfw1eZ46oMYf3wR-z3-Qo8rQ0T1G-YmRb-npZLso-zptml2SBoIVLbtjE0ICuQFFygS-GIXxctUKPexMcUs2qBlaET7N_BUe2AtSxYmzLJ_cUvgzaRL6D03kKYkIC7Nb891T0YC_5HAkI32ObGD-HV-hX7bCRdpBv16D5oJ0MWWQ", 0.85, 0.8),
    makeFallbackCandidate("Solo Leveling", ["Action", "Dungeon", "Progression"], "manhwa", "https://lh3.googleusercontent.com/aida-public/AB6AXuCotnl4-ZqJJO75AQby_NTbNPiKXUVmDK-DnXHYAJ-WMm3fsCoSkB4b0yhFFRGsgbhWRpTmfy1UZLBnFusEyNycpgNKlZrNd0z4SA--HxVFDxAQDpScbWvAJPVPMsjnKHg4bklQu1ZN0iHKlZn8jNivMNwS3b1I8adXcuMsouAvISfiFYVEjBesnBmw7XYrKg0tJTcwDw4_u_6BZvE14-HMFP9pDJgigpXR2eKdNOOZoB-upkFNweeqaWY4th6aQsNDKO-IhAnNmyA", 0.83, 0.92),
    makeFallbackCandidate("Omniscient Reader's Viewpoint", ["Action", "Mystery", "Regression"], "manhwa", "https://lh3.googleusercontent.com/aida-public/AB6AXuCAdKiWKcUA0CqpT0OZxS_L0Hc-C3NrtJcziaZqPIDPn79qXLbmIy3SrdEbK2qAoi8Y3Bh3fXSzKVKZeNxDZ2n-a8UjSmisLbsQ5mWPrtl260ZtO0c_4TA1bc-sW70kyRiubYBvBeH8OIjbthrJOZKiuDJg0_Rg9S3C9ss0tS53hSompLHWoOGLqsrcjh4IplGmK6JWSitOyy9yudB-e0g7DxAT5nbxOeBb2K8u9ZiIYrdNJQW4T3Q0uz4DvzWBrZS8EimPvzc287Y", 0.86, 0.86),
    makeFallbackCandidate("Return of the Mount Hua Sect", ["Action", "Martial Arts", "Regression"], "manhwa", "https://lh3.googleusercontent.com/aida-public/AB6AXuCVcnwyahABwgNKK5aVNk54Hn8Pwjc8Z-xosURylm0UU9oqVEYEJ7_lS7K27KpEB2OrsQEIzD-01UuqYGphUEsRTwDJJMHzg5psdto5vRcMjt_oSJZNGxAGtgZpmmHRfVTPnRpuSJuOrmW_EyYCdF6R5Gf_vZpM4cdNIq784Sj-FQD4xLbW5A_9MEKlaLwcj3PkJ9TMYaMRgEsiihQigG9IaLY04aHa_YWzqdeVbEj5CqZLfXeI8PUSG9Jpr_XdchcT4b-8PZ-j7yI", 0.84, 0.76),
    makeFallbackCandidate("Frieren Beyond Journey's End", ["Fantasy", "Adventure", "Slice of Life"], "manga", "https://lh3.googleusercontent.com/aida-public/AB6AXuC_-T33cnj7eyf6Y0_ufVew7JJp1EtRSD5qL7dfG-8srrSuFGjZBVBiedoDFjVMmqLEqZqcovzkuuLycKuATwqfUTuPqr4rDrNk1_A-fMNpPAaRo9dfgpanzrUqOl1di6zjL55IlwqFBZpvU7-FFYxRrjNXud_re0E1eUU-PaquIqk4Nbt2UDGGJmoMXLPjGeRAPOPrJN44pJk5RtGaFdRCqMzWKIK_q5Eki1IDbwTKdntT9J0t42UaOuhJmG8EZa-Hu-OcsVaBelU", 0.81, 0.36),
    makeFallbackCandidate("Vagabond", ["Historical", "Martial Arts", "Seinen"], "manga", "https://lh3.googleusercontent.com/aida-public/AB6AXuCNzuwHTnUkbUR3TGIgHNyRDX1XOOuGWu7sPNbEYYfkc8hN0VSeR5jsQgf_uIzS_1KvMwGN1LbTKIS-CMoyqguU8oapUsKGL8Zk2h5TnlmhalLfCt7GNlg_EPEwGuKOeZuxfk_y2Mh8dflZJ9-k_QdFT9I-K41-u5BsI3TkBEB5xy_t9IcSzMUOuH25q7HQRb9n-p1j6qH4FUrmg8txZ0UCRew3BcyIi6J2R72WlPWaOGzvWQ9eG9O9m3lbNF0jCXq1Z5ftLQ50F8s", 0.9, 0.22),
    makeFallbackCandidate("Monster", ["Mystery", "Psychological", "Seinen"], "manga", "https://lh3.googleusercontent.com/aida-public/AB6AXuDvlXvAPmD_YsRB6QKgR663fq2mYeW4x1Xz5NXZ6vzyEwzPj_fDr4_5dr5mMyp3VdiWwcIw1pkgBacP-YrGP_9uR0B6WpRq2FLrNDIjquEh-8ZkygP5h1BsvV58OjvjipXn9OFI4P9R5pCQggoFWusahHTvxvY64yo4S2ympvS0XMDkB7eTaZ9gy5tbDx5M41Q20YVbF7y8E2FBDpViJhp4citSkj9YU8Wpa70-m20hPiij5UxrwJ5w4YU0wHGxAqNg51lx3qjZnX8", 0.88, 0.2),
    makeFallbackCandidate("Lord of the Mysteries", ["Mystery", "Fantasy", "Progression"], "novel", "https://lh3.googleusercontent.com/aida-public/AB6AXuChEAKCeRq0CvkaGb6xFlIJ0cip1D9s1jB-TbS_93qUxxjolXUXjNAxop8XMZ_J3Vv_vWlsP-EZYqvU0dgFNoMBt-VponmxURMsId7QxosU8MePUlbFZJixA_SXdaB4ocYgC4yBVJG9UZI4cCrpRxrv816AeILt8VpIXeJ9HjOS8_WTjufDUMvVdwfDeERSR3Scqxv-4lo8lnzJ9XQKJfrmCJCU47ibBzvUiFlszCsqOSLntwMTdAYHUCpEBzzwYdPqtIcfXPVCgLA", 0.86, 0.55),
  ];

  const searchFallbackSeeds = searchFallbackCandidates.map((candidate, index) => ({
    id: `seed:${candidate.id}`,
    title: candidate.title,
    tags: candidate.tags,
    contentType: candidate.contentType,
    sourceId: candidate.providers[0]?.providerId ?? "mockup",
    userRating: index < 5 ? 8.5 : null,
    userRatingMax: 10,
    implicitWeight: index < 5 ? 0.8 : 0.35,
    status: index < 5 ? "reading" as const : "completed" as const,
  }));

  const searchSourceMangaPool = $derived.by(() => balanceMangaBySource(
    dedupeMangaByTitle(
      dedupeMangaById([
        ...searchSourceSeedResults,
        ...searchFreshSourceSeedResults,
      ]),
      store.settings.mangaLinks,
    ).filter(shouldShowCatalogManga),
  ));

  const searchFreshSourceMangaCandidates = $derived.by(() =>
    searchFreshSourceSeedResults.map((manga) => {
      const candidate = mangaToRecommendationCandidate(manga, { nowMs: searchSourceSeedFetchedAt ?? undefined });
      return {
        ...candidate,
        updatedAtMs: searchSourceSeedFetchedAt,
        providers: candidate.providers.map((provider) => provider.kind === "source"
          ? {
              ...provider,
              recency: { value: 1, confidence: 0.72, method: "source-latest-feed" },
            }
          : provider),
      };
    }),
  );

  const searchNovelSourceById = $derived.by(() =>
    new Map(allNovelSources.map((source) => [source.pluginId, source])),
  );

  const searchNovelSourcePool = $derived.by(() => balanceNovelSourceResults(dedupeNovelSourceResults([
    ...searchNovelSourceSeedResults,
  ])));

  const searchHardcoverProviderByTitleKey = $derived.by(() => {
    const providers = new Map<string, RecommendationProviderSignal>();
    for (const record of searchHardcoverRecords) {
      const candidate = hardcoverRecordToRecommendationCandidate(record);
      const provider = candidate.providers.find((entry) => entry.providerId === "hardcover");
      if (provider) providers.set(recommendationTitleKey(record.title, "novel"), provider);
    }
    for (const [key, provider] of searchHardcoverScoreResults) {
      providers.set(key, provider);
    }
    return providers;
  });

  const searchNovelSourceCandidates = $derived.by(() =>
    searchNovelSourcePool.map((result) => {
      const candidate = novelSourceResultToRecommendationCandidate(result, searchNovelSourceById.get(result.sourceId));
      const hardcoverProvider = searchHardcoverProviderByTitleKey.get(recommendationTitleKey(result.title, "novel"));
      const detailTags = searchNovelDetailTagsByKey.get(novelSourceResultKey(result)) ?? [];
      const detailUpdatedAtMs = searchNovelDetailUpdatedAtByKey.get(novelSourceResultKey(result));
      return {
        ...candidate,
        tags: mergeRecommendationTags(candidate.tags, detailTags),
        updatedAtMs: detailUpdatedAtMs ?? candidate.updatedAtMs,
        providers: hardcoverProvider ? [...candidate.providers, hardcoverProvider] : candidate.providers,
        inLibrary: novelLibraryState ? isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path)) : false,
      };
    }),
  );

  const searchHardcoverCandidateResults = $derived.by(() =>
    searchHardcoverRecords.map(hardcoverRecordToRecommendationCandidate),
  );

  const searchHardcoverSeedItems = $derived.by(() =>
    searchHardcoverRecords.map(hardcoverRecordToTasteProfileSeed),
  );

  const searchBookProgressById = $derived.by(() =>
    new Map((store.bookProgress ?? []).map((progress) => [progress.bookId, progress])),
  );

  const searchNovelProfileOnly = $derived.by(() => buildSearchRecommendations({
    libraryNovels: novelLibraryState?.entries ?? [],
    libraryBooks: store.books ?? [],
    progressByBookId: searchBookProgressById,
    extraSeeds: searchHardcoverSeedItems,
  }, {
    includeInLibrary: true,
    includeNsfw: includeNsfwSources,
    blockedTags: store.settings.filterBlockedTags ? store.settings.nsfwFilteredTags ?? [] : [],
    limitPerSection: SEARCH_RECOMMENDATION_MAX_LIMIT,
  }).profile);

  const searchHardcoverDiscoveryQueries = $derived.by(() => {
    if (activeContentType !== "novels") return [];
    const tags = searchNovelProfileOnly.topTags
      .map((tag) => formatTasteTag(tag).trim())
      .filter(isUsefulHardcoverDiscoveryTag);
    const queries = tags.slice(0, HARDCOVER_DISCOVERY_QUERY_LIMIT).map((tag) => `${tag} novel`);
    return queries.slice(0, HARDCOVER_DISCOVERY_QUERY_LIMIT);
  });

  const searchHardcoverScoreTitles = $derived.by(() => {
    if (activeContentType !== "novels") return [];
    const state = loadHardcoverState({
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    });
    if (!state.auth.connected) return [];
    const seen = new Set<string>();
    for (const record of searchHardcoverRecords) {
      seen.add(recommendationTitleKey(record.title, "novel"));
    }
    return dedupeScoreTitles(searchNovelSourcePool.map((result) => result.title?.trim()))
      .filter((title): title is string => Boolean(title))
      .filter((title) => {
        const key = recommendationTitleKey(title, "novel");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, HARDCOVER_SCORE_ENRICHMENT_LIMIT);
  });

  const searchHardcoverScoreExpectedKey = $derived.by(() => JSON.stringify({
    titles: searchHardcoverScoreTitles,
    aliasVersion: NOVEL_TITLE_ALIAS_VERSION,
    profile: store.runtimeResolvedLocalProfileId,
    server: store.runtimeServerUrl,
  }));

  const searchHardcoverDiscoveryExpectedKey = $derived.by(() => JSON.stringify({
    queries: searchHardcoverDiscoveryQueries,
    profile: store.runtimeResolvedLocalProfileId,
    server: store.runtimeServerUrl,
    includeNsfw: includeNsfwSources,
  }));

  $effect(() => {
    if (!HARDCOVER_BACKGROUND_ENRICHMENT_ENABLED) return;
    if (!searchRecommendationsReady) return;
    if (!searchHardcoverOnline) return;
    if (activeContentType !== "novels" || activeBrowseTab !== "keyword" || kw_submitted) return;
    if (hardcoverAutoCooldownRemainingMs() > 0) return;

    const scoreKey = searchHardcoverScoreExpectedKey;
    const discoveryKey = searchHardcoverDiscoveryExpectedKey;
    const titles = searchHardcoverScoreTitles;
    const queries = searchHardcoverDiscoveryQueries;
    const shouldScore = titles.length > 0 && scoreKey !== searchHardcoverScoreKey;
    const shouldDiscover = queries.length > 0 && discoveryKey !== searchHardcoverDiscoveryKey;
    if (!shouldScore && !shouldDiscover) return;

    const backgroundKey = JSON.stringify({
      scoreKey: shouldScore ? scoreKey : "",
      discoveryKey: shouldDiscover ? discoveryKey : "",
    });
    const lastStartedAt = searchHardcoverBackgroundStartedAtByKey.get(backgroundKey) ?? 0;
    if (Date.now() - lastStartedAt < HARDCOVER_BACKGROUND_ENRICHMENT_MIN_GAP_MS) return;

    clearHardcoverBackgroundTimer();
    searchHardcoverBackgroundTimer = setTimeout(() => {
      searchHardcoverBackgroundTimer = null;
      void (async () => {
        if (!searchHardcoverOnline || hardcoverAutoCooldownRemainingMs() > 0) return;
        if (activeContentType !== "novels" || activeBrowseTab !== "keyword" || kw_submitted) return;
        searchHardcoverBackgroundStartedAtByKey.set(backgroundKey, Date.now());
        if (shouldScore) {
          await refreshSearchHardcoverScores(scoreKey, titles);
        }
        if (searchHardcoverOnline && shouldDiscover) {
          await refreshSearchHardcoverDiscovery(discoveryKey, queries);
        }
      })();
    }, HARDCOVER_BACKGROUND_ENRICHMENT_DELAY_MS);

    return clearHardcoverBackgroundTimer;
  });

  const searchTrackerScoreTitles = $derived.by(() => {
    if (activeContentType !== "manga") return [];
    const seen = new Set<string>();
    return dedupeScoreTitles(searchSourceMangaPool.map((manga) => manga.title?.trim()))
      .filter((title): title is string => Boolean(title))
      .filter((title) => {
        const key = recommendationTitleKey(title, "manga");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, TRACKER_SCORE_ENRICHMENT_LIMIT);
  });

  const searchScoreTrackers = $derived.by(() =>
    allTrackers.filter((tracker) => {
      const provider = trackerProviderKind(tracker);
      return provider === "anilist" || provider === "mal";
    }),
  );

  function usableSearchTrackers(trackers = searchScoreTrackers) {
    return trackers
      .filter((tracker) => {
        const provider = trackerProviderKind(tracker);
        return provider === "anilist" || provider === "mal";
      })
      .slice(0, 2);
  }

  const searchTrackerScoreExpectedKey = $derived.by(() => JSON.stringify({
      titles: searchTrackerScoreTitles,
      trackers: searchScoreTrackers.map((tracker) => tracker.id),
      nsfw: includeNsfwSources,
      profile: store.runtimeResolvedLocalProfileId,
      server: store.runtimeServerUrl,
  }));

  $effect(() => {
    if (activeContentType !== "manga") return;
    if (searchTrackerScoreExpectedKey === searchTrackerScoreKey) return;
    untrack(() => {
      void refreshSearchTrackerScores(searchTrackerScoreExpectedKey, searchTrackerScoreTitles, searchScoreTrackers);
    });
  });

  $effect(() => {
    store.libraryMangaSnapshot;
    untrack(() => {
      void refreshSearchProfileLibrary();
    });
  });

  const searchTrackerTrendingExpectedKey = $derived.by(() => JSON.stringify({
    scope: searchRuntimeScopeKey,
    contentType: activeContentType,
    tab: activeBrowseTab,
    submitted: Boolean(kw_submitted),
    trackers: searchScoreTrackers.map((tracker) => tracker.id),
    nsfw: includeNsfwSources,
  }));

  $effect(() => {
    if (!searchRecommendationsReady) return;
    if (activeContentType !== "manga" || activeBrowseTab !== "keyword" || kw_submitted) return;
    if (searchTrackerTrendingExpectedKey === searchTrackerTrendingKey) return;
    untrack(() => {
      void refreshSearchTrackerTrendingFeed(searchTrackerTrendingExpectedKey, searchScoreTrackers);
    });
  });

  const searchTrackerScoreReady = $derived.by(() => {
    if (activeContentType !== "manga") return true;
    if (searchTrackerScoreTitles.length === 0) return true;
    if (searchScoreTrackers.length === 0) return true;
    return searchTrackerScoreKey === searchTrackerScoreExpectedKey && !searchTrackerScoreLoading;
  });

  const searchKnownTitleKeys = $derived.by(() => {
    const keys = new Set<string>();
    for (const manga of searchLibraryManga) {
      addKnownComicRecommendationTitle(keys, manga.title);
    }
    const books = Array.isArray(store.books) ? store.books : [];
    for (const book of books) {
      addKnownRecommendationTitle(keys, book.title, "book");
    }
    for (const record of searchTrackRecords) {
      addKnownComicRecommendationTitle(keys, record.title);
    }
    for (const novel of novelLibraryState?.entries ?? []) {
      addKnownRecommendationTitle(keys, novel.title, "novel");
    }
    for (const record of searchHardcoverRecords) {
      addKnownRecommendationTitle(keys, record.title, "novel");
    }
    return keys;
  });

  const searchKnownProviderKeys = $derived.by(() => {
    const keys = new Set<string>();
    for (const record of searchTrackRecords) {
      const key = recommendationTrackerRemoteKey(record.trackerId, record.remoteId);
      if (key) keys.add(key);
    }
    for (const record of searchHardcoverRecords) {
      const key = recommendationTrackerRemoteKey("hardcover", record.bookId);
      if (key) keys.add(key);
    }
    return keys;
  });

  const searchMangaByCandidateId = $derived.by(() => new Map(
    dedupeMangaById([
      ...searchLibraryManga,
      ...searchSourceMangaPool,
    ])
      .map((manga) => [`manga:${manga.id}`, manga]),
  ));

  const searchNovelByCandidateId = $derived.by(() => new Map(
    (novelLibraryState?.entries ?? []).map((entry) => [`novel:${entry.id}`, entry]),
  ));

  const searchNovelSourceByCandidateId = $derived.by(() => new Map(
    searchNovelSourcePool.map((result) => [
      `novel-source:${result.sourceId}:${encodeURIComponent(result.path)}`,
      result,
    ]),
  ));

  const searchBookByCandidateId = $derived.by(() => new Map(
    (store.books ?? []).map((entry) => [`book:${entry.id}`, entry]),
  ));

  const searchFallbackNovelCandidates = $derived(searchFallbackCandidates.filter((candidate) =>
    candidate.contentType === "novel" || candidate.contentType === "book",
  ));

  const searchFallbackNovelSeeds = $derived(searchFallbackSeeds.filter((seed) =>
    seed.contentType === "novel" || seed.contentType === "book",
  ));

  const searchHasLiveMangaRecommendationData = $derived.by(() =>
    searchSourceMangaPool.length > 0
      || trackerCatalogResults.length > 0
      || searchTrackerTrendingResults.length > 0
      || searchTrackerScoreResults.length > 0
      || searchTrackerRecordCandidates.length > 0,
  );

  const searchHasLiveNovelRecommendationData = $derived.by(() =>
    searchNovelSourceCandidates.length > 0
      || searchHardcoverCandidateResults.length > 0
      || searchHardcoverDiscoveryResults.length > 0,
  );

  const searchRecommendationResult = $derived.by(() => {
    if (activeContentType === "novels") {
      return buildSearchRecommendations({
        libraryNovels: novelLibraryState?.entries ?? [],
        libraryBooks: store.books ?? [],
        progressByBookId: searchBookProgressById,
        extraCandidates: searchHasLiveNovelRecommendationData
          ? [...searchNovelSourceCandidates, ...searchHardcoverDiscoveryResults, ...searchHardcoverCandidateResults]
          : [],
        extraSeeds: searchHasLiveNovelRecommendationData ? searchHardcoverSeedItems : [],
      }, {
        includeInLibrary: searchIncludeLibrary,
        knownTitleKeys: searchKnownTitleKeys,
        knownProviderKeys: searchKnownProviderKeys,
        includeNsfw: includeNsfwSources,
        blockedTags: store.settings.filterBlockedTags ? store.settings.nsfwFilteredTags ?? [] : [],
        limitPerSection: SEARCH_RECOMMENDATION_MAX_LIMIT,
      });
    }

    return buildSearchRecommendations({
      libraryManga: searchLibraryManga,
      sourceResults: searchSourceMangaPool,
      trackerResults: dedupeTrackSearches([...searchTrackerTrendingResults, ...trackerCatalogResults, ...searchTrackerScoreResults]),
      trackers: allTrackers,
      trackRecordsByMangaId: searchTrackRecordsByMangaId,
      extraCandidates: searchHasLiveMangaRecommendationData
        ? [...searchTrackerRecordCandidates, ...searchFreshSourceMangaCandidates]
        : [],
      extraSeeds: searchHasLiveMangaRecommendationData ? searchTrackerSeedItems : [],
    }, {
      includeInLibrary: searchIncludeLibrary,
      knownTitleKeys: searchKnownTitleKeys,
      knownProviderKeys: searchKnownProviderKeys,
      includeNsfw: includeNsfwSources,
      blockedTags: store.settings.filterBlockedTags ? store.settings.nsfwFilteredTags ?? [] : [],
      limitPerSection: SEARCH_RECOMMENDATION_MAX_LIMIT,
    });
  });

  const searchRecommendationCompositionKey = $derived.by(() => JSON.stringify({
    scope: searchRuntimeScopeKey,
    contentType: activeContentType,
    includeLibrary: searchIncludeLibrary,
    profile: [...searchRecommendationResult.profile.contentTypeWeights.entries()],
    sourceScope: searchRecommendationSourcePool.slice(0, activeContentType === "novels" ? SEARCH_SEED_SOURCE_LIMIT_NOVELS : SEARCH_SEED_SOURCE_LIMIT_MANGA).map((source) => source.id),
    lang: src_selectedLang,
    nsfw: includeNsfwSources,
  }));

  $effect(() => {
    searchRecommendationCompositionKey;
    untrack(() => {
      searchRecommendationSectionOrder = new Map();
      searchRecommendationVisibleLimits = new Map();
      searchRecommendationMoreRequestedWidths = new Map();
    });
  });

  $effect(() => {
    const nextOrders = new Map(untrack(() => searchRecommendationSectionOrder));
    for (const section of searchRecommendationResult.sections) {
      const key = searchRecommendationMoreKey(section.key);
      const availableIds = section.items.map((item) => item.candidate.id);
      const availableSet = new Set(availableIds);
      const previous = nextOrders.get(key) ?? [];
      const kept = previous.filter((id) => availableSet.has(id));
      const keptSet = new Set(kept);
      const appended = availableIds.filter((id) => !keptSet.has(id));
      nextOrders.set(key, [...kept, ...appended]);
    }
    untrack(() => {
      searchRecommendationSectionOrder = nextOrders;
    });
  });

  const searchRecommendationSections = $derived.by(() => {
    const visibleRecommendationIds = new Set<string>();
    return searchRecommendationResult.sections.map((section) => {
      const itemById = new Map(section.items.map((item) => [item.candidate.id, item]));
      const orderedItems = (searchRecommendationSectionOrder.get(searchRecommendationMoreKey(section.key)) ?? [])
        .map((id) => itemById.get(id))
        .filter((item): item is RecommendationItem => Boolean(item));
      const baseItems = orderedItems.length > 0 ? orderedItems : section.items;
      const uniqueItems = baseItems.filter((item) => !visibleRecommendationIds.has(item.candidate.id));
      const items = uniqueItems.length >= Math.min(SEARCH_RECOMMENDATION_MIN_SECTION_FILL, baseItems.length)
        ? uniqueItems
        : baseItems;
      const visibleItems = items.slice(0, searchRecommendationVisibleLimit(section.key));
      if (visibleItems.length > 0) {
        for (const item of visibleItems) visibleRecommendationIds.add(item.candidate.id);
      }
      return {
        ...section,
        items: visibleItems,
      };
    });
  });

  const searchRecommendationItems = $derived.by(() =>
    searchRecommendationSections.flatMap((section) => section.items),
  );

  const searchDisplayedRecommendationCount = $derived(searchRecommendationItems.length);

  let isInsightsOpen = $state(false);

  const libraryOnlyProfile = $derived.by(() => {
    const seeds: TasteProfileSeedItem[] = [];
    seeds.push(
      ...(searchLibraryManga ?? []).map((manga) =>
        mangaToTasteProfileSeed(manga, { trackRecordsByMangaId: searchTrackRecordsByMangaId }),
      )
    );
    seeds.push(
      ...(novelLibraryState?.entries ?? []).map(novelToTasteProfileSeed)
    );
    seeds.push(
      ...(store.books ?? []).map((book) =>
        bookToTasteProfileSeed(book, {
          progressByBookId: searchBookProgressById,
        })
      )
    );
    return buildTasteProfile(seeds);
  });

  const searchHasAnyRecommendationCandidates = $derived.by(() =>
    activeContentType === "novels"
      ? searchHasLiveNovelRecommendationData
      : searchHasLiveMangaRecommendationData,
  );

  const searchRecommendationHydrating = $derived.by(() => {
    if (activeBrowseTab !== "keyword" || kw_submitted) return false;
    if (searchDisplayedRecommendationCount > 0) return false;
    if (activeContentType === "novels") {
      const waitingForNovelSeeds = searchSourceSeedLoading
        || loadingSources
        || (searchRecommendationSourcePool.length > 0 && !searchSourceSeedKey && searchNovelSourcePool.length === 0);
      return waitingForNovelSeeds;
    }

    const waitingForMangaSeeds = searchSourceSeedLoading
      || loadingSources
      || loadingTrackers
      || searchTrackerTrendingLoading
      || (searchRecommendationSourcePool.length > 0 && !searchSourceSeedKey && searchSourceMangaPool.length === 0);
    return waitingForMangaSeeds;
  });

  $effect(() => {
    if (!searchRecommendationsReady) return;
    if (activeContentType !== "manga" || activeBrowseTab !== "keyword" || kw_submitted) return;
    if (searchRecommendationHydrating || searchSourceSeedLoading || searchMangaSeedAutofillLoading || searchMangaSeedAutofillExhausted) return;
    const underfilledSection = searchRecommendationSections.find((section) =>
      (section.key === "highConfidence" || section.key === "trendingNearYourTaste")
      && section.items.length > 0
      && section.items.length < SEARCH_RECOMMENDATION_MIN_SECTION_FILL
    );
    const needsCandidateDepth = searchSourceMangaPool.length > 0
      && searchSourceMangaPool.length < SEARCH_RECOMMENDATION_AUTOFILL_TARGET;
    if (!underfilledSection && !needsCandidateDepth) return;
    const key = [
      "search-source-seeds",
      searchRuntimeScopeKey,
      activeContentType,
      includeNsfwSources ? "nsfw" : "safe",
      src_selectedLang,
      searchRecommendationSourcePool.map((source) => source.id).join(","),
    ].join("|");
    window.setTimeout(() => {
      if (activeContentType !== "manga" || activeBrowseTab !== "keyword" || kw_submitted) return;
      if (searchSourceSeedLoading || searchMangaSeedAutofillLoading || searchMangaSeedAutofillExhausted) return;
      void loadMangaSearchSeedAutofill(key);
    }, 280);
  });

  $effect(() => {
    if (!searchRecommendationsReady) return;
    if (activeContentType !== "novels" || activeBrowseTab !== "keyword" || kw_submitted) return;
    if (searchRecommendationHydrating || searchSourceSeedLoading || searchNovelSeedAutofillLoading || searchNovelSeedAutofillExhausted) return;
    const underfilled = searchDisplayedRecommendationCount === 0
      || searchRecommendationSections.some((section) =>
        (section.key === "highConfidence" || section.key === "trendingNearYourTaste" || section.key === "freshInYourSources")
        && section.items.length > 0
        && section.items.length < SEARCH_RECOMMENDATION_MIN_SECTION_FILL,
      );
    const needsCandidateDepth = searchNovelSourcePool.length > 0
      && searchNovelSourcePool.length < SEARCH_RECOMMENDATION_AUTOFILL_TARGET;
    if (!underfilled && !needsCandidateDepth) return;
    const key = [
      "search-source-seeds",
      searchRuntimeScopeKey,
      activeContentType,
      includeNsfwSources ? "nsfw" : "safe",
      src_selectedLang,
      searchRecommendationSourcePool.map((source) => source.id).join(","),
    ].join("|");
    window.setTimeout(() => {
      if (activeContentType !== "novels" || activeBrowseTab !== "keyword" || kw_submitted) return;
      if (searchSourceSeedLoading || searchNovelSeedAutofillLoading || searchNovelSeedAutofillExhausted) return;
      void loadNovelSearchSeedAutofill(key);
    }, 360);
  });

  const searchHeroStatusText = $derived.by(() => {
    if (searchRecommendationHydrating) {
      return activeContentType === "novels"
        ? $_("browse.search.hydratingNovels")
        : $_("browse.search.hydratingManga");
    }
    if (!searchHasAnyRecommendationCandidates) {
      return activeContentType === "novels"
        ? $_("browse.search.noNovelData")
        : $_("browse.search.noMangaData");
    }
    return activeContentType === "novels"
      ? $_("browse.search.recommendationsSummaryNovels", { count: searchDisplayedRecommendationCount })
      : $_("browse.search.recommendationsSummaryManga", { count: searchDisplayedRecommendationCount });
  });

  const searchEmptyStateMessage = $derived.by(() => {
    if (setupState?.kind && setupState.kind !== "ready") {
      return setupState.kind === "server_offline"
        ? $_("browse.search.suwayomiOffline")
        : $_("browse.search.finishSetup");
    }
    if (searchRecommendationHydrating) return "";
    if (!searchHasAnyRecommendationCandidates) {
      return activeContentType === "novels"
        ? $_("browse.search.noNovelSourceResults")
        : $_("browse.search.noMangaSourceResults");
    }
    if (searchDisplayedRecommendationCount === 0) {
      return searchIncludeLibrary
        ? $_("browse.search.noRecommendationMatches")
        : $_("browse.search.noNewRecommendations");
    }
    return "";
  });

  const searchNovelItems = $derived.by(() => searchRecommendationItems
    .filter((item) => item.candidate.contentType === "novel" || item.candidate.contentType === "book")
    .slice(0, 3));

  const searchCandidateTags = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const item of searchRecommendationItems) {
      for (const tag of item.candidate.tags) {
        const normalized = tag.trim();
        if (!normalized) continue;
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  });

  const searchTasteTags = $derived.by(() =>
    searchRecommendationResult.profile.topTags.slice(0, 6).map(formatTasteTag),
  );

  const searchDiversityValue = $derived.by(() => {
    const items = searchRecommendationItems;
    if (!items.length) return 50;
    const divergent = items.filter((item) => item.breakdown.diversityBucket === "divergent").length;
    const adjacent = items.filter((item) => item.breakdown.diversityBucket === "adjacent").length;
    return Math.round(Math.min(100, Math.max(18, ((divergent * 1.2 + adjacent * 0.65) / items.length) * 100)));
  });

  const searchInsightLines = $derived.by(() => {
    const tags = searchTasteTags.slice(0, 2).join(" and ").toLowerCase();
    const trackerBacked = searchRecommendationItems.filter((item) => item.badge).length;
    const hardcoverBacked = searchRecommendationItems.filter((item) =>
      item.candidate.providers.some((provider) => provider.providerId === "hardcover" && provider.score),
    ).length;
    const sourceBacked = searchRecommendationItems.filter((item) => item.candidate.providers.some((provider) => provider.kind === "source")).length;
    const providerLine = activeContentType === "novels"
      ? $_("browse.search.sourcePicksNovels", { count: sourceBacked })
      : $_("browse.search.sourcePicksManga", { count: sourceBacked });
    return [
      tags ? $_("browse.search.strongestProfileSignal", { tags }) : $_("browse.search.profileWarming"),
      activeContentType === "novels"
        ? $_("browse.search.hardcoverSignals", { count: hardcoverBacked })
        : $_("browse.search.trackerSignals", { count: trackerBacked }),
      providerLine,
    ];
  });

  function addKnownRecommendationTitle(
    keys: Set<string>,
    title: string | null | undefined,
    contentType: RecommendationCandidate["contentType"],
  ) {
    if (!title?.trim()) return;
    const key = recommendationTitleKey(title, contentType);
    if (!key.endsWith(":")) keys.add(key);
  }

  function addKnownComicRecommendationTitle(keys: Set<string>, title: string | null | undefined) {
    addKnownRecommendationTitle(keys, title, "manga");
    addKnownRecommendationTitle(keys, title, "manhwa");
    addKnownRecommendationTitle(keys, title, "manhua");
  }

  function makeFallbackCandidate(
    title: string,
    tags: string[],
    contentType: RecommendationCandidate["contentType"],
    coverUrl: string,
    score: number,
    trending: number,
  ): RecommendationCandidate {
    return {
      id: `fallback:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      title,
      tags,
      contentType,
      coverUrl,
      status: contentType === "novel" ? "ONGOING" : "ONGOING",
      inLibrary: false,
      safety: "safe",
      providers: [
        {
          providerId: "mockup-source",
          providerName: contentType === "novel" ? "WebNovel" : "Flame Comics",
          kind: "source",
          availability: { value: 0.88, confidence: 0.7, method: "mockup" },
        },
        {
          providerId: score >= 0.85 ? "anilist" : "mal",
          providerName: score >= 0.85 ? "AniList" : "MAL",
          kind: "tracker",
          iconKey: score >= 0.85 ? "AL" : "MAL",
          score: { value: score, confidence: 0.72, method: "mockup" },
          trending: { value: trending, confidence: 0.58, method: "mockup" },
        },
      ],
    };
  }

  function trackerRecordToRecommendationCandidate(
    record: TrackRecord,
    manga: Manga,
    tracker: BrowseTrackerEntry,
  ): RecommendationCandidate {
    const scoreMax = record.score > 10 ? 100 : 10;
    const normalizedScore = scoreMax > 0 ? Math.max(0, Math.min(1, record.score / scoreMax)) : 0;
    const timestamp = trackRecordTimestamp(record.finishDate) ?? trackRecordTimestamp(record.startDate);
    const trackerName = tracker.name || `Tracker ${tracker.id}`;
    return {
      id: `manga:${manga.id}`,
      title: manga.title || record.title,
      coverUrl: manga.thumbnailUrl,
      alternativeTitles: record.title && record.title !== manga.title ? [record.title] : [],
      tags: manga.genre ?? [],
      contentType: inferMangaRecommendationContentType(manga, record.title),
      status: manga.status ?? null,
      inLibrary: false,
      safety: inferRecommendationSafety(manga.genre ?? []),
      updatedAtMs: timestamp,
      providers: [
        {
          providerId: String(tracker.id),
          providerName: trackerName,
          kind: "tracker",
          remoteId: record.remoteId,
          iconKey: trackerIconKey(trackerName),
          score: normalizedScore > 0 ? { value: normalizedScore, confidence: 0.9, method: `track-record/${scoreMax}`, sourceValue: record.displayScore || String(record.score) } : undefined,
        },
        ...(manga.source ? [{
          providerId: String(manga.source.id),
          providerName: manga.source.displayName ?? "Source",
          kind: "source" as const,
          availability: { value: 0.72, confidence: 0.52, method: "linked-source" },
        }] : []),
      ],
    };
  }

  function trackRecordToTasteProfileSeed(
    record: TrackRecord,
    manga: Manga | null | undefined,
    tracker: BrowseTrackerEntry,
  ): TasteProfileSeedItem {
    return {
      id: `tracker:${record.trackerId}:${record.remoteId || record.id}`,
      title: manga?.title || record.title,
      tags: manga?.genre ?? [],
      contentType: inferMangaRecommendationContentType(manga, record.title),
      sourceId: `tracker:${tracker.id}`,
      userRating: record.score > 0 ? record.score : null,
      userRatingMax: record.score > 10 ? 100 : 10,
      implicitWeight: record.score > 0 ? null : 0.42,
      status: trackRecordSeedStatus(record),
    };
  }

  function trackRecordSeedStatus(record: TrackRecord): TasteProfileSeedItem["status"] {
    if (record.finishDate || (record.totalChapters > 0 && record.lastChapterRead >= record.totalChapters)) return "completed";
    if (record.lastChapterRead > 0) return "reading";
    if (record.status < 0) return "dropped";
    return "planning";
  }

  function inferMangaRecommendationContentType(
    manga: Manga | null | undefined,
    fallbackTitle = "",
  ): RecommendationCandidate["contentType"] {
    const sourceName = (manga?.source?.displayName || manga?.source?.name || "").toLowerCase();
    const haystack = [
      fallbackTitle,
      manga?.title,
      manga?.description ?? "",
      ...(manga?.genre ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    // Dedicated manhwa/manhua sources
    if (
      sourceName.includes("asura")
      || sourceName.includes("flame")
      || sourceName.includes("reaper")
      || sourceName.includes("void scans")
    ) {
      return "manhwa";
    }

    if (
      haystack.includes("manhwa")
      || haystack.includes("korean")
      || haystack.includes("webtoon")
      || haystack.includes("regression")
      || haystack.includes("murim")
      || haystack.includes("necromancer")
      || haystack.includes("dungeon")
      || haystack.includes("system")
      || haystack.includes("level up")
      || haystack.includes("hunter")
      || haystack.includes("tower")
      || haystack.includes("gate")
      || haystack.includes("ranker")
      || haystack.includes("player")
      || haystack.includes("constellation")
    ) return "manhwa";

    if (
      haystack.includes("manhua")
      || haystack.includes("chinese")
      || haystack.includes("cultivation")
      || haystack.includes("wuxia")
      || haystack.includes("xianxia")
      || haystack.includes("xuanhuan")
    ) return "manhua";

    // Fallback to source language if available and source is not a general aggregator
    const isAggregator = sourceName.includes("mangakakalot")
      || sourceName.includes("manganato")
      || sourceName.includes("mangadex")
      || sourceName.includes("mangalife");
    if (!isAggregator) {
      const sourceLangType = inferComicTypeFromLanguage(manga?.source?.lang);
      if (sourceLangType) return sourceLangType;
    }

    return "manga";
  }

  function inferComicTypeFromLanguage(language: string | null | undefined): RecommendationCandidate["contentType"] | null {
    const normalized = language?.trim().toLowerCase().replace("_", "-") ?? "";
    if (!normalized) return null;
    if (normalized === "kr" || normalized === "ko" || normalized.startsWith("ko-") || normalized.includes("korean")) {
      return "manhwa";
    }
    if (
      normalized === "cn"
      || normalized === "zh"
      || normalized.startsWith("zh-")
      || normalized.includes("chinese")
    ) {
      return "manhua";
    }
    if (normalized === "jp" || normalized === "ja" || normalized.startsWith("ja-") || normalized.includes("japanese")) {
      return "manga";
    }
    return null;
  }

  function withMangaSourceMetadata(mangas: Manga[], source: Source | BrowseSourceEntry): Manga[] {
    return mangas.map((manga) => {
      const mangaSource = "mangaSource" in source ? source.mangaSource : source;
      const id = manga.source?.id ?? mangaSource?.id ?? source.id;
      const name = manga.source?.name ?? mangaSource?.name ?? source.name;
      const displayName = manga.source?.displayName ?? mangaSource?.displayName ?? source.displayName;
      const lang = manga.source?.lang ?? mangaSource?.lang ?? source.lang;
      return {
        ...manga,
        source: {
          id,
          name,
          displayName,
          lang,
        },
      };
    });
  }

  function trackRecordTimestamp(value: string | null | undefined) {
    if (!value || value === "0") return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function trackerIconKey(name: string) {
    const normalized = name.toLowerCase();
    if (normalized.includes("anilist")) return "anilist";
    if (normalized.includes("myanimelist") || normalized === "mal") return "myanimelist";
    return "tracker";
  }

  function inferRecommendationSafety(tags: string[]): RecommendationCandidate["safety"] {
    const normalized = tags.join(" ").toLowerCase();
    if (normalized.includes("hentai") || normalized.includes("pornographic")) return "explicit";
    if (normalized.includes("adult") || normalized.includes("erotica")) return "adult";
    if (normalized.includes("suggestive") || normalized.includes("ecchi")) return "suggestive";
    return "safe";
  }

  function formatTasteTag(tag: string) {
    return tag
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function getRecommendationBannerInfo(item: RecommendationItem) {
    if (activeContentType === "novels") {
      const hardcoverScore = recommendationHardcoverScore(item);
      if (hardcoverScore && hardcoverScore.value > 0) {
        return {
          tracker: "hardcover",
          score: formatHardcoverBadgeScore(hardcoverScore.value)
        };
      }
      const sourceScore = item.candidate.providers
        .filter((provider) => provider.kind === "source" && provider.score && provider.score.confidence > 0)
        .map((provider) => ({ provider, score: provider.score! }))
        .sort((a, b) => b.score.confidence - a.score.confidence)[0];
      if (sourceScore) {
        return {
          tracker: "source",
          score: formatSourceBadgeScore(sourceScore.score.value)
        };
      }
      return null;
    }

    if (item.badge) {
      const key = item.badge.iconKeys[0]?.toLowerCase() ?? "";
      let trackerType = "tracker";
      if (key.includes("mal") || key.includes("myanimelist")) {
        trackerType = "myanimelist";
      } else if (key.includes("ani") || key.includes("anilist")) {
        trackerType = "anilist";
      } else if (key.includes("kitsu")) {
        trackerType = "kitsu";
      } else if (key.includes("bangumi")) {
        trackerType = "bangumi";
      } else if (key.includes("mangaupdates")) {
        trackerType = "mangaupdates";
      } else if (key.includes("hardcover")) {
        trackerType = "hardcover";
      }
      return {
        tracker: trackerType,
        score: item.badge.displayScore
      };
    }
    return null;
  }

  function getTrackerBgColor(tracker: string): string {
    switch (tracker) {
      case "anilist": return "#0b1622";
      case "myanimelist": return "#2e51a2";
      case "kitsu": return "#ef5a3a";
      case "mangaupdates": return "#2f6e91";
      case "bangumi": return "#ff3599";
      case "hardcover": return "#ff9f43";
      default: return "#4c4078";
    }
  }


  function recommendationHardcoverScore(item: RecommendationItem) {
    return item.candidate.providers
      .find((provider) => provider.providerId === "hardcover" && provider.score && provider.score.confidence > 0)
      ?.score ?? null;
  }

  function formatSourceBadgeScore(value: number) {
    return (Math.round(value * 100) / 10).toFixed(1);
  }

  function formatHardcoverBadgeScore(value: number) {
    return (Math.round(value * 50) / 10).toFixed(1);
  }

  function recommendationProviderLabel(item: RecommendationItem) {
    const provider = item.candidate.providers.find((entry) => entry.kind === "source") ?? item.candidate.providers[0];
    return provider?.providerName ?? "Aethon";
  }

  function recommendationStatusLabel(item: RecommendationItem) {
    if (activeContentType === "novels") {
      const hardcoverScore = recommendationHardcoverScore(item);
      if (hardcoverScore && hardcoverScore.value > 0) {
        return `HC ${formatHardcoverBadgeScore(hardcoverScore.value)}`;
      }
    }
    return item.candidate.status?.replace(/_/g, " ") ?? (item.candidate.inLibrary ? "In library" : "Ongoing");
  }

  function scrollSearchSection(sectionKey: string, direction: -1 | 1) {
    const row = document.querySelector<HTMLElement>(`[data-search-row="${sectionKey}"]`);
    if (!row) return;
    row.scrollBy({
      left: direction * Math.max(320, row.clientWidth * 0.78),
      behavior: "smooth",
    });
    if (direction > 0) {
      window.setTimeout(() => {
        if (row.scrollLeft + row.clientWidth >= row.scrollWidth - 128) {
          requestSearchSectionMore(sectionKey, row);
        }
      }, 240);
    }
  }

  function advanceSearchSection(sectionKey: string) {
    scrollSearchSection(sectionKey, 1);
  }

  function searchCoverKey(candidate: RecommendationCandidate) {
    return `${candidate.id}:${candidate.coverUrl ?? ""}`;
  }

  function hasSearchCover(candidate: RecommendationCandidate) {
    return Boolean(candidate.coverUrl?.trim()) && !failedSearchCoverKeys.has(searchCoverKey(candidate));
  }

  function markSearchCoverFailed(candidate: RecommendationCandidate) {
    if (!candidate.coverUrl?.trim()) return;
    failedSearchCoverKeys = new Set([...failedSearchCoverKeys, searchCoverKey(candidate)]);
  }

  function searchRecommendationMoreKey(sectionKey: string) {
    const sourceIds = searchRecommendationSourcePool
      .slice(0, activeContentType === "novels" ? SEARCH_SEED_SOURCE_LIMIT_NOVELS : SEARCH_SEED_SOURCE_LIMIT_MANGA)
      .map((source) => source.id)
      .join(",");
    return [
      "search-more",
      searchRuntimeScopeKey,
      activeContentType,
      sectionKey,
      searchIncludeLibrary ? "include-known" : "new-only",
      includeNsfwSources ? "nsfw" : "safe",
      src_selectedLang,
      sourceIds,
    ].join("|");
  }

  function searchRecommendationVisibleLimit(sectionKey: string) {
    return searchRecommendationVisibleLimits.get(searchRecommendationMoreKey(sectionKey)) ?? SEARCH_RECOMMENDATION_BASE_LIMIT;
  }

  function setSearchRecommendationVisibleLimit(sectionKey: string, limit: number) {
    const key = searchRecommendationMoreKey(sectionKey);
    searchRecommendationVisibleLimits = new Map([
      ...searchRecommendationVisibleLimits,
      [key, Math.min(SEARCH_RECOMMENDATION_MAX_LIMIT, Math.max(SEARCH_RECOMMENDATION_BASE_LIMIT, limit))],
    ]);
  }

  function canLoadSearchSectionMore(sectionKey: string) {
    const key = searchRecommendationMoreKey(sectionKey);
    return activeBrowseTab === "keyword"
      && !kw_submitted
      && !discoverFocusedTracker
      && searchRecommendationSourcePool.length > 0
      && !searchRecommendationMoreLoadingKeys.has(key)
      && !searchRecommendationMoreExhaustedKeys.has(key);
  }

  function sectionFetchType(sectionKey: string): "POPULAR" | "LATEST" {
    return sectionKey === "freshInYourSources" ? "LATEST" : "POPULAR";
  }

  function requestSearchSectionMore(sectionKey: string, row: HTMLElement) {
    const key = searchRecommendationMoreKey(sectionKey);
    const fullSection = searchRecommendationResult.sections.find((section) => section.key === sectionKey);
    const visibleLimit = searchRecommendationVisibleLimit(sectionKey);
    const hasHiddenItems = Boolean(fullSection && visibleLimit < fullSection.items.length);
    if (!hasHiddenItems && searchRecommendationMoreExhaustedKeys.has(key)) return;
    searchRecommendationMoreRequestedWidths = new Map([
      ...searchRecommendationMoreRequestedWidths,
      [key, row.scrollWidth],
    ]);
    void loadMoreSearchRecommendations(sectionKey);
  }

  function handleSearchRailScroll(sectionKey: string, event: Event) {
    const row = event.currentTarget as HTMLElement;
    if (row.scrollLeft + row.clientWidth < row.scrollWidth - 96) return;
    requestSearchSectionMore(sectionKey, row);
  }

  async function loadMoreSearchRecommendations(sectionKey: string) {
    if (activeBrowseTab !== "keyword" || kw_submitted || discoverFocusedTracker) return;
    const key = searchRecommendationMoreKey(sectionKey);
    if (searchRecommendationMoreLoadingKeys.has(key)) return;
    const now = Date.now();
    if (now - (searchRecommendationMoreTriggeredAt.get(key) ?? 0) < SEARCH_RECOMMENDATION_SCROLL_THROTTLE_MS) return;
    searchRecommendationMoreTriggeredAt = new Map([...searchRecommendationMoreTriggeredAt, [key, now]]);

    const currentLimit = searchRecommendationVisibleLimit(sectionKey);
    const fullSection = searchRecommendationResult.sections.find((section) => section.key === sectionKey);
    const nextLimit = Math.min(SEARCH_RECOMMENDATION_MAX_LIMIT, currentLimit + SEARCH_RECOMMENDATION_LIMIT_STEP);
    const startingSectionCount = fullSection?.items.length ?? 0;

    if (fullSection && currentLimit < fullSection.items.length) {
      setSearchRecommendationVisibleLimit(sectionKey, nextLimit);
      return;
    }

    if (searchRecommendationMoreExhaustedKeys.has(key)) {
      return;
    }

    if (activeContentType === "manga" && sectionKey === "trendingNearYourTaste") {
      setSearchRecommendationVisibleLimit(sectionKey, nextLimit);
      void loadSearchTrackerTrendingMore();
      return;
    }

    if (activeContentType === "manga" && sectionKey === "highConfidence") {
      setSearchRecommendationVisibleLimit(sectionKey, nextLimit);
      void prefetchHighConfidenceSearchRecommendations(key);
      return;
    }

    const page = (searchRecommendationMorePages.get(key) ?? 1) + 1;
    const request = searchRecommendationSourceRequest(page);
    const sources = request.sources;
    if (sources.length === 0) return;
    searchRecommendationMoreLoadingKeys = new Set([...searchRecommendationMoreLoadingKeys, key]);

    try {
      if (activeContentType === "novels") {
        const scopeInput = {
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        };
        const fallbackTerms = novelRecommendationFallbackTerms();
        const maxAttempts = 4;
        let attemptPage = page;
        let loadedAnyIncoming = false;
        let addedVisibleItems = false;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const attemptRequest = searchRecommendationSourceRequest(attemptPage);
          const attemptSources = attemptRequest.sources;
          if (attemptSources.length === 0) break;
          const previousCount = searchNovelSourceSeedResults.length;
          const settled = await Promise.allSettled(attemptSources.map(async (entry) => {
            if (!entry.novelSource) return [] as NovelSourceSearchResult[];
            return fetchNovelRecommendationSourcePage(entry, attemptRequest.sourcePage, scopeInput, fallbackTerms);
          }));
          const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
          searchRecommendationMorePages = new Map([...searchRecommendationMorePages, [key, attemptPage]]);
          if (incoming.length === 0) {
            attemptPage += 1;
            continue;
          }

          loadedAnyIncoming = true;
          const nextResults = capNovelRecommendationSeeds(balanceNovelSourceResults(dedupeNovelSourceResults([
            ...searchNovelSourceSeedResults,
            ...incoming,
          ])));
          searchNovelSourceSeedResults = nextResults;
          await tick();

          const updatedCount = searchRecommendationResult.sections.find((section) => section.key === sectionKey)?.items.length ?? 0;
          if (nextResults.length > previousCount || updatedCount > startingSectionCount) {
            addedVisibleItems = true;
            break;
          }
          attemptPage += 1;
        }

        if (!loadedAnyIncoming || !addedVisibleItems) {
          if ((searchRecommendationMorePages.get(key) ?? page) >= SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT) {
            searchRecommendationMoreExhaustedKeys = new Set([...searchRecommendationMoreExhaustedKeys, key]);
          }
          if (!addedVisibleItems) return;
        }
      } else {
        const fetchType = sectionFetchType(sectionKey);
        const maxAttempts = sectionKey === "highConfidence" ? 1 : 4;
        let attemptPage = page;
        let addedVisibleItems = false;
        let loadedAnyIncoming = false;
        const startingSourceSeedCount = searchSourceSeedResults.length;
        const startingFreshSeedCount = searchFreshSourceSeedResults.length;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const attemptRequest = searchRecommendationSourceRequest(attemptPage);
          const attemptSources = attemptRequest.sources;
          if (attemptSources.length === 0) break;

          const settled = await Promise.allSettled(attemptSources.map(async (entry) => {
            if (!entry.mangaSource) return [] as Manga[];
            const data = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
              FETCH_SOURCE_MANGA,
              { source: entry.mangaSource.id, type: fetchType, page: attemptRequest.sourcePage, query: null },
            );
            return withMangaSourceMetadata(
              data.fetchSourceManga.mangas.filter((manga) => !shouldHideNsfw(manga, browseVisibilitySettings)),
              entry,
            );
          }));
          const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
          if (incoming.length === 0) {
            searchRecommendationMorePages = new Map([...searchRecommendationMorePages, [key, attemptPage]]);
            attemptPage += 1;
            continue;
          }
          loadedAnyIncoming = true;
          if (sectionKey === "highConfidence") {
            void loadSearchTrackerScoresForTitles(incoming.map((manga) => manga.title));
          }

          const nextSectionResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
            dedupeMangaById([
              ...(fetchType === "LATEST" ? searchFreshSourceSeedResults : searchSourceSeedResults),
              ...incoming,
            ]),
            store.settings.mangaLinks,
          )));
          const nextCombinedResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
            dedupeMangaById([
              ...searchSourceSeedResults,
              ...(fetchType === "LATEST" ? nextSectionResults : incoming),
            ]),
            store.settings.mangaLinks,
          )));
          if (fetchType === "LATEST") {
            searchFreshSourceSeedResults = nextSectionResults;
          }
          searchSourceSeedResults = nextCombinedResults;
          searchSourceSeedFetchedAt = searchSourceSeedFetchedAt ?? Date.now();
          searchRecommendationMorePages = new Map([...searchRecommendationMorePages, [key, attemptPage]]);
          await tick();

          const updatedCount = searchRecommendationResult.sections.find((section) => section.key === sectionKey)?.items.length ?? 0;
          const grewCandidatePool = fetchType === "LATEST"
            ? searchFreshSourceSeedResults.length > startingFreshSeedCount
            : searchSourceSeedResults.length > startingSourceSeedCount;
          if (grewCandidatePool || updatedCount > startingSectionCount) {
            addedVisibleItems = true;
            break;
          }
          attemptPage += 1;
        }

        if (!loadedAnyIncoming || !addedVisibleItems) {
          if ((searchRecommendationMorePages.get(key) ?? page) >= SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT) {
            searchRecommendationMoreExhaustedKeys = new Set([...searchRecommendationMoreExhaustedKeys, key]);
          }
          if (loadedAnyIncoming && sectionKey === "highConfidence") {
            setSearchRecommendationVisibleLimit(sectionKey, nextLimit);
          }
          if (!addedVisibleItems) return;
        }
      }

      setSearchRecommendationVisibleLimit(sectionKey, nextLimit);
    } catch (error) {
      console.warn("Could not load more search recommendations.", error);
    } finally {
      searchRecommendationMoreLoadingKeys = new Set([...searchRecommendationMoreLoadingKeys].filter((entry) => entry !== key));
    }
  }

  async function prefetchHighConfidenceSearchRecommendations(key: string) {
    if (searchRecommendationMoreLoadingKeys.has(key)) return;
    const page = (searchRecommendationMorePages.get(key) ?? 1) + 1;
    const request = searchRecommendationSourceRequest(page);
    const sources = request.sources;
    if (sources.length === 0) return;

    searchRecommendationMoreLoadingKeys = new Set([...searchRecommendationMoreLoadingKeys, key]);
    try {
      const settled = await Promise.allSettled(sources.map(async (entry) => {
        if (!entry.mangaSource) return [] as Manga[];
        const data = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
          FETCH_SOURCE_MANGA,
          { source: entry.mangaSource.id, type: "POPULAR", page: request.sourcePage, query: null },
        );
        return withMangaSourceMetadata(
          data.fetchSourceManga.mangas.filter((manga) => !shouldHideNsfw(manga, browseVisibilitySettings)),
          entry,
        );
      }));
      const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      searchRecommendationMorePages = new Map([...searchRecommendationMorePages, [key, page]]);
      if (incoming.length === 0) {
        if (page >= SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT) {
          searchRecommendationMoreExhaustedKeys = new Set([...searchRecommendationMoreExhaustedKeys, key]);
        }
        return;
      }

      searchSourceSeedResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
        dedupeMangaById([...searchSourceSeedResults, ...incoming]),
        store.settings.mangaLinks,
      )));
      searchSourceSeedFetchedAt = searchSourceSeedFetchedAt ?? Date.now();
      void loadSearchTrackerScoresForTitles(incoming.map((manga) => manga.title));
    } catch (error) {
      console.warn("Could not prefetch high-confidence recommendations.", error);
    } finally {
      searchRecommendationMoreLoadingKeys = new Set([...searchRecommendationMoreLoadingKeys].filter((entry) => entry !== key));
    }
  }

  async function openSearchRecommendation(item: RecommendationItem) {
    const manga = searchMangaByCandidateId.get(item.candidate.id);
    if (manga) {
      if (manga.inLibrary) {
        setNavPage("library");
        setActiveManga(manga);
      } else {
        setPreviewManga(manga);
      }
      return;
    }

    const novel = searchNovelByCandidateId.get(item.candidate.id);
    if (novel && novelLibraryState) {
      const chapters = novelLibraryState.chapters
        .filter((chapter) => chapter.novelId === novel.id)
        .sort((a, b) => a.order - b.order)
        .map((chapter) => ({ ...chapter, id: chapter.id, novelId: novel.id }));
      setActiveNovelDetail({
        novel: {
          ...novel,
          sourceId: novel.source.id,
          chapters,
        },
        inLibrary: true,
      });
      return;
    }

    const novelSourceResult = searchNovelSourceByCandidateId.get(item.candidate.id);
    if (novelSourceResult) {
      const source = searchNovelSourceById.get(novelSourceResult.sourceId);
      if (!source) return;
      await openNovelSourceResult(source, novelSourceResult);
      return;
    }

    const book = searchBookByCandidateId.get(item.candidate.id);
    if (book) {
      setNavPage("library");
      setActiveBookId(book.id);
      return;
    }

    const sourceProvider = item.candidate.providers.find((provider) => provider.kind === "source");
    if (sourceProvider) {
      activeBrowseTab = "source";
      src_browseQuery = item.candidate.title;
      src_submitted = "";
      addToast({ kind: "info", title: translate("ui_openItFromItsSource"), body: translate("ui_searchIsReadyInSourcesForThisRecommendation") });
      return;
    }

    kw_query = item.candidate.title;
    activeBrowseTab = "keyword";
    void kwDoSearch(item.candidate.title);
  }

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
      const matching = withMangaSourceMetadata((activeTags.length > 1
        ? result.mangas.filter((m) => matchesAllTags(m, activeTags))
        : result.mangas
      ).filter((m) => !shouldHideNsfw(m, store.settings)), src);
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
        const matching = withMangaSourceMetadata((tag_activeTags.length > 1
          ? result.mangas.filter((m) => matchesAllTags(m, tag_activeTags))
          : result.mangas
        ).filter((m) => !shouldHideNsfw(m, store.settings)), src);
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
    const recommendationsTimer = window.setTimeout(() => {
      searchRecommendationsReady = true;
    }, 1_800);
    const handleServerReady = () => {
      void refreshSetupState();
      void refreshSources();
      void refreshTrackers();
      void refreshSearchProfileLibrary();
      void refreshSearchTrackRecords();
      void refreshSearchHardcoverRecords();
      void loadNovelLibraryState({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }).then((state) => {
        novelLibraryState = state;
      }).catch(() => {});
    };
    window.addEventListener(SERVER_READY_EVENT, handleServerReady);
    document.addEventListener("pointerdown", handleBrowsePointerDown);
    return () => {
      window.clearTimeout(recommendationsTimer);
      window.removeEventListener(SERVER_READY_EVENT, handleServerReady);
      document.removeEventListener("pointerdown", handleBrowsePointerDown);
    };
  });

  const browseVisibilitySettings = $derived(
    includeNsfwSources ? { ...store.settings, showNsfw: true } : store.settings,
  );
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
  let src_browseError: string | null   = $state(null);
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

  function sourceBrowseErrorBody(error: unknown) {
    const message = sourceAccessErrorMessage(error);
    if (!isSourceChallengeMessage(message)) return message;
    return store.settings.flareSolverrEnabled
      ? "This source is still blocked by site protection. Check FlareSolverr and retry."
      : "This source needs FlareSolverr for Cloudflare or anti-bot protection.";
  }

  const src_novelSources = $derived.by(() =>
    [
      ...allNovelSources.filter((source) => source.enabled).map((source) => ({
      id: source.pluginId,
      name: source.name,
      displayName: source.name,
      lang: source.lang,
      iconUrl: source.iconUrl,
      isNsfw: false,
      contentKind: "novels" as const,
      novelSource: source,
      })),
      {
        id: "hardcover",
        name: "Hardcover",
        displayName: "Hardcover",
        lang: "all",
        iconUrl: "https://hardcover.app/favicon.ico",
        isNsfw: false,
        contentKind: "hardcover" as const,
      },
    ],
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
      ? src_novelSources.filter((entry) => entry.contentKind === "novels" || entry.contentKind === "hardcover")
      : src_mangaSources.filter((entry) =>
          entry.contentKind === "manga"
          && entry.mangaSource
          && !shouldHideSource(entry.mangaSource, browseVisibilitySettings),
        );
    if (src_selectedLang !== "all") {
      return sources.filter((s) => s.lang === src_selectedLang || s.contentKind === "hardcover");
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
  const searchRecommendationSourcePool = $derived.by(() => {
    if (activeBrowseTab === "keyword" && activeContentType === "novels") {
      const sources = src_novelSources.filter((source) =>
        source.contentKind === "novels"
        && source.novelSource
        && (src_selectedLang === "all" || source.lang === src_selectedLang),
      );
      return interleaveNovelRecommendationSources(sources);
    }

    const sources = activeBrowseTab === "keyword"
      ? src_visibleSources.filter((source) => source.contentKind !== "hardcover")
      : src_visibleSources;
    if (activeBrowseTab === "keyword" || !discoverFocusedSource) return sources;
    return [
      discoverFocusedSource,
      ...sources.filter((source) => source.id !== discoverFocusedSource.id),
    ];
  });

  function searchRecommendationSourceRequest(logicalPage: number) {
    const batchSize = activeContentType === "novels" ? SEARCH_SEED_SOURCE_LIMIT_NOVELS : SEARCH_SEED_SOURCE_LIMIT_MANGA;
    const pool = searchRecommendationSourcePool;
    if (pool.length <= batchSize) {
      return { sources: pool, sourcePage: Math.max(1, logicalPage) };
    }

    const batchCount = Math.ceil(pool.length / batchSize);
    const safePage = Math.max(1, logicalPage);
    const batchIndex = (safePage - 1) % batchCount;
    const sourcePage = Math.floor((safePage - 1) / batchCount) + 1;
    const start = batchIndex * batchSize;
    return {
      sources: pool.slice(start, start + batchSize),
      sourcePage,
    };
  }

  async function refreshSearchSourceSeeds(key: string, sources: BrowseSourceEntry[]) {
    searchSourceSeedAbortCtrl?.abort();
    const ctrl = new AbortController();
    const visibilitySettings = browseVisibilitySettings;
    const mangaLinks = store.settings.mangaLinks;
    untrack(() => {
      searchSourceSeedAbortCtrl = ctrl;
      searchSourceSeedKey = key;
      searchSourceSeedLoading = true;
      searchSourceSeedFetchedAt = Date.now();
      searchFreshSourceSeedResults = [];
      searchMangaSeedAutofillKey = key;
      searchMangaSeedAutofillPage = 1;
      searchMangaSeedAutofillLoading = false;
      searchMangaSeedAutofillExhausted = false;
    });
    const fallbackTerms = ["action", "fantasy", "adventure", "romance"];

    try {
      let collected: Manga[] = [];
      const publishPartial = (incoming: Manga[]) => {
        if (searchSourceSeedKey !== key || ctrl.signal.aborted || incoming.length === 0) return;
        collected = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
          dedupeMangaById([...collected, ...incoming]),
          mangaLinks,
        )));
        untrack(() => {
          searchSourceSeedResults = collected;
        });
      };

      const settled = await Promise.allSettled(sources.map(async (entry) => {
        if (!entry.mangaSource || ctrl.signal.aborted) return [] as Manga[];
        try {
          const data = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
            FETCH_SOURCE_MANGA,
            { source: entry.mangaSource.id, type: "POPULAR", page: 1, query: null },
            ctrl.signal,
          );
          const popular = withMangaSourceMetadata(
            data.fetchSourceManga.mangas.filter((manga) => !shouldHideNsfw(manga, visibilitySettings)),
            entry,
          );
          if (popular.length > 0) {
            publishPartial(popular);
            return popular;
          }
        } catch (error) {
          if (ctrl.signal.aborted) return [] as Manga[];
          logSearchRecommendationSourceIssue("popular recommendations", entry.displayName, error);
        }

        for (const term of fallbackTerms) {
          if (ctrl.signal.aborted) return [] as Manga[];
          const fallback = await fetchSourceMangaSearchWithFallback({
            sourceId: entry.mangaSource.id,
            query: term,
            signal: ctrl.signal,
          });
          const visible = withMangaSourceMetadata(
            fallback.filter((manga) => !shouldHideNsfw(manga, visibilitySettings)),
            entry,
          );
          if (visible.length > 0) {
            publishPartial(visible);
            return visible;
          }
        }

        return [] as Manga[];
      }));

      if (searchSourceSeedKey !== key || ctrl.signal.aborted) return;
      const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const nextResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
        dedupeMangaById([...collected, ...incoming]),
        mangaLinks,
      )));
      untrack(() => {
        searchSourceSeedResults = nextResults;
      });

      const latestSources = sources;
      const latestSettled = await Promise.allSettled(latestSources.map(async (entry) => {
        if (!entry.mangaSource || ctrl.signal.aborted) return [] as Manga[];
        const data = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
          FETCH_SOURCE_MANGA,
          { source: entry.mangaSource.id, type: "LATEST", page: 1, query: null },
          ctrl.signal,
        );
        return withMangaSourceMetadata(
          data.fetchSourceManga.mangas.filter((manga) => !shouldHideNsfw(manga, visibilitySettings)),
          entry,
        );
      }));
      if (searchSourceSeedKey !== key || ctrl.signal.aborted) return;
      const latestIncoming = latestSettled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const nextFreshResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
        dedupeMangaById(latestIncoming),
        mangaLinks,
      )));
      const nextCombinedResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
        dedupeMangaById([...nextResults, ...nextFreshResults]),
        mangaLinks,
      )));
      untrack(() => {
        searchFreshSourceSeedResults = nextFreshResults;
        searchSourceSeedResults = nextCombinedResults;
      });
    } catch (error) {
      if (searchSourceSeedKey !== key || ctrl.signal.aborted) return;
      console.error(error);
      untrack(() => {
        searchSourceSeedResults = [];
        searchFreshSourceSeedResults = [];
      });
    } finally {
      if (searchSourceSeedKey === key && searchSourceSeedAbortCtrl === ctrl) {
        untrack(() => {
          searchSourceSeedLoading = false;
        });
      }
    }
  }

  async function loadMangaSearchSeedAutofill(key: string) {
    if (activeContentType !== "manga" || activeBrowseTab !== "keyword" || kw_submitted || discoverFocusedTracker) return;
    if (searchSourceSeedLoading || searchMangaSeedAutofillLoading || searchMangaSeedAutofillExhausted) return;

    if (searchMangaSeedAutofillKey !== key) {
      searchMangaSeedAutofillKey = key;
      searchMangaSeedAutofillPage = 1;
      searchMangaSeedAutofillExhausted = false;
    }

    const nextPage = searchMangaSeedAutofillPage + 1;
    if (nextPage > SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT) {
      searchMangaSeedAutofillExhausted = true;
      return;
    }

    const request = searchRecommendationSourceRequest(nextPage);
    const sources = request.sources;
    if (sources.length === 0) {
      searchMangaSeedAutofillExhausted = true;
      return;
    }

    const visibilitySettings = browseVisibilitySettings;
    const mangaLinks = store.settings.mangaLinks;
    const previousSeedCount = searchSourceSeedResults.length;
    const previousFreshCount = searchFreshSourceSeedResults.length;
    searchMangaSeedAutofillLoading = true;

    const fetchSourcePage = async (entry: BrowseSourceEntry, type: "POPULAR" | "LATEST") => {
      if (!entry.mangaSource) return [] as Manga[];
      try {
        const data = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
          FETCH_SOURCE_MANGA,
          { source: entry.mangaSource.id, type, page: request.sourcePage, query: null },
        );
        const visible = withMangaSourceMetadata(
          data.fetchSourceManga.mangas.filter((manga) => !shouldHideNsfw(manga, visibilitySettings)),
          entry,
        );
        if (visible.length > 0 || type === "LATEST") return visible;
      } catch (error) {
        logSearchRecommendationSourceIssue(`${type.toLowerCase()} recommendations page ${request.sourcePage}`, entry.displayName, error);
      }

      return [] as Manga[];
    };

    try {
      const [popularSettled, latestSettled] = await Promise.all([
        Promise.allSettled(sources.map((entry) => fetchSourcePage(entry, "POPULAR"))),
        Promise.allSettled(sources.map((entry) => fetchSourcePage(entry, "LATEST"))),
      ]);
      if (searchMangaSeedAutofillKey !== key) return;

      const popularIncoming = popularSettled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const latestIncoming = latestSettled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      if (popularIncoming.length === 0 && latestIncoming.length === 0) {
        searchMangaSeedAutofillPage = nextPage;
        if (nextPage >= SEARCH_RECOMMENDATION_MANGA_AUTOFILL_DUPLICATE_RETRY_LIMIT) {
          searchMangaSeedAutofillExhausted = true;
        }
        return;
      }

      const nextFreshResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
        dedupeMangaById([...searchFreshSourceSeedResults, ...latestIncoming]),
        mangaLinks,
      )));
      const nextSeedResults = capMangaRecommendationSeeds(balanceMangaBySource(dedupeMangaByTitle(
        dedupeMangaById([...searchSourceSeedResults, ...popularIncoming, ...nextFreshResults]),
        mangaLinks,
      )));

      searchFreshSourceSeedResults = nextFreshResults;
      searchSourceSeedResults = nextSeedResults;
      searchSourceSeedFetchedAt = searchSourceSeedFetchedAt ?? Date.now();
      searchMangaSeedAutofillPage = nextPage;

      if (nextSeedResults.length <= previousSeedCount && nextFreshResults.length <= previousFreshCount) {
        if (nextPage >= SEARCH_RECOMMENDATION_MANGA_AUTOFILL_DUPLICATE_RETRY_LIMIT) {
          searchMangaSeedAutofillExhausted = true;
        }
      }
    } catch (error) {
      console.warn("Could not autofill manga search recommendations.", error);
      searchMangaSeedAutofillPage = nextPage;
    } finally {
      searchMangaSeedAutofillLoading = false;
    }
  }

  async function fetchNovelRecommendationSourcePage(
    entry: BrowseSourceEntry,
    pageNo: number,
    scopeInput: { profileId: string | null; serverUrl: string | null },
    fallbackTerms: string[],
  ): Promise<NovelSourceSearchResult[]> {
    if (!entry.novelSource) return [];
    const popular = await withSoftTimeout(
      browseInstalledNovelSource(scopeInput, entry.novelSource.pluginId, pageNo),
      NOVEL_SOURCE_REQUEST_TIMEOUT_MS,
      [] as NovelSourceSearchResult[],
    );
    let collected = dedupeNovelSourceResults(popular);
    if (collected.length >= SEARCH_RECOMMENDATION_LIMIT_STEP) return collected;

    if (pageNo === 1) {
      const nextPageSettled = await Promise.allSettled([2, 3].map((nextPage) =>
        withSoftTimeout(
          browseInstalledNovelSource(scopeInput, entry.novelSource!.pluginId, nextPage),
          NOVEL_SOURCE_REQUEST_TIMEOUT_MS,
          [] as NovelSourceSearchResult[],
        ),
      ));
      collected = dedupeNovelSourceResults([
        ...collected,
        ...nextPageSettled.flatMap((result) => result.status === "fulfilled" ? result.value : []),
      ]);
      if (collected.length >= SEARCH_RECOMMENDATION_LIMIT_STEP) return collected;
    }

    const terms = novelSourceLocalizedFallbackTerms(entry, fallbackTerms);
    const fallbackSettled = await Promise.allSettled(terms.map((term) =>
      withSoftTimeout(
        searchInstalledNovelSource(scopeInput, entry.novelSource!.pluginId, term, pageNo),
        NOVEL_SOURCE_REQUEST_TIMEOUT_MS,
        [] as NovelSourceSearchResult[],
      ),
    ));
    const fallbackResults = fallbackSettled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    return dedupeNovelSourceResults([
      ...collected,
      ...fallbackResults,
    ]).slice(0, Math.max(SEARCH_RECOMMENDATION_LIMIT_STEP, collected.length));
  }

  async function loadNovelSearchSeedAutofill(key: string) {
    if (activeContentType !== "novels" || activeBrowseTab !== "keyword" || kw_submitted || discoverFocusedTracker) return;
    if (searchSourceSeedLoading || searchNovelSeedAutofillLoading || searchNovelSeedAutofillExhausted) return;

    if (searchNovelSeedAutofillKey !== key) {
      searchNovelSeedAutofillKey = key;
      searchNovelSeedAutofillPage = 1;
      searchNovelSeedAutofillExhausted = false;
    }

    const nextPage = searchNovelSeedAutofillPage + 1;
    if (nextPage > SEARCH_RECOMMENDATION_AUTOFILL_PAGE_LIMIT) {
      searchNovelSeedAutofillExhausted = true;
      return;
    }

    const request = searchRecommendationSourceRequest(nextPage);
    const sources = request.sources;
    if (sources.length === 0) {
      searchNovelSeedAutofillExhausted = true;
      return;
    }

    const scopeInput = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };
    const fallbackTerms = novelRecommendationFallbackTerms();
    const previousCount = searchNovelSourceSeedResults.length;
    searchNovelSeedAutofillLoading = true;

    const fetchNovelSourcePage = (entry: BrowseSourceEntry) =>
      fetchNovelRecommendationSourcePage(entry, request.sourcePage, scopeInput, fallbackTerms);

    try {
      const settled = await Promise.allSettled(sources.map(fetchNovelSourcePage));
      if (searchNovelSeedAutofillKey !== key) return;
      const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      searchNovelSeedAutofillPage = nextPage;

      if (incoming.length === 0) {
        if (nextPage >= SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT) {
          searchNovelSeedAutofillExhausted = true;
        }
        return;
      }

      const nextResults = capNovelRecommendationSeeds(balanceNovelSourceResults(dedupeNovelSourceResults([
        ...searchNovelSourceSeedResults,
        ...incoming,
      ])));
      searchNovelSourceSeedResults = nextResults;

      if (nextResults.length <= previousCount && nextPage >= SEARCH_RECOMMENDATION_DUPLICATE_PAGE_RETRY_LIMIT) {
        searchNovelSeedAutofillExhausted = true;
      }
    } catch (error) {
      console.warn("Could not autofill novel search recommendations.", error);
      searchNovelSeedAutofillPage = nextPage;
    } finally {
      searchNovelSeedAutofillLoading = false;
    }
  }

  async function refreshSearchNovelSourceSeeds(key: string, sources: BrowseSourceEntry[]) {
    searchSourceSeedAbortCtrl?.abort();
    const ctrl = new AbortController();
    untrack(() => {
      searchSourceSeedAbortCtrl = ctrl;
      searchSourceSeedKey = key;
      searchSourceSeedLoading = true;
    });
    const fallbackTerms = novelRecommendationFallbackTerms();
    const scopeInput = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };

    try {
      let collected: NovelSourceSearchResult[] = [];
      const publishPartial = (incoming: NovelSourceSearchResult[]) => {
        if (searchSourceSeedKey !== key || ctrl.signal.aborted || incoming.length === 0) return;
        collected = capNovelRecommendationSeeds(balanceNovelSourceResults(dedupeNovelSourceResults([
          ...collected,
          ...incoming,
        ])));
        untrack(() => {
          searchNovelSourceSeedResults = collected;
          searchSourceSeedLoading = false;
        });
      };

      const incoming: NovelSourceSearchResult[] = [];
      for (let start = 0; start < sources.length; start += SEARCH_SEED_SOURCE_LIMIT_NOVELS) {
        if (searchSourceSeedKey !== key || ctrl.signal.aborted) return;
        const batch = sources.slice(start, start + SEARCH_SEED_SOURCE_LIMIT_NOVELS);
        const settled = await Promise.allSettled(batch.map(async (entry) => {
          if (!entry.novelSource || ctrl.signal.aborted) return [] as NovelSourceSearchResult[];
          const popular = await fetchNovelRecommendationSourcePage(entry, 1, scopeInput, fallbackTerms);
          if (ctrl.signal.aborted) return [] as NovelSourceSearchResult[];
          if (popular.length > 0) {
            publishPartial(popular);
            return popular;
          }

          return [] as NovelSourceSearchResult[];
        }));
        incoming.push(...settled.flatMap((result) => result.status === "fulfilled" ? result.value : []));
        if (incoming.length >= SEARCH_RECOMMENDATION_NOVEL_SEED_CAP) break;
      }

      if (searchSourceSeedKey !== key || ctrl.signal.aborted) return;
      if (incoming.length === 0) {
        for (let start = 0; start < sources.length; start += SEARCH_SEED_SOURCE_LIMIT_NOVELS) {
          if (searchSourceSeedKey !== key || ctrl.signal.aborted) return;
          const batch = sources.slice(start, start + SEARCH_SEED_SOURCE_LIMIT_NOVELS);
          const fallbackSettled = await Promise.allSettled(batch.map(async (entry) => {
            if (!entry.novelSource || ctrl.signal.aborted) return [] as NovelSourceSearchResult[];
            const sourceFallbacks: NovelSourceSearchResult[] = [];
            for (const term of fallbackTerms) {
              if (ctrl.signal.aborted) return sourceFallbacks;
              const fallback = await withSoftTimeout(
                searchInstalledNovelSource(scopeInput, entry.novelSource.pluginId, term, 1),
                NOVEL_SOURCE_REQUEST_TIMEOUT_MS,
                [] as NovelSourceSearchResult[],
              );
              if (fallback.length > 0) {
                sourceFallbacks.push(...fallback);
                publishPartial(fallback);
              }
              if (sourceFallbacks.length >= SEARCH_RECOMMENDATION_LIMIT_STEP) break;
            }
            return sourceFallbacks;
          }));
          incoming.push(...fallbackSettled.flatMap((result) => result.status === "fulfilled" ? result.value : []));
          if (incoming.length > 0) break;
        }
      }
      untrack(() => {
        searchNovelSourceSeedResults = capNovelRecommendationSeeds(balanceNovelSourceResults(dedupeNovelSourceResults([
          ...collected,
          ...incoming,
        ])));
      });
    } catch (error) {
      if (searchSourceSeedKey !== key || ctrl.signal.aborted) return;
      console.error(error);
      untrack(() => {
        searchNovelSourceSeedResults = [];
      });
    } finally {
      if (searchSourceSeedKey === key && searchSourceSeedAbortCtrl === ctrl) {
        untrack(() => {
          searchSourceSeedLoading = false;
        });
      }
    }
  }

  function novelDetailTags(detail: NovelDetailRecord) {
    return mergeRecommendationTags(detail.tags ?? [], [
      detail.status ?? "",
    ]);
  }

  function novelDetailUpdatedAtMs(detail: NovelDetailRecord) {
    const chapterTimes = (detail.chapters ?? [])
      .map((chapter) => normalizeTimestampMs(chapter.releaseTime))
      .filter((value): value is number => Number.isFinite(value ?? NaN) && (value ?? 0) > 0);
    return Math.max(0, ...chapterTimes) || null;
  }

  function normalizeTimestampMs(value: number | null | undefined) {
    if (!Number.isFinite(value ?? NaN) || !value) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  async function refreshSearchNovelDetailTags(key: string, results: NovelSourceSearchResult[]) {
    const runId = ++searchNovelDetailTagsRun;
    const missing = results.filter((result) => !searchNovelDetailTagsByKey.has(novelSourceResultKey(result)));
    if (missing.length === 0) {
      searchNovelDetailTagsKey = key;
      return;
    }

    searchNovelDetailTagsKey = key;
    const scopeInput = {
      profileId: store.runtimeResolvedLocalProfileId,
      serverUrl: store.runtimeServerUrl,
    };
    const ctrl = new AbortController();
    const nextTags = new Map<string, string[]>();
    const nextUpdatedAt = new Map<string, number>();
    await runConcurrentLimited(missing, NOVEL_DETAIL_ENRICHMENT_CONCURRENCY, async (result) => {
      if (searchNovelDetailTagsRun !== runId) {
        ctrl.abort();
        return;
      }
      const source = searchNovelSourceById.get(result.sourceId);
      if (!source) return;
      const detail = await withSoftTimeout(
        readInstalledNovelDetails(scopeInput, source.pluginId, result.path, {
          title: result.title,
          coverUrl: result.coverUrl,
        }),
        NOVEL_DETAIL_ENRICHMENT_TIMEOUT_MS,
        null as NovelDetailRecord | null,
      );
      if (!detail || searchNovelDetailTagsRun !== runId) return;
      const tags = novelDetailTags(detail);
      const updatedAtMs = novelDetailUpdatedAtMs(detail);
      const resultKey = novelSourceResultKey(result);
      if (tags.length > 0) nextTags.set(resultKey, tags);
      if (updatedAtMs) nextUpdatedAt.set(resultKey, updatedAtMs);
    }, ctrl.signal);
    if (searchNovelDetailTagsRun !== runId) return;
    if (nextTags.size > 0) {
      searchNovelDetailTagsByKey = new Map([
        ...searchNovelDetailTagsByKey,
        ...nextTags,
      ]);
    }
    if (nextUpdatedAt.size > 0) {
      searchNovelDetailUpdatedAtByKey = new Map([
        ...searchNovelDetailUpdatedAtByKey,
        ...nextUpdatedAt,
      ]);
    }
  }

  $effect(() => {
    if (!searchRecommendationsReady) return;
    const key = [
      "search-source-seeds",
      searchRuntimeScopeKey,
      activeContentType,
      includeNsfwSources ? "nsfw" : "safe",
      src_selectedLang,
      searchRecommendationSourcePool.map((source) => source.id).join(","),
    ].join("|");

    if (activeBrowseTab !== "keyword" || kw_submitted || discoverFocusedTracker) return;
    const seedSources = activeContentType === "novels"
      ? searchRecommendationSourcePool.slice(0, SEARCH_SEED_SOURCE_LIMIT_NOVELS * 2)
      : searchRecommendationSourceRequest(1).sources;
    if (seedSources.length === 0) {
      untrack(() => {
        resetSearchRecommendationSeedState();
      });
      return;
    }
    if (searchSourceSeedKey === key || searchSourceSeedLoading) return;
    window.setTimeout(() => {
      if (activeContentType === "novels") {
        void refreshSearchNovelSourceSeeds(key, seedSources);
      } else {
        void refreshSearchSourceSeeds(key, seedSources);
      }
    }, activeContentType === "novels" ? 220 : 80);
  });

  $effect(() => {
    if (!searchRecommendationsReady) return;
    if (activeContentType !== "novels" || activeBrowseTab !== "keyword" || kw_submitted) return;
    const candidates = searchNovelSourcePool.slice(0, NOVEL_DETAIL_ENRICHMENT_LIMIT);
    if (candidates.length === 0) return;
    const key = [
      "novel-detail-tags",
      store.runtimeResolvedLocalProfileId,
      store.runtimeServerUrl,
      ...candidates.map(novelSourceResultKey),
    ].join("|");
    if (key === searchNovelDetailTagsKey) return;
    window.setTimeout(() => {
      void refreshSearchNovelDetailTags(key, candidates);
    }, 1800);
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
      const key = item.remoteId ? `${item.trackerId}:${item.remoteId}` : `${item.trackerId}:${item.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(item);
    }
    return next;
  }

  function dedupeNovelSourceResults(items: NovelSourceSearchResult[]) {
    const seen = new Set<string>();
    const next: NovelSourceSearchResult[] = [];
    for (const item of items) {
      const key = item.sourceId && item.path
        ? `${item.sourceId}:${item.path}`
        : item.title.toLowerCase().trim();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(item);
    }
    return next;
  }

  function novelSourceResultKey(result: NovelSourceSearchResult) {
    return `${result.sourceId}:${result.path}`;
  }

  function mergeRecommendationTags(primary: string[], secondary: string[]) {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const tag of [...primary, ...secondary]) {
      const normalized = tag.trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(normalized);
    }
    return tags;
  }

  function dedupeScoreTitles(items: Array<string | null | undefined>) {
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const item of items) {
      const title = item?.trim();
      if (!title) continue;
      const key = recommendationTitleKey(title, "manga");
      if (seen.has(key)) continue;
      seen.add(key);
      titles.push(title);
    }
    return titles;
  }

  function mangaRecommendationSourceKey(manga: Manga) {
    return String(manga.source?.id ?? manga.source?.displayName ?? manga.source?.name ?? "unknown");
  }

  function balanceMangaBySource(items: Manga[], perSourceCap = SEARCH_RECOMMENDATION_PER_SOURCE_CAP) {
    const buckets = new Map<string, Manga[]>();
    for (const item of items) {
      const key = mangaRecommendationSourceKey(item);
      const bucket = buckets.get(key) ?? [];
      if (bucket.length < perSourceCap) bucket.push(item);
      buckets.set(key, bucket);
    }

    const balanced: Manga[] = [];
    let added = true;
    while (added) {
      added = false;
      for (const bucket of buckets.values()) {
        const next = bucket.shift();
        if (!next) continue;
        balanced.push(next);
        added = true;
      }
    }
    return balanced;
  }

  function novelRecommendationSourceKey(result: NovelSourceSearchResult) {
    return String(result.sourceId || "unknown");
  }

  function balanceNovelSourceResults(items: NovelSourceSearchResult[], perSourceCap = SEARCH_RECOMMENDATION_PER_SOURCE_CAP) {
    const buckets = new Map<string, NovelSourceSearchResult[]>();
    for (const item of items) {
      const key = novelRecommendationSourceKey(item);
      const bucket = buckets.get(key) ?? [];
      if (bucket.length < perSourceCap) bucket.push(item);
      buckets.set(key, bucket);
    }

    const balanced: NovelSourceSearchResult[] = [];
    let added = true;
    while (added) {
      added = false;
      for (const bucket of buckets.values()) {
        const next = bucket.shift();
        if (!next) continue;
        balanced.push(next);
        added = true;
      }
    }
    return balanced;
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

  function trackerScoreSearchKey(tracker: BrowseTrackerEntry, title: string, contentType: "manga" | "novel" = "manga") {
    return `${tracker.id}:${recommendationTitleKey(title, contentType)}`;
  }

  function isMalTrackerPaused() {
    return Date.now() < malTrackerPausedUntil;
  }

  function pauseMalTrackerRequests() {
    malTrackerPausedUntil = Date.now() + TRACKER_SCORE_MAL_RATE_LIMIT_COOLDOWN_MS;
  }

  function comparableRecommendationTitle(title: string) {
    return recommendationTitleKey(title, "manga")
      .replace(/^comic:/, "")
      .replace(/\b(the|a|an)\b/g, "")
      .replace(/\s+/g, "");
  }

  function trackerTitleMatchScore(queryTitle: string, resultTitle: string | null | undefined) {
    const query = comparableRecommendationTitle(queryTitle);
    const result = comparableRecommendationTitle(resultTitle ?? "");
    if (!query || !result) return 0;
    if (query === result) return 1;
    if (query.length >= 10 && result.length >= 10 && (query.includes(result) || result.includes(query))) return 0.82;
    return 0;
  }

  function bestTrackerTitleMatch<T extends { title: string }>(title: string, results: T[]) {
    return results
      .map((result) => ({ result, score: trackerTitleMatchScore(title, result.title) }))
      .filter((entry) => entry.score >= 0.8)
      .sort((a, b) => b.score - a.score)[0]?.result ?? null;
  }

  function mapAniListMediaToTrackSearch(item: any, tracker: BrowseTrackerEntry, sourceTitle?: string, forceNovel = false): TrackSearch {
    return {
      id: Number(item.id),
      trackerId: tracker.id,
      remoteId: String(item.id),
      title: sourceTitle || item.title?.english || item.title?.romaji || item.title?.native || translate("ui_untitled"),
      coverUrl: item.coverImage?.extraLarge ?? item.coverImage?.large ?? null,
      summary: null,
      publishingStatus: item.status ?? null,
      publishingType: forceNovel ? "NOVEL" : inferAniListPublishingType(item),
      score: item.averageScore ?? item.meanScore ?? null,
      scoreMax: 100,
      popularity: item.popularity ?? null,
      trending: item.trending ?? null,
      genres: item.genres ?? null,
      startDate: item.startDate?.year
        ? `${item.startDate.year}-${String(item.startDate.month ?? 1).padStart(2, "0")}-${String(item.startDate.day ?? 1).padStart(2, "0")}`
        : null,
      totalChapters: item.chapters ?? 0,
      trackingUrl: item.siteUrl ?? null,
    };
  }

  function inferAniListPublishingType(item: any) {
    const country = String(item?.countryOfOrigin ?? "").toUpperCase();
    if (country === "KR") return "MANHWA";
    if (country === "CN") return "MANHUA";
    if (country === "JP") return "MANGA";
    return item?.format ?? null;
  }

  function mapMalMediaToTrackSearch(item: any, tracker: BrowseTrackerEntry, sourceTitle?: string, forceNovel = false): TrackSearch {
    return {
      id: Number(item.mal_id),
      trackerId: tracker.id,
      remoteId: String(item.mal_id),
      title: sourceTitle || item.title_english || item.title || item.title_japanese || translate("ui_untitled"),
      coverUrl: item.images?.webp?.large_image_url ?? item.images?.jpg?.large_image_url ?? item.images?.jpg?.image_url ?? null,
      summary: item.synopsis ?? null,
      publishingStatus: item.status ?? null,
      publishingType: forceNovel ? "NOVEL" : item.type ?? null,
      score: item.score ?? null,
      scoreMax: 10,
      rank: item.rank ?? null,
      popularity: item.members ?? item.scored_by ?? null,
      trending: item.scored_by ?? null,
      genres: [...(item.genres ?? []), ...(item.themes ?? []), ...(item.demographics ?? [])]
        .map((entry: any) => entry?.name)
        .filter(Boolean),
      startDate: item.published?.from ?? null,
      totalChapters: item.chapters ?? 0,
      trackingUrl: item.url ?? `https://myanimelist.net/manga/${item.mal_id}`,
    };
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
            countryOfOrigin
            chapters
            averageScore
            meanScore
            popularity
            trending
            genres
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
    return media.map((item: any) => mapAniListMediaToTrackSearch(item, tracker)) as TrackSearch[];
  }

  async function fetchMalTrackerCatalog(tracker: BrowseTrackerEntry, page: number) {
    if (isMalTrackerPaused()) return [];
    const url = catalogFeed === "latest"
      ? `https://api.jikan.moe/v4/manga?page=${page}&limit=${TRACKER_CATALOG_PAGE_SIZE}&order_by=start_date&sort=desc`
      : `https://api.jikan.moe/v4/top/manga?page=${page}&limit=${TRACKER_CATALOG_PAGE_SIZE}${catalogFeed === "popular" ? "&filter=bypopularity" : ""}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (response.status === 429) {
      pauseMalTrackerRequests();
      return [];
    }
    if (!response.ok) throw new Error(`MyAnimeList catalog failed (${response.status})`);
    const data = await response.json();
    const items = (data?.data ?? []).filter((item: any) => item.mal_id && item.type !== "Anime");
    return items.map((item: any) => mapMalMediaToTrackSearch(item, tracker)) as TrackSearch[];
  }

  async function fetchSearchTrendingAniListCatalog(tracker: BrowseTrackerEntry, page: number) {
    const adultFilter = includeNsfwSources ? "" : ", isAdult: false";
    const query = `
      query SearchTrendingTrackerCatalog($page: Int!, $perPage: Int!) {
        Page(page: $page, perPage: $perPage) {
          media(type: MANGA, sort: [TRENDING_DESC, POPULARITY_DESC]${adultFilter}) {
            id
            title { romaji english native }
            coverImage { large extraLarge }
            siteUrl
            status
            format
            countryOfOrigin
            chapters
            averageScore
            meanScore
            popularity
            trending
            genres
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
        },
      }),
    });
    if (!response.ok) throw new Error(`AniList trending catalog failed (${response.status})`);
    const data = await response.json();
    const media = data?.data?.Page?.media ?? [];
    return media.map((item: any) => mapAniListMediaToTrackSearch(item, tracker)) as TrackSearch[];
  }

  async function fetchSearchTrendingMalCatalog(tracker: BrowseTrackerEntry, page: number) {
    if (isMalTrackerPaused()) return [];
    const url = `https://api.jikan.moe/v4/top/manga?page=${page}&limit=${TRACKER_CATALOG_PAGE_SIZE}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (response.status === 429) {
      pauseMalTrackerRequests();
      return [];
    }
    if (!response.ok) throw new Error(`MyAnimeList trending catalog failed (${response.status})`);
    const data = await response.json();
    const items = (data?.data ?? []).filter((item: any) => item.mal_id && item.type !== "Anime");
    return items.map((item: any) => mapMalMediaToTrackSearch(item, tracker)) as TrackSearch[];
  }

  async function fetchSearchTrendingTrackerCatalog(tracker: BrowseTrackerEntry, page: number) {
    const provider = trackerProviderKind(tracker);
    if (provider === "anilist") return fetchSearchTrendingAniListCatalog(tracker, page);
    if (provider === "mal") return fetchSearchTrendingMalCatalog(tracker, page);
    return [] as TrackSearch[];
  }

  async function fetchGenericTrackerCatalog(tracker: BrowseTrackerEntry, page: number) {
    const query = catalogFeed === "latest" ? "latest manga" : catalogFeed === "popular" ? "popular manga" : "manga";
    const d = await gql<{ searchTracker: { trackSearches: TrackSearch[] } }>(
      SEARCH_TRACKER,
      { trackerId: tracker.id, query: page === 1 ? query : `${query} ${page}` },
    );
    return d.searchTracker.trackSearches ?? [];
  }

  async function fetchAniListTrackerScoreByTitle(tracker: BrowseTrackerEntry, title: string, signal: AbortSignal) {
    const adultFilter = includeNsfwSources ? "" : ", isAdult: false";
    const query = `
      query SearchTrackerScore($search: String!) {
        Page(page: 1, perPage: 5) {
          media(type: MANGA, search: $search${adultFilter}) {
            id
            title { romaji english native }
            coverImage { large extraLarge }
            siteUrl
            status
            format
            countryOfOrigin
            chapters
            averageScore
            meanScore
            popularity
            trending
            genres
            startDate { year month day }
          }
        }
      }
    `;
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { search: title } }),
      signal,
    });
    if (!response.ok) return [];
    const data = await response.json();
    const media = data?.data?.Page?.media ?? [];
    const candidates = media.map((item: any) => ({
      item,
      title: item.title?.english ?? item.title?.romaji ?? item.title?.native ?? "",
    }));
    const match = bestTrackerTitleMatch(title, candidates)
      ?? candidates.find((candidate) => candidate.item.averageScore != null || candidate.item.meanScore != null)
      ?? candidates[0]
      ?? null;
    if (!match) return [];
    return [mapAniListMediaToTrackSearch(match.item, tracker, title, activeContentType === "novels")];
  }

  async function fetchAniListTrackerScoresByTitles(tracker: BrowseTrackerEntry, titles: string[], signal: AbortSignal) {
    const contentType = activeContentType === "novels" ? "novel" : "manga";
    const forceNovel = contentType === "novel";
    const missingTitles = titles.filter((title) => !trackerScoreSearchCache.has(trackerScoreSearchKey(tracker, title, contentType)));
    if (missingTitles.length === 0) {
      return titles.flatMap((title) => trackerScoreSearchCache.get(trackerScoreSearchKey(tracker, title, contentType)) ?? []);
    }

    const adultFilter = includeNsfwSources ? "" : ", isAdult: false";
    for (let start = 0; start < missingTitles.length; start += TRACKER_SCORE_BATCH_SIZE) {
      if (signal.aborted) break;
      const chunk = missingTitles.slice(start, start + TRACKER_SCORE_BATCH_SIZE);
      const variableDefs = chunk.map((_, index) => `$search${index}: String!`).join(", ");
      const pages = chunk.map((_, index) => `
        q${index}: Page(page: 1, perPage: 5) {
          media(type: MANGA, search: $search${index}${adultFilter}) {
            id
            title { romaji english native }
            coverImage { large extraLarge }
            siteUrl
            status
            format
            countryOfOrigin
            chapters
            averageScore
            meanScore
            popularity
            trending
            genres
            startDate { year month day }
          }
        }
      `).join("\n");
      const query = `query SearchTrackerScores(${variableDefs}) { ${pages} }`;
      const variables = Object.fromEntries(chunk.map((title, index) => [`search${index}`, title]));
      try {
        const response = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query, variables }),
          signal,
        });
        if (!response.ok) {
          for (const title of chunk) trackerScoreSearchCache.set(trackerScoreSearchKey(tracker, title, contentType), []);
          continue;
        }
        const data = await response.json();
        chunk.forEach((title, index) => {
          const media = data?.data?.[`q${index}`]?.media ?? [];
          const candidates = media.map((item: any) => ({
            item,
            title: item.title?.english ?? item.title?.romaji ?? item.title?.native ?? "",
          }));
          const match = bestTrackerTitleMatch(title, candidates)
            ?? candidates.find((candidate) => candidate.item.averageScore != null || candidate.item.meanScore != null)
            ?? candidates[0]
            ?? null;
          const results = match ? [mapAniListMediaToTrackSearch(match.item, tracker, title, forceNovel)] : [];
          trackerScoreSearchCache.set(trackerScoreSearchKey(tracker, title, contentType), results);
        });
      } catch {
        for (const title of chunk) {
          if (!trackerScoreSearchCache.has(trackerScoreSearchKey(tracker, title, contentType))) {
            trackerScoreSearchCache.set(trackerScoreSearchKey(tracker, title, contentType), []);
          }
        }
      }
    }

    return titles.flatMap((title) => trackerScoreSearchCache.get(trackerScoreSearchKey(tracker, title, contentType)) ?? []);
  }

  async function fetchMalTrackerScoreByTitle(tracker: BrowseTrackerEntry, title: string, signal: AbortSignal) {
    if (isMalTrackerPaused()) return [];
    const url = `https://api.jikan.moe/v4/manga?q=${encodeURIComponent(title)}&limit=5`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (response.status === 429) {
      pauseMalTrackerRequests();
      return [];
    }
    if (!response.ok) return [];
    const data = await response.json();
    const items = (data?.data ?? []).filter((item: any) => item.mal_id && item.type !== "Anime");
    const candidates = items.map((item: any) => ({
      item,
      title: item.title_english ?? item.title ?? item.title_japanese ?? "",
    }));
    const match = bestTrackerTitleMatch(title, candidates)
      ?? candidates.find((candidate) => candidate.item.score != null)
      ?? candidates[0]
      ?? null;
    if (!match) return [];
    return [mapMalMediaToTrackSearch(match.item, tracker, title, activeContentType === "novels")];
  }

  async function fetchTrackerScoreByTitle(tracker: BrowseTrackerEntry, title: string, signal: AbortSignal) {
    const cacheKey = trackerScoreSearchKey(tracker, title, activeContentType === "novels" ? "novel" : "manga");
    const cached = trackerScoreSearchCache.get(cacheKey);
    if (cached) return cached;

    let results: TrackSearch[] = [];
    const provider = trackerProviderKind(tracker);
    if (provider === "anilist") {
      results = await fetchAniListTrackerScoreByTitle(tracker, title, signal).catch(() => []);
    } else if (provider === "mal") {
      results = await fetchMalTrackerScoreByTitle(tracker, title, signal).catch(() => []);
    }

    trackerScoreSearchCache.set(cacheKey, results);
    return results;
  }

  async function refreshSearchHardcoverScores(key: string, titles: string[]) {
    const scopeInput = hardcoverScopeInput();
    const state = loadHardcoverState(scopeInput);
    const runId = ++searchHardcoverScoreRun;
    untrack(() => {
      searchHardcoverScoreKey = key;
      searchHardcoverScoreLoading = true;
    });

    if (!state.auth.connected || titles.length === 0) {
      searchHardcoverScoreResults = new Map();
      searchHardcoverScoreLoading = false;
      return;
    }

    const providers = new Map<string, RecommendationProviderSignal>();
    const ctrl = new AbortController();
    try {
      await runConcurrentLimited(titles, HARDCOVER_SCORE_ENRICHMENT_CONCURRENCY, async (title) => {
        if (searchHardcoverScoreRun !== runId || searchHardcoverScoreKey !== key) return;
        if (!searchHardcoverOnline) return;
        const titleKey = recommendationTitleKey(title, "novel");
        if (hardcoverScoreSearchCache.has(titleKey)) {
          const cached = hardcoverScoreSearchCache.get(titleKey);
          if (cached) providers.set(titleKey, cached);
          return;
        }

        let provider: RecommendationProviderSignal | null = null;
        for (const searchTitle of canonicalNovelTitleCandidates(title)) {
          if (searchHardcoverScoreRun !== runId || searchHardcoverScoreKey !== key) return;
          if (!searchHardcoverOnline) return;
          const results = await withSoftTimeout(
            searchHardcoverBooks(scopeInput, searchTitle, 5).catch((error) => {
              pauseHardcoverBackgroundEnrichment(error);
              return [];
            }),
            HARDCOVER_SCORE_ENRICHMENT_TIMEOUT_MS,
            [],
          );
          const match = matchHardcoverBook(searchTitle, results);
          if (match && match.rating) {
            provider = hardcoverBookToProvider(match);
            break;
          }
        }
        hardcoverScoreSearchCache.set(titleKey, provider);
        if (provider) providers.set(titleKey, provider);
      }, ctrl.signal);

      if (searchHardcoverScoreRun !== runId || searchHardcoverScoreKey !== key) return;
      searchHardcoverScoreResults = capProviderSignalMap(providers);
    } finally {
      if (searchHardcoverScoreRun === runId && searchHardcoverScoreKey === key) {
        searchHardcoverScoreLoading = false;
      }
    }
  }

  function hardcoverBookToRecommendationCandidate(
    book: HardcoverBookSearchResult,
    queryTags: string[],
  ): RecommendationCandidate {
    const provider = hardcoverBookToProvider(book);
    const ratingConfidence = book.rating == null ? 0 : 0.84;
    const popularityValue = book.ratingsCount && book.ratingsCount > 0
      ? Math.min(1, Math.log10(book.ratingsCount + 1) / 5)
      : 0.38;
    return {
      id: `hardcover-discovery:${book.id}`,
      title: book.title,
      alternativeTitles: book.authors,
      coverUrl: book.coverUrl,
      tags: mergeRecommendationTags(["novel", "book", "hardcover", ...book.genres, ...book.tags, ...book.moods], queryTags),
      contentType: "book",
      status: book.releaseYear ? String(book.releaseYear) : null,
      inLibrary: false,
      safety: "safe",
      publishedAtMs: book.releaseYear ? new Date(book.releaseYear, 0, 1).getTime() : null,
      providers: [{
        ...provider,
        score: provider.score ?? {
          value: book.rating ? Math.min(1, book.rating / 5) : 0,
          confidence: ratingConfidence,
          method: "hardcover-rating",
        },
        popularity: {
          value: popularityValue,
          confidence: book.ratingsCount ? 0.72 : 0.32,
          sourceValue: book.ratingsCount ? `${book.ratingsCount} ratings` : undefined,
          method: "hardcover-ratings-count",
        },
        trending: {
          value: Math.max(0.18, Math.min(0.74, popularityValue * 0.72)),
          confidence: book.ratingsCount ? 0.42 : 0.18,
          method: "hardcover-discovery",
        },
      }, {
        providerId: "hardcover-catalog",
        providerName: "Hardcover",
        kind: "source",
        remoteId: String(book.id),
        availability: { value: 0.76, confidence: 0.62, method: "hardcover-catalog" },
        recency: book.releaseYear ? undefined : { value: 0.18, confidence: 0.16, method: "hardcover-catalog" },
      }],
    };
  }

  async function refreshSearchHardcoverDiscovery(key: string, queries: string[]) {
    const scopeInput = hardcoverScopeInput();
    const state = loadHardcoverState(scopeInput);
    const runId = ++searchHardcoverDiscoveryRun;
    untrack(() => {
      searchHardcoverDiscoveryKey = key;
      searchHardcoverDiscoveryLoading = true;
    });

    if (!state.auth.connected || queries.length === 0) {
      searchHardcoverDiscoveryResults = [];
      searchHardcoverDiscoveryLoading = false;
      return;
    }

    const byId = new Map<number, RecommendationCandidate>();
    const ctrl = new AbortController();
    try {
      await runConcurrentLimited(queries, 1, async (query) => {
        if (searchHardcoverDiscoveryRun !== runId || searchHardcoverDiscoveryKey !== key) return;
        if (!searchHardcoverOnline) return;
        const queryTags = query
          .split(/\s+/)
          .map((part) => part.trim())
          .filter((part) => part.length > 2 && part.toLowerCase() !== "novel");
        const books = await withSoftTimeout((async () => {
          try {
            const weighted = await searchHardcoverBooks(scopeInput, query, HARDCOVER_DISCOVERY_RESULTS_PER_QUERY, 1, {
              fields: "series_names,title,subtitle,description",
              weights: "8,5,4,3",
              sort: "rating:desc",
              cacheGroup: "recommendation-discovery",
            });
            return weighted.filter((book) =>
              typeof book.rating === "number" && book.rating >= HARDCOVER_DISCOVERY_MIN_RATING,
            );
          } catch (error) {
            pauseHardcoverBackgroundEnrichment(error);
            return [];
          }
        })(), HARDCOVER_DISCOVERY_TIMEOUT_MS, []);
        for (const book of books) {
          if (searchHardcoverDiscoveryRun !== runId || searchHardcoverDiscoveryKey !== key) return;
          if (byId.has(book.id)) continue;
          byId.set(book.id, hardcoverBookToRecommendationCandidate(book, queryTags));
        }
        if (byId.size > 0 && searchHardcoverDiscoveryRun === runId && searchHardcoverDiscoveryKey === key) {
          searchHardcoverDiscoveryResults = capProviderResults([...byId.values()]);
        }
      }, ctrl.signal);

      if (searchHardcoverDiscoveryRun !== runId || searchHardcoverDiscoveryKey !== key) return;
      searchHardcoverDiscoveryResults = capProviderResults([...byId.values()]);
    } finally {
      if (searchHardcoverDiscoveryRun === runId && searchHardcoverDiscoveryKey === key) {
        searchHardcoverDiscoveryLoading = false;
      }
    }
  }

  async function refreshSearchTrackerScores(key: string, titles: string[], trackers: BrowseTrackerEntry[]) {
    searchTrackerScoreAbortCtrl?.abort();
    const ctrl = new AbortController();
    untrack(() => {
      searchTrackerScoreAbortCtrl = ctrl;
      searchTrackerScoreKey = key;
      searchTrackerScoreLoading = true;
    });

    const usableTrackers = trackers.filter((tracker) => {
      const provider = trackerProviderKind(tracker);
      return provider === "anilist" || provider === "mal";
    });

    if (titles.length === 0 || usableTrackers.length === 0) {
      searchTrackerScoreResults = [];
      searchTrackerScoreLoading = false;
      return;
    }

    const collected: TrackSearch[] = [];

    try {
      for (const tracker of usableTrackers) {
        if (ctrl.signal.aborted || searchTrackerScoreKey !== key) return;
        const provider = trackerProviderKind(tracker);
        if (provider === "anilist") {
          collected.push(...await fetchAniListTrackerScoresByTitles(tracker, titles, ctrl.signal));
          continue;
        }

        const coveredTitles = new Set(collected.map((result) => recommendationTitleKey(result.title, "manga")));
        const fallbackTitles = titles
          .filter((title) => !coveredTitles.has(recommendationTitleKey(title, "manga")))
          .slice(0, TRACKER_SCORE_MAL_FALLBACK_LIMIT);
        for (const title of fallbackTitles) {
          if (ctrl.signal.aborted || searchTrackerScoreKey !== key) return;
          collected.push(...await fetchTrackerScoreByTitle(tracker, title, ctrl.signal));
        }
      }
      if (ctrl.signal.aborted || searchTrackerScoreKey !== key) return;
      searchTrackerScoreResults = capProviderResults(dedupeTrackSearches(collected));
    } finally {
      if (searchTrackerScoreKey === key) searchTrackerScoreLoading = false;
    }
  }

  async function loadSearchTrackerScoresForTitles(titles: string[]) {
    const cleanedTitles = dedupeScoreTitles(titles).slice(0, TRACKER_SCORE_BATCH_SIZE);
    const usableTrackers = usableSearchTrackers(searchScoreTrackers);
    if (cleanedTitles.length === 0 || usableTrackers.length === 0) return false;

    const ctrl = new AbortController();
    const collected: TrackSearch[] = [];
    for (const tracker of usableTrackers) {
      const provider = trackerProviderKind(tracker);
      if (provider === "anilist") {
        collected.push(...await fetchAniListTrackerScoresByTitles(tracker, cleanedTitles, ctrl.signal));
        continue;
      }

      const coveredTitles = new Set(collected.map((result) => recommendationTitleKey(result.title, "manga")));
      const fallbackTitles = cleanedTitles
        .filter((title) => !coveredTitles.has(recommendationTitleKey(title, "manga")))
        .slice(0, TRACKER_SCORE_MAL_FALLBACK_LIMIT);
      for (const title of fallbackTitles) {
        collected.push(...await fetchTrackerScoreByTitle(tracker, title, ctrl.signal));
      }
    }

    if (collected.length === 0) return false;
    searchTrackerScoreResults = capProviderResults(dedupeTrackSearches([...searchTrackerScoreResults, ...collected]));
    return true;
  }

  async function refreshSearchTrackerTrendingFeed(key: string, trackers: BrowseTrackerEntry[]) {
    searchTrackerTrendingKey = key;
    searchTrackerTrendingLoading = true;
    const usableTrackers = usableSearchTrackers(trackers);

    if (usableTrackers.length === 0) {
      searchTrackerTrendingResults = [];
      searchTrackerTrendingLoading = false;
      return;
    }

    try {
      const requests = usableTrackers.flatMap((tracker) => [
        fetchSearchTrendingTrackerCatalog(tracker, 1).catch(() => [] as TrackSearch[]),
        fetchSearchTrendingTrackerCatalog(tracker, 2).catch(() => [] as TrackSearch[]),
      ]);
      const results = (await Promise.all(requests)).flat();
      if (searchTrackerTrendingKey !== key) return;
      searchTrackerTrendingResults = capProviderResults(dedupeTrackSearches(results));
      searchTrackerTrendingPage = 2;
      window.setTimeout(() => {
        if (searchTrackerTrendingKey === key) void prefetchSearchTrackerTrendingPages(3, 2);
      }, 250);
    } finally {
      if (searchTrackerTrendingKey === key) {
        searchTrackerTrendingLoading = false;
      }
    }
  }

  async function loadSearchTrackerTrendingMore() {
    const usableTrackers = usableSearchTrackers(searchScoreTrackers);
    if (usableTrackers.length === 0 || searchTrackerTrendingLoading) return false;

    searchTrackerTrendingLoading = true;
    const nextPage = searchTrackerTrendingPage + 1;
    try {
      const results = (await Promise.all(
        usableTrackers.map((tracker) =>
          fetchSearchTrendingTrackerCatalog(tracker, nextPage).catch(() => [] as TrackSearch[]),
        ),
      )).flat();
      if (results.length === 0) return false;
      searchTrackerTrendingResults = capProviderResults(dedupeTrackSearches([...searchTrackerTrendingResults, ...results]));
      searchTrackerTrendingPage = nextPage;
      return true;
    } finally {
      searchTrackerTrendingLoading = false;
    }
  }

  async function prefetchSearchTrackerTrendingPages(startPage: number, pageCount: number) {
    const usableTrackers = usableSearchTrackers(searchScoreTrackers);
    if (usableTrackers.length === 0) return;
    const expectedKey = searchTrackerTrendingKey;
    const pages = Array.from({ length: pageCount }, (_, index) => startPage + index);
    const results = (await Promise.all(pages.flatMap((page) =>
      usableTrackers.map((tracker) =>
        fetchSearchTrendingTrackerCatalog(tracker, page).catch(() => [] as TrackSearch[]),
      ),
    ))).flat();
    if (searchTrackerTrendingKey !== expectedKey || results.length === 0) return;
    searchTrackerTrendingResults = capProviderResults(dedupeTrackSearches([...searchTrackerTrendingResults, ...results]));
    searchTrackerTrendingPage = Math.max(searchTrackerTrendingPage, startPage + pageCount - 1);
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
      trackerCatalogResults = capProviderResults(dedupeTrackSearches(incoming));
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
      trackerCatalogResults = capProviderResults(dedupeTrackSearches([...trackerCatalogResults, ...incoming]));
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
        const failures = settled.filter((result) => result.status === "rejected");
        if (discoverNovelResults.length === 0 && failures.length > 0) {
          const firstFailure = failures[0] as PromiseRejectedResult;
          discoverError = firstFailure.reason instanceof Error
            ? firstFailure.reason.message
            : "Could not load novel source discovery results.";
        }
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
          const popular = withMangaSourceMetadata(
            d.fetchSourceManga.mangas.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings)),
            entry,
          );
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
          const visible = withMangaSourceMetadata(
            fallback.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings)),
            entry,
          );
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
        discoverNovelResults = capProviderResults([...discoverNovelResults, ...incoming]);
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
          mangas: withMangaSourceMetadata(
            d.fetchSourceManga.mangas.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings)),
            entry,
          ),
          hasNextPage: d.fetchSourceManga.hasNextPage,
        };
      }));
      if (discoverLoadedKey !== key) return;
      const incoming = settled.flatMap((result) => result.status === "fulfilled" ? result.value.mangas : []);
      discoverMangaResults = capProviderResults(dedupeMangaByTitle(
        dedupeMangaById([...discoverMangaResults, ...incoming]),
        store.settings.mangaLinks,
      ));
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
    if (activeBrowseTab === "keyword" && searchQuery !== kw_query) {
      kw_query = searchQuery;
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
    src_browseError = null;
    if (page === 1) { src_browseResults = []; }
    try {
      const d = await gql<{ fetchSourceManga: { mangas: Manga[]; hasNextPage: boolean } }>(
        FETCH_SOURCE_MANGA, { source: src.id, type, page, query: q ?? null }, ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      const incoming = withMangaSourceMetadata(
        d.fetchSourceManga.mangas.filter((m) => !shouldHideNsfw(m, browseVisibilitySettings)),
        src,
      );
      src_browseResults = page === 1 ? incoming : [...src_browseResults, ...incoming];
      src_hasNextPage = d.fetchSourceManga.hasNextPage;
      src_currentPage = page;
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        console.error(e);
        src_browseError = sourceBrowseErrorBody(e);
      }
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
    src_browseError = null;
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
      if ((e as { name?: string })?.name !== "AbortError") {
        console.error(e);
        src_browseError = sourceBrowseErrorBody(e);
      }
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
    await openNovelSourceResult(src_activeNovelSource, result);
  }

  async function openNovelSourceResult(source: InstalledNovelSourceDescriptor, result: NovelSourceSearchResult) {
    src_openingNovelPath = result.path;
    try {
      const detail = await readInstalledNovelDetails({
        profileId: store.runtimeResolvedLocalProfileId,
        serverUrl: store.runtimeServerUrl,
      }, source.pluginId, result.path, {
        title: result.title,
        coverUrl: result.coverUrl,
      });
      setActiveNovelDetail({
        novel: detail,
        inLibrary: novelLibraryState ? isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path)) : false,
      });
    } catch (error) {
      const message = sourceBrowseErrorBody(error);
      addToast({
        kind: "error",
        title: translate("novelSources_errors_openDetailTitle"),
        body: message || translate("ui_aethonCouldnTOpenThisNovel"),
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
    releaseBrowseTransientState();
    void shutdownInstalledNovelSourcesRuntime();
    document.body.classList.remove("aethon-browse-search-engaged");
  });
</script>

<div class="root" class:is-search-engaged={browseSearchFocused}>
  <AppTopbar className="browse-topbar">
    {#snippet left()}
      <nav class="n-segmented" data-active={activeContentType === "novels" ? "novels" : "manga"} aria-label={$_("browse.contentType")}>
        <span class="n-segmented__thumb" aria-hidden="true"></span>
        <button
          type="button"
          class="n-segmented__btn"
          class:is-active={activeContentType === "manga"}
          onclick={() => selectContentType("manga")}
        >
          {$_("common.comics")}
        </button>
        <button
          type="button"
          class="n-segmented__btn"
          class:is-active={activeContentType === "novels"}
          onclick={() => selectContentType("novels")}
        >
          {$_("common.books")}
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
            placeholder={browseSearchPlaceholder()}
            oninput={(event) => handleTopbarSearchInput((event.currentTarget as HTMLInputElement).value)}
            onfocus={handleBrowseSearchFocus}
            onblur={handleBrowseSearchBlur}
            onkeydown={(event) => event.key === "Enter" && handleSearch(searchQuery)}
          />
        </div>
      </div>
    {/snippet}

    {#snippet right()}
      <div class="browse-topbar__right">
        <ActivityButton />
        <WindowControlsInline />
      </div>
    {/snippet}
  </AppTopbar>

  <div class="browseSubtabs">
    <button class="browseSubtab" class:browseSubtabActive={activeBrowseTab === "keyword"} onclick={() => selectBrowseTab("keyword")}>
      {browseTabLabel("keyword")}
    </button>
    <button class="browseSubtab" class:browseSubtabActive={activeBrowseTab === "browse"} onclick={() => selectBrowseTab("browse")}>
      {browseTabLabel("browse")}
    </button>
    <button class="browseSubtab" class:browseSubtabActive={activeBrowseTab === "source"} onclick={() => selectBrowseTab("source")}>
      {browseTabLabel("source")}
    </button>
  </div>

  {#if activeBrowseTab !== "source" && setupState && setupState.kind !== "ready"}
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
    {#if !kw_submitted}
      <section class="searchLanding">
        <div class="searchCanvas">
          <main class="searchMainColumn">
          <div class="searchHeroCopy">
            <span class="n-eyebrow">{$_("browse.search.eyebrow")}</span>
            <h2>{$_("browse.search.title")}</h2>
            <p>{searchHeroStatusText}</p>
          </div>

          {#if searchRecommendationHydrating}
            <NocturneState
              layout="compact"
              tone="info"
              icon="retry"
              eyebrow={$_("browse.search.statusEyebrow")}
              title={$_("browse.search.preparingRecommendations")}
              body={searchHeroStatusText}
            />
          {:else if searchEmptyStateMessage}
            <NocturneState
              layout="compact"
              tone={setupState?.kind === "server_offline" ? "danger" : "info"}
              icon={setupState?.kind === "server_offline" ? "plug" : "info"}
              eyebrow={$_("browse.search.statusEyebrow")}
              title={$_("browse.search.recommendationsUnavailable")}
              body={searchEmptyStateMessage}
            />
          {:else}
            {#each searchRecommendationSections as section (section.key)}
              <section class="searchRecommendationSection">
                <div class="searchRecommendationHeader">
                  <div>
                    <span class="searchSectionIcon material-symbols-outlined" aria-hidden="true">
                      {section.key === "outsideYourUsualReads" ? "explore" : section.key === "freshInYourSources" ? "local_fire_department" : "star"}
                    </span>
                    <h3>{section.title}</h3>
                    <p>{section.reason}</p>
                  </div>
                  {#if section.items.length > 0 || canLoadSearchSectionMore(section.key)}
                    <div class="searchRailControls" aria-label={`${section.title} carousel controls`}>
                      <button type="button" aria-label={`Scroll ${section.title} left`} onclick={() => scrollSearchSection(section.key, -1)}>
                        <span class="material-symbols-outlined" aria-hidden="true">chevron_left</span>
                      </button>
                      <button type="button" aria-label={`Scroll ${section.title} right`} onclick={() => section.items.length > 0 ? advanceSearchSection(section.key) : loadMoreSearchRecommendations(section.key)}>
                        <span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>
                      </button>
                    </div>
                  {/if}
                </div>
                {#if section.items.length > 0}
                  <div class="searchRecommendationRow" data-search-row={section.key} onscroll={(event) => handleSearchRailScroll(section.key, event)}>
                    {#each section.items as item (item.candidate.id)}
                      {@const bannerInfo = getRecommendationBannerInfo(item)}
                      <button
                        class="n-library-card"
                        onclick={() => openSearchRecommendation(item)}
                      >
                        <div class="card-cover-container searchRecommendationCard">
                          <div class="n-library-card__cover">
                            {#if hasSearchCover(item.candidate)}
                              <img
                                src={resolveMangaCoverUrl(item.candidate.coverUrl, { context: "browse", persistence: "memory" })}
                                alt={item.candidate.title}
                                loading="lazy"
                                decoding="async"
                                fetchpriority="low"
                                onerror={() => markSearchCoverFailed(item.candidate)}
                              />
                            {:else}
                              <div class="searchCoverPlaceholder" aria-hidden="true">
                                <span>{item.candidate.title}</span>
                              </div>
                            {/if}
                          </div>
                          {#if bannerInfo}
                            <div class="source-metric-banner" aria-label={$_("ui_trackerRatingBanner")}>
                              <span
                                class="source-metric-flag"
                                aria-label={bannerInfo.tracker}
                                style="background-color: {getTrackerBgColor(bannerInfo.tracker)};"
                              >
                                {#if bannerInfo.tracker === "anilist"}
                                  <!-- AniList Icon -->
                                  <svg viewBox="0 0 24 24" class="source-metric-flag-img" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M24 17.53v2.421c0 .71-.391 1.101-1.1 1.101h-5l-.057-.165L11.84 3.736c.106-.502.46-.788 1.053-.788h2.422c.71 0 1.1.391 1.1 1.1v12.38H22.9c.71 0 1.1.392 1.1 1.101z" fill="#02a9ff"/>
                                    <path d="M11.034 2.947l6.337 18.104h-4.918l-1.052-3.131H6.019l-1.077 3.131H0L6.361 2.948h4.673zm-.66 10.96-1.69-5.014-1.541 5.015h3.23z" fill="#fff"/>
                                  </svg>
                                {:else if bannerInfo.tracker === "myanimelist"}
                                  <!-- MyAnimeList Icon -->
                                  <svg viewBox="0 0 24 24" class="source-metric-flag-img" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M14.921 6.479c-.82 0-3.683 0-4.947 3.156-.662 1.652-.986 4.812.876 7.886l1.934-1.41s-.767-1.095-1.083-3.191h2.897l.022 3.19h2.604V8.835h-2.581v2.043l-2.46-.023s.413-2.408 2.877-2.336h2.454l-.572-2.04ZM0 6.528v9.624h2.348v-5.84l2.031 2.664 2.047-2.652v5.828h2.336V6.528H6.437L4.368 9.474 2.31 6.528Zm18.447.022v9.583h5.022L24 14.09h-3.232V6.55Z" fill="#fff"/>
                                  </svg>
                                {:else if bannerInfo.tracker === "kitsu"}
                                  <!-- Kitsu Icon -->
                                  <svg viewBox="0 0 24 24" class="source-metric-flag-img" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M1.429 5.441a12.478 12.478 0 0 0 1.916 2.056c.011.011.022.011.022.022.452.387 1.313.947 1.937 1.173 0 0 3.886 1.496 4.091 1.582a1.4 1.4 0 0 0 .237.075.694.694 0 0 0 .808-.549c.011-.065.022-.172.022-.248V5.161c.011-.667-.205-1.679-.398-2.239 0-.011-.011-.022-.011-.032A11.979 11.979 0 0 0 8.824.36L8.781.285a.697.697 0 0 0-.958-.162c-.054.032-.086.075-.129.119L7.608.36a4.743 4.743 0 0 0-.786 3.412 8.212 8.212 0 0 0-.775.463c-.043.032-.42.291-.71.56A4.803 4.803 0 0 0 1.87 4.3c-.043.011-.097.021-.14.032-.054.022-.107.043-.151.076a.702.702 0 0 0-.193.958l.043.075zM8.222 1.07c.366.614.678 1.249.925 1.917-.495.086-.98.215-1.453.388a3.918 3.918 0 0 1 .528-2.305zM4.658 5.463a7.467 7.467 0 0 0-.893 1.216 11.68 11.68 0 0 1-1.453-1.55 3.825 3.825 0 0 1 2.346.334zm13.048-.302a7.673 7.673 0 0 0-2.347-.474 7.583 7.583 0 0 0-3.811.818l-.215.108v3.918c0 .054 0 .258-.032.431a1.535 1.535 0 0 1-.646.98 1.545 1.545 0 0 1-1.152.247 2.618 2.618 0 0 1-.409-.118 747.6 747.6 0 0 1-3.402-1.313 8.9 8.9 0 0 0-.323-.129 30.597 30.597 0 0 0-3.822 3.832l-.075.086a.698.698 0 0 0 .538 1.098.676.676 0 0 0 .42-.118c.011-.011.022-.022.043-.032 1.313-.947 2.756-1.712 4.284-2.325a.7.7 0 0 1 .818.13.704.704 0 0 1 .054.915l-.237.388a20.277 20.277 0 0 0-1.97 4.306l-.032.129a.646.646 0 0 0 .108.538.713.713 0 0 0 .549.301.657.657 0 0 0 .42-.118c.054-.043.108-.086.151-.14l.043-.065a18.95 18.95 0 0 1 1.765-2.153 20.156 20.156 0 0 1 10.797-6.018c.032-.011.065-.011.097-.011.237.011.42.215.409.452a.424.424 0 0 1-.344.398c-3.908.829-10.948 5.469-8.483 12.208.043.108.075.172.129.269a.71.71 0 0 0 .538.301.742.742 0 0 0 .657-.398c.398-.754 1.152-1.593 3.326-2.497 6.061-2.508 7.062-6.093 7.17-8.364v-.129a7.716 7.716 0 0 0-5.016-7.451zm-6.083 17.762c-.56-1.669-.506-3.283.151-4.823 1.26 2.035 3.456 2.207 3.456 2.207-2.25.937-3.133 1.863-3.607 2.616z" fill="#fff"/>
                                  </svg>
                                {:else if bannerInfo.tracker === "mangaupdates"}
                                  <!-- MangaUpdates Icon -->
                                  <svg viewBox="0 0 24 24" class="source-metric-flag-img" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M4.5 0C2.02 0 0 2.02 0 4.5v15C0 21.98 2.02 24 4.5 24h15c2.48 0 4.5-2.02 4.5-4.5v-15C24 2.02 21.98 0 19.5 0Zm0 1.5h15c1.675 0 3 1.325 3 3v15c0 1.675-1.325 3-3 3h-15c-1.675 0-3-1.325-3-3v-15c0-1.675 1.325-3 3-3zm12.791.595c-.475 0-.87.132-1.187.401-.3.253-.552.587-.758 1-.222.443-.39.901-.501 1.376-.111.475-.228.944-.355 1.403-.412 1.568-.84 3.127-1.283 4.68a36.509 36.509 0 0 1-1.64 4.56 35.575 35.575 0 0 1-1.093-5.059 37.104 37.104 0 0 1-.355-5.156c0-.206.015-.402.047-.592.032-.206.047-.412.047-.618a1.385 1.385 0 0 0-.689-1.236 2.084 2.084 0 0 0-.688-.308c-.253-.08-.5-.12-.738-.12-.333 0-.641.071-.926.214a2.9 2.9 0 0 0-.759.547 3.62 3.62 0 0 0-.548.783 3.629 3.629 0 0 0-.307.879 35.408 35.408 0 0 0-.405 2.115c-.095.696-.245 1.4-.45 2.112a51.043 51.043 0 0 1-.786 2.353c-.285.84-.563 1.687-.832 2.543-.27.854-.499 1.708-.689 2.563-.19.84-.284 1.632-.284 2.376 0 .349.023.698.07 1.046.064.333.176.633.335.902.158.27.372.484.641.642.27.174.608.26 1.02.26.443 0 .785-.116 1.022-.354.253-.221.437-.54.548-.952.143-.555.214-1.11.214-1.664.016-.57.061-1.13.14-1.685.096-.76.261-1.496.499-2.209.253-.712.538-1.426.855-2.138.238.903.493 1.789.762 2.66.285.871.53 1.76.735 2.663.08.333.15.671.214 1.02.063.332.15.666.26.999.143.443.365.845.666 1.21.3.364.706.547 1.213.547.316 0 .64-.048.972-.143.349-.08.65-.23.903-.451.11-.095.215-.238.31-.428s.182-.397.261-.618a6.432 6.432 0 0 0 .38-1.187c.096-.364.182-.736.262-1.116.079-.38.173-.752.284-1.116.126-.444.27-.88.427-1.307.175-.443.35-.879.525-1.306.222-.587.428-1.18.618-1.782.19-.602.37-1.206.545-1.807.19.76.317 1.519.38 2.279.064.76.102 1.53.118 2.306l.097 2.302c.047.76.149 1.522.307 2.283.095.459.268.846.522 1.163.269.316.659.474 1.166.474.412 0 .743-.094.996-.284.253-.19.452-.427.595-.712.142-.285.236-.604.284-.952.047-.347.073-.688.073-1.02v-.002c0-1.013-.079-2.008-.237-2.989a39.692 39.692 0 0 0-.548-2.994 39.075 39.075 0 0 1-.642-3.516 29.924 29.924 0 0 1-.214-3.565c0-.253.01-.498.027-.735.031-.254.047-.506.047-.76 0-.347-.08-.633-.238-.855a1.46 1.46 0 0 0-.57-.547 2.233 2.233 0 0 0-.81-.285 3.931 3.931 0 0 0-.855-.093z" fill="#fff"/>
                                  </svg>
                                {:else if bannerInfo.tracker === "bangumi"}
                                  <!-- Bangumi Icon -->
                                  <svg viewBox="0 0 362 410" class="source-metric-flag-img" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M284.083 6.56177C285.982 3.84619 289.723 3.18424 292.438 5.08325C295.154 6.9823 295.816 10.7232 293.917 13.4387L209.476 134.189C209.505 134.201 209.535 134.213 209.564 134.225C216.298 137.014 222.416 141.103 227.569 146.256C229.071 147.758 230.483 149.343 231.798 151H332C348.569 151 362 164.432 362 181V346C362 362.569 348.568 376 332 376H175.275L133.035 407.974C129.358 410.756 124.255 410.665 120.681 407.751C117.107 404.837 115.989 399.856 117.975 395.695L127.37 376H44C19.6996 376 0.000189693 356.301 0 332V181C0 164.432 13.4315 151 30 151H144.853C146.168 149.343 147.579 147.758 149.081 146.256C153.375 141.962 158.338 138.407 163.769 135.728L45.2051 14.1897C42.8914 11.8178 42.9388 8.01922 45.3105 5.70532C47.6826 3.39156 51.481 3.43886 53.7949 5.81079L176.243 131.331C180.2 130.449 184.252 130 188.325 130C191.323 130 194.309 130.243 197.255 130.723L284.083 6.56177ZM127 400L158.707 376H138.449L127 400ZM44 167C36.268 167 30 173.268 30 181V332C30.0002 339.732 36.2681 346 44 346H332C339.732 346 346 339.732 346 332V181C346 173.268 339.732 167 332 167H44Z" fill="#ff3599"/>
                                    <path d="M332 167C339.732 167 346 173.268 346 181V332C346 339.732 339.732 346 332 346H198.34L127 400L152.762 346H44C36.268 346 30 339.732 30 332V181C30 173.268 36.268 167 44 167H332Z" fill="white"/>
                                    <path d="M220 232C221.437 232 222.764 232.771 223.476 234.02C224.187 235.268 224.174 236.803 223.441 238.039L191.441 292.039C190.721 293.255 189.413 294 188 294C186.587 294 185.279 293.255 184.559 292.039L152.559 238.039C151.826 236.803 151.813 235.268 152.524 234.02C153.236 232.771 154.563 232 156 232H220ZM312 279C314.209 279 316 280.791 316 283C316 285.209 314.209 287 312 287H248.5C246.291 287 244.5 285.209 244.5 283C244.5 280.791 246.291 279 248.5 279H312ZM127.5 278.5C129.709 278.5 131.5 280.291 131.5 282.5C131.5 284.709 129.709 286.5 127.5 286.5H64C61.7909 286.5 60 284.709 60 282.5C60 280.291 61.7909 278.5 64 278.5H127.5ZM188 282.153L212.979 240H163.021L188 282.153ZM312 265C314.209 265 316 266.791 316 269C316 271.209 314.209 273 312 273H248.5C246.291 273 244.5 271.209 244.5 269C244.5 266.791 246.291 265 248.5 265H312ZM127.5 264.5C129.709 264.5 131.5 266.291 131.5 268.5C131.5 270.709 129.709 272.5 127.5 272.5H64C61.7909 272.5 60 270.709 60 268.5C60 266.291 61.7909 264.5 64 264.5H127.5ZM310.498 207.793C312.546 206.963 314.877 207.951 315.707 209.998C316.537 212.046 315.549 214.377 313.502 215.207L264.65 235L313.502 254.793C315.549 255.623 316.537 257.954 315.707 260.002C314.877 262.049 312.546 263.037 310.498 262.207L252.498 238.707C250.988 238.095 250 236.629 250 235C250 233.371 250.988 231.905 252.498 231.293L310.498 207.793ZM60.293 209.498C61.1225 207.451 63.4545 206.463 65.502 207.293L123.502 230.793C125.012 231.405 126 232.871 126 234.5C126 236.129 125.012 237.595 123.502 238.207L65.502 261.707C63.4545 262.537 61.1225 261.549 60.293 259.502C59.4634 257.454 60.4506 255.123 62.498 254.293L111.35 234.5L62.498 214.707C60.4506 213.877 59.4634 211.546 60.293 209.498Z" fill="#ff3599"/>
                                  </svg>
                                {:else if bannerInfo.tracker === "hardcover"}
                                  <!-- Hardcover Icon -->
                                  <svg viewBox="0 0 24 24" class="source-metric-flag-img" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M7.5 6.5v11H16c.8 0 1.5-.7 1.5-1.5V8c0-.8-.7-1.5-1.5-1.5H7.5zm2.8 2.8h4.7v.9h-4.7v-.9zm0 2.8h4.7v.9h-4.7v-.9z" fill="#fff"/>
                                  </svg>
                                {:else}
                                  <!-- Fallback Icon -->
                                  <svg viewBox="0 0 24 24" class="source-metric-flag-img" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M12 6.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5L12 6.5z" fill="#fff"/>
                                  </svg>
                                {/if}
                              </span>
                              <div class="source-metric-pill has-flag">
                                <span class="source-metric-downloaded has-flag pill-only" aria-label={$_("ui_score")}>
                                  <span class="source-metric-score-val">{bannerInfo.score}</span>
                                  <!-- Golden Star Icon -->
                                  <svg viewBox="0 0 24 24" class="source-metric-star-img" fill="#ffb800" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                                  </svg>
                                </span>
                              </div>
                            </div>
                          {/if}
                        </div>
                        <div class="n-library-card__info">
                          <p class="n-library-card__title">{item.candidate.title}</p>
                          <div class="n-library-card__meta">
                            <span class="n-library-card__author">{recommendationProviderLabel(item)}</span>
                            <span class="n-library-card__vol">{recommendationStatusLabel(item)}</span>
                          </div>
                        </div>
                      </button>
                    {/each}
                  </div>
                {:else}
                  <NocturneState
                    layout="compact"
                    tone="info"
                    icon="search"
                    eyebrow={section.title}
                    title={$_("ui_noMatchingPicksYet")}
                    body={`No new matches in this category after filtering your ${activeContentType === "novels" ? "saved novels and local books" : "library and tracker titles"}.`}
                  />
                {/if}
              </section>
            {/each}

          {/if}
          </main>

          <aside class="searchInsightPanel">
            <section class="searchInsightCard searchTasteCard">
              <div class="searchPanelTitle">
                <span>{$_("ui_tasteProfile")}</span>
                <span class="material-symbols-outlined" aria-hidden="true">info</span>
              </div>
              <p class="searchPanelLabel">{$_("ui_topGenres")}</p>
              <div class="searchTastePills">
                {#if searchTasteTags.length > 0}
                  {#each searchTasteTags as tag (tag)}
                    <span>{tag}</span>
                  {/each}
                {:else}
                  <span class="is-muted">{$_("ui_noLibraryGenresYet")}</span>
                {/if}
              </div>

              <div class="searchKnownToggle">
                <button
                  class="browseToggleRow searchPanelToggle"
                  class:is-active={searchIncludeLibrary}
                  type="button"
                  aria-pressed={searchIncludeLibrary}
                  onclick={() => (searchIncludeLibrary = !searchIncludeLibrary)}
                >
                  <span>{activeContentType === "novels" ? $_("ui_includeSavedProseTitles") : $_("ui_includeLibraryTrackerTitles")}</span>
                  <span class="browseSwitch" aria-hidden="true"></span>
                </button>
                <p>{searchIncludeLibrary ? $_("ui_knownTitlesCanAppearForComparison") : activeContentType === "novels" ? $_("ui_onlyNovelsOutsideYourSavedNovelsAndLocal") : $_("ui_onlyTitlesOutsideYourLocalAndTrackerLibraries")}</p>
              </div>

              <div class="searchDiversity">
                <div class="searchDiversityHeader">
                  <span>{$_("ui_diversity")}</span>
                </div>
                <div class="searchDiversityTrack">
                  <span style={`width:${searchDiversityValue}%`}></span>
                  <i style={`left:${searchDiversityValue}%`}></i>
                </div>
                <div class="searchDiversityLabels">
                  <span>{$_("ui_focused")}</span>
                  <span>{$_("ui_balanced")}</span>
                  <span>{$_("ui_diverse")}</span>
                </div>
              </div>

              <div class="searchDivergentNote">
                <span class="material-symbols-outlined" aria-hidden="true">diversity_2</span>
                <p>{$_("ui_includesAFewDivergentPicksToAvoidLoops")}</p>
              </div>

              <div class="searchInsights">
                <div class="searchPanelTitle">
                  <span>{$_("ui_insights")}</span>
                  <span class="material-symbols-outlined" aria-hidden="true">info</span>
                </div>
                {#each searchInsightLines as insight (insight)}
                  <p><span class="material-symbols-outlined" aria-hidden="true">adjust</span>{insight}</p>
                {/each}
              </div>

              <button class="searchInsightsButton" type="button" onclick={() => isInsightsOpen = true}>
                <span class="material-symbols-outlined" aria-hidden="true">bar_chart</span>
                {$_("ui_viewFullInsights")}
              </button>
            </section>
          </aside>
        </div>
      </section>
    {:else}
      <div class="results">
        {#if activeContentType === "novels" && kw_novelResults.length === 0}
          <div class="empty">
            <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint)" aria-hidden="true">
              <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
            </svg>
          </div>
        {:else if activeContentType === "manga" && kw_results.length === 0}
          <div class="empty">
            <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint)" aria-hidden="true">
              <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
            </svg>
          </div>
        {/if}

        {#if activeContentType === "novels"}
          {#each kw_novelResults.filter((r) => r.novels.length > 0 || r.loading || r.error) as { source, novels, loading, error } (source.pluginId)}
            <div class="sourceSection">
              <div class="sourceHeader">
                {#if source.iconUrl}
                  <img
                    src={resolveServiceIconUrl(source.iconUrl, { kind: source.contentKind === "novels" ? "extension" : "source" })}
                    onerror={(event) => applyServiceIconFallback(event, source.contentKind === "novels" ? "extension" : "source")}
                    alt={source.name}
                    class="sourceIcon"
                    loading="lazy"
                    decoding="async"
                  />
                {/if}
                <span class="sourceName">{source.name}</span>
                {#if hasMultipleLangs}
                  <span class="sourceLang">{source.lang.toUpperCase()}</span>
                {/if}
                {#if loading}
                  <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint);margin-left:auto" aria-hidden="true">
                    <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
                  </svg>
                {:else if novels.length > 0}
                  <span class="resultCount">{novels.length} {$_("ui_results")}</span>
                {/if}
              </div>

              {#if error}
                <NocturneState
                  layout="compact"
                  tone="warning"
                  icon="warning"
                  eyebrow="Source"
                  title={$_("ui_couldNotLoadThisNovelSource")}
                  body={error}
                />
              {:else if loading}
                <div class="sourceRow">
                  {#each Array(4) as _, i (i)}
                    <div class="skCard">
                      <div class="skeleton skCover"></div>
                      <div class="skeleton skTitle"></div>
                    </div>
                  {/each}
                </div>
              {:else if novels.length > 0}
                <div class="sourceRow">
                  {#each novels.slice(0, (store.settings.renderLimit ?? 48)) as result (`${result.sourceId}:${result.path}`)}
                    <button class="n-library-card" disabled={src_openingNovelPath !== null} onclick={() => openNovelSourceResult(source, result)}>
                      <div class="n-library-card__cover">
                        {#if result.coverUrl}
                          <img src={resolveMangaCoverUrl(result.coverUrl, { context: "browse", persistence: "memory" })} alt={result.title} loading="lazy" decoding="async" />
                        {:else}
                          <div class="coverFallback">{$_("ui_book")}</div>
                        {/if}
                        {#if novelLibraryState && isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path))}
                          <span class="n-library-card__badge">{$_("detail_status_inLibrary")}</span>
                        {/if}
                      </div>
                      <div class="n-library-card__info">
                        <p class="n-library-card__title">{result.title}</p>
                        <div class="n-library-card__meta">
                          <span class="n-library-card__author">{source.name}</span>
                          <span class="n-library-card__vol">{src_openingNovelPath === result.path ? $_("ui_opening") : source.lang.toUpperCase()}</span>
                        </div>
                      </div>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        {:else}
        {#each kw_results.filter((r) => r.mangas.length > 0 || r.loading || r.error) as { source, mangas, loading, error } (source.id)}
          <div class="sourceSection">
            <div class="sourceHeader">
              <img
                src={resolveServiceIconUrl(source.iconUrl, { kind: source.contentKind === "novels" ? "extension" : "source" })}
                onerror={(event) => applyServiceIconFallback(event, source.contentKind === "novels" ? "extension" : "source")}
                alt={source.displayName}
                class="sourceIcon"
                loading="lazy"
                decoding="async"
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
                <span class="resultCount">{mangas.length} {$_("ui_results")}</span>
              {/if}
            </div>

            {#if error}
              <NocturneState
                layout="compact"
                tone="warning"
                icon="warning"
                eyebrow="Source"
                title={$_("ui_couldNotLoadThisMangaSource")}
                body={error}
              />
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
                    <div class="card-cover-container">
                      <div class="n-library-card__cover">
                        <img
                          src={resolveMangaCoverUrl(m, { context: "browse", persistence: m.inLibrary ? "persistent" : "memory", cacheGeneration: store.libraryCoverCacheGeneration })}
                          alt={m.title}
                          loading="lazy"
                          decoding="async"
                        />
                      </div>
                      {#if m.inLibrary}
                        <div class="source-metric-banner" aria-label={$_("detail_status_inLibrary")}>
                          <div class="source-metric-pill">
                            <span class="source-metric-unread pill-only">{$_("detail_status_inLibrary")}</span>
                          </div>
                        </div>
                      {/if}
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
        {/if}

        {#if kw_allDone && (activeContentType === "novels" ? !kw_hasNovelResults : !kw_hasResults)}
          <NocturneState
            layout="center"
            tone="info"
            icon="search"
            eyebrow={$_("browse.search.keywordEyebrow")}
            title={$_("browse.source.noResultsFor", { query: kw_submitted })}
            body={$_("browse.search.noKeywordResultsBody")}
          />
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
            <h3 class="browseCardTitle">{$_("ui_filters")}</h3>
            <button class="browseResetButton" type="button" onclick={resetBrowseSidebarFilters}>
              {$_("ui_reset")}
              <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
            </button>
          </div>
          <div class="browseField">
            <p class="browseFieldLabel">{$_("downloads_summary_status")}</p>
            <div class="browseSegment">
              <button class:is-active={catalogFeed === "all"} onclick={() => selectCatalogFeed("all")}>{$_("downloads_filter_all")}</button>
              <button class:is-active={catalogFeed === "popular"} onclick={() => selectCatalogFeed("popular")}>{$_("ui_popular")}</button>
              <button class:is-active={catalogFeed === "latest"} onclick={() => selectCatalogFeed("latest")}>{$_("ui_latest")}</button>
            </div>
          </div>
          <div class="browseField browsePickerField browseLanguageField">
            <p class="browseFieldLabel">{$_("sources_table_language")}</p>
            <button class="browseSelectRow" class:is-open={catalogLanguagePickerOpen} type="button" onclick={() => { catalogLanguagePickerOpen = !catalogLanguagePickerOpen; catalogSourcePickerOpen = false; catalogTrackingPickerOpen = false; }}>
              <span>{src_selectedLang === "all" ? $_("ui_allLanguages") : src_selectedLang.toUpperCase()}</span>
              <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
            </button>
            {#if catalogLanguagePickerOpen}
              <div class="browseInlinePicker browseLanguagePicker n-popover-surface n-popover-menu">
                {#if src_selectedLang !== "all"}
                  <button class="n-popover-item" onclick={() => { src_selectedLang = "all"; catalogLanguagePickerOpen = false; }}>{$_("ui_allLanguages")}</button>
                {/if}
                {#each src_availableLangs.filter((lang) => lang !== src_selectedLang) as lang (lang)}
                  <button class="n-popover-item" onclick={() => { src_selectedLang = lang; catalogLanguagePickerOpen = false; }}>{lang.toUpperCase()}</button>
                {/each}
              </div>
            {/if}
          </div>
          <div class="browseField browsePickerField browseSourceField">
            <p class="browseFieldLabel">{$_("detail_fields_source")}</p>
            <button class="browseSelectRow" class:is-open={catalogSourcePickerOpen} class:is-paused={!!discoverFocusedTracker} type="button" onclick={() => { if (discoverFocusedTracker) return; catalogSourcePickerOpen = !catalogSourcePickerOpen; catalogLanguagePickerOpen = false; catalogTrackingPickerOpen = false; }}>
              <span>{discoverFocusedTracker ? $_("ui_usingTrackingCatalog") : discoverFocusedSource ? sourceNameWithoutLanguage(discoverFocusedSource) : $_("ui_allSources")}</span>
              <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
            </button>
            {#if catalogSourcePickerOpen}
              <div class="browseInlinePicker browseSourcePicker n-popover-surface n-popover-menu">
                {#if discoverSelectedSource}
                  <button class="n-popover-item" onclick={() => { discoverSelectedSource = ""; catalogSourcePickerOpen = false; }}>
                    <span>{$_("ui_allSources")}</span>
                    <span>{$_("ui_all")}</span>
                  </button>
                {/if}
                {#each src_visibleSources.filter((src) => src.id !== discoverSelectedSource) as src (src.id)}
                  <button class="n-popover-item" onclick={() => selectDiscoverSourceFilter(src)}>
                    <span>{sourceNameWithoutLanguage(src)}</span>
                    <span>{src.lang.toUpperCase()}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
          <div class="browseField browsePickerField browseTrackingField">
            <p class="browseFieldLabel">{$_("home_sections_tracking")}</p>
            <button class="browseSelectRow" class:is-open={catalogTrackingPickerOpen} type="button" onclick={() => { catalogTrackingPickerOpen = !catalogTrackingPickerOpen; catalogLanguagePickerOpen = false; catalogSourcePickerOpen = false; }}>
              <span>{discoverFocusedTracker?.name ?? "Off"}</span>
              <span class="material-symbols-outlined" aria-hidden="true">expand_more</span>
            </button>
            <p class="browseFieldHint">{discoverFocusedTracker ? $_("ui_browsingThisTrackerCatalogInsteadOfExtensionSources") : $_("ui_turnOnATrackerCatalogWhenYouWant")}</p>
            {#if catalogTrackingPickerOpen}
              <div class="browseInlinePicker browseTrackingPicker n-popover-surface n-popover-menu">
                {#if discoverSelectedTracker !== null}
                  <button class="n-popover-item" onclick={() => { discoverSelectedTracker = null; catalogTrackingPickerOpen = false; }}>
                    <span>{$_("ui_trackingOff")}</span>
                    <span>{$_("ui_off")}</span>
                  </button>
                {/if}
                {#if loadingTrackers}
                  <button class="n-popover-item" disabled>
                    <span>{$_("ui_loadingTracking")}</span>
                    <span></span>
                  </button>
                {:else if trackingFilterOptions.length === 0}
                  <button class="n-popover-item" disabled>
                    <span>{$_("ui_noTrackingReady")}</span>
                    <span></span>
                  </button>
                {:else}
                  {#each trackingFilterOptions.filter((tracker) => tracker.id !== discoverSelectedTracker) as tracker (tracker.id)}
                    <button class="n-popover-item" onclick={() => selectDiscoverTrackerFilter(tracker)}>
                      <span>{tracker.name}</span>
                      <span>{$_("ui_on")}</span>
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
            <span>{$_("ui_includeNsfwExtensions")}</span>
            <span class="browseSwitch" aria-hidden="true"></span>
          </button>
          <button
            class="browseToggleRow"
            class:is-active={includeInLibrary}
            type="button"
            aria-pressed={includeInLibrary}
            onclick={() => (includeInLibrary = !includeInLibrary)}
          >
            <span>{$_("ui_includeInLibrary")}</span>
            <span class="browseSwitch" aria-hidden="true"></span>
          </button>
        </section>

        <section class="browseFilterSection browseGenresSection">
          <div class="browseSectionHeader">
            <h3 class="browseCardTitle">{$_("ui_genres")}</h3>
          </div>
          <div class="browseSectionBody">
            <div class="splitSearchWrap catalogSearchWrap">
          <svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor" class="splitSearchIcon" aria-hidden="true">
            <path d="M229.66,218.34l-50.07-50.07a88,88,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.31ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"/>
          </svg>
          <input
            bind:value={tag_tagFilter}
            class="splitSearchInput"
            placeholder={$_("ui_filterGenres")}
          />
          {#if tag_tagFilter}
            <button class="splitSearchClear" title={$_("ui_clear")} onclick={() => (tag_tagFilter = "")}>x</button>
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
              {#if tag_activeTags.includes(tag)}<span class="tagCheckMark material-symbols-outlined" aria-hidden="true">check</span>{/if}
            </button>
          {/each}
          {#if tag_filteredGenres.length === 0}
            <p class="splitEmpty">{$_("ui_noMatchingGenres")}</p>
          {/if}
            </div>
          </div>
        </section>

      </div>

      
      <div class="splitContent">
        {#if src_activeSource || src_activeNovelSource}
          <div class="splitContentHeader">
            <div class="splitSourceTitle">
              {#if src_activeSource}
                <img
                  src={resolveServiceIconUrl(src_activeSource.iconUrl, { kind: "source" })}
                  onerror={(event) => applyServiceIconFallback(event, "source")}
                  alt=""
                  class="splitSourceIcon"
                  loading="lazy"
                  decoding="async"
                />
                <span class="splitContentTitle">{src_activeSource.displayName}</span>
                {#if src_activeSource.isNsfw}<span class="nsfwBadge">18+</span>{/if}
              {:else if src_activeNovelSource}
                {#if src_activeNovelSource.iconUrl}
                  <img
                    src={resolveServiceIconUrl(src_activeNovelSource.iconUrl, { kind: "extension" })}
                    onerror={(event) => applyServiceIconFallback(event, "extension")}
                    alt=""
                    class="splitSourceIcon"
                    loading="lazy"
                    decoding="async"
                  />
                {/if}
                <span class="splitContentTitle">{src_activeNovelSource.name}</span>
              {/if}
              {#if src_loadingBrowse}
                <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" class="anim-spin" style="color:var(--text-faint)" aria-hidden="true">
                  <path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/>
                </svg>
              {:else if src_activeSource && src_browseResults.length > 0}
                <span class="splitResultCount">{src_browseResults.length} {$_("ui_results")}</span>
              {:else if src_activeNovelSource && src_novelBrowseResults.length > 0}
                <span class="splitResultCount">{src_novelBrowseResults.length} {$_("ui_results")}</span>
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
                placeholder={sourceSearchPlaceholder()}
                onkeydown={(e) => e.key === "Enter" && srcHandleSearch()}
              />
              {#if src_submitted}
                <button class="clearBtn" title={$_("ui_clearSearch")} onclick={srcClearSearch}>x</button>
              {/if}
            </div>
            <button
              class="searchBtn"
              onclick={srcHandleSearch}
              disabled={!src_browseQuery.trim() || src_loadingBrowse}
            >
              {$_("novelSources_actions_search")}
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
                  <div class="card-cover-container">
                    <div class="n-library-card__cover">
                      <img src={resolveMangaCoverUrl(m, { context: "browse", persistence: m.inLibrary ? "persistent" : "memory", cacheGeneration: store.libraryCoverCacheGeneration })} alt={m.title} loading="lazy" decoding="async" />
                    </div>
                    {#if m.inLibrary}
                      <div class="source-metric-banner" aria-label={$_("detail_status_inLibrary")}>
                        <div class="source-metric-pill">
                          <span class="source-metric-unread pill-only">{$_("detail_status_inLibrary")}</span>
                        </div>
                      </div>
                    {/if}
                  </div>
                  <div class="n-library-card__info">
                    <p class="n-library-card__title">{m.title}</p>
                    <div class="n-library-card__meta">
                      <span class="n-library-card__author">{m.source?.displayName ?? src_activeSource?.displayName ?? $_("ui_source")}</span>
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
                  {#if src_loadingBrowse}{$_("ui_loading")}{:else}{$_("ui_loadMore")}{/if}
                </button>
              </div>
            {/if}
          {:else if src_activeNovelSource && src_novelBrowseResults.length > 0}
            <div class="tagGrid" onscroll={handleCatalogGridScroll}>
              {#each src_novelBrowseResults as result (result.path)}
                <button class="n-library-card" disabled={src_openingNovelPath !== null} onclick={() => srcOpenNovelDetail(result)}>
                  <div class="n-library-card__cover">
                    {#if result.coverUrl}
                      <img src={resolveMangaCoverUrl(result.coverUrl, { context: "browse", persistence: "memory" })} alt={result.title} loading="lazy" decoding="async" />
                    {:else}
                      <div class="coverFallback">{$_("ui_book")}</div>
                    {/if}
                    {#if novelLibraryState && isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path))}
                      <span class="n-library-card__badge">{$_("detail_status_inLibrary")}</span>
                    {/if}
                  </div>
                  <div class="n-library-card__info">
                    <p class="n-library-card__title">{result.title}</p>
                    <div class="n-library-card__meta">
                      <span class="n-library-card__author">{src_activeNovelSource.name}</span>
                      <span class="n-library-card__vol">{src_openingNovelPath === result.path ? $_("ui_opening") : src_activeNovelSource.lang.toUpperCase()}</span>
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
                  {#if src_loadingBrowse}{$_("ui_loading")}{:else}{$_("ui_loadMore")}{/if}
                </button>
              </div>
            {/if}
          {:else if src_browseError}
            <NocturneState
              layout="center"
              tone="warning"
              icon="warning"
              eyebrow={$_("ui_source")}
              title={$_("ui_couldNotLoadThisSource")}
              body={src_browseError}
            />
          {:else if !src_loadingBrowse}
            <NocturneState
              layout="center"
              tone="info"
              icon="search"
              eyebrow={$_("browse.source.searchEyebrow")}
              title={src_submitted ? $_("browse.source.noResultsFor", { query: src_submitted }) : $_("ui_noResults")}
              body={$_("browse.source.noResultsBody")}
            />
          {/if}
        {:else}
          <section class="discoverPanel">
            <div class="splitContentHeader discoverPanelHeader">
              <div class="catalogHeaderCopy">
                <span class="n-eyebrow">{$_("ui_discoverNewSeries")}</span>
                <p class="catalogSubtitle">
                  {#if tag_hasActiveTags}
                    {catalogActiveSummary} {$_("ui_genresManga")}{#if tag_searchSources}{$_("ui_sourcesEnabled")}{/if}
                  {:else if discoverFocusedTracker}
                    {discoverFocusedTracker.name} - {catalogFeedLabel(catalogFeed)} {$_("ui_mangaCatalog")}{:else}
                  {discoverSourceLabel} - {catalogFeedLabel(catalogFeed)} - {activeContentTypeLabel()}
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
                    {tag_totalVisible}{tag_localHasNext || tag_sourceHasMore ? "+" : ""} {$_("ui_titles")}{:else if discoverFocusedTracker}
                    {discoverResultCount} {$_("ui_titles")}{:else}
                    {discoverResultCount}{discoverHasNextPage ? "+" : ""} {$_("ui_titles")}{/if}
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
                    <div class="card-cover-container">
                      <div class="n-library-card__cover">
                        <img src={resolveMangaCoverUrl(m, { context: "browse", persistence: m.inLibrary ? "persistent" : "memory", cacheGeneration: store.libraryCoverCacheGeneration })} alt={m.title} loading="lazy" decoding="async" />
                      </div>
                      {#if m.inLibrary}
                        <div class="source-metric-banner" aria-label={$_("detail_status_inLibrary")}>
                          <div class="source-metric-pill">
                            <span class="source-metric-unread pill-only">{$_("detail_status_inLibrary")}</span>
                          </div>
                        </div>
                      {/if}
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
                    <span class="inlineLoading">{$_("ui_loadingMore")}</span>
                  </div>
                {/if}
              </div>
            {:else if tag_hasActiveTags}
              <NocturneState
                layout="center"
                tone="info"
                icon="search"
                eyebrow={$_("browse.tabs.discover")}
                title={$_("ui_nothingFoundForThisView")}
                body={$_("browse.discover.noGenreResultsBody")}
              />
            {:else if discoverFocusedTracker && trackerCatalogResults.length > 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each trackerCatalogResults as item (`${item.trackerId}:${item.remoteId}`)}
                  <a class="n-library-card" href={item.trackingUrl ?? undefined} target="_blank" rel="noreferrer">
                    <div class="n-library-card__cover">
                      {#if item.coverUrl}
                        <img src={resolveMangaCoverUrl(item.coverUrl, { context: "browse", persistence: "memory" })} alt={item.title} loading="lazy" decoding="async" />
                      {:else}
                        <div class="coverFallback">{$_("ui_manga")}</div>
                      {/if}
                    </div>
                    <div class="n-library-card__info">
                      <p class="n-library-card__title">{item.title}</p>
                      <div class="n-library-card__meta">
                        <span class="n-library-card__author">{discoverFocusedTracker.name}</span>
                        <span class="n-library-card__vol">{item.publishingStatus ?? item.publishingType ?? (item.totalChapters ? `${item.totalChapters} CH` : $_("ui_reading"))}</span>
                      </div>
                    </div>
                  </a>
                {/each}
                {#if trackerCatalogLoadingMore}
                  <div class="showMoreCell">
                    <span class="inlineLoading">{$_("ui_loadingMore")}</span>
                  </div>
                {/if}
              </div>
            {:else if discoverFocusedTracker && trackerCatalogError}
              <NocturneState
                layout="center"
                tone="danger"
                icon="warning"
                eyebrow={$_("browse.discover.trackerCatalog")}
                title={$_("ui_couldNotLoadTrackerCatalog")}
                body={trackerCatalogError}
              />
            {:else if discoverFocusedTracker}
              <NocturneState
                layout="center"
                tone="info"
                icon="books"
                eyebrow={$_("browse.discover.trackerCatalog")}
                title={$_("ui_noReadingTitlesFound")}
                body={$_("browse.discover.noTrackerResultsBody")}
              />
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
              <NocturneState
                layout="center"
                tone="danger"
                icon="warning"
                eyebrow={$_("browse.tabs.discover")}
                title={$_("ui_couldNotLoadDiscover")}
                body={discoverError}
              />
            {:else if activeContentType === "novels" && discoverNovelResults.length > 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each discoverNovelResults as result (`${result.sourceId}:${result.path}`)}
                  <button class="n-library-card" disabled={src_openingNovelPath !== null} onclick={() => srcOpenNovelDetail(result)}>
                    <div class="card-cover-container">
                      <div class="n-library-card__cover">
                        {#if result.coverUrl}
                          <img src={resolveMangaCoverUrl(result.coverUrl, { context: "browse", persistence: "memory" })} alt={result.title} loading="lazy" decoding="async" />
                        {:else}
                          <div class="coverFallback">{$_("ui_book")}</div>
                        {/if}
                      </div>
                      {#if novelLibraryState && isNovelInLibrary(novelLibraryState, createNovelLibraryId(result.sourceId, result.path))}
                        <div class="source-metric-banner" aria-label={$_("detail_status_inLibrary")}>
                          <div class="source-metric-pill">
                            <span class="source-metric-unread pill-only">{$_("detail_status_inLibrary")}</span>
                          </div>
                        </div>
                      {/if}
                    </div>
                    <div class="n-library-card__info">
                      <p class="n-library-card__title">{result.title}</p>
                      <div class="n-library-card__meta">
                        <span class="n-library-card__author">{discoverFocusedSource?.name ?? $_("browse.tabs.discover")}</span>
                        <span class="n-library-card__vol">{src_openingNovelPath === result.path ? $_("ui_opening") : $_("ui_novel")}</span>
                      </div>
                    </div>
                  </button>
                {/each}
                {#if discoverLoadingMore}
                  <div class="showMoreCell">
                    <span class="inlineLoading">{$_("ui_loadingMore")}</span>
                  </div>
                {/if}
              </div>
            {:else if activeContentType === "manga" && discoverMangaResults.length > 0}
              <div class="tagGrid" onscroll={handleCatalogGridScroll}>
                {#each discoverMangaResults.filter(shouldShowCatalogManga) as m (m.id)}
                  <button class="n-library-card" onclick={() => setPreviewManga(m)}>
                    <div class="card-cover-container">
                      <div class="n-library-card__cover">
                        <img src={resolveMangaCoverUrl(m, { context: "browse", persistence: m.inLibrary ? "persistent" : "memory", cacheGeneration: store.libraryCoverCacheGeneration })} alt={m.title} loading="lazy" decoding="async" />
                      </div>
                      {#if m.inLibrary}
                        <div class="source-metric-banner" aria-label={$_("detail_status_inLibrary")}>
                          <div class="source-metric-pill">
                            <span class="source-metric-unread pill-only">{$_("detail_status_inLibrary")}</span>
                          </div>
                        </div>
                      {/if}
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
                    <span class="inlineLoading">{$_("ui_loadingMore")}</span>
                  </div>
                {/if}
              </div>
            {:else}
              <NocturneState
                layout="center"
                tone="info"
                icon="search"
                eyebrow={$_("browse.tabs.discover")}
                title={$_("ui_nothingFoundForThisView")}
                body={$_("browse.discover.noResultsBody")}
              />
            {/if}
          </section>
        {/if}
      </div>
    </div>
    </div>
    </div>

  {:else if activeBrowseTab === "source"}
    <div class="browseShell">
      <SourcesView contentType={activeContentType} topbarSearch={searchQuery} />
    </div>
  {/if}

  {#if isInsightsOpen && libraryOnlyProfile}
    <TasteInsightsModal
      profile={libraryOnlyProfile}
      items={searchRecommendationItems}
      contentType={activeContentType}
      onClose={() => isInsightsOpen = false}
    />
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
      minmax(0, min(calc(640px * var(--n-hud-scale)), 44vw))
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
    padding: 12px clamp(28px, 3vw, 56px) 0;
    flex-shrink: 0;
  }
  .setup-banner :global(.n-state) {
    max-width: 1120px;
    margin: 0 auto;
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
  .searchBar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 40px;
    background: rgba(23, 22, 30, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.065);
    border-radius: 10px;
    padding: 0 12px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
    transition: border-color var(--t-base), background var(--t-base), box-shadow var(--t-base);
  }
  .searchBar:focus-within {
    border-color: rgba(184, 167, 234, 0.36);
    background: rgba(29, 27, 38, 0.92);
    box-shadow: 0 0 0 3px rgba(184, 167, 234, 0.08);
  }
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
  .searchBtn {
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 820;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    min-height: 40px;
    padding: 0 18px;
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(207, 187, 255, 0.96), rgba(152, 126, 219, 0.9));
    color: rgba(35, 25, 60, 0.96);
    border: 1px solid rgba(229, 219, 255, 0.2);
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-1);
    box-shadow: 0 10px 24px rgba(150, 121, 228, 0.18);
    transition: transform var(--t-base), filter var(--t-base), opacity var(--t-base);
  }
  .searchBtn:hover:not(:disabled) {
    filter: brightness(1.06);
    transform: translateY(-1px);
  }
  .searchBtn:disabled {
    opacity: 0.38;
    cursor: default;
    filter: grayscale(0.35);
    box-shadow: none;
  }
  .searchLanding {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: clamp(24px, 2.9vw, 52px) clamp(22px, 2.7vw, 46px) 48px;
    background:
      radial-gradient(circle at 18% 22%, rgba(184, 167, 234, 0.1), transparent 34%),
      radial-gradient(circle at 72% 18%, rgba(100, 145, 255, 0.06), transparent 30%);
    scrollbar-width: thin;
    scrollbar-color: rgba(184, 167, 234, 0.32) transparent;
  }
  .searchCanvas {
    --search-card-width: clamp(124px, 13.2vw, 180px);
    --search-card-gap: clamp(15px, 0.95vw, 17px);
    --search-rail-width: calc((var(--search-card-width) * 7) + (var(--search-card-gap) * 6));
    --search-panel-width: clamp(286px, 18vw, 328px);
    display: grid;
    grid-template-columns: minmax(0, var(--search-rail-width)) minmax(var(--search-panel-width), 1fr);
    gap: clamp(14px, 1.2vw, 22px);
    align-items: start;
    justify-content: start;
  }
  .searchMainColumn {
    min-width: 0;
    width: 100%;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: clamp(22px, 2vw, 30px);
  }
  .searchHeroCopy {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    max-width: 680px;
    margin-bottom: 2px;
  }
  .searchHeroCopy h2,
  .searchRecommendationHeader h3 {
    margin: 0;
    color: rgba(238, 235, 242, 0.92);
    font-weight: 760;
    letter-spacing: 0;
  }
  .searchHeroCopy h2 {
    font-size: 26px;
    line-height: 1.08;
  }
  .searchHeroCopy p,
  .searchRecommendationHeader p {
    margin: 0;
    color: rgba(229, 226, 225, 0.52);
    line-height: 1.45;
  }
  .searchHeroCopy p {
    font-size: 13px;
    max-width: 660px;
  }
  .searchRecommendationSection {
    min-width: 0;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .searchRecommendationHeader {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
    width: min(100%, var(--search-rail-width));
    min-width: 0;
  }
  .searchRecommendationHeader > div {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    column-gap: 8px;
    align-items: center;
  }
  .searchRecommendationHeader h3 {
    font-size: 16px;
    line-height: 1.1;
  }
  .searchRecommendationHeader p {
    grid-column: 2;
    margin-top: 3px;
    font-size: 12px;
  }
  .searchRailControls {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    align-self: center;
    flex-shrink: 0;
  }
  .searchRailControls button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: rgba(218, 207, 255, 0.68);
    cursor: pointer;
    transition: background var(--t-base), color var(--t-base), transform var(--t-base);
  }
  .searchRailControls button:hover {
    color: rgba(238, 235, 242, 0.94);
    background: rgba(184, 167, 234, 0.08);
    transform: translateY(-1px);
  }
  .searchRailControls button:active {
    transform: translateY(0);
  }
  .searchRailControls .material-symbols-outlined {
    font-size: 20px;
  }
  .searchSectionIcon {
    color: rgba(188, 166, 255, 0.96);
    font-size: 18px;
  }
  .searchTastePills span {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    padding: 0 8px;
    border: 1px solid rgba(184, 167, 234, 0.2);
    border-radius: 999px;
    background: rgba(184, 167, 234, 0.1);
    color: rgba(218, 207, 255, 0.88);
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 780;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .searchRecommendationRow {
    display: flex;
    gap: var(--search-card-gap);
    width: min(100%, var(--search-rail-width));
    max-width: 100%;
    box-sizing: border-box;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x proximity;
    scroll-padding-inline: 8px clamp(28px, 2vw, 44px);
    padding: 12px clamp(26px, 1.7vw, 36px) 12px 8px;
    scrollbar-width: thin;
    scrollbar-color: rgba(184, 167, 234, 0.24) transparent;
  }
  .searchRecommendationRow::-webkit-scrollbar {
    height: 7px;
  }
  .searchRecommendationRow::-webkit-scrollbar-track {
    background: transparent;
  }
  .searchRecommendationRow::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: rgba(184, 167, 234, 0.2);
  }
  .searchRecommendationRow .n-library-card {
    flex: 0 0 clamp(118px, 22cqw, 180px);
    width: clamp(118px, 22cqw, 180px);
    height: calc((clamp(118px, 22cqw, 180px) / 0.7) + 74px);
    min-width: 0;
    scroll-snap-align: start;
  }
  .searchRecommendationRow .n-library-card__cover {
    flex: 0 0 auto;
    aspect-ratio: 0.7;
  }
  .searchRecommendationRow .n-library-card__info {
    flex: 0 0 58px;
    overflow: hidden;
  }
  .searchRecommendationRow .n-library-card__title {
    min-height: 32px;
    max-height: 36px;
    line-height: 1.16;
    overflow-wrap: anywhere;
  }
  .searchRecommendationRow .n-library-card__meta {
    min-width: 0;
  }
  .searchRecommendationRow .n-library-card__author,
  .searchRecommendationRow .n-library-card__vol {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .searchCoverPlaceholder {
    display: flex;
    align-items: flex-end;
    width: 100%;
    height: 100%;
    padding: 18px 14px;
    box-sizing: border-box;
    border-radius: inherit;
    background:
      radial-gradient(circle at 28% 18%, rgba(184, 167, 234, 0.2), transparent 32%),
      linear-gradient(180deg, rgba(36, 33, 45, 0.92), rgba(21, 20, 27, 0.96));
    position: relative;
    overflow: hidden;
  }
  .searchCoverPlaceholder::after {
    content: "";
    position: absolute;
    left: 13%;
    right: 18%;
    bottom: 16%;
    height: 8px;
    border-radius: 999px;
    background: rgba(184, 167, 234, 0.14);
    box-shadow:
      0 -18px 0 rgba(255, 255, 255, 0.045),
      34px -36px 0 rgba(255, 255, 255, 0.035);
  }
  .searchCoverPlaceholder span {
    position: relative;
    z-index: 1;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: rgba(238, 235, 242, 0.9);
    font-size: 13px;
    font-weight: 780;
    line-height: 1.15;
    text-align: left;
  }
  .searchInsightPanel {
    position: sticky;
    top: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    justify-self: center;
    width: var(--search-panel-width);
    min-width: 0;
  }
  .searchInsightCard {
    min-width: 0;
    box-sizing: border-box;
    padding: 22px 22px 20px;
    border: 1px solid rgba(255, 255, 255, 0.055);
    border-radius: 12px;
    background:
      linear-gradient(180deg, rgba(27, 25, 36, 0.9), rgba(16, 16, 22, 0.92));
    box-shadow:
      0 16px 42px rgba(0, 0, 0, 0.24),
      inset 0 1px 0 rgba(255, 255, 255, 0.025);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  .searchPanelTitle,
  .searchDiversityHeader,
  .searchDiversityLabels {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-family: var(--font-sans);
  }
  .searchPanelTitle {
    color: rgba(207, 199, 226, 0.68);
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .searchPanelTitle .material-symbols-outlined {
    font-size: 14px;
    color: rgba(207, 199, 226, 0.42);
  }
  .searchPanelLabel {
    margin: 24px 0 0;
    color: rgba(229, 226, 225, 0.6);
    font-size: 13px;
    font-weight: 680;
  }
  .searchTastePills {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 7px 12px;
    margin-top: 12px;
    padding-bottom: 4px;
  }
  .searchTastePills span {
    min-width: 0;
    max-width: 100%;
    min-height: auto;
    padding: 0 0 0 10px;
    border: 0;
    border-left: 2px solid rgba(184, 167, 234, 0.42);
    border-radius: 0;
    background: transparent;
    color: rgba(218, 207, 255, 0.74);
    font-family: var(--font-sans);
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .searchKnownToggle {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-top: 24px;
    padding-top: 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.045);
  }
  .searchPanelToggle {
    min-height: 26px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    font-family: var(--font-sans);
  }
  .searchPanelToggle span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .searchKnownToggle p {
    margin: 0;
    color: rgba(229, 226, 225, 0.42);
    font-family: var(--font-sans);
    font-size: 12.5px;
    line-height: 1.4;
  }
  .searchDiversity,
  .searchInsights {
    display: flex;
    flex-direction: column;
    gap: 11px;
    margin-top: 28px;
    padding-top: 20px;
    border-top: 1px solid rgba(255, 255, 255, 0.045);
  }
  .searchDiversityHeader span {
    color: rgba(229, 226, 225, 0.62);
    font-size: 13px;
    font-weight: 700;
  }
  .searchDiversityTrack {
    position: relative;
    height: 3px;
    border-radius: 0;
    background: rgba(255, 255, 255, 0.09);
  }
  .searchDiversityTrack span {
    display: block;
    height: 100%;
    border-radius: 0;
    background: rgba(184, 167, 234, 0.82);
  }
  .searchDiversityTrack i {
    position: absolute;
    top: 50%;
    width: 10px;
    height: 10px;
    border: 2px solid rgba(24, 22, 31, 0.95);
    border-radius: 50%;
    background: rgba(218, 207, 255, 0.95);
    transform: translate(-50%, -50%);
  }
  .searchDiversityLabels {
    color: rgba(229, 226, 225, 0.32);
    font-family: var(--font-sans);
    font-size: 11px;
  }
  .searchDivergentNote {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 9px;
    margin-top: 22px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .searchDivergentNote .material-symbols-outlined {
    color: rgba(188, 166, 255, 0.68);
    font-size: 16px;
  }
  .searchDivergentNote p,
  .searchInsights p {
    margin: 0;
    color: rgba(229, 226, 225, 0.48);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.45;
  }
  .searchInsights p {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
  }
  .searchInsights p:first-of-type {
    border-top: 0;
    padding-top: 0;
  }
  .searchInsights p .material-symbols-outlined {
    color: rgba(188, 166, 255, 0.68);
    font-size: 12px;
    margin-top: 1px;
  }
  .searchInsightsButton {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid rgba(184, 167, 234, 0.14);
    background: transparent;
    color: rgba(211, 192, 255, 0.78);
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 720;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background var(--t-base), border-color var(--t-base), color var(--t-base);
  }
  .searchInsightsButton {
    width: 100%;
    min-height: 36px;
    margin-top: 18px;
    border-radius: 7px;
  }
  .searchInsightsButton:hover {
    color: rgba(238, 235, 242, 0.92);
    border-color: rgba(184, 167, 234, 0.2);
    background: rgba(184, 167, 234, 0.06);
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
  }
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
  .splitEmpty {
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    color: var(--text-faint);
    padding: var(--sp-3);
    margin: 0;
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
    font-size: 14px;
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
    min-height: 34px;
    padding: 0 14px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(255, 255, 255, 0.026);
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 780;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(211, 192, 255, 0.88);
    cursor: pointer;
    transition: background var(--t-base), color var(--t-base), border-color var(--t-base);
  }
  .showMoreBtn:hover:not(:disabled) {
    background: rgba(184, 167, 234, 0.075);
    color: rgba(238, 235, 242, 0.9);
    border-color: rgba(184, 167, 234, 0.24);
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
    gap: 10px;
    padding: 12px clamp(14px, 1.2vw, 20px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.045);
    background: rgba(8, 8, 12, 0.18);
    flex-shrink: 0;
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
  .catalogRoot {
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
  .catalogSidebar {
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
    max-height: min(204px, 38vh);
    overflow-y: auto;
  }
  .searchTastePills span.is-muted {
    grid-column: 1 / -1;
    color: rgba(229, 226, 225, 0.48);
    font-weight: 620;
    text-transform: none;
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
  .sourceBrowseBar .searchBar {
    min-height: calc(40px * var(--n-hud-scale));
    border-color: rgba(255, 255, 255, 0.055);
    background: rgba(27, 25, 34, 0.7);
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
    .searchLanding {
      padding: 18px clamp(14px, 3vw, 22px) 36px;
    }
    .searchCanvas {
      --search-card-width: clamp(118px, 21vw, 148px);
      --search-rail-width: 100%;
      --search-panel-width: clamp(168px, 28vw, 220px);
      grid-template-columns: minmax(0, 1fr) minmax(var(--search-panel-width), var(--search-panel-width));
      justify-content: start;
    }
    .searchMainColumn,
    .searchRecommendationSection,
    .searchRecommendationHeader,
    .searchRecommendationRow {
      width: 100%;
      max-width: 100%;
    }
    .searchRecommendationHeader {
      align-items: flex-start;
    }
    .searchInsightPanel {
      position: sticky;
      display: flex;
      justify-self: center;
      width: var(--search-panel-width);
    }
    .searchInsightCard {
      display: block;
      padding: 18px;
    }
    .searchPanelTitle {
      grid-column: auto;
    }
    .searchPanelLabel {
      margin-top: 18px;
    }
    .searchTastePills {
      grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
      gap: 8px 10px;
    }
    .searchKnownToggle {
      grid-column: auto;
      grid-row: auto;
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.045);
    }
    .searchDiversity {
      grid-column: 1 / -1;
      margin-top: 0;
      padding-top: 14px;
    }
    .searchDivergentNote,
    .searchInsights,
    .searchInsightsButton {
      display: none;
    }
    .catalogRoot {
      flex-direction: row !important;
    }
    .catalogSidebar {
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

  @media (max-width: 1740px) {
    .searchCanvas {
      --search-card-width: clamp(142px, 13.5vw, 172px);
      --search-rail-width: calc((var(--search-card-width) * 6) + (var(--search-card-gap) * 5));
    }
  }

  @media (max-width: 1500px) {
    .searchCanvas {
      --search-card-width: clamp(142px, 13.5vw, 172px);
      --search-rail-width: calc((var(--search-card-width) * 5) + (var(--search-card-gap) * 4));
    }
  }

  @media (max-width: 1220px) {
    .searchCanvas {
      --search-card-width: clamp(138px, 18vw, 166px);
      --search-rail-width: calc((var(--search-card-width) * 4) + (var(--search-card-gap) * 3));
    }
  }

  @media (max-width: 900px) {
    .searchCanvas {
      --search-card-width: clamp(118px, 21vw, 148px);
      --search-rail-width: 100%;
    }
  }

  @media (max-width: 520px) {
    .searchCanvas {
      --search-card-width: 132px;
      --search-panel-width: 100%;
      --search-rail-width: 100%;
      grid-template-columns: 1fr;
      justify-content: stretch;
    }
    .searchInsightPanel {
      position: static;
      display: grid;
      grid-template-columns: 1fr;
      justify-self: stretch;
      width: 100%;
    }
  }

  @media (max-width: 700px) {
    .root :global(.browse-topbar) {
      grid-template-columns: minmax(0, auto) minmax(0, 1fr) minmax(0, auto);
      gap: 8px;
    }
    .root :global(.browse-topbar .n-segmented) {
      max-width: 190px;
    }
    .root :global(.browse-topbar .n-search) {
      min-width: 0;
      max-width: 100%;
    }
    .browseSubtabs {
      gap: 18px;
      padding-inline: 14px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .browseSubtabs::-webkit-scrollbar {
      display: none;
    }
    .searchLanding {
      padding-inline: 14px;
    }
    .searchCanvas {
      --search-card-width: clamp(128px, 39vw, 148px);
    }
    .searchRecommendationHeader {
      gap: 8px;
    }
    .searchRailControls button {
      width: 26px;
      height: 26px;
    }
    .searchInsightCard {
      grid-template-columns: 1fr;
      row-gap: 12px;
      padding: 16px;
    }
    .searchKnownToggle,
    .searchDiversity {
      grid-column: auto;
      grid-row: auto;
    }
    .searchKnownToggle {
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.045);
    }
    .searchHeroCopy h2 {
      font-size: 24px;
    }
    .catalogSidebar {
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

  @media (max-width: 560px) {
    .root :global(.browse-topbar) {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .browse-topbar__center {
      display: none;
    }
    .searchCanvas {
      --search-card-width: min(132px, 42vw);
    }
    .searchHeroCopy h2 {
      font-size: 22px;
    }
    .searchRecommendationHeader {
      flex-direction: column;
      align-items: stretch;
    }
    .searchRailControls {
      align-self: flex-start;
    }
    .searchTastePills {
      grid-template-columns: 1fr;
    }
  }
</style>

<script module lang="ts">
  function focusOnMount(node: HTMLElement) { node.focus(); }
</script>
