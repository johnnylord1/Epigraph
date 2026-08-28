import { invoke } from "@tauri-apps/api/core";

import {
  replaceBooksState,
  store,
  updateSettings,
  upsertBook,
} from "../../store/state.svelte";
import {
  normalizeLocalProfileId as normalizeLocalProfileIdFromSession,
  normalizeServerUrl as normalizeServerUrlFromSession,
} from "../localProfiles";
import {
  createBooksCategory,
  sortBooksCategories,
} from "../library/domainCategories";

const AUDIT_SYNCD_BOOK_ID = "audit-sync-book";
const AUDIT_SYNCD_NOVEL_SOURCE_ID = "audit-sync-source";
const AUDIT_SYNCD_NOVEL_PATH = "/audit-sync-novel";
const AUDIT_SYNCD_NOVEL_CHAPTER_PATH = "/chapter-1";

export function resolveAuditSyncScope() {
  const profileId = normalizeLocalProfileIdFromSession(store.runtimeResolvedLocalProfileId);
  const serverUrl = normalizeServerUrlFromSession(store.runtimeResolvedLocalProfileMeta?.serverUrl ?? store.runtimeServerUrl);
  return { profileId, serverUrl };
}

async function readAuditNovelLibraryPersistence() {
  const scope = {
    profileId: normalizeLocalProfileIdFromSession(store.runtimeResolvedLocalProfileId),
    serverUrl: normalizeServerUrlFromSession(store.runtimeServerUrl),
  };
  const [{ reloadNovelLibraryState }, rawState, storageRoot] = await Promise.all([
    import("../novels/libraryState"),
    invoke<string | null>("read_novel_library_state", scope).catch(() => null),
    invoke<string>("resolve_novel_storage_root", scope).catch(() => null),
  ]);

  return {
    storageRoot,
    rawState,
    state: await reloadNovelLibraryState(scope),
  };
}

async function readAuditBookLibraryPersistence() {
  const profileId = store.runtimeResolvedLocalProfileId;
  const [{ reloadBookLibraryState }, rawState, storageRoot] = await Promise.all([
    import("../books/libraryState"),
    invoke<string | null>("read_book_library_state", { profileId }).catch(() => null),
    invoke<string>("resolve_book_storage_root").catch(() => null),
  ]);

  return {
    storageRoot,
    rawState,
    state: await reloadBookLibraryState({ profileId }),
  };
}

async function importAuditBookFromPath(sourcePath: string) {
  await assertWebdriverAutomation();
  const { importLocalBookFile } = await import("../books/importFile");
  const imported = await importLocalBookFile(sourcePath, { existingBooks: store.books });
  upsertBook(imported.entry);

  const category = store.settings.booksCategories.find((entry) => entry.name === "Audit Shelf")
    ?? createBooksCategory(store.settings.booksCategories, "Audit Shelf");

  const booksCategories = sortBooksCategories([
    ...store.settings.booksCategories.filter((entry) => entry.id !== category.id),
    category,
  ]);
  const previousAssignments = store.settings.booksCategoryAssignments[imported.entry.id] ?? [];
  const booksCategoryAssignments = {
    ...store.settings.booksCategoryAssignments,
    [imported.entry.id]: Array.from(new Set([...previousAssignments, category.id])),
  };

  updateSettings({
    booksCategories,
    booksCategoryAssignments,
    booksLibraryUi: {
      ...store.settings.booksLibraryUi,
      activeCategoryId: category.id,
      typeFilter: imported.entry.subtype,
      search: imported.entry.title,
    },
  });

  return {
    id: imported.entry.id,
    title: imported.entry.title,
    subtype: imported.entry.subtype,
    categoryId: category.id,
  };
}

async function assertWebdriverAutomation() {
  const enabled = await invoke<boolean>("is_webdriver_automation").catch(() => false);
  if (!enabled) {
    throw new Error("This audit operation is available only in WebDriver automation mode.");
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function readFileAsArrayBuffer(path: string): Promise<ArrayBuffer> {
  const storage = await import("../books/storage");
  return storage.readFileAsArrayBuffer(path);
}

async function setAuditBookReadingState(input: {
  bookId: string;
  progressPercent: number;
  bookmarkLabel: string;
}) {
  await assertWebdriverAutomation();
  const { reloadBookLibraryState, saveBookLibraryState } = await import("../books/libraryState");
  const profileId = store.runtimeResolvedLocalProfileId;
  const state = await reloadBookLibraryState({ profileId });
  const book = state.books.find((entry) => entry.id === input.bookId);
  if (!book) throw new Error(`Audit book ${input.bookId} was not found.`);

  const progressPercent = Math.max(0, Math.min(1, input.progressPercent));
  const now = Date.now();
  const location = book.subtype === "pdf" ? `page:${Math.max(1, Math.round(progressPercent * Math.max(1, book.pageCount ?? 1)))}` : `audit:${book.id}:${progressPercent}`;
  const saved = await saveBookLibraryState({
    ...state,
    bookProgress: [
      ...state.bookProgress.filter((entry) => entry.bookId !== book.id),
      {
        bookId: book.id,
        location,
        href: book.subtype === "pdf" ? null : book.sectionsSummary?.[0]?.href ?? null,
        progressPercent,
        lastReadAt: now,
        pageIndex: book.subtype === "pdf" ? Math.max(0, Math.round(progressPercent * Math.max(1, book.pageCount ?? 1)) - 1) : null,
        totalPages: book.subtype === "pdf" ? book.pageCount ?? 1 : null,
        sectionLabel: book.subtype === "pdf" ? "Audit page" : book.sectionsSummary?.[0]?.label ?? "Audit section",
        renderer: book.subtype,
      },
    ],
    bookBookmarks: [
      ...state.bookBookmarks.filter((entry) => entry.bookId !== book.id),
      {
        bookId: book.id,
        location,
        href: book.subtype === "pdf" ? null : book.sectionsSummary?.[0]?.href ?? null,
        pageIndex: book.subtype === "pdf" ? Math.max(0, Math.round(progressPercent * Math.max(1, book.pageCount ?? 1)) - 1) : null,
        progressPercent,
        label: input.bookmarkLabel,
        savedAt: now,
      },
    ],
    updatedAtMs: now,
  }, { profileId });

  replaceBooksState(saved);
  return {
    bookId: book.id,
    progressCount: saved.bookProgress.filter((entry) => entry.bookId === book.id).length,
    bookmarkCount: saved.bookBookmarks.filter((entry) => entry.bookId === book.id).length,
  };
}

async function exportAuditBooksBackupToPath(path: string) {
  await assertWebdriverAutomation();
  const profileId = store.runtimeResolvedLocalProfileId;
  const [{ reloadBookLibraryState }, { buildEpigraphBooksBackupContainer, buildEpigraphBooksSnapshotFromLibraryState }] = await Promise.all([
    import("../books/libraryState"),
    import("../backup/booksBackup"),
  ]);
  const state = await reloadBookLibraryState({ profileId });
  const container = await buildEpigraphBooksBackupContainer(
    buildEpigraphBooksSnapshotFromLibraryState(state),
    { exportMode: "full", sourceProfileId: profileId },
  );
  const writtenPath = await invoke<string>("write_file_base64", {
    path,
    bytesBase64: bytesToBase64(container.bytes),
  });
  const sha256 = await invoke<string>("compute_file_sha256", { path: writtenPath });
  return {
    path: writtenPath,
    sha256,
    bookCount: state.books.length,
    progressCount: state.bookProgress.length,
    bookmarkCount: state.bookBookmarks.length,
  };
}

async function restoreAuditBooksBackupFromPath(path: string) {
  await assertWebdriverAutomation();
  const [{ restoreEpigraphBooksPayload }, { saveBookLibraryState }] = await Promise.all([
    import("../backup/booksBackup"),
    import("../books/libraryState"),
  ]);
  const bytes = await readFileAsArrayBuffer(path);
  const restored = await restoreEpigraphBooksPayload(bytes);
  const profileId = store.runtimeResolvedLocalProfileId;
  const saved = await saveBookLibraryState({
    version: 1,
    books: restored.books,
    bookProgress: restored.bookProgress,
    bookBookmarks: restored.bookBookmarks,
    booksCategories: restored.booksCategories,
    booksCategoryAssignments: restored.booksCategoryAssignments,
    booksLibraryUi: store.settings.booksLibraryUi,
    updatedAtMs: Date.now(),
  }, { profileId });
  replaceBooksState(saved);
  return {
    bookCount: restored.books.length,
    progressCount: restored.bookProgress.length,
    bookmarkCount: restored.bookBookmarks.length,
    issueCount: restored.issues.length,
  };
}

async function mutateSyncdAuditBookFixture(input?: {
  mode?: "progress" | "bookmark" | "clear_bookmarks";
  marker?: string | null;
  progressPercent?: number | null;
}) {
  await assertWebdriverAutomation();
  const { reloadBookLibraryState, saveBookLibraryState } = await import("../books/libraryState");
  const mode = input?.mode ?? "progress";
  const marker = input?.marker?.trim() || "audit";
  const now = Date.now();
  const progressPercent = typeof input?.progressPercent === "number"
    ? Math.max(0, Math.min(1, input.progressPercent))
    : 0.5;

  const profileId = store.runtimeResolvedLocalProfileId;
  const state = await reloadBookLibraryState({ profileId });
  const books = state.books.some((entry) => entry.id === AUDIT_SYNCD_BOOK_ID)
    ? state.books
    : [
        ...state.books,
        {
          id: AUDIT_SYNCD_BOOK_ID,
          title: "Audit Sync Book",
          author: "Epigraph",
          description: "Automation-only sync replication fixture.",
          coverPath: null,
          subtype: "epub" as const,
          createdAt: now,
          updatedAt: now,
          importPath: "audit://sync-book.epub",
          assetPath: "audit://sync-book.epub",
          sectionCount: 1,
        },
      ];

  let bookProgress = state.bookProgress.filter((entry) => entry.bookId !== AUDIT_SYNCD_BOOK_ID);
  let bookBookmarks = state.bookBookmarks.filter((entry) => !(entry.bookId === AUDIT_SYNCD_BOOK_ID && entry.location === "audit-sync-bookmark"));

  if (mode === "progress") {
    bookProgress = [
      ...bookProgress,
      {
        bookId: AUDIT_SYNCD_BOOK_ID,
        location: `audit-progress-${marker}`,
        href: `/audit/${marker}`,
        progressPercent,
        lastReadAt: now,
        pageIndex: 1,
        totalPages: 10,
        sectionLabel: `Audit ${marker}`,
        renderer: "epub" as const,
      },
    ];
  } else if (mode === "bookmark") {
    bookBookmarks = [
      ...bookBookmarks,
      {
        bookId: AUDIT_SYNCD_BOOK_ID,
        location: "audit-sync-bookmark",
        href: `/audit/bookmark/${marker}`,
        pageIndex: 1,
        progressPercent,
        label: `Audit bookmark ${marker}`,
        savedAt: now,
      },
    ];
  }

  const saved = await saveBookLibraryState({
    ...state,
    books,
    bookProgress,
    bookBookmarks,
    updatedAtMs: now,
  }, { profileId });

  return {
    bookId: AUDIT_SYNCD_BOOK_ID,
    progressPercent: mode === "progress" ? progressPercent : null,
    bookmarkLabel: mode === "bookmark" ? `Audit bookmark ${marker}` : null,
    bookmarkCount: saved.bookBookmarks.filter((entry) => entry.bookId === AUDIT_SYNCD_BOOK_ID).length,
  };
}

async function mutateSyncdAuditNovelFixture(input?: {
  mode?: "progress" | "bookmark" | "clear_bookmarks";
  marker?: string | null;
  progressPercent?: number | null;
}) {
  await assertWebdriverAutomation();
  const scope = resolveAuditSyncScope();
  if (!scope.profileId) {
    throw new Error("No active local profile is available for the syncd novel audit fixture.");
  }

  const {
    reloadNovelLibraryState,
    saveNovelLibraryState,
    upsertNovelInLibrary,
    markNovelChapterRead,
  } = await import("../novels/libraryState");
  const {
    createNovelLibraryId,
    createNovelChapterId,
  } = await import("../novels/domain");

  const mode = input?.mode ?? "progress";
  const marker = input?.marker?.trim() || "audit";
  const now = Date.now();
  const requestedProgressPercent = typeof input?.progressPercent === "number"
    ? Math.max(0, Math.min(1, input.progressPercent))
    : 1;

  const novelId = createNovelLibraryId(AUDIT_SYNCD_NOVEL_SOURCE_ID, AUDIT_SYNCD_NOVEL_PATH);
  const chapterId = createNovelChapterId(novelId, AUDIT_SYNCD_NOVEL_CHAPTER_PATH);
  const chapterTitle = "Audit Chapter 1";

  let state = await reloadNovelLibraryState(scope);
  state = upsertNovelInLibrary(state, {
    id: novelId,
    sourceId: AUDIT_SYNCD_NOVEL_SOURCE_ID,
    title: "Audit Sync Novel",
    path: AUDIT_SYNCD_NOVEL_PATH,
    coverUrl: null,
    author: "Epigraph",
    description: "Automation-only sync replication fixture.",
    status: "ongoing",
    tags: ["audit", "syncd"],
    chapterCount: 1,
    chapters: [
      {
        id: chapterId,
        novelId,
        path: AUDIT_SYNCD_NOVEL_CHAPTER_PATH,
        title: chapterTitle,
        order: 1,
        releaseTime: null,
        unread: true,
      },
    ],
    source: {
      repositoryUrl: "https://audit.invalid/repo",
      repositoryName: "Audit Repository",
      pluginId: "audit-sync-plugin",
      pluginName: "Audit Sync Plugin",
      pluginVersion: "1.0.0",
      sourceId: AUDIT_SYNCD_NOVEL_SOURCE_ID,
      sourceName: "Audit Source",
      lang: "en",
    },
  });

  if (mode === "progress") {
    state = markNovelChapterRead(state, {
      novelId,
      chapterId,
      chapterTitle,
    });
    if (requestedProgressPercent < 1) {
      state = {
        ...state,
        progress: state.progress.map((entry) => entry.novelId === novelId
          ? { ...entry, progressPercent: requestedProgressPercent, updatedAt: now }
          : entry),
        updatedAtMs: now,
      };
    }
  } else if (mode === "bookmark") {
    state = {
      ...state,
      bookmarks: [
        ...state.bookmarks.filter((entry) => !(entry.novelId === novelId && entry.locator === "audit-sync-novel-bookmark")),
        {
          novelId,
          chapterId,
          chapterTitle,
          locator: "audit-sync-novel-bookmark",
          label: `Audit novel bookmark ${marker}`,
          savedAt: now,
        },
      ],
      updatedAtMs: now,
    };
  } else {
    state = {
      ...state,
      bookmarks: state.bookmarks.filter((entry) => !(entry.novelId === novelId && entry.locator === "audit-sync-novel-bookmark")),
      updatedAtMs: now,
    };
  }

  const saved = await saveNovelLibraryState(state, scope);
  return {
    profileId: scope.profileId,
    novelId,
    chapterId,
    progressPercent: mode === "progress" ? requestedProgressPercent : null,
    bookmarkLabel: mode === "bookmark" ? `Audit novel bookmark ${marker}` : null,
    bookmarkCount: saved.bookmarks.filter((entry) => entry.novelId === novelId).length,
  };
}


export function createAuditDataBridge() {
  return {
    readNovelLibraryPersistence: readAuditNovelLibraryPersistence,
    readBookLibraryPersistence: readAuditBookLibraryPersistence,
    importBookFromPath: importAuditBookFromPath,
    setBookReadingState: setAuditBookReadingState,
    exportBooksBackupToPath: exportAuditBooksBackupToPath,
    restoreBooksBackupFromPath: restoreAuditBooksBackupFromPath,
    mutateSyncdAuditBookFixture,
    mutateSyncdAuditNovelFixture,
  };
}
