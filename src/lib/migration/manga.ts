import { gql } from "../client";
import {
  GET_CATEGORIES,
  GET_CHAPTERS,
  GET_MANGA,
  UPDATE_CHAPTERS_PROGRESS,
  UPDATE_MANGA,
  UPDATE_MANGA_CATEGORIES,
} from "../queries";
import type { Category, Chapter, Manga } from "../types";
import { fetchSourceMangaSearchWithFallback } from "../manga/sourceSearch";
import { fetchSourceMangaChapters } from "../manga/runtime";
import { withSuwayomiOperationLease } from "../suwayomiUpdateLock.svelte";
import { getMigrationJournalEntry, getMigrationOperation } from "./journalState";
import {
  beginMigrationChildOperation,
  beginMigrationOperation,
  checkpointMigrationPayload,
  checkpointMigrationStep,
  commitMigrationOperation,
  markMigrationCompensated,
  markMigrationNeedsManualRecovery,
  runMigrationStep,
  transitionMigrationOperation,
  withMigrationProfileLock,
} from "./coordinator";
import { matchMangaChapters } from "./chapterMapping";
import {
  buildMangaDownloadedAssetManifest,
  type ProvenOfflineAssetPair,
} from "./offlineAssets";
import {
  migrationIdentityMatchesSlice,
  migrationIdentityRevision,
  prepareMangaIdentityMigration,
  restoreMigrationIdentitySlice,
  type MigrationIdentityBridge,
  type MigrationIdentityRevision,
} from "./identity";
import {
  applyMangaTrackerBindingPlan,
  compensateMangaTrackerBindingPlan,
  createGraphqlMangaTrackerBindingPort,
  prepareMangaTrackerBindingPlan,
  verifyMangaTrackerBindingPlan,
  type MangaTrackerBindingPlan,
} from "./trackerBindings";
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
  profileId?: string | null;
  identityBridge?: MigrationIdentityBridge;
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
  profileId?: string | null;
  identityBridge?: MigrationIdentityBridge;
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

async function readMangaState(mangaId: number): Promise<MangaMigrationStateSlice> {
  const [mangaData, chapterData, categoryIds] = await Promise.all([
    gql<{ manga: Manga }>(GET_MANGA, { id: mangaId }),
    gql<{ chapters: { nodes: Chapter[] } }>(GET_CHAPTERS, { mangaId }),
    loadCategoryIdsForManga(mangaId),
  ]);
  return snapshotMangaState(
    mangaData.manga,
    chapterData.chapters.nodes ?? [],
    categoryIds,
  );
}

function sameNumberSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

async function verifyMangaSnapshot(snapshot: MangaMigrationStateSlice): Promise<void> {
  const actual = await readMangaState(snapshot.mangaId);
  if (actual.inLibrary !== snapshot.inLibrary || !sameNumberSet(actual.categoryIds, snapshot.categoryIds)) {
    throw new Error(`Manga ${snapshot.mangaId} library state does not match its migration snapshot.`);
  }
  const actualById = new Map(actual.chapters.map((chapter) => [chapter.id, chapter]));
  for (const expected of snapshot.chapters) {
    const chapter = actualById.get(expected.id);
    if (
      !chapter
      || chapter.isRead !== expected.isRead
      || chapter.isBookmarked !== expected.isBookmarked
      || chapter.lastPageRead !== expected.lastPageRead
    ) {
      throw new Error(`Chapter ${expected.id} does not match its migration snapshot.`);
    }
  }
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

  const chaptersResult = await fetchSourceMangaChapters({
    mangaId: best.manga.id,
    sourceId: best.manga.source?.id,
  }, signal);

  return {
    manga: best.manga,
    chapters: chaptersResult.fetchChapters.chapters ?? [],
    similarity: best.similarity,
  };
}

function summarizeMatchedReadCount(oldChapters: Chapter[], newChapters: Chapter[]): number {
  return matchMangaChapters(oldChapters, newChapters)
    .filter(({ oldChapter, newChapter }) => oldChapter.isRead && !newChapter.isRead)
    .length;
}

export async function buildMangaMigrationMatch(
  currentManga: Manga,
  matchManga: Manga,
  similarity = titleSimilarity(currentManga.title, matchManga.title),
): Promise<MangaMigrationMatch> {
  const chaptersResult = await fetchSourceMangaChapters({
    mangaId: matchManga.id,
    sourceId: matchManga.source?.id,
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

interface PreparedMangaMigrationOperation {
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
  toMarkRead: number[];
  toMarkBookmarked: number[];
  progressUpdates: Array<{ id: number; lastPageRead: number }>;
  mode: "migrate" | "copy";
  currentMangaId: number;
  targetMangaId: number;
  oldCategoryIds: number[];
  targetCategoryIds: number[];
  identity?: ReturnType<typeof prepareMangaIdentityMigration>;
  trackerPlan: MangaTrackerBindingPlan;
  offlineAssets: ReturnType<typeof buildMangaDownloadedAssetManifest>;
}

async function prepareMangaMigrationOperation(
  input: ApplyMangaMigrationInput,
  identityRevision?: MigrationIdentityRevision,
): Promise<PreparedMangaMigrationOperation> {
  const oldCategoryIds = await loadCategoryIdsForManga(input.currentManga.id);
  const newCategoryIds = await loadCategoryIdsForManga(input.match.manga.id);
  const oldState = snapshotMangaState(input.currentManga, input.currentChapters, oldCategoryIds);
  const newState = snapshotMangaState(input.match.manga, input.match.chapters, newCategoryIds);
  const matches = matchMangaChapters(input.currentChapters, input.match.chapters);
  const sourceId = input.currentManga.source?.id ?? input.currentManga.sourceId ?? "unknown";
  const targetSourceId = input.match.manga.source?.id
    ?? input.match.manga.sourceId
    ?? input.targetSourceId;
  const downloadedPairs: ProvenOfflineAssetPair[] = matches
    .filter(({ oldChapter }) => oldChapter.isDownloaded)
    .map(({ oldChapter, newChapter }) => ({
      source: {
        sourceId,
        titleId: String(input.currentManga.id),
        chapterId: String(oldChapter.id),
        chapterPath: null,
      },
      target: {
        sourceId: targetSourceId,
        titleId: String(input.match.manga.id),
        chapterId: String(newChapter.id),
        chapterPath: null,
      },
    }));

  const toMarkRead: number[] = [];
  const toMarkBookmarked: number[] = [];
  const progressUpdates: Array<{ id: number; lastPageRead: number }> = [];

  for (const { oldChapter, newChapter } of matches) {
    if (oldChapter.isRead && !newChapter.isRead) {
      toMarkRead.push(newChapter.id);
    }
    if (oldChapter.isBookmarked && !newChapter.isBookmarked) {
      toMarkBookmarked.push(newChapter.id);
    }
    const oldLastPageRead = oldChapter.lastPageRead ?? 0;
    const newLastPageRead = newChapter.lastPageRead ?? 0;
    if (oldChapter.isRead || newChapter.isRead || oldLastPageRead <= 0) {
      continue;
    }
    if (oldChapter.pageCount > 1 && newChapter.pageCount > 1) {
      const oldRatio = Math.min(1, oldLastPageRead / (oldChapter.pageCount - 1));
      const newRatio = Math.min(1, newLastPageRead / (newChapter.pageCount - 1));
      if (oldRatio > newRatio) {
        progressUpdates.push({
          id: newChapter.id,
          lastPageRead: Math.round(oldRatio * (newChapter.pageCount - 1)),
        });
      }
    } else if (newLastPageRead === 0) {
      progressUpdates.push({ id: newChapter.id, lastPageRead: oldLastPageRead });
    }
  }

  const mode = input.mode ?? "migrate";
  const identity = identityRevision
    ? prepareMangaIdentityMigration({
        current: identityRevision.settings,
        sourceMangaId: input.currentManga.id,
        targetMangaId: input.match.manga.id,
        mode,
      })
    : undefined;
  const trackerPlan = await prepareMangaTrackerBindingPlan(
    createGraphqlMangaTrackerBindingPort(gql),
    {
      sourceMangaId: input.currentManga.id,
      targetMangaId: input.match.manga.id,
      mode,
    },
  );
  oldState.localIdentity = identity?.previous;
  oldState.trackerBindingPlan = trackerPlan;
  newState.localIdentity = identity?.applied;
  newState.trackerBindingPlan = trackerPlan;
  const targetCategoryIds = [...new Set([...newCategoryIds, ...oldCategoryIds])];

  return {
    oldState,
    newState,
    transferSummary: {
      oldItemTitle: input.currentManga.title,
      newItemTitle: input.match.manga.title,
      oldSourceId: input.currentManga.source?.id ?? "unknown",
      newSourceId: input.targetSourceId,
      transferredChapterCount: matches.length,
      transferredReadCount: toMarkRead.length,
      transferredBookmarkCount: toMarkBookmarked.length,
    },
    newManga: {
      ...input.match.manga,
      inLibrary: true,
    },
    toMarkRead,
    toMarkBookmarked,
    progressUpdates,
    mode,
    currentMangaId: input.currentManga.id,
    targetMangaId: input.match.manga.id,
    oldCategoryIds,
    targetCategoryIds,
    identity,
    trackerPlan,
    offlineAssets: buildMangaDownloadedAssetManifest(downloadedPairs),
  };
}

async function applyPreparedMangaTarget(prepared: PreparedMangaMigrationOperation): Promise<void> {
  if (prepared.toMarkRead.length) {
    await gql(UPDATE_CHAPTERS_PROGRESS, { ids: prepared.toMarkRead, isRead: true });
  }
  if (prepared.toMarkBookmarked.length) {
    await gql(UPDATE_CHAPTERS_PROGRESS, { ids: prepared.toMarkBookmarked, isBookmarked: true });
  }
  for (const update of prepared.progressUpdates) {
    await gql(UPDATE_CHAPTERS_PROGRESS, { ids: [update.id], lastPageRead: update.lastPageRead });
  }
  await gql(UPDATE_MANGA, { id: prepared.targetMangaId, inLibrary: true });
  await setCategoryIdsForManga(prepared.targetMangaId, prepared.targetCategoryIds);
}

async function cleanupPreparedMangaSource(prepared: PreparedMangaMigrationOperation): Promise<void> {
  if (prepared.mode === "migrate") {
    await gql(UPDATE_MANGA, { id: prepared.currentMangaId, inLibrary: false });
    await setCategoryIdsForManga(prepared.currentMangaId, []);
  }
}

async function restorePreparedMangaIdentity(
  prepared: PreparedMangaMigrationOperation,
  identityBridge?: MigrationIdentityBridge,
): Promise<void> {
  await compensateMangaTrackerBindingPlan(
    createGraphqlMangaTrackerBindingPort(gql),
    prepared.trackerPlan,
  );
  if (identityBridge && prepared.identity) {
    const current = await identityBridge.read();
    if (!migrationIdentityMatchesSlice(current.settings, prepared.identity.previous)) {
      if (!migrationIdentityMatchesSlice(current.settings, prepared.identity.applied)) {
        throw new Error("Manga links changed after migration; automatic compensation was stopped.");
      }
      await identityBridge.write({
        expectedRevision: current.revision,
        next: restoreMigrationIdentitySlice(current.settings, prepared.identity.previous),
      });
    }
  }
}

async function compensatePreparedMangaMigration(
  prepared: PreparedMangaMigrationOperation,
  identityBridge?: MigrationIdentityBridge,
): Promise<void> {
  await restorePreparedMangaIdentity(prepared, identityBridge);
  const results = await Promise.allSettled([
    restoreMangaSnapshot(prepared.oldState),
    restoreMangaSnapshot(prepared.newState),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    const verification = await Promise.allSettled([
      verifyMangaSnapshot(prepared.oldState),
      verifyMangaSnapshot(prepared.newState),
    ]);
    if (verification.some((result) => result.status === "rejected")) {
      throw new Error(`Could not compensate ${failures.length} Suwayomi migration snapshot(s).`);
    }
  }
}

async function verifyAppliedMangaMigration(prepared: PreparedMangaMigrationOperation): Promise<void> {
  const [oldState, targetState] = await Promise.all([
    readMangaState(prepared.currentMangaId),
    readMangaState(prepared.targetMangaId),
  ]);
  if (!targetState.inLibrary || !sameNumberSet(targetState.categoryIds, prepared.targetCategoryIds)) {
    throw new Error("Target manga state was not persisted after migration.");
  }
  if (
    prepared.mode === "migrate"
    && (oldState.inLibrary || oldState.categoryIds.length > 0)
  ) {
    throw new Error("Source manga cleanup was not persisted after migration.");
  }
  const targetChapters = new Map(targetState.chapters.map((chapter) => [chapter.id, chapter]));
  for (const chapterId of prepared.toMarkRead) {
    if (!targetChapters.get(chapterId)?.isRead) {
      throw new Error(`Read state was not persisted for target chapter ${chapterId}.`);
    }
  }
  for (const chapterId of prepared.toMarkBookmarked) {
    if (!targetChapters.get(chapterId)?.isBookmarked) {
      throw new Error(`Bookmark state was not persisted for target chapter ${chapterId}.`);
    }
  }
  for (const update of prepared.progressUpdates) {
    if (targetChapters.get(update.id)?.lastPageRead !== update.lastPageRead) {
      throw new Error(`Page progress was not persisted for target chapter ${update.id}.`);
    }
  }
}

async function compensateMangaOperation(
  operationId: string,
  preparedItems: PreparedMangaMigrationOperation[],
  identityBridge?: MigrationIdentityBridge,
): Promise<void> {
  await transitionMigrationOperation(operationId, "compensating");
  try {
    for (const prepared of [...preparedItems].reverse()) {
      await compensatePreparedMangaMigration(prepared, identityBridge);
    }
    await markMigrationCompensated(operationId);
  } catch (compensationError) {
    await markMigrationNeedsManualRecovery(
      operationId,
      compensationError instanceof Error ? compensationError.message : String(compensationError),
    );
    throw compensationError;
  }
}

async function compensateMassMangaOperation(
  parentOperationId: string,
  successful: Array<{
    prepared: PreparedMangaMigrationOperation;
    childOperationId: string;
  }>,
  identityBridge?: MigrationIdentityBridge,
): Promise<void> {
  await transitionMigrationOperation(parentOperationId, "compensating");
  try {
    for (const item of [...successful].reverse()) {
      await compensateMangaOperation(
        item.childOperationId,
        [item.prepared],
        identityBridge,
      );
    }
    await markMigrationCompensated(parentOperationId);
  } catch (error) {
    await markMigrationNeedsManualRecovery(
      parentOperationId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function applyMangaMigrationWithJournal(
  input: ApplyMangaMigrationInput,
): Promise<{ journalEntryId: string; newManga: Manga }> {
  const profileId = input.profileId?.trim() || "main";
  return withMigrationProfileLock(profileId, () => withSuwayomiOperationLease("migration", async () => {
    const identityRevision = input.identityBridge
      ? await input.identityBridge.read()
      : undefined;
    const prepared = await prepareMangaMigrationOperation(input, identityRevision);
    const operation = await beginMigrationOperation({
      profileId,
      contentKind: "manga",
      sourceFrom: input.currentManga.source?.id ?? "unknown",
      sourceTo: input.targetSourceId,
      transferSummary: prepared.transferSummary,
      payload: {
        oldState: prepared.oldState,
        newState: prepared.newState,
        offlineAssets: prepared.offlineAssets,
      },
      steps: [
        { stepId: "suwayomi-target-state", kind: "suwayomi" },
        { stepId: "tracker-bindings", kind: "tracker" },
        ...(prepared.identity ? [{ stepId: "manga-local-identity", kind: "link" as const }] : []),
        ...(prepared.mode === "migrate"
          ? [{ stepId: "suwayomi-source-cleanup", kind: "suwayomi" as const }]
          : []),
      ],
    });
    await transitionMigrationOperation(operation.operationId, "preparing");
    await transitionMigrationOperation(operation.operationId, "applying");
    try {
      await runMigrationStep({
        operationId: operation.operationId,
        stepId: "suwayomi-target-state",
        apply: () => applyPreparedMangaTarget(prepared),
        verify: async () => {
          const target = await readMangaState(prepared.targetMangaId);
          if (!target.inLibrary || !sameNumberSet(target.categoryIds, prepared.targetCategoryIds)) {
            throw new Error("Target manga library state was not persisted.");
          }
        },
      });
      await runMigrationStep({
        operationId: operation.operationId,
        stepId: "tracker-bindings",
        apply: () => applyMangaTrackerBindingPlan(
          createGraphqlMangaTrackerBindingPort(gql),
          prepared.trackerPlan,
        ),
        verify: () => verifyMangaTrackerBindingPlan(
          createGraphqlMangaTrackerBindingPort(gql),
          prepared.trackerPlan,
        ),
      });
      if (prepared.identity) {
        await runMigrationStep({
          operationId: operation.operationId,
          stepId: "manga-local-identity",
          apply: async () => {
            await input.identityBridge!.write({
              expectedRevision: identityRevision!.revision,
              next: prepared.identity!.next,
            });
          },
          verify: async () => {
            const current = await input.identityBridge!.read();
            if (!migrationIdentityMatchesSlice(current.settings, prepared.identity!.applied)) {
              throw new Error("Manga links were not persisted.");
            }
          },
        });
      }
      if (prepared.mode === "migrate") {
        await runMigrationStep({
          operationId: operation.operationId,
          stepId: "suwayomi-source-cleanup",
          apply: () => cleanupPreparedMangaSource(prepared),
          verify: () => verifyAppliedMangaMigration(prepared),
        });
      } else {
        await verifyAppliedMangaMigration(prepared);
      }
      await commitMigrationOperation(operation.operationId);
    } catch (error) {
      await compensateMangaOperation(
        operation.operationId,
        [prepared],
        input.identityBridge,
      ).catch(() => undefined);
      throw error;
    }
    return {
      journalEntryId: operation.operationId,
      newManga: prepared.newManga,
    };
  }));
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
  const profileId = input.profileId?.trim() || "main";
  return withMigrationProfileLock(profileId, () => withSuwayomiOperationLease("migration", async () => {
    const selectedIds = new Set(
      input.selectedMangaIds ?? input.preview.items.map((item) => item.currentManga.id),
    );
    const readyItems = input.preview.items.filter((item) => (
      item.status !== "no_match"
      && item.status !== "search_failed"
      && item.match
      && selectedIds.has(item.currentManga.id)
    ));

    const preparedItems: Array<{
      item: MassMangaMigrationPreviewItem;
      prepared: PreparedMangaMigrationOperation;
    }> = [];
    const initialIdentityRevision = input.identityBridge
      ? await input.identityBridge.read()
      : undefined;
    let transferredChapterCount = 0;
    let transferredReadCount = 0;
    let transferredBookmarkCount = 0;
    const failedItems: Array<{ mangaId: number; message: string }> = [];
    const targetIds = readyItems.map((item) => item.match!.manga.id);
    if (new Set(targetIds).size !== targetIds.length) {
      throw new Error("Mass migration cannot map multiple manga to the same target identity.");
    }

    for (const item of readyItems) {
      try {
        const prepared = await prepareMangaMigrationOperation({
          currentManga: item.currentManga,
          currentChapters: item.currentChapters,
          targetSourceId: input.preview.sourceTo,
          match: item.match!,
          mode: input.mode ?? "migrate",
          profileId,
        });
        preparedItems.push({ item, prepared });
      } catch (error) {
        failedItems.push({
          mangaId: item.currentManga.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (preparedItems.length === 0) {
      return {
        journalEntryId: null,
        migratedCount: 0,
        skippedCount: input.preview.items.length - readyItems.length,
        migratedMangaIds: [],
        migratedSourceMangaIds: [],
        failedItems,
      };
    }

    const operation = await beginMigrationOperation({
      profileId,
      contentKind: "manga",
      mode: "mass",
      sourceFrom: input.preview.sourceFrom,
      sourceTo: input.preview.sourceTo,
      transferSummary: {
        oldItemTitle: `${preparedItems.length} manga`,
        newItemTitle: `${preparedItems.length} pending`,
        oldSourceId: input.preview.sourceFrom,
        newSourceId: input.preview.sourceTo,
        transferredChapterCount: 0,
        transferredReadCount: 0,
        transferredBookmarkCount: 0,
      },
      payload: {
        items: preparedItems.map(({ prepared }) => ({
          oldState: prepared.oldState,
          newState: prepared.newState,
          offlineAssets: prepared.offlineAssets,
        })),
      },
      steps: [
        ...preparedItems.map(({ item }) => ({
          stepId: `manga-child-${item.currentManga.id}`,
          kind: "local" as const,
        })),
        ...(input.identityBridge
          ? [{ stepId: "mass-manga-identity", kind: "link" as const }]
          : []),
      ],
    });
    await transitionMigrationOperation(operation.operationId, "preparing");
    await transitionMigrationOperation(operation.operationId, "applying");

    const successful: Array<(typeof preparedItems)[number] & {
      childOperationId: string;
    }> = [];
    for (const preparedItem of preparedItems) {
      const parentStepId = `manga-child-${preparedItem.item.currentManga.id}`;
      let childOperationId: string | null = null;
      try {
        const child = await beginMigrationChildOperation(operation.operationId, {
          contentKind: "manga",
          sourceFrom: input.preview.sourceFrom,
          sourceTo: input.preview.sourceTo,
          transferSummary: preparedItem.prepared.transferSummary,
          payload: {
            oldState: preparedItem.prepared.oldState,
            newState: preparedItem.prepared.newState,
            offlineAssets: preparedItem.prepared.offlineAssets,
          },
          steps: [
            { stepId: "target", kind: "suwayomi" },
            { stepId: "tracker", kind: "tracker" },
            ...(preparedItem.prepared.mode === "migrate"
              ? [{ stepId: "cleanup", kind: "suwayomi" as const }]
              : []),
          ],
        });
        childOperationId = child.operationId;
        await transitionMigrationOperation(child.operationId, "preparing");
        await transitionMigrationOperation(child.operationId, "applying");
        await runMigrationStep({
          operationId: child.operationId,
          stepId: "target",
          apply: () => applyPreparedMangaTarget(preparedItem.prepared),
          verify: async () => {
            const target = await readMangaState(preparedItem.prepared.targetMangaId);
            if (
              !target.inLibrary
              || !sameNumberSet(target.categoryIds, preparedItem.prepared.targetCategoryIds)
            ) {
              throw new Error("Target manga library state was not persisted.");
            }
          },
        });
        await runMigrationStep({
          operationId: child.operationId,
          stepId: "tracker",
          apply: () => applyMangaTrackerBindingPlan(
            createGraphqlMangaTrackerBindingPort(gql),
            preparedItem.prepared.trackerPlan,
          ),
          verify: () => verifyMangaTrackerBindingPlan(
            createGraphqlMangaTrackerBindingPort(gql),
            preparedItem.prepared.trackerPlan,
          ),
        });
        if (preparedItem.prepared.mode === "migrate") {
          await runMigrationStep({
            operationId: child.operationId,
            stepId: "cleanup",
            apply: () => cleanupPreparedMangaSource(preparedItem.prepared),
            verify: () => verifyAppliedMangaMigration(preparedItem.prepared),
          });
        } else {
          await verifyAppliedMangaMigration(preparedItem.prepared);
        }
        await commitMigrationOperation(child.operationId);
        await runMigrationStep({
          operationId: operation.operationId,
          stepId: parentStepId,
          apply: async () => undefined,
          verify: async () => {
            const committedChild = await getMigrationOperation(child.operationId);
            if (committedChild?.status !== "committed") {
              throw new Error("Mass migration child did not commit.");
            }
          },
        });
        successful.push({
          ...preparedItem,
          childOperationId: child.operationId,
        });
        transferredChapterCount += preparedItem.prepared.transferSummary.transferredChapterCount;
        transferredReadCount += preparedItem.prepared.transferSummary.transferredReadCount;
        transferredBookmarkCount += preparedItem.prepared.transferSummary.transferredBookmarkCount;
      } catch (error) {
        try {
          if (childOperationId) {
            await compensateMangaOperation(
              childOperationId,
              [preparedItem.prepared],
              input.identityBridge,
            );
          } else {
            await compensatePreparedMangaMigration(
              preparedItem.prepared,
              input.identityBridge,
            );
          }
          await checkpointMigrationStep(operation.operationId, parentStepId, {
            status: "skipped",
            completedAt: Date.now(),
          });
        } catch (compensationError) {
          await markMigrationNeedsManualRecovery(
            operation.operationId,
            compensationError instanceof Error ? compensationError.message : String(compensationError),
          );
          throw compensationError;
        }
        failedItems.push({
          mangaId: preparedItem.item.currentManga.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (successful.length === 0) {
      await markMigrationCompensated(operation.operationId);
      return {
        journalEntryId: null,
        migratedCount: 0,
        skippedCount: input.preview.items.length - readyItems.length,
        migratedMangaIds: [],
        migratedSourceMangaIds: [],
        failedItems,
      };
    }

    let payloadItems: MangaMigrationUndoPayload[] = successful.map(({ prepared }) => ({
      oldState: prepared.oldState,
      newState: prepared.newState,
      offlineAssets: prepared.offlineAssets,
    }));
    await checkpointMigrationPayload(operation.operationId, {
      items: payloadItems,
    } satisfies MangaMassMigrationUndoPayload);

    if (input.identityBridge && initialIdentityRevision) {
      let nextIdentitySettings = initialIdentityRevision.settings;
      for (const { prepared } of successful) {
        const identity = prepareMangaIdentityMigration({
          current: nextIdentitySettings,
          sourceMangaId: prepared.currentMangaId,
          targetMangaId: prepared.targetMangaId,
          mode: prepared.mode,
        });
        prepared.identity = identity;
        prepared.oldState.localIdentity = identity.previous;
        prepared.newState.localIdentity = identity.applied;
        nextIdentitySettings = identity.next;
      }
      payloadItems = successful.map(({ prepared }) => ({
        oldState: prepared.oldState,
        newState: prepared.newState,
        offlineAssets: prepared.offlineAssets,
      }));
      await checkpointMigrationPayload(operation.operationId, {
        items: payloadItems,
      } satisfies MangaMassMigrationUndoPayload);
      try {
        await runMigrationStep({
          operationId: operation.operationId,
          stepId: "mass-manga-identity",
          apply: async () => {
            await input.identityBridge!.write({
              expectedRevision: initialIdentityRevision.revision,
              next: nextIdentitySettings,
            });
          },
          verify: async () => {
            const current = await input.identityBridge!.read();
            if (
              migrationIdentityRevision(current.settings)
              !== migrationIdentityRevision(nextIdentitySettings)
            ) {
              throw new Error("Mass migration manga links were not persisted.");
            }
          },
        });
      } catch (error) {
        await compensateMassMangaOperation(
          operation.operationId,
          successful,
          input.identityBridge,
        ).catch(() => undefined);
        throw error;
      }
    }

    try {
      await commitMigrationOperation(operation.operationId, {
        transferSummary: {
          oldItemTitle: `${successful.length} manga`,
          newItemTitle: `${successful.length} migrated`,
          oldSourceId: input.preview.sourceFrom,
          newSourceId: input.preview.sourceTo,
          transferredChapterCount,
          transferredReadCount,
          transferredBookmarkCount,
        },
        payload: { items: payloadItems } satisfies MangaMassMigrationUndoPayload,
      });
    } catch (error) {
      await compensateMassMangaOperation(
        operation.operationId,
        successful,
        input.identityBridge,
      ).catch(() => undefined);
      throw error;
    }

    return {
      journalEntryId: operation.operationId,
      migratedCount: successful.length,
      skippedCount: input.preview.items.length - readyItems.length,
      migratedMangaIds: successful.map(({ item }) => item.match!.manga.id),
      migratedSourceMangaIds: successful.map(({ item }) => item.currentManga.id),
      failedItems,
    };
  }));
}

export async function undoMangaMigration(
  journalEntryId: string,
  identityBridge?: MigrationIdentityBridge,
): Promise<void> {
  const operation = await getMigrationOperation(journalEntryId);
  const profileId = operation?.profileId ?? "main";
  return withMigrationProfileLock(profileId, () => withSuwayomiOperationLease("migration", async () => {
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

    await transitionMigrationOperation(entry.id, "compensating");
    try {
      for (const item of [...items].reverse()) {
        const trackerPlan = item.newState.trackerBindingPlan ?? item.oldState.trackerBindingPlan;
        if (trackerPlan) {
          await compensateMangaTrackerBindingPlan(
            createGraphqlMangaTrackerBindingPort(gql),
            trackerPlan,
          );
        }
        if (identityBridge && item.oldState.localIdentity && item.newState.localIdentity) {
          const current = await identityBridge.read();
          if (!migrationIdentityMatchesSlice(current.settings, item.oldState.localIdentity)) {
            if (!migrationIdentityMatchesSlice(current.settings, item.newState.localIdentity)) {
              throw new Error("Manga links changed after migration; undo requires manual recovery.");
            }
            await identityBridge.write({
              expectedRevision: current.revision,
              next: restoreMigrationIdentitySlice(
                current.settings,
                item.oldState.localIdentity,
              ),
            });
          }
        }
        await restoreMangaSnapshot(item.oldState);
        await restoreMangaSnapshot(item.newState);
      }
      for (const childOperationId of [...(operation?.childOperationIds ?? [])].reverse()) {
        const child = await getMigrationOperation(childOperationId);
        if (child?.status !== "committed") continue;
        await transitionMigrationOperation(childOperationId, "compensating");
        await markMigrationCompensated(childOperationId);
      }
      await markMigrationCompensated(entry.id);
    } catch (error) {
      await markMigrationNeedsManualRecovery(
        entry.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }));
}
