import { describe, expect, it, vi } from "vitest";
const { gql } = vi.hoisted(() => ({ gql: vi.fn() }));
vi.mock("../client", () => ({ gql, getServerUrl: () => "http://test" }));
import { getMangaProgressForScope } from "./mangaProgressRuntime";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

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
