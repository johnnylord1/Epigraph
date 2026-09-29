import { beforeEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  search: vi.fn(),
  getDetails: vi.fn(),
  getChapters: vi.fn(),
  getPages: vi.fn(),
}));

vi.mock("./managed", () => ({
  getManagedSourceRuntime: vi.fn(async () => runtime),
}));

import {
  fetchSourceChapterPages,
  fetchSourceMangaChapters,
  fetchSourceMangaDetails,
  searchSourceManga,
  setChapterPagesRelay,
} from "./sourceOperations";

describe("SourceRuntime source operations", () => {
  beforeEach(() => vi.clearAllMocks());

  test("preserves search pagination and maps source metadata", async () => {
    runtime.search.mockResolvedValue({
      items: [{
        id: 7,
        sourceId: "42",
        title: "Result",
        thumbnailUrl: null,
        inLibrary: false,
        status: "ONGOING",
        source: {
          id: "42",
          name: "Fixture",
          displayName: "Fixture (EN)",
          language: "en",
          iconUrl: null,
          isNsfw: false,
          supportsLatest: true,
          isConfigurable: false,
          extensionPackageName: "fixture.extension",
        },
      }],
      hasNextPage: true,
    });

    const result = await searchSourceManga({
      source: "42",
      type: "SEARCH",
      page: 3,
      query: "result",
    });

    expect(runtime.search).toHaveBeenCalledWith({
      sourceId: "42",
      mode: "SEARCH",
      page: 3,
      query: "result",
      signal: undefined,
    });
    expect(result.fetchSourceManga).toEqual({
      mangas: [expect.objectContaining({
        id: 7,
        thumbnailUrl: "",
        source: expect.objectContaining({ id: "42", lang: "en" }),
      })],
      hasNextPage: true,
    });
  });

  test("maps details, chapters, and ordered pages without raw GraphQL", async () => {
    runtime.getDetails.mockResolvedValue({
      id: 7,
      sourceId: "42",
      title: "Result",
      thumbnailUrl: "cover",
      inLibrary: true,
      status: "ONGOING",
      source: null,
      description: "Description",
      author: "Author",
      artist: null,
      genres: ["Action"],
      realUrl: "/result",
    });
    runtime.getChapters.mockResolvedValue([{ id: 9, mangaId: 7, name: "Chapter 1", chapterNumber: 1, sourceOrder: 1, isRead: false, isDownloaded: false, isBookmarked: false, pageCount: 2, uploadDate: null, realUrl: null, lastPageRead: 0, scanlator: null }]);
    runtime.getPages.mockResolvedValue([{ index: 1, url: "b" }, { index: 0, url: "a" }]);

    const details = await fetchSourceMangaDetails({ id: 7, sourceId: "42" });
    const chapters = await fetchSourceMangaChapters({ mangaId: 7, sourceId: "42" });
    const pages = await fetchSourceChapterPages({ chapterId: 9, mangaId: 7 });

    expect(details.fetchManga.manga).toEqual(expect.objectContaining({ genre: ["Action"] }));
    expect(chapters.fetchChapters.chapters).toEqual([expect.objectContaining({ id: 9, mangaId: 7 })]);
    expect(pages.fetchChapterPages.pages).toEqual(["a", "b"]);
  });

  test("readers opening the same chapter together share one page-list request", async () => {
    let answer!: (pages: { index: number; url: string }[]) => void;
    runtime.getPages.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    runtime.getPages.mockResolvedValue([{ index: 0, url: "later" }]);

    const first = fetchSourceChapterPages({ chapterId: 9 });
    const second = fetchSourceChapterPages({ chapterId: 9 });
    const other = fetchSourceChapterPages({ chapterId: 10 });
    await vi.waitFor(() => expect(runtime.getPages).toHaveBeenCalledTimes(2));
    answer([{ index: 0, url: "a" }]);

    expect((await first).fetchChapterPages.pages).toEqual(["a"]);
    expect((await second).fetchChapterPages.pages).toEqual(["a"]);
    expect((await other).fetchChapterPages.pages).toEqual(["later"]);
    expect(runtime.getPages.mock.calls.map(([target]) => target.id)).toEqual([9, 10]);
    // Once answered, a later open asks again instead of reusing a list the source may since have changed.
    expect((await fetchSourceChapterPages({ chapterId: 9 })).fetchChapterPages.pages).toEqual(["later"]);
    expect(runtime.getPages).toHaveBeenCalledTimes(3);
  });

  test("a detached reader window gets page lists from the main window", async () => {
    const relay = vi.fn(async () => ["x", "y"]);
    setChapterPagesRelay(relay);
    try {
      expect((await fetchSourceChapterPages({ chapterId: 9 })).fetchChapterPages.pages).toEqual(["x", "y"]);
      expect(relay).toHaveBeenCalledWith({ chapterId: 9, mangaId: 0 });
      expect(runtime.getPages).not.toHaveBeenCalled();
      relay.mockResolvedValueOnce([1] as never);
      await expect(fetchSourceChapterPages({ chapterId: 9 })).rejects.toThrow("Chapter pages were not returned.");
    } finally {
      setChapterPagesRelay(null);
    }
  });
});
