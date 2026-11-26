import { expect, it, vi } from "vitest";
const { saved, loadBookLibraryStateMock } = vi.hoisted(() => ({
  saved: [] as unknown[],
  loadBookLibraryStateMock: vi.fn(),
}));
vi.mock("../lib/books/libraryState", async (original) => {
  const actual = await original<typeof import("../lib/books/libraryState")>();
  return {
    ...actual,
    loadBookLibraryState: loadBookLibraryStateMock,
    saveBookLibraryState: async (snapshot: unknown) => { saved.push(snapshot); },
  };
});
import { store } from "./state.svelte";

it("does not flush an unhydrated book library over durable user data", async () => {
  const hydrated = store.booksLibraryHydrated;
  store.booksLibraryHydrated = false;
  try {
    await store.flushBookLibraryPersistence();
    expect(saved).toEqual([]);
  } finally { store.booksLibraryHydrated = hydrated; }
});

it("restore refuses an unhydrated destination rather than reporting a no-op flush as success", async () => {
  const hydrated = store.booksLibraryHydrated;
  store.booksLibraryHydrated = false;
  try {
    await expect(store.persistRestoredBooks()).rejects.toThrow("RESTORE_BOOKS_NOT_HYDRATED");
    expect(saved).toEqual([]);
  } finally { store.booksLibraryHydrated = hydrated; }
});

it("restore refuses while a Book reader can still write progress", async () => {
  const active = store.activeBookReaderId;
  store.activeBookReaderId = "reading";
  try { await expect(store.prepareBooksForRestore()).rejects.toThrow("RESTORE_BOOK_READER_ACTIVE"); }
  finally { store.activeBookReaderId = active; }
});

it("does not rewrite books state already on disk when the persist effect reruns for unrelated settings", async () => {
  // Vitest runs Svelte server-side, so the persist effect is triggered by hand.
  const queuePersist = () => (store as unknown as { queuePersistBooksLibraryState(): void }).queuePersistBooksLibraryState();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  store.replaceBooksStateFromDisk({
    books: [],
    bookProgress: [],
    bookBookmarks: [],
    booksCategories: [{ id: "shelf", name: "Shelf", order: 0 }],
    booksCategoryAssignments: { "novel:lorde": ["shelf"] },
  });
  const before = saved.length;

  store.updateSettings({ launchIntoLibrary: !store.settings.launchIntoLibrary });
  queuePersist();
  await settle();
  expect(saved.length).toBe(before);

  store.updateSettings({ booksCategoryAssignments: {} });
  queuePersist();
  await settle();
  expect(saved.length).toBe(before + 1);

  queuePersist();
  await settle();
  expect(saved.length).toBe(before + 1);
});

it("lets a picked chapter replace a precise position that a reader fallback could not overwrite", () => {
  const precise = { bookId: "epub-jump", location: "epubcfi(/6/6!/4/2)", href: "ch3.xhtml", progressPercent: 0.8, lastReadAt: 100, sectionLabel: "Chapter 3", renderer: "epub" as const };
  const picked = { bookId: "epub-jump", location: null, href: "ch1.xhtml", progressPercent: 0.1, lastReadAt: 200, sectionLabel: "Chapter 1", renderer: "epub" as const };
  store.setBookProgress(precise);

  store.setBookProgress(picked);
  expect(store.getBookProgress("epub-jump")?.href).toBe("ch3.xhtml");

  store.replaceBookProgress(picked);
  expect(store.getBookProgress("epub-jump")).toMatchObject({ location: null, href: "ch1.xhtml", progressPercent: 0.1 });
});

it("cancels a queued persist when replaceBooksStateFromDisk adopts a remote update", async () => {
  const queuePersist = () => (store as unknown as { queuePersistBooksLibraryState(): void }).queuePersistBooksLibraryState();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const before = saved.length;

  store.updateSettings({ booksCategoryAssignments: { "book:stale": ["shelf"] } });
  queuePersist();

  store.replaceBooksStateFromDisk({
    books: [],
    bookProgress: [],
    bookBookmarks: [],
    booksCategories: [{ id: "remote", name: "Remote", order: 0 }],
    booksCategoryAssignments: { "book:remote": ["remote"] },
  });

  await settle();
  expect(saved.length).toBe(before);
});

it("hydrateBookLibraryState sets booksStateDiskSignature and does not clobber concurrent replaceBooksStateFromDisk", async () => {
  const queuePersist = () => (store as unknown as { queuePersistBooksLibraryState(): void }).queuePersistBooksLibraryState();
  const hydrate = (profileId: string) => (store as unknown as { hydrateBookLibraryState(p: string): Promise<void> }).hydrateBookLibraryState(profileId);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  let resolveLoad!: (value: unknown) => void;
  loadBookLibraryStateMock.mockImplementationOnce(
    () => new Promise((resolve) => { resolveLoad = resolve; }),
  );

  const before = saved.length;
  const hydration = hydrate("race-profile");

  store.replaceBooksStateFromDisk({
    books: [],
    bookProgress: [],
    bookBookmarks: [],
    booksCategories: [{ id: "synced-cat", name: "Synced", order: 0 }],
    booksCategoryAssignments: { "book:synced": ["synced-cat"] },
  });

  resolveLoad({
    version: 1,
    books: [],
    bookProgress: [],
    bookBookmarks: [],
    booksCategories: [],
    booksCategoryAssignments: {},
    booksLibraryUi: store.settings.booksLibraryUi,
    updatedAtMs: 1,
  });
  await hydration;
  queuePersist();
  await settle();

  expect(store.settings.booksCategories).toEqual([{ id: "synced-cat", name: "Synced", order: 0, includeInUpdate: "UNSET" }]);
  expect(store.settings.booksCategoryAssignments).toEqual({ "book:synced": ["synced-cat"] });
  expect(saved.length).toBe(before);
});

it("keeps backend-owned cover and metadata fields when adopting books from disk", async () => {
  // Dropping them made the metadata backfill rewrite every book, the backend refill the
  // cover fields and reload, and the cycle repeat several times per second.
  const queuePersist = () => (store as unknown as { queuePersistBooksLibraryState(): void }).queuePersistBooksLibraryState();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const book = {
    id: "epub-cover",
    assetFingerprint: "sha256:abc",
    mimeType: "application/epub+zip",
    byteSize: 4096,
    title: "Cover Contract",
    author: null,
    description: null,
    isbns: ["9780306406157"],
    metadataBackfillVersion: 2,
    coverPath: "C:/books/covers/cover-contract.jpg",
    hardcoverBookId: 42,
    hardcoverCoverUrl: "https://example.test/cover.jpg",
    hasCover: true,
    coverAssetSha256: "a".repeat(64),
    coverAssetByteSize: 512,
    coverAssetMimeType: "image/jpeg",
    subtype: "epub",
    pageCount: null,
    createdAt: 1,
    updatedAt: 2,
    importPath: "D:/Books/cover-contract.epub",
    assetPath: "C:/books/epubs/cover-contract.epub",
  };
  store.replaceBooksStateFromDisk({
    books: [book],
    bookProgress: [],
    bookBookmarks: [],
    booksCategories: [],
    booksCategoryAssignments: {},
  });
  const adopted = store.books.find((entry) => entry.id === "epub-cover");
  expect(adopted).toMatchObject({
    mimeType: "application/epub+zip",
    byteSize: 4096,
    isbns: ["9780306406157"],
    metadataBackfillVersion: 2,
    hardcoverBookId: 42,
    hardcoverCoverUrl: "https://example.test/cover.jpg",
    hasCover: true,
    coverAssetSha256: "a".repeat(64),
    coverAssetByteSize: 512,
    coverAssetMimeType: "image/jpeg",
  });

  const before = saved.length;
  queuePersist();
  await settle();
  expect(saved.length).toBe(before);
});
