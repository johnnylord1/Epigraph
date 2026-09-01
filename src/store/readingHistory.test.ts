import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_READING_STATS, addHistory, store } from "./state.svelte";

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
