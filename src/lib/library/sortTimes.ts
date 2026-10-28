import type { Manga } from "../types";

// Suwayomi sends these as LongString. inLibraryAt, fetchedAt, lastReadAt and chaptersLastFetchedAt
// are epoch seconds; uploadDate comes from the source in epoch milliseconds.
export type MangaLibraryTimeFields = Pick<
  Manga,
  "inLibraryAt" | "chaptersLastFetchedAt" | "latestFetchedChapter" | "latestUploadedChapter" | "lastReadChapter"
>;

export interface MangaLibraryTimes {
  addedAt: number;
  latestFetchedAt: number;
  latestUploadedAt: number;
  lastReadAt: number;
}

function epochMs(value: unknown, unit: "s" | "ms"): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return unit === "s" ? number * 1000 : number;
}

/** Library dates in epoch milliseconds; 0 when Suwayomi has none. */
export function mangaLibraryTimes(manga: MangaLibraryTimeFields): MangaLibraryTimes {
  return {
    addedAt: epochMs(manga.inLibraryAt, "s"),
    latestFetchedAt: epochMs(manga.latestFetchedChapter?.fetchedAt, "s")
      || epochMs(manga.chaptersLastFetchedAt, "s"),
    latestUploadedAt: epochMs(manga.latestUploadedChapter?.uploadDate, "ms"),
    lastReadAt: epochMs(manga.lastReadChapter?.lastReadAt, "s"),
  };
}
