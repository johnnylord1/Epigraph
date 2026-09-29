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
