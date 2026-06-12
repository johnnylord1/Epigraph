import { describe, expect, it } from "vitest";

import { buildNovelLibraryCards } from "./libraryShelf";
import type { PersistedNovelLibraryEntry } from "./domain";
import type { HardcoverNovelTrackRecord } from "./hardcover";

function novel(overrides: Partial<PersistedNovelLibraryEntry> = {}): PersistedNovelLibraryEntry {
  return {
    id: "novel:source:lotm",
    title: "Lord of the Mysteries",
    author: "Cuttlefish",
    description: null,
    coverUrl: null,
    path: "/lotm",
    status: null,
    tags: [],
    source: {
      sourceId: "lnreader:illusia",
      pluginId: "lnreader",
      pluginName: "LNReader",
      sourceName: "Illusia",
      lang: "pt-BR",
    },
    chapterCount: 10,
    addedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function hardcover(overrides: Partial<HardcoverNovelTrackRecord> = {}): HardcoverNovelTrackRecord {
  return {
    bookId: 1435,
    title: "Lord of the Mysteries",
    authors: ["Cuttlefish"],
    genres: [],
    tags: [],
    moods: [],
    coverUrl: null,
    status: "Read",
    workStatus: null,
    rating: null,
    progress: null,
    remoteUrl: "https://hardcover.app/books/lord-of-the-mysteries",
    updatedAt: 1,
    sourceNovelId: null,
    sourceTitleKey: "novel:lord of the mysteries",
    ...overrides,
  };
}

function cards(input: {
  entries: PersistedNovelLibraryEntry[];
  hardcoverRecords?: HardcoverNovelTrackRecord[];
}) {
  return buildNovelLibraryCards({
    entries: input.entries,
    chapters: [],
    progress: [],
    search: "",
    sortMode: "az",
    sortDir: "asc",
    statusFilter: "all",
    hardcoverRecords: input.hardcoverRecords,
  }).cards;
}

describe("buildNovelLibraryCards", () => {
  it("uses linked Hardcover publication status when the user has tracked the source novel", () => {
    const [card] = cards({
      entries: [novel()],
      hardcoverRecords: [hardcover({ sourceNovelId: "novel:source:lotm", workStatus: "Ongoing" })],
    });

    expect(card?.metaChips).toEqual(["Ongoing"]);
  });

  it("does not auto-match Hardcover titles that were not explicitly linked", () => {
    const [card] = cards({
      entries: [novel()],
      hardcoverRecords: [hardcover({ sourceNovelId: null, workStatus: "Completed" })],
    });

    expect(card?.metaChips).toEqual(["Unknown"]);
  });

  it("does not treat Hardcover reading status as publication status", () => {
    const [card] = cards({
      entries: [novel()],
      hardcoverRecords: [hardcover({ sourceNovelId: "novel:source:lotm", status: "Read", workStatus: null })],
    });

    expect(card?.metaChips).toEqual(["Unknown"]);
  });
});
