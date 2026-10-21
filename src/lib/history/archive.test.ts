import { describe, expect, it } from "vitest";
import type { PersistedNovelLibraryState } from "../novels/domain";
import { countUnstartedNovels, summarizeArchive } from "./archive";

function novels(chapters: Array<{ novelId: string; unread: boolean }>, ids: string[]) {
  return {
    entries: ids.map((id) => ({ id })),
    chapters: chapters.map((chapter, index) => ({ ...chapter, id: `c${index}` })),
  } as unknown as Pick<PersistedNovelLibraryState, "entries" | "chapters">;
}

describe("countUnstartedNovels", () => {
  it("counts novels with nothing read and no reading history", () => {
    const state = novels(
      [
        { novelId: "a", unread: false },
        { novelId: "b", unread: true },
        { novelId: "c", unread: true },
      ],
      ["a", "b", "c", "d"],
    );
    expect(countUnstartedNovels(state, new Set(["c"]))).toBe(2);
    expect(countUnstartedNovels(null, new Set())).toBe(0);
  });
});

describe("summarizeArchive", () => {
  it("counts comics, books and novels together", () => {
    const summary = summarizeArchive({
      manga: [
        { id: 1, chapterCount: 10, unreadCount: 0 },
        { id: 2, chapterCount: 20, unreadCount: 15 },
      ],
      finishedMangaIds: new Set([1]),
      bookCount: 3,
      finishedBookCount: 1,
      novels: novels(
        [
          { novelId: "a", unread: false },
          { novelId: "a", unread: false },
          { novelId: "b", unread: false },
          { novelId: "b", unread: true },
        ],
        ["a", "b"],
      ),
      loggedChaptersRead: 0,
    });
    expect(summary).toEqual({ titles: 7, finished: 3, chaptersRead: 10 + 5 + 3 });
  });

  it("does not call a title finished just because it has history", () => {
    const summary = summarizeArchive({
      manga: [{ id: 1, chapterCount: 50, unreadCount: 49 }],
      finishedMangaIds: new Set(),
      bookCount: 0,
      finishedBookCount: 0,
      novels: null,
      loggedChaptersRead: 0,
    });
    expect(summary.finished).toBe(0);
    expect(summary.chaptersRead).toBe(1);
  });

  it("keeps the read log when it knows of more chapters than the library", () => {
    const summary = summarizeArchive({
      manga: [{ id: 1, chapterCount: 5, unreadCount: 3 }],
      finishedMangaIds: new Set(),
      bookCount: 0,
      finishedBookCount: 0,
      novels: novels([{ novelId: "gone", unread: false }], []),
      loggedChaptersRead: 40,
    });
    expect(summary).toEqual({ titles: 1, finished: 0, chaptersRead: 40 });
  });
});
