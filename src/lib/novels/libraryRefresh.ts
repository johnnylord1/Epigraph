import { translate } from "../i18n/runtime";
import type { NovelRepositoryScopeInput } from "./repositoryState";
import {
  loadNovelLibraryState,
  saveNovelLibraryState,
} from "./libraryState";
import { saveCachedNovelChapter } from "./offlineChapters";
import { readInstalledNovelChapter, readInstalledNovelDetails } from "./sources";
import { classifySourceAccessError, sourceAccessErrorMessage } from "../sourceAccess";
import {
  createNovelChapterId,
  normalizeNovelCoverUrl,
  type NovelDetailRecord,
  type PersistedNovelChapterEntry,
  type PersistedNovelLibraryEntry,
  type PersistedNovelLibraryState,
} from "./domain";

export interface RefreshedNovelChapter {
  novelId: string;
  novelTitle: string;
  sourceId: string;
  sourceName: string;
  coverUrl: string | null;
  chapterId: string;
  chapterPath: string;
  chapterTitle: string;
  releaseTime: number | null;
  previousChapterCount: number;
  nextChapterCount: number;
  createdAt: number;
}

export interface NovelRefreshNotificationGroup {
  novelId: string;
  novelTitle: string;
  thumbnailUrl: string | null;
  sourceName: string;
  chapterTitles: string[];
  previousChapterCount: number;
  nextChapterCount: number;
}

export interface RefreshNovelLibraryFailure {
  novelId: string;
  title: string;
  sourceId: string;
  sourceName: string;
  error: string;
  errorType?: ReturnType<typeof classifySourceAccessError>["errorType"];
  actionUrl?: string;
  retrySourceId?: string;
  retryKind?: "novels-source";
  recoveryHint?: "flaresolverr" | "webview" | "external-browser";
}

export interface RefreshNovelLibraryProgress {
  checked: number;
  total: number;
  currentTitle: string | null;
  newChapters: number;
  failed: number;
}

export interface RefreshNovelLibraryResult {
  state: PersistedNovelLibraryState;
  checked: number;
  total: number;
  updated: number;
  failed: number;
  newChapters: number;
  newChapterEntries: RefreshedNovelChapter[];
  failures: RefreshNovelLibraryFailure[];
}

export interface RefreshNovelLibraryOptions {
  categoryNovelIds?: readonly string[] | null;
  concurrency?: number;
  downloadNewChapters?: boolean;
  excludedNovelIds?: readonly string[] | null;
  onlyOngoing?: boolean;
  pauseMs?: number;
  sourceIds?: readonly string[] | null;
  onProgress?: (progress: RefreshNovelLibraryProgress) => void;
}

let activeNovelUpdate: Promise<RefreshNovelLibraryResult> | null = null;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function errorMessage(error: unknown): string {
  return sourceAccessErrorMessage(error);
}

function sourceIdForNovelEntry(entry: PersistedNovelLibraryEntry): string | null {
  return entry.source?.pluginId ?? entry.source?.sourceId ?? null;
}

function sourceNameForNovelEntry(entry: PersistedNovelLibraryEntry): string {
  return entry.source?.sourceName ?? entry.source?.pluginName ?? sourceIdForNovelEntry(entry) ?? translate("libraryUpdate_unknownSource");
}

function sourceScopedNovelEntries(entries: PersistedNovelLibraryEntry[], sourceIds?: readonly string[] | null) {
  if (!sourceIds?.length) return entries;
  const allowed = new Set(sourceIds.map(String));
  return entries.filter((entry) => {
    const sourceId = sourceIdForNovelEntry(entry);
    return sourceId ? allowed.has(sourceId) : false;
  });
}

export function isNovelUpdateOngoingStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "ongoing" || normalized === "releasing";
}

export function shouldRefreshNovelEntry(
  entry: PersistedNovelLibraryEntry,
  options: Pick<RefreshNovelLibraryOptions, "categoryNovelIds" | "excludedNovelIds" | "onlyOngoing"> = {},
): boolean {
  if (options.excludedNovelIds && options.excludedNovelIds.length > 0) {
    const excluded = new Set(options.excludedNovelIds);
    if (excluded.has(entry.id)) return false;
  }
  if (options.categoryNovelIds && options.categoryNovelIds.length > 0) {
    const allowed = new Set(options.categoryNovelIds);
    if (!allowed.has(entry.id)) return false;
  }
  if (options.onlyOngoing && !isNovelUpdateOngoingStatus(entry.status)) return false;
  return true;
}

export function groupRefreshedNovelChaptersForNotifications(
  chapters: readonly RefreshedNovelChapter[],
): NovelRefreshNotificationGroup[] {
  return Array.from(
    chapters.reduce((map, chapter) => {
      const current = map.get(chapter.novelId) ?? {
        novelId: chapter.novelId,
        novelTitle: chapter.novelTitle,
        thumbnailUrl: chapter.coverUrl,
        sourceName: chapter.sourceName,
        chapterTitles: [] as string[],
        previousChapterCount: chapter.previousChapterCount,
        nextChapterCount: chapter.nextChapterCount,
      };
      current.chapterTitles.push(chapter.chapterTitle);
      current.previousChapterCount = Math.min(current.previousChapterCount, chapter.previousChapterCount);
      current.nextChapterCount = Math.max(current.nextChapterCount, chapter.nextChapterCount);
      map.set(chapter.novelId, current);
      return map;
    }, new Map<string, NovelRefreshNotificationGroup>()),
  ).map(([, value]) => value);
}

function mapNovelId<T extends { novelId: string }>(items: T[], previousId: string, nextId: string): T[] {
  if (previousId === nextId) return items;
  return items.map((item) => item.novelId === previousId ? { ...item, novelId: nextId } : item);
}

export function mergeNovelDetailIntoLibraryState(
  state: PersistedNovelLibraryState,
  previousEntry: PersistedNovelLibraryEntry,
  detail: NovelDetailRecord,
  createdAt = Date.now(),
): { state: PersistedNovelLibraryState; newChapters: RefreshedNovelChapter[] } {
  const previousNovelIds = new Set([previousEntry.id, detail.id]);
  const previousChapters = state.chapters.filter((chapter) => chapter.novelId === previousEntry.id);
  const previousChapterCount = previousChapters.length;
  const existingByPath = new Map(previousChapters.map((chapter) => [chapter.path, chapter]));
  const nextChapters: PersistedNovelChapterEntry[] = detail.chapters.map((chapter) => {
    const existing = existingByPath.get(chapter.path);
    return {
      id: chapter.id || existing?.id || createNovelChapterId(detail.id, chapter.path),
      novelId: detail.id,
      path: chapter.path,
      title: chapter.title,
      order: chapter.order,
      releaseTime: chapter.releaseTime,
      unread: existing?.unread ?? chapter.unread,
      updatedAt: existing ? (existing.updatedAt ?? null) : createdAt,
    };
  });

  const newChapterEntries = nextChapters
    .filter((chapter) => !existingByPath.has(chapter.path))
    .map((chapter): RefreshedNovelChapter => ({
      novelId: detail.id,
      novelTitle: detail.title,
      sourceId: detail.source?.sourceId ?? detail.source?.pluginId ?? detail.sourceId,
      sourceName: detail.source?.sourceName ?? detail.source?.pluginName ?? "Novels",
      coverUrl: normalizeNovelCoverUrl(detail.coverUrl) ?? normalizeNovelCoverUrl(previousEntry.coverUrl),
      chapterId: chapter.id,
      chapterPath: chapter.path,
      chapterTitle: chapter.title,
      releaseTime: chapter.releaseTime,
      previousChapterCount,
      nextChapterCount: nextChapters.length,
      createdAt,
    }));

  const nextEntry: PersistedNovelLibraryEntry = {
    id: detail.id,
    title: detail.title,
    author: detail.author,
    description: detail.description,
    coverUrl: normalizeNovelCoverUrl(detail.coverUrl) ?? normalizeNovelCoverUrl(previousEntry.coverUrl),
    path: detail.path,
    status: detail.status,
    tags: detail.tags,
    source: detail.source,
    chapterCount: detail.chapterCount,
    addedAt: previousEntry.addedAt,
    updatedAt: createdAt,
  };

  return {
    state: {
      ...state,
      entries: [
        ...state.entries.filter((entry) => !previousNovelIds.has(entry.id)),
        nextEntry,
      ].sort((left, right) => right.updatedAt - left.updatedAt),
      chapters: [
        ...state.chapters.filter((chapter) => !previousNovelIds.has(chapter.novelId)),
        ...nextChapters,
      ].sort((left, right) => left.order - right.order),
      progress: mapNovelId(state.progress, previousEntry.id, detail.id),
      bookmarks: mapNovelId(state.bookmarks, previousEntry.id, detail.id),
      history: mapNovelId(state.history, previousEntry.id, detail.id),
      updatedAtMs: createdAt,
    },
    newChapters: newChapterEntries,
  };
}

async function runNovelUpdate(
  scopeInput: NovelRepositoryScopeInput,
  options: RefreshNovelLibraryOptions,
): Promise<RefreshNovelLibraryResult> {
  let state = await loadNovelLibraryState(scopeInput);
  const entries = sourceScopedNovelEntries(
    state.entries.filter((entry) => shouldRefreshNovelEntry(entry, options)),
    options.sourceIds,
  );
  const total = entries.length;
  const pauseMs = options.pauseMs ?? 800;
  const newChapterEntries: RefreshedNovelChapter[] = [];
  const failures: RefreshNovelLibraryFailure[] = [];
  let checked = 0;
  let updated = 0;
  let failed = 0;

  options.onProgress?.({ checked, total, currentTitle: null, newChapters: 0, failed: 0 });

  const groupedEntries = new Map<string, PersistedNovelLibraryEntry[]>();
  for (const entry of entries) {
    const sourceId = sourceIdForNovelEntry(entry) ?? "unknown";
    const current = groupedEntries.get(sourceId) ?? [];
    current.push(entry);
    groupedEntries.set(sourceId, current);
  }

  for (const [sourceId, group] of groupedEntries) {
    for (let index = 0; index < group.length; index += 1) {
      const entry = group[index];
      const entrySourceId = sourceIdForNovelEntry(entry);
      const sourceName = sourceNameForNovelEntry(entry);
      options.onProgress?.({ checked, total, currentTitle: entry.title, newChapters: newChapterEntries.length, failed });
      if (!entrySourceId) {
        failed += 1;
        checked += 1;
        failures.push({
          novelId: entry.id,
          title: entry.title,
          sourceId: "unknown",
          sourceName: translate("libraryUpdate_unknownSource"),
          error: translate("libraryUpdate_missingSourceId"),
          errorType: "missing-source",
        });
        options.onProgress?.({ checked, total, currentTitle: entry.title, newChapters: newChapterEntries.length, failed });
        continue;
      }

      try {
        const detail = await readInstalledNovelDetails(scopeInput, entrySourceId, entry.path, {
          title: entry.title,
          coverUrl: entry.coverUrl,
        });
        const merged = mergeNovelDetailIntoLibraryState(state, entry, detail, Date.now());
        state = merged.state;
        newChapterEntries.push(...merged.newChapters);
        if (options.downloadNewChapters && merged.newChapters.length > 0) {
          for (const chapter of merged.newChapters) {
            try {
              const loaded = await readInstalledNovelChapter(scopeInput, chapter.sourceId, chapter.chapterPath);
              await saveCachedNovelChapter(scopeInput, {
                sourceId: chapter.sourceId,
                novelId: chapter.novelId,
                chapterId: chapter.chapterId,
                chapterPath: chapter.chapterPath,
                chapterTitle: chapter.chapterTitle,
                content: loaded.content,
              });
            } catch (downloadError) {
              console.warn("Could not cache new novel chapter for offline reading:", chapter.novelTitle, chapter.chapterTitle, downloadError);
            }
          }
        }
        updated += 1;
        checked += 1;
      } catch (error) {
        const message = errorMessage(error);
        const classification = classifySourceAccessError(error);
        if (classification.sourceWide) {
          const affected = group.length - index;
          failed += affected;
          checked += affected;
          failures.push({
            novelId: `source:${sourceId}`,
            title: sourceName,
            sourceId,
            sourceName,
            error: classification.errorType === "source-challenge"
              ? translate("libraryUpdate_novelChallengeIssue", { count: affected, message })
              : translate("libraryUpdate_novelUnavailableIssue", { count: affected, message }),
            errorType: classification.errorType,
            retrySourceId: sourceId,
            retryKind: "novels-source",
            recoveryHint: classification.errorType === "source-challenge" ? "flaresolverr" : undefined,
          });
          console.warn("Could not refresh source novels:", sourceName, error);
          options.onProgress?.({ checked, total, currentTitle: entry.title, newChapters: newChapterEntries.length, failed });
          break;
        }

        failed += 1;
        checked += 1;
        failures.push({
          novelId: entry.id,
          title: entry.title,
          sourceId: entrySourceId,
          sourceName,
          error: message,
          errorType: classification.errorType,
          retrySourceId: entrySourceId,
          retryKind: "novels-source",
        });
        console.warn("Could not refresh source novel:", entry.title, error);
      } finally {
        options.onProgress?.({ checked, total, currentTitle: entry.title, newChapters: newChapterEntries.length, failed });
        if (checked < total) await sleep(pauseMs);
      }
    }
  }

  if (updated > 0) {
    state = await saveNovelLibraryState(state, scopeInput);
  }

  return {
    state,
    checked,
    total,
    updated,
    failed,
    newChapters: newChapterEntries.length,
    newChapterEntries,
    failures,
  };
}

export interface RefreshNovelDetailResult {
  detail: NovelDetailRecord;
  /** The saved library state when the novel is in the library, otherwise null. */
  state: PersistedNovelLibraryState | null;
  newChapters: number;
}

/**
 * Reloads one novel's details and chapter list from its source. A novel in the library is merged into it
 * (keeping read state, progress and bookmarks) and saved; a running library update finishes first.
 */
export async function refreshNovelDetailFromSource(
  scopeInput: NovelRepositoryScopeInput,
  novel: Pick<NovelDetailRecord, "id" | "sourceId" | "path" | "title" | "coverUrl">,
  inLibrary: boolean,
): Promise<RefreshNovelDetailResult> {
  const detail = await readInstalledNovelDetails(scopeInput, novel.sourceId, novel.path, {
    title: novel.title,
    coverUrl: novel.coverUrl,
  });
  if (!inLibrary) return { detail, state: null, newChapters: 0 };
  if (activeNovelUpdate) await activeNovelUpdate.catch(() => null);
  const state = await loadNovelLibraryState(scopeInput);
  const entry = state.entries.find((candidate) => candidate.id === novel.id);
  if (!entry) return { detail, state: null, newChapters: 0 };
  const merged = mergeNovelDetailIntoLibraryState(state, entry, detail, Date.now());
  return {
    detail,
    state: await saveNovelLibraryState(merged.state, scopeInput),
    newChapters: merged.newChapters.length,
  };
}

export function isNovelLibraryUpdateRunning(): boolean {
  return Boolean(activeNovelUpdate);
}

export async function refreshNovelLibraryFromSources(
  scopeInput: NovelRepositoryScopeInput = {},
  options: RefreshNovelLibraryOptions = {},
): Promise<RefreshNovelLibraryResult> {
  if (activeNovelUpdate) return activeNovelUpdate;
  activeNovelUpdate = runNovelUpdate(scopeInput, options).finally(() => {
    activeNovelUpdate = null;
  });
  return activeNovelUpdate;
}
