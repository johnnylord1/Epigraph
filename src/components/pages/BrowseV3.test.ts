import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  gqlMock,
  browseInstalledNovelSourceMock,
  detectSetupStateMock,
  loadTrustedInstalledNovelSourcesMock,
} = vi.hoisted(() => ({
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
  loadTrustedInstalledNovelSourcesMock: vi.fn(async () => [
    {
      pluginId: "novel-src",
      name: "Novel Source",
      lang: "en",
      iconUrl: null,
    },
  ]),
}));

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
    addToast: vi.fn(),
    setSearchPrefill: vi.fn(),
    setPreviewManga: vi.fn(),
    setExtensionsPanelHint: vi.fn(),
    setSearchTabHint: vi.fn(),
    setSearchBrowseHint: vi.fn(),
    setSearchSourcesPaneHint: vi.fn(),
    setSearchVisibilityDismissed: vi.fn(),
    store: {
      ...actual.store,
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

vi.mock("../../lib/novels/sources", () => ({
  browseInstalledNovelSource: browseInstalledNovelSourceMock,
  loadTrustedInstalledNovelSources: loadTrustedInstalledNovelSourcesMock,
  readInstalledNovelDetails: vi.fn(async () => null),
  searchInstalledNovelSource: vi.fn(async () => []),
  shutdownInstalledNovelSourcesRuntime: vi.fn(async () => {}),
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
    browseInstalledNovelSourceMock.mockClear();
    detectSetupStateMock.mockClear();
  });

  afterEach(() => cleanup());

  test("shows the browse shell by default and can switch tabs", async () => {
    render(BrowseV3);

    await waitFor(() => {
      expect(screen.getByText("Discover New Series")).toBeTruthy();
    });

    expect(screen.getByText("Filters")).toBeTruthy();
    expect(screen.getByText("Source")).toBeTruthy();
    expect(screen.getByRole("button", { name: /All sources/i })).toBeTruthy();
    expect(screen.getByText("Genres")).toBeTruthy();
    expect(screen.getByText("Language")).toBeTruthy();

    const searchInput = screen.getByPlaceholderText("Search sources...");
    await fireEvent.focus(searchInput);
    expect(document.body.className).toContain("aethon-browse-search-engaged");
    await fireEvent.blur(searchInput);
    expect(document.body.className).not.toContain("aethon-browse-search-engaged");

    await fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    await waitFor(() => {
      expect(screen.getByText("Browse Sources")).toBeTruthy();
      expect(screen.getByText("Extensions & Repos")).toBeTruthy();
    });
  });

  test("keeps manga sources out of the manga filter and shows novel sources only in novels", async () => {
    render(BrowseV3);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /All sources/i }).length).toBeGreaterThan(0);
    });

    await fireEvent.click(screen.getAllByRole("button", { name: /All sources/i })[0]);
    expect(screen.getByRole("button", { name: /Manga Source/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Novel Source/i })).toBeNull();
    expect(screen.getByPlaceholderText("Search sources...")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Novels" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /All sources/i }).length).toBeGreaterThan(0);
    });

    await fireEvent.click(screen.getAllByRole("button", { name: /All sources/i })[0]);
    expect(screen.getByRole("button", { name: /Novel Source/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Manga Source/i })).toBeNull();
    expect(screen.getByPlaceholderText("Search installed novel sources...")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Manga" }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /All sources/i }).length).toBeGreaterThan(0);
    });

    await fireEvent.click(screen.getAllByRole("button", { name: /All sources/i })[0]);
    expect(screen.getAllByRole("button", { name: /Manga Source/i }).length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("Search sources...")).toBeTruthy();
  });

  test("loads discover results without opening the Sources tab", async () => {
    render(BrowseV3);

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
