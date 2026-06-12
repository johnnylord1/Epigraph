import { describe, expect, it } from "vitest";
import type { Category, Manga } from "../types";
import {
  buildComicsLibraryCardVm,
  buildComicsReadingStateLabel,
  buildComicsSectionState,
} from "./comicsSection";

function manga(overrides: Partial<Manga> = {}): Manga {
  return {
    id: 1,
    title: "Alpha",
    thumbnailUrl: "thumb://alpha",
    inLibrary: true,
    downloadCount: 0,
    unreadCount: 3,
    chapterCount: 10,
    status: "ONGOING",
    genre: [],
    source: { id: "src-1", name: "Source", displayName: "Source" },
    ...overrides,
  };
}

function category(id: number, name: string, nodes: Manga[] = []): Category {
  return {
    id,
    name,
    order: id,
    default: false,
    includeInUpdate: "DEFAULT",
    includeInDownload: "DEFAULT",
    mangas: { nodes },
  };
}

describe("buildComicsSectionState", () => {
  it("derives categories, counts, filtered manga, and stable comic card ids", () => {
    const alpha = manga();
    const beta = manga({
      id: 2,
      title: "Beta",
      unreadCount: 0,
      downloadCount: 2,
      chapterCount: 20,
      status: "COMPLETED",
    });

    const state = buildComicsSectionState({
      librarySection: "comics",
      libraryFilter: "library",
      mangas: [alpha, beta],
      categories: [
        category(1, "Lendo", [alpha]),
        category(2, "Completed", [beta]),
      ],
      defaultCategoryId: 1,
      hiddenCategoryIds: [],
      search: "",
      sortMode: "unreadCount",
      sortDir: "desc",
      statusFilter: "ALL",
      recentReads: [],
      trackedCompletedIds: new Set([2]),
      trackedChapterTotalsByMangaId: new Map([[2, 20]]),
      settings: {
        showNsfw: false,
        nsfwFilteredTags: [],
        nsfwAllowedSourceIds: [],
        nsfwBlockedSourceIds: [],
        libraryCropCovers: true,
      },
      loading: false,
      error: null,
      selectedIds: new Set([1]),
      showBulkBar: true,
    });

    expect(state.visibleCategories.map((entry) => entry.name)).toEqual(["Lendo", "Completed"]);
    expect(state.counts.library).toBe(2);
    expect(state.counts.downloaded).toBe(1);
    expect(state.filteredManga.map((entry) => entry.id)).toEqual([1, 2]);
    expect(state.vm.cards.map((card) => card.id)).toEqual(["comic:1", "comic:2"]);
    expect(state.vm.cards[0].selected).toBe(true);
    expect(state.vm.collections[0].label).toBe("Saved");
    expect(state.vm.collections[2].label).toBe("Lendo");
  });

  it("uses publication-completed status semantics for the completed filter", () => {
    const ongoing = manga();
    const completed = manga({
      id: 3,
      title: "Gamma",
      status: "COMPLETED",
      unreadCount: 0,
      chapterCount: 12,
    });

    const state = buildComicsSectionState({
      librarySection: "comics",
      libraryFilter: "library",
      mangas: [ongoing, completed],
      categories: [category(3, "Completed", [completed])],
      defaultCategoryId: null,
      hiddenCategoryIds: [],
      search: "",
      sortMode: "az",
      sortDir: "asc",
      statusFilter: "COMPLETED",
      recentReads: [],
      trackedCompletedIds: new Set([3]),
      trackedChapterTotalsByMangaId: new Map([[3, 12]]),
      settings: {
        showNsfw: false,
        nsfwFilteredTags: [],
        nsfwAllowedSourceIds: [],
        nsfwBlockedSourceIds: [],
        libraryCropCovers: true,
      },
      loading: false,
      error: null,
    });

    expect(state.filteredManga.map((entry) => entry.id)).toEqual([3]);
    expect(state.vm.cards.map((card) => card.id)).toEqual(["comic:3"]);
  });

  it("resolves id-only category members against the library snapshot", () => {
    const alpha = manga();

    const state = buildComicsSectionState({
      librarySection: "comics",
      libraryFilter: "10",
      mangas: [alpha],
      categories: [category(10, "Favorites", [{ id: alpha.id } as Manga])],
      defaultCategoryId: null,
      hiddenCategoryIds: [],
      search: "",
      sortMode: "az",
      sortDir: "asc",
      statusFilter: "ALL",
      recentReads: [],
      trackedCompletedIds: new Set(),
      trackedChapterTotalsByMangaId: new Map(),
      settings: {
        showNsfw: false,
        nsfwFilteredTags: [],
        nsfwAllowedSourceIds: [],
        nsfwBlockedSourceIds: [],
        libraryCropCovers: true,
      },
      loading: false,
      error: null,
    });

    expect(state.counts["10"]).toBe(1);
    expect(state.filteredManga.map((entry) => entry.title)).toEqual(["Alpha"]);
  });

  it("builds Aethon comic card metadata from unread count and inferred state", () => {
    const unknownUnread = manga({
      status: "UNKNOWN",
      unreadCount: 12,
      chapterCount: 50,
    });
    const unknownRead = manga({
      id: 2,
      status: "UNKNOWN",
      unreadCount: 0,
      chapterCount: 50,
    });
    const finished = manga({
      id: 3,
      status: "COMPLETED",
      unreadCount: 0,
      chapterCount: 20,
    });

    const card = buildComicsLibraryCardVm(unknownUnread, {
      cropCovers: true,
      selectedIds: new Set(),
      trackedCompletedIds: new Set(),
      trackedChapterTotalsByMangaId: new Map(),
    });

    expect(card.badges).toEqual([{ kind: "unread", label: "CH 12" }]);
    expect(card.metaChips).toEqual(["Unknown"]);
    expect(buildComicsReadingStateLabel(unknownRead)).toBe("Unknown");
    expect(buildComicsReadingStateLabel(finished)).toBe("Completed");
    expect(buildComicsReadingStateLabel(finished, new Set([3]), new Map([[3, 20]]))).toBe("Finished");
  });
});
