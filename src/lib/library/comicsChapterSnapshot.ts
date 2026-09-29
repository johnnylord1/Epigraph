import { translate } from "../i18n/runtime";
import { librarySnapshotScopeKey, type LibrarySnapshotScope } from "./snapshot";
import {
  deriveMangaCountsFromChapters,
  isMangaChapterCountRegression,
  type MangaChapterCounts,
} from "./chapterCounts";
import type { Chapter, Manga } from "../types";

const COMICS_CHAPTER_SNAPSHOT_KEY = "epigraph-comics-chapter-snapshots";
const COMICS_CHAPTER_SNAPSHOT_VERSION = 1 as const;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface PersistedComicsChapterEntry {
  id: number;
  name?: string;
  sourceOrder?: number | null;
  uploadDate?: string | null;
  seenAt?: number;
}

export interface PersistedComicsMangaChapterSnapshot {
  mangaId: number;
  chapters: PersistedComicsChapterEntry[];
  updatedAt: number;
}

export interface PersistedComicsChapterSnapshot {
  version: typeof COMICS_CHAPTER_SNAPSHOT_VERSION;
  scopeKey: string;
  mangas: Record<string, PersistedComicsMangaChapterSnapshot>;
  updatedAt: number;
}

export interface ComicsUpdateNotificationInput {
  mangaId: number;
  mangaTitle: string;
  thumbnailUrl?: string | null;
  sourceName?: string | null;
  chapterTitles: string[];
  previousChapterCount: number;
  nextChapterCount: number;
}

export interface ReconcileComicsChapterSnapshotOptions {
  scope: LibrarySnapshotScope;
  beforeMangas: Manga[];
  afterMangas: Manga[];
  candidateMangaIds?: Iterable<number> | null;
  fetchChapters: (mangaId: number) => Promise<Chapter[]>;
  preloadedChapters?: Map<number, Chapter[]> | Record<string, Chapter[]>;
  createdAt?: number;
  concurrency?: number;
}

export interface ReconcileComicsChapterSnapshotResult {
  mangas: Manga[];
  changedIds: number[];
  failedIds: number[];
  notifications: ComicsUpdateNotificationInput[];
}

function storageOrNull(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function normalizeNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeChapterEntry(value: unknown): PersistedComicsChapterEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = normalizeNumber(record.id);
  const seenAt = normalizeNumber(record.seenAt);
  if (id === null) return null;
  const entry: PersistedComicsChapterEntry = { id };
  const name = normalizeString(record.name);
  const sourceOrder = normalizeNumber(record.sourceOrder);
  const uploadDate = normalizeString(record.uploadDate);
  if (name) entry.name = name;
  if (sourceOrder !== null) entry.sourceOrder = sourceOrder;
  if (uploadDate) entry.uploadDate = uploadDate;
  if (seenAt !== null) entry.seenAt = seenAt;
  return entry;
}

function normalizeMangaSnapshot(value: unknown): PersistedComicsMangaChapterSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const mangaId = normalizeNumber(record.mangaId);
  if (mangaId === null) return null;
  const chapters = Array.isArray(record.chapters)
    ? record.chapters.map(normalizeChapterEntry).filter((entry): entry is PersistedComicsChapterEntry => Boolean(entry))
    : [];
  return {
    mangaId,
    chapters,
    updatedAt: normalizeNumber(record.updatedAt) ?? Date.now(),
  };
}

export function normalizeComicsChapterSnapshot(
  value: unknown,
  scope: LibrarySnapshotScope = {},
): PersistedComicsChapterSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawMangas = record.mangas && typeof record.mangas === "object"
    ? record.mangas as Record<string, unknown>
    : {};
  const mangas = Object.fromEntries(
    Object.entries(rawMangas)
      .map(([, mangaSnapshot]) => normalizeMangaSnapshot(mangaSnapshot))
      .filter((entry): entry is PersistedComicsMangaChapterSnapshot => Boolean(entry))
      .map((entry) => [String(entry.mangaId), entry]),
  );
  return {
    version: COMICS_CHAPTER_SNAPSHOT_VERSION,
    scopeKey: normalizeString(record.scopeKey) ?? librarySnapshotScopeKey(scope),
    mangas,
    updatedAt: normalizeNumber(record.updatedAt) ?? Date.now(),
  };
}

function readSnapshotMap(storage = storageOrNull()): Record<string, PersistedComicsChapterSnapshot> {
  if (!storage) return {};
  const raw = storage.getItem(COMICS_CHAPTER_SNAPSHOT_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([scopeKey, snapshot]) => [scopeKey, normalizeComicsChapterSnapshot(snapshot, {})])
        .filter((entry): entry is [string, PersistedComicsChapterSnapshot] => Boolean(entry[1])),
    );
  } catch {
    return {};
  }
}

function compactChapterEntryForStorage(entry: PersistedComicsChapterEntry): PersistedComicsChapterEntry {
  if (Number.isFinite(entry.id)) return { id: entry.id };
  const compacted: PersistedComicsChapterEntry = { id: entry.id };
  if (entry.name) compacted.name = entry.name;
  if (entry.sourceOrder !== undefined) compacted.sourceOrder = entry.sourceOrder;
  if (entry.uploadDate) compacted.uploadDate = entry.uploadDate;
  return compacted;
}

function compactSnapshotForStorage(snapshot: PersistedComicsChapterSnapshot): PersistedComicsChapterSnapshot {
  return {
    ...snapshot,
    mangas: Object.fromEntries(
      Object.entries(snapshot.mangas).map(([mangaId, mangaSnapshot]) => [
        mangaId,
        {
          ...mangaSnapshot,
          chapters: mangaSnapshot.chapters.map(compactChapterEntryForStorage),
        },
      ]),
    ),
  };
}

function compactSnapshotMapForStorage(next: Record<string, PersistedComicsChapterSnapshot>) {
  return Object.fromEntries(
    Object.entries(next).map(([scopeKey, snapshot]) => [scopeKey, compactSnapshotForStorage(snapshot)]),
  );
}

function writeSnapshotMap(next: Record<string, PersistedComicsChapterSnapshot>, storage = storageOrNull()) {
  if (!storage) return;
  try {
    storage.setItem(COMICS_CHAPTER_SNAPSHOT_KEY, JSON.stringify(compactSnapshotMapForStorage(next)));
  } catch (error) {
    console.warn("Could not persist Comics chapter snapshots; continuing without updating the local snapshot cache.", error);
  }
}

export function loadComicsChapterSnapshot(scope: LibrarySnapshotScope = {}): PersistedComicsChapterSnapshot | null {
  const scopeKey = librarySnapshotScopeKey(scope);
  return readSnapshotMap()[scopeKey] ?? null;
}

export function saveComicsChapterSnapshot(
  scope: LibrarySnapshotScope,
  snapshot: Pick<PersistedComicsChapterSnapshot, "mangas"> & { updatedAt?: number },
) {
  const scopeKey = librarySnapshotScopeKey(scope);
  const nextSnapshot: PersistedComicsChapterSnapshot = {
    version: COMICS_CHAPTER_SNAPSHOT_VERSION,
    scopeKey,
    mangas: snapshot.mangas,
    updatedAt: snapshot.updatedAt ?? Date.now(),
  };
  writeSnapshotMap({
    ...readSnapshotMap(),
    [scopeKey]: nextSnapshot,
  });
  return nextSnapshot;
}

function chapterKey(entry: PersistedComicsChapterEntry) {
  if (Number.isFinite(entry.id)) return `id:${entry.id}`;
  const order = entry.sourceOrder ?? "";
  const name = (entry.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const uploadDate = entry.uploadDate ?? "";
  return `fallback:${order}:${name}:${uploadDate}`;
}

export function diffComicsChapterEntries(
  previous: PersistedComicsChapterEntry[] | null | undefined,
  next: PersistedComicsChapterEntry[],
) {
  if (!previous) return [];
  const previousKeys = new Set(previous.map(chapterKey));
  return next.filter((entry) => !previousKeys.has(chapterKey(entry)));
}

function toChapterEntry(chapter: Chapter, seenAt: number): PersistedComicsChapterEntry | null {
  const id = normalizeNumber(chapter.id);
  if (id === null) return null;
  return {
    id,
    name: typeof chapter.name === "string" ? chapter.name : "",
    sourceOrder: normalizeNumber(chapter.sourceOrder),
    uploadDate: typeof chapter.uploadDate === "string" && chapter.uploadDate.trim() ? chapter.uploadDate.trim() : null,
    seenAt,
  };
}

function countsChanged(manga: Manga, counts: MangaChapterCounts) {
  if (isMangaChapterCountRegression(manga, counts)) return false;
  const chapterCount = Number(manga.chapterCount ?? 0);
  const unreadCount = Number(manga.unreadCount ?? 0);
  const downloadCount = Number(manga.downloadCount ?? 0);
  return chapterCount !== counts.chapterCount
    || unreadCount !== counts.unreadCount
    || downloadCount !== counts.downloadCount;
}

function countDelta(previous: Manga | undefined, next: Manga | undefined) {
  if (!previous || !next) return 0;
  return Math.max(0, Number(next.chapterCount ?? 0) - Math.max(0, Number(previous.chapterCount ?? 0)));
}

export function buildComicsUpdateCandidateIds(
  beforeMangas: Manga[],
  afterMangas: Manga[],
  changedMangaIds?: Iterable<number> | null,
) {
  const afterById = new Map(afterMangas.map((manga) => [manga.id, manga]));
  const beforeById = new Map(beforeMangas.map((manga) => [manga.id, manga]));
  const ids = new Set<number>();
  for (const id of changedMangaIds ?? []) {
    const numericId = Number(id);
    if (Number.isFinite(numericId) && afterById.has(numericId)) ids.add(numericId);
  }
  for (const manga of afterMangas) {
    if (countDelta(beforeById.get(manga.id), manga) > 0) ids.add(manga.id);
  }
  return [...ids];
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

export async function reconcileComicsChapterSnapshot(
  options: ReconcileComicsChapterSnapshotOptions,
): Promise<ReconcileComicsChapterSnapshotResult> {
  const createdAt = options.createdAt ?? Date.now();
  const snapshot = loadComicsChapterSnapshot(options.scope);
  const nextSnapshotMap: Record<string, PersistedComicsMangaChapterSnapshot> = { ...(snapshot?.mangas ?? {}) };
  const beforeById = new Map(options.beforeMangas.map((manga) => [manga.id, manga]));
  const afterById = new Map(options.afterMangas.map((manga) => [manga.id, manga]));
  const candidates = buildComicsUpdateCandidateIds(
    options.beforeMangas,
    options.afterMangas,
    options.candidateMangaIds,
  ).filter((mangaId) => afterById.has(mangaId));
  const patches = new Map<number, MangaChapterCounts>();
  const notifications: ComicsUpdateNotificationInput[] = [];
  const failedIds: number[] = [];
  const touchedIds = new Set<number>();
  const preloadedChapters = options.preloadedChapters instanceof Map
    ? options.preloadedChapters
    : new Map(
        Object.entries(options.preloadedChapters ?? {})
          .map(([mangaId, chapters]) => [Number(mangaId), chapters] as const)
          .filter(([mangaId, chapters]) => Number.isFinite(mangaId) && Array.isArray(chapters)),
      );

  if (!candidates.length) {
    return {
      mangas: options.afterMangas,
      changedIds: [],
      failedIds: [],
      notifications: [],
    };
  }

  await runWithConcurrency(candidates, options.concurrency ?? 3, async (mangaId) => {
    const manga = afterById.get(mangaId);
    if (!manga) return;
    try {
      const chapters = preloadedChapters.get(mangaId) ?? await options.fetchChapters(mangaId);
      const entries = chapters
        .map((chapter) => toChapterEntry(chapter, createdAt))
        .filter((entry): entry is PersistedComicsChapterEntry => Boolean(entry));
      const previous = nextSnapshotMap[String(mangaId)] ?? null;
      const newChapters = diffComicsChapterEntries(previous?.chapters, entries);
      const counts = deriveMangaCountsFromChapters(chapters);
      if (isMangaChapterCountRegression(manga, counts)) return;
      if (countsChanged(manga, counts)) patches.set(mangaId, counts);
      nextSnapshotMap[String(mangaId)] = {
        mangaId,
        chapters: entries,
        updatedAt: createdAt,
      };
      touchedIds.add(mangaId);
      if (previous && newChapters.length > 0) {
        const sourceName = manga.source?.displayName || manga.source?.name || "Library";
        notifications.push({
          mangaId,
          mangaTitle: manga.title,
          thumbnailUrl: manga.thumbnailUrl,
          sourceName,
          chapterTitles: newChapters.map((entry) => entry.name || translate("detail_chapterNumber", { value: entry.sourceOrder ?? entry.id })).slice(0, 5),
          previousChapterCount: previous.chapters.length,
          nextChapterCount: entries.length,
        });
      }
    } catch {
      failedIds.push(mangaId);
      const previous = beforeById.get(mangaId);
      const delta = countDelta(previous, manga);
      if (delta > 0) {
        notifications.push({
          mangaId,
          mangaTitle: manga.title,
          thumbnailUrl: manga.thumbnailUrl,
          sourceName: manga.source?.displayName || manga.source?.name || "Library",
          chapterTitles: [],
          previousChapterCount: Math.max(0, Number(previous?.chapterCount ?? 0)),
          nextChapterCount: Math.max(0, Number(manga.chapterCount ?? 0)),
        });
      }
    }
  });

  if (touchedIds.size > 0 || snapshot) {
    saveComicsChapterSnapshot(options.scope, {
      mangas: nextSnapshotMap,
      updatedAt: createdAt,
    });
  }

  const mangas = patches.size > 0
    ? options.afterMangas.map((manga) => {
        const patch = patches.get(manga.id);
        return patch ? { ...manga, ...patch } : manga;
      })
    : options.afterMangas;

  return {
    mangas,
    changedIds: [...patches.keys()],
    failedIds,
    notifications: notifications.sort((left, right) =>
      right.chapterTitles.length - left.chapterTitles.length || left.mangaTitle.localeCompare(right.mangaTitle),
    ),
  };
}
