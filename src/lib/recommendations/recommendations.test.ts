import { describe, expect, it } from "vitest";
import {
  buildRecommendationSections,
  buildTasteProfile,
  normalizeRecency,
  normalizeScore,
  type RecommendationCandidate,
} from ".";

const NOW = Date.parse("2026-04-27T12:00:00.000Z");

function candidate(
  id: string,
  patch: Partial<RecommendationCandidate>,
): RecommendationCandidate {
  return {
    id,
    title: id,
    tags: [],
    contentType: "manhwa",
    providers: [],
    ...patch,
  };
}

describe("recommendation normalization", () => {
  it("normalizes provider scores from different scales into a common range", () => {
    expect(normalizeScore(8.5, 10)?.value).toBeCloseTo(0.85);
    expect(normalizeScore(85, 100)?.value).toBeCloseTo(0.85);
  });

  it("decays recency using a configurable half-life", () => {
    const oneHalfLifeAgo = NOW - (14 * 86_400_000);

    expect(normalizeRecency(oneHalfLifeAgo, NOW, 14)?.value).toBeCloseTo(0.5);
    expect(normalizeRecency(NOW, NOW, 14)?.value).toBeCloseTo(1);
  });
});

describe("taste profile", () => {
  it("weights highly rated genres above poorly rated genres", () => {
    const profile = buildTasteProfile([
      {
        id: "solo-leveling",
        title: "Solo Leveling",
        tags: ["Action", "Dungeon"],
        contentType: "manhwa",
        userRating: 9.5,
        userRatingMax: 10,
        status: "completed",
      },
      {
        id: "slow-romance",
        title: "Slow Romance",
        tags: ["Romance", "Slice of Life"],
        contentType: "manga",
        userRating: 4,
        userRatingMax: 10,
        status: "dropped",
      },
    ]);

    expect(profile.tagWeights.get("action")).toBeGreaterThan(1);
    expect(profile.tagWeights.get("dungeon")).toBeGreaterThan(1);
    expect(profile.tagWeights.get("romance")).toBeGreaterThan(0);
    expect(profile.topTags).toContain("action");
  });

  it("does not treat source metadata or language as library genres", () => {
    const profile = buildTasteProfile([
      {
        id: "novel-source-metadata",
        title: "Novel Source Metadata",
        tags: [
          "Novel",
          "Webnovel",
          "Português",
          "PT",
          "English",
          "EN-US",
          "Spanish",
          "ES",
          "French",
          "FR",
          "Korean",
          "KO",
          "Chinese",
          "ZH-CN",
          "Japanese",
          "JA",
          "EPUB",
          "PDF",
        ],
        contentType: "novel",
        status: "reading",
      },
      {
        id: "actual-favorite",
        title: "Actual Favorite",
        tags: ["Fantasy", "Cultivation"],
        contentType: "novel",
        status: "reading",
      },
    ]);

    expect(profile.topTags).toEqual(["fantasy", "cultivation"]);
    expect(profile.tagWeights.has("novel")).toBe(false);
    expect(profile.tagWeights.has("webnovel")).toBe(false);
    expect(profile.tagWeights.has("portugues")).toBe(false);
    expect(profile.tagWeights.has("english")).toBe(false);
    expect(profile.tagWeights.has("en us")).toBe(false);
    expect(profile.tagWeights.has("spanish")).toBe(false);
    expect(profile.tagWeights.has("zh cn")).toBe(false);
  });
});

describe("recommendation sections", () => {
  const profile = buildTasteProfile([
    {
      id: "favorite-1",
      title: "Favorite 1",
      tags: ["Action", "Dungeon", "Regression"],
      contentType: "manhwa",
      userRating: 10,
      status: "completed",
      sourceId: "flame",
    },
    {
      id: "favorite-2",
      title: "Favorite 2",
      tags: ["Action", "Martial Arts"],
      contentType: "manhwa",
      userRating: 9,
      status: "reading",
      sourceId: "asura",
    },
    {
      id: "low-rated",
      title: "Low Rated",
      tags: ["Office", "Drama"],
      contentType: "manga",
      userRating: 3,
      status: "dropped",
    },
  ]);

  it("returns only the active Browse Search recommendation categories", () => {
    const sections = buildRecommendationSections([
      candidate("visible", {
        tags: ["Action"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.7) },
        ],
      }),
    ], profile, { nowMs: NOW });

    expect(sections.map((section) => section.key)).toEqual([
      "becauseYouRatedHighly",
      "highConfidence",
      "trendingNearYourTaste",
      "freshInYourSources",
      "outsideYourUsualReads",
    ]);
  });

  it("prioritizes candidates that match high-rated taste and tracker consensus", () => {
    const sections = buildRecommendationSections([
      candidate("perfect-match", {
        tags: ["Action", "Dungeon"],
        providers: [
          {
            providerId: "anilist",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(88, 100, 0.9),
          },
          {
            providerId: "flame",
            providerName: "Flame Comics",
            kind: "source",
            availability: normalizeScore(1, 1, 0.7),
          },
        ],
      }),
      candidate("wrong-fit", {
        tags: ["Office", "Drama"],
        providers: [
          {
            providerId: "anilist",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(92, 100, 0.9),
          },
        ],
      }),
    ], profile, { nowMs: NOW });

    const ids = sections.flatMap((section) => section.items.map((item) => item.candidate.id));

    expect(ids[0]).toBe("perfect-match");
    expect(ids).toContain("wrong-fit");
  });

  it("builds a consensus badge when more than one tracker has a score", () => {
    const sections = buildRecommendationSections([
      candidate("multi-tracker", {
        tags: ["Action"],
        providers: [
          {
            providerId: "anilist",
            providerName: "AniList",
            kind: "tracker",
            iconKey: "anilist",
            score: normalizeScore(85, 100, 0.9),
          },
          {
            providerId: "myanimelist",
            providerName: "MyAnimeList",
            kind: "tracker",
            iconKey: "myanimelist",
            score: normalizeScore(8, 10, 0.8),
          },
        ],
      }),
    ], profile, { nowMs: NOW });

    const badge = sections.flatMap((section) => section.items).find((item) => item.candidate.id === "multi-tracker")?.badge;

    expect(badge?.kind).toBe("consensus");
    expect(badge?.iconKeys).toEqual(["anilist", "myanimelist"]);
    expect(badge?.displayScore).toBe("8.3");
  });

  it("sorts trending and fresh sections by momentum and recency", () => {
    const sections = buildRecommendationSections([
      candidate("older", {
        tags: ["Action"],
        providers: [
          {
            providerId: "tracker",
            providerName: "Tracker",
            kind: "tracker",
            score: normalizeScore(8, 10, 0.8),
            trending: normalizeScore(30, 100),
          },
        ],
      }),
      candidate("fresh-trending", {
        tags: ["Action", "Dungeon"],
        providers: [
          {
            providerId: "tracker",
            providerName: "Tracker",
            kind: "tracker",
            score: normalizeScore(8.6, 10, 0.8),
            trending: normalizeScore(90, 100),
          },
        ],
      }),
      candidate("fresh-source", {
        tags: ["Mystery"],
        contentType: "book",
        updatedAtMs: NOW - (2 * 86_400_000),
        providers: [
          { providerId: "source", providerName: "Source", kind: "source" },
        ],
      }),
    ], profile, { nowMs: NOW });

    expect(sections.find((section) => section.key === "trendingNearYourTaste")?.items[0]?.candidate.id)
      .toBe("fresh-trending");
    expect(sections.find((section) => section.key === "freshInYourSources")?.items[0]?.candidate.id)
      .toBe("fresh-source");
  });

  it("uses source activity and popularity as trend signals when explicit trending is missing", () => {
    const sections = buildRecommendationSections([
      candidate("active-source-title", {
        tags: ["Action"],
        providers: [
          {
            providerId: "source",
            providerName: "Source",
            kind: "source",
            availability: normalizeScore(1, 1, 0.8),
            activity: normalizeScore(0.82, 1, 0.7),
          },
          {
            providerId: "tracker",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(78, 100, 0.8),
            popularity: normalizeScore(0.8, 1, 0.65),
          },
        ],
      }),
    ], profile, { nowMs: NOW });

    const trendingIds = sections.find((section) => section.key === "trendingNearYourTaste")?.items.map((item) => item.candidate.id) ?? [];

    expect(trendingIds).toContain("active-source-title");
  });

  it("keeps divergent high-quality picks so recommendations do not loop forever", () => {
    const sections = buildRecommendationSections([
      candidate("divergent-gem", {
        tags: ["Mystery", "Psychological"],
        providers: [
          {
            providerId: "myanimelist",
            providerName: "MyAnimeList",
            kind: "tracker",
            score: normalizeScore(9.1, 10, 0.9),
            popularity: normalizeScore(0.7, 1, 0.5),
          },
        ],
      }),
      candidate("plain-random", {
        tags: ["Cooking"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.7) },
        ],
      }),
    ], profile, { nowMs: NOW });

    const outsideIds = sections.find((section) => section.key === "outsideYourUsualReads")?.items.map((item) => item.candidate.id) ?? [];

    expect(outsideIds).toContain("plain-random");
    expect(sections.flatMap((section) => section.items.map((item) => item.candidate.id))).toContain("divergent-gem");
  });

  it("allows adjacent low-overlap works in outside usual reads without accepting familiar matches", () => {
    const sections = buildRecommendationSections([
      candidate("adjacent-pick", {
        tags: ["Mystery", "System"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(82, 100, 0.8) },
        ],
      }),
      candidate("familiar-action", {
        tags: ["Action", "Dungeon", "Regression"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
    ], profile, { nowMs: NOW });

    const outsideIds = sections.find((section) => section.key === "outsideYourUsualReads")?.items.map((item) => item.candidate.id) ?? [];

    expect(outsideIds).toContain("adjacent-pick");
    expect(outsideIds).not.toContain("familiar-action");
  });


  it("respects blocked tags, NSFW visibility, and library inclusion filters", () => {
    const sections = buildRecommendationSections([
      candidate("blocked", { tags: ["Action", "Hentai"], safety: "explicit" }),
      candidate("library", { tags: ["Action"], inLibrary: true }),
      candidate("visible", {
        tags: ["Action"],
        providers: [
          {
            providerId: "source",
            providerName: "Source",
            kind: "source",
            availability: normalizeScore(1, 1, 0.8),
          },
        ],
      }),
    ], profile, {
      blockedTags: ["hentai"],
      includeNsfw: false,
      includeInLibrary: false,
      nowMs: NOW,
    });

    const ids = sections.flatMap((section) => section.items.map((item) => item.candidate.id));

    expect(ids).toContain("visible");
    expect(ids).not.toContain("blocked");
    expect(ids).not.toContain("library");
  });

  it("uses section-specific criteria while allowing partial overlap", () => {
    const sections = buildRecommendationSections([
      candidate("profile-match", {
        tags: ["Action", "Dungeon", "Regression"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
      candidate("high-rated", {
        tags: ["Action", "Martial Arts"],
        providers: [
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(96, 100, 0.92) },
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
      candidate("hot-now", {
        tags: ["Action", "Dungeon"],
        providers: [
          {
            providerId: "tracker",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(86, 100, 0.86),
            trending: normalizeScore(98, 100, 0.9),
          },
        ],
      }),
      candidate("new-drop", {
        tags: ["Mystery"],
        updatedAtMs: NOW - 86_400_000,
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
      candidate("outside-pick", {
        tags: ["Cooking", "Slice of Life"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(82, 100, 0.8) },
        ],
      }),
    ], profile, { nowMs: NOW, limitPerSection: 18 });

    const topBySection = new Map(sections.map((section) => [section.key, section.items[0]?.candidate.id]));

    expect(topBySection.get("becauseYouRatedHighly")).toBe("profile-match");
    expect(topBySection.get("highConfidence")).toBe("high-rated");
    expect(topBySection.get("trendingNearYourTaste")).toBe("hot-now");
    expect(topBySection.get("freshInYourSources")).toBe("new-drop");
    expect(topBySection.get("outsideYourUsualReads")).toBe("outside-pick");

    const highIds = sections.find((section) => section.key === "highConfidence")?.items.map((item) => item.candidate.id) ?? [];
    const becauseIds = sections.find((section) => section.key === "becauseYouRatedHighly")?.items.map((item) => item.candidate.id) ?? [];
    expect(highIds.some((id) => becauseIds.includes(id))).toBe(true);
  });

  it("keeps profile and confidence categories aligned with the dominant comic format", () => {
    const manhwaProfile = buildTasteProfile([
      {
        id: "top-manhwa",
        title: "Top Manhwa",
        tags: ["Action", "Dungeon", "Regression"],
        contentType: "manhwa",
        userRating: 10,
        status: "completed",
      },
      {
        id: "another-manhwa",
        title: "Another Manhwa",
        tags: ["Action", "Fantasy"],
        contentType: "manhwa",
        userRating: 9,
        status: "reading",
      },
    ]);
    const sections = buildRecommendationSections([
      candidate("generic-manga", {
        tags: ["Action", "Dungeon"],
        contentType: "manga",
        providers: [
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(95, 100, 0.9) },
          { providerId: "source", providerName: "Comick", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
      candidate("matching-manhwa", {
        tags: ["Action", "Fantasy"],
        contentType: "manhwa",
        providers: [
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(88, 100, 0.9) },
          { providerId: "source", providerName: "Flame Comics", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
    ], manhwaProfile, { nowMs: NOW });

    expect(sections.find((section) => section.key === "becauseYouRatedHighly")?.items[0]?.candidate.id)
      .toBe("matching-manhwa");
    expect(sections.find((section) => section.key === "highConfidence")?.items[0]?.candidate.id)
      .toBe("matching-manhwa");

    const becauseIds = sections.find((section) => section.key === "becauseYouRatedHighly")?.items.map((item) => item.candidate.id) ?? [];
    const highIds = sections.find((section) => section.key === "highConfidence")?.items.map((item) => item.candidate.id) ?? [];
    expect(becauseIds).not.toContain("generic-manga");
    expect(highIds).not.toContain("generic-manga");
  });

  it("does not put format-only matches in profile-driven categories", () => {
    const sections = buildRecommendationSections([
      candidate("unrelated-yaoi", {
        tags: ["Yaoi", "Boys Love", "Romance"],
        contentType: "manhwa",
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(91, 100, 0.9) },
        ],
      }),
      candidate("matching-action", {
        tags: ["Action", "Dungeon", "Fantasy"],
        contentType: "manhwa",
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(86, 100, 0.9) },
        ],
      }),
    ], profile, { nowMs: NOW });

    const becauseIds = sections.find((section) => section.key === "becauseYouRatedHighly")?.items.map((item) => item.candidate.id) ?? [];
    const highIds = sections.find((section) => section.key === "highConfidence")?.items.map((item) => item.candidate.id) ?? [];
    const trendingIds = sections.find((section) => section.key === "trendingNearYourTaste")?.items.map((item) => item.candidate.id) ?? [];

    expect(becauseIds).toContain("matching-action");
    expect(becauseIds).not.toContain("unrelated-yaoi");
    expect(highIds).not.toContain("unrelated-yaoi");
    expect(trendingIds).not.toContain("unrelated-yaoi");
  });

  it("keeps sparse candidates visible while rejecting unrelated topical tags", () => {
    const sections = buildRecommendationSections([
      candidate("source-only-no-tags-yet", {
        tags: ["Manhwa", "EN"],
        contentType: "manhwa",
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(88, 100, 0.9) },
        ],
      }),
      candidate("unrelated-bl", {
        tags: ["Boys Love", "Romance"],
        contentType: "manhwa",
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(91, 100, 0.9) },
        ],
      }),
    ], profile, { nowMs: NOW });

    const becauseIds = sections.find((section) => section.key === "becauseYouRatedHighly")?.items.map((item) => item.candidate.id) ?? [];
    const highIds = sections.find((section) => section.key === "highConfidence")?.items.map((item) => item.candidate.id) ?? [];

    expect(becauseIds).toContain("source-only-no-tags-yet");
    expect(highIds).toContain("source-only-no-tags-yet");
    expect(becauseIds).not.toContain("unrelated-bl");
    expect(highIds).not.toContain("unrelated-bl");
  });

  it("allows romance while filtering boys love unless the profile has that affinity", () => {
    const romanceProfile = buildTasteProfile([
      {
        id: "romcom",
        title: "Romantic Comedy Favorite",
        tags: ["Romance", "Comedy", "School"],
        contentType: "manga",
        userRating: 9,
        status: "completed",
      },
    ]);

    const sections = buildRecommendationSections([
      candidate("normal-romance", {
        tags: ["Romance", "Comedy"],
        contentType: "manga",
        providers: [
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(84, 100, 0.9) },
          { providerId: "source", providerName: "Comick", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
      candidate("boys-love-romance", {
        tags: ["Boys Love", "Romance"],
        contentType: "manga",
        providers: [
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(91, 100, 0.9) },
          { providerId: "source", providerName: "Comick", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
    ], romanceProfile, { nowMs: NOW });

    const ids = sections.flatMap((section) => section.items.map((item) => item.candidate.id));

    expect(ids).toContain("normal-romance");
    expect(ids).not.toContain("boys-love-romance");
  });

  it("filters mature spicy romance separately from regular romance", () => {
    const romanceProfile = buildTasteProfile([
      {
        id: "romcom",
        title: "Romantic Comedy Favorite",
        tags: ["Romance", "Comedy", "School"],
        contentType: "manga",
        userRating: 9,
        status: "completed",
      },
    ]);

    const sections = buildRecommendationSections([
      candidate("regular-romcom", {
        title: "A Gentle Romantic Comedy",
        tags: ["Romance", "Comedy"],
        contentType: "manga",
        providers: [
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(84, 100, 0.9) },
          { providerId: "source", providerName: "Comick", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
      candidate("spicy-roommates", {
        title: "Sweet Romance, Spicy Roommates",
        tags: ["Romance"],
        contentType: "manga",
        providers: [
          { providerId: "source", providerName: "WEBTOONS.COM", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
    ], romanceProfile, { nowMs: NOW });

    const ids = sections.flatMap((section) => section.items.map((item) => item.candidate.id));

    expect(ids).toContain("regular-romcom");
    expect(ids).not.toContain("spicy-roommates");
  });


  it("keeps high section limits from starving category backlogs", () => {
    const candidates = Array.from({ length: 120 }, (_, index) =>
      candidate(`bulk-${index}`, {
        tags: index % 5 === 0 ? ["Mystery", "Psychological"] : ["Action", "Fantasy"],
        updatedAtMs: NOW - (index * 86_400_000),
        providers: [
          {
            providerId: "source",
            providerName: "Source",
            kind: "source",
            availability: normalizeScore(1, 1, 0.7),
          },
          {
            providerId: "anilist",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(80 + (index % 16), 100, 0.8),
            trending: normalizeScore(100 - (index % 45), 100, 0.6),
          },
        ],
      }),
    );

    const sections = buildRecommendationSections(candidates, profile, {
      nowMs: NOW,
      limitPerSection: 180,
    });

    expect(sections.find((section) => section.key === "highConfidence")?.items.length).toBeGreaterThanOrEqual(18);
    expect(sections.find((section) => section.key === "trendingNearYourTaste")?.items.length).toBeGreaterThanOrEqual(18);
    expect(sections.find((section) => section.key === "freshInYourSources")?.items.length).toBeGreaterThanOrEqual(18);

    const highIds = sections.find((section) => section.key === "highConfidence")?.items.slice(0, 18).map((item) => item.candidate.id) ?? [];
    const trendingIds = sections.find((section) => section.key === "trendingNearYourTaste")?.items.slice(0, 18).map((item) => item.candidate.id) ?? [];
    const freshIds = sections.find((section) => section.key === "freshInYourSources")?.items.slice(0, 18).map((item) => item.candidate.id) ?? [];
    expect(highIds).not.toEqual(trendingIds);
    expect(highIds).not.toEqual(freshIds);
  });

  it("keeps comic format distribution anchored to a manhwa-heavy profile", () => {
    const manhwaProfile = buildTasteProfile([
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `manhwa-seed-${index}`,
        title: `Manhwa Seed ${index}`,
        tags: ["Action", "Fantasy"],
        contentType: "manhwa" as const,
        implicitWeight: 0.8,
        status: "reading" as const,
      })),
      {
        id: "manga-seed",
        title: "Manga Seed",
        tags: ["Action", "Fantasy"],
        contentType: "manga" as const,
        implicitWeight: 0.25,
        status: "reading" as const,
      },
    ]);
    const candidates = [
      ...Array.from({ length: 32 }, (_, index) =>
        candidate(`global-manga-${index}`, {
          title: `Global Manga ${index}`,
          tags: ["Action", "Fantasy"],
          contentType: "manga",
          providers: [
            {
              providerId: "anilist",
              providerName: "AniList",
              kind: "tracker",
              score: normalizeScore(90 - (index % 10), 100, 0.9),
              trending: normalizeScore(100 - (index % 20), 100, 0.8),
            },
            {
              providerId: "manga-source",
              providerName: "Manga Source",
              kind: "source",
              recency: normalizeRecency(NOW - ((index % 5) * 86_400_000), NOW, 14, 0.75),
              availability: normalizeScore(1, 1, 0.8),
            },
          ],
        }),
      ),
      ...Array.from({ length: 24 }, (_, index) =>
        candidate(`profile-manhwa-${index}`, {
          title: `Profile Manhwa ${index}`,
          tags: ["Action", "Fantasy"],
          contentType: "manhwa",
          providers: [
            {
              providerId: "anilist",
              providerName: "AniList",
              kind: "tracker",
              score: normalizeScore(82 - (index % 8), 100, 0.86),
              trending: normalizeScore(82 - (index % 8), 100, 0.72),
            },
            {
              providerId: "manhwa-source",
              providerName: "Manhwa Source",
              kind: "source",
              recency: normalizeRecency(NOW - ((index % 5) * 86_400_000), NOW, 14, 0.75),
              availability: normalizeScore(1, 1, 0.8),
            },
          ],
        }),
      ),
    ];

    const sections = buildRecommendationSections(candidates, manhwaProfile, {
      nowMs: NOW,
      limitPerSection: 60,
    });
    const highTop = sections.find((section) => section.key === "highConfidence")?.items.slice(0, 18) ?? [];
    const trendingTop = sections.find((section) => section.key === "trendingNearYourTaste")?.items.slice(0, 18) ?? [];
    const freshTop = sections.find((section) => section.key === "freshInYourSources")?.items.slice(0, 18) ?? [];

    expect(highTop.filter((item) => item.candidate.contentType === "manhwa").length).toBeGreaterThanOrEqual(16);
    expect(trendingTop.filter((item) => item.candidate.contentType === "manhwa").length).toBeGreaterThanOrEqual(16);
    expect(freshTop.filter((item) => item.candidate.contentType === "manhwa").length).toBeGreaterThanOrEqual(16);
  });

  it("allows sparse source comics into outside reads when their format differs from the dominant profile", () => {
    const sparseManga = Array.from({ length: 24 }, (_, index) =>
      candidate(`sparse-manga-${index}`, {
        contentType: "manga",
        tags: [],
        providers: [
          {
            providerId: "comick",
            providerName: "Comick",
            kind: "source",
            availability: normalizeScore(1, 1, 0.75),
          },
        ],
      }),
    );

    const sections = buildRecommendationSections(sparseManga, profile, {
      nowMs: NOW,
      limitPerSection: 180,
    });

    expect(sections.find((section) => section.key === "outsideYourUsualReads")?.items.length)
      .toBeGreaterThanOrEqual(18);
  });

  it("keeps sparse source-only novel candidates in the source freshness section only", () => {
    const sourceOnlyNovels = Array.from({ length: 48 }, (_, index) =>
      candidate(`novel-${index}`, {
        contentType: "novel",
        tags: ["novel"],
        providers: [
          {
            providerId: index % 2 === 0 ? "royal-road" : "scribble-hub",
            providerName: index % 2 === 0 ? "Royal Road" : "Scribble Hub",
            kind: "source",
            availability: normalizeScore(1, 1, 0.8),
          },
        ],
      }),
    );

    const sections = buildRecommendationSections(sourceOnlyNovels, buildTasteProfile([]), {
      nowMs: NOW,
      limitPerSection: 60,
    });

    const highConfidenceIds = sections.find((section) => section.key === "highConfidence")?.items.slice(0, 18).map((item) => item.candidate.id) ?? [];
    const freshIds = sections.find((section) => section.key === "freshInYourSources")?.items.slice(0, 18).map((item) => item.candidate.id) ?? [];
    const trendingIds = sections.find((section) => section.key === "trendingNearYourTaste")?.items ?? [];

    expect(sections).toHaveLength(5);
    expect(highConfidenceIds).toHaveLength(0);
    expect(freshIds).toHaveLength(18);
    expect(trendingIds).toHaveLength(0);
  });
});
