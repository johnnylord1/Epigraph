import { describe, expect, it } from "vitest";
import type { HardcoverNovelTrackRecord } from "../novels/hardcover";
import {
  hardcoverBindingMatchesSlice,
  prepareHardcoverBindingMigration,
  replaceHardcoverBindingSlice,
  restoreHardcoverBindingSlice,
} from "./hardcoverBinding";

function record(overrides: Partial<HardcoverNovelTrackRecord> = {}): HardcoverNovelTrackRecord {
  return {
    userBookId: 11,
    bookId: 22,
    title: "Book",
    authors: ["Author"],
    genres: [],
    tags: [],
    moods: [],
    coverUrl: null,
    status: "Reading",
    workStatus: "Ongoing",
    rating: 4,
    progress: 37,
    remoteUrl: "https://hardcover.app/books/book",
    updatedAt: 100,
    sourceNovelId: "source",
    sourceTitleKey: "book",
    ...overrides,
  };
}

describe("Hardcover migration identity", () => {
  it("retargets only the local source binding and preserves remote fields", () => {
    const source = record();
    const prepared = prepareHardcoverBindingMigration({
      records: [source],
      sourceNovelId: "source",
      targetNovelId: "target",
    });

    expect(prepared.nextRecords).toEqual([{ ...source, sourceNovelId: "target" }]);
    expect(hardcoverBindingMatchesSlice(prepared.nextRecords, prepared.applied)).toBe(true);
    expect(restoreHardcoverBindingSlice(prepared.nextRecords, prepared.previous)).toEqual([source]);
  });

  it("coalesces duplicate bindings for the same Hardcover book", () => {
    const prepared = prepareHardcoverBindingMigration({
      records: [
        record(),
        record({ sourceNovelId: "target", updatedAt: 200, progress: 42 }),
      ],
      sourceNovelId: "source",
      targetNovelId: "target",
    });

    expect(prepared.nextRecords).toHaveLength(1);
    expect(prepared.nextRecords[0]).toMatchObject({
      bookId: 22,
      sourceNovelId: "target",
      progress: 42,
    });
  });

  it("blocks different Hardcover editions before producing a new state", () => {
    expect(() => prepareHardcoverBindingMigration({
      records: [
        record(),
        record({ sourceNovelId: "target", bookId: 33 }),
      ],
      sourceNovelId: "source",
      targetNovelId: "target",
    })).toThrow("different Hardcover editions");
  });

  it("preserves another local binding that shares the same Hardcover book", () => {
    const shared = record({ sourceNovelId: "other" });
    const prepared = prepareHardcoverBindingMigration({
      records: [record(), shared],
      sourceNovelId: "source",
      targetNovelId: "target",
    });

    expect(prepared.nextRecords).toEqual(expect.arrayContaining([
      { ...record(), sourceNovelId: "target" },
      shared,
    ]));
    expect(restoreHardcoverBindingSlice(
      prepared.nextRecords,
      prepared.previous,
    )).toEqual(expect.arrayContaining([record(), shared]));
  });

  it("merges only the migration slice into a newer tracking state", () => {
    const prepared = prepareHardcoverBindingMigration({
      records: [record()],
      sourceNovelId: "source",
      targetNovelId: "target",
    });
    const concurrent = record({
      bookId: 99,
      sourceNovelId: "other",
      title: "Concurrent",
    });

    expect(replaceHardcoverBindingSlice(
      [record(), concurrent],
      prepared.previous,
      prepared.applied,
    )).toEqual(expect.arrayContaining([
      { ...record(), sourceNovelId: "target" },
      concurrent,
    ]));
  });

  it("blocks conflicting Hardcover user-book identities", () => {
    expect(() => prepareHardcoverBindingMigration({
      records: [
        record({ userBookId: 11 }),
        record({ sourceNovelId: "target", userBookId: 12 }),
      ],
      sourceNovelId: "source",
      targetNovelId: "target",
    })).toThrow("conflicting Hardcover user-book identities");
  });

  it("does not infer a binding from title alone", () => {
    const unbound = record({ sourceNovelId: null });
    const prepared = prepareHardcoverBindingMigration({
      records: [unbound],
      sourceNovelId: "source",
      targetNovelId: "target",
    });
    expect(prepared.nextRecords).toEqual([unbound]);
  });
});
