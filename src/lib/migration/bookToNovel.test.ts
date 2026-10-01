import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { NovelDetailRecord, PersistedNovelLibraryState } from "../novels/domain";
import { getNovelLibraryChapters, getNovelProgressEntry, normalizeNovelLibraryState, upsertNovelInLibrary, updateNovelReadingProgress } from "../novels/libraryState";
import {
  bookToNovelTitleConfidence,
  buildBookToNovelLibraryState,
  matchBookProgressToNovelChapter,
  previewBookToNovel,
} from "./bookToNovel";

const TITLES = ["Prologue", "Chapter 1: The Gate", "Chapter 2: Ashes", "Chapter 3: Tide", "Epilogue"];

function target(): NovelDetailRecord {
  const id = "royalroad::/fiction/1";
  return {
    id,
    sourceId: "royalroad",
    title: "The Gate Below",
    path: "/fiction/1",
    coverUrl: null,
    author: "Someone",
    description: null,
    status: null,
    tags: [],
    chapterCount: TITLES.length,
    chapters: TITLES.map((title, order) => ({
      id: `${id}::/c/${order}`,
      novelId: id,
      path: `/c/${order}`,
      title,
      order,
      releaseTime: null,
      unread: true,
    })),
    source: {
      repositoryUrl: "https://example.invalid/plugins.json",
      repositoryName: "Official",
      pluginId: "royalroad",
      pluginName: "Royal Road",
      pluginVersion: "2.3.0",
      sourceId: "royalroad",
      sourceName: "Royal Road",
      lang: "en",
    },
  } as NovelDetailRecord;
}

function emptyState(): PersistedNovelLibraryState {
  return normalizeNovelLibraryState({ scopeKey: "profile:test" });
}

describe("book to novel copy", () => {
  it("prefers the section title, then the chapter number, then the reading percentage", () => {
    const { chapters } = target();
    expect(matchBookProgressToNovelChapter({ sectionLabel: "chapter 2 ashes", progressPercent: 0.1 }, chapters))
      .toMatchObject({ reason: "section-title", chapter: { order: 2 } });
    expect(matchBookProgressToNovelChapter({ sectionLabel: "Capítulo 3", progressPercent: 0.1 }, chapters))
      .toMatchObject({ reason: "section-number", chapter: { order: 3 } });
    expect(matchBookProgressToNovelChapter({ sectionLabel: "Map of the world", progressPercent: 0.5 }, chapters))
      .toMatchObject({ reason: "percent", chapter: { order: 2 } });
    expect(matchBookProgressToNovelChapter({ sectionLabel: null, progressPercent: 1 }, chapters))
      .toMatchObject({ reason: "percent", chapter: { order: 4 } });
    expect(matchBookProgressToNovelChapter({ sectionLabel: null, progressPercent: 0 }, chapters))
      .toEqual({ chapter: null, reason: "none" });
    expect(matchBookProgressToNovelChapter(null, chapters)).toEqual({ chapter: null, reason: "none" });
  });

  it("adds the novel and lands on the mapped chapter with earlier chapters read", () => {
    const detail = target();
    const match = matchBookProgressToNovelChapter({ sectionLabel: "Chapter 2: Ashes", progressPercent: 0.4 }, detail.chapters);
    const next = buildBookToNovelLibraryState(emptyState(), detail, match, 1_000);

    expect(next.entries.map((entry) => entry.id)).toEqual([detail.id]);
    expect(getNovelLibraryChapters(next, detail.id).map((chapter) => chapter.unread)).toEqual([false, false, true, true, true]);
    expect(getNovelProgressEntry(next, detail.id)).toMatchObject({ chapterId: detail.chapters[2].id, chapterTitle: "Chapter 2: Ashes", updatedAt: 1_000 });
  });

  it("never moves progress backwards when the novel is already further along", () => {
    const detail = target();
    const existing = updateNovelReadingProgress(upsertNovelInLibrary(emptyState(), detail), {
      novelId: detail.id,
      chapterId: detail.chapters[3].id,
      chapterTitle: detail.chapters[3].title,
      chapterProgress: 0.2,
      updatedAt: 500,
    });
    const match = matchBookProgressToNovelChapter({ sectionLabel: "Chapter 1: The Gate", progressPercent: 0.2 }, detail.chapters);

    const preview = previewBookToNovel({ bookTitle: "The Gate Below", progress: { sectionLabel: "Chapter 1: The Gate", progressPercent: 0.2 }, target: detail, state: existing });
    expect(preview).toMatchObject({ alreadyInLibrary: true, keepsExistingProgress: true, readCount: 0, confidence: 1 });

    const next = buildBookToNovelLibraryState(existing, detail, match, 2_000);
    expect(getNovelProgressEntry(next, detail.id)).toMatchObject({ chapterId: detail.chapters[3].id, updatedAt: 500 });
  });

  it("only adds the novel when the book has no position yet", () => {
    const detail = target();
    const next = buildBookToNovelLibraryState(emptyState(), detail, { chapter: null, reason: "none" });
    expect(next.entries).toHaveLength(1);
    expect(next.progress).toEqual([]);
    expect(getNovelLibraryChapters(next, detail.id).every((chapter) => chapter.unread)).toBe(true);
  });

  it("scores title overlap without punctuation or accents", () => {
    expect(bookToNovelTitleConfidence("A Espada do Destino", "a espada do destino!")).toBe(1);
    expect(bookToNovelTitleConfidence("Mother of Learning", "Learning Mother")).toBeCloseTo(2 / 3);
    expect(bookToNovelTitleConfidence("", "Anything")).toBe(0);
  });
});
