import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  loadBookLibraryState,
  loadBookLibraryStateForRestore,
  peekBookLibraryState,
  reloadBookLibraryState,
  resetBookLibraryStateCacheForTests,
  saveBookLibraryState,
  type PersistedBookLibraryState,
} from "./libraryState";

function createState(): PersistedBookLibraryState {
  return {
    version: 1,
    books: [{
      id: "epub-demo",
      mimeType: "application/epub+zip",
      byteSize: 1234,
      title: "Reader Contract",
      author: "Epigraph",
      description: null,
      coverPath: "C:/Users/jhow-/AppData/Roaming/epigraph/books/covers/reader-contract.jpg",
      coverUrl: undefined,
      subtype: "epub",
      pageCount: null,
      createdAt: 1,
      updatedAt: 2,
      importPath: "D:/Books/reader-contract.epub",
      assetPath: "C:/Users/jhow-/AppData/Roaming/epigraph/books/epubs/reader-contract.epub",
      tocCount: 2,
      spineCount: 2,
      sectionsSummary: [],
      sectionCount: 0,
    }],
    bookProgress: [{
      bookId: "epub-demo",
      location: "epubcfi(/6/2)",
      href: "chapter-1.xhtml",
      progressPercent: 0.4,
      lastReadAt: 10,
      renderer: "epub",
    }],
    bookBookmarks: [{
      bookId: "epub-demo",
      bookmarkId: "bookmark-1",
      location: "epubcfi(/6/2)",
      href: "chapter-1.xhtml",
      pageIndex: null,
      progressPercent: 0.4,
      label: "Chapter 1",
      note: "Remember this",
      createdAtMs: 8,
      updatedAtMs: 9,
      savedAt: 10,
    }],
    booksCategories: [{
      id: "favorites",
      name: "Favorites",
      order: 1,
    }],
    booksCategoryAssignments: {
      "epub-demo": ["favorites"],
    },
    booksLibraryUi: {
      activeCategoryId: "favorites",
      typeFilter: "epub",
      statusFilter: "in_progress",
      search: "reader",
      sortMode: "recentlyRead",
      sortDir: "asc",
    },
    updatedAtMs: 10,
  };
}

describe("book library state storage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetBookLibraryStateCacheForTests();
    const memoryStorage = (() => {
      const data = new Map<string, string>();
      return {
        getItem: vi.fn((key: string) => data.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          data.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          data.delete(key);
        }),
      };
    })();

    Object.defineProperty(globalThis, "window", {
      value: {
        localStorage: memoryStorage,
        __TAURI_INTERNALS__: {},
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: memoryStorage,
      configurable: true,
      writable: true,
    });
  });

  it("restore bypasses cached fallback and refuses corrupt destination evidence", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(createState()));
    await loadBookLibraryState({ profileId: "test" });
    invokeMock.mockResolvedValueOnce("{broken");
    await expect(loadBookLibraryStateForRestore({ profileId: "test" })).rejects.toThrow("RESTORE_BOOKS_DESTINATION_CORRUPT");
    expect((await loadBookLibraryState({ profileId: "test" })).books).toHaveLength(1);
  });

  it("restore propagates unreadable destination and distinguishes an absent file", async () => {
    invokeMock.mockRejectedValueOnce(Error("access denied"));
    await expect(loadBookLibraryStateForRestore()).rejects.toThrow("access denied");
    invokeMock.mockResolvedValueOnce(null);
    expect((await loadBookLibraryStateForRestore()).books).toEqual([]);
  });

  it("loads persisted desktop book state from the books root file", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(createState()));

    const state = await loadBookLibraryState();

    expect(invokeMock).toHaveBeenCalledWith("read_book_library_state", { profileId: "main" });
    expect(state.books[0]?.title).toBe("Reader Contract");
    expect(state.booksCategories[0]?.id).toBe("favorites");
    expect(peekBookLibraryState().books[0]?.title).toBe("Reader Contract");
  });

  it("normalizes optional Hardcover links for imported books", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      ...createState(),
      books: createState().books.map((book) => ({
        ...book,
        hardcoverBookId: 456.9,
        hardcoverCoverUrl: "https://assets.hardcover.app/covers/book.jpg",
      })),
    }));

    const state = await loadBookLibraryState();

    expect(state.books[0]?.hardcoverBookId).toBe(456);
    expect(state.books[0]?.hardcoverCoverUrl).toBe("https://assets.hardcover.app/covers/book.jpg");
  });

  it("keeps the synced cover fields the backend owns", async () => {
    const coverAssetSha256 = "b8".repeat(32);
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      ...createState(),
      books: createState().books.map((book) => ({
        ...book,
        hasCover: true,
        coverAssetSha256,
        coverAssetByteSize: 4096,
        coverAssetMimeType: "image/jpeg",
      })),
    }));

    const state = await loadBookLibraryState();

    expect(state.books[0]).toMatchObject({
      mimeType: "application/epub+zip",
      byteSize: 1234,
      hasCover: true,
      coverAssetSha256,
      coverAssetByteSize: 4096,
      coverAssetMimeType: "image/jpeg",
    });
    expect(state.bookBookmarks[0]).toMatchObject({
      bookmarkId: "bookmark-1",
      note: "Remember this",
      createdAtMs: 8,
      updatedAtMs: 9,
    });
  });

  it("starts with empty book state when no desktop state exists", async () => {
    invokeMock.mockResolvedValueOnce(null);

    const state = await loadBookLibraryState();

    expect(invokeMock).toHaveBeenCalledWith("read_book_library_state", { profileId: "main" });
    expect(state.books).toHaveLength(0);
    expect(state.bookProgress).toHaveLength(0);
    expect(state.bookBookmarks).toHaveLength(0);
  });

  it("persists updated book state to desktop storage", async () => {
    invokeMock.mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/epigraph/books/library-state.json");

    const nextState = {
      ...createState(),
      books: createState().books.map((book) => ({
        ...book,
        hardcoverBookId: 456,
        hardcoverCoverUrl: "https://assets.hardcover.app/covers/book.jpg",
      })),
    };
    const state = await saveBookLibraryState(nextState);

    expect(state.books).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("write_book_library_state", expect.objectContaining({
      contents: expect.stringContaining("\"bookId\": \"epub-demo\""),
      profileId: "main",
    }));
    expect(invokeMock).toHaveBeenCalledWith("write_book_library_state", expect.objectContaining({
      contents: expect.stringContaining("\"hardcoverBookId\": 456"),
      profileId: "main",
    }));
    expect(invokeMock).toHaveBeenCalledWith("write_book_library_state", expect.objectContaining({
      contents: expect.stringContaining("\"bookmarkId\": \"bookmark-1\""),
      profileId: "main",
    }));
  });

  it("reloads desktop book state even when the cache is already populated", async () => {
    const initial = createState();
    const updated = {
      ...createState(),
      books: createState().books.map((book) => ({ ...book, title: "Updated Reader Contract" })),
      bookProgress: createState().bookProgress.map((entry) => ({ ...entry, progressPercent: 0.8 })),
      updatedAtMs: 20,
    };

    invokeMock.mockResolvedValueOnce(JSON.stringify(initial));
    const cached = await loadBookLibraryState();
    expect(cached.books[0]?.title).toBe("Reader Contract");

    invokeMock.mockResolvedValueOnce(JSON.stringify(updated));
    const reloaded = await reloadBookLibraryState();

    expect(reloaded.books[0]?.title).toBe("Updated Reader Contract");
    expect(reloaded.bookProgress[0]?.progressPercent).toBe(0.8);
    expect(peekBookLibraryState().books[0]?.title).toBe("Updated Reader Contract");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "read_book_library_state", { profileId: "main" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "read_book_library_state", { profileId: "main" });
  });

  it("keeps desktop book state caches isolated per profile", async () => {
    const main = createState();
    const test = {
      ...createState(),
      books: createState().books.map((book) => ({ ...book, id: "test-book", title: "Test Profile Book" })),
      bookProgress: [],
      updatedAtMs: 30,
    };

    invokeMock
      .mockResolvedValueOnce(JSON.stringify(main))
      .mockResolvedValueOnce(JSON.stringify(test));

    const mainState = await loadBookLibraryState({ profileId: "main" });
    const testState = await loadBookLibraryState({ profileId: "test" });

    expect(mainState.books[0]?.title).toBe("Reader Contract");
    expect(testState.books[0]?.title).toBe("Test Profile Book");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "read_book_library_state", { profileId: "main" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "read_book_library_state", { profileId: "test" });
  });
});


describe("B4 strict synchronization refresh", () => {
  it("refuses read failures and corrupt state instead of acknowledging an empty library", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    invokeMock.mockReset();
    invokeMock.mockRejectedValueOnce(Error("read failed"));
    await expect(reloadBookLibraryState({ profileId: "test" }, { strict: true })).rejects.toThrow("read failed");
    invokeMock.mockResolvedValueOnce("{broken");
    await expect(reloadBookLibraryState({ profileId: "test" }, { strict: true })).rejects.toThrow();
  });
  it("hydrates the domain cache after a successful empty remote read", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    invokeMock.mockReset().mockResolvedValue(null);
    const value = await reloadBookLibraryState({ profileId: "test" }, { strict: true });
    expect(await loadBookLibraryState({ profileId: "test" })).toEqual(value);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("records __diskRevision from read_book_library_state, passes expectedRevision on write, and strips __diskRevision from saved contents", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    const payload = { ...createState(), __diskRevision: 7 };
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(JSON.stringify(payload));
    invokeMock.mockResolvedValueOnce("ok");

    const loaded = await reloadBookLibraryState({ profileId: "rev-test" });
    await saveBookLibraryState(loaded, { profileId: "rev-test" });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "read_book_library_state", { profileId: "rev-test" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "write_book_library_state", expect.objectContaining({
      profileId: "rev-test",
      expectedRevision: 7,
    }));
    const savedContents = JSON.parse(invokeMock.mock.calls[1][1].contents);
    expect(savedContents.__diskRevision).toBeUndefined();
  });
});
