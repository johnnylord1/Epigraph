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
});
