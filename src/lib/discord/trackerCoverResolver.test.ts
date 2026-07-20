import { afterEach, describe, expect, test, vi } from "vitest";
import { createEmptyHardcoverState, saveHardcoverState } from "../novels/hardcover";
import type { DiscordCoverCacheStorage } from "./discordCoverService";
import {
  createHardcoverBookDiscordTrackerKey,
  extractBangumiSubjectId,
  extractKitsuMangaId,
  extractMangaUpdatesSeriesId,
  inferAniListMangaId,
  inferMangaTrackerCoverProvider,
  inferMyAnimeListMangaId,
  resolveHardcoverBookDiscordCover,
  resolveHardcoverNovelDiscordCover,
} from "./trackerCoverResolver";

function createMemoryStorage() {
  const data = new Map<string, string>();
  const storage: DiscordCoverCacheStorage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
  return storage;
}

describe("Discord tracker cover resolver", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("infers manga tracker ids from remoteUrl or remoteId", () => {
    expect(inferAniListMangaId({
      trackerId: 2,
      remoteId: "999",
      remoteUrl: "https://anilist.co/manga/123/title",
    })).toBe(123);
    expect(inferAniListMangaId({
      trackerId: 2,
      remoteId: "999",
      remoteUrl: null,
    })).toBe(999);
    expect(inferMyAnimeListMangaId({
      trackerId: 1,
      remoteId: "456",
      remoteUrl: null,
    })).toBe(456);
    expect(inferMyAnimeListMangaId({
      trackerId: 2,
      remoteId: "456",
      remoteUrl: null,
    })).toBeNull();
  });

  test("infers manga tracker providers from url, metadata, or known tracker id", () => {
    expect(inferMangaTrackerCoverProvider({
      trackerId: 999,
      remoteUrl: "https://kitsu.io/manga/123",
    })).toBe("kitsu");
    expect(inferMangaTrackerCoverProvider({
      trackerId: 999,
      remoteUrl: null,
      tracker: { id: 999, name: "Bangumi", icon: "" },
    })).toBe("bangumi");
    expect(inferMangaTrackerCoverProvider({
      trackerId: 7,
      remoteUrl: null,
    })).toBe("mangaupdates");
    expect(inferMangaTrackerCoverProvider({
      trackerId: 999,
      remoteUrl: null,
      tracker: { id: 999, name: "Unknown", icon: "" },
    })).toBeNull();
  });

  test("extracts tracker ids for supported manga cover providers", () => {
    expect(extractKitsuMangaId("https://kitsu.io/manga/42")).toBe(42);
    expect(extractKitsuMangaId("https://kitsu.app/manga/42")).toBe(42);
    expect(extractBangumiSubjectId("https://bgm.tv/subject/1234")).toBe(1234);
    expect(extractBangumiSubjectId("https://bangumi.tv/subject/1234")).toBe(1234);
    expect(extractBangumiSubjectId("https://chii.in/subject/1234")).toBe(1234);
    expect(extractMangaUpdatesSeriesId("https://www.mangaupdates.com/series/15090100540/title")).toBe(15090100540);
    expect(extractMangaUpdatesSeriesId("https://www.mangaupdates.com/series/6xk983g/title")).toBeNull();
  });

  test("resolves a novel cover from the local Hardcover record", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const scopeInput = { profileId: "main", serverUrl: "https://suwayomi.example" };
    const state = createEmptyHardcoverState(scopeInput);
    saveHardcoverState({
      ...state,
      records: [{
        bookId: 123,
        title: "Tracked Novel",
        authors: [],
        genres: [],
        tags: [],
        moods: [],
        coverUrl: "https://assets.hardcover.app/covers/tracked.jpg",
        status: "Reading",
        workStatus: null,
        rating: null,
        progress: null,
        remoteUrl: "https://hardcover.app/books/123",
        updatedAt: Date.now(),
        sourceNovelId: "novel-1",
        sourceTitleKey: "tracked novel",
      }],
    }, scopeInput);

    expect(resolveHardcoverNovelDiscordCover({
      novelId: "novel-1",
      title: "Tracked Novel",
      scopeInput,
    })).toBe("https://assets.hardcover.app/covers/tracked.jpg");
  });

  test("rejects non-public Hardcover covers", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const scopeInput = { profileId: "main", serverUrl: "https://suwayomi.example" };
    const state = createEmptyHardcoverState(scopeInput);
    saveHardcoverState({
      ...state,
      records: [{
        bookId: 123,
        title: "Tracked Novel",
        authors: [],
        genres: [],
        tags: [],
        moods: [],
        coverUrl: "http://localhost/private.jpg",
        status: "Reading",
        workStatus: null,
        rating: null,
        progress: null,
        remoteUrl: "https://hardcover.app/books/123",
        updatedAt: Date.now(),
        sourceNovelId: "novel-1",
        sourceTitleKey: "tracked novel",
      }],
    }, scopeInput);

    expect(resolveHardcoverNovelDiscordCover({
      novelId: "novel-1",
      title: "Tracked Novel",
      scopeInput,
    })).toBeNull();
  });

  test("resolves an imported book cover from its explicit Hardcover cover link", () => {
    expect(resolveHardcoverBookDiscordCover({
      book: {
        id: "book-1",
        hardcoverBookId: 123,
        hardcoverCoverUrl: "https://covers.openlibrary.org/b/id/123-L.jpg?default=false",
      },
    })).toBe("https://covers.openlibrary.org/b/id/123-L.jpg?default=false");
  });

  test("resolves an imported book cover from the existing tracker UI link", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const scopeInput = { profileId: "main", serverUrl: "https://suwayomi.example" };
    const state = createEmptyHardcoverState(scopeInput);
    saveHardcoverState({
      ...state,
      records: [{
        bookId: 987,
        title: "Imported Book",
        authors: [],
        genres: [],
        tags: [],
        moods: [],
        coverUrl: "https://assets.hardcover.app/covers/imported.jpg",
        status: "Reading",
        workStatus: null,
        rating: null,
        progress: null,
        remoteUrl: "https://hardcover.app/books/987",
        updatedAt: Date.now(),
        sourceNovelId: "book-1",
        sourceTitleKey: "imported book",
      }],
    }, scopeInput);

    expect(resolveHardcoverBookDiscordCover({
      book: {
        id: "book-1",
        hardcoverBookId: null,
        hardcoverCoverUrl: null,
      },
      scopeInput,
    })).toBe("https://assets.hardcover.app/covers/imported.jpg");
  });

  test("changes imported book tracker key when the existing UI link is created", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const scopeInput = { profileId: "main", serverUrl: "https://suwayomi.example" };
    const book = {
      id: "book-1",
      hardcoverBookId: null,
      hardcoverCoverUrl: null,
    };
    const before = createHardcoverBookDiscordTrackerKey({ book, scopeInput });
    const state = createEmptyHardcoverState(scopeInput);
    saveHardcoverState({
      ...state,
      records: [{
        bookId: 987,
        title: "Imported Book",
        authors: [],
        genres: [],
        tags: [],
        moods: [],
        coverUrl: "https://assets.hardcover.app/covers/imported.jpg",
        status: "Reading",
        workStatus: null,
        rating: null,
        progress: null,
        remoteUrl: "https://hardcover.app/books/987",
        updatedAt: 123_456,
        sourceNovelId: "book-1",
        sourceTitleKey: "imported book",
      }],
    }, scopeInput);
    const after = createHardcoverBookDiscordTrackerKey({ book, scopeInput });

    expect(after).not.toBe(before);
    expect(after).toContain("987");
    expect(after).toContain("imported.jpg");
  });

  test("resolves an imported book cover from cached Hardcover state by persisted linked id", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const scopeInput = { profileId: "main", serverUrl: "https://suwayomi.example" };
    const state = createEmptyHardcoverState(scopeInput);
    saveHardcoverState({
      ...state,
      records: [{
        bookId: 987,
        title: "Imported Book",
        authors: [],
        genres: [],
        tags: [],
        moods: [],
        coverUrl: "https://assets.hardcover.app/covers/imported.jpg",
        status: "Reading",
        workStatus: null,
        rating: null,
        progress: null,
        remoteUrl: "https://hardcover.app/books/987",
        updatedAt: Date.now(),
        sourceNovelId: null,
        sourceTitleKey: "imported book",
      }],
    }, scopeInput);

    expect(resolveHardcoverBookDiscordCover({
      book: {
        id: "book-1",
        hardcoverBookId: 987,
        hardcoverCoverUrl: null,
      },
      scopeInput,
    })).toBe("https://assets.hardcover.app/covers/imported.jpg");
  });

  test("falls back to the main local Hardcover scope for imported books", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const mainScope = { profileId: "main", serverUrl: "http://127.0.0.1:4567" };
    const state = createEmptyHardcoverState(mainScope);
    saveHardcoverState({
      ...state,
      records: [{
        bookId: 1451556,
        title: "Book of the Dead: Awakening",
        authors: [],
        genres: [],
        tags: [],
        moods: [],
        coverUrl: "https://assets.hardcover.app/covers/book-of-the-dead.jpg",
        status: "Reading",
        workStatus: null,
        rating: null,
        progress: null,
        remoteUrl: "https://hardcover.app/books/1451556",
        updatedAt: 123_456,
        sourceNovelId: "book-of-the-dead-local",
        sourceTitleKey: "book of the dead",
      }],
    }, mainScope);

    const staleLoopbackScope = { profileId: null, serverUrl: "http://127.0.0.1:4667" };
    expect(resolveHardcoverBookDiscordCover({
      book: {
        id: "book-of-the-dead-local",
        hardcoverBookId: null,
        hardcoverCoverUrl: null,
      },
      scopeInput: staleLoopbackScope,
    })).toBe("https://assets.hardcover.app/covers/book-of-the-dead.jpg");

    expect(createHardcoverBookDiscordTrackerKey({
      book: {
        id: "book-of-the-dead-local",
        hardcoverBookId: null,
        hardcoverCoverUrl: null,
      },
      scopeInput: staleLoopbackScope,
    })).toContain("main:http://127.0.0.1:4567");
  });

  test("does not guess imported book covers without an explicit Hardcover link", () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const scopeInput = { profileId: "main", serverUrl: "https://suwayomi.example" };
    const state = createEmptyHardcoverState(scopeInput);
    saveHardcoverState({
      ...state,
      records: [{
        bookId: 987,
        title: "Imported Book",
        authors: [],
        genres: [],
        tags: [],
        moods: [],
        coverUrl: "https://assets.hardcover.app/covers/imported.jpg",
        status: "Reading",
        workStatus: null,
        rating: null,
        progress: null,
        remoteUrl: "https://hardcover.app/books/987",
        updatedAt: Date.now(),
        sourceNovelId: null,
        sourceTitleKey: "imported book",
      }],
    }, scopeInput);

    expect(resolveHardcoverBookDiscordCover({
      book: {
        id: "book-1",
        hardcoverBookId: null,
        hardcoverCoverUrl: null,
      },
      scopeInput,
    })).toBeNull();
  });
});
