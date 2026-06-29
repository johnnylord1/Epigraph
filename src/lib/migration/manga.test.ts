import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, gqlMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  gqlMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../client", () => ({
  gql: gqlMock,
}));

import { resetMigrationJournalStateCacheForTests } from "./journalState";
import {
  applyMangaMigrationWithJournal,
  applyMassMangaMigrationWithJournal,
  previewMassMangaMigration,
  updateMassMangaMigrationPreviewItem,
  undoMangaMigration,
} from "./manga";
import type { Chapter, Manga } from "../types";

function createManga(id: number, title: string, sourceId: string, inLibrary = true): Manga {
  return {
    id,
    title,
    thumbnailUrl: "",
    inLibrary,
    source: {
      id: sourceId,
      name: sourceId,
      displayName: sourceId,
    },
  };
}

function createChapter(id: number, mangaId: number, chapterNumber: number, overrides: Partial<Chapter> = {}): Chapter {
  return {
    id,
    name: `Chapter ${chapterNumber}`,
    chapterNumber,
    sourceOrder: id,
    isRead: false,
    isDownloaded: false,
    isBookmarked: false,
    pageCount: 10,
    mangaId,
    uploadDate: null,
    realUrl: null,
    lastPageRead: 0,
    scanlator: null,
    ...overrides,
  };
}

describe("manga migration services", () => {
  let journalStateJson: string | null;
  let mangaById: Map<number, Manga>;
  let chaptersByMangaId: Map<number, Chapter[]>;
  let categoryMembership: Map<number, number[]>;
  let failUpdateMangaIds: Set<number>;

  beforeEach(() => {
    resetMigrationJournalStateCacheForTests();
    journalStateJson = null;
    gqlMock.mockReset();
    invokeMock.mockReset();
    failUpdateMangaIds = new Set();

    mangaById = new Map([
      [10, createManga(10, "Alpha Hero", "source-old", true)],
      [20, createManga(20, "Alpha Hero", "source-new", false)],
      [11, createManga(11, "Blue Planet", "source-old", true)],
      [21, createManga(21, "Scarlet Forest", "source-new", false)],
      [12, createManga(12, "No Match Book", "source-old", true)],
      [13, createManga(13, "Slow Book", "source-old", true)],
    ]);

    chaptersByMangaId = new Map([
      [10, [
        createChapter(101, 10, 1, { isRead: false, isBookmarked: true, lastPageRead: 7 }),
        createChapter(102, 10, 2, { isRead: true }),
      ]],
      [20, [
        createChapter(201, 20, 1),
        createChapter(202, 20, 2),
      ]],
      [11, [
        createChapter(111, 11, 1, { isRead: true }),
      ]],
      [21, [
        createChapter(211, 21, 1),
      ]],
      [12, [
        createChapter(121, 12, 1),
      ]],
      [13, [
        createChapter(131, 13, 1),
      ]],
    ]);

    categoryMembership = new Map([
      [1, [10, 11]],
      [2, [10]],
      [3, [20]],
    ]);

    const memoryStorage = (() => {
      const data = new Map<string, string>();
      return {
        getItem: vi.fn((key: string) => data.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          data.set(key, value);
        }),
      };
    })();

    Object.defineProperty(globalThis, "window", {
      value: {
        localStorage: memoryStorage,
        __TAURI_INTERNALS__: {},
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: memoryStorage,
      configurable: true,
      writable: true,
    });

    invokeMock.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
      switch (command) {
        case "read_migration_journal_state":
          return journalStateJson;
        case "write_migration_journal_state":
          journalStateJson = String(payload?.contents ?? "");
          return null;
        default:
          throw new Error(`Unexpected invoke command: ${command}`);
      }
    });

    gqlMock.mockImplementation(async (query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal) => {
      if (query.includes("query GetCategories")) {
        return {
          categories: {
            nodes: [...categoryMembership.entries()].map(([id, mangaIds]) => ({
              id,
              name: `Category ${id}`,
              order: id,
              default: false,
              includeInUpdate: "DEFAULT",
              includeInDownload: "DEFAULT",
              mangas: {
                nodes: mangaIds
                  .map((mangaId) => mangaById.get(mangaId))
                  .filter((manga): manga is Manga => Boolean(manga)),
              },
            })),
          },
        };
      }

      if (query.includes("mutation UpdateMangaCategories")) {
        const mangaId = Number(variables.mangaId);
        const addTo = Array.isArray(variables.addTo) ? variables.addTo.map(Number) : [];
        const removeFrom = Array.isArray(variables.removeFrom) ? variables.removeFrom.map(Number) : [];

        for (const categoryId of addTo) {
          const current = new Set(categoryMembership.get(categoryId) ?? []);
          current.add(mangaId);
          categoryMembership.set(categoryId, [...current]);
        }
        for (const categoryId of removeFrom) {
          const current = new Set(categoryMembership.get(categoryId) ?? []);
          current.delete(mangaId);
          categoryMembership.set(categoryId, [...current]);
        }

        return {
          updateMangaCategories: {
            manga: { id: mangaId },
          },
        };
      }

      if (query.includes("mutation UpdateManga(")) {
        const id = Number(variables.id);
        if (failUpdateMangaIds.has(id)) {
          throw new Error(`Update manga ${id} failed`);
        }
        const current = mangaById.get(id);
        if (current) {
          mangaById.set(id, {
            ...current,
            inLibrary: Boolean(variables.inLibrary),
          });
        }
        return {
          updateManga: {
            manga: mangaById.get(id),
          },
        };
      }

      if (query.includes("mutation UpdateChaptersProgress")) {
        const ids = Array.isArray(variables.ids) ? variables.ids.map(Number) : [];
        for (const chapters of chaptersByMangaId.values()) {
          for (const chapter of chapters) {
            if (!ids.includes(chapter.id)) continue;
            if ("isRead" in variables && typeof variables.isRead === "boolean") {
              chapter.isRead = variables.isRead;
            }
            if ("isBookmarked" in variables && typeof variables.isBookmarked === "boolean") {
              chapter.isBookmarked = variables.isBookmarked;
            }
            if ("lastPageRead" in variables) {
              chapter.lastPageRead = typeof variables.lastPageRead === "number" ? variables.lastPageRead : 0;
            }
          }
        }
        return {
          updateChapters: {
            chapters: ids,
          },
        };
      }

      if (query.includes("mutation FetchSourceManga")) {
        const queryText = String(variables.query ?? "");
        if (queryText === "Slow Book") {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        if (queryText === "Alpha Hero") {
          return { fetchSourceManga: { mangas: [mangaById.get(20)] } };
        }
        if (queryText === "Blue Planet") {
          return { fetchSourceManga: { mangas: [mangaById.get(21)] } };
        }
        if (queryText === "No Match Book") {
          return { fetchSourceManga: { mangas: [] } };
        }
        return { fetchSourceManga: { mangas: [] } };
      }

      if (query.includes("mutation FetchChapters")) {
        const mangaId = Number(variables.mangaId);
        return {
          fetchChapters: {
            chapters: chaptersByMangaId.get(mangaId) ?? [],
          },
        };
      }

      throw new Error(`Unexpected gql query: ${query.slice(0, 40)}`);
    });
  });

  it("applies and undoes a single manga migration with category transfer", async () => {
    const result = await applyMangaMigrationWithJournal({
      currentManga: mangaById.get(10)!,
      currentChapters: chaptersByMangaId.get(10)!,
      targetSourceId: "source-new",
      match: {
        manga: mangaById.get(20)!,
        chapters: chaptersByMangaId.get(20)!,
        similarity: 1,
      },
    });

    expect(mangaById.get(10)?.inLibrary).toBe(false);
    expect(mangaById.get(20)?.inLibrary).toBe(true);
    expect(categoryMembership.get(1)).toContain(20);
    expect(categoryMembership.get(2)).toContain(20);
    expect(categoryMembership.get(1)).not.toContain(10);
    expect(categoryMembership.get(2)).not.toContain(10);
    expect(chaptersByMangaId.get(20)?.[0]?.isRead).toBe(true);
    expect(chaptersByMangaId.get(20)?.[0]?.isBookmarked).toBe(true);
    expect(chaptersByMangaId.get(20)?.[0]?.lastPageRead).toBe(7);
    expect(chaptersByMangaId.get(20)?.[1]?.isRead).toBe(true);

    await undoMangaMigration(result.journalEntryId);

    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
    expect(categoryMembership.get(1)).toContain(10);
    expect(categoryMembership.get(2)).toContain(10);
    expect(categoryMembership.get(3)).toContain(20);
  });

  it("can copy a single manga migration without removing the source title", async () => {
    const result = await applyMangaMigrationWithJournal({
      currentManga: mangaById.get(10)!,
      currentChapters: chaptersByMangaId.get(10)!,
      targetSourceId: "source-new",
      mode: "copy",
      match: {
        manga: mangaById.get(20)!,
        chapters: chaptersByMangaId.get(20)!,
        similarity: 1,
      },
    });

    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(true);
    expect(categoryMembership.get(1)).toContain(10);
    expect(categoryMembership.get(1)).toContain(20);
    expect(categoryMembership.get(2)).toContain(10);
    expect(categoryMembership.get(2)).toContain(20);

    await undoMangaMigration(result.journalEntryId);

    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
    expect(categoryMembership.get(1)).toContain(10);
    expect(categoryMembership.get(2)).toContain(10);
  });

  it("previews and applies a mass manga migration for selected matched items", async () => {
    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      items: [
        { manga: mangaById.get(10)!, chapters: chaptersByMangaId.get(10)! },
        { manga: mangaById.get(11)!, chapters: chaptersByMangaId.get(11)! },
        { manga: mangaById.get(12)!, chapters: chaptersByMangaId.get(12)! },
      ],
    });

    expect(preview.readyCount).toBe(1);
    expect(preview.needsReviewCount).toBe(1);
    expect(preview.blockedCount).toBe(1);
    expect(preview.items.find((item) => item.currentManga.id === 10)?.status).toBe("matched");
    expect(preview.items.find((item) => item.currentManga.id === 11)?.status).toBe("needs_review");
    expect(preview.items.find((item) => item.currentManga.id === 12)?.status).toBe("no_match");

    const applied = await applyMassMangaMigrationWithJournal({ preview });

    expect(applied.migratedCount).toBe(2);
    expect(applied.skippedCount).toBe(1);
    expect(mangaById.get(10)?.inLibrary).toBe(false);
    expect(mangaById.get(20)?.inLibrary).toBe(true);
    expect(mangaById.get(11)?.inLibrary).toBe(false);
    expect(mangaById.get(21)?.inLibrary).toBe(true);

    const journalState = JSON.parse(String(journalStateJson));
    expect(journalState.entries[0].mode).toBe("mass");
    expect(journalState.entries[0].status).toBe("applied");
    expect(journalState.entries[0].payload.items).toHaveLength(2);

    expect(applied.journalEntryId).not.toBeNull();
    await undoMangaMigration(applied.journalEntryId!);

    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
    expect(mangaById.get(11)?.inLibrary).toBe(true);
    expect(mangaById.get(21)?.inLibrary).toBe(false);
    expect(categoryMembership.get(1)).toContain(10);
    expect(categoryMembership.get(2)).toContain(10);
    expect(categoryMembership.get(3)).toContain(20);
  });

  it("promotes a reviewed mass migration item after manual match selection", async () => {
    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      items: [
        { manga: mangaById.get(11)!, chapters: chaptersByMangaId.get(11)! },
      ],
    });

    expect(preview.items[0].status).toBe("needs_review");

    const reviewed = updateMassMangaMigrationPreviewItem(preview, 11, {
      manga: mangaById.get(21)!,
      chapters: chaptersByMangaId.get(21)!,
      similarity: 0.42,
    });

    expect(reviewed.items[0].status).toBe("matched");
    expect(reviewed.items[0].reasonCode).toBe("manual_match");
    expect(reviewed.readyCount).toBe(1);
    expect(reviewed.needsReviewCount).toBe(0);
  });

  it("marks slow mass migration searches as search failures and continues the preview", async () => {
    const onItemDone = vi.fn();

    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      itemTimeoutMs: 10,
      onItemDone,
      items: [
        { manga: mangaById.get(10)!, chapters: chaptersByMangaId.get(10)! },
        { manga: mangaById.get(13)!, chapters: chaptersByMangaId.get(13)! },
      ],
    });

    expect(preview.readyCount).toBe(1);
    expect(preview.blockedCount).toBe(1);
    expect(preview.items.find((item) => item.currentManga.id === 13)?.status).toBe("search_failed");
    expect(preview.items.find((item) => item.currentManga.id === 13)?.reasonCode).toContain("Timed out while searching Slow Book");
    expect(onItemDone).toHaveBeenCalledTimes(2);
  });

  it("keeps failed source manga and journals successful mass items", async () => {
    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      items: [
        { manga: mangaById.get(10)!, chapters: chaptersByMangaId.get(10)! },
        { manga: mangaById.get(11)!, chapters: chaptersByMangaId.get(11)! },
      ],
    });
    const reviewed = updateMassMangaMigrationPreviewItem(preview, 11, {
      manga: mangaById.get(21)!,
      chapters: chaptersByMangaId.get(21)!,
      similarity: 1,
    });
    failUpdateMangaIds.add(21);

    const applied = await applyMassMangaMigrationWithJournal({ preview: reviewed });

    expect(applied.migratedCount).toBe(1);
    expect(applied.migratedSourceMangaIds).toEqual([10]);
    expect(applied.failedItems).toEqual([{ mangaId: 11, message: "Update manga 21 failed" }]);
    expect(mangaById.get(10)?.inLibrary).toBe(false);
    expect(mangaById.get(20)?.inLibrary).toBe(true);
    expect(mangaById.get(11)?.inLibrary).toBe(true);
    expect(mangaById.get(21)?.inLibrary).toBe(false);

    const journalState = JSON.parse(String(journalStateJson));
    expect(journalState.entries[0].payload.items).toHaveLength(1);
  });

  it("does not leave the target in the library when cleanup of the source fails", async () => {
    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      items: [
        { manga: mangaById.get(10)!, chapters: chaptersByMangaId.get(10)! },
      ],
    });
    failUpdateMangaIds.add(10);

    const applied = await applyMassMangaMigrationWithJournal({ preview });

    expect(applied.migratedCount).toBe(0);
    expect(applied.failedItems).toEqual([{ mangaId: 10, message: "Update manga 10 failed" }]);
    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
    expect(journalStateJson).toBeNull();
  });
});
