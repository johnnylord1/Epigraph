import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyHardcoverState, hardcoverRecordToTrackedNovel, saveHardcoverState, type HardcoverNovelTrackRecord } from "../novels/hardcover";
import { loadNativeTrackedNovels, loadNativeTrackedTitleKeys } from "./providerInventory";
import { findTrackedNovel } from "./trackedNovels";

function record(patch: Partial<HardcoverNovelTrackRecord> = {}): HardcoverNovelTrackRecord {
  return {
    bookId: 101,
    title: "Lord of the Mysteries",
    authors: ["Cuttlefish That Loves Diving"],
    genres: ["Fantasy", "Mystery"],
    tags: ["Steampunk"],
    moods: [],
    coverUrl: null,
    status: "Currently Reading",
    workStatus: null,
    rating: 4.5,
    progress: null,
    remoteUrl: null,
    updatedAt: 0,
    sourceNovelId: null,
    sourceTitleKey: null,
    ...patch,
  };
}

describe("tracked novels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes the tracked entry the work's profile, with the user's rating and status there", () => {
    const tracked = hardcoverRecordToTrackedNovel(record({ sourceNovelId: "novel:central:/lotm" }));

    expect(tracked).toMatchObject({
      key: "hardcover:101",
      sourceNovelId: "novel:central:/lotm",
      userRating: 4.5,
      userRatingMax: 5,
      status: "reading",
      profile: {
        format: "NOVEL",
        genres: ["Fantasy", "Mystery", "Steampunk"],
        titles: ["Lord of the Mysteries"],
        hardcoverId: 101,
        credits: ["Cuttlefish That Loves Diving"],
      },
    });
  });

  it("finds a library work's tracked entry by its id, then by a title only one entry has", () => {
    const linked = hardcoverRecordToTrackedNovel(record({ sourceNovelId: "novel:central:/lotm" }));
    const byTitle = hardcoverRecordToTrackedNovel(record({ bookId: 202, title: "Shadow Slave", sourceTitleKey: null }));
    const tracked = [linked, byTitle];

    expect(findTrackedNovel(tracked, { novelId: "novel:central:/lotm", title: "Lorde dos Mistérios" })).toBe(linked);
    expect(findTrackedNovel(tracked, { novelId: "book-9", title: "Shadow Slave" })).toBe(byTitle);
    // A work linked to another library novel never stands in for this one.
    expect(findTrackedNovel(tracked, { novelId: "novel:other:/lotm", title: "Lord of the Mysteries" })).toBeNull();
    expect(findTrackedNovel(tracked, { novelId: "book-10", title: "Omniscient Reader" })).toBeNull();
  });

  it("does not guess between two tracked entries with the same title", () => {
    const tracked = [
      hardcoverRecordToTrackedNovel(record({ bookId: 1, title: "Berserker" })),
      hardcoverRecordToTrackedNovel(record({ bookId: 2, title: "Berserker" })),
    ];

    expect(findTrackedNovel(tracked, { novelId: "book-1", title: "Berserker" })).toBeNull();
  });

  it("reads the tracked novels of every native tracker for the scope", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    const scope = { profileId: "profile-1", serverUrl: "http://127.0.0.1:4577" };
    saveHardcoverState({
      ...createEmptyHardcoverState(scope),
      records: [record({ sourceNovelId: "central:/lotm" }), record({ bookId: 202, title: "Shadow Slave" })],
    }, scope);

    expect(loadNativeTrackedNovels(scope).map((tracked) => tracked.key)).toEqual(["hardcover:101", "hardcover:202"]);
    expect(loadNativeTrackedTitleKeys(scope)).toEqual(["novel:central:/lotm", "hardcover:202"]);
    expect(loadNativeTrackedNovels({ profileId: "profile-2" })).toEqual([]);
  });
});
