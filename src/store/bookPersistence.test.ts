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
