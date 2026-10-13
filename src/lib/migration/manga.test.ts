import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, gqlMock, searchSourceMangaMock, fetchSourceMangaChaptersMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  gqlMock: vi.fn(),
  searchSourceMangaMock: vi.fn(),
  fetchSourceMangaChaptersMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../client", () => ({
  gql: gqlMock,
}));

vi.mock("../manga/runtime", () => ({
  searchSourceManga: searchSourceMangaMock,
  fetchSourceMangaChapters: fetchSourceMangaChaptersMock,
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
import {
  migrationIdentityRevision,
  type MigrationIdentityBridge,
  type MigrationIdentitySettings,
} from "./identity";

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

function createMemoryIdentityBridge(initial: MigrationIdentitySettings) {
  let settings = structuredClone(initial);
  const bridge: MigrationIdentityBridge = {
    profileId: "main",
    async read() {
      return {
        profileId: "main",
        revision: migrationIdentityRevision(settings),
        settings: structuredClone(settings),
      };
    },
    async write(input) {
      if (input.expectedRevision !== migrationIdentityRevision(settings)) {
        throw new Error("identity revision mismatch");
      }
      settings = structuredClone(input.next);
      return this.read();
    },
  };
  return {
    bridge,
    read: () => structuredClone(settings),
  };
}

describe("manga migration services", () => {
  let journalStateJson: string | null;
  let mangaById: Map<number, Manga>;
  let chaptersByMangaId: Map<number, Chapter[]>;
  let categoryMembership: Map<number, number[]>;
  let failUpdateMangaIds: Set<number>;
  let journalStatusAtFirstMutation: string | null;
  let trackerRecordsByMangaId: Map<number, Array<{ id: number; trackerId: number; remoteId: string }>>;
  let nextTrackerRecordId: number;

  beforeEach(() => {
    resetMigrationJournalStateCacheForTests();
    journalStateJson = null;
    gqlMock.mockReset();
    searchSourceMangaMock.mockReset();
    fetchSourceMangaChaptersMock.mockReset();
    invokeMock.mockReset();
    failUpdateMangaIds = new Set();
    journalStatusAtFirstMutation = null;
    trackerRecordsByMangaId = new Map();
    nextTrackerRecordId = 1000;

    mangaById = new Map([
      [10, createManga(10, "Alpha Hero", "source-old", true)],
      [20, createManga(20, "Alpha Hero", "source-new", false)],
      [11, createManga(11, "Blue Planet", "source-old", true)],
      [21, createManga(21, "Blue Planet: Second Orbit", "source-new", false)],
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

    searchSourceMangaMock.mockImplementation(async (variables: Record<string, unknown>, signal?: AbortSignal) => {
      const queryText = String(variables.query ?? "");
      if (queryText === "Slow Book") {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      const mangas = queryText === "Alpha Hero"
        ? [mangaById.get(20)]
        : queryText === "Blue Planet"
          ? [mangaById.get(21)]
          : [];
      return { fetchSourceManga: { mangas, hasNextPage: false } };
    });
    fetchSourceMangaChaptersMock.mockImplementation(async (variables: Record<string, unknown>) => ({
      fetchChapters: {
        chapters: chaptersByMangaId.get(Number(variables.mangaId)) ?? [],
      },
    }));

    invokeMock.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
      switch (command) {
        case "begin_suwayomi_runtime_operation":
          return "migration-lease";
        case "end_suwayomi_runtime_operation":
          return true;
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
      if (query.includes("query GetManga(")) {
        return { manga: mangaById.get(Number(variables.id)) };
      }

      if (query.includes("query GetChapters(")) {
        return {
          chapters: {
            nodes: chaptersByMangaId.get(Number(variables.mangaId)) ?? [],
          },
        };
      }

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

      if (query.includes("query GetMangaTrackRecords")) {
        return {
          manga: {
            trackRecords: {
              nodes: trackerRecordsByMangaId.get(Number(variables.mangaId)) ?? [],
            },
          },
        };
      }

      if (query.includes("mutation BindTrack")) {
        const mangaId = Number(variables.mangaId);
        const record = {
          id: nextTrackerRecordId++,
          trackerId: Number(variables.trackerId),
          remoteId: String(variables.remoteId),
        };
        trackerRecordsByMangaId.set(mangaId, [
          ...(trackerRecordsByMangaId.get(mangaId) ?? []),
          record,
        ]);
        return { bindTrack: { trackRecord: record } };
      }

      if (query.includes("mutation UnbindTrack")) {
        const recordId = Number(variables.recordId);
        for (const [mangaId, records] of trackerRecordsByMangaId) {
          trackerRecordsByMangaId.set(
            mangaId,
            records.filter((record) => record.id !== recordId),
          );
        }
        return { unbindTrack: { trackRecord: { id: recordId } } };
      }

      if (query.includes("mutation UpdateMangaCategories")) {
        journalStatusAtFirstMutation ??= journalStateJson
          ? JSON.parse(journalStateJson).operations[0]?.status ?? null
          : null;
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
        journalStatusAtFirstMutation ??= journalStateJson
          ? JSON.parse(journalStateJson).operations[0]?.status ?? null
          : null;
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
        journalStatusAtFirstMutation ??= journalStateJson
          ? JSON.parse(journalStateJson).operations[0]?.status ?? null
          : null;
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
    trackerRecordsByMangaId.set(10, [{ id: 70, trackerId: 1, remoteId: "remote-alpha" }]);
    const identity = createMemoryIdentityBridge({
      mangaLinks: { 10: [30], 30: [10] },
      novelLinks: {},
      booksCategoryAssignments: {},
    });
    const result = await applyMangaMigrationWithJournal({
      currentManga: mangaById.get(10)!,
      currentChapters: chaptersByMangaId.get(10)!,
      targetSourceId: "source-new",
      match: {
        manga: mangaById.get(20)!,
        chapters: chaptersByMangaId.get(20)!,
        similarity: 1,
      },
      identityBridge: identity.bridge,
    });

    expect(mangaById.get(10)?.inLibrary).toBe(false);
    expect(mangaById.get(20)?.inLibrary).toBe(true);
    expect(categoryMembership.get(1)).toContain(20);
    expect(categoryMembership.get(2)).toContain(20);
    expect(categoryMembership.get(1)).not.toContain(10);
    expect(categoryMembership.get(2)).not.toContain(10);
    expect(trackerRecordsByMangaId.get(10)).toEqual([]);
    expect(trackerRecordsByMangaId.get(20)).toEqual([
      expect.objectContaining({ trackerId: 1, remoteId: "remote-alpha" }),
    ]);
    expect(identity.read().mangaLinks[10]).toBeUndefined();
    expect(identity.read().mangaLinks[20]).toContain(30);
    expect(identity.read().mangaLinks[30]).toContain(20);
    expect(journalStatusAtFirstMutation).toBe("applying");
    expect(chaptersByMangaId.get(20)?.[0]?.isRead).toBe(false);
    expect(chaptersByMangaId.get(20)?.[0]?.isBookmarked).toBe(true);
    expect(chaptersByMangaId.get(20)?.[0]?.lastPageRead).toBe(7);
    expect(chaptersByMangaId.get(20)?.[1]?.isRead).toBe(true);

    await undoMangaMigration(result.journalEntryId, identity.bridge);

    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
    expect(categoryMembership.get(1)).toContain(10);
    expect(categoryMembership.get(2)).toContain(10);
    expect(categoryMembership.get(3)).toContain(20);
    expect(trackerRecordsByMangaId.get(10)).toEqual([
      expect.objectContaining({ trackerId: 1, remoteId: "remote-alpha" }),
    ]);
    expect(trackerRecordsByMangaId.get(20)).toEqual([]);
    expect(identity.read().mangaLinks).toEqual({ 10: [30], 30: [10] });
  });

  it("never reduces chapter state already present on the target", async () => {
    const targetChapter = chaptersByMangaId.get(20)![0]!;
    targetChapter.isRead = true;
    targetChapter.lastPageRead = 9;

    await applyMangaMigrationWithJournal({
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

    expect(targetChapter.isRead).toBe(true);
    expect(targetChapter.isBookmarked).toBe(true);
    expect(targetChapter.lastPageRead).toBe(9);
  });

  it("blocks conflicting tracker identities before changing library state", async () => {
    trackerRecordsByMangaId.set(10, [{ id: 70, trackerId: 1, remoteId: "source-edition" }]);
    trackerRecordsByMangaId.set(20, [{ id: 71, trackerId: 1, remoteId: "target-edition" }]);

    await expect(applyMangaMigrationWithJournal({
      currentManga: mangaById.get(10)!,
      currentChapters: chaptersByMangaId.get(10)!,
      targetSourceId: "source-new",
      match: {
        manga: mangaById.get(20)!,
        chapters: chaptersByMangaId.get(20)!,
        similarity: 1,
      },
    })).rejects.toMatchObject({ code: "TARGET_TRACKER_CONFLICT" });

    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
    expect(journalStateJson).toBeNull();
  });

  it("transfers partial progress proportionally when page counts differ", async () => {
    const sourceChapter = chaptersByMangaId.get(10)![0]!;
    const targetChapter = chaptersByMangaId.get(20)![0]!;
    sourceChapter.pageCount = 20;
    sourceChapter.lastPageRead = 10;
    targetChapter.pageCount = 10;
    targetChapter.lastPageRead = 2;

    await applyMangaMigrationWithJournal({
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

    expect(targetChapter.lastPageRead).toBe(5);
  });

  it("can copy a single manga migration without removing the source title", async () => {
    chaptersByMangaId.get(10)![0]!.isDownloaded = true;
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
    const committed = JSON.parse(String(journalStateJson)).operations.find(
      (operation: { operationId: string }) => operation.operationId === result.journalEntryId,
    );
    expect(committed.snapshots.payload.offlineAssets).toEqual([
      expect.objectContaining({
        kind: "manga",
        status: "pending",
        sourcePreserved: true,
        source: expect.objectContaining({ chapterId: "101" }),
        target: expect.objectContaining({ chapterId: "201" }),
      }),
    ]);

    await undoMangaMigration(result.journalEntryId);

    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
    expect(categoryMembership.get(1)).toContain(10);
    expect(categoryMembership.get(2)).toContain(10);
  });

  it("previews and applies a mass manga migration for selected matched items", async () => {
    const identity = createMemoryIdentityBridge({
      mangaLinks: { 10: [30], 30: [10] },
      novelLinks: {},
      booksCategoryAssignments: {},
    });
    const writeIdentity = identity.bridge.write.bind(identity.bridge);
    identity.bridge.write = async (input) => {
      const journalAtWrite = JSON.parse(String(journalStateJson));
      const parent = journalAtWrite.operations.find((operation: any) => (
        operation.mode === "mass"
      ));
      expect(
        parent.snapshots.payload.items[0].oldState.localIdentity,
      ).toBeDefined();
      return writeIdentity(input);
    };
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

    const applied = await applyMassMangaMigrationWithJournal({
      preview,
      identityBridge: identity.bridge,
    });

    expect(applied.migratedCount).toBe(2);
    expect(applied.skippedCount).toBe(1);
    expect(mangaById.get(10)?.inLibrary).toBe(false);
    expect(mangaById.get(20)?.inLibrary).toBe(true);
    expect(mangaById.get(11)?.inLibrary).toBe(false);
    expect(mangaById.get(21)?.inLibrary).toBe(true);

    const journalState = JSON.parse(String(journalStateJson));
    expect(journalState.version).toBe(2);
    const parent = journalState.operations.find((operation: any) => operation.mode === "mass");
    expect(parent.status).toBe("committed");
    expect(parent.childOperationIds).toHaveLength(2);
    expect(parent.snapshots.payload.items).toHaveLength(2);

    expect(applied.journalEntryId).not.toBeNull();
    await undoMangaMigration(applied.journalEntryId!, identity.bridge);

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

  it("keeps a found title when its chapter list fails, and loads it again before applying", async () => {
    let failChapters = true;
    fetchSourceMangaChaptersMock.mockImplementation(async (variables: Record<string, unknown>) => {
      if (failChapters) throw new Error("Open in WebView to solve the captcha");
      return { fetchChapters: { chapters: chaptersByMangaId.get(Number(variables.mangaId)) ?? [] } };
    });

    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      items: [{ manga: mangaById.get(10)!, chapters: chaptersByMangaId.get(10)! }],
    });

    expect(preview.items[0].status).toBe("matched");
    expect(preview.items[0].match?.manga.id).toBe(20);
    expect(preview.items[0].match?.chapters).toEqual([]);
    expect(preview.items[0].match?.chaptersError).toContain("captcha");
    expect(preview.items[0].chapterDiff).toBe(0);

    failChapters = false;
    const applied = await applyMassMangaMigrationWithJournal({ preview });

    expect(applied.migratedCount).toBe(1);
    expect(chaptersByMangaId.get(20)?.find((chapter) => chapter.id === 202)?.isRead).toBe(true);
  });

  it("leaves a title with read progress unmigrated when the new source has no chapters", async () => {
    fetchSourceMangaChaptersMock.mockRejectedValue(new Error("Open in WebView to solve the captcha"));

    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      items: [{ manga: mangaById.get(10)!, chapters: chaptersByMangaId.get(10)! }],
    });
    const applied = await applyMassMangaMigrationWithJournal({ preview });

    expect(applied.migratedCount).toBe(0);
    expect(applied.failedItems).toHaveLength(1);
    expect(applied.failedItems[0]?.message).toContain("Alpha Hero was kept in its current source");
    expect(applied.failedItems[0]?.message).toContain("captcha");
    expect(mangaById.get(10)?.inLibrary).toBe(true);
    expect(mangaById.get(20)?.inLibrary).toBe(false);
  });

  it("does not offer an unrelated search result as a match", async () => {
    searchSourceMangaMock.mockImplementation(async () => ({
      fetchSourceManga: { mangas: [createManga(30, "After Rebirth, I Married My Scumbag Ex's Arch-Enemy", "source-new", false)], hasNextPage: false },
    }));

    const preview = await previewMassMangaMigration({
      sourceFrom: "source-old",
      sourceTo: "source-new",
      items: [{
        manga: createManga(14, "After Rebirth, I Used Mirror Reversal For Vengeance", "source-old"),
        chapters: [],
      }],
    });

    expect(preview.items[0].status).toBe("no_match");
    expect(fetchSourceMangaChaptersMock).not.toHaveBeenCalled();
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
    const parent = journalState.operations.find((operation: any) => operation.mode === "mass");
    expect(parent.snapshots.payload.items).toHaveLength(1);
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
    const journalState = JSON.parse(String(journalStateJson));
    const parent = journalState.operations.find((operation: any) => operation.mode === "mass");
    expect(parent.status).toBe("compensated");
    expect(parent.steps[0].status).toBe("skipped");
  });
});
