import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverKitsuNovels,
  kitsuCategorySlug,
  kitsuNovelToRecommendationCandidate,
  kitsuNovels,
  matchKitsuNovel,
  resetKitsuNovelCacheForTests,
  searchKitsuNovels,
} from "./kitsuNovels";

const answer = {
  data: [
    {
      id: "26008",
      type: "manga",
      attributes: {
        canonicalTitle: "Mushoku Tensei: Isekai Ittara Honki Dasu",
        titles: { en: "Mushoku Tensei: Jobless Reincarnation" },
        abbreviatedTitles: ["Mushoku Tensei"],
        subtype: "novel",
        averageRating: "83.12",
        userCount: 4843,
        popularityRank: 336,
        startDate: "2014-01-23",
        status: "finished",
        ageRating: "PG",
        posterImage: { small: "https://media.kitsu.app/s.jpg", medium: "https://media.kitsu.app/m.jpg" },
      },
      relationships: {
        categories: { data: [{ type: "categories", id: "c1" }, { type: "categories", id: "c2" }] },
        staff: { data: [{ type: "mediaStaff", id: "s1" }] },
      },
    },
    { id: "1", type: "manga", attributes: { canonicalTitle: "Some Manga", subtype: "manga" } },
  ],
  included: [
    { id: "c1", type: "categories", attributes: { title: "Fantasy" } },
    { id: "c2", type: "categories", attributes: { title: "Isekai" } },
    { id: "s1", type: "mediaStaff", attributes: {}, relationships: { person: { data: { type: "people", id: "p1" } } } },
    { id: "p1", type: "people", attributes: { name: "Rifujin na Magonote" } },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Kitsu's novel catalogue", () => {
  afterEach(() => {
    resetKitsuNovelCacheForTests();
    try {
      globalThis.localStorage?.clear();
    } catch {
      // No storage in this environment.
    }
  });

  it("reads novels only, with their rating, readers, categories and authors", () => {
    const [novel, ...rest] = kitsuNovels(answer);
    expect(rest).toEqual([]);
    expect(novel).toMatchObject({
      id: 26008,
      title: "Mushoku Tensei: Isekai Ittara Honki Dasu",
      averageRating: 83.12,
      userCount: 4843,
      categories: ["Fantasy", "Isekai"],
      credits: ["Rifujin na Magonote"],
      coverUrl: "https://media.kitsu.app/m.jpg",
      adult: false,
    });
    expect(novel.titles).toContain("Mushoku Tensei");
  });

  it("matches a title only to the novel it certainly names", () => {
    const novels = kitsuNovels(answer);
    expect(matchKitsuNovel("Mushoku Tensei: Jobless Reincarnation", novels)?.id).toBe(26008);
    expect(matchKitsuNovel("A Completely Different Story", novels)).toBeNull();
  });

  it("rates a novel through a tracker signal and suggests it as a recommendation", () => {
    const candidate = kitsuNovelToRecommendationCandidate(kitsuNovels(answer)[0], ["Fantasy"]);
    expect(candidate).toMatchObject({ id: "kitsu-novel:26008", contentType: "novel", safety: "safe", format: "NOVEL" });
    const tracker = candidate.providers.find((provider) => provider.kind === "tracker")!;
    expect(tracker).toMatchObject({ providerId: "kitsu", remoteId: "26008" });
    expect(tracker.score?.value).toBeCloseTo(0.8312);
    expect(tracker.popularity?.value).toBeGreaterThan(0.5);
    expect(candidate.tags).toEqual(expect.arrayContaining(["novel", "Fantasy", "Isekai"]));
  });

  it("searches and discovers novels without an account, keeping only the category asked for", async () => {
    const fetchImpl = vi.fn(async (_url: unknown) => json(answer));
    const options = { fetchImpl: fetchImpl as unknown as typeof fetch };

    expect((await searchKitsuNovels("Mushoku Tensei", 5, options)).map((novel) => novel.id)).toEqual([26008]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("filter%5Bsubtype%5D=novel");
    // Kitsu refuses the whole request when it names a field manga do not have, such as nsfw.
    expect(String(fetchImpl.mock.calls[0][0])).not.toMatch(/nsfw/);
    // A second search for the same title is answered from the cache.
    await searchKitsuNovels("Mushoku Tensei", 5, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(kitsuCategorySlug("Slice of Life")).toBe("slice-of-life");
    expect((await discoverKitsuNovels("Isekai", 10, options)).map((novel) => novel.id)).toEqual([26008]);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("filter%5Bcategories%5D=isekai");
    // Kitsu answers every novel for a category it does not have; those are left out.
    expect(await discoverKitsuNovels("Reincarnation", 10, options)).toEqual([]);
  });

  it("reports a Kitsu that does not answer", async () => {
    const fetchImpl = vi.fn(async () => json({}, 503));
    await expect(searchKitsuNovels("Anything", 5, { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow();
  });
});
