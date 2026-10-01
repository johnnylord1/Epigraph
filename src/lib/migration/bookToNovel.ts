import type { BookProgress } from "../books/types";
import type { NovelDetailChapter, NovelDetailRecord, PersistedNovelLibraryState } from "../novels/domain";
import type { NovelRepositoryScopeInput } from "../novels/repositoryState";
import {
  getNovelLibraryChapters,
  getNovelProgressEntry,
  isNovelInLibrary,
  loadNovelLibraryState,
  saveNovelLibraryState,
  updateNovelReadingProgress,
  upsertNovelInLibrary,
} from "../novels/libraryState";
import { extractedChapterNumber, normalizeText } from "./chapterMapping";

/**
 * Book → novel is a copy, never a move: the imported book is user data and stays untouched.
 * The novel is added to the library and the book's reading position is carried to the
 * matching chapter when one can be found.
 */
export type BookToNovelMatchReason = "section-title" | "section-number" | "percent" | "none";

export interface BookToNovelProgressMatch {
  chapter: NovelDetailChapter | null;
  reason: BookToNovelMatchReason;
}

export interface BookToNovelPreview {
  confidence: number;
  match: BookToNovelProgressMatch;
  /** Chapters before the mapped one that will be marked read. */
  readCount: number;
  alreadyInLibrary: boolean;
  /** True when the novel already has progress at or past the mapped chapter, which is kept. */
  keepsExistingProgress: boolean;
}

type BookProgressInput = Pick<BookProgress, "progressPercent" | "sectionLabel"> | null | undefined;

function uniqueMatch(chapters: readonly NovelDetailChapter[], predicate: (chapter: NovelDetailChapter) => boolean) {
  const found = chapters.filter(predicate);
  return found.length === 1 ? found[0] : null;
}

export function bookToNovelTitleConfidence(bookTitle: string, novelTitle: string): number {
  const left = new Set(normalizeText(bookTitle).split(/\s+/).filter(Boolean));
  const right = new Set(normalizeText(novelTitle).split(/\s+/).filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared / new Set([...left, ...right]).size;
}

export function matchBookProgressToNovelChapter(
  progress: BookProgressInput,
  chapters: readonly NovelDetailChapter[],
): BookToNovelProgressMatch {
  const ordered = [...chapters].sort((left, right) => left.order - right.order);
  if (!progress || ordered.length === 0) return { chapter: null, reason: "none" };

  const label = normalizeText(progress.sectionLabel);
  if (label) {
    const byTitle = uniqueMatch(ordered, (chapter) => normalizeText(chapter.title) === label);
    if (byTitle) return { chapter: byTitle, reason: "section-title" };
    const number = extractedChapterNumber(progress.sectionLabel ?? "");
    const byNumber = number ? uniqueMatch(ordered, (chapter) => extractedChapterNumber(chapter.title) === number) : null;
    if (byNumber) return { chapter: byNumber, reason: "section-number" };
  }

  const percent = Math.max(0, Math.min(1, Number(progress.progressPercent) || 0));
  if (percent <= 0) return { chapter: null, reason: "none" };
  const index = Math.min(ordered.length - 1, Math.floor(percent * ordered.length));
  return { chapter: ordered[index], reason: "percent" };
}

function existingProgressReaches(
  state: PersistedNovelLibraryState,
  target: NovelDetailRecord,
  chapter: NovelDetailChapter,
): boolean {
  const existing = getNovelProgressEntry(state, target.id);
  if (!existing?.chapterId) return false;
  const current = target.chapters.find((entry) => entry.id === existing.chapterId || entry.path === existing.chapterId);
  return current ? current.order >= chapter.order : false;
}

export function previewBookToNovel(input: {
  bookTitle: string;
  progress: BookProgressInput;
  target: NovelDetailRecord;
  state: PersistedNovelLibraryState;
}): BookToNovelPreview {
  const match = matchBookProgressToNovelChapter(input.progress, input.target.chapters);
  const keepsExistingProgress = match.chapter ? existingProgressReaches(input.state, input.target, match.chapter) : false;
  const readCount = match.chapter && !keepsExistingProgress
    ? input.target.chapters.filter((chapter) => chapter.order < match.chapter!.order).length
    : 0;
  return {
    confidence: bookToNovelTitleConfidence(input.bookTitle, input.target.title),
    match,
    readCount,
    alreadyInLibrary: isNovelInLibrary(input.state, input.target.id),
    keepsExistingProgress,
  };
}

export function buildBookToNovelLibraryState(
  state: PersistedNovelLibraryState,
  target: NovelDetailRecord,
  match: BookToNovelProgressMatch,
  now = Date.now(),
): PersistedNovelLibraryState {
  const added = upsertNovelInLibrary(state, target);
  const mapped = match.chapter;
  if (!mapped || existingProgressReaches(state, target, mapped)) return added;

  const persisted = getNovelLibraryChapters(added, target.id);
  const landing = persisted.find((chapter) => chapter.path === mapped.path);
  if (!landing) return added;

  const withReadState: PersistedNovelLibraryState = {
    ...added,
    chapters: added.chapters.map((chapter) => (
      chapter.novelId === target.id && chapter.order < landing.order ? { ...chapter, unread: false } : chapter
    )),
  };
  return updateNovelReadingProgress(withReadState, {
    novelId: target.id,
    chapterId: landing.id,
    chapterTitle: landing.title,
    chapterProgress: 0,
    updatedAt: now,
  });
}

export async function copyBookToNovelLibrary(input: {
  scopeInput: NovelRepositoryScopeInput;
  progress: BookProgressInput;
  target: NovelDetailRecord;
}): Promise<PersistedNovelLibraryState> {
  const state = await loadNovelLibraryState(input.scopeInput);
  const match = matchBookProgressToNovelChapter(input.progress, input.target.chapters);
  return saveNovelLibraryState(buildBookToNovelLibraryState(state, input.target, match), input.scopeInput);
}
