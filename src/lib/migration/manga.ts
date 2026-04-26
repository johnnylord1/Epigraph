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
}

export type MassMangaMigrationStatus = "ready" | "needs-review" | "blocked";

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
}

export interface ApplyMassMangaMigrationInput {
  preview: MassMangaMigrationPreview;
  selectedMangaIds?: number[];
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
): Promise<MangaMigrationMatch | null> {
  const mangas = await fetchSourceMangaSearchWithFallback({
    sourceId: targetSourceId,
    query: currentManga.title.trim(),
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
  });

  return {
    manga: best.manga,
    chapters: chaptersResult.fetchChapters.chapters ?? [],
    similarity: best.similarity,
  };
}

function summarizeMatchedReadCount(oldChapters: Chapter[], newChapters: Chapter[]): number {
  const oldByNum = new Map(oldChapters.map((chapter) => [Math.round(chapter.chapterNumber * 100), chapter]));
  return newChapters.filter((chapter) => {
    const oldChapter = oldByNum.get(Math.round(chapter.chapterNumber * 100));
    return Boolean(oldChapter?.isRead);
  }).length;
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

  for (const newChapter of input.match.chapters) {
    const key = Math.round(newChapter.chapterNumber * 100);
    const oldChapter = oldByNum.get(key);
    if (!oldChapter) continue;
    if (oldChapter.isRead) toMarkRead.push(newChapter.id);
    if (oldChapter.isBookmarked) toMarkBookmarked.push(newChapter.id);
    if ((oldChapter.lastPageRead ?? 0) > 0 && !oldChapter.isRead) {
      progressUpdates.push({ id: newChapter.id, lastPageRead: oldChapter.lastPageRead ?? 0 });
    }
  }

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
  await gql(UPDATE_MANGA, { id: input.currentManga.id, inLibrary: false });
  await setCategoryIdsForManga(input.currentManga.id, []);

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
  const items: MassMangaMigrationPreviewItem[] = [];

  for (const item of input.items) {
    try {
      const match = await fetchBestMangaMatch(item.manga, input.sourceTo);
      if (!match) {
        items.push({
          currentManga: item.manga,
          currentChapters: item.chapters,
          status: "blocked",
          reasonCode: "no_match_found",
          match: null,
          matchedReadCount: 0,
          chapterDiff: 0,
        });
        continue;
      }

      items.push({
        currentManga: item.manga,
        currentChapters: item.chapters,
        status: match.similarity >= readyThreshold ? "ready" : "needs-review",
        reasonCode: match.similarity >= readyThreshold ? "auto_match" : "low_confidence_match",
        match,
        matchedReadCount: summarizeMatchedReadCount(item.chapters, match.chapters),
        chapterDiff: match.chapters.length - item.chapters.length,
      });
    } catch (error) {
      items.push({
        currentManga: item.manga,
        currentChapters: item.chapters,
        status: "blocked",
        reasonCode: error instanceof Error ? error.message : "runtime_gap",
        match: null,
        matchedReadCount: 0,
        chapterDiff: 0,
      });
    }
  }

  return {
    sourceFrom: input.sourceFrom,
    sourceTo: input.sourceTo,
    items,
    readyCount: items.filter((item) => item.status === "ready").length,
    needsReviewCount: items.filter((item) => item.status === "needs-review").length,
    blockedCount: items.filter((item) => item.status === "blocked").length,
  };
}

export async function applyMassMangaMigrationWithJournal(
  input: ApplyMassMangaMigrationInput,
): Promise<{ journalEntryId: string; migratedCount: number; skippedCount: number; migratedMangaIds: number[] }> {
  const selectedIds = new Set(input.selectedMangaIds ?? input.preview.items.map((item) => item.currentManga.id));
  const readyItems = input.preview.items.filter((item) => (
    item.status === "ready"
    && item.match
    && selectedIds.has(item.currentManga.id)
  ));

  const payloadItems: MangaMigrationUndoPayload[] = [];
  let transferredChapterCount = 0;
  let transferredReadCount = 0;
  let transferredBookmarkCount = 0;

  for (const item of readyItems) {
    const prepared = await prepareMangaMigrationOperation({
      currentManga: item.currentManga,
      currentChapters: item.currentChapters,
      targetSourceId: input.preview.sourceTo,
      match: item.match!,
    });

    payloadItems.push({
      oldState: prepared.oldState,
      newState: prepared.newState,
    });
    transferredChapterCount += prepared.transferSummary.transferredChapterCount;
    transferredReadCount += prepared.transferSummary.transferredReadCount;
    transferredBookmarkCount += prepared.transferSummary.transferredBookmarkCount;
  }

  const journalEntry = buildMigrationJournalEntry({
    contentKind: "manga",
    mode: "mass",
    sourceFrom: input.preview.sourceFrom,
    sourceTo: input.preview.sourceTo,
    transferSummary: {
      oldItemTitle: `${readyItems.length} manga`,
      newItemTitle: `${readyItems.length} migrated`,
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

  return {
    journalEntryId: journalEntry.id,
    migratedCount: readyItems.length,
    skippedCount: input.preview.items.length - readyItems.length,
    migratedMangaIds: readyItems.map((item) => item.match!.manga.id),
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
