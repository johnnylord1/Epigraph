import JSZip from "jszip";
import {
  EPIGRAPH_BACKUP_PAYLOAD_REGISTRY,
  buildEpigraphBackupContainer,
  inspectEpigraphBackupContainer,
  type EpigraphBackupPayloadBuildInput,
  type BuiltEpigraphBackupContainer,
  type InspectedEpigraphBackupContainer,
} from "./epigraphBackup";
import { reconcileBookIdentityState } from "../books/identity";
import type { PersistedBookLibraryState, PersistedBooksLibraryUiState } from "../books/libraryState";
import { normalizeBookBookmark, normalizeBookProgress } from "../books/progress";
import { readFileAsArrayBuffer, writeBookAsset, writeBookCover } from "../books/storage";
import type { BookBookmarkEntry, BookEntry, BookProgress, BookSectionSummaryItem, BookSubtype } from "../books/types";

export type EpigraphBooksExportMode = "full" | "metadata-only";
export type EpigraphBooksRestoreIssueCode =
  | "missing-books-payload"
  | "invalid-books-payload"
  | "missing-library-file"
  | "missing-progress-file"
  | "missing-bookmarks-file"
  | "missing-categories-file"
  | "missing-asset-file"
  | "missing-cover-file"
  | "metadata-only-book";

export interface EpigraphBooksCategoryRecord {
  id: string;
  name: string;
  order: number;
}

export interface EpigraphBooksSnapshot {
  books: BookEntry[];
  bookProgress: BookProgress[];
  bookBookmarks: BookBookmarkEntry[];
  booksCategories?: EpigraphBooksCategoryRecord[];
  booksCategoryAssignments?: Record<string, string[]>;
  booksLibraryUi?: PersistedBooksLibraryUiState;
}

interface PortableBookRecord {
  id: string;
  assetFingerprint?: string;
  title: string;
  author: string | null;
  description: string | null;
  subtype: BookSubtype;
  pageCount: number | null;
  createdAt: number;
  updatedAt: number;
  tocCount: number;
  spineCount: number;
  sectionsSummary: BookSectionSummaryItem[];
  sectionCount: number;
  assetArchivePath: string | null;
  coverArchivePath: string | null;
  importPathHint: string | null;
}

interface BooksLibraryFile {
  version: 1;
  books: PortableBookRecord[];
}

interface BooksProgressFile {
  version: 1;
  progress: BookProgress[];
}

interface BooksBookmarksFile {
  version: 1;
  bookmarks: BookBookmarkEntry[];
}

interface BooksCategoriesFile {
  version: 1;
  categories: EpigraphBooksCategoryRecord[];
  assignments: Record<string, string[]>;
  ui: PersistedBooksLibraryUiState;
}

export interface EpigraphBooksRestoreIssue {
  code: EpigraphBooksRestoreIssueCode;
  message: string;
  bookId?: string;
  path?: string;
}

export interface ParsedEpigraphBooksPayload {
  exportMode: EpigraphBooksExportMode;
  library: BooksLibraryFile;
  progress: BooksProgressFile;
  bookmarks: BooksBookmarksFile;
  categories: BooksCategoriesFile;
  inspection: InspectedEpigraphBackupContainer;
}

export interface RestoredEpigraphBooksSnapshot extends EpigraphBooksSnapshot {
  exportMode: EpigraphBooksExportMode;
  booksCategories: EpigraphBooksCategoryRecord[];
  booksCategoryAssignments: Record<string, string[]>;
  booksLibraryUi: PersistedBooksLibraryUiState;
  issues: EpigraphBooksRestoreIssue[];
}

type BooksBackupReadDeps = {
  readBinaryFile: (path: string) => Promise<ArrayBuffer>;
};

type BooksBackupWriteDeps = {
  writeManagedBookAsset: (bookId: string, bytesBase64: string, ext: string) => Promise<string>;
  writeManagedBookCover: (bookId: string, bytesBase64: string, ext: string) => Promise<string>;
};

const defaultReadDeps: BooksBackupReadDeps = {
  readBinaryFile: readFileAsArrayBuffer,
};

const defaultWriteDeps: BooksBackupWriteDeps = {
  writeManagedBookAsset: writeBookAsset,
  writeManagedBookCover: writeBookCover,
};

const BOOKS_LIBRARY_FILE_PATH = "library.json";
const BOOKS_PROGRESS_FILE_PATH = "progress.json";
const BOOKS_BOOKMARKS_FILE_PATH = "bookmarks.json";
const BOOKS_CATEGORIES_FILE_PATH = "categories.json";

function normalizeArchiveRelativePath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized) throw new Error("Books backup path cannot be empty.");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Unsafe books backup path: ${raw}`);
  }
  return parts.join("/");
}

function arrayBufferToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fileExtension(path: string | null | undefined, fallback = "bin"): string {
  const match = path?.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? fallback;
}

function jsonBytes(input: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(input, null, 2)}\n`);
}

function normalizeCategories(
  categories: EpigraphBooksCategoryRecord[] | undefined,
): EpigraphBooksCategoryRecord[] {
  return Array.isArray(categories)
    ? [...categories]
        .map((category, index) => ({
          id: typeof category?.id === "string" && category.id.trim()
            ? category.id
            : `books-category-${index + 1}`,
          name: typeof category?.name === "string" && category.name.trim()
            ? category.name.trim()
            : `Category ${index + 1}`,
          order: typeof category?.order === "number" ? category.order : index + 1,
        }))
        .sort((left, right) => left.order - right.order)
    : [];
}

function normalizeCategoryAssignments(
  assignments: Record<string, string[]> | undefined,
): Record<string, string[]> {
  if (!assignments || typeof assignments !== "object") return {};
  return Object.fromEntries(
    Object.entries(assignments).map(([bookId, ids]) => [
      bookId,
      Array.isArray(ids)
        ? [...new Set(ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0))]
        : [],
    ]),
  );
}

function normalizeBooksLibraryUi(
  value: PersistedBooksLibraryUiState | undefined,
): PersistedBooksLibraryUiState {
  const record = value ?? {
    activeCategoryId: null,
    typeFilter: "all",
    statusFilter: "all",
    search: "",
    sortMode: "recentlyAdded",
    sortDir: "desc",
  };
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

export function buildEpigraphBooksSnapshotFromLibraryState(
  state: Pick<
    PersistedBookLibraryState,
    "books" | "bookProgress" | "bookBookmarks" | "booksCategories" | "booksCategoryAssignments" | "booksLibraryUi"
  >,
): EpigraphBooksSnapshot {
  return {
    books: [...state.books],
    bookProgress: [...state.bookProgress],
    bookBookmarks: [...state.bookBookmarks],
    booksCategories: normalizeCategories(state.booksCategories),
    booksCategoryAssignments: normalizeCategoryAssignments(state.booksCategoryAssignments),
    booksLibraryUi: normalizeBooksLibraryUi(state.booksLibraryUi),
  };
}

function toPortableBookRecord(book: BookEntry, exportMode: EpigraphBooksExportMode): PortableBookRecord {
  const normalized = {
    ...book,
    pageCount: typeof book.pageCount === "number" ? book.pageCount : null,
    tocCount: typeof book.tocCount === "number" ? book.tocCount : 0,
    spineCount: typeof book.spineCount === "number" ? book.spineCount : 0,
    sectionsSummary: Array.isArray(book.sectionsSummary) ? book.sectionsSummary : [],
    sectionCount: typeof book.sectionCount === "number"
      ? book.sectionCount
      : (Array.isArray(book.sectionsSummary) ? book.sectionsSummary.length : 0),
  };
  const assetArchivePath = exportMode === "full" && normalized.assetPath
    ? `files/${normalized.id}.${fileExtension(normalized.assetPath, normalized.subtype)}`
    : null;
  const coverArchivePath = exportMode === "full" && normalized.coverPath
    ? `covers/${normalized.id}.${fileExtension(normalized.coverPath, "bin")}`
    : null;

  return {
    id: normalized.id,
    assetFingerprint: normalized.assetFingerprint,
    title: normalized.title,
    author: normalized.author,
    description: normalized.description,
    subtype: normalized.subtype,
    pageCount: normalized.pageCount,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    tocCount: normalized.tocCount,
    spineCount: normalized.spineCount,
    sectionsSummary: normalized.sectionsSummary,
    sectionCount: normalized.sectionCount,
    assetArchivePath,
    coverArchivePath,
    importPathHint: normalized.importPath || null,
  };
}

async function readRequiredBinary(
  path: string,
  kind: "asset" | "cover",
  bookId: string,
  deps: BooksBackupReadDeps,
): Promise<ArrayBuffer> {
  try {
    return await deps.readBinaryFile(path);
  } catch (error) {
    throw new Error(
      `Could not read ${kind} file for book "${bookId}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadJsonFromZip<T>(zip: JSZip, path: string): Promise<T | null> {
  const file = zip.file(path);
  if (!file) return null;
  return JSON.parse(await file.async("text")) as T;
}

async function readArchiveBinary(zip: JSZip, path: string): Promise<Uint8Array | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async("uint8array");
}

export async function buildEpigraphBooksPayload(
  snapshot: EpigraphBooksSnapshot,
  options: {
    exportMode?: EpigraphBooksExportMode;
  } = {},
  deps: BooksBackupReadDeps = defaultReadDeps,
): Promise<EpigraphBackupPayloadBuildInput> {
  const exportMode = options.exportMode ?? "full";
  const categories = normalizeCategories(snapshot.booksCategories);
  const assignments = normalizeCategoryAssignments(snapshot.booksCategoryAssignments);
  const booksLibraryUi = normalizeBooksLibraryUi(snapshot.booksLibraryUi);
  const libraryRecords = snapshot.books.map((book) => toPortableBookRecord(book, exportMode));

  const files: EpigraphBackupPayloadBuildInput["files"] = [
    {
      path: BOOKS_LIBRARY_FILE_PATH,
      bytes: jsonBytes({ version: 1, books: libraryRecords } satisfies BooksLibraryFile),
      contentType: "application/json",
      role: "library",
    },
    {
      path: BOOKS_PROGRESS_FILE_PATH,
      bytes: jsonBytes({
        version: 1,
        progress: snapshot.bookProgress.map((entry) => normalizeBookProgress(entry)),
      } satisfies BooksProgressFile),
      contentType: "application/json",
      role: "progress",
    },
    {
      path: BOOKS_BOOKMARKS_FILE_PATH,
      bytes: jsonBytes({
        version: 1,
        bookmarks: snapshot.bookBookmarks.map((entry) => normalizeBookBookmark(entry)),
      } satisfies BooksBookmarksFile),
      contentType: "application/json",
      role: "bookmarks",
    },
    {
      path: BOOKS_CATEGORIES_FILE_PATH,
      bytes: jsonBytes({
        version: 1,
        categories,
        assignments,
        ui: booksLibraryUi,
      } satisfies BooksCategoriesFile),
      contentType: "application/json",
      role: "categories",
    },
  ];

  if (exportMode === "full") {
    for (const book of snapshot.books) {
      const portable = libraryRecords.find((candidate) => candidate.id === book.id);
      if (!portable) continue;

      if (portable.assetArchivePath) {
        files.push({
          path: normalizeArchiveRelativePath(portable.assetArchivePath),
          bytes: await readRequiredBinary(book.assetPath, "asset", book.id, deps),
          contentType: book.subtype === "pdf" ? "application/pdf" : "application/epub+zip",
          role: "asset",
        });
      }

      if (portable.coverArchivePath && book.coverPath) {
        files.push({
          path: normalizeArchiveRelativePath(portable.coverArchivePath),
          bytes: await readRequiredBinary(book.coverPath, "cover", book.id, deps),
          contentType: `image/${fileExtension(book.coverPath, "png") === "jpg" ? "jpeg" : fileExtension(book.coverPath, "png")}`,
          role: "cover",
        });
      }
    }
  }

  return {
    kind: "books",
    exportMode,
    restoreModesSupported: ["full", "metadata-only"],
    requiresRuntime: "books",
    requiresRepositories: [],
    portableByDefault: true,
    metadata: {
      schemaVersion: 1,
      bookCount: snapshot.books.length,
      progressCount: snapshot.bookProgress.length,
      bookmarkCount: snapshot.bookBookmarks.length,
      categoryCount: categories.length,
      libraryUiIncluded: true,
      includesFiles: exportMode === "full",
    },
    files,
  };
}

export async function buildEpigraphBooksBackupContainer(
  snapshot: EpigraphBooksSnapshot,
  options: {
    exportMode?: EpigraphBooksExportMode;
    appVersion?: string | null;
    platform?: string | null;
    sourceProfileId?: string | null;
  } = {},
  deps: BooksBackupReadDeps = defaultReadDeps,
): Promise<BuiltEpigraphBackupContainer> {
  const payload = await buildEpigraphBooksPayload(snapshot, { exportMode: options.exportMode }, deps);
  return buildEpigraphBackupContainer({
    appVersion: options.appVersion ?? null,
    platform: options.platform ?? null,
    sourceSurface: "desktop",
    sourceProfileId: options.sourceProfileId ?? null,
    payloads: [payload],
  });
}

export async function parseEpigraphBooksPayload(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ParsedEpigraphBooksPayload> {
  const inspection = await inspectEpigraphBackupContainer(bytes);
  if (inspection.hasErrors) {
    throw new Error("Epigraph backup container failed inspection.");
  }

  const booksManifest = inspection.payloadManifests.books;
  if (!booksManifest) {
    throw new Error("The selected Epigraph backup does not contain a books payload.");
  }

  const exportMode = booksManifest.exportMode === "metadata-only" ? "metadata-only" : "full";
  const zip = await JSZip.loadAsync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const registry = EPIGRAPH_BACKUP_PAYLOAD_REGISTRY.books;

  const library = await loadJsonFromZip<BooksLibraryFile>(zip, `${registry.rootPath}/${BOOKS_LIBRARY_FILE_PATH}`);
  const progress = await loadJsonFromZip<BooksProgressFile>(zip, `${registry.rootPath}/${BOOKS_PROGRESS_FILE_PATH}`);
  const bookmarks = await loadJsonFromZip<BooksBookmarksFile>(zip, `${registry.rootPath}/${BOOKS_BOOKMARKS_FILE_PATH}`);
  const categories = await loadJsonFromZip<BooksCategoriesFile>(zip, `${registry.rootPath}/${BOOKS_CATEGORIES_FILE_PATH}`);

  if (!library) throw new Error("Books payload is missing library.json.");
  if (!progress) throw new Error("Books payload is missing progress.json.");
  if (!bookmarks) throw new Error("Books payload is missing bookmarks.json.");

  return {
    exportMode,
    library,
    progress,
    bookmarks,
    categories: categories ?? {
      version: 1,
      categories: [],
      assignments: {},
      ui: normalizeBooksLibraryUi(undefined),
    },
    inspection,
  };
}

export async function restoreEpigraphBooksPayload(
  bytes: Uint8Array | ArrayBuffer,
  deps: BooksBackupWriteDeps = defaultWriteDeps,
): Promise<RestoredEpigraphBooksSnapshot> {
  const parsed = await parseEpigraphBooksPayload(bytes);
  const zip = await JSZip.loadAsync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const issues: EpigraphBooksRestoreIssue[] = [];
  const restoredBooks: BookEntry[] = [];

  for (const record of parsed.library.books) {
    let assetPath = "";
    let importPath = "";
    let coverPath: string | null = null;

    if (record.assetArchivePath) {
      const archivePath = `${EPIGRAPH_BACKUP_PAYLOAD_REGISTRY.books.rootPath}/${normalizeArchiveRelativePath(record.assetArchivePath)}`;
      const assetBytes = await readArchiveBinary(zip, archivePath);
      if (!assetBytes) {
        issues.push({
          code: "missing-asset-file",
          message: `The books payload is missing the asset for "${record.title}".`,
          bookId: record.id,
          path: archivePath,
        });
      } else {
        const ext = fileExtension(record.assetArchivePath, record.subtype);
        assetPath = await deps.writeManagedBookAsset(record.id, arrayBufferToBase64(assetBytes), ext);
        importPath = assetPath;
      }
    } else {
      issues.push({
        code: "metadata-only-book",
        message: `Book "${record.title}" was restored without a packaged file.`,
        bookId: record.id,
      });
    }

    if (record.coverArchivePath) {
      const archivePath = `${EPIGRAPH_BACKUP_PAYLOAD_REGISTRY.books.rootPath}/${normalizeArchiveRelativePath(record.coverArchivePath)}`;
      const coverBytes = await readArchiveBinary(zip, archivePath);
      if (!coverBytes) {
        issues.push({
          code: "missing-cover-file",
          message: `The books payload is missing the cover for "${record.title}".`,
          bookId: record.id,
          path: archivePath,
        });
      } else {
        coverPath = await deps.writeManagedBookCover(
          record.id,
          arrayBufferToBase64(coverBytes),
          fileExtension(record.coverArchivePath, "png"),
        );
      }
    }

    restoredBooks.push({
      id: record.id,
      assetFingerprint: record.assetFingerprint,
      title: record.title,
      author: record.author,
      description: record.description,
      coverPath,
      coverUrl: undefined,
      subtype: record.subtype,
      pageCount: record.pageCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      importPath,
      assetPath,
      tocCount: record.tocCount,
      spineCount: record.spineCount,
      sectionsSummary: record.sectionsSummary,
      sectionCount: record.sectionCount,
    });
  }

  const reconciled = reconcileBookIdentityState(
    restoredBooks,
    parsed.progress.progress.map((entry) => normalizeBookProgress(entry)),
  );

  const remapBookId = (bookId: string) => reconciled.idRemap.get(bookId) ?? bookId;
  const restoredBookmarks = parsed.bookmarks.bookmarks
    .map((entry) => normalizeBookBookmark(entry))
    .map((entry) => ({ ...entry, bookId: remapBookId(entry.bookId) }))
    .filter((entry) => reconciled.books.some((book) => book.id === entry.bookId));
  const restoredAssignments = Object.fromEntries(
    Object.entries(normalizeCategoryAssignments(parsed.categories.assignments)).map(([bookId, categoryIds]) => [
      remapBookId(bookId),
      categoryIds,
    ]),
  );

  return {
    exportMode: parsed.exportMode,
    books: reconciled.books,
    bookProgress: reconciled.bookProgress,
    bookBookmarks: restoredBookmarks,
    booksCategories: normalizeCategories(parsed.categories.categories),
    booksCategoryAssignments: restoredAssignments,
    booksLibraryUi: normalizeBooksLibraryUi(parsed.categories.ui),
    issues,
  };
}
