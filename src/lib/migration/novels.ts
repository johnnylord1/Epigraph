import type { NovelRepositoryScopeInput } from "../novels/repositoryState";
import type {
  AethonNovelBookmarkEntry,
  AethonNovelHistoryEntry,
  AethonNovelProgressEntry,
} from "../backup/novelsBackup";
import type { NovelDetailRecord, PersistedNovelChapterEntry, PersistedNovelLibraryState } from "../novels/domain";
import {
  getNovelLibraryChapters,
  getNovelLibraryEntry,
  loadNovelLibraryState,
  reloadNovelLibraryState,
  removeNovelFromLibraryState,
  restoreNovelLibraryStateSlice,
  saveNovelLibraryState,
  snapshotNovelLibraryStateSlice,
  upsertNovelInLibrary,
} from "../novels/libraryState";
import { getMigrationJournalEntry, getMigrationOperation } from "./journalState";
import {
  beginMigrationOperation,
  commitMigrationOperation,
  markMigrationCompensated,
  markMigrationNeedsManualRecovery,
  runMigrationStep,
  transitionMigrationOperation,
  withMigrationProfileLock,
} from "./coordinator";
import { matchNovelChapters } from "./chapterMapping";
import type {
  NovelMassMigrationUndoPayload,
  NovelMigrationStateSlice,
  NovelMigrationUndoPayload,
} from "./types";
import { readInstalledNovelDetails, searchInstalledNovelSource } from "../novels/sources";

function migrationProfileId(scopeInput: NovelRepositoryScopeInput): string {
  return scopeInput.profileId?.trim()
    || scopeInput.serverUrl?.trim()
    || "main";
}

async function compensateNovelOperation(
  operationId: string,
  restore: () => Promise<void>,
): Promise<void> {
  await transitionMigrationOperation(operationId, "compensating");
  try {
    await restore();
    await markMigrationCompensated(operationId);
  } catch (error) {
    await markMigrationNeedsManualRecovery(
      operationId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

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

function buildPreview(
  oldTitle: string,
  oldChapters: PersistedNovelChapterEntry[],
  oldState: PersistedNovelLibraryState,
  targetDetail: NovelDetailRecord,
): NovelMigrationPreview {
  const matched = matchNovelChapters(oldChapters, targetDetail.chapters);
  const targetStateById = new Map(
    oldState.chapters
      .filter((chapter) => chapter.novelId === targetDetail.id)
      .map((chapter) => [chapter.id, chapter] as const),
  );
  const matchedByOldId = new Map(matched.map((pair) => [pair.oldChapter.id, pair] as const));
  const transferredReadCount = matched.filter(({ oldChapter, newChapter }) => {
    const targetState = targetStateById.get(newChapter.id);
    return !oldChapter.unread && (targetState?.unread ?? newChapter.unread);
  }).length;
  const existingTargetBookmarkKeys = new Set(
    oldState.bookmarks
      .filter((bookmark) => bookmark.novelId === targetDetail.id)
      .map((bookmark) => `${bookmark.chapterId ?? ""}|${bookmark.label ?? ""}`),
  );
  const transferredBookmarkCount = oldState.bookmarks.filter((bookmark) => {
    const pair = bookmark.chapterId ? matchedByOldId.get(bookmark.chapterId) : null;
    return Boolean(
      pair
      && bookmark.novelId === pair.oldChapter.novelId
      && !existingTargetBookmarkKeys.has(`${pair.newChapter.id}|${bookmark.label ?? ""}`),
    );
  }).length;
  return {
    transferredReadCount,
    transferredBookmarkCount,
    matchedChapterCount: matched.length,
    chapterDiff: targetDetail.chapters.length - oldChapters.length,
    confidence: titleSimilarity(oldTitle, targetDetail.title),
  };
}

function chooseFurthestProgress(
  existing: AethonNovelProgressEntry | null,
  migrated: AethonNovelProgressEntry | null,
  targetDetail: NovelDetailRecord,
): AethonNovelProgressEntry | null {
  if (!existing) return migrated;
  if (!migrated) return existing;

  const orderByChapterId = new Map(
    targetDetail.chapters.flatMap((chapter) => [
      [chapter.id, chapter.order] as const,
      [chapter.path, chapter.order] as const,
    ]),
  );
  const existingOrder = existing.chapterId ? orderByChapterId.get(existing.chapterId) : undefined;
  const migratedOrder = migrated.chapterId ? orderByChapterId.get(migrated.chapterId) : undefined;

  if (existingOrder === undefined || migratedOrder === undefined) {
    return existing;
  }
  if (migratedOrder !== existingOrder) {
    return migratedOrder > existingOrder ? migrated : existing;
  }
  if (migrated.progressPercent !== existing.progressPercent) {
    return migrated.progressPercent > existing.progressPercent ? migrated : existing;
  }
  return migrated.updatedAt > existing.updatedAt ? migrated : existing;
}

function deduplicateBookmarks(entries: AethonNovelBookmarkEntry[]): AethonNovelBookmarkEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = [
      entry.novelId,
      entry.chapterId ?? "",
      entry.locator ?? "",
      entry.label ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateHistory(entries: AethonNovelHistoryEntry[]): AethonNovelHistoryEntry[] {
  const seen = new Set<string>();
  return entries
    .sort((left, right) => right.readAt - left.readAt)
    .filter((entry) => {
      const key = [
        entry.novelId,
        entry.chapterId ?? "",
        entry.locator ?? "",
        entry.readAt,
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 200);
}

function remapNovelState(
  oldState: PersistedNovelLibraryState,
  currentNovelId: string,
  targetDetail: NovelDetailRecord,
): PersistedNovelLibraryState {
  const oldSlice = snapshotNovelLibraryStateSlice(oldState, currentNovelId);
  const currentChapters = oldSlice.chapters;
  const matches = matchNovelChapters(currentChapters, targetDetail.chapters);
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
      unread: chapter.unread && oldMatch.oldChapter.unread,
    };
  });

  const oldProgressEntries = oldState.progress.filter((entry) => entry.novelId === currentNovelId);
  const existingTargetProgressEntries = oldState.progress.filter((entry) => entry.novelId === targetDetail.id);
  const oldBookmarks = oldState.bookmarks.filter((entry) => entry.novelId === currentNovelId);
  const existingTargetBookmarks = oldState.bookmarks.filter((entry) => entry.novelId === targetDetail.id);
  const oldHistory = oldState.history.filter((entry) => entry.novelId === currentNovelId);
  const existingTargetHistory = oldState.history.filter((entry) => entry.novelId === targetDetail.id);

  const mappedProgressEntries: AethonNovelProgressEntry[] = [];
  const preservedUnmappedProgress: AethonNovelProgressEntry[] = [];
  for (const progressEntry of oldProgressEntries) {
    const mapped = progressEntry.chapterId ? mappedByOldId.get(progressEntry.chapterId) : null;
    if (!mapped) {
      preservedUnmappedProgress.push(progressEntry);
      continue;
    }
    mappedProgressEntries.push({
      ...progressEntry,
      novelId: targetDetail.id,
      chapterId: mapped.id || mapped.path,
      chapterTitle: mapped.title,
      locator: mapped.id || mapped.path,
    });
  }
  const targetProgress = [...existingTargetProgressEntries, ...mappedProgressEntries]
    .reduce<AethonNovelProgressEntry | null>(
      (selected, candidate) => chooseFurthestProgress(selected, candidate, targetDetail),
      null,
    );

  const mappedBookmarks: AethonNovelBookmarkEntry[] = [];
  const preservedUnmappedBookmarks: AethonNovelBookmarkEntry[] = [];
  for (const bookmark of oldBookmarks) {
    const mapped = bookmark.chapterId ? mappedByOldId.get(bookmark.chapterId) : null;
    if (!mapped) {
      preservedUnmappedBookmarks.push(bookmark);
      continue;
    }
    mappedBookmarks.push({
      ...bookmark,
      novelId: targetDetail.id,
      chapterId: mapped.id || mapped.path,
      chapterTitle: mapped.title,
      locator: mapped.id || mapped.path,
    });
  }

  const mappedHistory: AethonNovelHistoryEntry[] = [];
  const preservedUnmappedHistory: AethonNovelHistoryEntry[] = [];
  for (const entry of oldHistory) {
    const mapped = entry.chapterId ? mappedByOldId.get(entry.chapterId) : null;
    if (!mapped) {
      preservedUnmappedHistory.push(entry);
      continue;
    }
    mappedHistory.push({
      ...entry,
      novelId: targetDetail.id,
      chapterId: mapped.id || mapped.path,
      chapterTitle: mapped.title,
      locator: mapped.id || mapped.path,
    });
  }

  return {
    ...nextState,
    entries: nextState.entries.filter((entry) => entry.id !== currentNovelId),
    chapters: remappedChapters.filter((chapter) => chapter.novelId !== currentNovelId),
    progress: [
      ...nextState.progress.filter((entry) => entry.novelId !== currentNovelId && entry.novelId !== targetDetail.id),
      ...preservedUnmappedProgress,
      ...(targetProgress ? [targetProgress] : []),
    ],
    bookmarks: deduplicateBookmarks([
      ...nextState.bookmarks.filter((entry) => entry.novelId !== currentNovelId && entry.novelId !== targetDetail.id),
      ...preservedUnmappedBookmarks,
      ...existingTargetBookmarks,
      ...mappedBookmarks,
    ]),
    history: deduplicateHistory([
      ...preservedUnmappedHistory,
      ...existingTargetHistory,
      ...mappedHistory,
      ...nextState.history.filter((entry) => entry.novelId !== currentNovelId && entry.novelId !== targetDetail.id),
    ]),
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
  const profileId = migrationProfileId(input.scopeInput);
  return withMigrationProfileLock(profileId, async () => {
    const currentState = await loadNovelLibraryState(input.scopeInput);
    const prepared = await prepareNovelMigrationOperation({
      currentState,
      currentNovelId: input.currentNovelId,
      targetDetail: input.targetDetail,
    });
    const operation = await beginMigrationOperation({
      profileId,
      contentKind: "novel",
      sourceFrom: prepared.oldSlice.entry?.source?.sourceId ?? prepared.oldSlice.entry?.source?.pluginId ?? "unknown",
      sourceTo: input.targetDetail.source.sourceId ?? input.targetDetail.source.pluginId ?? "unknown",
      transferSummary: prepared.transferSummary,
      payload: { oldState: prepared.oldSlice, newState: prepared.newSlice },
      steps: [{ stepId: "novel-library-state", kind: "local" }],
    });
    await transitionMigrationOperation(operation.operationId, "preparing");
    await transitionMigrationOperation(operation.operationId, "applying");
    try {
      await runMigrationStep({
        operationId: operation.operationId,
        stepId: "novel-library-state",
        apply: async () => {
          await saveNovelLibraryState(prepared.nextState, input.scopeInput);
        },
        verify: async () => {
          const reloaded = await reloadNovelLibraryState(input.scopeInput);
          if (
            !getNovelLibraryEntry(reloaded, input.targetDetail.id)
            || getNovelLibraryEntry(reloaded, input.currentNovelId)
          ) {
            throw new Error("Novel migration state could not be verified after persistence.");
          }
        },
      });
      await commitMigrationOperation(operation.operationId);
    } catch (error) {
      await compensateNovelOperation(operation.operationId, async () => {
        await saveNovelLibraryState(currentState, input.scopeInput);
      }).catch(() => undefined);
      throw error;
    }
    return {
      journalEntryId: operation.operationId,
      nextState: prepared.nextState,
    };
  });
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
  const profileId = migrationProfileId(input.scopeInput);
  return withMigrationProfileLock(profileId, async () => {
    const selectedIds = new Set(input.selectedNovelIds ?? input.preview.items.map((item) => item.currentNovelId));
    const readyItems = input.preview.items.filter((item) => (
      item.status === "ready"
      && item.match
      && selectedIds.has(item.currentNovelId)
    ));

    const initialState = await loadNovelLibraryState(input.scopeInput);
    let currentState = initialState;
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
      payloadItems.push({ oldState: prepared.oldSlice, newState: prepared.newSlice });
      transferredChapterCount += prepared.transferSummary.transferredChapterCount;
      transferredReadCount += prepared.transferSummary.transferredReadCount;
      transferredBookmarkCount += prepared.transferSummary.transferredBookmarkCount;
      currentState = prepared.nextState;
    }

    const operation = await beginMigrationOperation({
      profileId,
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
      payload: { items: payloadItems } satisfies NovelMassMigrationUndoPayload,
      steps: [{ stepId: "novel-library-state", kind: "local" }],
    });
    await transitionMigrationOperation(operation.operationId, "preparing");
    await transitionMigrationOperation(operation.operationId, "applying");
    try {
      await runMigrationStep({
        operationId: operation.operationId,
        stepId: "novel-library-state",
        apply: async () => {
          await saveNovelLibraryState(currentState, input.scopeInput);
        },
        verify: async () => {
          const reloaded = await reloadNovelLibraryState(input.scopeInput);
          const allTargetsPresent = readyItems.every((item) => (
            item.match && getNovelLibraryEntry(reloaded, item.match.detail.id)
          ));
          const allSourcesRemoved = readyItems.every((item) => (
            !getNovelLibraryEntry(reloaded, item.currentNovelId)
          ));
          if (!allTargetsPresent || !allSourcesRemoved) {
            throw new Error("Mass novel migration state could not be verified after persistence.");
          }
        },
      });
      await commitMigrationOperation(operation.operationId);
    } catch (error) {
      await compensateNovelOperation(operation.operationId, async () => {
        await saveNovelLibraryState(initialState, input.scopeInput);
      }).catch(() => undefined);
      throw error;
    }

    return {
      journalEntryId: operation.operationId,
      migratedCount: readyItems.length,
      skippedCount: input.preview.items.length - readyItems.length,
      migratedNovelIds: readyItems.map((item) => item.match!.detail.id),
      nextState: currentState,
    };
  });
}

export async function undoNovelMigration(input: {
  scopeInput: NovelRepositoryScopeInput;
  journalEntryId: string;
}): Promise<PersistedNovelLibraryState> {
  const operation = await getMigrationOperation(input.journalEntryId);
  const profileId = operation?.profileId ?? migrationProfileId(input.scopeInput);
  return withMigrationProfileLock(profileId, async () => {
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
    await transitionMigrationOperation(entry.id, "compensating");
    try {
      for (const item of [...items].reverse()) {
        const targetNovelId = item.newState.entry?.id;
        const withoutNew = targetNovelId
          ? removeNovelFromLibraryState(currentState, targetNovelId)
          : currentState;
        currentState = restoreNovelLibraryStateSlice(withoutNew, item.oldState);
      }
      const saved = await saveNovelLibraryState(currentState, input.scopeInput);
      await markMigrationCompensated(entry.id);
      return saved;
    } catch (error) {
      await markMigrationNeedsManualRecovery(entry.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
}
