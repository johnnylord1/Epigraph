import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manga } from "../types";

type Entry = { key: string; title: string };

function fakeProvider(id: string, batchSize: number, knows: (title: string) => boolean) {
  const answered = new Map<string, "matched" | "missed">();
  const provider = {
    id,
    batchSize,
    intervalMs: 1_000,
    failing: false,
    answered,
    status: (entry: Entry) => answered.get(entry.title) ?? "pending",
    lookUp: vi.fn(async (entries: Entry[]) => {
      if (provider.failing) return { ok: false as const };
      for (const entry of entries) answered.set(entry.title, knows(entry.title) ? "matched" : "missed");
      return { ok: true as const };
    }),
  };
  return provider;
}

const aniList = fakeProvider("anilist", 20, (title) => title.startsWith("Work"));
const kitsu = fakeProvider("kitsu", 1, (title) => title.startsWith("Kitsu"));

vi.mock("./titleProviders", () => ({ titleProviderChain: () => [aniList, kitsu] }));
vi.mock("../startupClient", () => ({
  gql: async () => ({ trackers: { nodes: [{ id: 2, name: "AniList", isLoggedIn: true, trackRecords: { nodes: [{ manga: { id: 9 } }] } }] } }),
}));

const {
  ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS,
  ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS,
  resumeLibraryAniListLookup,
  stopAniListLibraryLookup,
  syncLibraryAniListLookup,
} = await import("./anilistLibraryLookup");

const work = (id: number, title = `Work ${id}`) => ({ id, title, genre: [] }) as unknown as Manga;
const asked = (provider: typeof aniList) => provider.lookUp.mock.calls.flatMap(([entries]) => entries.map((entry) => entry.title));

describe("background lookup of the library", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const provider of [aniList, kitsu]) {
      provider.answered.clear();
      provider.lookUp.mockClear();
      provider.failing = false;
    }
  });

  afterEach(() => {
    stopAniListLibraryLookup();
    vi.useRealTimers();
  });

  it("looks every work up once, asking the next provider only about the works the first does not know", async () => {
    const progress = vi.fn();
    syncLibraryAniListLookup([work(1), work(2), work(3, "Kitsu Only"), work(4, "Missing Work"), work(9)], progress);

    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS + 10_000);
    // Work 9 has an AniList tracker entry already; the four others share one AniList request.
    expect(aniList.lookUp).toHaveBeenCalledTimes(1);
    expect(asked(aniList)).toEqual(["Work 1", "Work 2", "Kitsu Only", "Missing Work"]);
    expect(asked(kitsu)).toEqual(["Kitsu Only", "Missing Work"]);
    expect(progress).toHaveBeenNthCalledWith(1, { phase: "running", total: 4, remaining: 4, matched: 0, missed: 0 });
    expect(progress).toHaveBeenLastCalledWith({ phase: "done", total: 4, remaining: 0, matched: 3, missed: 1 });

    aniList.lookUp.mockClear();
    kitsu.lookUp.mockClear();
    progress.mockClear();
    // A removed work is simply dropped; only the added one is looked up.
    syncLibraryAniListLookup([work(1), work(4, "Missing Work"), work(5), work(9)]);
    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS + 5_000);
    expect(asked(aniList)).toEqual(["Work 5"]);
    expect(kitsu.lookUp).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith({ phase: "done", total: 1, remaining: 0, matched: 1, missed: 0 });
  });

  it("stays quiet when every work was looked up in an earlier session", async () => {
    aniList.answered.set("Work 1", "matched");
    aniList.answered.set("Work 2", "missed");
    kitsu.answered.set("Work 2", "missed");
    const progress = vi.fn();
    syncLibraryAniListLookup([work(1), work(2)], progress);

    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS + 10_000);

    expect(aniList.lookUp).not.toHaveBeenCalled();
    expect(kitsu.lookUp).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it("moves on to the next provider when one stops answering, and asks it again later", async () => {
    aniList.failing = true;
    const progress = vi.fn();
    syncLibraryAniListLookup([work(1), work(2, "Kitsu Two")], progress);

    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS + 60_000);
    expect(aniList.lookUp).toHaveBeenCalledTimes(3);
    expect(asked(kitsu)).toEqual(["Work 1", "Kitsu Two"]);
    // Kitsu recognised one work; the other waits for AniList.
    expect(progress).toHaveBeenLastCalledWith({ phase: "paused", total: 2, remaining: 1, matched: 1, missed: 0 });

    aniList.failing = false;
    aniList.lookUp.mockClear();
    resumeLibraryAniListLookup();
    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS + 5_000);
    expect(asked(aniList)).toEqual(["Work 1"]);
    expect(progress).toHaveBeenLastCalledWith({ phase: "done", total: 1, remaining: 0, matched: 1, missed: 0 });
  });
});
