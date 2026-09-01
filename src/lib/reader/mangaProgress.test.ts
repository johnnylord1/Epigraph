import { describe, expect, it, vi } from "vitest";
import { createMangaProgressPersister, createMangaProgressJournal } from "./mangaProgress";

describe("manga reading progress persistence", () => {
  it("does not treat a cached reader seed as confirmation of an outstanding write", async () => {
    const saved: unknown[] = [];
    const persister = createMangaProgressPersister({ journal: { load: () => [], save: (value) => { saved.push(value); } }, write: async () => {} });
    persister.seed(7, 0, false);
    persister.record(7, 4, false);
    persister.seed(7, 4, false);
    persister.checkpoint();
    expect(saved.at(-1)).toEqual([{ chapterId: 7, lastPageRead: 4, isRead: false }]);
    await persister.flushAll();
  });

  it("incorporates a newer authoritative position returned by the writer", async () => {
    const persister = createMangaProgressPersister({ write: async (progress) => ({ ...progress, lastPageRead: 9, isRead: true }) });
    persister.record(7, 4, false);
    await persister.flushAll();
    expect(persister.peek(7)).toEqual({ chapterId: 7, lastPageRead: 9, isRead: true });
  });

  it("can checkpoint an offline close but reports failure if durable storage is unavailable", () => {
    const save = vi.fn();
    const persister = createMangaProgressPersister({ journal: { load: () => [], save }, write: async () => {} });
    persister.checkpoint();
    expect(save).toHaveBeenCalledWith([]);
    save.mockImplementation(() => { throw new Error("disk full"); });
    expect(() => persister.checkpoint()).toThrow("disk full");
  });

  it("retains failed offline updates across reader sessions and clears them only after success", async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const journal = createMangaProgressJournal("profile:test", storage);
    const offline = createMangaProgressPersister({ journal, write: async () => { throw new Error("offline"); } });
    offline.seed(7, 0, false);
    offline.record(7, 4, false);
    await expect(offline.flushAll()).rejects.toThrow("offline");
    expect(journal.load()).toEqual([{ chapterId: 7, lastPageRead: 4, isRead: false }]);
    const writes: unknown[] = [];
    const reopened = createMangaProgressPersister({ journal, write: async (progress) => { writes.push(progress); } });
    reopened.seed(7, 0, false);
    expect(reopened.peek(7)?.lastPageRead).toBe(4);
    await reopened.flushAll();
    expect(writes).toEqual([{ chapterId: 7, lastPageRead: 4, isRead: false }]);
    expect(journal.load()).toEqual([]);
    expect(createMangaProgressJournal("profile:other", storage).load()).toEqual([]);
  });

  it("does not regress pending progress when a later seed confirms a newer server position", async () => {
    const pending = [{ chapterId: 7, lastPageRead: 4, isRead: false }];
    const writes: unknown[] = [];
    const persister = createMangaProgressPersister({
      journal: { load: () => pending, save: () => {} },
      write: async (progress) => { writes.push(progress); },
    });
    persister.seed(7, 9, false);
    await persister.flushAll();
    expect(writes.every((entry: any) => entry.lastPageRead >= 9)).toBe(true);
    expect(persister.peek(7)?.lastPageRead).toBe(9);
  });

  it("debounces page updates and never moves a chapter backwards", async () => {
    vi.useFakeTimers();
    const writes: Array<{ chapterId: number; lastPageRead: number; isRead: boolean }> = [];
    const persister = createMangaProgressPersister({
      delayMs: 400,
      write: async (progress) => { writes.push(progress); },
    });

    persister.seed(7, 1, false);
    persister.record(7, 4, false);
    persister.record(7, 2, false);
    await vi.advanceTimersByTimeAsync(399);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual([{ chapterId: 7, lastPageRead: 4, isRead: false }]);

    persister.record(7, 3, false);
    await vi.advanceTimersByTimeAsync(400);
    expect(writes).toHaveLength(1);
    vi.useRealTimers();
  });

  it("flushes pending progress immediately when the reader closes", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const persister = createMangaProgressPersister({ delayMs: 500, write });

    persister.record(11, 6, false);
    await persister.flush(11);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ chapterId: 11, lastPageRead: 6, isRead: false });
    vi.useRealTimers();
  });

  it("persists completion once and ignores a repeated final-page event", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const persister = createMangaProgressPersister({ delayMs: 300, write });

    persister.record(19, 10, true);
    persister.record(19, 10, true);
    await persister.flush(19);
    persister.record(19, 10, true);
    await vi.advanceTimersByTimeAsync(300);

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({ chapterId: 19, lastPageRead: 10, isRead: true });
    vi.useRealTimers();
  });
});
