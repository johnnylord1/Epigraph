import { gql } from "../client";
import {
  FETCH_CHAPTERS,
  GET_CATEGORIES,
  UPDATE_CHAPTERS_PROGRESS,
  UPDATE_MANGA,
  UPDATE_MANGA_CATEGORIES,
} from "../queries";
import type { Category, Chapter, Manga } from "../types";
import { fetchSourceMangaSearchWithFallback } from "../manga/sourceSearch";
import {
  appendMigrationJournalEntry,
  buildMigrationJournalEntry,
  getMigrationJournalEntry,
  markMigrationJournalEntryFailed,
  markMigrationJournalEntryUndone,
} from "./journalState";
import type {
  MangaMassMigrationUndoPayload,
  MangaMigrationStateSlice,
  MangaMigrationUndoPayload,
} from "./types";

interface MangaMigrationMatch {
  manga: Manga;
  chapters: Chapter[];
  similarity: number;
}

export interface ApplyMangaMigrationInput {
  currentManga: Manga;
  currentChapters: Chapter[];
  targetSourceId: string;
  match: MangaMigrationMatch;
  mode?: "migrate" | "copy";
}

export type MassMangaMigrationStatus = "matched" | "needs_review" | "no_match" | "search_failed";

export interface MassMangaMigrationPreviewItem {
  currentManga: Manga;
  currentChapters: Chapter[];
  status: MassMangaMigrationStatus;
  reasonCode: string;
  match: MangaMigrationMatch | null;
  matchedReadCount: number;
  chapterDiff: number;
}

export interface MassMangaMigrationPreview {
  sourceFrom: string;
  sourceTo: string;
  items: MassMangaMigrationPreviewItem[];
  readyCount: number;
  needsReviewCount: number;
  blockedCount: number;
}

export interface PreviewMassMangaMigrationInput {
  sourceFrom: string;
  sourceTo: string;
  items: Array<{
    manga: Manga;
    chapters: Chapter[];
  }>;
  readyThreshold?: number;
  concurrency?: number;
  itemTimeoutMs?: number;
  onItemDone?: (completedCount: number, totalCount: number, item: MassMangaMigrationPreviewItem) => void;
}

export interface ApplyMassMangaMigrationInput {
  preview: MassMangaMigrationPreview;
  selectedMangaIds?: number[];
  mode?: "migrate" | "copy";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await run(items[currentIndex]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function titleSimilarity(a: string, b: string): number {
  const norm = (value: string) => value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

  const wordsA = new Set(norm(a));
  const wordsB = new Set(norm(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((word) => wordsB.has(word)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

async function loadCategoryIdsForManga(mangaId: number): Promise<number[]> {
  const data = await gql<{ categories: { nodes: Category[] } }>(GET_CATEGORIES);
  return (data.categories.nodes ?? [])
    .filter((category) => category.mangas?.nodes?.some((manga) => manga.id === mangaId))
    .map((category) => category.id);
}

async function setCategoryIdsForManga(mangaId: number, targetCategoryIds: number[]): Promise<void> {
  const currentCategoryIds = await loadCategoryIdsForManga(mangaId);
  const targetSet = new Set(targetCategoryIds);
  const currentSet = new Set(currentCategoryIds);
  const addTo = targetCategoryIds.filter((id) => !currentSet.has(id));
  const removeFrom = currentCategoryIds.filter((id) => !targetSet.has(id));

  if (addTo.length === 0 && removeFrom.length === 0) {
    return;
  }

  await gql(UPDATE_MANGA_CATEGORIES, {
    mangaId,
    addTo,
    removeFrom,
  });
}

function snapshotMangaState(
  manga: Manga,
  chapters: Chapter[],
  categoryIds: number[],
): MangaMigrationStateSlice {
  return {
    mangaId: manga.id,
    inLibrary: manga.inLibrary,
    title: manga.title,
    categoryIds: [...categoryIds],
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      isRead: chapter.isRead,
      isBookmarked: chapter.isBookmarked,
      lastPageRead: typeof chapter.lastPageRead === "number" ? chapter.lastPageRead : null,
    })),
  };
}

function buildRestoreGroups(
  snapshot: MangaMigrationStateSlice,
  key: "isRead" | "isBookmarked" | "lastPageRead",
): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const chapter of snapshot.chapters) {
    const rawValue = chapter[key];
    const groupKey = rawValue === null ? "null" : String(rawValue);
    const current = groups.get(groupKey) ?? [];
    current.push(chapter.id);
    groups.set(groupKey, current);
  }
  return groups;
}

async function restoreMangaSnapshot(snapshot: MangaMigrationStateSlice) {
  const readGroups = buildRestoreGroups(snapshot, "isRead");
  for (const [groupKey, ids] of readGroups) {
    await gql(UPDATE_CHAPTERS_PROGRESS, {
      ids,
      isRead: groupKey === "true",
    });
  }

  const bookmarkGroups = buildRestoreGroups(snapshot, "isBookmarked");
  for (const [groupKey, ids] of bookmarkGroups) {
    await gql(UPDATE_CHAPTERS_PROGRESS, {
      ids,
      isBookmarked: groupKey === "true",
    });
  }

  const progressGroups = buildRestoreGroups(snapshot, "lastPageRead");
  for (const [groupKey, ids] of progressGroups) {
    await gql(UPDATE_CHAPTERS_PROGRESS, {
      ids,
      lastPageRead: groupKey === "null" ? null : Number(groupKey),
    });
  }

  await gql(UPDATE_MANGA, {
    id: snapshot.mangaId,
    inLibrary: snapshot.inLibrary,
  });
  await setCategoryIdsForManga(snapshot.mangaId, snapshot.categoryIds);
}

async function fetchBestMangaMatch(
  currentManga: Manga,
  targetSourceId: string,
  signal?: AbortSignal,
  timeoutMs = 18000,
): Promise<MangaMigrationMatch | null> {
  const mangas = await fetchSourceMangaSearchWithFallback({
    sourceId: targetSourceId,
    query: currentManga.title.trim(),
    signal,
    timeoutMs,
  });

  const scored = mangas
    .map((manga) => ({
      manga,
      similarity: titleSimilarity(currentManga.title, manga.title),
    }))
    .sort((left, right) => right.similarity - left.similarity);

  const best = scored[0];
  if (!best) return null;

  const chaptersResult = await gql<{ fetchChapters: { chapters: Chapter[] } }>(FETCH_CHAPTERS, {
    mangaId: best.manga.id,
  }, signal);

  return {
    manga: best.manga,
    chapters: chaptersResult.fetchChapters.chapters ?? [],
    similarity: best.similarity,
  };
}

function summarizeMatchedReadCount(oldChapters: Chapter[], newChapters: Chapter[]): number {
  const highestReadChapterNumber = oldChapters.reduce((highest, chapter) => (
    chapter.isRead && chapter.chapterNumber > highest ? chapter.chapterNumber : highest
  ), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(highestReadChapterNumber)) return 0;
  return newChapters.filter((chapter) => chapter.chapterNumber <= highestReadChapterNumber).length;
}

export async function buildMangaMigrationMatch(
  currentManga: Manga,
  matchManga: Manga,
  similarity = titleSimilarity(currentManga.title, matchManga.title),
): Promise<MangaMigrationMatch> {
  const chaptersResult = await gql<{ fetchChapters: { chapters: Chapter[] } }>(FETCH_CHAPTERS, {
    mangaId: matchManga.id,
  });

  return {
    manga: matchManga,
    chapters: chaptersResult.fetchChapters.chapters ?? [],
    similarity,
  };
}

export function updateMassMangaMigrationPreviewItem(
  preview: MassMangaMigrationPreview,
  currentMangaId: number,
  match: MangaMigrationMatch | null,
): MassMangaMigrationPreview {
  const items = preview.items.map((item) => {
    if (item.currentManga.id !== currentMangaId) return item;
    if (!match) {
      return {
        ...item,
        status: "no_match" as const,
        reasonCode: "manual_match_cleared",
        match: null,
        matchedReadCount: 0,
        chapterDiff: 0,
      };
    }
    return {
      ...item,
      status: "matched" as const,
      reasonCode: "manual_match",
      match,
      matchedReadCount: summarizeMatchedReadCount(item.currentChapters, match.chapters),
      chapterDiff: match.chapters.length - item.currentChapters.length,
    };
  });
  return {
    ...preview,
    items,
    readyCount: items.filter((item) => item.status === "matched").length,
    needsReviewCount: items.filter((item) => item.status === "needs_review").length,
    blockedCount: items.filter((item) => item.status === "no_match" || item.status === "search_failed").length,
  };
}

async function prepareMangaMigrationOperation(
  input: ApplyMangaMigrationInput,
): Promise<{
  oldState: MangaMigrationStateSlice;
  newState: MangaMigrationStateSlice;
  transferSummary: {
    oldItemTitle: string;
    newItemTitle: string;
    oldSourceId: string;
    newSourceId: string;
    transferredChapterCount: number;
    transferredReadCount: number;
    transferredBookmarkCount: number;
  };
  newManga: Manga;
}> {
  const oldCategoryIds = await loadCategoryIdsForManga(input.currentManga.id);
  const newCategoryIds = await loadCategoryIdsForManga(input.match.manga.id);
  const oldState = snapshotMangaState(input.currentManga, input.currentChapters, oldCategoryIds);
  const newState = snapshotMangaState(input.match.manga, input.match.chapters, newCategoryIds);
  const oldByNum = new Map(
    input.currentChapters.map((chapter) => [Math.round(chapter.chapterNumber * 100), chapter] as const),
  );

  const toMarkRead: number[] = [];
  const toMarkBookmarked: number[] = [];
  const progressUpdates: Array<{ id: number; lastPageRead: number }> = [];

  const highestReadChapterNumber = input.currentChapters.reduce((highest, chapter) => (
    chapter.isRead && chapter.chapterNumber > highest ? chapter.chapterNumber : highest
  ), Number.NEGATIVE_INFINITY);

  for (const newChapter of input.match.chapters) {
    const key = Math.round(newChapter.chapterNumber * 100);
    const oldChapter = oldByNum.get(key);
    if (Number.isFinite(highestReadChapterNumber) && newChapter.chapterNumber <= highestReadChapterNumber) {
      toMarkRead.push(newChapter.id);
    }
    if (oldChapter?.isBookmarked) toMarkBookmarked.push(newChapter.id);
    if (oldChapter && (oldChapter.lastPageRead ?? 0) > 0 && !oldChapter.isRead) {
      progressUpdates.push({ id: newChapter.id, lastPageRead: oldChapter.lastPageRead ?? 0 });
    }
  }

  const mode = input.mode ?? "migrate";

  try {
    if (toMarkRead.length) {
      await gql(UPDATE_CHAPTERS_PROGRESS, { ids: toMarkRead, isRead: true });
    }
    if (toMarkBookmarked.length) {
      await gql(UPDATE_CHAPTERS_PROGRESS, { ids: toMarkBookmarked, isBookmarked: true });
    }
    for (const update of progressUpdates) {
      await gql(UPDATE_CHAPTERS_PROGRESS, { ids: [update.id], lastPageRead: update.lastPageRead });
    }

    await gql(UPDATE_MANGA, { id: input.match.manga.id, inLibrary: true });
    await setCategoryIdsForManga(input.match.manga.id, oldCategoryIds);
    if (mode === "migrate") {
      await gql(UPDATE_MANGA, { id: input.currentManga.id, inLibrary: false });
      await setCategoryIdsForManga(input.currentManga.id, []);
    }
  } catch (error) {
    await Promise.allSettled([
      restoreMangaSnapshot(oldState),
      restoreMangaSnapshot(newState),
    ]);
    throw error;
  }

  return {
    oldState,
    newState,
    transferSummary: {
      oldItemTitle: input.currentManga.title,
      newItemTitle: input.match.manga.title,
      oldSourceId: input.currentManga.source?.id ?? "unknown",
      newSourceId: input.targetSourceId,
      transferredChapterCount: input.match.chapters.length,
      transferredReadCount: toMarkRead.length,
      transferredBookmarkCount: toMarkBookmarked.length,
    },
    newManga: {
      ...input.match.manga,
      inLibrary: true,
    },
  };
}

export async function applyMangaMigrationWithJournal(
  input: ApplyMangaMigrationInput,
): Promise<{ journalEntryId: string; newManga: Manga }> {
  const prepared = await prepareMangaMigrationOperation(input);

  const journalEntry = buildMigrationJournalEntry({
    contentKind: "manga",
    sourceFrom: input.currentManga.source?.id ?? "unknown",
    sourceTo: input.targetSourceId,
    transferSummary: prepared.transferSummary,
    payload: {
      oldState: prepared.oldState,
      newState: prepared.newState,
    },
  });

  await appendMigrationJournalEntry(journalEntry);

  return {
    journalEntryId: journalEntry.id,
    newManga: prepared.newManga,
  };
}

export async function previewMassMangaMigration(
  input: PreviewMassMangaMigrationInput,
): Promise<MassMangaMigrationPreview> {
  const readyThreshold = input.readyThreshold ?? 0.7;
  const itemTimeoutMs = input.itemTimeoutMs ?? 22000;
  let completedCount = 0;
  const items = await mapWithConcurrency(input.items, input.concurrency ?? 2, async (item): Promise<MassMangaMigrationPreviewItem> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), itemTimeoutMs);
    let result: MassMangaMigrationPreviewItem;
    try {
      const match = await fetchBestMangaMatch(item.manga, input.sourceTo, controller.signal, itemTimeoutMs);
      if (!match) {
        result = {
          currentManga: item.manga,
          currentChapters: item.chapters,
          status: "no_match",
          reasonCode: "no_match_found",
          match: null,
          matchedReadCount: 0,
          chapterDiff: 0,
        };
        return result;
      }

      result = {
        currentManga: item.manga,
        currentChapters: item.chapters,
        status: match.similarity >= readyThreshold ? "matched" : "needs_review",
        reasonCode: match.similarity >= readyThreshold ? "auto_match" : "low_confidence_match",
        match,
        matchedReadCount: summarizeMatchedReadCount(item.chapters, match.chapters),
        chapterDiff: match.chapters.length - item.chapters.length,
      };
      return result;
    } catch (error) {
      const isTimeout = controller.signal.aborted;
      result = {
        currentManga: item.manga,
        currentChapters: item.chapters,
        status: "search_failed",
        reasonCode: isTimeout ? `Timed out while searching ${item.manga.title}` : error instanceof Error ? error.message : "runtime_gap",
        match: null,
        matchedReadCount: 0,
        chapterDiff: 0,
      };
      return result;
    } finally {
      clearTimeout(timeoutId);
      completedCount += 1;
      if (result!) input.onItemDone?.(completedCount, input.items.length, result);
    }
  });

  return {
    sourceFrom: input.sourceFrom,
    sourceTo: input.sourceTo,
    items,
    readyCount: items.filter((item) => item.status === "matched").length,
    needsReviewCount: items.filter((item) => item.status === "needs_review").length,
    blockedCount: items.filter((item) => item.status === "no_match" || item.status === "search_failed").length,
  };
}

export async function applyMassMangaMigrationWithJournal(
  input: ApplyMassMangaMigrationInput,
): Promise<{
  journalEntryId: string | null;
  migratedCount: number;
  skippedCount: number;
  migratedMangaIds: number[];
  migratedSourceMangaIds: number[];
  failedItems: Array<{ mangaId: number; message: string }>;
}> {
  const selectedIds = new Set(input.selectedMangaIds ?? input.preview.items.map((item) => item.currentManga.id));
  const readyItems = input.preview.items.filter((item) => (
    item.status !== "no_match"
    && item.status !== "search_failed"
    && item.match
    && selectedIds.has(item.currentManga.id)
  ));

  const payloadItems: MangaMigrationUndoPayload[] = [];
  let transferredChapterCount = 0;
  let transferredReadCount = 0;
  let transferredBookmarkCount = 0;
  const migratedMangaIds: number[] = [];
  const migratedSourceMangaIds: number[] = [];
  const failedItems: Array<{ mangaId: number; message: string }> = [];

  for (const item of readyItems) {
    try {
      const prepared = await prepareMangaMigrationOperation({
        currentManga: item.currentManga,
        currentChapters: item.currentChapters,
        targetSourceId: input.preview.sourceTo,
        match: item.match!,
        mode: input.mode ?? "migrate",
      });

      payloadItems.push({
        oldState: prepared.oldState,
        newState: prepared.newState,
      });
      migratedMangaIds.push(item.match!.manga.id);
      migratedSourceMangaIds.push(item.currentManga.id);
      transferredChapterCount += prepared.transferSummary.transferredChapterCount;
      transferredReadCount += prepared.transferSummary.transferredReadCount;
      transferredBookmarkCount += prepared.transferSummary.transferredBookmarkCount;
    } catch (error) {
      failedItems.push({
        mangaId: item.currentManga.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let journalEntryId: string | null = null;
  if (payloadItems.length) {
    const journalEntry = buildMigrationJournalEntry({
      contentKind: "manga",
      mode: "mass",
      sourceFrom: input.preview.sourceFrom,
      sourceTo: input.preview.sourceTo,
      transferSummary: {
        oldItemTitle: `${payloadItems.length} manga`,
        newItemTitle: `${payloadItems.length} migrated`,
        oldSourceId: input.preview.sourceFrom,
        newSourceId: input.preview.sourceTo,
        transferredChapterCount,
        transferredReadCount,
        transferredBookmarkCount,
      },
      payload: {
        items: payloadItems,
      } satisfies MangaMassMigrationUndoPayload,
    });

    await appendMigrationJournalEntry(journalEntry);
    journalEntryId = journalEntry.id;
  }

  return {
    journalEntryId,
    migratedCount: payloadItems.length,
    skippedCount: input.preview.items.length - readyItems.length,
    migratedMangaIds,
    migratedSourceMangaIds,
    failedItems,
  };
}

export async function undoMangaMigration(journalEntryId: string): Promise<void> {
  const entry = await getMigrationJournalEntry(journalEntryId);
  if (!entry || entry.contentKind !== "manga") {
    throw new Error("The requested manga migration journal entry was not found.");
  }
  if (entry.status !== "applied") {
    throw new Error("This manga migration can no longer be undone.");
  }

  const payload = entry.payload as MangaMigrationUndoPayload | MangaMassMigrationUndoPayload;
  const items = "items" in payload
    ? payload.items
    : [payload];

  try {
    for (const item of items) {
      await restoreMangaSnapshot(item.oldState);
      await restoreMangaSnapshot(item.newState);
    }
    await markMigrationJournalEntryUndone(entry.id);
  } catch (error) {
    await markMigrationJournalEntryFailed(entry.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
