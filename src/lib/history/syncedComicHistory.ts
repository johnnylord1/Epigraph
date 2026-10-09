import { gql } from "../client";
import { GET_RECENTLY_READ_CHAPTERS } from "../queries";
import type { HistoryEntry } from "../../store/state.svelte";

interface RecentlyReadChapter {
  id: number;
  name: string;
  lastReadAt: string | number | null;
  manga: { id: number; title: string; thumbnailUrl: string | null } | null;
}

/** Suwayomi stores lastReadAt in epoch seconds; history entries use milliseconds. */
export function toSyncedHistoryEntries(chapters: RecentlyReadChapter[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const chapter of chapters) {
    const seconds = Number(chapter.lastReadAt);
    if (!chapter.manga || !Number.isFinite(seconds) || seconds <= 0) continue;
    entries.push({
      mangaId: chapter.manga.id,
      mangaTitle: chapter.manga.title,
      thumbnailUrl: chapter.manga.thumbnailUrl ?? "",
      chapterId: chapter.id,
      chapterName: chapter.name,
      readAt: seconds * 1000,
    });
  }
  return entries;
}

export async function fetchSyncedComicHistory(limit = 100): Promise<HistoryEntry[]> {
  const data = await gql<{ chapters: { nodes: RecentlyReadChapter[] } }>(
    GET_RECENTLY_READ_CHAPTERS,
    { first: limit },
  );
  return toSyncedHistoryEntries(data.chapters?.nodes ?? []);
}
