import { describe, expect, test, vi } from "vitest";
import { translate } from "../i18n/runtime";
import { createBrowseNovelRemoteProvider, createBrowseRemoteProvider, createCatalogProvider } from "./providers";
import { SETTINGS_SEARCH_CATALOG } from "./settingsCatalog";

const manga = {
  id: 7,
  title: "The Moon Reader",
  author: "Aethon Press",
  thumbnailUrl: null,
  sourceId: "source-1",
  source: { id: "source-1", displayName: "Local source" },
  genre: ["Fantasy"],
  status: "ONGOING",
  unreadCount: 2,
  chapterCount: 12,
} as never;

describe("search catalog providers", () => {
  test("keeps contextual results isolated", async () => {
    const provider = createCatalogProvider({
      libraryManga: [manga],
      settings: [{
        id: "settings-appearance",
        tab: "appearance",
        group: "app",
        groupLabel: "App",
        title: "Appearance",
        description: "Themes and motion",
      }],
      downloads: [{
        chapterId: 3,
        mangaTitle: "Downloaded title",
        chapterName: "Chapter 3",
        progress: 0.5,
        status: "paused",
      }],
    });

    expect((await provider.search({ context: "library", query: "moon", signal: new AbortController().signal })).map((entry) => entry.type)).toEqual(["comic"]);
    expect((await provider.search({ context: "settings", query: "theme", signal: new AbortController().signal })).map((entry) => entry.type)).toEqual(["setting"]);
    expect((await provider.search({ context: "downloads", query: "downloaded", signal: new AbortController().signal })).map((entry) => entry.type)).toEqual(["download"]);
  });

  test("exposes Library-style source and status metadata for work cards", async () => {
    const provider = createCatalogProvider({
      libraryManga: [manga],
      books: [{
        id: "book-1",
        title: "Local PDF",
        author: null,
        description: null,
        coverPath: null,
        subtype: "pdf",
        createdAt: 1,
        updatedAt: 1,
        importPath: "C:\\books\\local.pdf",
        assetPath: "C:\\books\\local.pdf",
      }],
      bookProgress: [{
        bookId: "book-1",
        location: null,
        href: null,
        progressPercent: 1,
        lastReadAt: 1,
      }],
    });
    const signal = new AbortController().signal;

    const comicResults = await provider.search({ context: "library", librarySection: "comics", query: "moon", signal });
    expect(comicResults[0]?.metadata).toMatchObject({
      source: "Local source",
      status: translate("library.status.ongoing"),
    });

    const bookResults = await provider.search({ context: "library", librarySection: "books", query: "local", signal });
    expect(bookResults[0]?.metadata).toMatchObject({
      source: "PDF",
      status: translate("library.collections.finished"),
    });
  });

  test("home combines domains without duplicate ids", async () => {
    const provider = createCatalogProvider({
      libraryManga: [manga],
      pages: [{
        id: "page:library",
        title: "Library",
        action: { kind: "navigate", page: "library" },
      }],
    });

    const results = await provider.search({ context: "home", query: "library", signal: new AbortController().signal });
    expect(new Set(results.map((entry) => entry.id)).size).toBe(results.length);
    expect(results.some((entry) => entry.action.kind === "navigate")).toBe(true);
  });

  test("returns a typed collection action only in Home and Library", async () => {
    const provider = createCatalogProvider({
      collections: [{ id: "fantasy", title: "Fantasy", librarySection: "comics" }],
    });
    const signal = new AbortController().signal;

    expect(await provider.search({ context: "library", query: "fantasy", signal })).toMatchObject([
      {
        type: "collection",
        action: { kind: "collection", collectionId: "fantasy", librarySection: "comics" },
      },
    ]);
    expect(await provider.search({
      context: "library",
      librarySection: "books",
      query: "fantasy",
      signal,
    })).toEqual([]);
    expect(await provider.search({ context: "settings", query: "fantasy", signal })).toEqual([]);
  });

  test("maps specialized Settings terms to the intended sections", async () => {
    const provider = createCatalogProvider({
      settings: SETTINGS_SEARCH_CATALOG.map((entry) => ({
        ...entry,
        groupLabel: entry.group,
        title: entry.id,
        description: entry.descriptionKey,
      })),
    });
    const signal = new AbortController().signal;

    const syncd = await provider.search({ context: "settings", query: "syncd", signal });
    expect(syncd.map((entry) => entry.action)).toContainEqual({ kind: "setting", tab: "security" });
    const hardcover = await provider.search({ context: "settings", query: "hardcover", signal });
    expect(hardcover.map((entry) => entry.action)).toContainEqual({ kind: "setting", tab: "tracking" });
    const epub = await provider.search({ context: "settings", query: "epub", signal });
    expect(epub.map((entry) => entry.action)).toContainEqual({ kind: "setting", tab: "reader" });
  });

  test("keeps Browse remote results inside the active content domain", async () => {
    const mangaLoad = vi.fn(async () => [manga]);
    const novelEntry = {
      source: {
        pluginId: "novels",
        name: "Novel source",
        lang: "en",
      },
      novel: {
        sourceId: "novels",
        title: "Index novel",
        path: "/index",
        coverUrl: null,
      },
    } as never;
    const novelLoad = vi.fn(async () => [novelEntry]);
    const mangaProvider = createBrowseRemoteProvider(mangaLoad);
    const novelProvider = createBrowseNovelRemoteProvider(novelLoad);
    const base = {
      context: "browse" as const,
      browseSurface: "keyword" as const,
      query: "index",
      signal: new AbortController().signal,
    };

    expect(await mangaProvider.search({ ...base, browseContentType: "novels" })).toEqual([]);
    expect(await novelProvider.search({ ...base, browseContentType: "manga" })).toEqual([]);
    expect(await novelProvider.search({ ...base, browseContentType: "novels" })).toHaveLength(1);
    expect(mangaLoad).not.toHaveBeenCalled();
    expect(novelLoad).toHaveBeenCalledOnce();
    expect(novelProvider.contexts).toEqual(["browse"]);

    mangaLoad.mockClear();
    novelLoad.mockClear();
    expect(await mangaProvider.search({ ...base, browseContentType: "manga", browseSurface: "browse" })).toEqual([]);
    expect(await novelProvider.search({ ...base, browseContentType: "novels", browseSurface: "sources" })).toEqual([]);
    expect(mangaLoad).not.toHaveBeenCalled();
    expect(novelLoad).not.toHaveBeenCalled();
  });
});
