import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

const { searchInstalledNovelSourceMock, readInstalledNovelDetailsMock } = vi.hoisted(() => ({
  searchInstalledNovelSourceMock: vi.fn(),
  readInstalledNovelDetailsMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../novels/sources", () => ({
  searchInstalledNovelSource: searchInstalledNovelSourceMock,
  readInstalledNovelDetails: readInstalledNovelDetailsMock,
}));

import { resetMigrationJournalStateCacheForTests } from "./journalState";
import {
  applyMassNovelMigrationWithJournal,
  applyNovelMigrationWithJournal,
  previewMassNovelMigration,
  previewNovelMigration,
  undoNovelMigration,
} from "./novels";
import {
  createNovelChapterId,
  createNovelLibraryId,
  type NovelDetailRecord,
  type PersistedNovelLibraryState,
} from "../novels/domain";
import {
  loadNovelLibraryState,
  resetNovelLibraryStateCacheForTests,
  upsertNovelInLibrary,
} from "../novels/libraryState";
import {
  createEmptyHardcoverState,
  loadHardcoverState,
  saveHardcoverState,
} from "../novels/hardcover";
import {
  migrationIdentityRevision,
  type MigrationIdentityBridge,
  type MigrationIdentitySettings,
} from "./identity";

const SCOPE = { profileId: "test" } as const;
const OLD_ID = createNovelLibraryId("archiveofourown", "/works/1");
const NEW_ID = createNovelLibraryId("royalroad", "fiction/21220");

function createMemoryIdentityBridge(initial: MigrationIdentitySettings) {
  let settings = structuredClone(initial);
  const bridge: MigrationIdentityBridge = {
    profileId: "test",
    async read() {
      return {
        profileId: "test",
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

function createInitialState(): PersistedNovelLibraryState {
  return {
    version: 1,
    scopeKey: "profile:test",
    entries: [{
      id: OLD_ID,
      title: "MANACLED",
      author: "senlinyu",
      description: "Old description",
      coverUrl: null,
      path: "/works/1",
      status: "ONGOING",
      tags: ["drama"],
      source: {
        repositoryUrl: "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
        repositoryName: "Official",
        pluginId: "archiveofourown",
        pluginName: "Archive Of Our Own",
        pluginVersion: "1.0.0",
        sourceId: "archiveofourown",
        sourceName: "Archive Of Our Own",
        lang: "en",
      },
      chapterCount: 2,
      addedAt: 1,
      updatedAt: 1,
    }],
    chapters: [
      {
        id: createNovelChapterId(OLD_ID, "/works/1/chapters/1"),
        novelId: OLD_ID,
        path: "/works/1/chapters/1",
        title: "Chapter 1",
        order: 0,
        releaseTime: null,
        unread: false,
      },
      {
        id: createNovelChapterId(OLD_ID, "/works/1/chapters/2"),
        novelId: OLD_ID,
        path: "/works/1/chapters/2",
        title: "Chapter 2",
        order: 1,
        releaseTime: null,
        unread: true,
      },
    ],
    progress: [{
      novelId: OLD_ID,
      chapterId: createNovelChapterId(OLD_ID, "/works/1/chapters/1"),
      chapterTitle: "Chapter 1",
      progressPercent: 0.5,
      locator: createNovelChapterId(OLD_ID, "/works/1/chapters/1"),
      updatedAt: 10,
    }],
    bookmarks: [{
      novelId: OLD_ID,
      chapterId: createNovelChapterId(OLD_ID, "/works/1/chapters/1"),
      chapterTitle: "Chapter 1",
      locator: createNovelChapterId(OLD_ID, "/works/1/chapters/1"),
      label: "bookmark",
      savedAt: 11,
    }],
    history: [{
      novelId: OLD_ID,
      chapterId: createNovelChapterId(OLD_ID, "/works/1/chapters/1"),
      chapterTitle: "Chapter 1",
      locator: createNovelChapterId(OLD_ID, "/works/1/chapters/1"),
      readAt: 12,
    }],
    updatedAtMs: 12,
  };
}

function createTargetDetail(): NovelDetailRecord {
  return {
    id: NEW_ID,
    sourceId: "royalroad",
    title: "MANACLED",
    path: "fiction/21220",
    coverUrl: null,
    author: "senlinyu",
    description: "New description",
    status: "ONGOING",
    tags: ["drama"],
    chapterCount: 2,
    chapters: [
      {
        id: createNovelChapterId(NEW_ID, "fiction/21220/chapter/1"),
        novelId: NEW_ID,
        path: "fiction/21220/chapter/1",
        title: "Chapter 1",
        order: 0,
        releaseTime: null,
        unread: true,
      },
      {
        id: createNovelChapterId(NEW_ID, "fiction/21220/chapter/2"),
        novelId: NEW_ID,
        path: "fiction/21220/chapter/2",
        title: "Chapter 2",
        order: 1,
        releaseTime: null,
        unread: true,
      },
    ],
    source: {
      repositoryUrl: "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
      repositoryName: "Official",
      pluginId: "royalroad",
      pluginName: "Royal Road",
      pluginVersion: "2.3.0",
      sourceId: "royalroad",
      sourceName: "Royal Road",
      lang: "en",
    },
  };
}

describe("novel migration with journal", () => {
  let novelStateJson = "";
  let journalStateJson: string | null = null;

  beforeEach(() => {
    resetNovelLibraryStateCacheForTests();
    resetMigrationJournalStateCacheForTests();
    novelStateJson = JSON.stringify(createInitialState());
    journalStateJson = null;
    invokeMock.mockReset();
    searchInstalledNovelSourceMock.mockReset();
    readInstalledNovelDetailsMock.mockReset();

    const memoryStorage = (() => {
      const data = new Map<string, string>();
      return {
        getItem: vi.fn((key: string) => data.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          data.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          data.delete(key);
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
        case "read_novel_library_state":
          return novelStateJson;
        case "write_novel_library_state":
          novelStateJson = String(payload?.contents ?? "");
          return null;
        case "read_migration_journal_state":
          return journalStateJson;
        case "write_migration_journal_state":
          journalStateJson = String(payload?.contents ?? "");
          return null;
        default:
          throw new Error(`Unexpected invoke command: ${command}`);
      }
    });
  });

  it("previews, applies, and undoes a novel migration through authoritative state and journal", async () => {
    const identity = createMemoryIdentityBridge({
      mangaLinks: {},
      novelLinks: {
        [OLD_ID]: ["related"],
        related: [OLD_ID],
      },
      booksCategoryAssignments: {
        [OLD_ID]: ["favorites"],
        [NEW_ID]: ["reading"],
      },
    });
    saveHardcoverState({
      ...createEmptyHardcoverState(SCOPE),
      records: [
        {
          userBookId: 10,
          bookId: 20,
          title: "MANACLED",
          authors: ["senlinyu"],
          genres: [],
          tags: [],
          moods: [],
          coverUrl: null,
          status: "Reading",
          workStatus: "Ongoing",
          rating: 4,
          progress: 37,
          remoteUrl: null,
          updatedAt: 100,
          sourceNovelId: OLD_ID,
          sourceTitleKey: "manacled",
        },
        {
          userBookId: 11,
          bookId: 99,
          title: "Unrelated",
          authors: [],
          genres: [],
          tags: [],
          moods: [],
          coverUrl: null,
          status: "Read",
          workStatus: null,
          rating: null,
          progress: 100,
          remoteUrl: null,
          updatedAt: 101,
          sourceNovelId: "unrelated",
          sourceTitleKey: "unrelated",
        },
      ],
    }, SCOPE);
    const preview = await previewNovelMigration({
      scopeInput: SCOPE,
      currentNovelId: OLD_ID,
      targetDetail: createTargetDetail(),
    });

    expect(preview).toMatchObject({
      matchedChapterCount: 2,
      transferredReadCount: 1,
      transferredBookmarkCount: 1,
    });

    const applied = await applyNovelMigrationWithJournal({
      scopeInput: SCOPE,
      currentNovelId: OLD_ID,
      targetDetail: createTargetDetail(),
      identityBridge: identity.bridge,
    });

    expect(applied.journalEntryId).toMatch(/^migration-/);

    const migratedState = await loadNovelLibraryState(SCOPE);
    expect(migratedState.entries.find((entry) => entry.id === OLD_ID)).toBeUndefined();
    expect(migratedState.entries.find((entry) => entry.id === NEW_ID)?.title).toBe("MANACLED");
    expect(migratedState.chapters.filter((chapter) => chapter.novelId === NEW_ID).map((chapter) => chapter.unread)).toEqual([false, true]);
    expect(migratedState.progress[0]?.novelId).toBe(NEW_ID);
    expect(migratedState.bookmarks[0]?.novelId).toBe(NEW_ID);
    expect(migratedState.history[0]?.novelId).toBe(NEW_ID);
    expect(identity.read().novelLinks[OLD_ID]).toBeUndefined();
    expect(identity.read().novelLinks[NEW_ID]).toContain("related");
    expect(identity.read().booksCategoryAssignments[NEW_ID]).toEqual(["reading", "favorites"]);
    expect(loadHardcoverState(SCOPE).records.find((record) => (
      record.sourceNovelId === NEW_ID
    ))).toMatchObject({
      bookId: 20,
      sourceNovelId: NEW_ID,
      progress: 37,
    });
    expect(loadHardcoverState(SCOPE).records.find((record) => (
      record.sourceNovelId === "unrelated"
    ))).toMatchObject({ bookId: 99, progress: 100 });

    const journalState = JSON.parse(String(journalStateJson));
    expect(journalState.version).toBe(2);
    expect(journalState.operations).toHaveLength(1);
    expect(journalState.operations[0].contentKind).toBe("novel");
    expect(journalState.operations[0].status).toBe("committed");

    const restored = await undoNovelMigration({
      scopeInput: SCOPE,
      journalEntryId: applied.journalEntryId,
      identityBridge: identity.bridge,
    });

    expect(restored.entries.find((entry) => entry.id === OLD_ID)?.title).toBe("MANACLED");
    expect(restored.entries.find((entry) => entry.id === NEW_ID)).toBeUndefined();
    expect(restored.progress[0]?.novelId).toBe(OLD_ID);
    expect(restored.bookmarks[0]?.novelId).toBe(OLD_ID);
    expect(restored.history[0]?.novelId).toBe(OLD_ID);
    expect(identity.read().novelLinks[OLD_ID]).toEqual(["related"]);
    expect(identity.read().booksCategoryAssignments[OLD_ID]).toEqual(["favorites"]);
    expect(loadHardcoverState(SCOPE).records.find((record) => (
      record.sourceNovelId === OLD_ID
    ))).toMatchObject({
      bookId: 20,
      sourceNovelId: OLD_ID,
      progress: 37,
    });
    expect(loadHardcoverState(SCOPE).records.find((record) => (
      record.sourceNovelId === "unrelated"
    ))).toMatchObject({ bookId: 99, progress: 100 });

    const finalJournalState = JSON.parse(String(journalStateJson));
    expect(finalJournalState.operations[0].status).toBe("compensated");
  });

  it("merges matched chapter state without reducing an existing target position", async () => {
    const target = createTargetDetail();
    const state = upsertNovelInLibrary(createInitialState(), target);
    const targetChapterOne = state.chapters.find((chapter) => (
      chapter.novelId === NEW_ID && chapter.order === 0
    ))!;
    targetChapterOne.unread = false;
    state.progress.push({
      novelId: NEW_ID,
      chapterId: target.chapters[1]!.id,
      chapterTitle: target.chapters[1]!.title,
      progressPercent: 0.75,
      locator: target.chapters[1]!.id,
      updatedAt: 20,
    });
    novelStateJson = JSON.stringify(state);

    await applyNovelMigrationWithJournal({
      scopeInput: SCOPE,
      currentNovelId: OLD_ID,
      targetDetail: target,
    });

    const migrated = await loadNovelLibraryState(SCOPE);
    const targetChapters = migrated.chapters
      .filter((chapter) => chapter.novelId === NEW_ID)
      .sort((left, right) => left.order - right.order);
    expect(targetChapters.map((chapter) => chapter.unread)).toEqual([false, true]);
    expect(migrated.progress.find((entry) => entry.novelId === NEW_ID)).toMatchObject({
      chapterId: target.chapters[1]!.id,
      progressPercent: 0.75,
    });
  });

  it("blocks a different Hardcover edition before changing novel state", async () => {
    const baseRecord = {
      userBookId: 10,
      title: "MANACLED",
      authors: ["senlinyu"],
      genres: [],
      tags: [],
      moods: [],
      coverUrl: null,
      status: "Reading",
      workStatus: "Ongoing",
      rating: 4,
      progress: 37,
      remoteUrl: null,
      updatedAt: 100,
      sourceTitleKey: "manacled",
    };
    saveHardcoverState({
      ...createEmptyHardcoverState(SCOPE),
      records: [
        { ...baseRecord, bookId: 20, sourceNovelId: OLD_ID },
        { ...baseRecord, bookId: 21, sourceNovelId: NEW_ID },
      ],
    }, SCOPE);

    await expect(applyNovelMigrationWithJournal({
      scopeInput: SCOPE,
      currentNovelId: OLD_ID,
      targetDetail: createTargetDetail(),
    })).rejects.toThrow("different Hardcover editions");

    const state = await loadNovelLibraryState(SCOPE);
    expect(state.entries.some((entry) => entry.id === OLD_ID)).toBe(true);
    expect(state.entries.some((entry) => entry.id === NEW_ID)).toBe(false);
    expect(journalStateJson).toBeNull();
  });

  it("preserves unmatched chapter references without attaching them to the target", async () => {
    const state = createInitialState();
    const unmatchedChapterId = createNovelChapterId(OLD_ID, "/works/1/side-story");
    state.chapters.push({
      id: unmatchedChapterId,
      novelId: OLD_ID,
      path: "/works/1/side-story",
      title: "Side Story: Rain",
      order: 2,
      releaseTime: null,
      unread: false,
    });
    state.progress = [{
      novelId: OLD_ID,
      chapterId: unmatchedChapterId,
      chapterTitle: "Side Story: Rain",
      progressPercent: 0.8,
      locator: unmatchedChapterId,
      updatedAt: 30,
    }];
    state.bookmarks = [{
      novelId: OLD_ID,
      chapterId: unmatchedChapterId,
      chapterTitle: "Side Story: Rain",
      locator: unmatchedChapterId,
      label: "keep",
      savedAt: 31,
    }];
    state.history = [{
      novelId: OLD_ID,
      chapterId: unmatchedChapterId,
      chapterTitle: "Side Story: Rain",
      locator: unmatchedChapterId,
      readAt: 32,
    }];
    novelStateJson = JSON.stringify(state);
    const target = createTargetDetail();
    target.chapters.push({
      id: createNovelChapterId(NEW_ID, "fiction/21220/appendix"),
      novelId: NEW_ID,
      path: "fiction/21220/appendix",
      title: "Appendix",
      order: 2,
      releaseTime: null,
      unread: true,
    });
    target.chapterCount = target.chapters.length;

    await applyNovelMigrationWithJournal({
      scopeInput: SCOPE,
      currentNovelId: OLD_ID,
      targetDetail: target,
    });

    const migrated = await loadNovelLibraryState(SCOPE);
    expect(migrated.progress).toContainEqual(expect.objectContaining({
      novelId: OLD_ID,
      chapterId: unmatchedChapterId,
    }));
    expect(migrated.bookmarks).toContainEqual(expect.objectContaining({
      novelId: OLD_ID,
      chapterId: unmatchedChapterId,
    }));
    expect(migrated.history).toContainEqual(expect.objectContaining({
      novelId: OLD_ID,
      chapterId: unmatchedChapterId,
    }));
    expect(migrated.progress.some((entry) => (
      entry.novelId === NEW_ID && entry.chapterId === unmatchedChapterId
    ))).toBe(false);
  });

  it("previews, applies, and undoes mass novel migration for ready items only", async () => {
    const secondOldId = createNovelLibraryId("archiveofourown", "/works/2");
    const secondState = createInitialState();
    secondState.entries.push({
      ...secondState.entries[0],
      id: secondOldId,
      title: "Shadow Slave",
      path: "/works/2",
    });
    secondState.chapters.push(
      {
        id: createNovelChapterId(secondOldId, "/works/2/chapters/1"),
        novelId: secondOldId,
        path: "/works/2/chapters/1",
        title: "Chapter 1",
        order: 0,
        releaseTime: null,
        unread: false,
      },
      {
        id: createNovelChapterId(secondOldId, "/works/2/chapters/2"),
        novelId: secondOldId,
        path: "/works/2/chapters/2",
        title: "Chapter 2",
        order: 1,
        releaseTime: null,
        unread: true,
      },
    );
    secondState.progress = [
      secondState.progress[0],
      {
        ...secondState.progress[0],
        novelId: secondOldId,
        chapterId: createNovelChapterId(secondOldId, "/works/2/chapters/1"),
        locator: createNovelChapterId(secondOldId, "/works/2/chapters/1"),
      },
    ];
    novelStateJson = JSON.stringify(secondState);

    const secondNewId = createNovelLibraryId("royalroad", "fiction/30000");
    searchInstalledNovelSourceMock.mockImplementation(async (_scope, _sourceId, query: string) => {
      if (query === "MANACLED") {
        return [{ sourceId: "royalroad", title: "MANACLED", path: "fiction/21220", coverUrl: null }];
      }
      if (query === "Shadow Slave") {
        return [{ sourceId: "royalroad", title: "Shadow Slave", path: "fiction/30000", coverUrl: null }];
      }
      return [];
    });
    readInstalledNovelDetailsMock.mockImplementation(async (_scope, _sourceId, path: string) => {
      if (path === "fiction/21220") {
        return createTargetDetail();
      }
      return {
        ...createTargetDetail(),
        id: secondNewId,
        title: "Shadow Slave",
        path: "fiction/30000",
        chapters: [
          {
            id: createNovelChapterId(secondNewId, "fiction/30000/chapter/1"),
            novelId: secondNewId,
            path: "fiction/30000/chapter/1",
            title: "Chapter 1",
            order: 0,
            releaseTime: null,
            unread: true,
          },
          {
            id: createNovelChapterId(secondNewId, "fiction/30000/chapter/2"),
            novelId: secondNewId,
            path: "fiction/30000/chapter/2",
            title: "Chapter 2",
            order: 1,
            releaseTime: null,
            unread: true,
          },
        ],
      };
    });

    const preview = await previewMassNovelMigration({
      scopeInput: SCOPE,
      sourceFrom: "archiveofourown",
      sourceTo: "royalroad",
      novelIds: [OLD_ID, secondOldId],
    });

    expect(preview.readyCount).toBe(2);
    expect(preview.needsReviewCount).toBe(0);
    expect(preview.blockedCount).toBe(0);

    const applied = await applyMassNovelMigrationWithJournal({
      scopeInput: SCOPE,
      preview,
    });

    expect(applied.migratedCount).toBe(2);
    expect(applied.skippedCount).toBe(0);

    const migratedState = await loadNovelLibraryState(SCOPE);
    expect(migratedState.entries.find((entry) => entry.id === OLD_ID)).toBeUndefined();
    expect(migratedState.entries.find((entry) => entry.id === secondOldId)).toBeUndefined();
    expect(migratedState.entries.find((entry) => entry.id === NEW_ID)?.title).toBe("MANACLED");
    expect(migratedState.entries.find((entry) => entry.id === secondNewId)?.title).toBe("Shadow Slave");

    const journalState = JSON.parse(String(journalStateJson));
    const parentOperation = journalState.operations.find(
      (operation: { mode: string }) => operation.mode === "mass",
    );
    expect(parentOperation?.contentKind).toBe("novel");
    expect(parentOperation?.childOperationIds).toHaveLength(2);

    const restored = await undoNovelMigration({
      scopeInput: SCOPE,
      journalEntryId: applied.journalEntryId,
    });

    expect(restored.entries.find((entry) => entry.id === OLD_ID)?.title).toBe("MANACLED");
    expect(restored.entries.find((entry) => entry.id === secondOldId)?.title).toBe("Shadow Slave");
    expect(restored.entries.find((entry) => entry.id === NEW_ID)).toBeUndefined();
    expect(restored.entries.find((entry) => entry.id === secondNewId)).toBeUndefined();
    const finalJournalState = JSON.parse(String(journalStateJson));
    const compensatedParent = finalJournalState.operations.find(
      (operation: { operationId: string }) => operation.operationId === applied.journalEntryId,
    );
    expect(compensatedParent.status).toBe("compensated");
    expect(
      finalJournalState.operations
        .filter((operation: { parentOperationId: string | null }) => (
          operation.parentOperationId === applied.journalEntryId
        ))
        .map((operation: { status: string }) => operation.status),
    ).toEqual(["compensated", "compensated"]);
  });
});
