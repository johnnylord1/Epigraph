import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  loadBookLibraryState,
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
      title: "Reader Contract",
      author: "Aethon",
      description: null,
      coverPath: "C:/Users/jhow-/AppData/Roaming/aethon/books/covers/reader-contract.jpg",
      coverUrl: undefined,
      subtype: "epub",
      pageCount: null,
      createdAt: 1,
      updatedAt: 2,
      importPath: "D:/Books/reader-contract.epub",
      assetPath: "C:/Users/jhow-/AppData/Roaming/aethon/books/epubs/reader-contract.epub",
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
      location: "epubcfi(/6/2)",
      href: "chapter-1.xhtml",
      pageIndex: null,
      progressPercent: 0.4,
      label: "Chapter 1",
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

  it("starts with empty book state when no desktop state exists", async () => {
    invokeMock.mockResolvedValueOnce(null);

    const state = await loadBookLibraryState();

    expect(invokeMock).toHaveBeenCalledWith("read_book_library_state", { profileId: "main" });
    expect(state.books).toHaveLength(0);
    expect(state.bookProgress).toHaveLength(0);
    expect(state.bookBookmarks).toHaveLength(0);
  });

  it("persists updated book state to desktop storage", async () => {
    invokeMock.mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/aethon/books/library-state.json");

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
