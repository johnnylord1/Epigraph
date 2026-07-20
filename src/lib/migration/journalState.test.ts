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
  loadMigrationJournalState,
  markMigrationJournalEntryUndone,
  resetMigrationJournalStateCacheForTests,
  saveMigrationJournalState,
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
    invokeMock.mockResolvedValueOnce("C:/Users/jhow-/AppData/Roaming/aethon/migration/journal-state.json");

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

    expect(saved.entries[0]?.id).toBe(entry.id);
    expect(invokeMock).toHaveBeenCalledWith("write_migration_journal_state", expect.objectContaining({
      contents: expect.stringContaining(`"id": "${entry.id}"`),
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
  });

  it("loads an empty journal when no file exists yet", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const state = await loadMigrationJournalState();
    expect(state.entries).toHaveLength(0);
  });
});
