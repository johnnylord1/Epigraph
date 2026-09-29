import { describe, expect, it, vi } from "vitest";
const { gql } = vi.hoisted(() => ({ gql: vi.fn() }));
vi.mock("../client", () => ({ gql, getServerUrl: () => "http://test" }));
import { configureDetachedMangaProgress, flushAllMangaProgress, getMangaProgressForScope, resetMangaProgressRuntimeForTests } from "./mangaProgressRuntime";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

function listableStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
}

const MAIN_JOURNAL = "epigraph-manga-pending-progress:profile%3Aone";
const DETACHED_JOURNAL = `${MAIN_JOURNAL}~detached-reader-abc`;

describe("shared manga progress runtime", () => {
  it("shares the reader queue with backup export and merges newer server state before replay", async () => {
    gql.mockReset();
    gql.mockResolvedValue({ chapter: { id: 7, lastPageRead: 9, isRead: true } });
    const storage = memoryStorage();
    const reader = getMangaProgressForScope("profile:one", storage);
    reader.record(7, 4, false);
    const exporter = getMangaProgressForScope("profile:one", storage);
    expect(exporter).toBe(reader);
    await exporter.flushAll();
    expect(gql).toHaveBeenCalledTimes(1);
    expect(reader.peek(7)).toEqual({ chapterId: 7, lastPageRead: 9, isRead: true });
    expect(getMangaProgressForScope("profile:two", storage).peek(7)).toBeNull();
  });

  it("uses UPDATE_CHAPTERS_PROGRESS only after reading the authoritative chapter", async () => {
    gql.mockReset();
    gql.mockResolvedValueOnce({ chapter: { id: 7, lastPageRead: 2, isRead: false } });
    gql.mockResolvedValueOnce({ updateChapters: { chapters: [{ id: 7, lastPageRead: 4, isRead: false }] } });
    const reader = getMangaProgressForScope("profile:one", memoryStorage());
    reader.record(7, 4, false);
    await reader.flushAll();
    expect(gql.mock.calls[1][1]).toEqual({ ids: [7], lastPageRead: 4, isRead: false });
  });
});

describe("detached reader manga progress", () => {
  it("keeps a detached window's pending progress in its own journal and reports each save", async () => {
    resetMangaProgressRuntimeForTests();
    gql.mockReset();
    gql.mockResolvedValueOnce({ chapter: { id: 7, lastPageRead: 1, isRead: false } });
    gql.mockResolvedValueOnce({ updateChapters: { chapters: [] } });
    const saved = vi.fn();
    configureDetachedMangaProgress("detached-reader-abc", saved);
    const storage = listableStorage();
    storage.setItem(MAIN_JOURNAL, JSON.stringify([{ chapterId: 3, lastPageRead: 2, isRead: false }]));
    const reader = getMangaProgressForScope("profile:one", storage);
    reader.record(7, 5, false);
    expect(JSON.parse(storage.getItem(DETACHED_JOURNAL)!)).toEqual([{ chapterId: 7, lastPageRead: 5, isRead: false }]);
    expect(JSON.parse(storage.getItem(MAIN_JOURNAL)!)).toEqual([{ chapterId: 3, lastPageRead: 2, isRead: false }]);
    await flushAllMangaProgress();
    expect(saved).toHaveBeenCalledWith("profile:one", { chapterId: 7, lastPageRead: 5, isRead: false });
    expect(JSON.parse(storage.getItem(DETACHED_JOURNAL)!)).toEqual([]);
    resetMangaProgressRuntimeForTests();
  });

  it("lets the main window adopt a journal a closed detached window left behind", () => {
    resetMangaProgressRuntimeForTests();
    const storage = listableStorage();
    storage.setItem(MAIN_JOURNAL, JSON.stringify([{ chapterId: 7, lastPageRead: 2, isRead: false }]));
    storage.setItem(DETACHED_JOURNAL, JSON.stringify([
      { chapterId: 7, lastPageRead: 6, isRead: false },
      { chapterId: 8, lastPageRead: 1, isRead: true },
    ]));
    storage.setItem("epigraph-manga-pending-progress:profile%3Atwo~detached-reader-abc", JSON.stringify([{ chapterId: 9, lastPageRead: 4, isRead: false }]));
    const main = getMangaProgressForScope("profile:one", storage);
    expect(main.peek(7)).toEqual({ chapterId: 7, lastPageRead: 6, isRead: false });
    expect(main.peek(8)).toEqual({ chapterId: 8, lastPageRead: 1, isRead: true });
    expect(storage.getItem(DETACHED_JOURNAL)).toBeNull();
    expect(storage.getItem("epigraph-manga-pending-progress:profile%3Atwo~detached-reader-abc")).not.toBeNull();
  });

  it("leaves an unreadable detached journal in place instead of dropping it", () => {
    resetMangaProgressRuntimeForTests();
    const storage = listableStorage();
    storage.setItem(DETACHED_JOURNAL, "{not json");
    const main = getMangaProgressForScope("profile:one", storage);
    expect(main.peek(7)).toBeNull();
    expect(storage.getItem(DETACHED_JOURNAL)).toBe("{not json");
  });
});
