import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { store } from "./state.svelte";

const base = {
  mangaId: 1,
  mangaTitle: "Series",
  thumbnailUrl: "",
  chapterId: 10,
  chapterName: "Chapter",
};

describe("comic bookmark state", () => {
  let previous = store.bookmarks;

  beforeEach(() => {
    previous = store.bookmarks;
    store.bookmarks = [];
  });

  afterEach(() => {
    store.bookmarks = previous;
  });

  it("keeps explicit page bookmarks when the automatic resume marker advances", () => {
    store.addBookmark({ ...base, pageNumber: 2 });
    store.addBookmark({ ...base, pageNumber: 3, isAutomatic: true });
    store.addBookmark({ ...base, pageNumber: 4, isAutomatic: true });

    expect(store.bookmarks).toHaveLength(2);
    expect(store.bookmarks.find((entry) => !entry.isAutomatic)?.pageNumber).toBe(2);
    expect(store.bookmarks.find((entry) => entry.isAutomatic)?.pageNumber).toBe(4);
  });

  it("removes an explicit locator without deleting the automatic resume marker", () => {
    store.addBookmark({ ...base, pageNumber: 2 });
    store.addBookmark({ ...base, pageNumber: 2, isAutomatic: true });

    store.removePageBookmark(base.chapterId, 2);

    expect(store.bookmarks).toHaveLength(1);
    expect(store.bookmarks[0]?.isAutomatic).toBe(true);
  });
});
