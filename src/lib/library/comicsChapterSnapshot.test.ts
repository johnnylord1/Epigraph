import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  diffComicsChapterEntries,
  loadComicsChapterSnapshot,
  reconcileComicsChapterSnapshot,
  saveComicsChapterSnapshot,
} from "./comicsChapterSnapshot";
import type { Chapter, Manga } from "../types";

const manga: Manga = {
  id: 7,
  title: "A Library Title",
  thumbnailUrl: "/cover.jpg",
  inLibrary: true,
  chapterCount: 1,
  unreadCount: 1,
  downloadCount: 0,
  source: {
    id: "1",
    name: "demo",
    displayName: "Demo",
    lang: "en",
  },
};

function chapter(id: number, name: string): Chapter {
  return {
    id,
    mangaId: 7,
    name,
    chapterNumber: id,
    sourceOrder: id,
    isRead: false,
    isDownloaded: false,
    isBookmarked: false,
    pageCount: 10,
    uploadDate: `2026-06-${String(id).padStart(2, "0")}`,
  };
}

describe("comics chapter snapshot", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    });
  });

  it("stores chapter snapshots per profile and server", () => {
    saveComicsChapterSnapshot(
      { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      {
        mangas: {
          "7": {
            mangaId: 7,
            chapters: [{ id: 1, name: "Chapter 1", sourceOrder: 1, uploadDate: null, seenAt: 42 }],
            updatedAt: 42,
          },
        },
        updatedAt: 42,
      },
    );

    expect(loadComicsChapterSnapshot({ profileId: "main", serverUrl: "http://127.0.0.1:4567" })?.mangas["7"]?.chapters).toHaveLength(1);
    expect(loadComicsChapterSnapshot({ profileId: "test", serverUrl: "http://127.0.0.1:4667" })).toBeNull();
  });

  it("diffs new chapters by stable chapter id", () => {
    const newEntries = diffComicsChapterEntries(
      [{ id: 1, name: "Chapter 1", sourceOrder: 1, uploadDate: null, seenAt: 1 }],
      [
        { id: 1, name: "Chapter 1", sourceOrder: 1, uploadDate: null, seenAt: 2 },
        { id: 2, name: "Chapter 2", sourceOrder: 2, uploadDate: null, seenAt: 2 },
      ],
    );

    expect(newEntries).toEqual([
      { id: 2, name: "Chapter 2", sourceOrder: 2, uploadDate: null, seenAt: 2 },
    ]);
  });

  it("seeds the first fetched manga snapshot without creating old update notifications", async () => {
    const result = await reconcileComicsChapterSnapshot({
      scope: { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      beforeMangas: [manga],
      afterMangas: [{ ...manga, chapterCount: 2 }],
      candidateMangaIds: [7],
      fetchChapters: vi.fn(async () => [chapter(1, "Chapter 1"), chapter(2, "Chapter 2")]),
      createdAt: 100,
    });

    expect(result.notifications).toEqual([]);
    expect(result.mangas[0]).toMatchObject({ chapterCount: 2, unreadCount: 2 });
    expect(loadComicsChapterSnapshot({ profileId: "main", serverUrl: "http://127.0.0.1:4567" })?.mangas["7"]?.chapters).toHaveLength(2);
  });

  it("creates notifications for chapters added after a previous snapshot exists", async () => {
    saveComicsChapterSnapshot(
      { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      {
        mangas: {
          "7": {
            mangaId: 7,
            chapters: [{ id: 1, name: "Chapter 1", sourceOrder: 1, uploadDate: null, seenAt: 42 }],
            updatedAt: 42,
          },
        },
      },
    );

    const result = await reconcileComicsChapterSnapshot({
      scope: { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      beforeMangas: [manga],
      afterMangas: [{ ...manga, chapterCount: 2 }],
      candidateMangaIds: [7],
      fetchChapters: vi.fn(async () => [chapter(1, "Chapter 1"), chapter(2, "Chapter 2")]),
      createdAt: 100,
    });

    expect(result.notifications).toMatchObject([
      {
        mangaId: 7,
        chapterTitles: ["Chapter 2"],
        previousChapterCount: 1,
        nextChapterCount: 2,
      },
    ]);
  });

  it("uses preloaded chapters from the update queue without fetching again", async () => {
    saveComicsChapterSnapshot(
      { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      {
        mangas: {
          "7": {
            mangaId: 7,
            chapters: [{ id: 1, name: "Chapter 1", sourceOrder: 1, uploadDate: null, seenAt: 42 }],
            updatedAt: 42,
          },
        },
      },
    );
    const fetchChapters = vi.fn(async () => [chapter(1, "Chapter 1")]);

    const result = await reconcileComicsChapterSnapshot({
      scope: { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      beforeMangas: [manga],
      afterMangas: [{ ...manga, chapterCount: 2 }],
      candidateMangaIds: [7],
      preloadedChapters: new Map([[7, [chapter(1, "Chapter 1"), chapter(2, "Chapter 2")]]]),
      fetchChapters,
      createdAt: 100,
    });

    expect(fetchChapters).not.toHaveBeenCalled();
    expect(result.notifications).toMatchObject([
      {
        mangaId: 7,
        chapterTitles: ["Chapter 2"],
        previousChapterCount: 1,
        nextChapterCount: 2,
      },
    ]);
  });

  it("falls back to chapterCount notifications when fetching candidate chapters fails", async () => {
    const result = await reconcileComicsChapterSnapshot({
      scope: { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      beforeMangas: [manga],
      afterMangas: [{ ...manga, chapterCount: 2 }],
      candidateMangaIds: [7],
      fetchChapters: vi.fn(async () => {
        throw new Error("offline");
      }),
      createdAt: 100,
    });

    expect(result.failedIds).toEqual([7]);
    expect(result.notifications).toMatchObject([
      {
        mangaId: 7,
        chapterTitles: [],
        previousChapterCount: 1,
        nextChapterCount: 2,
      },
    ]);
  });
});
