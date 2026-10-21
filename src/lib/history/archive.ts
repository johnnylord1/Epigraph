import type { PersistedNovelLibraryState } from "../novels/domain";

interface ArchiveManga {
  id: number;
  unreadCount?: number;
  chapterCount?: number;
}

export interface ArchiveSummary {
  titles: number;
  finished: number;
  chaptersRead: number;
}

/**
 * The Home archive across comics, books and novels. Chapters read come from the library itself,
 * so a restored backup counts before anything is read on this computer; the local read log
 * still wins when it knows of more (titles removed from the library since).
 */
export function summarizeArchive(input: {
  manga: readonly ArchiveManga[];
  finishedMangaIds: ReadonlySet<number>;
  bookCount: number;
  finishedBookCount: number;
  novels: Pick<PersistedNovelLibraryState, "entries" | "chapters"> | null;
  loggedChaptersRead: number;
}): ArchiveSummary {
  let mangaChaptersRead = 0;
  let finishedManga = 0;
  for (const manga of input.manga) {
    const total = Math.max(0, Number(manga.chapterCount) || 0);
    const unread = Math.max(0, Number(manga.unreadCount) || 0);
    mangaChaptersRead += Math.max(0, total - unread);
    if (input.finishedMangaIds.has(manga.id)) finishedManga += 1;
  }

  const novelChapters = new Map<string, { total: number; read: number }>();
  for (const entry of input.novels?.entries ?? []) novelChapters.set(entry.id, { total: 0, read: 0 });
  for (const chapter of input.novels?.chapters ?? []) {
    const counts = novelChapters.get(chapter.novelId);
    if (!counts) continue;
    counts.total += 1;
    if (!chapter.unread) counts.read += 1;
  }
  let novelChaptersRead = 0;
  let finishedNovels = 0;
  for (const { total, read } of novelChapters.values()) {
    novelChaptersRead += read;
    if (total > 0 && read === total) finishedNovels += 1;
  }

  return {
    titles: input.manga.length + input.bookCount + novelChapters.size,
    finished: finishedManga + input.finishedBookCount + finishedNovels,
    chaptersRead: Math.max(input.loggedChaptersRead, mangaChaptersRead + novelChaptersRead),
  };
}
