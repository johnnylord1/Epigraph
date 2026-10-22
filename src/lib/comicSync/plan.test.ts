import { describe, expect, test } from "vitest";
import {
  batchChapterUpdates,
  comicKey,
  emptyBaseline,
  mergeAssignments,
  parseBaseline,
  planCategories,
  planChapters,
  planLibrary,
  type ChapterTriple,
  type ComicChapterState,
  type ComicKey,
  type ComicSyncBaseline,
  type ComicWork,
} from "./plan";

function work(id: number, url = `/w/${id}`): ComicWork {
  return { id, sourceId: "100", url, title: `Work ${id}`, categories: [], digest: "" };
}

function library(...works: ComicWork[]): Map<ComicKey, ComicWork> {
  return new Map(works.map((item) => [comicKey(item.sourceId, item.url), item]));
}

function baselineOf(partial: Partial<ComicSyncBaseline>): ComicSyncBaseline {
  return { ...emptyBaseline(), ...partial };
}

function chapter(id: number, isRead: boolean, isBookmarked: boolean, lastPageRead: number, lastReadAt = 0): ComicChapterState {
  return { id, isRead, isBookmarked, lastPageRead, lastReadAt };
}

describe("planLibrary", () => {
  test("without a baseline both sides get what only the other has", () => {
    const plan = planLibrary(library(work(1), work(2)), library(work(10, "/w/2"), work(11, "/w/3")), null);
    expect(plan.addRemote.map((item) => item.url)).toEqual(["/w/1"]);
    expect(plan.addLocal.map((item) => item.url)).toEqual(["/w/3"]);
    expect(plan.removeLocal).toEqual([]);
    expect(plan.removeRemote).toEqual([]);
  });

  test("a work both held that one side removed is removed on the other", () => {
    const known = [1, 2, 3].map((id) => comicKey("100", `/w/${id}`));
    const plan = planLibrary(library(work(1), work(2), work(3)), library(work(1), work(2)), baselineOf({ library: known }));
    expect(plan.removeLocal.map((item) => item.url)).toEqual(["/w/3"]);
    expect(plan.addRemote).toEqual([]);
  });

  test("a side that suddenly lists nothing gets everything back instead", () => {
    const known = [1, 2, 3].map((id) => comicKey("100", `/w/${id}`));
    const plan = planLibrary(library(work(1), work(2), work(3)), library(), baselineOf({ library: known }));
    expect(plan.removeLocal).toEqual([]);
    expect(plan.addRemote.map((item) => item.url)).toEqual(["/w/1", "/w/2", "/w/3"]);
  });

  test("losing most of a large library is not copied to the other side", () => {
    const all = Array.from({ length: 30 }, (_, index) => work(index + 1));
    const known = all.map((item) => comicKey(item.sourceId, item.url));
    const plan = planLibrary(library(...all), library(...all.slice(0, 10)), baselineOf({ library: known }));
    expect(plan.removeLocal).toEqual([]);
    expect(plan.addRemote).toHaveLength(20);
  });
});

describe("planCategories", () => {
  test("creates new names on the other side and deletes names removed since the baseline", () => {
    const plan = planCategories(new Set(["A", "B", "New"]), new Set(["A", "B", "Old"]), null);
    expect(plan.createRemote).toEqual(["New"]);
    expect(plan.createLocal).toEqual(["Old"]);

    const known = baselineOf({ categories: ["A", "B", "Gone"] });
    const after = planCategories(new Set(["A", "B", "Gone"]), new Set(["A", "B"]), known);
    expect(after.deleteLocal).toEqual(["Gone"]);
    expect(after.names).toEqual(["A", "B"]);
  });
});

describe("mergeAssignments", () => {
  const categories = new Set(["A", "B", "C"]);

  test("without a baseline a work keeps every category either side gave it", () => {
    expect(mergeAssignments(["A"], ["B", "Unknown"], undefined, categories)).toEqual(["A", "B"]);
  });

  test("a category removed on one side since the baseline is removed on both", () => {
    expect(mergeAssignments(["A", "B"], ["A"], ["A", "B"], categories)).toEqual(["A"]);
    expect(mergeAssignments(["A", "C"], ["A"], ["A"], categories)).toEqual(["A", "C"]);
  });
});

describe("planChapters", () => {
  test("a change made on one side since the baseline goes to the other", () => {
    const base: Record<string, ChapterTriple> = { c1: [false, false, 3] };
    const plan = planChapters(
      new Map([["c1", chapter(1, true, false, 3, 200)], ["c2", chapter(2, false, true, 0, 0)]]),
      new Map([["c1", chapter(11, false, false, 3, 100)], ["c2", chapter(12, false, false, 0, 0)]]),
      base,
    );
    expect(plan.localUpdates).toEqual([]);
    expect(plan.remoteUpdates).toEqual([
      { id: 11, value: [true, false, 3] },
      { id: 12, value: [false, true, 0] },
    ]);
    expect(plan.merged).toEqual({ c1: [true, false, 3], c2: [false, true, 0] });
  });

  test("when both sides changed the same field, the side that read it last wins", () => {
    const plan = planChapters(
      new Map([["c1", chapter(1, false, false, 5, 100)]]),
      new Map([["c1", chapter(11, false, false, 9, 300)]]),
      { c1: [false, false, 2] },
    );
    expect(plan.localUpdates).toEqual([{ id: 1, value: [false, false, 9] }]);
    expect(plan.remoteUpdates).toEqual([]);
  });

  test("a chapter missing from an existing baseline counts as untouched", () => {
    const plan = planChapters(
      new Map([["c1", chapter(1, false, false, 0, 0)]]),
      new Map([["c1", chapter(11, true, false, 0, 50)]]),
      {},
    );
    expect(plan.localUpdates).toEqual([{ id: 1, value: [true, false, 0] }]);
  });

  test("without a baseline read and bookmark marks are kept and the page comes from the newer side", () => {
    const plan = planChapters(
      new Map([["c1", chapter(1, true, false, 4, 100)], ["c2", chapter(2, false, false, 7, 5)]]),
      new Map([["c1", chapter(11, false, true, 8, 300)], ["c2", chapter(12, false, false, 2, 5)]]),
      undefined,
    );
    expect(plan.localUpdates).toEqual([{ id: 1, value: [true, true, 8] }]);
    expect(plan.remoteUpdates).toEqual([
      { id: 11, value: [true, true, 8] },
      { id: 12, value: [false, false, 7] },
    ]);
  });

  test("chapters only one side lists and untouched chapters stay out of the baseline", () => {
    const plan = planChapters(
      new Map([["c1", chapter(1, false, false, 0)], ["only-local", chapter(2, true, false, 0)]]),
      new Map([["c1", chapter(11, false, false, 0)]]),
      undefined,
    );
    expect(plan.localUpdates).toEqual([]);
    expect(plan.remoteUpdates).toEqual([]);
    expect(plan.merged).toEqual({});
  });
});

describe("batchChapterUpdates", () => {
  test("groups chapters that get the same state and splits large groups", () => {
    const updates = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: index + 1, value: [true, false, 0] as ChapterTriple })),
      { id: 99, value: [false, true, 4] as ChapterTriple },
    ];
    expect(batchChapterUpdates(updates, 2)).toEqual([
      { ids: [1, 2], isRead: true, isBookmarked: false, lastPageRead: 0 },
      { ids: [3, 4], isRead: true, isBookmarked: false, lastPageRead: 0 },
      { ids: [5], isRead: true, isBookmarked: false, lastPageRead: 0 },
      { ids: [99], isRead: false, isBookmarked: true, lastPageRead: 4 },
    ]);
  });
});

describe("parseBaseline", () => {
  test("keeps valid entries and treats another version as none", () => {
    const key = comicKey("100", "/w/1");
    const parsed = parseBaseline({
      version: 1,
      library: [key, 3],
      categories: ["A"],
      assignments: { [key]: ["A", 1] },
      chapters: { [key]: { c1: [true, false, 2], bad: [true] } },
      digests: { [key]: "d" },
      sweptAt: 10,
    });
    expect(parsed).toEqual({
      version: 1,
      library: [key],
      categories: ["A"],
      assignments: { [key]: ["A"] },
      chapters: { [key]: { c1: [true, false, 2] } },
      digests: { [key]: "d" },
      sweptAt: 10,
    });
    expect(parseBaseline({ version: 2 })).toBeNull();
    expect(parseBaseline(null)).toBeNull();
  });
});
