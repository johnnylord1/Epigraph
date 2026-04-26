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

    expect(invokeMock).toHaveBeenCalledWith("read_book_library_state");
    expect(state.books[0]?.title).toBe("Reader Contract");
    expect(state.booksCategories[0]?.id).toBe("favorites");
    expect(peekBookLibraryState().books[0]?.title).toBe("Reader Contract");
  });

  it("migrates legacy moku-store book state into desktop storage when no file exists yet", async () => {
    const legacy = createState();
    localStorage.setItem("moku-store", JSON.stringify({
      books: legacy.books,
      bookProgress: legacy.bookProgress,
      bookBookmarks: legacy.bookBookmarks,
      settings: {
        booksCategories: legacy.booksCategories,
        booksCategoryAssignments: legacy.booksCategoryAssignments,
        booksLibraryUi: legacy.booksLibraryUi,
      },
      navPage: "home",
    }));

    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/aethon/books/library-state.json");

    const state = await loadBookLibraryState();

    expect(state.books[0]?.title).toBe("Reader Contract");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "read_book_library_state");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "write_book_library_state", expect.objectContaining({
      contents: expect.stringContaining("\"title\": \"Reader Contract\""),
    }));
    const migratedStore = JSON.parse(localStorage.getItem("moku-store") ?? "{}");
    expect(migratedStore).not.toHaveProperty("books");
    expect(migratedStore).toHaveProperty("navPage", "home");
    expect(migratedStore.settings ?? {}).not.toHaveProperty("booksCategories");
    expect(migratedStore.settings ?? {}).not.toHaveProperty("booksCategoryAssignments");
    expect(migratedStore.settings ?? {}).not.toHaveProperty("booksLibraryUi");
  });

  it("persists updated book state to desktop storage", async () => {
    invokeMock.mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/aethon/books/library-state.json");

    const state = await saveBookLibraryState(createState());

    expect(state.books).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("write_book_library_state", expect.objectContaining({
      contents: expect.stringContaining("\"bookId\": \"epub-demo\""),
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
    expect(invokeMock).toHaveBeenNthCalledWith(1, "read_book_library_state");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "read_book_library_state");
  });
});
