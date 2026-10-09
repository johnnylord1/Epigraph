import { describe, expect, it } from "vitest";
import { toSyncedHistoryEntries } from "./syncedComicHistory";

describe("toSyncedHistoryEntries", () => {
  it("converts Suwayomi seconds to milliseconds and skips unread or orphan chapters", () => {
    const entries = toSyncedHistoryEntries([
      { id: 1, name: "Ch. 1", lastReadAt: "1700000000", manga: { id: 9, title: "A", thumbnailUrl: null } },
      { id: 2, name: "Ch. 2", lastReadAt: "0", manga: { id: 9, title: "A", thumbnailUrl: null } },
      { id: 3, name: "Ch. 3", lastReadAt: 1700000100, manga: null },
    ]);
    expect(entries).toEqual([
      { mangaId: 9, mangaTitle: "A", thumbnailUrl: "", chapterId: 1, chapterName: "Ch. 1", readAt: 1_700_000_000_000 },
    ]);
  });
});
