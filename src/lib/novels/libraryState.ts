import { invoke } from "@tauri-apps/api/core";

import {
  type AethonNovelBookmarkEntry,
  type AethonNovelHistoryEntry,
  type AethonNovelProgressEntry,
} from "../backup/novelsBackup";
import { resolveNovelsProfileScope } from "../backup/novelsProfileState";
import { DEFAULT_LOCAL_PROFILE_ID, normalizeLocalProfileId, normalizeServerUrl } from "../localProfiles";
import type { NovelRepositoryScopeInput } from "./repositoryState";
import {
  type NovelMigrationChapterSnapshot,
  type NovelMigrationEntrySnapshot,
  type NovelMigrationStateSlice,
} from "../migration/types";
import {
  createNovelChapterId,
  createNovelLibraryId,
  normalizeStringArray,
  normalizeText,
  type NovelDetailRecord,
  type PersistedNovelChapterEntry,
  type PersistedNovelLibraryEntry,
  type PersistedNovelLibraryState,
} from "./domain";

const NOVEL_LIBRARY_STATE_KEY = "aethon-novels-library-state";
const NOVEL_LIBRARY_STATE_VERSION = 1 as const;
const novelLibraryStateCache = new Map<string, PersistedNovelLibraryState>();

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function storageOrNull(): StorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function canUseDesktopNovelStorage(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

function normalizeScopeInput(input: NovelRepositoryScopeInput = {}): { profileId: string | null; serverUrl: string | null } {
  const profileId = normalizeLocalProfileId(input.profileId);
  const serverUrl = normalizeServerUrl(input.serverUrl);
  return {
    profileId: profileId ?? (serverUrl ? null : DEFAULT_LOCAL_PROFILE_ID),
    serverUrl,
  };
}

function normalizeChapterEntry(value: unknown): PersistedNovelChapterEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const novelId = normalizeText(record.novelId);
  const path = normalizeText(record.path);
  const title = normalizeText(record.title);
  if (!novelId || !path || !title) return null;

  return {
    id: normalizeText(record.id) ?? createNovelChapterId(novelId, path),
    novelId,
    path,
    title,
    order: typeof record.order === "number" ? record.order : 0,
    releaseTime: typeof record.releaseTime === "number" ? record.releaseTime : null,
    unread: record.unread !== false,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
  };
}

function normalizeProgressEntry(value: unknown): AethonNovelProgressEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const novelId = normalizeText(record.novelId);
  if (!novelId) return null;

  return {
    novelId,
    chapterId: normalizeText(record.chapterId),
    chapterTitle: normalizeText(record.chapterTitle),
    progressPercent: typeof record.progressPercent === "number"
      ? Math.max(0, Math.min(1, record.progressPercent))
      : 0,
    locator: normalizeText(record.locator),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

function normalizeBookmarkEntry(value: unknown): AethonNovelBookmarkEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const novelId = normalizeText(record.novelId);
  if (!novelId) return null;

  return {
    novelId,
    chapterId: normalizeText(record.chapterId),
    chapterTitle: normalizeText(record.chapterTitle),
    locator: normalizeText(record.locator),
    label: normalizeText(record.label),
    savedAt: typeof record.savedAt === "number" ? record.savedAt : Date.now(),
  };
}

function normalizeHistoryEntry(value: unknown): AethonNovelHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const novelId = normalizeText(record.novelId);
  if (!novelId) return null;

  return {
    novelId,
    chapterId: normalizeText(record.chapterId),
    chapterTitle: normalizeText(record.chapterTitle),
    locator: normalizeText(record.locator),
    readAt: typeof record.readAt === "number" ? record.readAt : Date.now(),
  };
}

function normalizeLibraryEntry(value: unknown): PersistedNovelLibraryEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = normalizeText(record.id);
  const title = normalizeText(record.title);
  const path = normalizeText(record.path);
  if (!id || !title || !path) return null;

  const sourceValue = record.source;
  const source = sourceValue && typeof sourceValue === "object"
    ? {
        repositoryUrl: normalizeText((sourceValue as Record<string, unknown>).repositoryUrl),
        repositoryName: normalizeText((sourceValue as Record<string, unknown>).repositoryName),
        pluginId: normalizeText((sourceValue as Record<string, unknown>).pluginId),
        pluginName: normalizeText((sourceValue as Record<string, unknown>).pluginName),
        pluginVersion: normalizeText((sourceValue as Record<string, unknown>).pluginVersion),
        sourceId: normalizeText((sourceValue as Record<string, unknown>).sourceId),
        sourceName: normalizeText((sourceValue as Record<string, unknown>).sourceName),
        lang: normalizeText((sourceValue as Record<string, unknown>).lang),
      }
    : null;

  return {
    id,
    title,
    author: normalizeText(record.author),
    description: normalizeText(record.description),
    coverUrl: normalizeText(record.coverUrl),
    path,
    status: normalizeText(record.status),
    tags: normalizeStringArray(Array.isArray(record.tags) ? record.tags : []),
    source,
    chapterCount: typeof record.chapterCount === "number" ? record.chapterCount : 0,
    addedAt: typeof record.addedAt === "number" ? record.addedAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

function createEmptyState(scopeInput: NovelRepositoryScopeInput = {}): PersistedNovelLibraryState {
  return {
    version: NOVEL_LIBRARY_STATE_VERSION,
    scopeKey: resolveNovelsProfileScope(normalizeScopeInput(scopeInput)),
    entries: [],
    chapters: [],
    progress: [],
    bookmarks: [],
    history: [],
    updatedAtMs: null,
  };
}

function readLegacyStateMap(storage = storageOrNull()): Record<string, PersistedNovelLibraryState> {
  if (!storage) return {};
  const raw = storage.getItem(NOVEL_LIBRARY_STATE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([scopeKey, state]) => [
        scopeKey,
        normalizeNovelLibraryState(state, { profileId: null, serverUrl: null }, scopeKey),
      ]),
    );
  } catch {
    return {};
  }
}

function writeLegacyStateMap(next: Record<string, PersistedNovelLibraryState>, storage = storageOrNull()) {
  if (!storage) return;
  storage.setItem(NOVEL_LIBRARY_STATE_KEY, JSON.stringify(next));
}

function deleteLegacyStateScope(scopeKey: string, storage = storageOrNull()) {
  if (!storage) return;
  const next = readLegacyStateMap(storage);
  if (!(scopeKey in next)) return;
  delete next[scopeKey];
  if (Object.keys(next).length === 0) {
    storage.removeItem?.(NOVEL_LIBRARY_STATE_KEY);
    return;
  }
  writeLegacyStateMap(next, storage);
}

function readLegacyNovelLibraryState(scopeInput: NovelRepositoryScopeInput = {}): PersistedNovelLibraryState | null {
  const scopeKey = resolveNovelsProfileScope(normalizeScopeInput(scopeInput));
  const legacy = readLegacyStateMap()[scopeKey];
  return legacy ? normalizeNovelLibraryState(legacy, scopeInput, scopeKey) : null;
}

function persistNovelLibraryStateCache(state: PersistedNovelLibraryState): PersistedNovelLibraryState {
  novelLibraryStateCache.set(state.scopeKey, state);
  return state;
}

export function normalizeNovelLibraryState(
  value: unknown,
  scopeInput: NovelRepositoryScopeInput = {},
  fallbackScopeKey = resolveNovelsProfileScope(normalizeScopeInput(scopeInput)),
): PersistedNovelLibraryState {
  if (!value || typeof value !== "object") {
    return createEmptyState(scopeInput);
  }

  const record = value as Record<string, unknown>;
  return {
    version: NOVEL_LIBRARY_STATE_VERSION,
    scopeKey: normalizeText(record.scopeKey) ?? fallbackScopeKey,
    entries: Array.isArray(record.entries)
      ? record.entries.map((entry) => normalizeLibraryEntry(entry)).filter((entry): entry is PersistedNovelLibraryEntry => Boolean(entry))
      : [],
    chapters: Array.isArray(record.chapters)
      ? record.chapters.map((entry) => normalizeChapterEntry(entry)).filter((entry): entry is PersistedNovelChapterEntry => Boolean(entry))
      : [],
    progress: Array.isArray(record.progress)
      ? record.progress.map((entry) => normalizeProgressEntry(entry)).filter((entry): entry is AethonNovelProgressEntry => Boolean(entry))
      : [],
    bookmarks: Array.isArray(record.bookmarks)
      ? record.bookmarks.map((entry) => normalizeBookmarkEntry(entry)).filter((entry): entry is AethonNovelBookmarkEntry => Boolean(entry))
      : [],
    history: Array.isArray(record.history)
      ? record.history.map((entry) => normalizeHistoryEntry(entry)).filter((entry): entry is AethonNovelHistoryEntry => Boolean(entry))
      : [],
    updatedAtMs: typeof record.updatedAtMs === "number" ? record.updatedAtMs : null,
  };
}

export function peekNovelLibraryState(
  scopeInput: NovelRepositoryScopeInput = {},
): PersistedNovelLibraryState {
  const scopeKey = resolveNovelsProfileScope(normalizeScopeInput(scopeInput));
  return novelLibraryStateCache.get(scopeKey)
    ?? readLegacyNovelLibraryState(scopeInput)
    ?? createEmptyState(scopeInput);
}

export function resetNovelLibraryStateCacheForTests() {
  novelLibraryStateCache.clear();
}

async function persistNovelLibraryStateToDesktop(
  state: PersistedNovelLibraryState,
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelLibraryState> {
  const normalized = normalizeNovelLibraryState({
    ...state,
    updatedAtMs: Date.now(),
  }, scopeInput);
  const scope = normalizeScopeInput(scopeInput);

  await invoke("write_novel_library_state", {
    contents: JSON.stringify(normalized, null, 2),
    profileId: scope.profileId,
    serverUrl: scope.serverUrl,
  });

  deleteLegacyStateScope(normalized.scopeKey);
  return persistNovelLibraryStateCache(normalized);
}

export async function loadNovelLibraryState(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelLibraryState> {
  const scope = normalizeScopeInput(scopeInput);
  const scopeKey = resolveNovelsProfileScope(scope);
  const cached = novelLibraryStateCache.get(scopeKey);
  if (cached) return cached;

  if (!canUseDesktopNovelStorage()) {
    const legacy = readLegacyNovelLibraryState(scopeInput) ?? createEmptyState(scopeInput);
    return persistNovelLibraryStateCache(legacy);
  }

  const raw = await invoke<string | null>("read_novel_library_state", {
    profileId: scope.profileId,
    serverUrl: scope.serverUrl,
  });

  if (raw) {
    try {
      return persistNovelLibraryStateCache(normalizeNovelLibraryState(JSON.parse(raw), scopeInput, scopeKey));
    } catch {
      return persistNovelLibraryStateCache(createEmptyState(scopeInput));
    }
  }

  const legacy = readLegacyNovelLibraryState(scopeInput);
  if (legacy) {
    return persistNovelLibraryStateToDesktop(legacy, scopeInput);
  }

  return persistNovelLibraryStateCache(createEmptyState(scopeInput));
}

export async function reloadNovelLibraryState(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelLibraryState> {
  const scope = normalizeScopeInput(scopeInput);
  const scopeKey = resolveNovelsProfileScope(scope);
  novelLibraryStateCache.delete(scopeKey);
  return loadNovelLibraryState(scopeInput);
}

export async function saveNovelLibraryState(
  state: PersistedNovelLibraryState,
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelLibraryState> {
  const normalized = normalizeNovelLibraryState({
    ...state,
    updatedAtMs: Date.now(),
  }, scopeInput);

  if (!canUseDesktopNovelStorage()) {
    const stateMap = readLegacyStateMap();
    stateMap[normalized.scopeKey] = normalized;
    writeLegacyStateMap(stateMap);
    return persistNovelLibraryStateCache(normalized);
  }

  return persistNovelLibraryStateToDesktop(normalized, scopeInput);
}

export function upsertNovelInLibrary(
  state: PersistedNovelLibraryState,
  detail: NovelDetailRecord,
): PersistedNovelLibraryState {
  const now = Date.now();
  const existing = state.entries.find((entry) => entry.id === detail.id);
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
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };

  const nextChapters = detail.chapters.map((chapter) => {
    const existingChapter = state.chapters.find((entry) => entry.id === chapter.id);
    return {
      id: chapter.id || createNovelChapterId(detail.id, chapter.path),
      novelId: detail.id,
      path: chapter.path,
      title: chapter.title,
      order: chapter.order,
      releaseTime: chapter.releaseTime,
      unread: existingChapter?.unread ?? chapter.unread,
      updatedAt: existingChapter?.updatedAt ?? null,
    } satisfies PersistedNovelChapterEntry;
  });

  return {
    ...state,
    entries: [
      ...state.entries.filter((entry) => entry.id !== detail.id),
      nextEntry,
    ].sort((left, right) => right.updatedAt - left.updatedAt),
    chapters: [
      ...state.chapters.filter((entry) => entry.novelId !== detail.id),
      ...nextChapters,
    ].sort((left, right) => left.order - right.order),
    updatedAtMs: now,
  };
}

export function removeNovelFromLibraryState(
  state: PersistedNovelLibraryState,
  novelId: string,
): PersistedNovelLibraryState {
  return {
    ...state,
    entries: state.entries.filter((entry) => entry.id !== novelId),
    chapters: state.chapters.filter((entry) => entry.novelId !== novelId),
    progress: state.progress.filter((entry) => entry.novelId !== novelId),
    bookmarks: state.bookmarks.filter((entry) => entry.novelId !== novelId),
    history: state.history.filter((entry) => entry.novelId !== novelId),
    updatedAtMs: Date.now(),
  };
}

export function getNovelLibraryEntry(
  state: PersistedNovelLibraryState,
  novelId: string,
): PersistedNovelLibraryEntry | null {
  return state.entries.find((entry) => entry.id === novelId) ?? null;
}

export function getNovelLibraryChapters(
  state: PersistedNovelLibraryState,
  novelId: string,
): PersistedNovelChapterEntry[] {
  return state.chapters
    .filter((entry) => entry.novelId === novelId)
    .sort((left, right) => left.order - right.order);
}

export function isNovelInLibrary(
  state: PersistedNovelLibraryState,
  novelId: string,
): boolean {
  return state.entries.some((entry) => entry.id === novelId);
}

export function getNovelProgressEntry(
  state: PersistedNovelLibraryState,
  novelId: string,
): AethonNovelProgressEntry | null {
  return state.progress.find((entry) => entry.novelId === novelId) ?? null;
}

export function getNovelBookmarkEntries(
  state: PersistedNovelLibraryState,
  novelId: string,
): AethonNovelBookmarkEntry[] {
  return state.bookmarks
    .filter((entry) => entry.novelId === novelId)
    .sort((left, right) => right.savedAt - left.savedAt);
}

export function getNovelHistoryEntries(
  state: PersistedNovelLibraryState,
  novelId: string,
): AethonNovelHistoryEntry[] {
  return state.history
    .filter((entry) => entry.novelId === novelId)
    .sort((left, right) => right.readAt - left.readAt);
}

export function getNovelLastReadChapterId(
  state: PersistedNovelLibraryState,
  novelId: string,
): string | null {
  return getNovelProgressEntry(state, novelId)?.chapterId
    ?? getNovelHistoryEntries(state, novelId)[0]?.chapterId
    ?? null;
}

export function getNovelResumeChapter(
  state: PersistedNovelLibraryState,
  novelId: string,
): PersistedNovelChapterEntry | null {
  const chapters = getNovelLibraryChapters(state, novelId);
  if (chapters.length === 0) return null;

  const lastReadChapterId = getNovelLastReadChapterId(state, novelId);
  if (lastReadChapterId) {
    const lastRead = chapters.find((entry) => entry.id === lastReadChapterId);
    if (lastRead) return lastRead;
  }

  return chapters.find((entry) => entry.unread) ?? chapters[0] ?? null;
}

export function getNovelReadStats(
  state: PersistedNovelLibraryState,
  novelId: string,
): {
  total: number;
  read: number;
  unread: number;
  progressPercent: number;
} {
  const chapters = getNovelLibraryChapters(state, novelId);
  const total = chapters.length;
  const read = chapters.filter((entry) => !entry.unread).length;
  const unread = total - read;
  const persistedProgress = getNovelProgressEntry(state, novelId)?.progressPercent ?? null;
  return {
    total,
    read,
    unread,
    progressPercent: persistedProgress ?? (total > 0 ? read / total : 0),
  };
}

export function isNovelChapterBookmarked(
  state: PersistedNovelLibraryState,
  input: {
    novelId: string;
    chapterId?: string | null;
    locator?: string | null;
  },
): boolean {
  return state.bookmarks.some((entry) => (
    entry.novelId === input.novelId
    && (
      (input.chapterId && entry.chapterId === input.chapterId)
      || (input.locator && entry.locator === input.locator)
    )
  ));
}

export function toggleNovelChapterBookmark(
  state: PersistedNovelLibraryState,
  input: {
    novelId: string;
    chapterId: string;
    chapterTitle: string;
    locator?: string | null;
    label?: string | null;
  },
): PersistedNovelLibraryState {
  const matchesBookmark = (entry: AethonNovelBookmarkEntry) => (
    entry.novelId === input.novelId
    && (
      entry.chapterId === input.chapterId
      || (input.locator ? entry.locator === input.locator : false)
    )
  );

  if (state.bookmarks.some(matchesBookmark)) {
    return {
      ...state,
      bookmarks: state.bookmarks.filter((entry) => !matchesBookmark(entry)),
      updatedAtMs: Date.now(),
    };
  }

  return {
    ...state,
    bookmarks: [
      {
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterTitle: input.chapterTitle,
        locator: input.locator ?? input.chapterId,
        label: input.label ?? input.chapterTitle,
        savedAt: Date.now(),
      },
      ...state.bookmarks,
    ],
    updatedAtMs: Date.now(),
  };
}

export function markNovelChapterRead(
  state: PersistedNovelLibraryState,
  input: {
    novelId: string;
    chapterId: string;
    chapterTitle: string;
  },
): PersistedNovelLibraryState {
  const totalChapters = state.chapters.filter((entry) => entry.novelId === input.novelId).length;
  let readChapters = 0;
  const nextChapters = state.chapters.map((entry) => {
    if (entry.novelId !== input.novelId) {
      return entry;
    }

    const nextEntry = entry.id === input.chapterId
      ? { ...entry, unread: false }
      : entry;
    if (!nextEntry.unread) {
      readChapters += 1;
    }
    return nextEntry;
  });

  const progressPercent = totalChapters > 0 ? readChapters / totalChapters : 0;
  const updatedAt = Date.now();
  const progressEntry: AethonNovelProgressEntry = {
    novelId: input.novelId,
    chapterId: input.chapterId,
    chapterTitle: input.chapterTitle,
    progressPercent,
    locator: input.chapterId,
    updatedAt,
  };

  const historyEntry: AethonNovelHistoryEntry = {
    novelId: input.novelId,
    chapterId: input.chapterId,
    chapterTitle: input.chapterTitle,
    locator: input.chapterId,
    readAt: updatedAt,
  };

  return {
    ...state,
    chapters: nextChapters,
    progress: [
      ...state.progress.filter((entry) => entry.novelId !== input.novelId),
      progressEntry,
    ],
    history: [
      historyEntry,
      ...state.history.filter((entry) => !(entry.novelId === input.novelId && entry.chapterId === input.chapterId)),
    ].slice(0, 200),
    updatedAtMs: updatedAt,
  };
}

export function buildNovelDetailRecordFromLibrary(
  entry: PersistedNovelLibraryEntry,
  chapters: PersistedNovelChapterEntry[],
): NovelDetailRecord {
  return {
    id: entry.id,
    sourceId: entry.source?.sourceId ?? entry.source?.pluginId ?? "unknown",
    title: entry.title,
    path: entry.path,
    coverUrl: entry.coverUrl,
    author: entry.author,
    description: entry.description,
    status: entry.status,
    tags: entry.tags,
    chapterCount: entry.chapterCount,
    chapters: chapters.map((chapter) => ({
      id: chapter.id,
      novelId: chapter.novelId,
      path: chapter.path,
      title: chapter.title,
      order: chapter.order,
      releaseTime: chapter.releaseTime,
      unread: chapter.unread,
    })),
    source: entry.source,
  };
}

export function buildNovelDetailRecordId(sourceId: string, path: string): string {
  return createNovelLibraryId(sourceId, path);
}

export function snapshotNovelLibraryStateSlice(
  state: PersistedNovelLibraryState,
  novelId: string,
): NovelMigrationStateSlice {
  const entry = getNovelLibraryEntry(state, novelId);
  const chapters = getNovelLibraryChapters(state, novelId);
  const snapshotEntry: NovelMigrationEntrySnapshot | null = entry
    ? {
        id: entry.id,
        title: entry.title,
        author: entry.author,
        description: entry.description,
        coverUrl: entry.coverUrl,
        path: entry.path,
        status: entry.status,
        tags: [...entry.tags],
        chapterCount: entry.chapterCount,
        addedAt: entry.addedAt,
        updatedAt: entry.updatedAt,
        source: entry.source ? { ...entry.source } : null,
      }
    : null;

  const snapshotChapters: NovelMigrationChapterSnapshot[] = chapters.map((chapter) => ({
    id: chapter.id,
    novelId: chapter.novelId,
    path: chapter.path,
    title: chapter.title,
    order: chapter.order,
    releaseTime: chapter.releaseTime,
    unread: chapter.unread,
    updatedAt: chapter.updatedAt ?? null,
  }));

  return {
    scopeKey: state.scopeKey,
    entry: snapshotEntry,
    chapters: snapshotChapters,
    progress: state.progress
      .filter((progress) => progress.novelId === novelId)
      .map((progress) => ({ ...progress })),
    bookmarks: state.bookmarks
      .filter((bookmark) => bookmark.novelId === novelId)
      .map((bookmark) => ({ ...bookmark })),
    history: state.history
      .filter((entryItem) => entryItem.novelId === novelId)
      .map((entryItem) => ({ ...entryItem })),
  };
}

export function restoreNovelLibraryStateSlice(
  state: PersistedNovelLibraryState,
  slice: NovelMigrationStateSlice,
): PersistedNovelLibraryState {
  const novelId = slice.entry?.id ?? slice.chapters[0]?.novelId ?? normalizeText((slice.progress[0] as Record<string, unknown> | undefined)?.novelId) ?? null;
  if (!novelId) {
    return state;
  }

  const withoutNovel = removeNovelFromLibraryState(state, novelId);
  if (!slice.entry) {
    return withoutNovel;
  }

  return {
    ...withoutNovel,
    entries: [...withoutNovel.entries, {
      ...slice.entry,
      source: slice.entry.source ? { ...slice.entry.source } : null,
      tags: [...slice.entry.tags],
    }].sort((left, right) => right.updatedAt - left.updatedAt),
    chapters: [...withoutNovel.chapters, ...slice.chapters.map((chapter) => ({ ...chapter }))].sort((left, right) => left.order - right.order),
    progress: [...withoutNovel.progress, ...slice.progress.map((entry) => ({ ...entry as AethonNovelProgressEntry }))],
    bookmarks: [...withoutNovel.bookmarks, ...slice.bookmarks.map((entry) => ({ ...entry as AethonNovelBookmarkEntry }))],
    history: [...slice.history.map((entry) => ({ ...entry as AethonNovelHistoryEntry })), ...withoutNovel.history].slice(0, 200),
    updatedAtMs: Date.now(),
  };
}
