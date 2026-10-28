import type { Manga, TrackerStatus } from "../types";

export interface TrackerCompletionRecord {
  status: number;
  totalChapters?: number | null;
  manga?: {
    id: number;
    inLibrary: boolean;
  } | null;
}

export interface TrackerCompletionTracker {
  isLoggedIn: boolean;
  statuses?: TrackerStatus[] | null;
  trackRecords?: {
    nodes: TrackerCompletionRecord[];
  } | null;
}

function normalizeStatusToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isSourceCompletedStatus(status: string | null | undefined): boolean {
  const token = normalizeStatusToken(status);
  return token === "COMPLETED" || token === "COMPLETE" || token === "PUBLISHING_FINISHED";
}

export function isSourceUnknownStatus(status: string | null | undefined): boolean {
  return normalizeStatusToken(status) === "UNKNOWN";
}

export function isTrackerCompletedStatusName(name: string | null | undefined): boolean {
  const token = normalizeStatusToken(name);
  return token === "COMPLETED" || token === "COMPLETE" || token === "COMPLETE_LIST";
}

export function isLibraryReadCompleted(manga: Pick<Manga, "chapterCount" | "unreadCount">): boolean {
  const chapterCount = Number(manga.chapterCount ?? 0);
  const unreadCount = Number(manga.unreadCount ?? 0);
  return chapterCount > 0 && unreadCount <= 0;
}

export function collectTrackedCompletedMangaIds(
  trackers: TrackerCompletionTracker[] | null | undefined,
): Set<number> {
  const completedIds = new Set<number>();

  for (const tracker of trackers ?? []) {
    if (!tracker?.isLoggedIn) continue;

    const completedValues = new Set(
      (tracker.statuses ?? [])
        .filter((status) => isTrackerCompletedStatusName(status.name))
        .map((status) => Number(status.value)),
    );

    if (!completedValues.size) continue;

    for (const record of tracker.trackRecords?.nodes ?? []) {
      const mangaId = record.manga?.id;
      if (!record.manga?.inLibrary || typeof mangaId !== "number") continue;
      if (completedValues.has(Number(record.status))) {
        completedIds.add(mangaId);
      }
    }
  }

  return completedIds;
}

export function collectTrackedMangaIds(
  trackers: TrackerCompletionTracker[] | null | undefined,
): Set<number> {
  const trackedIds = new Set<number>();

  for (const tracker of trackers ?? []) {
    if (!tracker?.isLoggedIn) continue;
    for (const record of tracker.trackRecords?.nodes ?? []) {
      const mangaId = record.manga?.id;
      if (record.manga?.inLibrary && typeof mangaId === "number") trackedIds.add(mangaId);
    }
  }

  return trackedIds;
}

export function collectTrackedChapterTotalsByMangaId(
  trackers: TrackerCompletionTracker[] | null | undefined,
): Map<number, number> {
  const totals = new Map<number, number>();

  for (const tracker of trackers ?? []) {
    if (!tracker?.isLoggedIn) continue;

    for (const record of tracker.trackRecords?.nodes ?? []) {
      const mangaId = record.manga?.id;
      const totalChapters = Number(record.totalChapters ?? 0);

      if (!record.manga?.inLibrary || typeof mangaId !== "number" || totalChapters <= 0) continue;

      const prev = totals.get(mangaId) ?? 0;
      if (totalChapters > prev) totals.set(mangaId, totalChapters);
    }
  }

  return totals;
}

export function hasSatisfiedTrackedChapterTotal(
  manga: Pick<Manga, "id" | "chapterCount">,
  trackedChapterTotalsByMangaId: ReadonlyMap<number, number>,
): boolean {
  const trackedTotal = trackedChapterTotalsByMangaId.get(manga.id) ?? 0;
  if (trackedTotal <= 0) return true;

  const libraryChapterCount = Number(manga.chapterCount ?? 0);
  return libraryChapterCount >= trackedTotal;
}

export function isMangaPublicationCompleted(
  manga: Pick<Manga, "id" | "status">,
  trackedCompletedIds: ReadonlySet<number>,
): boolean {
  const sourceCompleted = isSourceCompletedStatus(manga.status);
  const trackerCompleted = trackedCompletedIds.has(manga.id);
  return sourceCompleted || trackerCompleted;
}

export function isMangaFinishedReading(
  manga: Pick<Manga, "id" | "status" | "chapterCount" | "unreadCount">,
  trackedCompletedIds: ReadonlySet<number>,
  trackedChapterTotalsByMangaId: ReadonlyMap<number, number> = new Map(),
): boolean {
  const libraryCompleted = isLibraryReadCompleted(manga);
  if (!libraryCompleted) return false;
  if (!hasSatisfiedTrackedChapterTotal(manga, trackedChapterTotalsByMangaId)) return false;

  const sourceCompleted = isSourceCompletedStatus(manga.status);
  const trackerCompleted = trackedCompletedIds.has(manga.id);

  if (isSourceUnknownStatus(manga.status)) {
    return trackerCompleted;
  }

  return sourceCompleted || trackerCompleted;
}

export const isMangaCompletedByAnySignal = isMangaFinishedReading;

export function buildCompletedLibraryIds(
  libraryManga: Manga[],
  completedCategoryMembers: Manga[],
  trackedCompletedIds: ReadonlySet<number>,
  trackedChapterTotalsByMangaId: ReadonlyMap<number, number> = new Map(),
): Set<number> {
  const ids = new Set<number>();

  for (const manga of completedCategoryMembers) {
    if (isMangaFinishedReading(manga, trackedCompletedIds, trackedChapterTotalsByMangaId)) {
      ids.add(manga.id);
    }
  }

  for (const manga of libraryManga) {
    if (isMangaFinishedReading(manga, trackedCompletedIds, trackedChapterTotalsByMangaId)) {
      ids.add(manga.id);
    }
  }
  return ids;
}
