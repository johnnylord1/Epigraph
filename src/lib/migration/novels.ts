import type { NovelRepositoryScopeInput } from "../novels/repositoryState";
import type {
  EpigraphNovelBookmarkEntry,
  EpigraphNovelHistoryEntry,
  EpigraphNovelProgressEntry,
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
  beginMigrationChildOperation,
  beginMigrationOperation,
  checkpointMigrationPayload,
  commitMigrationOperation,
  markMigrationCompensated,
  markMigrationNeedsManualRecovery,
  runMigrationStep,
  transitionMigrationOperation,
  withMigrationProfileLock,
} from "./coordinator";
import { matchNovelChapters } from "./chapterMapping";
import {
  copyVerifiedNovelOfflineAssets,
  type NovelOfflineAssetCachePort,
  type ProvenOfflineAssetPair,
} from "./offlineAssets";
import type {
  NovelMassMigrationUndoPayload,
  NovelMigrationStateSlice,
  NovelMigrationUndoPayload,
} from "./types";
import { readInstalledNovelDetails, searchInstalledNovelSource } from "../novels/sources";
import {
  loadHardcoverState,
  saveHardcoverState,
  type HardcoverTrackingState,
} from "../novels/hardcover";
import {
  hardcoverBindingMatchesSlice,
  prepareHardcoverBindingMigration,
  replaceHardcoverBindingSlice,
  type HardcoverBindingSlice,
  type PreparedHardcoverBindingMigration,
} from "./hardcoverBinding";
import {
  migrationIdentityMatchesSlice,
  migrationIdentityRevision,
  prepareNovelIdentityMigration,
  restoreMigrationIdentitySlice,
  type MigrationIdentityBridge,
  type MigrationIdentityRevision,
} from "./identity";
import {
  loadCachedNovelChapter,
  saveCachedNovelChapter,
} from "../novels/offlineChapters";

function migrationProfileId(scopeInput: NovelRepositoryScopeInput): string {
  return scopeInput.profileId?.trim()
    || scopeInput.serverUrl?.trim()
    || "main";
}

function createNovelOfflineAssetCachePort(
  scopeInput: NovelRepositoryScopeInput,
): NovelOfflineAssetCachePort {
  return {
    async inspect(reference) {
      if (!reference.chapterPath) return null;
      const cached = await loadCachedNovelChapter(
        scopeInput,
        reference.sourceId,
        reference.chapterPath,
      );
      if (!cached) return null;
      return {
        bytes: new TextEncoder().encode(cached.content),
        valid: cached.sourceId === reference.sourceId
          && cached.chapterPath === reference.chapterPath
          && cached.content.trim().length > 0,
      };
    },
    async write(reference, bytes) {
      if (!reference.chapterPath) {
        throw new Error("Novel offline assets require a chapter path.");
      }
      const saved = await saveCachedNovelChapter(scopeInput, {
        sourceId: reference.sourceId,
        novelId: reference.titleId,
        chapterId: reference.chapterId,
        chapterPath: reference.chapterPath,
        content: new TextDecoder().decode(bytes),
      });
      if (!saved) {
        throw new Error("Novel offline asset could not be persisted.");
      }
    },
  };
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
  existing: EpigraphNovelProgressEntry | null,
  migrated: EpigraphNovelProgressEntry | null,
  targetDetail: NovelDetailRecord,
): EpigraphNovelProgressEntry | null {
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

function deduplicateBookmarks(entries: EpigraphNovelBookmarkEntry[]): EpigraphNovelBookmarkEntry[] {
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

function deduplicateHistory(entries: EpigraphNovelHistoryEntry[]): EpigraphNovelHistoryEntry[] {
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

  const mappedProgressEntries: EpigraphNovelProgressEntry[] = [];
  const preservedUnmappedProgress: EpigraphNovelProgressEntry[] = [];
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
    .reduce<EpigraphNovelProgressEntry | null>(
      (selected, candidate) => chooseFurthestProgress(selected, candidate, targetDetail),
      null,
    );

  const mappedBookmarks: EpigraphNovelBookmarkEntry[] = [];
  const preservedUnmappedBookmarks: EpigraphNovelBookmarkEntry[] = [];
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

  const mappedHistory: EpigraphNovelHistoryEntry[] = [];
  const preservedUnmappedHistory: EpigraphNovelHistoryEntry[] = [];
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
  scopeInput: NovelRepositoryScopeInput;
  currentState: PersistedNovelLibraryState;
  currentNovelId: string;
  targetDetail: NovelDetailRecord;
  identityRevision?: MigrationIdentityRevision;
  hardcoverState?: HardcoverTrackingState;
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
  identity?: ReturnType<typeof prepareNovelIdentityMigration>;
  hardcover: PreparedHardcoverBindingMigration;
  offlinePairs: ProvenOfflineAssetPair[];
}> {
  const oldSlice = snapshotNovelLibraryStateSlice(input.currentState, input.currentNovelId);
  if (!oldSlice.entry) {
    throw new Error("Only saved novels can be migrated right now.");
  }

  const preview = buildPreview(oldSlice.entry.title, oldSlice.chapters, input.currentState, input.targetDetail);
  const sourceId = oldSlice.entry.source?.sourceId
    ?? oldSlice.entry.source?.pluginId
    ?? "unknown";
  const targetSourceId = input.targetDetail.source.sourceId
    ?? input.targetDetail.source.pluginId
    ?? "unknown";
  const offlinePairs: ProvenOfflineAssetPair[] = matchNovelChapters(
    oldSlice.chapters,
    input.targetDetail.chapters,
  ).map(({ oldChapter, newChapter }) => ({
    source: {
      sourceId,
      titleId: input.currentNovelId,
      chapterId: oldChapter.id,
      chapterPath: oldChapter.path,
    },
    target: {
      sourceId: targetSourceId,
      titleId: input.targetDetail.id,
      chapterId: newChapter.id,
      chapterPath: newChapter.path,
    },
  }));
  const nextState = remapNovelState(input.currentState, input.currentNovelId, input.targetDetail);
  const identity = input.identityRevision
    ? prepareNovelIdentityMigration({
        current: input.identityRevision.settings,
        sourceNovelId: input.currentNovelId,
        targetNovelId: input.targetDetail.id,
      })
    : undefined;
  const hardcoverState = input.hardcoverState ?? loadHardcoverState(input.scopeInput);
  const hardcover = prepareHardcoverBindingMigration({
    records: hardcoverState.records,
    sourceNovelId: input.currentNovelId,
    targetNovelId: input.targetDetail.id,
  });
  const newSlice = snapshotNovelLibraryStateSlice(nextState, input.targetDetail.id);
  oldSlice.localIdentity = identity?.previous;
  oldSlice.hardcoverBinding = hardcover.previous;
  newSlice.localIdentity = identity?.applied;
  newSlice.hardcoverBinding = hardcover.applied;

  return {
    preview,
    oldSlice,
    newSlice,
    nextState,
    identity,
    hardcover,
    offlinePairs,
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

function saveVerifiedHardcoverSlice(
  scopeInput: NovelRepositoryScopeInput,
  expected: HardcoverBindingSlice,
  next: HardcoverBindingSlice,
): HardcoverTrackingState {
  const current = loadHardcoverState(scopeInput);
  const records = replaceHardcoverBindingSlice(current.records, expected, next);
  const saved = saveHardcoverState({ ...current, records }, scopeInput);
  const reloaded = loadHardcoverState(scopeInput);
  if (!hardcoverBindingMatchesSlice(saved.records, next)
    || !hardcoverBindingMatchesSlice(reloaded.records, next)) {
    throw new Error("The Hardcover source binding could not be persisted.");
  }
  return reloaded;
}

async function restoreNovelIdentityState(input: {
  bridge?: MigrationIdentityBridge;
  prepared: Awaited<ReturnType<typeof prepareNovelMigrationOperation>>;
  scopeInput: NovelRepositoryScopeInput;
}): Promise<void> {
  const currentHardcover = loadHardcoverState(input.scopeInput);
  if (!hardcoverBindingMatchesSlice(currentHardcover.records, input.prepared.hardcover.previous)) {
    if (!hardcoverBindingMatchesSlice(currentHardcover.records, input.prepared.hardcover.applied)) {
      throw new Error("Hardcover identity changed after migration; automatic compensation was stopped.");
    }
    const restored = saveVerifiedHardcoverSlice(
      input.scopeInput,
      input.prepared.hardcover.applied,
      input.prepared.hardcover.previous,
    );
    if (!hardcoverBindingMatchesSlice(restored.records, input.prepared.hardcover.previous)) {
      throw new Error("The previous Hardcover binding could not be restored.");
    }
  }

  if (input.bridge && input.prepared.identity) {
    const current = await input.bridge.read();
    if (!migrationIdentityMatchesSlice(current.settings, input.prepared.identity.previous)) {
      if (!migrationIdentityMatchesSlice(current.settings, input.prepared.identity.applied)) {
        throw new Error("Migration links or folders changed after migration; automatic compensation was stopped.");
      }
      const restored = restoreMigrationIdentitySlice(
        current.settings,
        input.prepared.identity.previous,
      );
      await input.bridge.write({
        expectedRevision: current.revision,
        next: restored,
      });
    }
  }
}

async function restoreNovelJournalIdentity(input: {
  bridge?: MigrationIdentityBridge;
  oldState: NovelMigrationStateSlice;
  newState: NovelMigrationStateSlice;
  scopeInput: NovelRepositoryScopeInput;
}): Promise<void> {
  if (input.oldState.hardcoverBinding && input.newState.hardcoverBinding) {
    const current = loadHardcoverState(input.scopeInput);
    if (!hardcoverBindingMatchesSlice(current.records, input.oldState.hardcoverBinding)) {
      if (!hardcoverBindingMatchesSlice(current.records, input.newState.hardcoverBinding)) {
        throw new Error("Hardcover identity changed after migration; undo requires manual recovery.");
      }
      const restored = saveVerifiedHardcoverSlice(
        input.scopeInput,
        input.newState.hardcoverBinding,
        input.oldState.hardcoverBinding,
      );
      if (!hardcoverBindingMatchesSlice(restored.records, input.oldState.hardcoverBinding)) {
        throw new Error("The previous Hardcover binding could not be restored.");
      }
    }
  }

  if (input.bridge && input.oldState.localIdentity && input.newState.localIdentity) {
    const current = await input.bridge.read();
    if (!migrationIdentityMatchesSlice(current.settings, input.oldState.localIdentity)) {
      if (!migrationIdentityMatchesSlice(current.settings, input.newState.localIdentity)) {
        throw new Error("Migration links or folders changed after migration; undo requires manual recovery.");
      }
      await input.bridge.write({
        expectedRevision: current.revision,
        next: restoreMigrationIdentitySlice(current.settings, input.oldState.localIdentity),
      });
    }
  }
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
  identityBridge?: MigrationIdentityBridge;
}): Promise<{ journalEntryId: string; nextState: PersistedNovelLibraryState }> {
  const profileId = migrationProfileId(input.scopeInput);
  return withMigrationProfileLock(profileId, async () => {
    const currentState = await loadNovelLibraryState(input.scopeInput);
    const identityRevision = input.identityBridge
      ? await input.identityBridge.read()
      : undefined;
    const hardcoverState = loadHardcoverState(input.scopeInput);
    const prepared = await prepareNovelMigrationOperation({
      scopeInput: input.scopeInput,
      currentState,
      currentNovelId: input.currentNovelId,
      targetDetail: input.targetDetail,
      identityRevision,
      hardcoverState,
    });
    const operation = await beginMigrationOperation({
      profileId,
      contentKind: "novel",
      sourceFrom: prepared.oldSlice.entry?.source?.sourceId ?? prepared.oldSlice.entry?.source?.pluginId ?? "unknown",
      sourceTo: input.targetDetail.source.sourceId ?? input.targetDetail.source.pluginId ?? "unknown",
      transferSummary: prepared.transferSummary,
      payload: {
        oldState: prepared.oldSlice,
        newState: prepared.newSlice,
        offlineAssets: [],
      },
      steps: [
        { stepId: "novel-library-state", kind: "local" },
        { stepId: "novel-offline-assets", kind: "filesystem" },
        ...(prepared.identity ? [{ stepId: "novel-local-identity", kind: "link" as const }] : []),
        { stepId: "novel-hardcover-binding", kind: "tracker" },
      ],
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
      let offlineAssets = [] as Awaited<ReturnType<typeof copyVerifiedNovelOfflineAssets>>;
      await runMigrationStep({
        operationId: operation.operationId,
        stepId: "novel-offline-assets",
        apply: async () => {
          offlineAssets = await copyVerifiedNovelOfflineAssets(
            prepared.offlinePairs,
            createNovelOfflineAssetCachePort(input.scopeInput),
          );
          await checkpointMigrationPayload(operation.operationId, {
            oldState: prepared.oldSlice,
            newState: prepared.newSlice,
            offlineAssets,
          });
        },
        verify: async () => {
          if (offlineAssets.some((asset) => !asset.sourcePreserved)) {
            throw new Error("Novel offline asset source preservation could not be verified.");
          }
        },
      });
      if (prepared.identity) {
        await runMigrationStep({
          operationId: operation.operationId,
          stepId: "novel-local-identity",
          apply: async () => {
            await input.identityBridge!.write({
              expectedRevision: identityRevision!.revision,
              next: prepared.identity!.next,
            });
          },
          verify: async () => {
            const current = await input.identityBridge!.read();
            if (!migrationIdentityMatchesSlice(current.settings, prepared.identity!.applied)) {
              throw new Error("Novel links or folders were not persisted.");
            }
          },
        });
      }
      await runMigrationStep({
        operationId: operation.operationId,
        stepId: "novel-hardcover-binding",
        apply: async () => {
          const persisted = saveVerifiedHardcoverSlice(
            input.scopeInput,
            prepared.hardcover.previous,
            prepared.hardcover.applied,
          );
          if (!hardcoverBindingMatchesSlice(persisted.records, prepared.hardcover.applied)) {
            throw new Error("The Hardcover source binding could not be persisted.");
          }
        },
        verify: async () => {
          const current = loadHardcoverState(input.scopeInput);
          if (!hardcoverBindingMatchesSlice(current.records, prepared.hardcover.applied)) {
            throw new Error("The Hardcover source binding could not be verified.");
          }
        },
      });
      await commitMigrationOperation(operation.operationId);
    } catch (error) {
      await compensateNovelOperation(operation.operationId, async () => {
        await restoreNovelIdentityState({
          bridge: input.identityBridge,
          prepared,
          scopeInput: input.scopeInput,
        });
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
  identityBridge?: MigrationIdentityBridge;
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
    const initialIdentityRevision = input.identityBridge
      ? await input.identityBridge.read()
      : undefined;
    let plannedIdentityRevision = initialIdentityRevision;
    const initialHardcoverState = loadHardcoverState(input.scopeInput);
    let plannedHardcoverState = initialHardcoverState;
    let currentState = initialState;
    const payloadItems: NovelMigrationUndoPayload[] = [];
    const preparedItems: Array<{
      prepared: Awaited<ReturnType<typeof prepareNovelMigrationOperation>>;
      previousState: PersistedNovelLibraryState;
    }> = [];
    let transferredChapterCount = 0;
    let transferredReadCount = 0;
    let transferredBookmarkCount = 0;

    const targetIds = readyItems.map((item) => item.match!.detail.id);
    if (new Set(targetIds).size !== targetIds.length) {
      throw new Error("Mass migration cannot map multiple novels to the same target identity.");
    }

    for (const item of readyItems) {
      const prepared = await prepareNovelMigrationOperation({
        scopeInput: input.scopeInput,
        currentState,
        currentNovelId: item.currentNovelId,
        targetDetail: item.match!.detail,
        identityRevision: plannedIdentityRevision,
        hardcoverState: plannedHardcoverState,
      });
      preparedItems.push({ prepared, previousState: currentState });
      payloadItems.push({
        oldState: prepared.oldSlice,
        newState: prepared.newSlice,
        offlineAssets: [],
      });
      transferredChapterCount += prepared.transferSummary.transferredChapterCount;
      transferredReadCount += prepared.transferSummary.transferredReadCount;
      transferredBookmarkCount += prepared.transferSummary.transferredBookmarkCount;
      currentState = prepared.nextState;
      if (plannedIdentityRevision && prepared.identity) {
        plannedIdentityRevision = {
          ...plannedIdentityRevision,
          settings: prepared.identity.next,
        };
      }
      plannedHardcoverState = {
        ...plannedHardcoverState,
        records: prepared.hardcover.nextRecords,
      };
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
      steps: [
        ...preparedItems.map(({ prepared }) => ({
          stepId: `novel-child-${prepared.oldSlice.entry!.id}`,
          kind: "local" as const,
        })),
        { stepId: "novel-hardcover-binding", kind: "tracker" },
        ...(plannedIdentityRevision ? [{ stepId: "novel-local-identity", kind: "link" as const }] : []),
      ],
    });
    await transitionMigrationOperation(operation.operationId, "preparing");
    await transitionMigrationOperation(operation.operationId, "applying");
    const committedChildren: string[] = [];
    let appliedHardcoverCount = 0;
    let identityApplied = false;
    try {
      for (const { prepared, previousState } of preparedItems) {
        const parentStepId = `novel-child-${prepared.oldSlice.entry!.id}`;
        const child = await beginMigrationChildOperation(operation.operationId, {
          contentKind: "novel",
          sourceFrom: prepared.transferSummary.oldSourceId,
          sourceTo: prepared.transferSummary.newSourceId,
          transferSummary: prepared.transferSummary,
          payload: {
            oldState: prepared.oldSlice,
            newState: prepared.newSlice,
            offlineAssets: [],
          },
          steps: [
            { stepId: "novel-library-state", kind: "local" },
            { stepId: "novel-offline-assets", kind: "filesystem" },
          ],
        });
        await transitionMigrationOperation(child.operationId, "preparing");
        await transitionMigrationOperation(child.operationId, "applying");
        try {
          await runMigrationStep({
            operationId: child.operationId,
            stepId: "novel-library-state",
            apply: async () => {
              await saveNovelLibraryState(prepared.nextState, input.scopeInput);
            },
            verify: async () => {
              const reloaded = await reloadNovelLibraryState(input.scopeInput);
              if (
                !prepared.newSlice.entry
                || !getNovelLibraryEntry(reloaded, prepared.newSlice.entry.id)
                || getNovelLibraryEntry(reloaded, prepared.oldSlice.entry!.id)
              ) {
                throw new Error("Mass novel migration child state could not be verified.");
              }
            },
          });
          let offlineAssets = [] as Awaited<ReturnType<typeof copyVerifiedNovelOfflineAssets>>;
          await runMigrationStep({
            operationId: child.operationId,
            stepId: "novel-offline-assets",
            apply: async () => {
              offlineAssets = await copyVerifiedNovelOfflineAssets(
                prepared.offlinePairs,
                createNovelOfflineAssetCachePort(input.scopeInput),
              );
              await checkpointMigrationPayload(child.operationId, {
                oldState: prepared.oldSlice,
                newState: prepared.newSlice,
                offlineAssets,
              });
            },
            verify: async () => {
              if (offlineAssets.some((asset) => !asset.sourcePreserved)) {
                throw new Error("Novel offline asset source preservation could not be verified.");
              }
            },
          });
          await commitMigrationOperation(child.operationId);
          committedChildren.push(child.operationId);
          payloadItems[committedChildren.length - 1] = {
            oldState: prepared.oldSlice,
            newState: prepared.newSlice,
            offlineAssets,
          };
          await runMigrationStep({
            operationId: operation.operationId,
            stepId: parentStepId,
            apply: async () => undefined,
            verify: async () => {
              const committedChild = await getMigrationOperation(child.operationId);
              if (committedChild?.status !== "committed") {
                throw new Error("Mass novel migration child did not commit.");
              }
            },
          });
        } catch (error) {
          await compensateNovelOperation(child.operationId, async () => {
            await saveNovelLibraryState(previousState, input.scopeInput);
          }).catch(() => undefined);
          throw error;
        }
      }
      await checkpointMigrationPayload(operation.operationId, {
        items: payloadItems,
      } satisfies NovelMassMigrationUndoPayload);
      await runMigrationStep({
        operationId: operation.operationId,
        stepId: "novel-hardcover-binding",
        apply: async () => {
          for (const { prepared } of preparedItems) {
            saveVerifiedHardcoverSlice(
              input.scopeInput,
              prepared.hardcover.previous,
              prepared.hardcover.applied,
            );
            appliedHardcoverCount += 1;
          }
        },
        verify: async () => {
          const current = loadHardcoverState(input.scopeInput);
          if (!preparedItems.every(({ prepared }) => (
            hardcoverBindingMatchesSlice(
              current.records,
              prepared.hardcover.applied,
            )
          ))) {
            throw new Error("Mass migration Hardcover bindings were not persisted.");
          }
        },
      });
      if (plannedIdentityRevision && initialIdentityRevision) {
        await runMigrationStep({
          operationId: operation.operationId,
          stepId: "novel-local-identity",
          apply: async () => {
            await input.identityBridge!.write({
              expectedRevision: initialIdentityRevision.revision,
              next: plannedIdentityRevision!.settings,
            });
            identityApplied = true;
          },
          verify: async () => {
            const current = await input.identityBridge!.read();
            if (
              migrationIdentityRevision(current.settings)
              !== migrationIdentityRevision(plannedIdentityRevision!.settings)
            ) {
              throw new Error("Mass migration links or folders were not persisted.");
            }
          },
        });
      }
      await commitMigrationOperation(operation.operationId, {
        payload: { items: payloadItems } satisfies NovelMassMigrationUndoPayload,
      });
    } catch (error) {
      await compensateNovelOperation(operation.operationId, async () => {
        if (
          identityApplied
          && input.identityBridge
          && initialIdentityRevision
          && plannedIdentityRevision
        ) {
          const current = await input.identityBridge.read();
          if (
            migrationIdentityRevision(current.settings)
            !== migrationIdentityRevision(initialIdentityRevision.settings)
          ) {
            if (
              migrationIdentityRevision(current.settings)
              !== migrationIdentityRevision(plannedIdentityRevision.settings)
            ) {
              throw new Error("Mass migration links changed; automatic compensation was stopped.");
            }
            await input.identityBridge.write({
              expectedRevision: current.revision,
              next: initialIdentityRevision.settings,
            });
          }
        }
        for (
          let index = Math.min(appliedHardcoverCount, preparedItems.length) - 1;
          index >= 0;
          index -= 1
        ) {
          const prepared = preparedItems[index]!.prepared;
          saveVerifiedHardcoverSlice(
            input.scopeInput,
            prepared.hardcover.applied,
            prepared.hardcover.previous,
          );
        }
        await saveNovelLibraryState(initialState, input.scopeInput);
        for (const childOperationId of [...committedChildren].reverse()) {
          const child = await getMigrationOperation(childOperationId);
          if (child?.status !== "committed") continue;
          await transitionMigrationOperation(childOperationId, "compensating");
          await markMigrationCompensated(childOperationId);
        }
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
  identityBridge?: MigrationIdentityBridge;
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
        await restoreNovelJournalIdentity({
          bridge: input.identityBridge,
          oldState: item.oldState,
          newState: item.newState,
          scopeInput: input.scopeInput,
        });
        const targetNovelId = item.newState.entry?.id;
        const withoutNew = targetNovelId
          ? removeNovelFromLibraryState(currentState, targetNovelId)
          : currentState;
        currentState = restoreNovelLibraryStateSlice(withoutNew, item.oldState);
      }
      const saved = await saveNovelLibraryState(currentState, input.scopeInput);
      for (const childOperationId of [...(operation?.childOperationIds ?? [])].reverse()) {
        const child = await getMigrationOperation(childOperationId);
        if (child?.status !== "committed") continue;
        await transitionMigrationOperation(childOperationId, "compensating");
        await markMigrationCompensated(childOperationId);
      }
      await markMigrationCompensated(entry.id);
      return saved;
    } catch (error) {
      await markMigrationNeedsManualRecovery(entry.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
}
