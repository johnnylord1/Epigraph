import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const {
  listSourcesMock,
  mangaSourceSearchMock,
  loadNovelSourcesMock,
  novelSourceSearchMock,
  readNovelDetailsMock,
} = vi.hoisted(() => ({
  listSourcesMock: vi.fn(async () => [
    { id: "source-a", name: "source-a", displayName: "Source A", language: "en", iconUrl: null, isNsfw: false, supportsLatest: true, isConfigurable: false, extensionPackageName: "source-a" },
    { id: "source-b", name: "source-b", displayName: "Source B", language: "en", iconUrl: null, isNsfw: false, supportsLatest: true, isConfigurable: false, extensionPackageName: "source-b" },
  ]),
  mangaSourceSearchMock: vi.fn(async ({ sourceId }: { sourceId: string }) => [{
    id: sourceId === "source-a" ? 101 : 201,
    title: sourceId === "source-a" ? "Remote Alpha" : "Remote Beta",
    thumbnailUrl: "",
    inLibrary: false,
    sourceId,
    status: "ONGOING",
  }]),
  loadNovelSourcesMock: vi.fn(async () => [{
    pluginId: "novel-source",
    repositoryId: "repo",
    repositoryUrl: "https://repo.example.test",
    trustState: "trusted",
    name: "Novel Source",
    lang: "en",
    site: "https://novel.example.test",
    version: "1",
    iconUrl: null,
    artifactUrl: "https://repo.example.test/plugin.js",
    artifactPath: "plugin.js",
    enabled: true,
  }]),
  novelSourceSearchMock: vi.fn(async () => [{
    sourceId: "novel-source",
    title: "Remote Novel",
    path: "/remote-novel",
    coverUrl: null,
  }]),
  readNovelDetailsMock: vi.fn(async () => ({
    id: "novel-source:/remote-novel",
    sourceId: "novel-source",
    title: "Remote Novel",
    path: "/remote-novel",
    coverUrl: null,
    author: null,
    description: null,
    status: "ONGOING",
    tags: [],
    chapterCount: 0,
    chapters: [],
    source: {
      sourceId: "novel-source",
      sourceName: "Novel Source",
      sourceLang: "en",
      sourceSite: "https://novel.example.test",
    },
  })),
}));

vi.mock("../../lib/manga/runtime", () => ({
  getManagedSourceRuntime: vi.fn(async () => ({ listSources: listSourcesMock })),
}));

vi.mock("../../lib/manga/sourceSearch", () => ({
  fetchSourceMangaSearchWithFallback: mangaSourceSearchMock,
}));

vi.mock("../../lib/novels/sources", () => ({
  loadTrustedInstalledNovelSources: loadNovelSourcesMock,
  searchInstalledNovelSource: novelSourceSearchMock,
  readInstalledNovelDetails: readNovelDetailsMock,
}));

vi.mock("../../lib/novels/libraryState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/novels/libraryState")>();
  return {
    ...actual,
    peekNovelLibraryState: () => ({
      version: 1,
      profileId: "test",
      entries: [],
      chapters: [],
      categories: [],
      progress: [],
      bookmarks: [],
      history: [],
      updatedAtMs: null,
    }),
  };
});

import SearchPalette from "./SearchPalette.svelte";
import { store } from "../../store/state.svelte";

const comic = {
  id: 17,
  title: "Moon Reader",
  author: "Epigraph Press",
  thumbnailUrl: "",
  genre: ["Fantasy"],
  inLibrary: true,
} as never;

const book = {
  id: "book-index",
  title: "Index Book",
  author: "Epigraph Press",
  subtype: "pdf",
  coverPath: null,
  genres: ["Fantasy"],
} as never;

function originInput() {
  const search = document.createElement("div");
  search.className = "n-search";
  const input = document.createElement("input");
  input.className = "n-search__input";
  input.dataset.testid = "search-origin";
  search.append(input);
  document.body.append(search);
  input.focus();
  return input;
}

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

describe("SearchPalette behavior", () => {
  beforeEach(() => {
    store.closeSearchPalette(false);
    store.navPage = "home";
    store.librarySection = "comics";
    store.searchPrefill = "";
    store.searchBrowseContentType = "manga";
    store.libraryMangaSnapshot = [comic];
    store.books = [book];
    store.searchNovelLibraryEntries = [];
    store.searchNovelLibraryChapters = [];
    listSourcesMock.mockClear();
    mangaSourceSearchMock.mockClear();
    loadNovelSourcesMock.mockClear();
    novelSourceSearchMock.mockClear();
    readNovelDetailsMock.mockClear();
    document.body.className = "";
  });

  afterEach(() => {
    store.closeSearchPalette(false);
    store.activeManga = null;
    store.activeBookId = null;
    store.activeNovelDetail = null;
    cleanup();
    document.body.replaceChildren();
  });

  test("does not open the palette for an empty query", () => {
    store.openSearchPalette("home", " ");

    expect(store.searchOpen).toBe(false);
    expect(document.body.classList.contains("epigraph-search-engaged")).toBe(false);
  });

  test("shows the dim while engaged without rendering the palette", () => {
    store.engageSearch();
    render(SearchPalette);

    expect(store.searchEngaged).toBe(true);
    expect(store.searchOpen).toBe(false);
    expect(document.body.classList.contains("epigraph-search-engaged")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/type a title to search/i);

    store.disengageSearch();
    expect(store.searchEngaged).toBe(false);
    expect(document.body.classList.contains("epigraph-search-engaged")).toBe(false);
  });

  test("keeps one polite live region while moving from empty to no results", async () => {
    store.engageSearch();
    render(SearchPalette);
    const liveRegion = screen.getByRole("status");

    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
    expect(liveRegion.getAttribute("aria-atomic")).toBe("true");
    expect(liveRegion.textContent).toMatch(/type a title to search/i);

    store.openSearchPalette("settings", "zzzz-no-match");
    await waitFor(() => expect(liveRegion.textContent).toMatch(/no results/i));
    expect(screen.getAllByRole("status")).toEqual([liveRegion]);
  });

  test("closes on Escape, removes dim state, and restores the opener focus", async () => {
    const origin = originInput();
    store.openSearchPalette("home", "m");
    render(SearchPalette);

    await screen.findByRole("dialog");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await waitFor(() => {
      expect(store.searchOpen).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.body.classList.contains("epigraph-search-engaged")).toBe(false);
      expect(document.activeElement).toBe(origin);
      expect(origin.closest(".n-search")?.classList.contains("is-search-focus-restored")).toBe(true);
    });
    expect(store.isSearchFocusRestoreInProgress).toBe(false);

    store.engageSearch();
    expect(origin.closest(".n-search")?.classList.contains("is-search-focus-restored")).toBe(false);
  });

  test("clears a typed query before closing the engaged search on Escape", async () => {
    const origin = originInput();
    store.openSearchPalette("home", "moon");
    render(SearchPalette);

    await screen.findByRole("dialog");
    await fireEvent.keyDown(origin, { key: "Escape" });

    await waitFor(() => {
      expect(store.searchQuery).toBe("");
      expect(store.searchOpen).toBe(false);
      expect(store.searchEngaged).toBe(true);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.body.classList.contains("epigraph-search-engaged")).toBe(true);
      expect(document.activeElement).toBe(origin);
    });

    await fireEvent.keyDown(origin, { key: "Escape" });

    await waitFor(() => {
      expect(store.searchEngaged).toBe(false);
      expect(document.body.classList.contains("epigraph-search-engaged")).toBe(false);
      expect(document.activeElement).not.toBe(origin);
    });
  });

  test("restores focus from the close button and backdrop without reopening", async () => {
    const origin = originInput();
    store.openSearchPalette("home", "m");
    render(SearchPalette);

    await screen.findByRole("dialog");
    const closeButtons = screen.getAllByRole("button", { name: /close/i });
    await fireEvent.click(closeButtons.at(-1)!);
    await waitFor(() => expect(document.activeElement).toBe(origin));
    expect(store.searchOpen).toBe(false);

    store.openSearchPalette("home", "m");
    await screen.findByRole("dialog");
    const reopenedCloseButtons = screen.getAllByRole("button", { name: /close/i });
    await fireEvent.click(reopenedCloseButtons[0]);
    await waitFor(() => expect(document.activeElement).toBe(origin));
    expect(store.searchOpen).toBe(false);
  });

  test("does not restore focus after navigation or when the opener was removed", async () => {
    const origin = originInput();
    store.openSearchPalette("home", "m");
    render(SearchPalette);

    await screen.findByRole("dialog");
    screen.getAllByRole("button", { name: /close/i }).at(-1)!.focus();
    store.navPage = "library";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => expect(store.searchOpen).toBe(false));
    expect(document.activeElement).not.toBe(origin);

    store.navPage = "home";
    origin.focus();
    store.openSearchPalette("home", "m");
    await screen.findByRole("dialog");
    origin.remove();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => expect(store.searchOpen).toBe(false));
    expect(document.activeElement).not.toBe(origin);
  });

  test("recomputes results when reopening the same query", async () => {
    const origin = originInput();
    store.openSearchPalette("library", "moon");
    render(SearchPalette);

    expect(await screen.findByText("Moon Reader")).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => {
      expect(store.searchOpen).toBe(false);
      expect(document.activeElement).toBe(origin);
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(store.isSearchFocusRestoreInProgress).toBe(false);

    store.openSearchPalette("library", "moon");
    expect(store.searchOpen).toBe(true);
    await screen.findByRole("dialog");
    expect(await screen.findByText("Moon Reader")).toBeTruthy();
  });

  test("keeps Arrow navigation visible using only the internal result containers", async () => {
    originInput();
    store.openSearchPalette("home", "a");
    render(SearchPalette);

    await waitFor(() => {
      expect(screen.getAllByRole("option").filter((option) => option.classList.contains("is-work-card")).length).toBeGreaterThanOrEqual(2);
    });
    const options = screen.getAllByRole("option");
    const workOptions = options.filter((option) => option.classList.contains("is-work-card"));
    const results = screen.getByRole("listbox");
    const first = workOptions[0] as HTMLElement;
    const second = workOptions[1] as HTMLElement;
    const secondGroup = second.parentElement as HTMLElement;
    const initialSelection = options.find((option) => option.getAttribute("aria-selected") === "true");

    expect(initialSelection).toBeTruthy();
    expect(initialSelection?.classList.contains("is-active")).toBe(false);

    Object.defineProperty(results, "scrollTop", { value: 0, writable: true });
    Object.defineProperty(secondGroup, "scrollLeft", { value: 0, writable: true });
    Object.defineProperty(document.documentElement, "scrollTop", { value: 19, writable: true });
    results.getBoundingClientRect = () => rect(100, 100, 700, 300);
    secondGroup.getBoundingClientRect = () => rect(100, 100, 700, 300);
    second.getBoundingClientRect = () => rect(750, 320, 850, 380);

    const secondIndex = options.indexOf(second);
    for (let index = 0; index < secondIndex; index += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }

    await waitFor(() => {
      expect(second.getAttribute("aria-selected")).toBe("true");
      expect(second.classList.contains("is-active")).toBe(true);
      expect(secondGroup.scrollLeft).toBe(150);
      expect(results.scrollTop).toBe(80);
    });
    expect(document.documentElement.scrollTop).toBe(19);

    first.getBoundingClientRect = () => rect(140, 140, 240, 240);
    const firstGroup = first.parentElement as HTMLElement;
    Object.defineProperty(firstGroup, "scrollLeft", { value: 23, writable: true });
    firstGroup.getBoundingClientRect = () => rect(100, 100, 700, 300);
    results.scrollTop = 31;

    const firstIndex = options.indexOf(first);
    for (let index = 0; index < secondIndex - firstIndex; index += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    }

    await waitFor(() => {
      expect(first.getAttribute("aria-selected")).toBe("true");
      expect(firstGroup.scrollLeft).toBe(23);
      expect(results.scrollTop).toBe(31);
    });
    expect(document.documentElement.scrollTop).toBe(19);
  });

  test("keeps the implicit first result available to Enter without an initial visual highlight", async () => {
    originInput();
    store.openSearchPalette("library", "moon");
    render(SearchPalette);

    const first = await screen.findByRole("option", { name: /Moon Reader/i });
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(first.classList.contains("is-active")).toBe(false);
    const metadata = first.querySelectorAll(".search-palette__result-work-meta span");
    expect([...metadata].map((entry) => entry.textContent)).toEqual(["Source", "Unknown"]);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitFor(() => {
      expect(store.activeManga?.id).toBe(17);
      expect(store.searchOpen).toBe(false);
    });
  });

  test("opens current Comic and Book details without reopening the palette", async () => {
    const origin = originInput();
    store.openSearchPalette("library", "moon");
    render(SearchPalette);

    const comicOption = await screen.findByRole("option", { name: /Moon Reader/i });
    comicOption.focus();
    await fireEvent.click(comicOption);
    expect(store.activeManga?.id).toBe(17);
    expect(store.searchOpen).toBe(false);
    expect(document.activeElement).not.toBe(origin);

    store.librarySection = "books";
    store.openSearchPalette("library", "index");
    await fireEvent.click(await screen.findByRole("option", { name: /Index Book/i }));
    expect(store.activeBookId).toBe("book-index");
    expect(store.librarySection).toBe("books");
    expect(store.navPage).toBe("library");
    expect(store.searchOpen).toBe(false);
  });

  test("opens a persisted source novel in the current NovelDetail", async () => {
    originInput();
    store.librarySection = "books";
    store.searchNovelLibraryEntries = [{
      id: "novel:illusia:/lord",
      title: "Lorde dos Mistérios",
      author: "Cuttlefish",
      description: null,
      coverUrl: null,
      path: "/lord",
      status: "ONGOING",
      tags: ["Mystery"],
      source: {
        repositoryUrl: null,
        pluginId: "illusia",
        sourceId: "illusia",
        sourceName: "Illusia",
      },
      chapterCount: 1,
      addedAt: 1,
      updatedAt: 1,
    }];
    store.searchNovelLibraryChapters = [{
      id: "novel:illusia:/lord:chapter-1",
      novelId: "novel:illusia:/lord",
      path: "/lord/1",
      title: "Chapter 1",
      order: 1,
      releaseTime: null,
      unread: true,
    }];
    store.openSearchPalette("library", "lorde");
    render(SearchPalette);

    await fireEvent.click(await screen.findByRole("option", { name: /Lorde dos Mistérios/i }));
    expect(store.activeNovelDetail?.novel.title).toBe("Lorde dos Mistérios");
    expect(store.activeNovelDetail?.inLibrary).toBe(true);
    expect(store.searchOpen).toBe(false);
  });

  test("offers Browse as an explicit scope expansion with and without local results", async () => {
    originInput();
    store.openSearchPalette("home", "moon");
    render(SearchPalette);

    expect(await screen.findByRole("option", { name: /Moon Reader/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Search in Browse/i })).toBeTruthy();

    store.openSearchPalette("home", "zzzz-no-local-match");
    await waitFor(() => {
      expect(screen.queryByRole("option", { name: /Moon Reader/i })).toBeNull();
      expect(screen.getByRole("option", { name: /Search in Browse/i })).toBeTruthy();
    });
  });

  test("opens Browse as an in-modal subview and preserves the exact query by mouse", async () => {
    originInput();
    store.openSearchPalette("home", "  葬送のフリーレン  ");
    render(SearchPalette);

    expect(listSourcesMock).not.toHaveBeenCalled();
    expect(mangaSourceSearchMock).not.toHaveBeenCalled();
    await fireEvent.click(await screen.findByRole("option", { name: /Search in Browse/i }));

    await waitFor(() => {
      expect(screen.getByText("Browse Search")).toBeTruthy();
      expect(screen.getByRole("button", { name: /Back to global search/i })).toBeTruthy();
      expect(screen.getAllByText("Source A").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Remote Alpha")).toBeTruthy();
      expect(mangaSourceSearchMock).toHaveBeenCalledWith(expect.objectContaining({
        sourceId: "source-a",
        query: "葬送のフリーレン",
      }));
      expect(store.navPage).toBe("home");
      expect(store.searchOpen).toBe(true);
    });

    await fireEvent.click(screen.getByRole("option", { name: /Remote Alpha/i }));
    expect(store.activeManga?.id).toBe(101);
    expect(store.searchOpen).toBe(false);
  });

  test("activates the Books Browse subview with Enter without leaving the modal", async () => {
    originInput();
    store.librarySection = "books";
    store.openSearchPalette("home", "별을 품은 소설");
    render(SearchPalette);

    await screen.findByRole("option", { name: /Search in Browse/i });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await waitFor(() => {
      expect(screen.getByText("Browse Search")).toBeTruthy();
      expect(screen.getAllByText("Novel Source").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Remote Novel")).toBeTruthy();
      expect(novelSourceSearchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: store.runtimeResolvedLocalProfileId,
          serverUrl: store.runtimeServerUrl,
        }),
        "novel-source",
        "별을 품은 소설",
        1,
      );
      expect(store.navPage).toBe("home");
      expect(store.searchOpen).toBe(true);
    });

    await fireEvent.click(screen.getByRole("option", { name: /Remote Novel/i }));
    await waitFor(() => {
      expect(readNovelDetailsMock).toHaveBeenCalledWith(
        expect.any(Object),
        "novel-source",
        "/remote-novel",
        {
          title: "Remote Novel",
          coverUrl: null,
        },
      );
      expect(store.activeNovelDetail?.novel.sourceId).toBe("novel-source");
      expect(store.searchOpen).toBe(false);
    });
  });

  test("does not offer the scope expansion while already searching Browse", async () => {
    originInput();
    store.openSearchPalette("browse", "moon", {
      browseContentType: "manga",
      browseSurface: "keyword",
    });
    render(SearchPalette);

    await screen.findByRole("dialog");
    expect(screen.queryByRole("option", { name: /Search in Browse/i })).toBeNull();
    expect(await screen.findByText("Browse Search")).toBeTruthy();
  });

  test("returns from the Browse subview to preserved global results", async () => {
    const origin = originInput();
    store.openSearchPalette("home", "moon");
    render(SearchPalette);

    expect(await screen.findByRole("option", { name: /Moon Reader/i })).toBeTruthy();
    await fireEvent.click(screen.getByRole("option", { name: /Search in Browse/i }));
    await screen.findByText("Remote Alpha");
    await fireEvent.click(screen.getByRole("button", { name: /Back to global search/i }));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Moon Reader/i })).toBeTruthy();
      expect(screen.getByRole("option", { name: /Search in Browse/i })).toBeTruthy();
      expect(screen.queryByText("Browse Search")).toBeNull();
      expect(store.searchQuery).toBe("moon");
      expect(store.searchOpen).toBe(true);
      expect(document.activeElement).toBe(origin);
    });
  });
});
