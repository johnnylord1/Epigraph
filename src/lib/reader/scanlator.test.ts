import { describe, expect, it } from "vitest";
import { buildReaderChapterList, effectiveScanlator, listScanlators, normalizeMangaReaderPreference, resolveReaderChapterTarget } from "./scanlator";
import type { Chapter } from "../types";

const chapters: Chapter[] = [
  {
    id: 1,
    name: "Ch 1 / Group A",
    chapterNumber: 1,
    sourceOrder: 1,
    isRead: false,
    isDownloaded: false,
    isBookmarked: false,
    pageCount: 10,
    mangaId: 99,
    scanlator: "Group A",
  },
  {
    id: 2,
    name: "Ch 1 / Group B",
    chapterNumber: 1,
    sourceOrder: 2,
    isRead: false,
    isDownloaded: false,
    isBookmarked: false,
    pageCount: 10,
    mangaId: 99,
    scanlator: "Group B",
  },
  {
    id: 3,
    name: "Ch 2 / Group A",
    chapterNumber: 2,
    sourceOrder: 3,
    isRead: false,
    isDownloaded: false,
    isBookmarked: false,
    pageCount: 10,
    mangaId: 99,
    scanlator: "Group A",
  },
];

describe("scanlator reader helpers", () => {
  it("lists unique scanlators from chapters", () => {
    expect(listScanlators(chapters)).toEqual(["Group A", "Group B"]);
  });

  it("uses a source fallback for official sources with empty chapter scanlators", () => {
    const officialChapters = chapters.map((chapter) => ({ ...chapter, scanlator: null }));

    expect(listScanlators(officialChapters, "MangaPlus")).toEqual(["MangaPlus"]);
    expect(effectiveScanlator(officialChapters[0], "MangaPlus")).toBe("MangaPlus");
  });

  it("filters the canonical reader list when allowed scanlators are selected", () => {
    const filtered = buildReaderChapterList(chapters, {
      scanlatorFilter: ["Group B"],
    });

    expect(filtered.map((chapter) => chapter.id)).toEqual([2]);
  });

  it("filters official-source chapters by the fallback scanlator label", () => {
    const officialChapters = chapters.map((chapter) => ({ ...chapter, scanlator: null }));
    const filtered = buildReaderChapterList(officialChapters, {
      scanlatorFilter: ["MangaPlus"],
    }, "MangaPlus");

    expect(filtered.map((chapter) => chapter.id)).toEqual([1, 2, 3]);
  });

  it("prioritizes the preferred scanlator within duplicate chapter groups", () => {
    const ordered = buildReaderChapterList(chapters, {
      preferredScanlator: "Group B",
      scanlatorFilter: [],
    });

    expect(ordered.map((chapter) => chapter.id)).toEqual([2, 1, 3]);
  });

  it("falls back to the nearest remaining chapter when the requested one is filtered out", () => {
    const filtered = buildReaderChapterList(chapters, {
      scanlatorFilter: ["Group B"],
    });

    expect(resolveReaderChapterTarget(chapters[0], filtered)?.id).toBe(2);
  });

  it("normalizes stored preferences safely", () => {
    expect(normalizeMangaReaderPreference({
      preferredScanlator: "  Group A  ",
      scanlatorFilter: ["Group A", "", "Group A", "  Group B  "],
    })).toEqual({
      preferredScanlator: "Group A",
      scanlatorFilter: ["Group A", "Group B"],
    });
  });
});
