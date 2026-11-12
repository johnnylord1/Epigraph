import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { gqlMock, fetchChaptersMock } = vi.hoisted(() => ({
  gqlMock: vi.fn(),
  fetchChaptersMock: vi.fn(),
}));

vi.mock("../client", () => ({
  gql: gqlMock,
  getServerUrl: () => "http://127.0.0.1:4567",
  getServerAuthHeader: () => null,
}));
vi.mock("../serverLifecycle", () => ({ ensureServerAwakeFor: vi.fn(async () => true) }));
vi.mock("../suwayomiUpdateLock.svelte", () => ({
  withSuwayomiOperationLease: (_name: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../manga/runtime", () => ({ fetchSourceMangaChapters: fetchChaptersMock }));

import { beginLibraryUpdateSession, endLibraryUpdateSession, runSharedLibraryUpdate, stopSharedLibraryUpdate } from "./updateRuntime";
import { saveComicsChapterSnapshot } from "./comicsChapterSnapshot";
import { store } from "../../store/state.svelte";
import { applyAppLanguage } from "../i18n/runtime";

const PAUSE_MS = 800;

function manga(id: number, chapterCount = 1) {
  return {
    id,
    title: `Title ${id}`,
    inLibrary: true,
    sourceId: "1",
    source: { id: "1", name: "Source", displayName: "Source" },
    chapterCount,
    unreadCount: chapterCount,
    downloadCount: 0,
  };
}

function chapter(id: number) {
  return { id, name: `Chapter ${id}`, isRead: false, isDownloaded: false };
}

function chaptersOf(...ids: number[]) {
  return { fetchChapters: { chapters: ids.map(chapter) } };
}

function recordChapters(records: Record<number, number[]>) {
  saveComicsChapterSnapshot(
    { profileId: store.runtimeResolvedLocalProfileId, serverUrl: store.runtimeServerUrl },
    {
      mangas: Object.fromEntries(
        Object.entries(records).map(([mangaId, ids]) => [
          mangaId,
          { mangaId: Number(mangaId), chapters: ids.map((id) => ({ id })), updatedAt: 1 },
        ]),
      ),
    },
  );
}

function pausesIn(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([, delay]) => delay === PAUSE_MS).length;
}

describe("the library update queue", () => {
  const storage = new Map<string, string>();
  let stopSignal: AbortSignal;

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    applyAppLanguage("en");
    store.toasts = [];
    gqlMock.mockReset();
    gqlMock.mockResolvedValue({ categories: { nodes: [] } });
    fetchChaptersMock.mockReset();
    stopSignal = beginLibraryUpdateSession();
  });

  afterEach(() => {
    endLibraryUpdateSession(stopSignal);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves the library alone when nothing changed on any title", async () => {
    store.libraryMangaSnapshot = [manga(1), manga(2)] as never;
    recordChapters({ 1: [11], 2: [21] });
    fetchChaptersMock.mockImplementation(async ({ mangaId }: { mangaId: number }) => chaptersOf(mangaId * 10 + 1));
    const commit = vi.spyOn(store, "setLibraryMangaSnapshot");

    const run = await runSharedLibraryUpdate({ reason: "manual-library-update" });

    expect(fetchChaptersMock).toHaveBeenCalledTimes(2);
    expect(run.changedMangaIds).toEqual([]);
    expect(run.preloadedChapters.size).toBe(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps chapters only for titles with something to record", async () => {
    store.libraryMangaSnapshot = [manga(1), manga(2), manga(3), manga(4)] as never;
    // 1 gained a chapter, 2 has never been recorded, 3 swapped a chapter at the same count, 4 has nothing new.
    recordChapters({ 1: [11], 3: [31], 4: [41] });
    const lists: Record<number, number[]> = { 1: [11, 12], 2: [21], 3: [32], 4: [41] };
    fetchChaptersMock.mockImplementation(async ({ mangaId }: { mangaId: number }) => chaptersOf(...lists[mangaId]));

    const run = await runSharedLibraryUpdate({ reason: "manual-library-update" });

    expect(run.changedMangaIds).toEqual([1]);
    expect([...run.preloadedChapters.keys()].sort()).toEqual([1, 2, 3]);
    expect(store.libraryMangaSnapshot.find((entry) => entry.id === 1)?.chapterCount).toBe(2);
  });

  it("does not undo what sync did to the library during the update", async () => {
    store.libraryMangaSnapshot = [manga(1), manga(2), manga(3)] as never;
    recordChapters({ 1: [11], 2: [21], 3: [31] });
    fetchChaptersMock.mockImplementation(async ({ mangaId }: { mangaId: number }) => {
      if (mangaId === 1) {
        // Sync brings in a new work and removes another while the first title is being checked.
        store.libraryMangaSnapshot = [manga(1), manga(3), manga(99)] as never;
      }
      return mangaId === 3 ? chaptersOf(31, 32) : chaptersOf(mangaId * 10 + 1);
    });

    const run = await runSharedLibraryUpdate({ reason: "manual-library-update" });

    expect(store.libraryMangaSnapshot.map((entry) => entry.id)).toEqual([1, 3, 99]);
    expect(store.libraryMangaSnapshot.find((entry) => entry.id === 3)?.chapterCount).toBe(2);
    expect(run.changedMangaIds).toEqual([3]);
  });

  it("pauses between titles only on an automatic update", async () => {
    store.libraryMangaSnapshot = [manga(1), manga(2)] as never;
    fetchChaptersMock.mockResolvedValue(chaptersOf(1));
    const timers = vi.spyOn(globalThis, "setTimeout");

    await runSharedLibraryUpdate({ reason: "manual-library-update" });
    expect(pausesIn(timers)).toBe(0);

    await runSharedLibraryUpdate({ reason: "auto-library-update" });
    expect(pausesIn(timers)).toBe(1);
  });

  it("does not pause after Stop", async () => {
    store.libraryMangaSnapshot = [manga(1), manga(2)] as never;
    fetchChaptersMock.mockImplementation(async () => {
      await stopSharedLibraryUpdate();
      return chaptersOf(1);
    });
    const timers = vi.spyOn(globalThis, "setTimeout");

    const run = await runSharedLibraryUpdate({ reason: "auto-library-update" });

    expect(run.cancelled).toBe(true);
    expect(fetchChaptersMock).toHaveBeenCalledTimes(1);
    expect(pausesIn(timers)).toBe(0);
  });
});
