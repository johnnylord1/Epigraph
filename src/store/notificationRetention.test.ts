import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NOTIFICATION_RETENTION,
  addSystemNotification,
  compactUpdateNotifications,
  dismissSystemNotification,
  pruneNotifications,
  recordComicsUpdateNotifications,
  recordLibraryRunResult,
  recordLibraryUpdateIssues,
  store,
} from "./state.svelte";

const original = {
  libraryUpdateNotifications: store.libraryUpdateNotifications,
  libraryUpdateIssues: store.libraryUpdateIssues,
  systemNotifications: store.systemNotifications,
};

const DAY = 24 * 60 * 60 * 1000;

function comicsUpdate(mangaId: number, chapterTitles: string[]) {
  return {
    mangaId,
    mangaTitle: `Title ${mangaId}`,
    thumbnailUrl: "",
    sourceName: "Source",
    chapterTitles,
    previousChapterCount: 10,
    nextChapterCount: 10 + chapterTitles.length,
  };
}

function issue(itemId: string, runId: string) {
  return {
    runId,
    contentKind: "manga" as const,
    title: `Title ${itemId}`,
    itemId,
    sourceId: "1",
    sourceName: "Source",
    extensionName: "Source",
    message: "Timed out",
    errorType: "timeout" as const,
  };
}

describe("activity notification retention", () => {
  beforeEach(() => {
    store.libraryUpdateNotifications = [];
    store.libraryUpdateIssues = [];
    store.systemNotifications = [];
  });

  afterEach(() => {
    store.libraryUpdateNotifications = original.libraryUpdateNotifications;
    store.libraryUpdateIssues = original.libraryUpdateIssues;
    store.systemNotifications = original.systemNotifications;
  });

  it("drops entries past their age and keeps the newest within the cap", () => {
    const now = 100 * DAY;
    const entries = [
      { createdAt: now - 8 * DAY },
      { createdAt: now - DAY },
      { createdAt: now },
    ];
    expect(pruneNotifications(entries, { maxAgeMs: 7 * DAY, max: 1 }, now)).toEqual([{ createdAt: now }]);
    expect(pruneNotifications(entries, { maxAgeMs: 7 * DAY, max: 5 }, now)).toHaveLength(2);
  });

  it("keeps one row per title, folding older runs into the newest", () => {
    const now = Date.now();
    recordComicsUpdateNotifications([comicsUpdate(1, ["Chapter 11"])], now - 2_000);
    recordComicsUpdateNotifications([comicsUpdate(1, ["Chapter 12", "Chapter 13"]), comicsUpdate(2, ["Chapter 5"])], now);

    const rows = store.libraryUpdateNotifications;
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.mangaId === 1)!;
    expect(first.chapterDelta).toBe(3);
    expect(first.chapterTitles).toEqual(["Chapter 12", "Chapter 13", "Chapter 11"]);
    expect(first.createdAt).toBe(now);
  });

  it("drops update rows older than the retention window on compaction", () => {
    const stale = { ...comicsUpdate(3, ["Chapter 1"]), id: "old", kind: "comics" as const, chapterDelta: 1, createdAt: Date.now() - NOTIFICATION_RETENTION.updates.maxAgeMs - DAY };
    expect(compactUpdateNotifications([stale as any])).toEqual([]);
  });

  it("replaces a title's earlier problem and clears it once the title updates", () => {
    const now = Date.now();
    recordLibraryUpdateIssues([issue("1", "run-a"), issue("2", "run-a")], now - 3_000);
    recordLibraryUpdateIssues([issue("1", "run-b")], now - 2_000);
    expect(store.libraryUpdateIssues.map((entry) => `${entry.itemId}:${entry.runId}`).sort()).toEqual(["1:run-b", "2:run-a"]);

    recordComicsUpdateNotifications([comicsUpdate(2, ["Chapter 11"])], now);
    expect(store.libraryUpdateIssues.map((entry) => entry.itemId)).toEqual(["1"]);
  });

  it("keeps only the latest library run summary and removes it after a clean run", () => {
    recordLibraryRunResult("comics", { kind: "info", title: "Comics issues" });
    recordLibraryRunResult("books", { kind: "success", title: "New books chapters" });
    recordLibraryRunResult("comics", { kind: "success", title: "New comics chapters" });
    expect(store.systemNotifications.map((entry) => entry.title).sort()).toEqual(["New books chapters", "New comics chapters"]);

    recordLibraryRunResult("all", { kind: "success", title: "Everything" });
    expect(store.systemNotifications.map((entry) => entry.title)).toEqual(["Everything"]);

    recordLibraryRunResult("all", null);
    expect(store.systemNotifications).toEqual([]);
  });

  it("caps system notifications and lets one be dismissed", () => {
    const now = Date.now();
    for (let index = 0; index < NOTIFICATION_RETENTION.system.max + 5; index += 1) {
      addSystemNotification({ kind: "info", title: `Event ${index}`, createdAt: now - index });
    }
    expect(store.systemNotifications).toHaveLength(NOTIFICATION_RETENTION.system.max);
    const newest = store.systemNotifications[0];
    expect(newest.title).toBe("Event 0");
    dismissSystemNotification(newest);
    expect(store.systemNotifications.some((entry) => entry.id === newest.id)).toBe(false);
  });
});
