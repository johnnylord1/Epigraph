import { invoke } from "@tauri-apps/api/core";

import { reconcileBookIdentityState } from "./identity";
import { BookAssetResolver } from "./assets";
import { normalizeBookBookmark, normalizeBookProgress } from "./progress";
import type { BookBookmarkEntry, BookEntry, BookProgress } from "./types";

const BOOK_LIBRARY_STATE_VERSION = 1 as const;
const LEGACY_STORE_KEY = "moku-store";
const bookLibraryStateCacheKey = "global";

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

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const bookLibraryStateCache = new Map<string, PersistedBookLibraryState>();

function storageOrNull(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
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
  return {
    id: String(book?.id ?? ""),
    assetFingerprint: typeof book?.assetFingerprint === "string" ? book.assetFingerprint : undefined,
    title: String(book?.title ?? "Imported book"),
    author: typeof book?.author === "string" ? book.author : null,
    description: typeof book?.description === "string" ? book.description : null,
    genres: Array.isArray(book?.genres) ? book.genres.filter((entry: unknown): entry is string => typeof entry === "string") : undefined,
    coverPath: typeof book?.coverPath === "string" ? book.coverPath : null,
    coverUrl: typeof book?.coverUrl === "string" ? book.coverUrl : undefined,
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

function readLegacyStore(storage = storageOrNull()): Record<string, unknown> | null {
  if (!storage) return null;
  const raw = storage.getItem(LEGACY_STORE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeLegacyStore(next: Record<string, unknown>, storage = storageOrNull()) {
  if (!storage) return;
  storage.setItem(LEGACY_STORE_KEY, JSON.stringify(next));
}

function normalizeBooksCategories(value: unknown): PersistedBooksCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => ({
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

function deleteLegacyBookLibraryState(storage = storageOrNull()) {
  const current = readLegacyStore(storage);
  if (!storage || !current) return;

  const next = { ...current };
  delete next.books;
  delete next.bookProgress;
  delete next.bookBookmarks;
  if (next.settings && typeof next.settings === "object") {
    const nextSettings = { ...(next.settings as Record<string, unknown>) };
    delete nextSettings.booksCategories;
    delete nextSettings.booksCategoryAssignments;
    delete nextSettings.booksLibraryUi;
    next.settings = nextSettings;
  }

  if (Object.keys(next).length === 0) {
    storage.removeItem?.(LEGACY_STORE_KEY);
    return;
  }

  writeLegacyStore(next, storage);
}

function readLegacyBookLibraryState(storage = storageOrNull()): PersistedBookLibraryState | null {
  const current = readLegacyStore(storage);
  if (!current) return null;

  const hasLegacyBooks =
    Array.isArray(current.books)
    || Array.isArray(current.bookProgress)
    || Array.isArray(current.bookBookmarks)
    || Array.isArray((current.settings as Record<string, unknown> | undefined)?.booksCategories)
    || Boolean((current.settings as Record<string, unknown> | undefined)?.booksCategoryAssignments)
    || Boolean((current.settings as Record<string, unknown> | undefined)?.booksLibraryUi);

  if (!hasLegacyBooks) return null;

  const legacySettings = current.settings && typeof current.settings === "object"
    ? current.settings as Record<string, unknown>
    : {};

  return normalizeBookLibraryState({
    books: current.books,
    bookProgress: current.bookProgress,
    bookBookmarks: current.bookBookmarks,
    booksCategories: legacySettings.booksCategories,
    booksCategoryAssignments: legacySettings.booksCategoryAssignments,
    booksLibraryUi: legacySettings.booksLibraryUi,
  });
}

function writeLegacyBookLibraryState(state: PersistedBookLibraryState, storage = storageOrNull()) {
  if (!storage) return;
  const current = readLegacyStore(storage) ?? {};
  writeLegacyStore({
    ...current,
    books: state.books,
    bookProgress: state.bookProgress,
    bookBookmarks: state.bookBookmarks,
    settings: {
      ...(current.settings && typeof current.settings === "object" ? current.settings as Record<string, unknown> : {}),
      booksCategories: state.booksCategories,
      booksCategoryAssignments: state.booksCategoryAssignments,
      booksLibraryUi: state.booksLibraryUi,
    },
  }, storage);
}

function persistBookLibraryStateCache(state: PersistedBookLibraryState): PersistedBookLibraryState {
  bookLibraryStateCache.set(bookLibraryStateCacheKey, state);
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
    books: reconciled.books.map((book) => BookAssetResolver.toPersistedBookEntry(book)),
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
  return bookLibraryStateCache.get(bookLibraryStateCacheKey)
    ?? readLegacyBookLibraryState()
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
): Promise<PersistedBookLibraryState> {
  const normalized = normalizeBookLibraryState({
    ...state,
    updatedAtMs: Date.now(),
  });

  await invoke("write_book_library_state", {
    contents: JSON.stringify(normalized, null, 2),
  });

  deleteLegacyBookLibraryState();
  return persistBookLibraryStateCache(normalized);
}

export async function loadBookLibraryState(): Promise<PersistedBookLibraryState> {
  const cached = bookLibraryStateCache.get(bookLibraryStateCacheKey);
  if (cached) return cached;
  return reloadBookLibraryState();
}

export async function reloadBookLibraryState(): Promise<PersistedBookLibraryState> {
  bookLibraryStateCache.delete(bookLibraryStateCacheKey);

  if (!canUseDesktopBookStorage()) {
    return persistBookLibraryStateCache(readLegacyBookLibraryState() ?? createEmptyState());
  }

  const raw = await invoke<string | null>("read_book_library_state").catch(() => null);
  if (raw) {
    try {
      deleteLegacyBookLibraryState();
      return persistBookLibraryStateCache(normalizeBookLibraryState(JSON.parse(raw)));
    } catch {
      return persistBookLibraryStateCache(createEmptyState());
    }
  }

  const legacy = readLegacyBookLibraryState();
  if (legacy) {
    return persistBookLibraryStateToDesktop(legacy);
  }

  return persistBookLibraryStateCache(createEmptyState());
}

export async function saveBookLibraryState(
  state: PersistedBookLibraryState,
): Promise<PersistedBookLibraryState> {
  const normalized = normalizeBookLibraryState({
    ...state,
    updatedAtMs: Date.now(),
  });

  if (!canUseDesktopBookStorage()) {
    writeLegacyBookLibraryState(normalized);
    return persistBookLibraryStateCache(normalized);
  }

  return persistBookLibraryStateToDesktop(normalized);
}
