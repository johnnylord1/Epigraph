import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  appendMigrationJournalEntry,
  buildMigrationJournalEntry,
  getMigrationJournalEntry,
  getMigrationOperation,
  loadMigrationJournalState,
  markMigrationJournalEntryUndone,
  resetMigrationJournalStateCacheForTests,
  saveMigrationJournalState,
  updateMigrationOperation,
} from "./journalState";
import type { MangaMigrationUndoPayload } from "./types";

describe("migration journal state", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetMigrationJournalStateCacheForTests();
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
  });

  it("persists the migration journal to desktop storage", async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/aethon/migration/journal-state.json");

    const payload: MangaMigrationUndoPayload = {
      oldState: {
        mangaId: 1,
        inLibrary: true,
        title: "Old",
        categoryIds: [],
        chapters: [],
      },
      newState: {
        mangaId: 2,
        inLibrary: false,
        title: "New",
        categoryIds: [],
        chapters: [],
      },
    };
    const entry = buildMigrationJournalEntry({
      contentKind: "manga",
      sourceFrom: "1",
      sourceTo: "2",
      transferSummary: {
        oldItemTitle: "Old",
        newItemTitle: "New",
        oldSourceId: "1",
        newSourceId: "2",
        transferredChapterCount: 42,
        transferredReadCount: 10,
        transferredBookmarkCount: 2,
      },
      payload,
    });

    const saved = await appendMigrationJournalEntry(entry);

    expect(saved.version).toBe(2);
    expect(saved.operations[0]?.operationId).toBe(entry.id);
    expect(saved.operations[0]?.status).toBe("committed");
    expect(invokeMock).toHaveBeenCalledWith("write_migration_journal_state", expect.objectContaining({
      contents: expect.stringContaining(`"operationId": "${entry.id}"`),
      expectedSha256: null,
    }));
  });

  it("marks an applied journal entry as undone", async () => {
    const entry = buildMigrationJournalEntry({
      contentKind: "novel",
      sourceFrom: "archiveofourown",
      sourceTo: "royalroad",
      transferSummary: {
        oldItemTitle: "MANACLED",
        newItemTitle: "MANACLED",
        oldSourceId: "archiveofourown",
        newSourceId: "royalroad",
        transferredChapterCount: 3,
        transferredReadCount: 2,
        transferredBookmarkCount: 1,
      },
      payload: {
        oldState: {
          scopeKey: "profile:test",
          entry: null,
          chapters: [],
          progress: [],
          bookmarks: [],
          history: [],
        },
        newState: {
          scopeKey: "profile:test",
          entry: null,
          chapters: [],
          progress: [],
          bookmarks: [],
          history: [],
        },
      },
    });

    invokeMock
      .mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/aethon/migration/journal-state.json")
      .mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/aethon/migration/journal-state.json");

    await saveMigrationJournalState({
      version: 1,
      entries: [entry],
      updatedAtMs: Date.now(),
    });
    await markMigrationJournalEntryUndone(entry.id);

    const updated = await getMigrationJournalEntry(entry.id);
    expect(updated?.status).toBe("undone");
    expect(updated?.undoUntil).toBeNull();

    const persisted = JSON.parse(String(invokeMock.mock.calls.at(-1)?.[1]?.contents));
    expect(persisted.version).toBe(2);
    expect(persisted.operations[0].status).toBe("compensated");
  });

  it("loads an empty journal when no file exists yet", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const state = await loadMigrationJournalState();
    expect(state.operations).toHaveLength(0);
  });

  it("migrates a V1 journal without losing its undo payload", async () => {
    const legacyState = {
      version: 1,
      entries: [{
        id: "migration-v1",
        contentKind: "manga",
        mode: "single",
        sourceFrom: "1",
        sourceTo: "2",
        createdAt: 100,
        appliedAt: 101,
        undoUntil: Date.now() + 60_000,
        status: "applied",
        transferSummary: {
          oldItemTitle: "Old",
          newItemTitle: "New",
          oldSourceId: "1",
          newSourceId: "2",
          transferredChapterCount: 1,
          transferredReadCount: 1,
          transferredBookmarkCount: 0,
        },
        failureReason: null,
        payload: {
          oldState: { mangaId: 1, inLibrary: true, title: "Old", categoryIds: [], chapters: [] },
          newState: { mangaId: 2, inLibrary: true, title: "New", categoryIds: [], chapters: [] },
        },
      }],
      updatedAtMs: 101,
    };
    invokeMock.mockResolvedValueOnce(JSON.stringify(legacyState));

    const state = await loadMigrationJournalState();

    expect(state.version).toBe(2);
    expect(state.operations[0]).toMatchObject({
      operationId: "migration-v1",
      status: "committed",
      committedAt: 101,
    });
    expect(state.operations[0]?.snapshots.payload).toEqual(legacyState.entries[0].payload);
  });

  it("reconciles a child persisted before its parent link checkpoint", async () => {
    const oldState = {
      mangaId: 1,
      inLibrary: true,
      title: "Old",
      categoryIds: [],
      chapters: [],
    };
    const newState = {
      mangaId: 2,
      inLibrary: true,
      title: "New",
      categoryIds: [],
      chapters: [],
    };
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      version: 2,
      operations: [
        {
          operationId: "parent",
          mode: "mass",
          contentKind: "manga",
          childOperationIds: [],
          createdAt: 1,
          snapshots: { payload: { items: [{ oldState, newState }] } },
          steps: [],
        },
        {
          operationId: "child",
          parentOperationId: "parent",
          mode: "single",
          contentKind: "manga",
          createdAt: 2,
          snapshots: { payload: { oldState, newState } },
          steps: [],
        },
      ],
      updatedAtMs: 2,
    }));

    const state = await loadMigrationJournalState();
    const parent = state.operations.find((operation) => operation.operationId === "parent");

    expect(parent?.childOperationIds).toEqual(["child"]);
  });

  it("does not turn a corrupt desktop journal into an empty state", async () => {
    invokeMock.mockResolvedValueOnce("{not-json");

    await expect(loadMigrationJournalState()).rejects.toThrow();
  });

  it("rejects a stale operation revision before persisting a conflicting update", async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue("C:/Users/jhow-/AppData/Roaming/aethon/migration/journal-state.json");
    const entry = buildMigrationJournalEntry({
      contentKind: "manga",
      sourceFrom: "1",
      sourceTo: "2",
      transferSummary: {
        oldItemTitle: "Old",
        newItemTitle: "New",
        oldSourceId: "1",
        newSourceId: "2",
        transferredChapterCount: 1,
        transferredReadCount: 0,
        transferredBookmarkCount: 0,
      },
      payload: {
        oldState: { mangaId: 1, inLibrary: true, title: "Old", categoryIds: [], chapters: [] },
        newState: { mangaId: 2, inLibrary: true, title: "New", categoryIds: [], chapters: [] },
      },
    });
    await appendMigrationJournalEntry(entry);
    const operation = await getMigrationOperation(entry.id);
    expect(operation?.revision).toBe(1);

    await updateMigrationOperation(entry.id, { status: "verifying" }, 1);
    await expect(
      updateMigrationOperation(entry.id, { status: "committing" }, 1),
    ).rejects.toThrow("revision changed");
  });

  it("preserves malformed V2 evidence as a corrupt operation", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      version: 2,
      operations: [{
        schemaVersion: 2,
        operationId: "bad-step",
        profileId: "main",
        revision: 1,
        contentKind: "manga",
        mode: "single",
        sourceFrom: "1",
        sourceTo: "2",
        createdAt: 100,
        updatedAt: 100,
        status: "applying",
        steps: [{ stepId: "broken", kind: "unknown", status: "applied" }],
        snapshots: { payload: {} },
      }],
      updatedAtMs: 100,
    }));

    const state = await loadMigrationJournalState();

    expect(state.operations[0]?.status).toBe("corrupt");
    expect(state.operations[0]?.failureReason).toContain("invalid step");
  });
});
