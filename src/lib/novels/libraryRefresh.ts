import type { NovelRepositoryScopeInput } from "./repositoryState";
import {
  loadNovelLibraryState,
  saveNovelLibraryState,
} from "./libraryState";
import { saveCachedNovelChapter } from "./offlineChapters";
import { readInstalledNovelChapter, readInstalledNovelDetails } from "./sources";
import {
  createNovelChapterId,
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
  onProgress?: (progress: RefreshNovelLibraryProgress) => void;
}

let activeNovelUpdate: Promise<RefreshNovelLibraryResult> | null = null;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      coverUrl: detail.coverUrl,
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
    coverUrl: detail.coverUrl,
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
  const entries = state.entries.filter((entry) => shouldRefreshNovelEntry(entry, options));
  const total = entries.length;
  const pauseMs = options.pauseMs ?? 800;
  const newChapterEntries: RefreshedNovelChapter[] = [];
  const failures: RefreshNovelLibraryFailure[] = [];
  let checked = 0;
  let updated = 0;
  let failed = 0;

  options.onProgress?.({ checked, total, currentTitle: null, newChapters: 0, failed: 0 });

  for (const entry of entries) {
    const sourceId = entry.source?.pluginId ?? entry.source?.sourceId;
    options.onProgress?.({ checked, total, currentTitle: entry.title, newChapters: newChapterEntries.length, failed });
    if (!sourceId) {
      failed += 1;
      checked += 1;
      failures.push({ novelId: entry.id, title: entry.title, sourceId: "unknown", sourceName: "Unknown source", error: "Missing source id" });
      options.onProgress?.({ checked, total, currentTitle: entry.title, newChapters: newChapterEntries.length, failed });
      continue;
    }

    try {
      const detail = await readInstalledNovelDetails(scopeInput, sourceId, entry.path, {
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
    } catch (error) {
      failed += 1;
      failures.push({
        novelId: entry.id,
        title: entry.title,
        sourceId,
        sourceName: entry.source?.sourceName ?? entry.source?.pluginName ?? sourceId,
        error: errorMessage(error),
      });
      console.warn("Could not refresh source novel:", entry.title, error);
    } finally {
      checked += 1;
      options.onProgress?.({ checked, total, currentTitle: entry.title, newChapters: newChapterEntries.length, failed });
      if (checked < total) await sleep(pauseMs);
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
