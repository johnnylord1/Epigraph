import { invoke } from "../tauri/invoke";

import { reconcileBookIdentityState } from "./identity";
import { extractIsbns } from "./isbn";
import { toPersistedBookEntry } from "./persisted";
import { normalizeBookBookmark, normalizeBookProgress } from "./progress";
import type { BookBookmarkEntry, BookEntry, BookProgress } from "./types";

const BOOK_LIBRARY_STATE_VERSION = 1 as const;

export interface BookLibraryStateScope {
  profileId?: string | null;
}

export interface PersistedBooksCategory {
  id: string;
  name: string;
  order: number;
  includeInUpdate?: "INCLUDE" | "EXCLUDE" | "UNSET";
}

export interface PersistedBooksLibraryUiState {
  activeCategoryId: string | null;
  typeFilter: "all" | "epub" | "pdf" | "sources";
  statusFilter: "all" | "unopened" | "in_progress" | "finished";
  search: string;
  sortMode: "az" | "author" | "recentlyAdded" | "recentlyRead" | "sectionCount";
  sortDir: "asc" | "desc";
}

export interface PersistedBookLibraryState {
  version: typeof BOOK_LIBRARY_STATE_VERSION;
  books: BookEntry[];
  bookProgress: BookProgress[];
  bookBookmarks: BookBookmarkEntry[];
  booksCategories: PersistedBooksCategory[];
  booksCategoryAssignments: Record<string, string[]>;
  booksLibraryUi: PersistedBooksLibraryUiState;
  updatedAtMs: number | null;
}

const bookLibraryStateCache = new Map<string, PersistedBookLibraryState>();

function bookLibraryStateCacheKey(scope: BookLibraryStateScope = {}) {
  const profileId = typeof scope.profileId === "string" && scope.profileId.trim()
    ? scope.profileId.trim().toLowerCase()
    : "main";
  return profileId;
}

export function canUseDesktopBookStorage(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

function createEmptyState(): PersistedBookLibraryState {
  return {
    version: BOOK_LIBRARY_STATE_VERSION,
    books: [],
    bookProgress: [],
    bookBookmarks: [],
    booksCategories: [],
    booksCategoryAssignments: {},
    booksLibraryUi: {
      activeCategoryId: null,
      typeFilter: "all",
      statusFilter: "all",
      search: "",
      sortMode: "recentlyAdded",
      sortDir: "desc",
    },
    updatedAtMs: null,
  };
}

function normalizeLoadedBook(book: any): BookEntry {
  const hardcoverBookId = typeof book?.hardcoverBookId === "number" && Number.isFinite(book.hardcoverBookId)
    ? Math.trunc(book.hardcoverBookId)
    : null;
  return {
    id: String(book?.id ?? ""),
    assetFingerprint: typeof book?.assetFingerprint === "string" ? book.assetFingerprint : undefined,
    title: String(book?.title ?? "Imported book"),
    author: typeof book?.author === "string" ? book.author : null,
    description: typeof book?.description === "string" ? book.description : null,
    genres: Array.isArray(book?.genres) ? book.genres.filter((entry: unknown): entry is string => typeof entry === "string") : undefined,
    isbns: Array.isArray(book?.isbns) ? extractIsbns(book.isbns) : undefined,
    metadataBackfillVersion: typeof book?.metadataBackfillVersion === "number" ? book.metadataBackfillVersion : undefined,
    coverPath: typeof book?.coverPath === "string" ? book.coverPath : null,
    coverUrl: typeof book?.coverUrl === "string" ? book.coverUrl : undefined,
    hardcoverBookId: hardcoverBookId && hardcoverBookId > 0 ? hardcoverBookId : null,
    hardcoverCoverUrl: typeof book?.hardcoverCoverUrl === "string" ? book.hardcoverCoverUrl : null,
    subtype: book?.subtype === "pdf" ? "pdf" : "epub",
    pageCount: typeof book?.pageCount === "number" ? book.pageCount : null,
    createdAt: typeof book?.createdAt === "number" ? book.createdAt : 0,
    updatedAt: typeof book?.updatedAt === "number" ? book.updatedAt : 0,
    importPath: typeof book?.importPath === "string" ? book.importPath : "",
    assetPath: typeof book?.assetPath === "string" ? book.assetPath : "",
    toc: Array.isArray(book?.toc) ? book.toc : undefined,
    spine: Array.isArray(book?.spine) ? book.spine : undefined,
    tocCount: typeof book?.tocCount === "number" ? book.tocCount : undefined,
    spineCount: typeof book?.spineCount === "number" ? book.spineCount : undefined,
    sectionsSummary: Array.isArray(book?.sectionsSummary) ? book.sectionsSummary : undefined,
    sectionCount: typeof book?.sectionCount === "number" ? book.sectionCount : undefined,
  };
}

function normalizeLoadedBookBookmark(bookmark: unknown): BookBookmarkEntry {
  return normalizeBookBookmark(bookmark);
}

function normalizeLoadedBookProgress(progress: unknown): BookProgress {
  return normalizeBookProgress(progress);
}

function normalizeBooksCategories(value: unknown): PersistedBooksCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .map<PersistedBooksCategory>((entry, index) => ({
      id: typeof (entry as PersistedBooksCategory | null | undefined)?.id === "string" && (entry as PersistedBooksCategory).id.trim()
        ? (entry as PersistedBooksCategory).id.trim()
        : `books-cat-${index + 1}`,
      name: typeof (entry as PersistedBooksCategory | null | undefined)?.name === "string" && (entry as PersistedBooksCategory).name.trim()
        ? (entry as PersistedBooksCategory).name.trim()
        : `Category ${index + 1}`,
      order: typeof (entry as PersistedBooksCategory | null | undefined)?.order === "number"
        ? (entry as PersistedBooksCategory).order
        : index + 1,
      includeInUpdate: (entry as PersistedBooksCategory | null | undefined)?.includeInUpdate === "EXCLUDE"
        ? "EXCLUDE"
        : (entry as PersistedBooksCategory | null | undefined)?.includeInUpdate === "INCLUDE"
          ? "INCLUDE"
          : "UNSET",
    }))
    .sort((left, right) => left.order - right.order);
}

function normalizeBooksCategoryAssignments(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([bookId, ids]) => [
      String(bookId),
      Array.isArray(ids)
        ? [...new Set(ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0))]
        : [],
    ]),
  );
}

function normalizeBooksLibraryUi(value: unknown): PersistedBooksLibraryUiState {
  const record = value && typeof value === "object"
    ? value as Partial<PersistedBooksLibraryUiState>
    : {};
  const normalizedStatus = (() => {
    const raw = String(record.statusFilter ?? "all").toLowerCase();
    if (raw === "unopened") return "unopened";
    if (raw === "in_progress") return "in_progress";
    if (raw === "finished") return "finished";
    return "all";
  })() as PersistedBooksLibraryUiState["statusFilter"];
  const normalizedType = (() => {
    const raw = String(record.typeFilter ?? "all").toLowerCase();
    if (raw === "epub") return "epub";
    if (raw === "pdf") return "pdf";
    if (raw === "sources") return "sources";
    return "all";
  })() as PersistedBooksLibraryUiState["typeFilter"];
  const normalizedSortMode = (() => {
    const raw = String(record.sortMode ?? "recentlyAdded");
    if (raw === "az" || raw === "author" || raw === "recentlyAdded" || raw === "recentlyRead" || raw === "sectionCount") {
      return raw;
    }
    return "recentlyAdded";
  })() as PersistedBooksLibraryUiState["sortMode"];

  return {
    activeCategoryId: typeof record.activeCategoryId === "string" && record.activeCategoryId.trim()
      ? record.activeCategoryId
      : null,
    typeFilter: normalizedType,
    statusFilter: normalizedStatus,
    search: typeof record.search === "string" ? record.search : "",
    sortMode: normalizedSortMode,
    sortDir: record.sortDir === "asc" ? "asc" : "desc",
  };
}

function persistBookLibraryStateCache(
  state: PersistedBookLibraryState,
  scope: BookLibraryStateScope = {},
): PersistedBookLibraryState {
  bookLibraryStateCache.set(bookLibraryStateCacheKey(scope), state);
  return state;
}

export function resetBookLibraryStateCacheForTests() {
  bookLibraryStateCache.clear();
}

export function normalizeBookLibraryState(value: unknown): PersistedBookLibraryState {
  if (!value || typeof value !== "object") {
    return createEmptyState();
  }

  const record = value as Record<string, unknown>;
  const reconciled = reconcileBookIdentityState(
    Array.isArray(record.books)
      ? record.books.map((book) => normalizeLoadedBook(book))
      : [],
    Array.isArray(record.bookProgress)
      ? record.bookProgress.map((progress) => normalizeLoadedBookProgress(progress))
      : [],
  );
  const validBookIds = new Set(reconciled.books.map((book) => book.id));

  return {
    version: BOOK_LIBRARY_STATE_VERSION,
    books: reconciled.books.map(toPersistedBookEntry),
    bookProgress: reconciled.bookProgress,
    bookBookmarks: Array.isArray(record.bookBookmarks)
      ? record.bookBookmarks
        .map((bookmark) => normalizeLoadedBookBookmark(bookmark))
        .filter((bookmark) => validBookIds.has(bookmark.bookId))
      : [],
    booksCategories: normalizeBooksCategories(record.booksCategories),
    booksCategoryAssignments: normalizeBooksCategoryAssignments(record.booksCategoryAssignments),
    booksLibraryUi: normalizeBooksLibraryUi(record.booksLibraryUi),
    updatedAtMs: typeof record.updatedAtMs === "number" ? record.updatedAtMs : null,
  };
}

export function peekBookLibraryState(): PersistedBookLibraryState {
  return bookLibraryStateCache.get(bookLibraryStateCacheKey())
    ?? createEmptyState();
}

export function peekPersistedBookEntry(bookId: string): BookEntry | null {
  const trimmed = bookId.trim();
  if (!trimmed) return null;
  return peekBookLibraryState().books.find((book) => book.id === trimmed) ?? null;
}

export function peekPersistedBookProgress(bookId: string): BookProgress | null {
  const trimmed = bookId.trim();
  if (!trimmed) return null;
  return peekBookLibraryState().bookProgress.find((progress) => progress.bookId === trimmed) ?? null;
}

async function persistBookLibraryStateToDesktop(
  state: PersistedBookLibraryState,
  scope: BookLibraryStateScope = {},
): Promise<PersistedBookLibraryState> {
  const normalized = normalizeBookLibraryState({
    ...state,
    updatedAtMs: Date.now(),
  });

  await invoke("write_book_library_state", {
    contents: JSON.stringify(normalized, null, 2),
    profileId: bookLibraryStateCacheKey(scope),
  });

  return persistBookLibraryStateCache(normalized, scope);
}

export async function loadBookLibraryState(scope: BookLibraryStateScope = {}): Promise<PersistedBookLibraryState> {
  const cached = bookLibraryStateCache.get(bookLibraryStateCacheKey(scope));
  if (cached) return cached;
  return reloadBookLibraryState(scope);
}

/** Restore must not treat a UI fallback/cache as evidence that disk is empty. */
export async function loadBookLibraryStateForRestore(scope: BookLibraryStateScope = {}): Promise<PersistedBookLibraryState> {
  if (!canUseDesktopBookStorage()) throw Error("RESTORE_BOOKS_STORAGE_UNAVAILABLE");
  const raw = await invoke<string | null>("read_book_library_state", { profileId: bookLibraryStateCacheKey(scope) });
  if (raw === null) return createEmptyState();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !["books", "bookProgress", "bookBookmarks", "booksCategories"].every(key => Array.isArray(parsed[key]))
      || !parsed.booksCategoryAssignments || typeof parsed.booksCategoryAssignments !== "object" || Array.isArray(parsed.booksCategoryAssignments)) throw Error();
    const normalized = normalizeBookLibraryState(parsed);
    for (const key of ["books", "bookProgress", "bookBookmarks", "booksCategories"] as const) {
      if (normalized[key].length !== parsed[key].length) throw Error();
    }
    return normalized;
  } catch { throw Error("RESTORE_BOOKS_DESTINATION_CORRUPT"); }
}

export async function reloadBookLibraryState(scope: BookLibraryStateScope = {}, options: { strict?: boolean } = {}): Promise<PersistedBookLibraryState> {
  if (options.strict) return persistBookLibraryStateCache(await loadBookLibraryStateForRestore(scope), scope);
  bookLibraryStateCache.delete(bookLibraryStateCacheKey(scope));

  if (!canUseDesktopBookStorage()) {
    return persistBookLibraryStateCache(createEmptyState(), scope);
  }

  const raw = await invoke<string | null>("read_book_library_state", {
    profileId: bookLibraryStateCacheKey(scope),
  }).catch(() => null);
  if (raw) {
    try {
      return persistBookLibraryStateCache(normalizeBookLibraryState(JSON.parse(raw)), scope);
    } catch {
      return persistBookLibraryStateCache(createEmptyState(), scope);
    }
  }

  return persistBookLibraryStateCache(createEmptyState(), scope);
}

export async function saveBookLibraryState(
  state: PersistedBookLibraryState,
  scope: BookLibraryStateScope = {},
): Promise<PersistedBookLibraryState> {
  const normalized = normalizeBookLibraryState({
    ...state,
    updatedAtMs: Date.now(),
  });

  if (!canUseDesktopBookStorage()) {
    return persistBookLibraryStateCache(normalized, scope);
  }

  return persistBookLibraryStateToDesktop(normalized, scope);
}
