import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { tick } from "svelte";

const {
  gqlMock,
  addToastMock,
  browseInstalledNovelSourceMock,
  detectSetupStateMock,
  ensureServerAwakeForMock,
  loadTrustedInstalledNovelSourcesMock,
  resetMangaExtensionsMock,
  failMangaUpdateIdsMock,
} = vi.hoisted(() => {
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
    );
  });

  return {
    addToastMock: vi.fn(),
    resetMangaExtensionsMock,
    failMangaUpdateIdsMock,
    gqlMock: vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    if (query === "GET_SOURCES") return {
      sources: {
        nodes: [
          {
            id: "manga-src",
            name: "manga-src",
            displayName: "Manga Source",
            lang: "en",
            iconUrl: null,
            isNsfw: false,
          },
        ],
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
    if (query === "GET_LIBRARY") return {
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
    if (query === "FETCH_SOURCE_MANGA") return {
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
            source: { id: "manga-src", displayName: "Manga Source" },
          },
        ],
        hasNextPage: false,
      },
    };
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
    detectSetupStateMock: vi.fn(async () => ({ kind: "ready" })),
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
  thumbUrl: vi.fn((url: string | null) => url ?? ""),
}));

vi.mock("../../lib/queries", () => ({
  GET_SOURCES: "GET_SOURCES",
  EXPLORE_ALL_MANGA: "EXPLORE_ALL_MANGA",
  FETCH_SOURCE_MANGA: "FETCH_SOURCE_MANGA",
  GET_TRACKERS: "GET_TRACKERS",
  SEARCH_TRACKER: "SEARCH_TRACKER",
  GET_LIBRARY: "GET_LIBRARY",
  GET_ALL_TRACKER_RECORDS: "GET_ALL_TRACKER_RECORDS",
  GET_EXTENSIONS: "GET_EXTENSIONS",
  FETCH_EXTENSIONS: "FETCH_EXTENSIONS",
  GET_SETTINGS: "GET_SETTINGS",
  UPDATE_EXTENSION: "UPDATE_EXTENSION",
  INSTALL_EXTERNAL_EXTENSION: "INSTALL_EXTERNAL_EXTENSION",
  SET_EXTENSION_REPOS: "SET_EXTENSION_REPOS",
}));

vi.mock("../../lib/manga/sourceSearch", () => ({
  fetchSourceMangaSearchWithFallback: vi.fn(async () => []),
}));

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
    setPreviewManga: vi.fn(),
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

vi.mock("../../lib/setupState", () => ({
  detectSetupState: detectSetupStateMock,
}));

vi.mock("../../lib/serverLifecycle", () => ({
  ensureServerAwakeFor: ensureServerAwakeForMock,
  maybeStandbyLocalServer: vi.fn(async () => true),
  SERVER_READY_EVENT: "aethon:server-ready",
}));

vi.mock("../../lib/novels/sources", () => ({
  browseInstalledNovelSource: browseInstalledNovelSourceMock,
  loadTrustedInstalledNovelSources: loadTrustedInstalledNovelSourcesMock,
  readInstalledNovelDetails: vi.fn(async () => null),
  searchInstalledNovelSource: vi.fn(async () => []),
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

vi.mock("./Extensions.svelte", () => ({ default: class ExtensionsStub {} }));
vi.mock("../shared/SetupStatusCard.svelte", () => ({ default: class SetupStatusCardStub {} }));

import BrowseV3 from "./BrowseV3.svelte";

describe("BrowseV3", () => {
  beforeEach(() => {
    gqlMock.mockClear();
    addToastMock.mockClear();
    resetMangaExtensionsMock();
    browseInstalledNovelSourceMock.mockClear();
    detectSetupStateMock.mockClear();
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
    expect(document.body.className).toContain("aethon-browse-search-engaged");
    await fireEvent.blur(searchInput);
    expect(document.body.className).not.toContain("aethon-browse-search-engaged");

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("Manage extensions")).toBeTruthy();
      expect(screen.getByText("Installed")).toBeTruthy();
    });
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
      expect(gqlMock).toHaveBeenCalledWith(
        "UPDATE_EXTENSION",
        expect.objectContaining({ id: "ext.asura", install: true }),
        undefined,
        60000,
      );
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
      expect(gqlMock).toHaveBeenCalledWith(
        "UPDATE_EXTENSION",
        expect.objectContaining({ id: "ext.mangadex", update: true }),
      );
    });
    await waitFor(() => {
      expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Extension updated" }));
    });

    await fireEvent.click(screen.getByRole("button", { name: "Installed" }));
    await waitFor(() => {
      expect(screen.getAllByText("Asura Scans").length).toBeGreaterThan(0);
    });
    await fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);

    await waitFor(() => {
      expect(gqlMock).toHaveBeenCalledWith(
        "UPDATE_EXTENSION",
        expect.objectContaining({ uninstall: true }),
      );
    });
    await waitFor(() => {
      expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Extension removed" }));
    });
  });

  test("reports partial failures when updating all manga extensions", async () => {
    failMangaUpdateIdsMock.add("ext.mangadex");
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Update all (1)" })).toBeTruthy();
    });

    await fireEvent.click(screen.getByRole("button", { name: "Update all (1)" }));

    await waitFor(() => {
      expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({
        kind: "error",
        title: "Some extensions could not update",
      }));
    });
    await waitFor(() => {
      expect(screen.getByText("Repository timeout")).toBeTruthy();
    });
  });

  test("shows installed manga extensions when the wake probe is stale but GraphQL responds", async () => {
    ensureServerAwakeForMock.mockResolvedValue(false);
    render(BrowseV3);

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("MangaDex")).toBeTruthy();
    });
    expect(screen.getByText("1 extension")).toBeTruthy();
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

    expect(gqlMock).toHaveBeenCalledWith(
      "FETCH_SOURCE_MANGA",
      expect.objectContaining({ type: "LATEST" }),
      expect.any(AbortSignal),
    );
  });
});
