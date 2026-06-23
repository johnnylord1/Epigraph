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
  markNovelChapterRead,
  peekNovelLibraryState,
  resetNovelLibraryStateCacheForTests,
  saveNovelLibraryState,
  toggleNovelChapterBookmark,
} from "./libraryState";

const SCOPE = { profileId: "test" } as const;
const SCOPE_KEY = "profile:test";

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
    localStorage.setItem("aethon-novels-library-state", JSON.stringify({
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
    expect(localStorage.getItem("aethon-novels-library-state")).toBeNull();
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
});
