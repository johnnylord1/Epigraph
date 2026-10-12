import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAniListMediaCacheForTests } from "./anilistMedia";
import {
  cachedLibraryTitleCandidate,
  cachedLibraryTitleMatch,
  hardcoverProfiles,
  jikanProfiles,
  kitsuProfiles,
  providerTitleStatus,
  recordProviderTitleJudgement,
  recordProviderTitleMatch,
  resetTitleProviderCacheForTests,
  titleProviderChain,
  trackerSearchProfiles,
} from "./titleProviders";

const kitsuAnswer = {
  data: [
    {
      id: "79155",
      type: "manga",
      attributes: { canonicalTitle: "Shadow Slave", titles: { en: "Shadow Slave", ko_kr: "그림자 노예" }, abbreviatedTitles: ["SS"], subtype: "manhwa" },
      relationships: {
        categories: { data: [{ type: "categories", id: "150" }] },
        mappings: { data: [{ type: "mappings", id: "m1" }, { type: "mappings", id: "m2" }] },
        staff: { data: [{ type: "mediaStaff", id: "s1" }] },
      },
    },
    {
      id: "75529",
      type: "manga",
      attributes: { canonicalTitle: "Shadow Slave", titles: { en: "Shadow Slave" }, abbreviatedTitles: [], subtype: "novel" },
      relationships: { categories: { data: [] }, mappings: { data: [] } },
    },
  ],
  included: [
    { id: "150", type: "categories", attributes: { title: "Action" } },
    { id: "m1", type: "mappings", attributes: { externalSite: "myanimelist/manga", externalId: "155555" } },
    { id: "m2", type: "mappings", attributes: { externalSite: "anilist/manga", externalId: "166666" } },
    { id: "s1", type: "mediaStaff", attributes: {}, relationships: { person: { data: [{ type: "people", id: "p1" }] } } },
    { id: "p1", type: "people", attributes: { name: "Guiltythree" } },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("title providers after AniList", () => {
  afterEach(() => {
    resetTitleProviderCacheForTests();
    resetAniListMediaCacheForTests();
    try {
      globalThis.localStorage?.clear();
    } catch {
      // No storage in this environment.
    }
  });

  it("reads Kitsu works with their format, country, genres and the ids other sites give them", () => {
    const [manhwa, novel] = kitsuProfiles(kitsuAnswer);
    expect(manhwa).toMatchObject({ id: 166666, idMal: 155555, country: "KR", format: "MANGA", genres: ["Action"] });
    expect(manhwa.titles).toEqual(["Shadow Slave", "그림자 노예", "SS"]);
    expect(manhwa.credits).toEqual(["Guiltythree"]);
    expect(novel.format).toBe("NOVEL");
  });

  it("reads MyAnimeList works from Jikan and names from tracker searches", () => {
    const [work] = jikanProfiles({
      data: [{ mal_id: 7, type: "Manhua", title: "Wu Dong Qian Kun", title_english: "Martial Universe", title_synonyms: ["WDQK"], genres: [{ name: "Action" }], themes: [{ name: "Martial Arts" }], authors: [{ name: "Tian Can, Tu Dou" }] }],
    });
    expect(work.credits).toEqual(["Tian Can  Tu Dou"]);
    expect(work).toMatchObject({ id: 0, idMal: 7, country: "CN", format: "MANGA", genres: ["Action", "Martial Arts"] });
    expect(work.titles).toEqual(["Wu Dong Qian Kun", "Martial Universe", "WDQK"]);

    const [mal] = trackerSearchProfiles(1, "mal", [{ remoteId: "7", title: "Wu Dong Qian Kun", publishingType: "manhua" }]);
    expect(mal).toMatchObject({ idMal: 7, country: "CN" });
    const [updates] = trackerSearchProfiles(7, "generic", [{ remoteId: "abc", title: "Some Work", publishingType: "Novel" }]);
    expect(updates).toMatchObject({ idMal: null, format: "NOVEL", trackerRemote: { trackerId: 7, remoteId: "abc" } });
  });

  it("remembers what each provider answered and serves the work found from the cache", () => {
    recordProviderTitleMatch("kitsu", "Shadow Slave", null);
    expect(providerTitleStatus("kitsu", "Shadow Slave")).toBe("missed");
    expect(providerTitleStatus("mal", "Shadow Slave")).toBe("pending");

    recordProviderTitleMatch("mal", "Shadow Slave", kitsuProfiles(kitsuAnswer)[0]);
    expect(providerTitleStatus("mal", "Shadow Slave")).toBe("matched");
    expect(cachedLibraryTitleMatch("Shadow Slave [Official]")).toMatchObject({ idMal: 155555, provider: "mal" });
  });

  it("orders the providers and asks only logged-in trackers that can search", () => {
    const chain = titleProviderChain([
      { id: 1, name: "MyAnimeList", isLoggedIn: true },
      { id: 2, name: "AniList", isLoggedIn: true },
      { id: 7, name: "MangaUpdates", isLoggedIn: true },
      { id: 4, name: "Shikimori", isLoggedIn: false },
      { id: 9, name: "Komga", isLoggedIn: true },
    ], { fetchImpl: vi.fn() as unknown as typeof fetch, gql: vi.fn() });
    expect(chain.map((provider) => provider.id)).toEqual(["anilist", "kitsu", "mal", "tracker:7"]);
  });

  it("recognises a work on Kitsu, never taking the novel of the same name", async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => json(kitsuAnswer));
    const kitsu = titleProviderChain([], { fetchImpl: fetchImpl as unknown as typeof fetch })[1];

    await expect(kitsu.lookUp([{ key: "1", title: "Shadow Slave" }])).resolves.toEqual({ ok: true });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("filter%5Btext%5D=Shadow%20Slave");
    expect(cachedLibraryTitleMatch("Shadow Slave")).toMatchObject({ format: "MANGA", country: "KR", provider: "kitsu" });
  });

  it("asks MyAnimeList through the user's tracker while Jikan is down, accepting only the same title", async () => {
    const fetchImpl = vi.fn(async () => json({}, 504));
    const gql = vi.fn(async () => ({
      searchTracker: { trackSearches: [{ remoteId: "11", title: "Close Work Title" }, { remoteId: "12", title: "Exact Work" }] },
    }));
    const mal = titleProviderChain([{ id: 1, name: "MyAnimeList", isLoggedIn: true }], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gql: gql as never,
    })[2];

    await expect(mal.lookUp([{ key: "1", title: "Exact Work" }])).resolves.toEqual({ ok: true });
    await expect(mal.lookUp([{ key: "2", title: "Close Work Titles" }])).resolves.toEqual({ ok: true });
    await expect(mal.lookUp([{ key: "3", title: "Another" }])).resolves.toEqual({ ok: true });

    // Jikan is skipped once it failed twice.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(gql).toHaveBeenCalledTimes(3);
    expect(cachedLibraryTitleMatch("Exact Work")).toMatchObject({ idMal: 12 });
    expect(providerTitleStatus("mal", "Close Work Titles")).toBe("missed");
  });

  it("reports a provider that does not answer, leaving its titles to ask again", async () => {
    const fetchImpl = vi.fn(async () => json({}, 503));
    const kitsu = titleProviderChain([], { fetchImpl: fetchImpl as unknown as typeof fetch })[1];

    await expect(kitsu.lookUp([{ key: "1", title: "Shadow Slave" }])).resolves.toMatchObject({ ok: false });
    expect(providerTitleStatus("kitsu", "Shadow Slave")).toBe("pending");
  });

  it("keeps a likely work apart from a recognised one, as a suggestion only", () => {
    const work = kitsuProfiles(kitsuAnswer)[0];
    recordProviderTitleJudgement("kitsu", "Chrysalis", { match: null, candidate: work });

    expect(providerTitleStatus("kitsu", "Chrysalis")).toBe("uncertain");
    expect(cachedLibraryTitleMatch("Chrysalis")).toBeNull();
    expect(cachedLibraryTitleCandidate("Chrysalis")).toMatchObject({ idMal: 155555, provider: "kitsu" });
    // Comics and novels are kept apart.
    expect(providerTitleStatus("kitsu", "Chrysalis", "novel")).toBe("pending");
  });

  it("looks novels up on a connected Hardcover only, recognising books by title and author", async () => {
    const search = vi.fn(async () => [
      { id: 5, title: "Chrysalis", authors: ["Someone Else"], genres: [] },
      { id: 6, title: "Chrysalis", authors: ["RinoZ"], genres: ["Fantasy"] },
    ]);
    const hardcover = { search, retryAfterMs: () => null };
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(titleProviderChain([], { fetchImpl }, "novel")).toEqual([]);
    const chain = titleProviderChain([{ id: 7, name: "MangaUpdates", isLoggedIn: true }, { id: 2, name: "AniList", isLoggedIn: true }], { fetchImpl, hardcover }, "novel");
    expect(chain.map((provider) => provider.id)).toEqual(["hardcover"]);

    expect(hardcoverProfiles([{ id: 6, title: "Chrysalis", authors: ["RinoZ"] }])[0]).toMatchObject({ format: "NOVEL", hardcoverId: 6, credits: ["RinoZ"] });
    await expect(chain[0].lookUp([{ key: "novel:a", title: "Chrysalis", credits: ["RinoZ"] }])).resolves.toEqual({ ok: true });
    expect(cachedLibraryTitleMatch("Chrysalis", "novel")).toMatchObject({ hardcoverId: 6, provider: "hardcover" });
    expect(cachedLibraryTitleMatch("Chrysalis")).toBeNull();

    await expect(chain[0].lookUp([{ key: "book:b", title: "Chrysalis Book", credits: [] }])).resolves.toEqual({ ok: true });
    expect(providerTitleStatus("hardcover", "Chrysalis Book", "novel")).toBe("missed");

    // A novel another site knows is not used: novels are recognised on Hardcover only.
    recordProviderTitleJudgement("mal", "Lord of the Mysteries", { match: kitsuProfiles(kitsuAnswer)[1], candidate: null }, "novel");
    expect(cachedLibraryTitleMatch("Lord of the Mysteries", "novel")).toBeNull();
  });
});
