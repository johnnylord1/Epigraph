import type { Chapter, Manga } from "../types";

export interface ReconciledMangaCounts {
  mangas: Manga[];
  changedIds: number[];
  failedIds: number[];
}

export interface ReconcileMangaCountsOptions {
  concurrency?: number;
}

function toFiniteCount(value: unknown) {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export interface MangaChapterCounts {
  chapterCount: number;
  unreadCount: number;
  downloadCount: number;
}

export function deriveMangaCountsFromChapters(chapters: Chapter[]): MangaChapterCounts {
  return {
    chapterCount: chapters.length,
    unreadCount: chapters.filter((chapter) => !chapter.isRead).length,
    downloadCount: chapters.filter((chapter) => chapter.isDownloaded).length,
  };
}

export function isMangaChapterCountRegression(manga: Manga, counts: MangaChapterCounts) {
  return counts.chapterCount < toFiniteCount(manga.chapterCount);
}

export function mergeMangaCountsFromChapters(manga: Manga, chapters: Chapter[]): Manga {
  const counts = deriveMangaCountsFromChapters(chapters);
  if (isMangaChapterCountRegression(manga, counts)) return manga;
  return {
    ...manga,
    ...counts,
  };
}

function countsChanged(manga: Manga, counts: MangaChapterCounts) {
  if (isMangaChapterCountRegression(manga, counts)) return false;
  return (
    toFiniteCount(manga.chapterCount) !== counts.chapterCount
    || toFiniteCount(manga.unreadCount) !== counts.unreadCount
    || toFiniteCount(manga.downloadCount) !== counts.downloadCount
  );
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await task(item);
      }
    }),
  );
}

export async function reconcileMangaCountsFromChapters(
  mangas: Manga[],
  fetchChapters: (mangaId: number) => Promise<Chapter[]>,
  options: ReconcileMangaCountsOptions = {},
): Promise<ReconciledMangaCounts> {
  const uniqueMangas = [...new Map(mangas.map((manga) => [manga.id, manga])).values()];
  const patches = new Map<number, MangaChapterCounts>();
  const failedIds: number[] = [];

  await runWithConcurrency(
    uniqueMangas,
    options.concurrency ?? 6,
    async (manga) => {
      try {
        const counts = deriveMangaCountsFromChapters(await fetchChapters(manga.id));
        if (countsChanged(manga, counts)) patches.set(manga.id, counts);
      } catch {
        failedIds.push(manga.id);
      }
    },
  );

  if (patches.size === 0) {
    return { mangas, changedIds: [], failedIds };
  }

  return {
    mangas: mangas.map((manga) => {
      const patch = patches.get(manga.id);
      return patch ? { ...manga, ...patch } : manga;
    }),
    changedIds: [...patches.keys()],
    failedIds,
  };
}
