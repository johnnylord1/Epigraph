import { afterEach, describe, expect, it, vi } from "vitest";
import {
  comicOriginForRecords,
  comicOriginKey,
  comicTypeFromCountry,
  fetchAniListCountries,
  resetComicOriginCacheForTests,
} from "./comicOrigin";

function aniListResponse(media: Array<{ id: number; countryOfOrigin: string | null }>) {
  return new Response(JSON.stringify({ data: { Page: { media } } }), { status: 200 });
}

describe("comic origin", () => {
  afterEach(() => {
    resetComicOriginCacheForTests();
    try {
      globalThis.localStorage?.clear();
    } catch {
      // No storage in this environment.
    }
  });

  it("maps countries of origin to comic formats", () => {
    expect(comicTypeFromCountry("KR")).toBe("manhwa");
    expect(comicTypeFromCountry("cn")).toBe("manhua");
    expect(comicTypeFromCountry("TW")).toBe("manhua");
    expect(comicTypeFromCountry("JP")).toBe("manga");
    expect(comicTypeFromCountry("")).toBeNull();
    expect(comicTypeFromCountry(null)).toBeNull();
  });

  it("resolves a work's format from any of its tracker entries", () => {
    const origins = new Map([[comicOriginKey(2, "77"), "manhwa" as const]]);

    expect(comicOriginForRecords([{ trackerId: 1, remoteId: "5" }, { trackerId: 2, remoteId: "77" }], origins)).toBe("manhwa");
    expect(comicOriginForRecords([{ trackerId: 1, remoteId: "5" }], origins)).toBeNull();
    expect(comicOriginForRecords(undefined, origins)).toBeNull();
  });

  it("fetches each AniList id once and serves repeats from the cache", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: number[] } };
      return aniListResponse(variables.ids.filter((id) => id !== 3).map((id) => ({ id, countryOfOrigin: id === 1 ? "KR" : "JP" })));
    });

    const first = await fetchAniListCountries([1, 2, 3, 1], { fetchImpl: fetchImpl as unknown as typeof fetch });
    const second = await fetchAniListCountries([1, 2, 3], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.get(1)).toBe("KR");
    expect(first.get(2)).toBe("JP");
    // Ids AniList no longer knows are remembered as unknown instead of being refetched.
    expect(first.get(3)).toBe("");
    expect(second).toEqual(first);
  });

  it("limits requests per call and leaves the rest for later refreshes", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: number[] } };
      return aniListResponse(variables.ids.map((id) => ({ id, countryOfOrigin: "KR" })));
    });
    const ids = Array.from({ length: 120 }, (_, index) => index + 1);

    const countries = await fetchAniListCountries(ids, { fetchImpl: fetchImpl as unknown as typeof fetch, maxRequests: 2 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(countries.size).toBe(100);
  });

  it("returns what it has when AniList fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));

    const countries = await fetchAniListCountries([10, 11], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(countries.size).toBe(0);
  });
});
