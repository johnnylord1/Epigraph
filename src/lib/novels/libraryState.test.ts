import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  createNovelLibraryId,
  type PersistedNovelLibraryState,
} from "./domain";
import {
  getNovelBookmarkEntries,
  getNovelReadStats,
  getNovelResumeChapter,
  loadNovelLibraryState,
  reloadNovelLibraryState,
  loadNovelLibraryStateForRestore,
  markNovelChapterRead,
  parseNovelScrollLocator,
  peekNovelLibraryState,
  resetNovelLibraryStateCacheForTests,
  saveNovelLibraryState,
  toggleNovelChapterBookmark,
  updateNovelReadingProgress,
  upsertNovelInLibrary,
} from "./libraryState";

const SCOPE = { profileId: "test" } as const;
const SCOPE_KEY = "profile:test";

describe("restore destination validation", () => {
  it("distinguishes an absent destination from an existing empty file", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    invokeMock.mockResolvedValueOnce(null);
    expect((await loadNovelLibraryStateForRestore(SCOPE)).entries).toEqual([]);
    invokeMock.mockResolvedValueOnce("");
    await expect(loadNovelLibraryStateForRestore(SCOPE)).rejects.toThrow("RESTORE_DESTINATION_CORRUPT");
  });
  it("preserves malformed destination evidence by refusing instead of returning an empty library", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    invokeMock.mockResolvedValueOnce("{broken");
    await expect(loadNovelLibraryStateForRestore(SCOPE)).rejects.toThrow("RESTORE_DESTINATION_CORRUPT");
  });
  it("rejects incomplete destination snapshots", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    invokeMock.mockResolvedValueOnce(JSON.stringify({ version: 1, entries: [] }));
    await expect(loadNovelLibraryStateForRestore(SCOPE)).rejects.toThrow("RESTORE_DESTINATION_CORRUPT");
  });
});

function createState(): PersistedNovelLibraryState {
  return {
    version: 1,
    scopeKey: SCOPE_KEY,
    entries: [{
      id: createNovelLibraryId("archiveofourown", "/works/1"),
      title: "MANACLED",
      author: "senlinyu",
      description: null,
      coverUrl: null,
      path: "/works/1",
      status: "ONGOING",
      tags: ["drama"],
      source: {
        repositoryUrl: "https://example.com/plugins.min.json",
        repositoryName: "Official",
        pluginId: "archiveofourown",
        pluginName: "Archive Of Our Own",
        pluginVersion: "1.0.0",
        sourceId: "archiveofourown",
        sourceName: "Archive Of Our Own",
        lang: "en",
      },
      chapterCount: 2,
      addedAt: 1,
      updatedAt: 1,
    }],
    chapters: [{
      id: "chapter:1",
      novelId: createNovelLibraryId("archiveofourown", "/works/1"),
      path: "/works/1/chapters/1",
      title: "Chapter 1",
      order: 0,
      releaseTime: null,
      unread: true,
    }],
    progress: [],
    bookmarks: [],
    history: [],
    updatedAtMs: 1,
  };
}

describe("re-adding a novel the source no longer serves", () => {
  it("keeps the saved cover and chapters when the detail has none", () => {
    const saved = createState();
    saved.entries[0].coverUrl = "data:image/png;base64,AA";
    const next = upsertNovelInLibrary(saved, {
      ...saved.entries[0],
      sourceId: "archiveofourown",
      coverUrl: null,
      chapterCount: 0,
      chapters: [],
    });
    expect(next.entries[0]?.coverUrl).toBe("data:image/png;base64,AA");
    expect(next.chapters.map((chapter) => chapter.id)).toEqual(["chapter:1"]);
  });
});

describe("novel library state storage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetNovelLibraryStateCacheForTests();
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
        clear: vi.fn(() => {
          data.clear();
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

  it("loads persisted desktop state from the profile-root file", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(createState()));

    const state = await loadNovelLibraryState(SCOPE);

    expect(invokeMock).toHaveBeenCalledWith("read_novel_library_state", {
      profileId: "test",
      serverUrl: null,
    });
    expect(state.entries[0]?.title).toBe("MANACLED");
    expect(peekNovelLibraryState(SCOPE).entries[0]?.title).toBe("MANACLED");
  });

  it("sanitizes default-cover sentinels from persisted source novels", async () => {
    const persisted = createState();
    persisted.entries[0] = { ...persisted.entries[0]!, coverUrl: "about:blank" };
    invokeMock.mockResolvedValueOnce(JSON.stringify(persisted));

    const state = await loadNovelLibraryState(SCOPE);

    expect(state.entries[0]?.coverUrl).toBeNull();
  });

  it("uses the main local profile for empty desktop scopes", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      ...createState(),
      scopeKey: "profile:main",
    }));

    const state = await loadNovelLibraryState();

    expect(invokeMock).toHaveBeenCalledWith("read_novel_library_state", {
      profileId: "main",
      serverUrl: null,
    });
    expect(state.scopeKey).toBe("profile:main");
  });

  it("migrates legacy localStorage novels state into desktop storage when no file exists yet", async () => {
    const legacy = createState();
    localStorage.setItem("epigraph-novels-library-state", JSON.stringify({
      [SCOPE_KEY]: legacy,
    }));

    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("C:/Profiles/test/novels/library-state.json");

    const state = await loadNovelLibraryState(SCOPE);

    expect(state.entries[0]?.title).toBe("MANACLED");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "read_novel_library_state", {
      profileId: "test",
      serverUrl: null,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "write_novel_library_state", expect.objectContaining({
      profileId: "test",
      serverUrl: null,
      contents: expect.stringContaining("\"title\": \"MANACLED\""),
    }));
    expect(localStorage.getItem("epigraph-novels-library-state")).toBeNull();
  });

  it("persists updated state to desktop storage", async () => {
    invokeMock.mockResolvedValueOnce("C:/Profiles/test/novels/library-state.json");

    const saved = await saveNovelLibraryState(createState(), SCOPE);

    expect(saved.entries).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("write_novel_library_state", expect.objectContaining({
      profileId: "test",
      serverUrl: null,
      contents: expect.stringContaining("\"scopeKey\": \"profile:test\""),
    }));
  });

  it("derives resume, read stats, and bookmark state from persisted novel entries", () => {
    const novelId = createNovelLibraryId("archiveofourown", "/works/1");
    const enriched = {
      ...createState(),
      chapters: [
        {
          id: "chapter:1",
          novelId,
          path: "/works/1/chapters/1",
          title: "Chapter 1",
          order: 0,
          releaseTime: null,
          unread: false,
        },
        {
          id: "chapter:2",
          novelId,
          path: "/works/1/chapters/2",
          title: "Chapter 2",
          order: 1,
          releaseTime: null,
          unread: true,
        },
      ],
      progress: [{
        novelId,
        chapterId: "chapter:2",
        chapterTitle: "Chapter 2",
        progressPercent: 0.5,
        locator: "chapter:2",
        updatedAt: 2,
      }],
      bookmarks: [{
        novelId,
        chapterId: "chapter:2",
        chapterTitle: "Chapter 2",
        locator: "chapter:2",
        label: "Chapter 2",
        savedAt: 2,
      }],
      history: [{
        novelId,
        chapterId: "chapter:2",
        chapterTitle: "Chapter 2",
        locator: "chapter:2",
        readAt: 2,
      }],
    };

    expect(getNovelResumeChapter(enriched, novelId)?.id).toBe("chapter:2");
    expect(getNovelReadStats(enriched, novelId)).toEqual({
      total: 2,
      read: 1,
      unread: 1,
      progressPercent: 0.5,
    });
    expect(getNovelBookmarkEntries(enriched, novelId)).toHaveLength(1);
  });

  it("toggles bookmarks and advances read state for a novel chapter", () => {
    const novelId = createNovelLibraryId("archiveofourown", "/works/1");
    const withBookmark = toggleNovelChapterBookmark(createState(), {
      novelId,
      chapterId: "chapter:1",
      chapterTitle: "Chapter 1",
    });
    expect(withBookmark.bookmarks).toHaveLength(1);

    const withoutBookmark = toggleNovelChapterBookmark(withBookmark, {
      novelId,
      chapterId: "chapter:1",
      chapterTitle: "Chapter 1",
    });
    expect(withoutBookmark.bookmarks).toHaveLength(0);

    const readState = markNovelChapterRead(createState(), {
      novelId,
      chapterId: "chapter:1",
      chapterTitle: "Chapter 1",
    });
    expect(readState.chapters[0]?.unread).toBe(false);
    expect(readState.progress[0]?.progressPercent).toBe(1);
    expect(readState.history[0]?.chapterId).toBe("chapter:1");
  });

  it("tracks partial chapter position without marking the chapter read", () => {
    const novelId = createNovelLibraryId("archiveofourown", "/works/1");
    const state = createState();
    state.chapters = [
      state.chapters[0]!,
      {
        ...state.chapters[0]!,
        id: "chapter:2",
        path: "/works/1/chapters/2",
        title: "Chapter 2",
        order: 1,
      },
    ];

    const partial = updateNovelReadingProgress(state, {
      novelId,
      chapterId: "chapter:1",
      chapterTitle: "Chapter 1",
      chapterProgress: 0.4,
      updatedAt: 10,
    });

    expect(partial.chapters[0]?.unread).toBe(true);
    expect(partial.progress[0]).toMatchObject({
      chapterId: "chapter:1",
      progressPercent: 0.2,
      locator: "scroll:chapter%3A1:0.400000",
      updatedAt: 10,
    });
    expect(partial.history[0]).toMatchObject({ chapterId: "chapter:1", locator: "scroll:chapter%3A1:0.400000" });
  });

  it("marks a novel chapter read at 95 percent and calculates overall position", () => {
    const novelId = createNovelLibraryId("archiveofourown", "/works/1");
    const state = createState();
    state.chapters = [
      state.chapters[0]!,
      {
        ...state.chapters[0]!,
        id: "chapter:2",
        path: "/works/1/chapters/2",
        title: "Chapter 2",
        order: 1,
      },
    ];

    const completed = updateNovelReadingProgress(state, {
      novelId,
      chapterId: "chapter:1",
      chapterTitle: "Chapter 1",
      chapterProgress: 0.95,
      updatedAt: 20,
    });

    expect(completed.chapters[0]?.unread).toBe(false);
    expect(completed.progress[0]?.progressPercent).toBe(0.5);
    expect(parseNovelScrollLocator(completed.progress[0]?.locator, "chapter:1")).toBe(1);

    const nextChapter = updateNovelReadingProgress(completed, {
      novelId,
      chapterId: "chapter:2",
      chapterTitle: "Chapter 2",
      chapterProgress: 0.4,
      updatedAt: 30,
    });
    expect(nextChapter.progress[0]?.progressPercent).toBe(0.7);
  });

  it("accepts legacy chapter-only locators", () => {
    expect(parseNovelScrollLocator("chapter:1", "chapter:1")).toBe(0);
    expect(parseNovelScrollLocator("chapter:2", "chapter:1")).toBeNull();
  });
});


describe("B4 strict synchronization refresh", () => {
  it("refuses read failures and corrupt state instead of acknowledging an empty library", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    invokeMock.mockReset();
    invokeMock.mockRejectedValueOnce(Error("read failed"));
    await expect(reloadNovelLibraryState(SCOPE, { strict: true })).rejects.toThrow("read failed");
    invokeMock.mockResolvedValueOnce("{broken");
    await expect(reloadNovelLibraryState(SCOPE, { strict: true })).rejects.toThrow();
  });
  it("hydrates the domain cache after a successful empty remote read", async () => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    invokeMock.mockReset().mockResolvedValue(null);
    const value = await reloadNovelLibraryState(SCOPE, { strict: true });
    expect(peekNovelLibraryState(SCOPE)).toEqual(value);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
