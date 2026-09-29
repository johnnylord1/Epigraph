// The novel reader loads chapters and saves reading changes through here. A detached reader window has no
// novel runtime host and does not write the novel library, so it hands both to the main window, which applies
// each change to its own copy of the library; a whole snapshot from the window could undo the main window's edits.
import type { ActiveNovelReaderState, PersistedNovelLibraryState } from "./domain";
import {
  isNovelChapterBookmarked,
  loadNovelLibraryState,
  rememberNovelLibraryState,
  saveNovelLibraryState,
  toggleNovelChapterBookmark,
  updateNovelReadingProgress,
} from "./libraryState";
import { loadCachedNovelChapter, saveCachedNovelChapter } from "./offlineChapters";
import type { NovelRepositoryScopeInput } from "./repositoryState";
import { readInstalledNovelChapter } from "./sources";

export type NovelReaderChange =
  | { kind: "progress"; novelId: string; chapterId: string; chapterTitle: string; chapterProgress: number; completed: boolean; updatedAt: number }
  | { kind: "bookmark"; novelId: string; chapterId: string; chapterTitle: string; bookmarked: boolean };

export interface NovelReaderRelay {
  loadChapter(scope: NovelRepositoryScopeInput, reader: ActiveNovelReaderState): Promise<unknown>;
  saveChanges(scope: NovelRepositoryScopeInput, changes: NovelReaderChange[]): Promise<unknown>;
}

/** Fired in the main window after it saved a reader window's changes, so an open novel page can show them. */
export const NOVEL_READER_CHANGES_SAVED_EVENT = "epigraph-novel-reader-changes-saved";

let relay: NovelReaderRelay | null = null;
let saveChain: Promise<unknown> = Promise.resolve();

export function setNovelReaderRelay(next: NovelReaderRelay | null) {
  relay = next;
}

export async function loadNovelChapterContent(scope: NovelRepositoryScopeInput, reader: ActiveNovelReaderState): Promise<string> {
  if (relay) {
    const content = await relay.loadChapter(scope, reader);
    if (typeof content !== "string") throw new Error("Novel chapter did not return readable content.");
    return content;
  }
  const cached = await loadCachedNovelChapter(scope, reader.sourceId, reader.chapterPath);
  if (cached) return cached.content;
  const result = await readInstalledNovelChapter(scope, reader.sourceId, reader.chapterPath);
  await saveCachedNovelChapter(scope, {
    sourceId: reader.sourceId,
    novelId: reader.novelId,
    chapterId: reader.chapterId,
    chapterPath: reader.chapterPath,
    chapterTitle: reader.chapterTitle,
    content: result.content,
  }).catch(() => null);
  return result.content;
}

export function applyNovelReaderChanges(state: PersistedNovelLibraryState, changes: NovelReaderChange[]): PersistedNovelLibraryState {
  return changes.reduce((next, change) => {
    if (change.kind === "progress") return updateNovelReadingProgress(next, change);
    const bookmark = { novelId: change.novelId, chapterId: change.chapterId, chapterTitle: change.chapterTitle, locator: change.chapterId };
    // Toggled only when it differs, so a change another window already made is not undone.
    return isNovelChapterBookmarked(next, bookmark) === change.bookmarked ? next : toggleNovelChapterBookmark(next, bookmark);
  }, state);
}

/** Main window: applies a reader window's changes to the current library and saves it. */
export function saveNovelReaderChanges(scope: NovelRepositoryScopeInput, changes: NovelReaderChange[]): Promise<void> {
  const operation = saveChain.then(async () => {
    const current = await loadNovelLibraryState(scope);
    const saved = await saveNovelLibraryState(applyNovelReaderChanges(current, changes), scope);
    try {
      globalThis.dispatchEvent?.(new CustomEvent(NOVEL_READER_CHANGES_SAVED_EVENT, { detail: { scopeKey: saved.scopeKey } }));
    } catch {}
  });
  saveChain = operation.catch(() => {});
  return operation;
}

/** Reader window: hands its changes to the main window and keeps its own copy for the next chapter. */
export async function relayNovelReaderChanges(
  changes: NovelReaderChange[],
  local: PersistedNovelLibraryState,
  scope: NovelRepositoryScopeInput,
): Promise<PersistedNovelLibraryState> {
  if (!relay) throw new Error("NOVEL_READER_RELAY_UNAVAILABLE");
  if (changes.length > 0) await relay.saveChanges(scope, changes);
  return rememberNovelLibraryState(local, scope);
}

function text(value: unknown, max = 4096): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export function readNovelReaderScope(value: unknown): NovelRepositoryScopeInput {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { profileId: text(record.profileId), serverUrl: text(record.serverUrl) };
}

export function readNovelReaderTarget(value: unknown): ActiveNovelReaderState {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const reader = {
    novelId: text(record.novelId),
    chapterId: text(record.chapterId),
    chapterPath: text(record.chapterPath),
    chapterTitle: typeof record.chapterTitle === "string" ? record.chapterTitle.slice(0, 4096) : "",
    sourceId: text(record.sourceId),
  };
  if (!reader.novelId || !reader.chapterId || !reader.chapterPath || !reader.sourceId) throw new Error("NOVEL_READER_TARGET_INVALID");
  return reader as ActiveNovelReaderState;
}

export function readNovelReaderChanges(value: unknown): NovelReaderChange[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("NOVEL_READER_CHANGES_INVALID");
  return value.map((entry) => {
    const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const novelId = text(record.novelId);
    const chapterId = text(record.chapterId);
    const chapterTitle = typeof record.chapterTitle === "string" ? record.chapterTitle.slice(0, 4096) : "";
    if (!novelId || !chapterId) throw new Error("NOVEL_READER_CHANGES_INVALID");
    if (record.kind === "bookmark" && typeof record.bookmarked === "boolean") {
      return { kind: "bookmark", novelId, chapterId, chapterTitle, bookmarked: record.bookmarked };
    }
    const chapterProgress = Number(record.chapterProgress);
    const updatedAt = Number(record.updatedAt);
    if (record.kind !== "progress" || !Number.isFinite(chapterProgress) || !Number.isFinite(updatedAt)) {
      throw new Error("NOVEL_READER_CHANGES_INVALID");
    }
    return {
      kind: "progress", novelId, chapterId, chapterTitle,
      chapterProgress: Math.max(0, Math.min(1, chapterProgress)), completed: record.completed === true, updatedAt,
    };
  });
}
