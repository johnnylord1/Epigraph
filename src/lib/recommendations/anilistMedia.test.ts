import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aniListAlternativeTitles,
  aniListSearchQuery,
  aniListTitleMatchKey,
  cachedAniListTitleMatch,
  fetchAniListMediaProfiles,
  matchAniListTitles,
  pendingAniListTitleCount,
  pickAniListTitleMatch,
  resetAniListMediaCacheForTests,
  withAniListGenres,
  type AniListMediaProfile,
} from "./anilistMedia";
import { mangaToRecommendationCandidate, mangaToTasteProfileSeed } from "./adapters";
import { aniListLibraryLookupEntries } from "./anilistLibraryLookup";
import type { Manga } from "../types";

function profile(id: number, titles: string[], overrides: Partial<AniListMediaProfile> = {}): AniListMediaProfile {
  return { id, idMal: null, country: "KR", format: "MANGA", genres: ["Action"], titles, ...overrides };
}

function media(id: number, romaji: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    idMal: id + 1000,
    countryOfOrigin: "KR",
    format: "MANGA",
    genres: ["Action", "Fantasy"],
    synonyms: [],
    title: { romaji, english: null, native: null },
    ...overrides,
  };
}

type SearchVariables = Record<string, string>;

describe("AniList media profiles", () => {
  afterEach(() => {
    resetAniListMediaCacheForTests();
    try {
      globalThis.localStorage?.clear();
    } catch {
      // No storage in this environment.
    }
  });

  it("keys titles without the labels sources append", () => {
    expect(aniListTitleMatchKey("Solo Leveling [Official]")).toBe("solo leveling");
    expect(aniListTitleMatchKey("Tower of God (Webtoon)")).toBe("tower of god");
    expect(aniListTitleMatchKey("The Breaker - Manhwa")).toBe("breaker");
    expect(aniListTitleMatchKey("[Official]")).toBe("official");
    expect(aniListTitleMatchKey("Goshujin-sama to Yuku Isekai Survival! THE COMIC")).toBe("goshujin sama to yuku isekai survival");
    expect(aniListTitleMatchKey("Ore no Imouto R-18")).toBe("ore no imouto");
  });

  it("searches AniList with plain punctuation and without source labels", () => {
    expect(aniListSearchQuery("Aristocrat’s Revenge")).toBe("Aristocrat's Revenge");
    expect(aniListSearchQuery("Undead Unluck (Official Colored)")).toBe("Undead Unluck");
    expect(aniListSearchQuery("Ore no Koto ga Daikirai na Imouto ga Kowai [R18]")).toBe("Ore no Koto ga Daikirai na Imouto ga Kowai");
    expect(aniListSearchQuery("Sword\u200b Master — Return")).toBe("Sword Master Return");
    expect(aniListSearchQuery("[Official]")).toBe("[Official]");
  });

  it("tells works sharing a name apart by the library's format and genres", () => {
    const japanese = profile(11, ["Leviathan"], { country: "JP", genres: ["Sci-Fi", "Horror"] });
    const korean = profile(12, ["Leviathan"], { country: "KR", genres: ["Action", "Fantasy"] });
    const otherKorean = profile(13, ["Leviathan"], { country: "KR", genres: ["Romance", "Drama"] });

    expect(pickAniListTitleMatch("Leviathan", [japanese, korean])).toBeNull();
    expect(pickAniListTitleMatch("Leviathan", [japanese, korean], { country: "KR" })?.id).toBe(12);
    expect(pickAniListTitleMatch("Leviathan", [japanese, korean, otherKorean], { country: "KR", genres: ["action", "Fantasy"] })?.id).toBe(12);
    // One shared genre is not enough to choose.
    expect(pickAniListTitleMatch("Leviathan", [korean, otherKorean], { genres: ["Action", "Romance"] })).toBeNull();
  });

  it("looks up again titles that older matching rules missed", () => {
    const stored = new Map<string, string>([["epigraph.recommendations.anilistTitleMatch.v1", JSON.stringify({
      "aristocrat s revenge": { id: 0, at: 1_000 },
      "lookism": { id: 0, at: 1_000, v: 2 },
    })]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      clear: () => stored.clear(),
    });
    try {
      resetAniListMediaCacheForTests();
      expect(pendingAniListTitleCount(["Aristocrat’s Revenge", "Lookism"], 2_000)).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists library works without an AniList entry, sparsest first, with their format", () => {
    const works = [
      { id: 1, title: "Tracked Work", genre: ["Action"] },
      { id: 2, title: "Rich Work", genre: ["Action", "Fantasy", "Drama"] },
      { id: 3, title: "Bare Work", genre: [""], source: { id: "9", name: "Asura Scans", displayName: "Asura Scans" } },
      { id: 4, title: "  ", genre: [] },
    ] as unknown as Manga[];

    const entries = aniListLibraryLookupEntries(works, new Set([1]));

    expect(entries.map((entry) => entry.key)).toEqual(["3", "2"]);
    expect(entries[0].genres).toEqual([]);
    expect(entries[1].genres).toEqual(["Action", "Fantasy", "Drama"]);
  });

  it("matches a title through any of the work's names", () => {
    const solo = profile(1, ["Na Honjaman Level Up", "Solo Leveling", "나 혼자만 레벨업", "Only I Level Up"]);
    const other = profile(2, ["Solo Leveling: Ragnarok"]);

    expect(pickAniListTitleMatch("Only I Level Up", [other, solo])?.id).toBe(1);
    expect(pickAniListTitleMatch("Solo Leveling [Official]", [other, solo])?.id).toBe(1);
  });

  it("never takes a sequel, a novel or an ambiguous result for the work", () => {
    const sequel = profile(2, ["Solo Leveling: Ragnarok"]);
    const novel = profile(3, ["Omniscient Reader"], { format: "NOVEL" });
    const twinA = profile(4, ["Berserker"]);
    const twinB = profile(5, ["Berserker"]);

    expect(pickAniListTitleMatch("Solo Leveling", [sequel])).toBeNull();
    expect(pickAniListTitleMatch("Omniscient Reader", [novel])).toBeNull();
    expect(pickAniListTitleMatch("Berserker", [twinA, twinB])).toBeNull();
  });

  it("prefers the series over a one-shot pilot of the same name", () => {
    const pilot = profile(6, ["Chainsaw Man"], { format: "ONE_SHOT" });
    const series = profile(7, ["Chainsaw Man"]);

    expect(pickAniListTitleMatch("Chainsaw Man", [pilot, series])?.id).toBe(7);
  });

  it("accepts only near-identical spellings without an exact title", () => {
    const work = profile(8, ["The Beginning After The End"]);

    expect(pickAniListTitleMatch("Beginning After the Ends", [work])?.id).toBe(8);
    expect(pickAniListTitleMatch("Beginning of the End", [work])).toBeNull();
  });

  it("fetches genres, titles and country for tracker ids once", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: number[] } };
      return new Response(JSON.stringify({
        data: { Page: { media: variables.ids.filter((id) => id !== 3).map((id) => media(id, `Work ${id}`, { synonyms: [`Alias ${id}`] })) } },
      }), { status: 200 });
    });

    const first = await fetchAniListMediaProfiles([1, 3], { fetchImpl: fetchImpl as unknown as typeof fetch });
    const second = await fetchAniListMediaProfiles([1, 3], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.get(1)).toEqual({
      id: 1,
      idMal: 1001,
      country: "KR",
      format: "MANGA",
      genres: ["Action", "Fantasy"],
      titles: ["Work 1", "Alias 1"],
    });
    expect(first.get(3)).toBeNull();
    expect(second).toEqual(first);
  });

  it("looks up library titles in shared requests and remembers hits and misses", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: SearchVariables };
      const data: Record<string, unknown> = {};
      for (const [name, title] of Object.entries(variables)) {
        const index = name.slice(1);
        data[`r${index}`] = { media: title === "Unknown Work" ? [] : [media(Number(index) + 10, title)] };
      }
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const entries = [
      { key: "1", title: "Lookism" },
      { key: "2", title: "Unknown Work" },
      { key: "3", title: "Lookism" },
    ];

    const matches = await matchAniListTitles(entries, { fetchImpl: fetchImpl as unknown as typeof fetch, nowMs: 1_000 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(matches.get("1")?.id).toBe(10);
    expect(matches.get("3")?.id).toBe(10);
    expect(matches.has("2")).toBe(false);
    expect(cachedAniListTitleMatch("Lookism")?.genres).toEqual(["Action", "Fantasy"]);
    expect(pendingAniListTitleCount(entries.map((entry) => entry.title), 2_000)).toBe(0);

    const cachedOnly = await matchAniListTitles(entries, { fetchImpl: fetchImpl as unknown as typeof fetch, cachedOnly: true });
    expect(cachedOnly.get("1")?.id).toBe(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A miss is looked up again once AniList has had time to add the work.
    expect(pendingAniListTitleCount(["Unknown Work"], 1_000 + 15 * 24 * 60 * 60 * 1000)).toBe(1);
  });

  it("caps title lookups per call and stops on a rate limit", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    const entries = Array.from({ length: 35 }, (_, index) => ({ key: String(index), title: `Work number ${index}` }));

    const matches = await matchAniListTitles(entries, { fetchImpl: fetchImpl as unknown as typeof fetch, maxRequests: 3 });

    expect(matches.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(pendingAniListTitleCount(entries.map((entry) => entry.title))).toBe(35);
  });

  it("adds AniList genres once and lists the work's other names", () => {
    const work = profile(9, ["Na Honjaman Level Up", "Solo Leveling", "나 혼자만 레벨업"], { genres: ["Action", "Fantasy"] });

    expect(withAniListGenres(["action", "Dungeons"], work)).toEqual(["action", "Dungeons", "Fantasy"]);
    expect(withAniListGenres(["Romance"], null)).toEqual(["Romance"]);
    // Native script titles have no Latin key to match on, so they are left out.
    expect(aniListAlternativeTitles("Solo Leveling", work)).toEqual(["Na Honjaman Level Up"]);
  });

  it("lets a library work with no source genres shape the profile", () => {
    const manga = {
      id: 42,
      title: "Lookism",
      genre: [""],
      inLibrary: true,
      source: { id: "7", name: "Mangakakalot", displayName: "Mangakakalot" },
    } as unknown as Manga;
    const aniListByMangaId = new Map([[42, profile(10, ["Lookism", "Oegmojisangjuui"], { genres: ["Action", "Drama"], country: "KR" })]]);

    const seed = mangaToTasteProfileSeed(manga, { aniListByMangaId });
    const candidate = mangaToRecommendationCandidate(manga, { aniListByMangaId });

    expect(seed.tags).toEqual(["Action", "Drama"]);
    expect(seed.contentType).toBe("manhwa");
    expect(candidate.alternativeTitles).toEqual(["Oegmojisangjuui"]);
    expect(candidate.contentType).toBe("manhwa");
  });
});
