import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

const {
  gqlMock,
  gqlUploadMock,
  addToastMock,
  browseInstalledNovelSourceMock,
  detectSetupStateMock,
  ensureServerAwakeForMock,
  loadTrustedInstalledNovelSourcesMock,
  resetMangaExtensionsMock,
  failMangaUpdateIdsMock,
  sourceMangaFailureMock,
  sourceMangaSearchMock,
  mangaSourcesMock,
  resetMangaSourcesMock,
  readInstalledNovelDetailsMock,
  searchInstalledNovelSourceMock,
  setActiveNovelDetailMock,
  managedRuntimeListExtensionsMock,
  managedRuntimeRefreshExtensionsMock,
  managedRuntimeInstallExtensionMock,
  managedRuntimeUpdateExtensionMock,
  managedRuntimeUninstallExtensionMock,
  managedRuntimeListStoresMock,
  managedRuntimeAddStoreMock,
  managedRuntimeRemoveStoreMock,
  managedRuntimeSearchSourceMangaMock,
  runTransactionalExtensionUpdatesMock,
} = vi.hoisted(() => {
  const mangaSourcesMock = [{
    id: "manga-src",
    name: "manga-src",
    displayName: "Manga Source",
    lang: "en",
    iconUrl: null,
    isNsfw: false,
  }];
  const resetMangaSourcesMock = vi.fn(() => {
    mangaSourcesMock.splice(0, mangaSourcesMock.length, {
      id: "manga-src",
      name: "manga-src",
      displayName: "Manga Source",
      lang: "en",
      iconUrl: null,
      isNsfw: false,
    });
  });
  const mangaExtensionsMock: Array<{
    apkName: string;
    pkgName: string;
    name: string;
    lang: string;
    versionName: string;
    isInstalled: boolean;
    isObsolete: boolean;
    hasUpdate: boolean;
    iconUrl: string | null;
  }> = [];
  const failMangaUpdateIdsMock = new Set<string>();
  const sourceMangaFailureMock = {
    value: null as Error | null,
  };
  const resetMangaExtensionsMock = vi.fn(() => {
    failMangaUpdateIdsMock.clear();
    mangaExtensionsMock.splice(
      0,
      mangaExtensionsMock.length,
      {
        apkName: "mangadex.apk",
        pkgName: "ext.mangadex",
        name: "MangaDex",
        lang: "en",
        versionName: "1.0",
        isInstalled: true,
        isObsolete: false,
        hasUpdate: true,
        iconUrl: null,
      },
      {
        apkName: "asura.apk",
        pkgName: "ext.asura",
        name: "Asura Scans",
        lang: "en",
        versionName: "1.0",
        isInstalled: false,
        isObsolete: false,
        hasUpdate: false,
        iconUrl: null,
      },
      {
        apkName: "comick.apk",
        pkgName: "ext.comick",
        name: "Comick",
        lang: "en",
        versionName: "1.0",
        isInstalled: true,
        isObsolete: false,
        hasUpdate: false,
        iconUrl: null,
      },
    );
  });
  const runtimeExtensions = () => mangaExtensionsMock.map((extension) => ({
    packageName: extension.pkgName,
    name: extension.name,
    language: extension.lang,
    versionName: extension.versionName,
    versionCode: "1",
    isInstalled: extension.isInstalled,
    isObsolete: extension.isObsolete,
    hasUpdate: extension.hasUpdate,
    iconUrl: extension.iconUrl,
    storeId: null,
    apkName: extension.apkName,
    apkUrl: null,
    jarUrl: null,
  }));
  const managedRuntimeListExtensionsMock = vi.fn(async () => runtimeExtensions());
  const managedRuntimeRefreshExtensionsMock = vi.fn(async () => runtimeExtensions());
  const managedRuntimeInstallExtensionMock = vi.fn(async ({ packageName }: { packageName: string }) => {
    const extension = mangaExtensionsMock.find((item) => item.pkgName === packageName);
    if (!extension) throw new Error("Extension not found");
    extension.isInstalled = true;
    extension.hasUpdate = false;
  });
  const managedRuntimeUpdateExtensionMock = vi.fn(async ({ packageName }: { packageName: string }) => {
    const extension = mangaExtensionsMock.find((item) => item.pkgName === packageName);
    if (!extension) throw new Error("Extension not found");
    if (failMangaUpdateIdsMock.has(packageName)) throw new Error("Repository timeout");
    extension.hasUpdate = false;
    extension.versionName = "1.1";
  });
  const managedRuntimeUninstallExtensionMock = vi.fn(async (packageName: string) => {
    const extension = mangaExtensionsMock.find((item) => item.pkgName === packageName);
    if (!extension) throw new Error("Extension not found");
    extension.isInstalled = false;
    extension.hasUpdate = false;
  });
  const managedRuntimeListStoresMock = vi.fn<() => Promise<Array<{ id: string; name: string; indexUrl: string }>>>(async () => []);
  const managedRuntimeAddStoreMock = vi.fn(async () => {});
  const managedRuntimeRemoveStoreMock = vi.fn(async () => {});
  const managedRuntimeSearchSourceMangaMock = vi.fn(async (variables: { type: string }) => {
    if (sourceMangaFailureMock.value) throw sourceMangaFailureMock.value;
    return {
      fetchSourceManga: {
        mangas: [{
          id: variables.type === "LATEST" ? 2 : 1,
          title: variables.type === "LATEST" ? "Latest Mock Manga" : "Popular Mock Manga",
          thumbnailUrl: "/mock-cover.png",
          inLibrary: false,
          chapterCount: 12,
          unreadCount: 0,
          status: "ONGOING",
          source: { id: "manga-src", displayName: "Manga Source" },
        }],
        hasNextPage: false,
      },
    };
  });
  const runTransactionalExtensionUpdatesMock = vi.fn(async (candidates: Array<{ packageName: string }>) => {
    const approved: Array<{ packageName: string }> = [];
    const rejected: Array<{ packageName: string }> = [];
    for (const candidate of candidates) {
      try {
        await managedRuntimeUpdateExtensionMock({ packageName: candidate.packageName });
        approved.push({ packageName: candidate.packageName });
      } catch {
        rejected.push({ packageName: candidate.packageName });
      }
    }
    return { approved, rejected };
  });

  return {
    addToastMock: vi.fn(),
    gqlUploadMock: vi.fn(async () => ({
      installExternalExtension: {
        extension: {
          apkName: "external.apk",
          pkgName: "ext.external",
          name: "External Source",
          isInstalled: true,
        },
      },
    })),
    resetMangaExtensionsMock,
    failMangaUpdateIdsMock,
    sourceMangaFailureMock,
    sourceMangaSearchMock: vi.fn(async (_input: { sourceId: string }) => [] as unknown[]),
    readInstalledNovelDetailsMock: vi.fn(async () => ({
      id: "novel-src:/novel-result",
      sourceId: "novel-src",
      title: "Novel Result",
      path: "/novel-result",
      coverUrl: null,
      author: "Novel Author",
      description: null,
      status: "ONGOING",
      tags: [],
      chapterCount: 12,
      chapters: [],
      source: {
        sourceId: "novel-src",
        sourceName: "Novel Source",
        sourceLang: "en",
        sourceSite: "https://novel.example.test",
      },
    })),
    searchInstalledNovelSourceMock: vi.fn(async () => [{
      sourceId: "novel-src",
      path: "/novel-result",
      title: "Novel Result",
      coverUrl: null,
    }]),
    setActiveNovelDetailMock: vi.fn(),
    managedRuntimeListExtensionsMock,
    managedRuntimeRefreshExtensionsMock,
    managedRuntimeInstallExtensionMock,
    managedRuntimeUpdateExtensionMock,
    managedRuntimeUninstallExtensionMock,
    managedRuntimeListStoresMock,
    managedRuntimeAddStoreMock,
    managedRuntimeRemoveStoreMock,
    managedRuntimeSearchSourceMangaMock,
    runTransactionalExtensionUpdatesMock,
    mangaSourcesMock,
    resetMangaSourcesMock,
    gqlMock: vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    if (query.includes("EpigraphGraphqlReady")) return { __typename: "Query" };
    if (query.includes("EpigraphExtensionsReady")) return {
      extensions: {
        nodes: mangaExtensionsMock.map((extension) => ({
          pkgName: extension.pkgName,
          isInstalled: extension.isInstalled,
        })),
      },
    };
    if (query.includes("EpigraphSourcesReady")) return {
      sources: {
        nodes: [{ id: "manga-src", displayName: "Manga Source" }],
      },
    };
    if (query === "GET_SOURCES") return {
      sources: {
        nodes: mangaSourcesMock,
      },
    };
    if (query === "EXPLORE_ALL_MANGA") return { mangas: { nodes: [] } };
    if (query === "GET_TRACKERS") return {
      trackers: {
        nodes: [
          {
            id: 1,
            name: "Mock Tracker",
            icon: "",
            isLoggedIn: true,
            authUrl: null,
            supportsPrivateTracking: false,
            scores: [],
            statuses: [{ value: 1, name: "Reading" }],
          },
        ],
      },
    };
    if (query === "GET_LIBRARY_SEARCH_SNAPSHOT") return {
      mangas: {
        nodes: [],
      },
    };
    if (query === "GET_ALL_TRACKER_RECORDS") return {
      trackers: {
        nodes: [
          {
            id: 1,
            name: "Mock Tracker",
            icon: "",
            isLoggedIn: true,
            authUrl: null,
            supportsPrivateTracking: false,
            scores: [],
            statuses: [{ value: 1, name: "Reading" }],
            trackRecords: {
              nodes: [],
            },
          },
        ],
      },
    };
    if (query === "GET_SOURCES_WITH_EXTENSIONS") return {
      sources: {
        nodes: [
          {
            id: "mangadex-src",
            name: "mangadex",
            displayName: "MangaDex",
            lang: "en",
            iconUrl: null,
            isNsfw: false,
            extension: { pkgName: "ext.mangadex", name: "MangaDex", lang: "en" },
          },
          {
            id: "mangadex-pt-src",
            name: "mangadex",
            displayName: "MangaDex",
            lang: "pt-BR",
            iconUrl: null,
            isNsfw: false,
            extension: { pkgName: "ext.mangadex", name: "MangaDex", lang: "all" },
          },
          {
            id: "mangadex-ja-src",
            name: "mangadex",
            displayName: "MangaDex",
            lang: "ja",
            iconUrl: null,
            isNsfw: false,
            extension: { pkgName: "ext.mangadex", name: "MangaDex", lang: "all" },
          },
          {
            id: "asura-src",
            name: "asura",
            displayName: "Asura Scans",
            lang: "en",
            iconUrl: null,
            isNsfw: false,
            extension: { pkgName: "ext.asura", name: "Asura Scans", lang: "en" },
          },
          {
            id: "asura-pt-src",
            name: "asura",
            displayName: "Asura Scans",
            lang: "pt-BR",
            iconUrl: null,
            isNsfw: false,
            extension: { pkgName: "ext.asura", name: "Asura Scans", lang: "all" },
          },
          {
            id: "comick-src",
            name: "comick",
            displayName: "Comick",
            lang: "en",
            iconUrl: null,
            isNsfw: false,
            extension: { pkgName: "ext.comick", name: "Comick", lang: "en" },
          },
          {
            id: "comick-ja-src",
            name: "comick",
            displayName: "Comick",
            lang: "ja",
            iconUrl: null,
            isNsfw: false,
            extension: { pkgName: "ext.comick", name: "Comick", lang: "all" },
          },
        ],
      },
    };
    if (query === "GET_LIBRARY") return {
      mangas: {
        nodes: [
          {
            id: 101,
            title: "Library Manga",
            thumbnailUrl: "",
            inLibrary: true,
            sourceId: "mangadex-src",
            source: { id: "mangadex-src", name: "mangadex", displayName: "MangaDex", lang: "en" },
          },
        ],
      },
    };
    if (query === "GET_CHAPTERS") return {
      chapters: {
        nodes: [
          {
            id: 1001,
            name: "Chapter 1",
            chapterNumber: 1,
            sourceOrder: 1,
            isRead: true,
            isDownloaded: false,
            isBookmarked: false,
            pageCount: 10,
            mangaId: variables?.mangaId ?? 101,
            uploadDate: null,
            realUrl: null,
            lastPageRead: 0,
            scanlator: null,
          },
        ],
      },
    };
    if (query === "FETCH_EXTENSIONS") return {
      fetchExtensions: {
        extensions: mangaExtensionsMock,
      },
    };
    if (query === "GET_EXTENSIONS") return {
      extensions: {
        nodes: mangaExtensionsMock,
      },
    };
    if (query === "UPDATE_EXTENSION") {
      const extension = mangaExtensionsMock.find((item) => item.pkgName === variables?.id);
      if (!extension) throw new Error("Extension not found");
      if (variables?.install) {
        extension.isInstalled = true;
        extension.hasUpdate = false;
      }
      if (variables?.update) {
        if (failMangaUpdateIdsMock.has(extension.pkgName)) {
          throw new Error("Repository timeout");
        }
        extension.hasUpdate = false;
        extension.versionName = "1.1";
      }
      if (variables?.uninstall) {
        extension.isInstalled = false;
        extension.hasUpdate = false;
      }
      return {
        updateExtension: {
          extension,
        },
      };
    }
    if (query === "GET_SETTINGS") return {
      settings: {
        extensionRepos: [],
      },
    };
    if (query === "SEARCH_TRACKER") return {
      searchTracker: {
        trackSearches: [
          {
            id: 1,
            trackerId: variables?.trackerId ?? 1,
            remoteId: "mock-track-manga",
            title: "Mock Tracker Manga",
            coverUrl: "/tracker-cover.png",
            summary: null,
            publishingStatus: "Publishing",
            publishingType: "Manga",
            startDate: null,
            totalChapters: 10,
            trackingUrl: "https://example.test/manga/mock-track-manga",
          },
        ],
      },
    };
    if (query === "FETCH_SOURCE_MANGA") {
      if (sourceMangaFailureMock.value) throw sourceMangaFailureMock.value;
      return {
        fetchSourceManga: {
          mangas: [
            {
              id: variables?.type === "LATEST" ? 2 : 1,
              title: variables?.type === "LATEST" ? "Latest Mock Manga" : "Popular Mock Manga",
              thumbnailUrl: "/mock-cover.png",
              inLibrary: false,
              chapterCount: 12,
              unreadCount: 0,
              status: "ONGOING",
              genre: variables?.type === "LATEST" ? ["Mystery"] : ["Action"],
              source: { id: "manga-src", displayName: "Manga Source" },
            },
          ],
          hasNextPage: false,
        },
      };
    }
      return {};
    }),
    browseInstalledNovelSourceMock: vi.fn(async () => [
      {
        sourceId: "novel-src",
        path: "/novel",
        title: "Popular Mock Novel",
        coverUrl: null,
      },
    ]),
    detectSetupStateMock: vi.fn<() => Promise<import("../../lib/setupState").SetupState>>(async () => ({
      kind: "ready",
      extensionRepoCount: 1,
      installedExtensionCount: 1,
      installedContentExtensionCount: 1,
      installedHelperExtensionCount: 0,
      totalSourceCount: 1,
      usableSourceCount: 1,
      hiddenSourceCount: 0,
      errorMessage: null,
    })),
    ensureServerAwakeForMock: vi.fn(async () => true),
    loadTrustedInstalledNovelSourcesMock: vi.fn(async () => [
      {
        pluginId: "novel-src",
        name: "Novel Source",
        lang: "en",
        iconUrl: null,
        enabled: true,
      },
    ]),
  };
});

vi.mock("../../lib/client", () => ({
  gql: gqlMock,
  gqlUpload: gqlUploadMock,
  thumbUrl: vi.fn((url: string | null) => url ?? ""),
}));

vi.mock("../../lib/queries", () => ({
  GET_SOURCES: "GET_SOURCES",
  GET_SOURCES_WITH_EXTENSIONS: "GET_SOURCES_WITH_EXTENSIONS",
  GET_LIBRARY: "GET_LIBRARY",
  GET_CHAPTERS: "GET_CHAPTERS",
  EXPLORE_ALL_MANGA: "EXPLORE_ALL_MANGA",
  FETCH_SOURCE_MANGA: "FETCH_SOURCE_MANGA",
  GET_TRACKERS: "GET_TRACKERS",
  SEARCH_TRACKER: "SEARCH_TRACKER",
  GET_LIBRARY_SEARCH_SNAPSHOT: "GET_LIBRARY_SEARCH_SNAPSHOT",
  GET_ALL_TRACKER_RECORDS: "GET_ALL_TRACKER_RECORDS",
  GET_EXTENSIONS: "GET_EXTENSIONS",
  FETCH_EXTENSIONS: "FETCH_EXTENSIONS",
  GET_SETTINGS: "GET_SETTINGS",
  UPDATE_EXTENSION: "UPDATE_EXTENSION",
  INSTALL_EXTERNAL_EXTENSION: "INSTALL_EXTERNAL_EXTENSION",
  SET_EXTENSION_REPOS: "SET_EXTENSION_REPOS",
}));

vi.mock("../../lib/manga/sourceSearch", () => ({
  fetchSourceMangaSearchWithFallback: sourceMangaSearchMock,
}));

vi.mock("../../lib/manga/runtime", async () => {
  const actual = await vi.importActual<typeof import("../../lib/manga/runtime")>("../../lib/manga/runtime");
  return {
    ...actual,
    searchSourceManga: managedRuntimeSearchSourceMangaMock,
    runTransactionalExtensionUpdates: runTransactionalExtensionUpdatesMock,
    getManagedSourceRuntime: vi.fn(async () => ({
      listExtensions: managedRuntimeListExtensionsMock,
      refreshExtensions: managedRuntimeRefreshExtensionsMock,
      installExtension: managedRuntimeInstallExtensionMock,
      updateExtension: managedRuntimeUpdateExtensionMock,
      uninstallExtension: managedRuntimeUninstallExtensionMock,
      listStores: managedRuntimeListStoresMock,
      addStore: managedRuntimeAddStoreMock,
      removeStore: managedRuntimeRemoveStoreMock,
    })),
  };
});

vi.mock("../../lib/cache", () => ({
  cache: { get: vi.fn(async (_key: string, load: () => Promise<unknown>) => load()) },
  CACHE_KEYS: { sourceMangaPage: vi.fn(() => "page-key") },
  getPageSet: vi.fn(() => ({ add: vi.fn() })),
}));

vi.mock("../../lib/util", () => ({
  dedupeSources: vi.fn((sources: unknown[]) => sources),
  dedupeMangaById: vi.fn((items: unknown[]) => items),
  dedupeMangaByTitle: vi.fn((items: unknown[]) => items),
  shouldHideNsfw: vi.fn(() => false),
  shouldHideSource: vi.fn(() => false),
}));

vi.mock("../../store/state.svelte", async () => {
  const actual = await vi.importActual<typeof import("../../store/state.svelte")>("../../store/state.svelte");
  return {
    ...actual,
    addToast: addToastMock,
    setSearchPrefill: vi.fn(),
    openMangaDetail: vi.fn(),
    setActiveNovelDetail: setActiveNovelDetailMock,
    setExtensionsPanelHint: vi.fn(),
    setSearchTabHint: vi.fn(),
    setSearchBrowseHint: vi.fn(),
    setSearchSourcesPaneHint: vi.fn(),
    setSearchVisibilityDismissed: vi.fn(),
    store: {
      ...actual.store,
      setLibraryMangaSnapshot: vi.fn(),
      settings: {
        ...actual.store.settings,
        showNsfw: true,
        renderLimit: 24,
        mangaLinks: [],
        preferredExtensionLang: "en",
      },
      searchTabHint: null,
      searchBrowseHint: null,
      searchSourcesPaneHint: null,
      searchVisibilityDismissed: false,
      genreFilter: "",
      searchPrefill: "",
      contentSetupVersion: 0,
      runtimeResolvedLocalProfileId: "main",
      runtimeServerUrl: "http://127.0.0.1:4567",
    },
  };
});

vi.mock("../../lib/setupState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/setupState")>()),
  detectSetupState: detectSetupStateMock,
}));

vi.mock("../../lib/serverLifecycle", () => ({
  ensureServerAwakeFor: ensureServerAwakeForMock,
  maybeStandbyLocalServer: vi.fn(async () => true),
  SERVER_READY_EVENT: "epigraph:server-ready",
}));

vi.mock("../../lib/novels/sources", () => ({
  browseInstalledNovelSource: browseInstalledNovelSourceMock,
  loadTrustedInstalledNovelSources: loadTrustedInstalledNovelSourcesMock,
  readInstalledNovelDetails: readInstalledNovelDetailsMock,
  searchInstalledNovelSource: searchInstalledNovelSourceMock,
  shutdownInstalledNovelSourcesRuntime: vi.fn(async () => {}),
}));

vi.mock("../../lib/novels/repositoryState", () => ({
  addNovelRepositoryToState: vi.fn((state) => state),
  deriveNovelRepositoryUiState: vi.fn(() => "ready"),
  loadNovelRepositoryState: vi.fn(async () => ({
    repositories: [],
    catalogEntries: [],
  })),
  refreshAllNovelRepositories: vi.fn(async (state) => ({
    state,
  })),
  refreshNovelRepositoryCatalog: vi.fn(async (state) => ({
    state,
    status: "not-modified",
    repository: { lastError: null },
    catalogCount: 0,
  })),
  removeNovelRepositoryFromState: vi.fn((state) => state),
  saveNovelRepositoryState: vi.fn(async (state) => state),
  setNovelRepositoryEnabled: vi.fn((state) => state),
}));

vi.mock("../../lib/novels/domain", () => ({
  createNovelLibraryId: vi.fn(() => "novel-lib-id"),
}));

vi.mock("../../lib/novels/libraryState", () => ({
  isNovelInLibrary: vi.fn(() => false),
  loadNovelLibraryState: vi.fn(async () => null),
  peekNovelLibraryState: vi.fn(() => null),
}));

import BrowseV3 from "./BrowseV3.svelte";
import { openMangaDetail as openMangaDetailMock, store as browseStore } from "../../store/state.svelte";

describe("BrowseV3", () => {
  beforeEach(() => {
    gqlMock.mockClear();
    gqlUploadMock.mockClear();
    addToastMock.mockClear();
    resetMangaExtensionsMock();
    managedRuntimeListExtensionsMock.mockClear();
    managedRuntimeRefreshExtensionsMock.mockClear();
    managedRuntimeInstallExtensionMock.mockClear();
    managedRuntimeUpdateExtensionMock.mockClear();
    managedRuntimeUninstallExtensionMock.mockClear();
    managedRuntimeListStoresMock.mockReset();
    managedRuntimeListStoresMock.mockResolvedValue([{
      id: "repo-default",
      name: "Extension repository",
      indexUrl: "https://example.test/index.min.json",
    }]);
    managedRuntimeAddStoreMock.mockClear();
    managedRuntimeRemoveStoreMock.mockClear();
    managedRuntimeSearchSourceMangaMock.mockClear();
    runTransactionalExtensionUpdatesMock.mockClear();
    resetMangaSourcesMock();
    sourceMangaFailureMock.value = null;
    sourceMangaSearchMock.mockReset();
    sourceMangaSearchMock.mockResolvedValue([]);
    searchInstalledNovelSourceMock.mockClear();
    readInstalledNovelDetailsMock.mockClear();
    setActiveNovelDetailMock.mockClear();
    browseStore.searchPrefill = "";
    browseStore.searchBrowseContentType = "manga";
    vi.mocked(openMangaDetailMock).mockClear();
    browseInstalledNovelSourceMock.mockClear();
    detectSetupStateMock.mockClear();
    detectSetupStateMock.mockResolvedValue({
      kind: "ready",
      extensionRepoCount: 1,
      installedExtensionCount: 1,
      installedContentExtensionCount: 1,
      installedHelperExtensionCount: 0,
      totalSourceCount: 1,
      usableSourceCount: 1,
      hiddenSourceCount: 0,
      errorMessage: null,
    });
    ensureServerAwakeForMock.mockReset();
    ensureServerAwakeForMock.mockResolvedValue(true);
  });

  afterEach(() => cleanup());

  test("shows Search by default and can switch to Discover and Sources", async () => {
    render(BrowseV3);

    await waitFor(() => {
      expect(screen.getByText("Find something to read")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Discover" }));

    await waitFor(() => {
      expect(screen.getByText("Discover New Series")).toBeTruthy();
    });

    expect(screen.getByText("Filters")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
    expect(screen.getByRole("button", { name: /All sources/i })).toBeTruthy();
    expect(screen.getByText("Genres")).toBeTruthy();
    expect(screen.getByText("Language")).toBeTruthy();

    const searchInput = screen.getByPlaceholderText("Filter Discover...");
    await fireEvent.focus(searchInput);
    expect(document.body.className).not.toContain("epigraph-browse-search-engaged");
    await fireEvent.blur(searchInput);
    expect(document.body.className).not.toContain("epigraph-browse-search-engaged");

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(document.body.className).not.toContain("epigraph-browse-search-engaged");

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sources" })).toBeTruthy();
      expect(screen.getByText("Installed")).toBeTruthy();
    });
  });

  test("does not present recommendation totals as source-backed while setup is incomplete", async () => {
    detectSetupStateMock.mockResolvedValue({
      kind: "no_extension_repos",
      extensionRepoCount: 0,
      installedExtensionCount: 0,
      installedContentExtensionCount: 0,
      installedHelperExtensionCount: 0,
      totalSourceCount: 0,
      usableSourceCount: 0,
      hiddenSourceCount: 0,
      errorMessage: null,
    });

    render(BrowseV3);

    await waitFor(() => {
      expect(screen.getByText("Finish setup to load recommendations from your sources.")).toBeTruthy();
    });
    expect(screen.queryByText(/recommendations from installed sources/i)).toBeNull();
  });

  test("refreshes an existing repository when the cached extension catalog is empty", async () => {
    managedRuntimeListStoresMock.mockResolvedValueOnce([{
      id: "repo-1",
      name: "Extension repository",
      indexUrl: "https://example.test/index.min.json",
    }]);
    managedRuntimeListExtensionsMock.mockResolvedValueOnce([]);

    render(BrowseV3);
    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(managedRuntimeRefreshExtensionsMock).toHaveBeenCalled();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Available" }));
    await waitFor(() => {
      expect(screen.getByText("Asura Scans")).toBeTruthy();
    });
  });

  test("accepts a GitHub repository page and adds its raw extension index safely", async () => {
    render(BrowseV3);
    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    const manageButton = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('button[title="Manage repos"]');
      expect(button).toBeTruthy();
      return button!;
    });
    await fireEvent.click(manageButton);
    const input = await waitFor(() => {
      const dialog = screen.getByRole("dialog", { name: "Manga repositories" });
      const field = within(dialog).queryByPlaceholderText("https://example.com/index.min.json");
      expect(field).toBeTruthy();
      return field!;
    });
    await fireEvent.input(input, { target: { value: "https://github.com/keiyoushi/extensions" } });
    const dialog = screen.getByRole("dialog", { name: "Manga repositories" });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(managedRuntimeAddStoreMock).toHaveBeenCalledWith({
        indexUrl: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
      });
    });
    expect(managedRuntimeRemoveStoreMock).not.toHaveBeenCalled();
  });

  test("does not expose stale available extensions when no repository is configured", async () => {
    managedRuntimeListStoresMock.mockResolvedValue([]);
    managedRuntimeListExtensionsMock.mockResolvedValueOnce([{
      packageName: "ext.stale",
      name: "Stale cached extension",
      language: "en",
      versionName: "1.0",
      versionCode: "1",
      isInstalled: false,
      isObsolete: false,
      hasUpdate: false,
      iconUrl: null,
      storeId: null,
      apkName: "stale.apk",
      apkUrl: null,
      jarUrl: null,
    }]);
    detectSetupStateMock.mockResolvedValue({
      kind: "no_extension_repos",
      extensionRepoCount: 0,
      installedExtensionCount: 0,
      installedContentExtensionCount: 0,
      installedHelperExtensionCount: 0,
      totalSourceCount: 0,
      usableSourceCount: 0,
      hiddenSourceCount: 0,
      errorMessage: null,
    });

    render(BrowseV3);
    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(document.querySelectorAll("[data-sources-count]")).toHaveLength(4);
    });
    expect(screen.queryByText("Stale cached extension")).toBeNull();
    await waitFor(() => {
      expect(screen.getByText("Add an extension repository first")).toBeTruthy();
    });
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });

  test("uses the full-area Sources workspace with overview and dedicated updates states", async () => {
    const { container } = render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });

    expect(document.querySelector("[data-sources-workspace]")).toBeTruthy();
    expect(document.querySelector("[data-sources-overview]")).toBeTruthy();
    expect(container.querySelectorAll("[data-sources-count]")).toHaveLength(4);
    expect(container.querySelector(".sourcesTitle span")).toBeNull();
    expect(container.querySelector(".tabs small")).toBeNull();
    expect(container.querySelector(".sourcesFooter")).toBeNull();

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    expect(refreshButton.closest(".sourceTools")).toBeTruthy();
    expect(container.querySelector(".searchWrap")?.parentElement).toBe(refreshButton.closest(".sourceTools"));

    const updatesTab = container.querySelector<HTMLButtonElement>('.tabs button[aria-label="Updates"]');
    expect(updatesTab).toBeTruthy();
    await fireEvent.click(updatesTab!);

    await waitFor(() => {
      expect(container.querySelector('.tabs button[aria-label="Updates"]')?.getAttribute("aria-current")).toBe("page");
    });
    expect(document.querySelector("[data-sources-overview]")).toBeTruthy();
    expect(container.querySelector(".updatesHeading")).toBeNull();
    expect(container.querySelector('[data-sources-workspace] .searchWrap input[placeholder="Search extensions..."]')).toBeTruthy();
    expect(screen.getByText("MangaDex")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Installed" }));

    await waitFor(() => {
      expect(document.querySelector("[data-sources-overview]")).toBeTruthy();
    });
  });

  test("finishes a manual Sources refresh when a server-ready reload supersedes its catalog run", async () => {
    const refreshedExtensions = await managedRuntimeListExtensionsMock();
    let resolveRefresh: ((value: Awaited<ReturnType<typeof managedRuntimeListExtensionsMock>>) => void) | null = null;
    managedRuntimeRefreshExtensionsMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const { container } = render(BrowseV3);
    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    await fireEvent.click(refreshButton);
    await waitFor(() => expect((refreshButton as HTMLButtonElement).disabled).toBe(true));
    await waitFor(() => expect(resolveRefresh).toBeTruthy());

    window.dispatchEvent(new CustomEvent("epigraph:server-ready"));
    (resolveRefresh as unknown as (value: Awaited<ReturnType<typeof managedRuntimeListExtensionsMock>>) => void)(refreshedExtensions);

    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false));
    expect(container.querySelector(".refreshAction .anim-spin")).toBeNull();
  });

  test("routes Browse manga cards to the active SeriesDetail instead of the legacy preview", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/pages/BrowseV3.svelte"), "utf8");

    expect(source).toContain("openMangaDetail(manga)");
    expect(source).toContain("function openKeywordMangaResult(manga: Manga)");
    expect(source).toContain("onclick={() => openKeywordMangaResult(m)}");
    expect(source).toContain("kw_abortCtrl?.abort()");
    expect(source).toContain("const linkedNovelId = hardcoverRecord?.sourceNovelId ?? null;");
    expect(source).toContain("metadataOnly: true");
    expect(source).not.toContain("setPreviewManga(m)");
  });

  test("uses the shared palette only for keyword search", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/pages/BrowseV3.svelte"), "utf8");
    const focusHandler = source.slice(
      source.indexOf("function handleBrowseSearchFocus()"),
      source.indexOf("function handleBrowseSearchBlur()"),
    );

    expect(focusHandler).toContain("function openBrowseSearchPalette(query: string)");
    expect(focusHandler).toContain('if (activeBrowseTab !== "keyword" || !query.trim()) return');
    expect(focusHandler).toContain('browseSurface: "keyword"');
    expect(focusHandler).not.toContain('document.body.classList.add("epigraph-browse-search-engaged")');
  });

  test("keeps one independent horizontal result state per installed source", async () => {
    browseStore.searchPrefill = "missing title";
    render(BrowseV3);

    await waitFor(() => {
      expect(sourceMangaSearchMock).toHaveBeenCalledTimes(1);
      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("missing title");
      expect(screen.getByRole("heading", { level: 3, name: "Manga Source" })).toBeTruthy();
      expect(screen.getAllByText('No results for "missing title"').length).toBeGreaterThan(0);
    });
  });

  test("shows the empty installed-source state without starting remote manga requests", async () => {
    mangaSourcesMock.splice(0, mangaSourcesMock.length);
    browseStore.searchPrefill = "missing source";
    render(BrowseV3);

    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("missing source");
      expect(sourceMangaSearchMock).not.toHaveBeenCalled();
      expect(screen.getByText("No Suwayomi source data is available yet.")).toBeTruthy();
    });
  });

  test("opens a source novel with its stable source and path identity", async () => {
    browseStore.searchBrowseContentType = "novels";
    browseStore.searchPrefill = "Novel Result";
    render(BrowseV3);

    const card = await screen.findByRole("button", { name: /Novel Result/i });
    await fireEvent.click(card);

    await waitFor(() => {
      expect(searchInstalledNovelSourceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "main",
          serverUrl: "http://127.0.0.1:4567",
        }),
        "novel-src",
        "Novel Result",
        1,
      );
      expect(readInstalledNovelDetailsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "main",
          serverUrl: "http://127.0.0.1:4567",
        }),
        "novel-src",
        "/novel-result",
        {
          title: "Novel Result",
          coverUrl: null,
        },
      );
      expect(setActiveNovelDetailMock).toHaveBeenCalledWith(expect.objectContaining({
        novel: expect.objectContaining({
          sourceId: "novel-src",
          path: "/novel-result",
        }),
      }));
    });
  });

  test("keeps stable source and item identities in keyboard-enabled result rows", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/pages/BrowseV3.svelte"), "utf8");

    expect(source).toContain("data-keyword-source-row={source.id}");
    expect(source).toContain("data-keyword-source-row={source.pluginId}");
    expect(source).toContain('data-browse-result-key={`${source.id}:${m.id}`}');
    expect(source).toContain('data-browse-result-key={`${result.sourceId}:${result.path}`}');
    expect(source).toContain("onkeydown={handleKeywordResultKeydown}");
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).toContain('event.key === "ArrowLeft"');
    expect(source).toContain('event.key === "ArrowDown"');
    expect(source).toContain('event.key === "ArrowUp"');
    expect(source).not.toContain("kw_results.filter((r) => r.mangas.length > 0 || r.loading || r.error)");
    expect(source).not.toContain("kw_novelResults.filter((r) => r.novels.length > 0 || r.loading || r.error)");
  });

  test("moves horizontally within one source and vertically to the nearest card without moving other rows", async () => {
    mangaSourcesMock.push({
      id: "second-src",
      name: "second-src",
      displayName: "Second Source",
      lang: "en",
      iconUrl: null,
      isNsfw: false,
    });
    sourceMangaSearchMock.mockImplementation(async ({ sourceId }: { sourceId: string }) => (
      [1, 2].map((position) => ({
        id: sourceId === "manga-src" ? 100 + position : 200 + position,
        title: `${sourceId} result ${position}`,
        thumbnailUrl: "",
        inLibrary: false,
        chapterCount: position,
        status: "ONGOING",
        sourceId,
      }))
    ));
    browseStore.searchPrefill = "result";
    render(BrowseV3);

    await waitFor(() => expect(document.querySelectorAll("[data-keyword-source-row]").length).toBe(2));
    const rows = [...document.querySelectorAll<HTMLElement>("[data-keyword-source-row]")];
    const firstRowCards = [...rows[0].querySelectorAll<HTMLButtonElement>("[data-browse-result-key]")];
    const secondRowCards = [...rows[1].querySelectorAll<HTMLButtonElement>("[data-browse-result-key]")];
    Object.defineProperty(rows[0], "scrollLeft", { value: 0, writable: true });
    Object.defineProperty(rows[1], "scrollLeft", { value: 31, writable: true });
    rows[0].getBoundingClientRect = () => rect(100, 100, 500, 300);
    firstRowCards[1].getBoundingClientRect = () => rect(520, 100, 620, 250);

    firstRowCards[0].focus();
    await fireEvent.keyDown(firstRowCards[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(firstRowCards[1]);
    expect(rows[0].scrollLeft).toBe(120);
    expect(rows[1].scrollLeft).toBe(31);

    await fireEvent.keyDown(firstRowCards[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondRowCards[1]);

    await fireEvent.click(secondRowCards[1]);
    expect(openMangaDetailMock).toHaveBeenCalledTimes(1);
    expect(openMangaDetailMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 202,
      sourceId: "second-src",
    }));
  });

  test("installs, updates, and removes manga extensions from Sources", async () => {
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Available" }));
    await waitFor(() => {
      expect(screen.getByText("Asura Scans")).toBeTruthy();
    });
    await fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(managedRuntimeInstallExtensionMock).toHaveBeenCalledWith({ packageName: "ext.asura" });
    });
    await waitFor(() => {
      expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Extension installed" }));
    });

    await fireEvent.click(screen.getByRole("button", { name: /Updates/ }));
    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });
    await fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(managedRuntimeRefreshExtensionsMock).toHaveBeenCalled();
      expect(managedRuntimeUpdateExtensionMock).toHaveBeenCalledWith({ packageName: "ext.mangadex" });
    });
    await waitFor(() => {
      expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Extension updated" }));
    });

    await fireEvent.click(screen.getByRole("button", { name: "Installed" }));
    await waitFor(() => {
      expect(screen.getAllByText("Asura Scans").length).toBeGreaterThan(0);
    });
    await fireEvent.click(screen.getAllByText("Asura Scans")[0]);

    const settingsPanel = await waitFor(() => screen.getByLabelText("Settings for Asura Scans"));
    await fireEvent.click(within(settingsPanel).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(managedRuntimeUninstallExtensionMock).toHaveBeenCalledWith(expect.any(String));
    });
    await waitFor(() => {
      expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Extension removed" }));
    });
  });

  test("opens mass migration from an installed manga extension settings panel", async () => {
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });

    await fireEvent.click(screen.getByText("MangaDex"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Mass migration" })).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Mass migration" }));

    await waitFor(() => {
      expect(screen.getAllByText("Mass migration").length).toBeGreaterThan(1);
      expect(screen.getAllByText("Comick").length).toBeGreaterThan(0);
    });
    expect(screen.getByRole("dialog", { name: "MangaDex" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close mass migration" })).toBeTruthy();
    expect(screen.getAllByText("Comick").length).toBeGreaterThan(0);
    expect(screen.queryByText("PT-BR")).toBeNull();
    expect(screen.queryByText("JA")).toBeNull();

    await fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "MangaDex" })).toBeNull();
    });
  });

  test("reports partial failures when updating all manga extensions", async () => {
    failMangaUpdateIdsMock.add("ext.mangadex");
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Updates" })).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Updates" }));

    await fireEvent.click(await screen.findByRole("button", { name: "Update all (1)" }));

    await waitFor(() => {
      expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: "error",
        title: "Some extensions could not update",
      }));
    });
    await waitFor(() => {
      expect(screen.getByText("The update was preserved for review because compatibility checks failed.")).toBeTruthy();
    });
  });

  test("installs external manga extensions from a local apk file", async () => {
    const { container } = render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });

    await fireEvent.click(screen.getByTitle("Install APK file"));
    await waitFor(() => {
      expect(screen.getByText("Choose a local `.apk` extension package. Epigraph will install it through the same extension manager used by repository installs.")).toBeTruthy();
    });

    const dialog = screen.getByRole("dialog", { name: "Install APK file" });
    expect(dialog).toBeTruthy();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(fileInput).toBeTruthy();
    expect(fileInput?.classList.contains("apkFileInput")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Choose file" })).toBeTruthy();
    expect(within(dialog).getByText("No APK selected")).toBeTruthy();
    const panel = dialog;
    expect(panel).toBeTruthy();
    const installButton = within(panel as HTMLElement).getByRole("button", { name: "Install" });

    await fireEvent.click(installButton);
    await waitFor(() => {
      expect(screen.getByText("Choose an .apk extension file first.")).toBeTruthy();
    });
    expect(gqlUploadMock).not.toHaveBeenCalled();

    await fireEvent.change(fileInput!, {
      target: { files: [new File(["not an apk"], "source.txt", { type: "text/plain" })] },
    });
    await fireEvent.click(installButton);
    await waitFor(() => {
      expect(screen.getByText("File must be an .apk extension package.")).toBeTruthy();
    });
    expect(gqlUploadMock).not.toHaveBeenCalled();

    await fireEvent.change(fileInput!, {
      target: { files: [new File(["apk"], "source.apk", { type: "application/vnd.android.package-archive" })] },
    });
    expect(within(dialog).getByText("source.apk")).toBeTruthy();
    await fireEvent.click(installButton);

    await waitFor(() => {
      expect(gqlUploadMock).toHaveBeenCalledWith(
        "INSTALL_EXTERNAL_EXTENSION",
        { extensionFile: null },
        { "variables.extensionFile": expect.any(File) },
      );
    });
  });

  test("shows installed manga extensions when the wake probe is stale but GraphQL responds", async () => {
    ensureServerAwakeForMock.mockResolvedValue(false);
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });
    expect(document.querySelector('.sourcesOverview button[aria-current="page"] [data-sources-count]')?.textContent).toBe("2");
  });

  test("keeps the last manga extension list during a transient reload failure", async () => {
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });

    managedRuntimeListExtensionsMock.mockRejectedValueOnce(
      new Error("Suwayomi returned an empty GraphQL error."),
    );

    window.dispatchEvent(new CustomEvent("epigraph:server-ready"));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
      expect(screen.queryByText("No extensions found")).toBeNull();
    });
  });

  test("clears stale Sources search when switching between manga and novels", async () => {
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });

    await fireEvent.input(screen.getAllByPlaceholderText("Search extensions...")[0], {
      target: { value: "central novel" },
    });
    await waitFor(() => {
      expect(screen.queryByText("MangaDex")).toBeNull();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Books" }));
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "Comics" }));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });
  });

  test("keeps manga sources out of the manga filter and shows novel sources only in novels", async () => {
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Discover" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /All sources/i }).length).toBeGreaterThan(0);
    });

    await fireEvent.click(screen.getAllByRole("button", { name: /All sources/i })[0]);
    expect(screen.getAllByRole("button", { name: /Manga Source/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Novel Source/i })).toBeNull();
    expect(screen.getByPlaceholderText("Filter Discover...")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Books" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /All sources/i }).length).toBeGreaterThan(0);
    });

    await fireEvent.click(screen.getAllByRole("button", { name: /All sources/i })[0]);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Novel Source/i })).toBeTruthy();
    });
    expect(screen.getByPlaceholderText("Filter Discover...")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Comics" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /All sources/i }).length).toBeGreaterThan(0);
    });

    await fireEvent.click(screen.getAllByRole("button", { name: /All sources/i })[0]);
    expect(screen.getAllByRole("button", { name: /Manga Source/i }).length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("Filter Discover...")).toBeTruthy();
  });

  test("loads discover results without opening the Sources tab", async () => {
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Discover" }));

    await waitFor(() => {
      expect(screen.getByText("Popular Mock Manga")).toBeTruthy();
    });

    await fireEvent.click(screen.getAllByRole("button", { name: /All sources/i })[0]);
    await fireEvent.click(screen.getAllByRole("button", { name: /Manga Source/i })[0]);

    await waitFor(() => {
      expect(screen.getByText("Popular Mock Manga")).toBeTruthy();
    });

    expect(screen.queryByText("Browse Sources")).toBeNull();
    expect(screen.getByText("Discover New Series")).toBeTruthy();
  });

  test("uses Latest fetch type when the catalog filter changes", async () => {
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Discover" }));

    await waitFor(() => {
      expect(screen.getByText("Popular Mock Manga")).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Latest" }));

    await waitFor(() => {
      expect(screen.getByText("Latest Mock Manga")).toBeTruthy();
    });

    expect(managedRuntimeSearchSourceMangaMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "LATEST" }),
      expect.any(AbortSignal),
    );
  });

  test("logs expected source recommendation failures as deduped info instead of warnings", async () => {
    vi.useFakeTimers();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sourceMangaFailureMock.value = new Error("Cloudflare bypass currently disabled");

    try {
      render(BrowseV3);
      await vi.advanceTimersByTimeAsync(550);
      await tick();
      await vi.advanceTimersByTimeAsync(120);

      await waitFor(() => {
        expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("source-challenge"));
      });
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Search recommendations source issue"),
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(120);
      expect(infoSpy.mock.calls.filter(([message]) => String(message).includes("source-challenge")).length).toBe(1);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
