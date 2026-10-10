import { expect, it, vi } from "vitest";
const { saved } = vi.hoisted(() => ({ saved: [] as unknown[] }));
vi.mock("../lib/books/libraryState", async (original) => ({
  ...await original<typeof import("../lib/books/libraryState")>(),
  saveBookLibraryState: async (snapshot: unknown) => { saved.push(snapshot); },
}));
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
