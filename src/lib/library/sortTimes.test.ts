import { describe, expect, it } from "vitest";
import type { Manga } from "../types";
import type { LibrarySortDir, LibrarySortMode, LibraryStatusFilter } from "../../store/state.svelte";
import { buildComicsWorkStatusLabel, buildFilteredComics, type BuildComicsSectionInput, type ComicsRecentlyReadEntry } from "./comicsSection";
import { mangaLibraryTimes } from "./sortTimes";

function manga(id: number, title: string, overrides: Partial<Manga> = {}): Manga {
  return { id, title, thumbnailUrl: "", inLibrary: true, unreadCount: 0, chapterCount: 5, status: "ONGOING", ...overrides };
}

function filtered(
  mangas: Manga[],
  sortMode: LibrarySortMode,
  sortDir: LibrarySortDir,
  options: { statusFilter?: LibraryStatusFilter; recentReads?: ComicsRecentlyReadEntry[] } = {},
): string[] {
  const input = {
    libraryFilter: "library",
    mangas,
    search: "",
    sortMode,
    sortDir,
    statusFilter: options.statusFilter ?? "ALL",
    recentReads: options.recentReads ?? [],
    trackedCompletedIds: new Set<number>(),
    settings: { showNsfw: true, nsfwFilteredTags: [], nsfwAllowedSourceIds: [], nsfwBlockedSourceIds: [], libraryCropCovers: true },
  } as unknown as BuildComicsSectionInput;
  return buildFilteredComics(input, new Map()).map((item) => item.title);
}

// Ids follow A-Z order, as after a backup restore, so an id-based sort would look like A-Z.
const alpha = manga(1, "Alpha", {
  inLibraryAt: "1600000000",
  latestFetchedChapter: { fetchedAt: "1700000300" },
  latestUploadedChapter: { uploadDate: "1700000100000" },
  lastReadChapter: { lastReadAt: "1700000050" },
});
const beta = manga(2, "Beta", {
  inLibraryAt: "1650000000",
  latestFetchedChapter: { fetchedAt: "1700000100" },
  latestUploadedChapter: { uploadDate: "1700000300000" },
  lastReadChapter: null,
});
const gamma = manga(3, "Gamma", {
  inLibraryAt: "1620000000",
  latestFetchedChapter: { fetchedAt: "1700000200" },
  latestUploadedChapter: { uploadDate: "1700000200000" },
  lastReadChapter: { lastReadAt: "1700000400" },
});
const library = [alpha, beta, gamma];

describe("mangaLibraryTimes", () => {
  it("reads Suwayomi seconds and source milliseconds as epoch milliseconds", () => {
    expect(mangaLibraryTimes(alpha)).toEqual({
      addedAt: 1_600_000_000_000,
      latestFetchedAt: 1_700_000_300_000,
      latestUploadedAt: 1_700_000_100_000,
      lastReadAt: 1_700_000_050_000,
    });
  });

  it("falls back to the last chapter fetch and treats missing or zero dates as none", () => {
    expect(mangaLibraryTimes(manga(9, "Empty", { inLibraryAt: "0", chaptersLastFetchedAt: "1700000000" }))).toEqual({
      addedAt: 0,
      latestFetchedAt: 1_700_000_000_000,
      latestUploadedAt: 0,
      lastReadAt: 0,
    });
  });
});

describe("comics library date sorts", () => {
  it.each([
    ["recentlyAdded", ["Beta", "Gamma", "Alpha"]],
    ["latestFetched", ["Alpha", "Gamma", "Beta"]],
    ["latestUploaded", ["Beta", "Gamma", "Alpha"]],
    ["recentlyRead", ["Gamma", "Alpha", "Beta"]],
  ] as const)("orders %s by the real date in both directions", (sortMode, newestFirst) => {
    expect(filtered(library, sortMode, "desc")).toEqual(newestFirst);
    expect(filtered(library, sortMode, "asc")).toEqual([...newestFirst].reverse());
  });

  it("lets this device's newer history win over Suwayomi's last read chapter", () => {
    const recentReads = [{ mangaId: 2, readAt: 1_800_000_000_000 }, { mangaId: 2, readAt: 1 }];
    expect(filtered(library, "recentlyRead", "desc", { recentReads })).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("keeps ties in A-Z order whichever way the sort runs", () => {
    const undated = [manga(3, "Charlie"), manga(1, "bravo"), manga(2, "Alpha")];
    expect(filtered(undated, "latestUploaded", "desc")).toEqual(["Alpha", "bravo", "Charlie"]);
    expect(filtered(undated, "latestUploaded", "asc")).toEqual(["Alpha", "bravo", "Charlie"]);
    expect(filtered(undated, "totalChapters", "desc")).toEqual(["Alpha", "bravo", "Charlie"]);
  });
});

describe("comics library status filter", () => {
  it("matches Suwayomi's ON_HIATUS under the Hiatus filter", () => {
    const works = [
      manga(1, "Paused", { status: "ON_HIATUS" }),
      manga(2, "Running", { status: "ONGOING" }),
      manga(3, "Dropped", { status: "CANCELLED" }),
      manga(4, "Mystery", { status: null }),
    ];
    expect(filtered(works, "az", "asc", { statusFilter: "HIATUS" })).toEqual(["Paused"]);
    expect(filtered(works, "az", "asc", { statusFilter: "CANCELLED" })).toEqual(["Dropped"]);
    expect(filtered(works, "az", "asc", { statusFilter: "UNKNOWN" })).toEqual(["Mystery"]);
  });

  it("counts Suwayomi's PUBLISHING_FINISHED as completed and labels hiatus works as such", () => {
    const works = [
      manga(1, "Finished", { status: "PUBLISHING_FINISHED" }),
      manga(2, "Done", { status: "COMPLETED" }),
      manga(3, "Paused", { status: "ON_HIATUS" }),
    ];
    expect(filtered(works, "az", "asc", { statusFilter: "COMPLETED" })).toEqual(["Done", "Finished"]);
    expect(buildComicsWorkStatusLabel(works[0])).toBe("Completed");
    expect(buildComicsWorkStatusLabel(works[2])).toBe("Hiatus");
  });
});
