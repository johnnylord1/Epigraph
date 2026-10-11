import { describe, expect, test } from "vitest";
import { sameSnapshotData, store } from "./state.svelte";

describe("library snapshot writes", () => {
  test("compares snapshot data by value", () => {
    expect(sameSnapshotData([{ id: 1, tags: ["a"] }], [{ id: 1, tags: ["a"] }])).toBe(true);
    expect(sameSnapshotData([{ id: 1, tags: ["a"] }], [{ id: 1, tags: ["b"] }])).toBe(false);
    expect(sameSnapshotData([{ id: 1 }], [{ id: 1, title: undefined }])).toBe(false);
    expect(sameSnapshotData([{ id: 1 }], [{ id: 1 }, { id: 2 }])).toBe(false);
    expect(sameSnapshotData({ at: new Date(1) }, { at: new Date(1) })).toBe(false);
  });

  test("keeps the current snapshot when a reload brings back the same manga", () => {
    store.setLibraryMangaSnapshot([{ id: 7, title: "Same", thumbnailUrl: "" } as never]);
    const current = store.libraryMangaSnapshot;

    store.setLibraryMangaSnapshot([{ id: 7, title: "Same", thumbnailUrl: "" } as never]);
    expect(store.libraryMangaSnapshot).toBe(current);

    store.setLibraryMangaSnapshot([{ id: 7, title: "Renamed", thumbnailUrl: "" } as never]);
    expect(store.libraryMangaSnapshot).not.toBe(current);
    expect(store.libraryMangaSnapshot[0]?.title).toBe("Renamed");
  });
});
