import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_READING_STATS, addHistory, mergeSyncedHistory, store } from "./state.svelte";

const original = {
  history: store.history,
  readLog: store.readLog,
  readingStats: store.readingStats,
};

describe("reading history completion accounting", () => {
  beforeEach(() => {
    store.history = [];
    store.readLog = [];
    store.readingStats = { ...DEFAULT_READING_STATS };
  });

  afterEach(() => {
    store.history = original.history;
    store.readLog = original.readLog;
    store.readingStats = original.readingStats;
  });

  it("does not double-count the same consecutive chapter completion", () => {
    const entry = {
      mangaId: 4,
      mangaTitle: "A title",
      thumbnailUrl: "",
      chapterId: 12,
      chapterName: "Chapter 12",
      readAt: 1_000,
    };

    addHistory(entry, true, 4);
    addHistory({ ...entry, readAt: 1_500 }, true, 4);

    expect(store.readLog).toEqual([{
      mangaId: 4,
      chapterId: 12,
      readAt: 1_000,
      minutes: 4,
    }]);
    expect(store.readingStats.totalChaptersRead).toBe(1);
    expect(store.readingStats.totalMinutesRead).toBe(4);
  });
});

describe("reads synced from paired devices", () => {
  const entry = (chapterId: number, readAt: number) => ({
    mangaId: 4,
    mangaTitle: "A title",
    thumbnailUrl: "",
    chapterId,
    chapterName: `Chapter ${chapterId}`,
    readAt,
  });

  beforeEach(() => {
    store.history = [];
    store.readLog = [];
    store.historyClearedAt = 0;
  });

  afterEach(() => {
    store.history = original.history;
    store.readLog = original.readLog;
    store.historyClearedAt = 0;
  });

  it("adds newer reads, keeps newer local ones and skips reads cleared on this desktop", () => {
    store.history = [entry(1, 5_000)];
    store.historyClearedAt = 2_000;

    mergeSyncedHistory([entry(1, 4_000), entry(2, 6_000), entry(3, 1_000)]);

    expect(store.history.map((item) => [item.chapterId, item.readAt])).toEqual([[2, 6_000], [1, 5_000]]);
    expect(store.readLog).toEqual([]);
  });
});
