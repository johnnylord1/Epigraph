import { describe, expect, it } from "vitest";
import type { Chapter, Manga } from "../types";
import { reconcileMangaCountsFromChapters } from "./chapterCounts";

function manga(overrides: Partial<Manga> = {}): Manga {
  return {
    id: 1,
    title: "Alpha",
    thumbnailUrl: "thumb://alpha",
    inLibrary: true,
    downloadCount: 0,
    unreadCount: 0,
    chapterCount: 0,
    status: "ONGOING",
    genre: [],
    source: { id: "source", name: "Source", displayName: "Source" },
    ...overrides,
  };
}

function chapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 1,
    name: "Chapter 1",
    chapterNumber: 1,
    sourceOrder: 1,
    isRead: false,
    isDownloaded: false,
    isBookmarked: false,
    pageCount: 10,
    mangaId: 1,
    ...overrides,
  };
}

describe("reconcileMangaCountsFromChapters", () => {
  it("patches library counts from concrete chapter rows", async () => {
    const result = await reconcileMangaCountsFromChapters(
      [
        manga({ id: 1, chapterCount: 1, unreadCount: 1, downloadCount: 0 }),
        manga({ id: 2, chapterCount: 2, unreadCount: 0, downloadCount: 0 }),
      ],
      async (mangaId) => {
        if (mangaId === 1) {
          return [
            chapter({ id: 1, mangaId: 1, isRead: true, isDownloaded: true }),
            chapter({ id: 2, mangaId: 1, isRead: false }),
            chapter({ id: 3, mangaId: 1, isRead: false }),
          ];
        }
        return [
          chapter({ id: 4, mangaId: 2, isRead: true }),
          chapter({ id: 5, mangaId: 2, isRead: true }),
        ];
      },
    );

    expect(result.changedIds).toEqual([1]);
    expect(result.mangas[0]).toMatchObject({
      chapterCount: 3,
      unreadCount: 2,
      downloadCount: 1,
    });
    expect(result.mangas[1]).toMatchObject({
      chapterCount: 2,
      unreadCount: 0,
      downloadCount: 0,
    });
  });

  it("keeps successful patches when another manga fails", async () => {
    const result = await reconcileMangaCountsFromChapters(
      [
        manga({ id: 1, chapterCount: 0 }),
        manga({ id: 2, chapterCount: 0 }),
      ],
      async (mangaId) => {
        if (mangaId === 2) throw new Error("offline");
        return [chapter({ id: 1, mangaId })];
      },
    );

    expect(result.changedIds).toEqual([1]);
    expect(result.failedIds).toEqual([2]);
    expect(result.mangas[0].chapterCount).toBe(1);
    expect(result.mangas[1].chapterCount).toBe(0);
  });
});
