import { describe, expect, it } from "vitest";
import type { NovelDetailChapter, PersistedNovelChapterEntry } from "../novels/domain";
import type { Chapter } from "../types";
import { matchMangaChapters, matchNovelChapters } from "./chapterMapping";

function mangaChapter(
  id: number,
  chapterNumber: number,
  overrides: Partial<Chapter> = {},
): Chapter {
  return {
    id,
    mangaId: id < 100 ? 1 : 2,
    name: `Chapter ${chapterNumber}`,
    chapterNumber,
    sourceOrder: id % 100,
    isRead: false,
    isDownloaded: false,
    isBookmarked: false,
    pageCount: 10,
    lastPageRead: 0,
    ...overrides,
  };
}

function oldNovelChapter(
  id: string,
  title: string,
  order: number,
  path = `/old/${id}`,
): PersistedNovelChapterEntry {
  return {
    id,
    novelId: "old",
    path,
    title,
    order,
    releaseTime: null,
    unread: true,
  };
}

function newNovelChapter(
  id: string,
  title: string,
  order: number,
  path = `/new/${id}`,
): NovelDetailChapter {
  return {
    id,
    novelId: "new",
    path,
    title,
    order,
    releaseTime: null,
    unread: true,
  };
}

describe("chapter migration mapping", () => {
  it("matches manga decimals exactly without filling gaps", () => {
    const matches = matchMangaChapters(
      [
        mangaChapter(1, 1),
        mangaChapter(2, 1.5),
        mangaChapter(3, 3),
      ],
      [
        mangaChapter(101, 1),
        mangaChapter(102, 1.5),
        mangaChapter(103, 2),
        mangaChapter(104, 3),
      ],
    );

    expect(matches.map((match) => [match.oldChapter.chapterNumber, match.newChapter.chapterNumber]))
      .toEqual([[1, 1], [1.5, 1.5], [3, 3]]);
  });

  it("disambiguates duplicate manga numbers and leaves unresolved duplicates unmatched", () => {
    const matches = matchMangaChapters(
      [
        mangaChapter(1, 4, { name: "Chapter 4 - Alpha", scanlator: "Team A", sourceOrder: 10 }),
        mangaChapter(2, 4, { name: "Chapter 4 - Beta", scanlator: "Team B", sourceOrder: 11 }),
        mangaChapter(3, 5, { name: "Chapter 5", sourceOrder: 12 }),
        mangaChapter(4, 5, { name: "Chapter 5", sourceOrder: 12 }),
      ],
      [
        mangaChapter(101, 4, { name: "Chapter 4 - Beta", scanlator: "Team B", sourceOrder: 11 }),
        mangaChapter(102, 4, { name: "Chapter 4 - Alpha", scanlator: "Team A", sourceOrder: 10 }),
        mangaChapter(103, 5, { name: "Chapter 5", sourceOrder: 12 }),
        mangaChapter(104, 5, { name: "Chapter 5", sourceOrder: 12 }),
      ],
    );

    expect(matches.map((match) => [match.oldChapter.id, match.newChapter.id])).toEqual([
      [1, 102],
      [2, 101],
    ]);
  });

  it("matches novel chapter labels across sources but never uses order alone", () => {
    const matches = matchNovelChapters(
      [
        oldNovelChapter("old-1", "Chapter 1", 0),
        oldNovelChapter("old-2", "Chapter 3.5", 2),
        oldNovelChapter("old-special", "Side Story: Rain", 3),
      ],
      [
        newNovelChapter("new-1", "Ch 1", 0),
        newNovelChapter("new-2", "Chapter 2", 2),
        newNovelChapter("new-3", "Chapter 3.5", 4),
      ],
    );

    expect(matches.map((match) => [match.oldChapter.id, match.newChapter.id])).toEqual([
      ["old-2", "new-3"],
      ["old-1", "new-1"],
    ]);
    expect(matches.some((match) => match.oldChapter.id === "old-special")).toBe(false);
  });

  it("uses order only to disambiguate duplicate novel identities", () => {
    const matches = matchNovelChapters(
      [
        oldNovelChapter("old-a", "Chapter 8", 7),
        oldNovelChapter("old-b", "Chapter 8", 8),
      ],
      [
        newNovelChapter("new-b", "Chapter 8", 8),
        newNovelChapter("new-a", "Chapter 8", 7),
      ],
    );

    expect(matches.map((match) => [match.oldChapter.id, match.newChapter.id])).toEqual([
      ["old-a", "new-a"],
      ["old-b", "new-b"],
    ]);
  });

  it("preserves non-Latin titles as valid matching evidence", () => {
    const matches = matchNovelChapters(
      [
        oldNovelChapter("old-ja", "第十二章 旅立ち", 11),
        oldNovelChapter("old-zh", "番外篇 雨", 12),
      ],
      [
        newNovelChapter("new-zh", "番外篇 雨", 20),
        newNovelChapter("new-ja", "第十二章 旅立ち", 21),
      ],
    );

    expect(matches.map((match) => [match.oldChapter.id, match.newChapter.id])).toEqual([
      ["old-ja", "new-ja"],
      ["old-zh", "new-zh"],
    ]);
  });
});
