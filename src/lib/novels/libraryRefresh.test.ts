import { describe, expect, it } from "vitest";

import type { NovelDetailRecord, PersistedNovelLibraryEntry, PersistedNovelLibraryState } from "./domain";
import { createNovelLibraryId } from "./domain";
import {
  groupRefreshedNovelChaptersForNotifications,
  mergeNovelDetailIntoLibraryState,
  shouldRefreshNovelEntry,
} from "./libraryRefresh";

const novelId = createNovelLibraryId("ln-source", "/novel/1");

function source() {
  return {
    repositoryUrl: "https://example.com/plugins.json",
    repositoryName: "Test",
    pluginId: "ln-source",
    pluginName: "LN Source",
    pluginVersion: "1.0.0",
    sourceId: "ln-source",
    sourceName: "LN Source",
    lang: "en",
  };
}

function entry(status = "Ongoing"): PersistedNovelLibraryEntry {
  return {
    id: novelId,
    title: "A Novel",
    author: null,
    description: null,
    coverUrl: "https://example.com/cover.jpg",
    path: "/novel/1",
    status,
    tags: [],
    source: source(),
    chapterCount: 1,
    addedAt: 10,
    updatedAt: 10,
  };
}

function state(): PersistedNovelLibraryState {
  return {
    version: 1,
    scopeKey: "profile:test",
    entries: [entry()],
    chapters: [{
      id: "chapter:old",
      novelId,
      path: "/novel/1/chapter-1",
      title: "Chapter 1",
      order: 0,
      releaseTime: null,
      unread: false,
      updatedAt: null,
    }],
    progress: [{
      novelId,
      chapterId: "chapter:old",
      chapterTitle: "Chapter 1",
      progressPercent: 0.5,
      locator: "chapter:old",
      updatedAt: 20,
    }],
    bookmarks: [],
    history: [],
    updatedAtMs: 10,
  };
}

function detail(): NovelDetailRecord {
  return {
    id: novelId,
    sourceId: "ln-source",
    title: "A Novel",
    path: "/novel/1",
    coverUrl: "https://example.com/cover-2.jpg",
    author: "Author",
    description: "Updated",
    status: "Ongoing",
    tags: ["fantasy"],
    chapterCount: 2,
    source: source(),
    chapters: [
      {
        id: "chapter:new-old-id",
        novelId,
        path: "/novel/1/chapter-1",
        title: "Chapter 1 revised",
        order: 0,
        releaseTime: null,
        unread: true,
      },
      {
        id: "chapter:new",
        novelId,
        path: "/novel/1/chapter-2",
        title: "Chapter 2",
        order: 1,
        releaseTime: 100,
        unread: true,
      },
    ],
  };
}

describe("novel library refresh", () => {
  it("diffs chapters by path and marks only new chapters as updated", () => {
    const merged = mergeNovelDetailIntoLibraryState(state(), entry(), detail(), 1234);

    expect(merged.newChapters).toHaveLength(1);
    expect(merged.newChapters[0]).toMatchObject({
      chapterPath: "/novel/1/chapter-2",
      chapterTitle: "Chapter 2",
      previousChapterCount: 1,
      nextChapterCount: 2,
      createdAt: 1234,
    });
    expect(merged.state.chapters).toEqual([
      expect.objectContaining({
        path: "/novel/1/chapter-1",
        unread: false,
        updatedAt: null,
      }),
      expect.objectContaining({
        path: "/novel/1/chapter-2",
        unread: true,
        updatedAt: 1234,
      }),
    ]);
    expect(merged.state.progress[0]?.novelId).toBe(novelId);

    expect(groupRefreshedNovelChaptersForNotifications(merged.newChapters)).toEqual([{
      novelId,
      novelTitle: "A Novel",
      thumbnailUrl: "https://example.com/cover-2.jpg",
      sourceName: "LN Source",
      chapterTitles: ["Chapter 2"],
      previousChapterCount: 1,
      nextChapterCount: 2,
    }]);
  });

  it("preserves a valid stored cover when a source returns its default-cover sentinel", () => {
    const nextDetail = { ...detail(), coverUrl: "about:blank" };

    const merged = mergeNovelDetailIntoLibraryState(state(), entry(), nextDetail, 1234);

    expect(merged.state.entries[0]?.coverUrl).toBe("https://example.com/cover.jpg");
    expect(merged.newChapters[0]?.coverUrl).toBe("https://example.com/cover.jpg");
  });

  it("filters only ongoing novels when requested", () => {
    expect(shouldRefreshNovelEntry(entry("Ongoing"), { onlyOngoing: true })).toBe(true);
    expect(shouldRefreshNovelEntry(entry("Releasing"), { onlyOngoing: true })).toBe(true);
    expect(shouldRefreshNovelEntry(entry("Completed"), { onlyOngoing: true })).toBe(false);
    expect(shouldRefreshNovelEntry(entry("Unknown"), { onlyOngoing: true })).toBe(false);
    expect(shouldRefreshNovelEntry(entry("Unknown"), { onlyOngoing: false })).toBe(true);
  });

  it("skips novels blocked by folder update rules before category filters", () => {
    expect(shouldRefreshNovelEntry(entry("Ongoing"), {
      categoryNovelIds: [novelId],
      excludedNovelIds: [novelId],
      onlyOngoing: false,
    })).toBe(false);
    expect(shouldRefreshNovelEntry(entry("Ongoing"), {
      categoryNovelIds: [novelId],
      excludedNovelIds: [],
      onlyOngoing: false,
    })).toBe(true);
  });
});
