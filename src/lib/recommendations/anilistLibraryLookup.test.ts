import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manga } from "../types";

const looked = new Set<string>();
const matchAniListTitles = vi.fn(async (entries: Array<{ key: string; title: string }>) => {
  const matches = new Map<string, { id: number }>();
  for (const entry of entries) {
    looked.add(entry.title);
    if (!entry.title.startsWith("Missing")) matches.set(entry.key, { id: Number(entry.key) });
  }
  return matches;
});

vi.mock("./anilistMedia", () => ({
  matchAniListTitles: (entries: Array<{ key: string; title: string }>) => matchAniListTitles(entries),
  isAniListTitlePending: (title: string) => !looked.has(title),
}));
vi.mock("../startupClient", () => ({
  gql: async () => ({ trackers: { nodes: [{ name: "AniList", trackRecords: { nodes: [{ manga: { id: 9 } }] } }] } }),
}));

const {
  ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS,
  ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS,
  stopAniListLibraryLookup,
  syncLibraryAniListLookup,
} = await import("./anilistLibraryLookup");

const work = (id: number, title = `Work ${id}`) => ({ id, title, genre: [] }) as unknown as Manga;
const lookedUpTitles = () => matchAniListTitles.mock.calls.flatMap(([entries]) => entries.map((entry) => entry.title));

describe("background AniList lookup of the library", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    looked.clear();
    matchAniListTitles.mockClear();
  });

  afterEach(() => {
    stopAniListLibraryLookup();
    vi.useRealTimers();
  });

  it("looks the library up once, then only the works added later", async () => {
    const progress = vi.fn();
    syncLibraryAniListLookup([work(1), work(2), work(3, "Missing Work"), work(9)], progress);

    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS);
    // Work 9 has an AniList tracker entry already.
    expect(lookedUpTitles()).toEqual(["Work 1", "Work 2", "Missing Work"]);
    expect(progress).toHaveBeenNthCalledWith(1, { phase: "running", total: 3, remaining: 3, matched: 0, missed: 0 });
    expect(progress).toHaveBeenLastCalledWith({ phase: "done", total: 3, remaining: 0, matched: 2, missed: 1 });

    matchAniListTitles.mockClear();
    progress.mockClear();
    // A removed work is simply dropped; only the added one is looked up.
    syncLibraryAniListLookup([work(1), work(3, "Missing Work"), work(4), work(9)]);
    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
    expect(lookedUpTitles()).toEqual(["Work 4"]);
    expect(progress).toHaveBeenLastCalledWith({ phase: "done", total: 1, remaining: 0, matched: 1, missed: 0 });

    matchAniListTitles.mockClear();
    syncLibraryAniListLookup([work(1), work(4), work(9)]);
    await vi.advanceTimersByTimeAsync(10 * ANILIST_LIBRARY_LOOKUP_CHANGE_DELAY_MS);
    expect(matchAniListTitles).not.toHaveBeenCalled();
  });

  it("stays quiet when every work was looked up in an earlier session", async () => {
    looked.add("Work 1");
    looked.add("Work 2");
    const progress = vi.fn();
    syncLibraryAniListLookup([work(1), work(2)], progress);

    await vi.advanceTimersByTimeAsync(ANILIST_LIBRARY_LOOKUP_FIRST_DELAY_MS);

    expect(matchAniListTitles).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});
