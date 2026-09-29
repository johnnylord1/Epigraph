import { describe, expect, it, vi } from "vitest";
import { createNovelRestoreAdapter, preserveNovelCategoriesForBooksRestore } from "./restoreAdapters";
import type { BooksCategory } from "../../store/state.svelte";

describe("production Novel adapter contract", () => {
  it("preserves empty destination categories when Books follows Novel restore", () => {
    const next = preserveNovelCategoriesForBooksRestore({ categories: [{ id: "empty", name: "To discover", order: 0 }], assignments: {} },
      { booksCategories: [] as BooksCategory[], booksCategoryAssignments: {} }, []);
    expect(next.booksCategories.map(category => category.name)).toEqual(["To discover"]);
  });
  it("a later Books restore preserves restored Novel memberships even when category IDs collide", () => {
    const current = { categories: [{ id: "4", name: "Novel favorites", order: 0 }], assignments: { destination: ["4"] } };
    const restored: { booksCategories: BooksCategory[]; booksCategoryAssignments: Record<string, string[]> } = { booksCategories: [{ id: "4", name: "Books", order: 0 }], booksCategoryAssignments: { book: ["4"] } };
    const next = preserveNovelCategoriesForBooksRestore(current, restored, ["destination"]);
    const novelCategory = next.booksCategories.find(category => category.name === "Novel favorites")!;
    expect(novelCategory.id).not.toBe("4");
    expect(next.booksCategoryAssignments.destination).toEqual([novelCategory.id]);
    expect(next.booksCategoryAssignments.book).toEqual(["4"]);
    const retry = preserveNovelCategoriesForBooksRestore({ categories: next.booksCategories, assignments: next.booksCategoryAssignments }, next, ["destination"]);
    expect(retry).toEqual(next);
  });
  it("awaits category persistence using the destination Novel ID after the library commit", async () => {
    const events: string[] = [];
    const source = { pluginId: "provider", sourceId: "provider", repositoryUrl: null };
    const entry = { id: "destination", title: "Novel", path: "/novel", source, tags: [], addedAt: 1, updatedAt: 1 };
    const state = { version: 1, scopeKey: "test", entries: [entry], chapters: [], progress: [], bookmarks: [], history: [], updatedAtMs: 1 };
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const adapter = createNovelRestoreAdapter({
      prepareReader: async () => ({ ok: true }), validateTarget: () => {}, load: async () => state as any,
      save: async () => { events.push("library"); },
      saveCategories: async (_categories, ids) => {
        expect(ids.get("backup-id")).toBe("destination");
        events.push("categories"); await pending;
      },
    });
    let completed = false;
    const run = adapter.restore({ ...state, entries: [{ ...entry, id: "backup-id" }], categories: [{ id: "4", name: "Favorites", order: 0, novelIds: ["backup-id"] }] } as any).then(() => { completed = true; });
    await vi.waitFor(() => expect(events).toEqual(["library", "categories"]));
    expect(completed).toBe(false);
    finish(); await run;
  });
  it("refuses before reading or mutation when reader preparation fails", async () => {
    const load = vi.fn(), save = vi.fn();
    const adapter = createNovelRestoreAdapter({ prepareReader: async () => ({ ok: false, code: "RESTORE_REFUSED_READER_NOT_FLUSHED", reason: "timeout" }), validateTarget: () => {}, load, save });
    await expect(adapter.restore({} as any)).rejects.toThrow("RESTORE_REFUSED_READER_NOT_FLUSHED");
    expect(load).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("waits for reader preparation and commit acknowledgement in order", async () => {
    const events: string[] = [];
    let prepare!: () => void, commit!: () => void;
    const barrier = new Promise<void>(resolve => { prepare = resolve; });
    const persistence = new Promise<void>(resolve => { commit = resolve; });
    const state = { version: 1, scopeKey: "test", updatedAtMs: 1, entries: [], chapters: [], progress: [], bookmarks: [], history: [] };
    const adapter = createNovelRestoreAdapter({
      prepareReader: async () => { await barrier; events.push("prepared"); return { ok: true }; },
      validateTarget: () => {}, load: async () => { events.push("load"); return state as any; },
      save: async () => { events.push("save"); await persistence; events.push("persisted"); },
    });
    const result = adapter.restore({ ...state } as any).then(value => { events.push("done"); return value; });
    expect(events).toEqual([]); prepare();
    await vi.waitFor(() => expect(events).toEqual(["prepared", "load", "save"]));
    commit(); await result;
    expect(events).toEqual(["prepared", "load", "save", "persisted", "done"]);
  });
  it("checks frozen target again after the asynchronous reader barrier", async () => {
    let changed = false;
    const save = vi.fn();
    const adapter = createNovelRestoreAdapter({ prepareReader: async () => { changed = true; return { ok: true }; }, validateTarget: () => { if (changed) throw Error("RESTORE_TARGET_CHANGED"); }, load: vi.fn(), save });
    await expect(adapter.restore({} as any)).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(save).not.toHaveBeenCalled();
  });
});
