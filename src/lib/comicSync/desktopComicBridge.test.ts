import { describe, expect, test, vi } from "vitest";
import type { MihonImportWork } from "../backup/mihonBackup";
import { comicKey } from "./plan";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../store/state.svelte", () => ({ store: {}, bumpContentSetupVersion: vi.fn() }));

const { COMIC_LIBRARY_RECONCILED_EVENT, fillChapters, importBatches, libraryMembershipChanges, showLocalComicChanges } = await import(
  "./desktopComicBridge"
);
const { MAX_WORKS_PER_READ } = await import("./syncLandingWatch");

function work(n: number, chapters = 0): MihonImportWork {
  return {
    sourceId: "1",
    url: `/manga/${n}`,
    title: `Work ${n}`,
    author: null,
    artist: null,
    genre: [],
    status: null,
    dateAdded: 0,
    chapters: Array.from({ length: chapters }, (_, c) => ({
      url: `/manga/${n}/chapter/${c}-${"x".repeat(80)}`,
      name: `Chapter ${c}`,
      scanlator: null,
      isRead: false,
      isBookmarked: false,
      lastPageRead: 0,
      fetchedAt: 0,
      uploadDate: 0,
      chapterNumber: c,
      sourceOrder: c,
    })),
  };
}

describe("importBatches", () => {
  test("keeps at most 25 works in a restore", () => {
    const batches = importBatches(Array.from({ length: 60 }, (_, n) => work(n)));
    expect(batches.map((batch) => batch.length)).toEqual([25, 25, 10]);
  });

  test("splits by size and keeps an oversized work on its own", () => {
    const big = work(1, 4_000);
    const batches = importBatches([work(0, 2_000), big, work(2)]);
    expect(batches.length).toBe(3);
    expect(batches[1]).toEqual([big]);
    for (const batch of batches.slice(0, 1)) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(900_000);
    }
  });

  test("answers nothing for no works", () => {
    expect(importBatches([])).toEqual([]);
  });
});

describe("fillChapters", () => {
  const comic = (id: number) => ({ id, sourceId: "1", url: "/manga/a", title: "A", categories: [], digest: "" });
  const details = (id: number, extra: object) => ({
    mangas: { nodes: [{ id, sourceId: "1", url: "/manga/a", title: "A", genre: [], chapters: { nodes: [] }, ...extra }] },
  });
  const side = (name: "local" | "remote", answer: object, importWorks = vi.fn(async () => true)) =>
    ({ name, query: vi.fn(async () => answer), importWorks, fetchChapters: vi.fn(async () => {}) }) as any;

  test("copies the chapters and keeps the target's own details", async () => {
    const chapter = { url: "/c/1", name: "Chapter 1", isRead: true, isBookmarked: false, lastPageRead: 3, chapterNumber: 1, sourceOrder: 0 };
    const from = side("remote", details(7, { author: null, status: "UNKNOWN", inLibraryAt: 1, chapters: { nodes: [chapter] } }));
    const to = side("local", details(9, { author: "Author", artist: "Artist", genre: ["Action"], status: "ONGOING", inLibraryAt: 1_700_000_000 }));

    const filled = await fillChapters(from, to, [{ key: comicKey("1", "/manga/a"), source: comic(7), target: comic(9) }], 0);

    expect(filled).toBe(1);
    const [[batch]] = to.importWorks.mock.calls;
    expect(batch[0]).toMatchObject({ author: "Author", artist: "Artist", genre: ["Action"], status: "ONGOING", dateAdded: 1_700_000_000_000 });
    expect(batch[0].chapters).toEqual([expect.objectContaining({ url: "/c/1", isRead: true, lastPageRead: 3 })]);
    expect(to.fetchChapters).not.toHaveBeenCalled();
  });

  test("lists the chapters from the source when the target cannot restore", async () => {
    const from = side("remote", details(7, { chapters: { nodes: [{ url: "/c/1", name: "1", isRead: false, isBookmarked: false }] } }));
    const to = side("local", details(9, {}), vi.fn(async () => false));

    expect(await fillChapters(from, to, [{ key: comicKey("1", "/manga/a"), source: comic(7), target: comic(9) }], 0)).toBe(0);
    expect(to.fetchChapters).toHaveBeenCalledWith(9);
  });
});

describe("libraryMembershipChanges", () => {
  const library = (...ids: number[]) => new Map(ids.map((id) => [comicKey("1", `/manga/${id}`), { id } as never]));

  test("names the works that joined and left", () => {
    expect(libraryMembershipChanges(library(1, 2), library(2, 3))).toEqual([3, 1]);
  });

  test("is empty when the same works stay", () => {
    expect(libraryMembershipChanges(library(1, 2), library(2, 1))).toEqual([]);
  });
});

describe("showLocalComicChanges", () => {
  function reader(overrides: Partial<{ readWorks: () => Promise<void>; readLibrary: () => Promise<void> }> = {}) {
    return { readWorks: vi.fn(async () => {}), readLibrary: vi.fn(async () => {}), ...overrides };
  }

  async function announced(run: () => Promise<void>) {
    const details: unknown[] = [];
    const target = new EventTarget();
    target.addEventListener(COMIC_LIBRARY_RECONCILED_EVENT, (event) => details.push((event as CustomEvent).detail));
    vi.stubGlobal("window", target);
    try {
      await run();
    } finally {
      vi.unstubAllGlobals();
    }
    return details;
  }

  test("reads only the works that changed", async () => {
    const lib = reader();
    const details = await announced(() => showLocalComicChanges("p", { works: [1, 2], categories: false }, lib));
    expect(lib.readWorks).toHaveBeenCalledWith([1, 2]);
    expect(lib.readLibrary).not.toHaveBeenCalled();
    expect(details).toEqual([]);
  });

  test("reads nothing when the library did not change", async () => {
    const lib = reader();
    const details = await announced(() => showLocalComicChanges("p", { works: [], categories: false }, lib));
    expect(lib.readWorks).not.toHaveBeenCalled();
    expect(lib.readLibrary).not.toHaveBeenCalled();
    expect(details).toEqual([]);
  });

  test("reads the whole library when too many works changed", async () => {
    const lib = reader();
    const works = Array.from({ length: MAX_WORKS_PER_READ + 1 }, (_, id) => id);
    await showLocalComicChanges("p", { works, categories: false }, lib);
    expect(lib.readWorks).not.toHaveBeenCalled();
    expect(lib.readLibrary).toHaveBeenCalledOnce();
  });

  test("reads the whole library when the works could not be read", async () => {
    const lib = reader({ readWorks: vi.fn(async () => Promise.reject(new Error("offline"))) });
    const details = await announced(() => showLocalComicChanges("p", { works: [1], categories: false }, lib));
    expect(lib.readLibrary).toHaveBeenCalledOnce();
    expect(details).toEqual([]);
  });

  test("leaves the read to the library page when nothing could be read", async () => {
    const lib = reader({
      readWorks: vi.fn(async () => Promise.reject(new Error("offline"))),
      readLibrary: vi.fn(async () => Promise.reject(new Error("offline"))),
    });
    const details = await announced(() => showLocalComicChanges("p", { works: [1], categories: true }, lib));
    expect(details).toEqual([{ localProfileId: "p" }]);
  });

  test("announces a change of categories without a read of the works", async () => {
    const lib = reader();
    const details = await announced(() => showLocalComicChanges("p", { works: [], categories: true }, lib));
    expect(lib.readWorks).not.toHaveBeenCalled();
    expect(details).toEqual([{ localProfileId: "p", libraryReloaded: true }]);
  });
});
