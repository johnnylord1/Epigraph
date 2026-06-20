import { beforeEach, describe, expect, it } from "vitest";

import {
  buildCategoryMembers,
  librarySnapshotScopeKey,
  loadLibrarySnapshot,
  normalizeLibrarySnapshot,
  resolveLibrarySnapshotCategoryState,
  saveLibrarySnapshot,
} from "./snapshot";
import type { Category, Manga } from "../types";

const manga: Manga = {
  id: 7,
  title: "A Library Title",
  thumbnailUrl: "/cover.jpg",
  inLibrary: true,
  chapterCount: 12,
  source: {
    id: "1",
    name: "demo",
    displayName: "Demo",
    lang: "en",
  },
};

const category: Category = {
  id: 3,
  name: "Reading",
  order: 1,
  default: false,
  includeInUpdate: "GLOBAL",
  includeInDownload: "GLOBAL",
  mangas: { nodes: [manga] },
};

describe("library snapshot", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    });
  });

  it("stores snapshots per profile and server", () => {
    saveLibrarySnapshot(
      { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      {
        mangas: [manga],
        categories: [category],
        categoryMembers: buildCategoryMembers([category]),
        trackingSummary: [{ tracker: "demo" }],
        updatedAt: 42,
      },
    );

    expect(loadLibrarySnapshot({ profileId: "main", serverUrl: "http://127.0.0.1:4567" })).toMatchObject({
      scopeKey: librarySnapshotScopeKey({ profileId: "main", serverUrl: "http://127.0.0.1:4567" }),
      updatedAt: 42,
      categoryMembers: { "3": [7] },
    });
    expect(loadLibrarySnapshot({ profileId: "test", serverUrl: "http://127.0.0.1:4667" })).toBeNull();
  });

  it("ignores invalid or empty snapshots", () => {
    expect(normalizeLibrarySnapshot({ version: 1, mangas: [], categories: [] })).toBeNull();
    expect(normalizeLibrarySnapshot({ mangas: [{ id: "nope" }], categories: [{ id: null }] })).toBeNull();
  });

  it("preserves folders when a transient category refresh returns no data", () => {
    const previous = saveLibrarySnapshot(
      { profileId: "main", serverUrl: "http://127.0.0.1:4567" },
      {
        mangas: [manga],
        categories: [category],
        categoryMembers: { "3": [7] },
        trackingSummary: [],
      },
    );

    expect(resolveLibrarySnapshotCategoryState(previous, [], {}, false)).toEqual({
      categories: previous.categories,
      categoryMembers: { "3": [7] },
    });
    expect(resolveLibrarySnapshotCategoryState(previous, [], {}, true)).toEqual({
      categories: [],
      categoryMembers: {},
    });
  });
});
