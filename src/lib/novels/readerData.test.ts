import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { disk, readChapter, cache } = vi.hoisted(() => ({
  disk: { state: null as any, writes: 0 },
  readChapter: vi.fn(),
  cache: { saved: [] as unknown[] },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: any) => {
    if (command === "read_novel_library_state") return JSON.stringify(disk.state);
    if (command === "write_novel_library_state") {
      disk.writes += 1;
      disk.state = JSON.parse(args.contents);
    }
    return null;
  }),
}));
vi.mock("./sources", () => ({ readInstalledNovelChapter: readChapter }));
vi.mock("./offlineChapters", () => ({
  loadCachedNovelChapter: async () => null,
  saveCachedNovelChapter: async (_scope: unknown, input: unknown) => { cache.saved.push(input); },
}));

import type { PersistedNovelLibraryState } from "./domain";
import { getNovelBookmarkEntries, getNovelProgressEntry, loadNovelLibraryState, resetNovelLibraryStateCacheForTests, saveNovelLibraryState } from "./libraryState";
import {
  applyNovelReaderChanges,
  loadNovelChapterContent,
  NOVEL_READER_CHANGES_SAVED_EVENT,
  readNovelReaderChanges,
  readNovelReaderTarget,
  relayNovelReaderChanges,
  saveNovelReaderChanges,
  setNovelReaderRelay,
  type NovelReaderChange,
} from "./readerData";

const SCOPE = { profileId: "test" };
const READER = { novelId: "novel", chapterId: "chapter-0", chapterPath: "/chapter-0", chapterTitle: "Chapter 1", sourceId: "fixture" };

function entry(id: string) {
  return {
    id, title: id, author: null, description: null, coverUrl: null, path: `/${id}`, status: "ONGOING", tags: [],
    source: { sourceId: "fixture", sourceName: "Fixture", pluginId: "fixture", pluginName: "Fixture", repositoryUrl: null },
    chapterCount: 2, addedAt: 1, updatedAt: 1,
  };
}

function library(): PersistedNovelLibraryState {
  return {
    version: 1, scopeKey: "profile:test", updatedAtMs: 1,
    entries: [entry("novel")] as any,
    chapters: [0, 1].map((index) => ({ id: `chapter-${index}`, novelId: "novel", path: `/chapter-${index}`, title: `Chapter ${index + 1}`, order: index, releaseTime: null, unread: true })),
    progress: [], bookmarks: [], history: [],
  };
}

const progress = (chapterProgress: number): NovelReaderChange => ({
  kind: "progress", novelId: "novel", chapterId: "chapter-0", chapterTitle: "Chapter 1", chapterProgress, completed: false, updatedAt: 10,
});
const bookmark = (bookmarked: boolean): NovelReaderChange => ({
  kind: "bookmark", novelId: "novel", chapterId: "chapter-0", chapterTitle: "Chapter 1", bookmarked,
});

describe("novel reader data", () => {
  beforeEach(() => {
    (globalThis as any).window = { __TAURI_INTERNALS__: {} };
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value); },
      removeItem: (key: string) => { memory.delete(key); },
    });
    resetNovelLibraryStateCacheForTests();
    disk.state = library();
    disk.writes = 0;
    cache.saved = [];
    readChapter.mockReset();
    setNovelReaderRelay(null);
  });
  afterEach(() => {
    setNovelReaderRelay(null);
    vi.unstubAllGlobals();
    delete (globalThis as any).window;
  });

  it("sets a bookmark to the requested state instead of flipping it", () => {
    const once = applyNovelReaderChanges(library(), [bookmark(true)]);
    expect(getNovelBookmarkEntries(once, "novel")).toHaveLength(1);
    // Another window already bookmarked the chapter; applying the same change keeps it.
    expect(getNovelBookmarkEntries(applyNovelReaderChanges(once, [bookmark(true)]), "novel")).toHaveLength(1);
    expect(getNovelBookmarkEntries(applyNovelReaderChanges(once, [bookmark(false)]), "novel")).toHaveLength(0);
  });

  it("applies a reader window's changes on top of what the main window saved meanwhile", async () => {
    const current = await loadNovelLibraryState(SCOPE);
    await saveNovelLibraryState({ ...current, entries: [...current.entries, entry("added-in-main") as any] }, SCOPE);
    const events: Event[] = [];
    vi.stubGlobal("dispatchEvent", (event: Event) => { events.push(event); return true; });

    await saveNovelReaderChanges(SCOPE, [progress(0.5), bookmark(true)]);

    // An open novel page in the main window learns that the library changed under it.
    expect(events.map((event) => [event.type, (event as CustomEvent).detail])).toEqual([[NOVEL_READER_CHANGES_SAVED_EVENT, { scopeKey: disk.state.scopeKey }]]);

    expect(disk.state.entries.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(["novel", "added-in-main"]));
    expect(getNovelProgressEntry(disk.state, "novel")?.progressPercent).toBeCloseTo(0.25, 5);
    expect(getNovelBookmarkEntries(disk.state, "novel")).toHaveLength(1);
  });

  it("a reader window hands its changes over and never writes the library itself", async () => {
    const saveChanges = vi.fn(async () => null);
    const loadChapter = vi.fn(async () => "<p>relayed</p>");
    setNovelReaderRelay({ saveChanges, loadChapter });
    const local = applyNovelReaderChanges(library(), [progress(0.5)]);

    await relayNovelReaderChanges([progress(0.5)], local, SCOPE);

    expect(saveChanges).toHaveBeenCalledWith(SCOPE, [progress(0.5)]);
    expect(disk.writes).toBe(0);
    // The next chapter starts from the window's own copy, not the file it read when it opened.
    expect(getNovelProgressEntry(await loadNovelLibraryState(SCOPE), "novel")?.progressPercent).toBeCloseTo(0.25, 5);
    expect(await loadNovelChapterContent(SCOPE, READER)).toBe("<p>relayed</p>");
    expect(readChapter).not.toHaveBeenCalled();
  });

  it("the main window reads a chapter from its source and caches it", async () => {
    readChapter.mockResolvedValue({ content: "<p>from source</p>" });
    expect(await loadNovelChapterContent(SCOPE, READER)).toBe("<p>from source</p>");
    expect(cache.saved).toEqual([expect.objectContaining({ sourceId: "fixture", chapterPath: "/chapter-0", content: "<p>from source</p>" })]);
  });

  it("refuses malformed requests from a reader window", () => {
    expect(() => readNovelReaderTarget({ ...READER, sourceId: 5 })).toThrow("NOVEL_READER_TARGET_INVALID");
    expect(() => readNovelReaderChanges([{ kind: "progress", novelId: "novel", chapterId: "chapter-0", chapterProgress: "x", updatedAt: 1 }])).toThrow("NOVEL_READER_CHANGES_INVALID");
    expect(() => readNovelReaderChanges([{ kind: "erase", novelId: "novel", chapterId: "chapter-0" }])).toThrow("NOVEL_READER_CHANGES_INVALID");
    expect(readNovelReaderChanges([{ ...progress(4), extra: true }])).toEqual([{ ...progress(1) }]);
  });
});
