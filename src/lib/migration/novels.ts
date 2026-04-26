import type { NovelRepositoryScopeInput } from "../novels/repositoryState";
import type { NovelDetailRecord, PersistedNovelChapterEntry, PersistedNovelLibraryState } from "../novels/domain";
import {
  getNovelLibraryChapters,
  getNovelLibraryEntry,
  loadNovelLibraryState,
  removeNovelFromLibraryState,
  restoreNovelLibraryStateSlice,
  saveNovelLibraryState,
  snapshotNovelLibraryStateSlice,
  upsertNovelInLibrary,
} from "../novels/libraryState";
import {
  appendMigrationJournalEntry,
  buildMigrationJournalEntry,
  getMigrationJournalEntry,
  markMigrationJournalEntryFailed,
  markMigrationJournalEntryUndone,
} from "./journalState";
import type {
  NovelMassMigrationUndoPayload,
  NovelMigrationStateSlice,
  NovelMigrationUndoPayload,
} from "./types";
import { readInstalledNovelDetails, searchInstalledNovelSource } from "../novels/sources";

export interface NovelMigrationPreview {
  transferredReadCount: number;
  transferredBookmarkCount: number;
  matchedChapterCount: number;
  chapterDiff: number;
  confidence: number;
}

interface NovelMigrationMatch {
  detail: NovelDetailRecord;
  similarity: number;
}

export type MassNovelMigrationStatus = "ready" | "needs-review" | "blocked";

export interface MassNovelMigrationPreviewItem {
  currentNovelId: string;
  currentTitle: string;
  currentSourceId: string;
  status: MassNovelMigrationStatus;
  reasonCode: string;
  match: NovelMigrationMatch | null;
  preview: NovelMigrationPreview | null;
}

export interface MassNovelMigrationPreview {
  sourceFrom: string;
  sourceTo: string;
  items: MassNovelMigrationPreviewItem[];
  readyCount: number;
  needsReviewCount: number;
  blockedCount: number;
}

interface MatchedChapterPair {
  oldChapter: PersistedNovelChapterEntry;
  newChapter: NovelDetailRecord["chapters"][number];
}

function normalizeLookupText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleSimilarity(left: string, right: string): number {
  const a = new Set(normalizeLookupText(left).split(/\s+/).filter(Boolean));
  const b = new Set(normalizeLookupText(right).split(/\s+/).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function matchNovelChapters(
  oldChapters: PersistedNovelChapterEntry[],
  newDetail: NovelDetailRecord,
): MatchedChapterPair[] {
  const unmatched = [...newDetail.chapters];
  const pairs: MatchedChapterPair[] = [];

  for (const oldChapter of oldChapters) {
    let index = unmatched.findIndex((candidate) => candidate.path === oldChapter.path);
    if (index < 0) {
      const normalizedOldTitle = normalizeLookupText(oldChapter.title);
      index = unmatched.findIndex((candidate) => normalizeLookupText(candidate.title) === normalizedOldTitle);
    }
    if (index < 0 && oldChapter.order < unmatched.length) {
      index = unmatched.findIndex((candidate) => candidate.order === oldChapter.order);
    }
    if (index < 0) continue;

    const [newChapter] = unmatched.splice(index, 1);
    if (!newChapter) continue;
    pairs.push({ oldChapter, newChapter });
  }

  return pairs;
}

function buildPreview(
  oldTitle: string,
  oldChapters: PersistedNovelChapterEntry[],
  oldState: PersistedNovelLibraryState,
  targetDetail: NovelDetailRecord,
): NovelMigrationPreview {
  const matched = matchNovelChapters(oldChapters, targetDetail);
  const matchedIds = new Set(matched.map((pair) => pair.oldChapter.id));
  const transferredReadCount = oldChapters.filter((chapter) => matchedIds.has(chapter.id) && !chapter.unread).length;
  const transferredBookmarkCount = oldState.bookmarks.filter((bookmark) => (
    bookmark.novelId === targetDetail.id || matched.some((pair) => pair.oldChapter.id === bookmark.chapterId)
  )).length;
  return {
    transferredReadCount,
    transferredBookmarkCount,
    matchedChapterCount: matched.length,
    chapterDiff: targetDetail.chapters.length - oldChapters.length,
    confidence: titleSimilarity(oldTitle, targetDetail.title),
  };
}

function remapNovelState(
  oldState: PersistedNovelLibraryState,
  currentNovelId: string,
  targetDetail: NovelDetailRecord,
): PersistedNovelLibraryState {
  const oldSlice = snapshotNovelLibraryStateSlice(oldState, currentNovelId);
  const currentChapters = oldSlice.chapters;
  const matches = matchNovelChapters(currentChapters, targetDetail);
  const mappedByOldId = new Map(matches.map((pair) => [pair.oldChapter.id, pair.newChapter] as const));
  const nextState = upsertNovelInLibrary(oldState, targetDetail);

  const remappedChapters = nextState.chapters.map((chapter) => {
    if (chapter.novelId !== targetDetail.id) {
      return chapter;
    }

    const oldMatch = matches.find((pair) => pair.newChapter.id === chapter.id || pair.newChapter.path === chapter.path);
    if (!oldMatch) {
      return chapter;
    }

    return {
      ...chapter,
      unread: oldMatch.oldChapter.unread,
    };
  });

  const oldProgress = oldState.progress.find((entry) => entry.novelId === currentNovelId) ?? null;
  const oldBookmarks = oldState.bookmarks.filter((entry) => entry.novelId === currentNovelId);
  const oldHistory = oldState.history.filter((entry) => entry.novelId === currentNovelId);

  const progress = oldProgress
    ? (() => {
        const mapped = oldProgress.chapterId ? mappedByOldId.get(oldProgress.chapterId) : null;
        return [{
          ...oldProgress,
          novelId: targetDetail.id,
          chapterId: mapped?.id ?? mapped?.path ?? oldProgress.chapterId,
          chapterTitle: mapped?.title ?? oldProgress.chapterTitle,
          locator: mapped?.id ?? oldProgress.locator,
        }];
      })()
    : [];

  const bookmarks = oldBookmarks.map((bookmark) => {
    const mapped = bookmark.chapterId ? mappedByOldId.get(bookmark.chapterId) : null;
    return {
      ...bookmark,
      novelId: targetDetail.id,
      chapterId: mapped?.id ?? bookmark.chapterId,
      chapterTitle: mapped?.title ?? bookmark.chapterTitle,
      locator: mapped?.id ?? bookmark.locator,
    };
  });

  const history = oldHistory.map((entry) => {
    const mapped = entry.chapterId ? mappedByOldId.get(entry.chapterId) : null;
    return {
      ...entry,
      novelId: targetDetail.id,
      chapterId: mapped?.id ?? entry.chapterId,
      chapterTitle: mapped?.title ?? entry.chapterTitle,
      locator: mapped?.id ?? entry.locator,
    };
  });

  return {
    ...nextState,
    entries: nextState.entries.filter((entry) => entry.id !== currentNovelId),
    chapters: remappedChapters.filter((chapter) => chapter.novelId !== currentNovelId),
    progress: [
      ...nextState.progress.filter((entry) => entry.novelId !== currentNovelId && entry.novelId !== targetDetail.id),
      ...progress,
    ],
    bookmarks: [
      ...nextState.bookmarks.filter((entry) => entry.novelId !== currentNovelId && entry.novelId !== targetDetail.id),
      ...bookmarks,
    ],
    history: [
      ...history,
      ...nextState.history.filter((entry) => entry.novelId !== currentNovelId && entry.novelId !== targetDetail.id),
    ].slice(0, 200),
    updatedAtMs: Date.now(),
  };
}

async function prepareNovelMigrationOperation(input: {
  currentState: PersistedNovelLibraryState;
  currentNovelId: string;
  targetDetail: NovelDetailRecord;
}): Promise<{
  preview: NovelMigrationPreview;
  oldSlice: NovelMigrationStateSlice;
  newSlice: NovelMigrationStateSlice;
  nextState: PersistedNovelLibraryState;
  transferSummary: {
    oldItemTitle: string;
    newItemTitle: string;
    oldSourceId: string;
    newSourceId: string;
    transferredChapterCount: number;
    transferredReadCount: number;
    transferredBookmarkCount: number;
  };
}> {
  const oldSlice = snapshotNovelLibraryStateSlice(input.currentState, input.currentNovelId);
  if (!oldSlice.entry) {
    throw new Error("Only saved novels can be migrated right now.");
  }

  const preview = buildPreview(oldSlice.entry.title, oldSlice.chapters, input.currentState, input.targetDetail);
  const nextState = remapNovelState(input.currentState, input.currentNovelId, input.targetDetail);
  const newSlice = snapshotNovelLibraryStateSlice(nextState, input.targetDetail.id);

  return {
    preview,
    oldSlice,
    newSlice,
    nextState,
    transferSummary: {
      oldItemTitle: oldSlice.entry.title,
      newItemTitle: input.targetDetail.title,
      oldSourceId: oldSlice.entry.source?.sourceId ?? oldSlice.entry.source?.pluginId ?? "unknown",
      newSourceId: input.targetDetail.source.sourceId ?? input.targetDetail.source.pluginId ?? "unknown",
      transferredChapterCount: preview.matchedChapterCount,
      transferredReadCount: preview.transferredReadCount,
      transferredBookmarkCount: preview.transferredBookmarkCount,
    },
  };
}

async function fetchBestNovelMatch(input: {
  scopeInput: NovelRepositoryScopeInput;
  currentTitle: string;
  targetSourceId: string;
}): Promise<NovelMigrationMatch | null> {
  const results = await searchInstalledNovelSource(input.scopeInput, input.targetSourceId, input.currentTitle, 1);
  if (results.length === 0) {
    return null;
  }

  const scored = results
    .map((result) => ({
      result,
      similarity: titleSimilarity(input.currentTitle, result.title),
    }))
    .sort((left, right) => right.similarity - left.similarity);

  const best = scored[0];
  if (!best) {
    return null;
  }

  const detail = await readInstalledNovelDetails(input.scopeInput, input.targetSourceId, best.result.path, {
    title: best.result.title,
    coverUrl: best.result.coverUrl,
  });

  return {
    detail,
    similarity: best.similarity,
  };
}

export async function previewNovelMigration(input: {
  scopeInput: NovelRepositoryScopeInput;
  currentNovelId: string;
  targetDetail: NovelDetailRecord;
}): Promise<NovelMigrationPreview> {
  const state = await loadNovelLibraryState(input.scopeInput);
  const oldSlice = snapshotNovelLibraryStateSlice(state, input.currentNovelId);
  if (!oldSlice.entry) {
    throw new Error("Only saved novels can be migrated right now.");
  }
  return buildPreview(oldSlice.entry.title, oldSlice.chapters, state, input.targetDetail);
}

export async function applyNovelMigrationWithJournal(input: {
  scopeInput: NovelRepositoryScopeInput;
  currentNovelId: string;
  targetDetail: NovelDetailRecord;
}): Promise<{ journalEntryId: string; nextState: PersistedNovelLibraryState }> {
  const currentState = await loadNovelLibraryState(input.scopeInput);
  const prepared = await prepareNovelMigrationOperation({
    currentState,
    currentNovelId: input.currentNovelId,
    targetDetail: input.targetDetail,
  });

  await saveNovelLibraryState(prepared.nextState, input.scopeInput);

  const entry = buildMigrationJournalEntry({
    contentKind: "novel",
    sourceFrom: prepared.oldSlice.entry?.source?.sourceId ?? prepared.oldSlice.entry?.source?.pluginId ?? "unknown",
    sourceTo: input.targetDetail.source.sourceId ?? input.targetDetail.source.pluginId ?? "unknown",
    transferSummary: prepared.transferSummary,
    payload: {
      oldState: prepared.oldSlice,
      newState: prepared.newSlice,
    },
  });

  await appendMigrationJournalEntry(entry);
  return {
    journalEntryId: entry.id,
    nextState: prepared.nextState,
  };
}

export async function previewMassNovelMigration(input: {
  scopeInput: NovelRepositoryScopeInput;
  sourceFrom: string;
  sourceTo: string;
  novelIds: string[];
  readyThreshold?: number;
}): Promise<MassNovelMigrationPreview> {
  const readyThreshold = input.readyThreshold ?? 0.7;
  const state = await loadNovelLibraryState(input.scopeInput);
  const items: MassNovelMigrationPreviewItem[] = [];

  for (const novelId of input.novelIds) {
    const entry = getNovelLibraryEntry(state, novelId);
    if (!entry) {
      items.push({
        currentNovelId: novelId,
        currentTitle: "Unknown novel",
        currentSourceId: input.sourceFrom,
        status: "blocked",
        reasonCode: "missing_library_entry",
        match: null,
        preview: null,
      });
      continue;
    }

    try {
      const match = await fetchBestNovelMatch({
        scopeInput: input.scopeInput,
        currentTitle: entry.title,
        targetSourceId: input.sourceTo,
      });

      if (!match) {
        items.push({
          currentNovelId: novelId,
          currentTitle: entry.title,
          currentSourceId: entry.source?.sourceId ?? entry.source?.pluginId ?? input.sourceFrom,
          status: "blocked",
          reasonCode: "no_match_found",
          match: null,
          preview: null,
        });
        continue;
      }

      const preview = buildPreview(entry.title, getNovelLibraryChapters(state, novelId), state, match.detail);
      items.push({
        currentNovelId: novelId,
        currentTitle: entry.title,
        currentSourceId: entry.source?.sourceId ?? entry.source?.pluginId ?? input.sourceFrom,
        status: match.similarity >= readyThreshold ? "ready" : "needs-review",
        reasonCode: match.similarity >= readyThreshold ? "auto_match" : "low_confidence_match",
        match,
        preview,
      });
    } catch (error) {
      items.push({
        currentNovelId: novelId,
        currentTitle: entry.title,
        currentSourceId: entry.source?.sourceId ?? entry.source?.pluginId ?? input.sourceFrom,
        status: "blocked",
        reasonCode: error instanceof Error ? error.message : "runtime_gap",
        match: null,
        preview: null,
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

export async function applyMassNovelMigrationWithJournal(input: {
  scopeInput: NovelRepositoryScopeInput;
  preview: MassNovelMigrationPreview;
  selectedNovelIds?: string[];
}): Promise<{
  journalEntryId: string;
  migratedCount: number;
  skippedCount: number;
  migratedNovelIds: string[];
  nextState: PersistedNovelLibraryState;
}> {
  const selectedIds = new Set(input.selectedNovelIds ?? input.preview.items.map((item) => item.currentNovelId));
  const readyItems = input.preview.items.filter((item) => (
    item.status === "ready"
    && item.match
    && selectedIds.has(item.currentNovelId)
  ));

  let currentState = await loadNovelLibraryState(input.scopeInput);
  const payloadItems: NovelMigrationUndoPayload[] = [];
  let transferredChapterCount = 0;
  let transferredReadCount = 0;
  let transferredBookmarkCount = 0;

  for (const item of readyItems) {
    const prepared = await prepareNovelMigrationOperation({
      currentState,
      currentNovelId: item.currentNovelId,
      targetDetail: item.match!.detail,
    });

    payloadItems.push({
      oldState: prepared.oldSlice,
      newState: prepared.newSlice,
    });
    transferredChapterCount += prepared.transferSummary.transferredChapterCount;
    transferredReadCount += prepared.transferSummary.transferredReadCount;
    transferredBookmarkCount += prepared.transferSummary.transferredBookmarkCount;
    currentState = prepared.nextState;
  }

  await saveNovelLibraryState(currentState, input.scopeInput);

  const journalEntry = buildMigrationJournalEntry({
    contentKind: "novel",
    mode: "mass",
    sourceFrom: input.preview.sourceFrom,
    sourceTo: input.preview.sourceTo,
    transferSummary: {
      oldItemTitle: `${readyItems.length} novels`,
      newItemTitle: `${readyItems.length} migrated`,
      oldSourceId: input.preview.sourceFrom,
      newSourceId: input.preview.sourceTo,
      transferredChapterCount,
      transferredReadCount,
      transferredBookmarkCount,
    },
    payload: {
      items: payloadItems,
    } satisfies NovelMassMigrationUndoPayload,
  });

  await appendMigrationJournalEntry(journalEntry);

  return {
    journalEntryId: journalEntry.id,
    migratedCount: readyItems.length,
    skippedCount: input.preview.items.length - readyItems.length,
    migratedNovelIds: readyItems.map((item) => item.match!.detail.id),
    nextState: currentState,
  };
}

export async function undoNovelMigration(input: {
  scopeInput: NovelRepositoryScopeInput;
  journalEntryId: string;
}): Promise<PersistedNovelLibraryState> {
  const entry = await getMigrationJournalEntry(input.journalEntryId);
  if (!entry || entry.contentKind !== "novel") {
    throw new Error("The requested novel migration journal entry was not found.");
  }
  if (entry.status !== "applied") {
    throw new Error("This novel migration can no longer be undone.");
  }

  const payload = entry.payload as NovelMigrationUndoPayload | NovelMassMigrationUndoPayload;
  const items = "items" in payload
    ? payload.items
    : [payload];
  let currentState = await loadNovelLibraryState(input.scopeInput);
  try {
    for (const item of items) {
      const targetNovelId = item.newState.entry?.id;
      const withoutNew = targetNovelId
        ? removeNovelFromLibraryState(currentState, targetNovelId)
        : currentState;
      currentState = restoreNovelLibraryStateSlice(withoutNew, item.oldState);
    }
    const saved = await saveNovelLibraryState(currentState, input.scopeInput);
    await markMigrationJournalEntryUndone(entry.id);
    return saved;
  } catch (error) {
    await markMigrationJournalEntryFailed(entry.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
