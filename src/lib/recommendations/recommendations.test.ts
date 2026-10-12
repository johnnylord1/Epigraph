import { describe, expect, it } from "vitest";
import {
  buildRecommendationSections,
  buildTasteProfile,
  normalizeRecency,
  normalizeScore,
  recommendationCandidateIdentityKeys,
  recommendationReleaseKind,
  rerankForDiversity,
  scoreRecommendationCandidate,
  type RecommendationCandidate,
  type RecommendationSection,
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
    expect(profile.tagWeights.get("romance")).toBeLessThan(0);
    expect(profile.topTags).not.toContain("romance");
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

  it("does not treat the content format alone as a library-profile match", () => {
    const scored = scoreRecommendationCandidate(candidate("missing-genres", {
      contentType: "manhwa",
      tags: [],
      providers: [
        { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
      ],
    }), profile, NOW);
    const sections = buildRecommendationSections([
      candidate("missing-genres", {
        contentType: "manhwa",
        tags: [],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
    ], profile, { nowMs: NOW });

    expect(scored.personalRatingAffinity).toBe(0);
    expect(scored.profileTagOverlap).toBe(0);
    expect(scored.contentTypeFit).toBeGreaterThan(0);
    expect(sections.find((section) => section.key === "becauseYouRatedHighly")?.items)
      .toHaveLength(0);
  });

  it("uses the full profile/tag union when measuring overlap", () => {
    const scored = scoreRecommendationCandidate(candidate("single-tag-match", {
      tags: ["Action"],
      providers: [
        { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
      ],
    }), profile, NOW);

    expect(scored.profileTagOverlap).toBeGreaterThan(0);
    expect(scored.profileTagOverlap).toBeLessThan(0.3);
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

  it("keeps the reader's main genre out of outside usual reads even among unfamiliar tags", () => {
    const sections = buildRecommendationSections([
      candidate("diluted-action", {
        tags: ["Action", "Cooking", "Sports", "Music", "Space", "Mecha", "Idol", "Aliens", "Survival", "Gourmet"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(84, 100, 0.8) },
        ],
      }),
      candidate("sports-pick", {
        tags: ["Sports", "Music"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(84, 100, 0.8) },
        ],
      }),
    ], profile, { nowMs: NOW });

    const outside = sections.find((section) => section.key === "outsideYourUsualReads")?.items ?? [];
    const outsideIds = outside.map((item) => item.candidate.id);

    expect(outsideIds).toContain("sports-pick");
    expect(outsideIds).not.toContain("diluted-action");
  });


  it("keeps the genres shown as the reader's principal ones out of outside usual reads", () => {
    const actionReader = buildTasteProfile([
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `action-${index}`,
        title: `Action ${index}`,
        tags: ["Action", "Fantasy"],
        contentType: "manhwa" as const,
        implicitWeight: 0.8,
        status: "reading" as const,
      })),
      {
        id: "one-drama",
        title: "One Drama",
        tags: ["Drama"],
        contentType: "manhwa" as const,
        implicitWeight: 0.8,
        status: "reading" as const,
      },
    ]);
    const tracked = (id: string, tags: string[]) => candidate(id, {
      tags,
      providers: [
        { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(84, 100, 0.8) },
      ],
    });
    const sections = buildRecommendationSections([
      tracked("drama-pick", ["Drama", "Sports", "Music", "Cooking", "Space"]),
      tracked("sports-pick", ["Sports", "Music", "Cooking", "Space"]),
    ], actionReader, { nowMs: NOW });

    const outsideIds = sections.find((section) => section.key === "outsideYourUsualReads")?.items.map((item) => item.candidate.id) ?? [];

    expect(actionReader.topTags.slice(0, 6)).toContain("drama");
    expect(outsideIds).toContain("sports-pick");
    expect(outsideIds).not.toContain("drama-pick");
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

  it("uses section-specific criteria without repeating a work across sections", () => {
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

    const allIds = sections.flatMap((section) => section.items.map((item) => item.candidate.id));
    expect(allIds).toHaveLength(new Set(allIds).size);
    expect(new Set(allIds)).toEqual(new Set(["profile-match", "high-rated", "hot-now", "new-drop", "outside-pick"]));
  });

  it("orders overlapping candidates by each category's primary signal", () => {
    const sections = buildRecommendationSections([
      candidate("profile-first", {
        tags: ["Action", "Dungeon", "Regression"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          {
            providerId: "anilist",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(72, 100, 0.9),
          },
        ],
      }),
      candidate("consensus-first", {
        tags: ["Action"],
        providers: [
          { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
          {
            providerId: "anilist",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(98, 100, 0.9),
            trending: normalizeScore(15, 100, 0.8),
          },
        ],
      }),
      candidate("trend-first", {
        tags: ["Action"],
        providers: [
          {
            providerId: "anilist",
            providerName: "AniList",
            kind: "tracker",
            score: normalizeScore(72, 100, 0.9),
            trending: normalizeScore(99, 100, 0.9),
          },
        ],
      }),
      candidate("fresh-first", {
        tags: ["Action"],
        providers: [
          {
            providerId: "source",
            providerName: "Source",
            kind: "source",
            availability: normalizeScore(1, 1, 0.8),
            recency: normalizeRecency(NOW, NOW, 14, 0.9),
          },
        ],
      }),
      candidate("fresh-second", {
        tags: ["Action"],
        providers: [
          {
            providerId: "source",
            providerName: "Source",
            kind: "source",
            availability: normalizeScore(1, 1, 0.8),
            recency: normalizeRecency(NOW - (7 * 86_400_000), NOW, 14, 0.9),
          },
        ],
      }),
    ], profile, { nowMs: NOW, limitPerSection: 18 });

    const idsFor = (key: RecommendationSection["key"]) =>
      sections.find((section) => section.key === key)?.items.map((item) => item.candidate.id) ?? [];

    expect(idsFor("becauseYouRatedHighly")[0]).toBe("profile-first");
    expect(idsFor("highConfidence")[0]).toBe("consensus-first");
    expect(idsFor("trendingNearYourTaste")[0]).toBe("trend-first");
    expect(idsFor("freshInYourSources").slice(0, 2)).toEqual(["fresh-first", "fresh-second"]);
  });

  it("shows each work, including its aliases, in only one section of the page", () => {
    const sharedWork = candidate("shared-work", {
      title: "Shared Work",
      tags: ["Action", "Dungeon", "Regression"],
      providers: [
        { providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        {
          providerId: "anilist",
          providerName: "AniList",
          kind: "tracker",
          score: normalizeScore(92, 100, 0.9),
          trending: normalizeScore(90, 100, 0.8),
        },
      ],
    });
    const sharedWorkAlias = candidate("shared-work-alias", {
      title: "Isekai Shared Work",
      alternativeTitles: ["Shared Work"],
      tags: ["Action", "Dungeon", "Regression"],
      providers: [
        { providerId: "source-2", providerName: "Another Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
      ],
    });

    const sections = buildRecommendationSections([sharedWork, sharedWorkAlias], profile, {
      nowMs: NOW,
      limitPerSection: 18,
    });

    const seenKeys = new Set<string>();
    for (const section of sections) {
      for (const item of section.items) {
        const identityKeys = recommendationCandidateIdentityKeys(item.candidate);
        expect(identityKeys.some((key) => seenKeys.has(key))).toBe(false);
        for (const key of identityKeys) seenKeys.add(key);
      }
    }

    const sectionsContainingSharedWork = sections.filter((section) =>
      section.items.some((item) => recommendationCandidateIdentityKeys(item.candidate).includes("comic:shared work")),
    );
    expect(sectionsContainingSharedWork).toHaveLength(1);
  });

  it("keeps a profile match out of outside usual reads", () => {
    const profileMatch = candidate("shepherd-wizard", {
      title: "The Shepherd Wizard",
      tags: ["Action", "Fantasy", "Adventure"],
      providers: [
        { providerId: "flame", providerName: "Flame Scans", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        {
          providerId: "anilist",
          providerName: "AniList",
          kind: "tracker",
          score: normalizeScore(76, 100, 0.9),
        },
      ],
    });

    const sections = buildRecommendationSections([profileMatch], profile, {
      nowMs: NOW,
      limitPerSection: 18,
    });
    const because = sections.find((section) => section.key === "becauseYouRatedHighly");
    const outside = sections.find((section) => section.key === "outsideYourUsualReads");

    expect(because?.items.map((item) => item.candidate.id)).toContain("shepherd-wizard");
    expect(outside?.items.map((item) => item.candidate.id)).not.toContain("shepherd-wizard");
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
      candidate("acclaimed-manhwa", {
        tags: ["Action"],
        contentType: "manhwa",
        providers: [
          { providerId: "tracker", providerName: "AniList", kind: "tracker", score: normalizeScore(97, 100, 0.9) },
          { providerId: "tracker-2", providerName: "MyAnimeList", kind: "tracker", score: normalizeScore(9.5, 10, 0.9) },
          { providerId: "source", providerName: "Flame Comics", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        ],
      }),
    ], manhwaProfile, { nowMs: NOW });

    expect(sections.find((section) => section.key === "becauseYouRatedHighly")?.items[0]?.candidate.id)
      .toBe("matching-manhwa");
    expect(sections.find((section) => section.key === "highConfidence")?.items[0]?.candidate.id)
      .toBe("acclaimed-manhwa");

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

    expect(becauseIds).not.toContain("source-only-no-tags-yet");
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
      ...Array.from({ length: 72 }, (_, index) =>
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

  it("ends a row when the library's main format runs out instead of filling it with another", () => {
    const manhwaProfile = buildTasteProfile([
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `manhwa-seed-${index}`,
        title: `Manhwa Seed ${index}`,
        tags: ["Action", "Fantasy"],
        contentType: "manhwa" as const,
        implicitWeight: 0.8,
        status: "reading" as const,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `manga-seed-${index}`,
        title: `Manga Seed ${index}`,
        tags: ["Action", "Fantasy"],
        contentType: "manga" as const,
        implicitWeight: 0.8,
        status: "reading" as const,
      })),
    ]);
    const tracked = (id: string, contentType: RecommendationCandidate["contentType"], score: number) =>
      candidate(id, {
        title: id,
        tags: ["Action", "Fantasy"],
        contentType,
        providers: [{ providerId: "anilist", providerName: "AniList", kind: "tracker", score: normalizeScore(score, 100, 0.9) }],
      });
    // Plenty of well rated manga, few manhwa: the supply a manhwa reader often gets from AniList.
    const sections = buildRecommendationSections([
      ...Array.from({ length: 6 }, (_, index) => tracked(`manhwa-${index}`, "manhwa", 80 - index)),
      ...Array.from({ length: 40 }, (_, index) => tracked(`manga-${index}`, "manga", 90 - (index % 10))),
    ], manhwaProfile, { nowMs: NOW, limitPerSection: 40 });

    for (const section of sections.filter((row) => row.key !== "freshInYourSources" && row.key !== "outsideYourUsualReads")) {
      const manhwa = section.items.filter((item) => item.candidate.contentType === "manhwa").length;
      const manga = section.items.filter((item) => item.candidate.contentType === "manga").length;
      expect(manga, section.key).toBeLessThanOrEqual(Math.ceil(manhwa / 2));
    }
  });

  it("lists one work of a series instead of its episodes and side novels", () => {
    const tracked = (title: string, score: number) =>
      candidate(title, {
        title,
        tags: ["Action", "Fantasy"],
        providers: [{ providerId: "anilist", providerName: "AniList", kind: "tracker", score: normalizeScore(score, 100, 0.9) }],
      });
    const sections = buildRecommendationSections([
      tracked("Higurashi no Naku Koro ni - Dai 1-wa: Onikakushi-hen", 88),
      tracked("Higurashi no Naku Koro ni - Dai 2-wa: Watanagashi-hen", 87),
      tracked("Higurashi no Naku Koro ni - Dai 3-wa: Tatarigoroshi-hen", 86),
      tracked("Yakusoku no Neverland: Mama-tachi no Tsuisou Uta", 85),
      tracked("Yakusoku no Neverland: Norman kara no Tegami", 84),
      tracked("Spice & Wolf", 83),
    ], profile, { nowMs: NOW, limitPerSection: 20 });
    const listed = sections
      .filter((section) => section.key !== "freshInYourSources")
      .flatMap((section) => section.items.map((item) => item.candidate.title));
    expect(listed.filter((title) => title.startsWith("Higurashi"))).toHaveLength(1);
    expect(listed.filter((title) => title.startsWith("Yakusoku"))).toHaveLength(1);
    expect(listed).toContain("Spice & Wolf");
  });

  it("keeps the library's comic format mix in each row, each format listed by rating", () => {
    const mixedProfile = buildTasteProfile([
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `manhwa-seed-${index}`,
        title: `Manhwa Seed ${index}`,
        tags: ["Action", "Fantasy"],
        contentType: "manhwa" as const,
        implicitWeight: 0.8,
        status: "reading" as const,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `manga-seed-${index}`,
        title: `Manga Seed ${index}`,
        tags: ["Action", "Fantasy"],
        contentType: "manga" as const,
        implicitWeight: 0.8,
        status: "reading" as const,
      })),
    ]);
    const tracked = (id: string, contentType: RecommendationCandidate["contentType"], score: number) =>
      candidate(id, {
        title: id,
        tags: ["Action", "Fantasy"],
        contentType,
        providers: [{
          providerId: "anilist",
          providerName: "AniList",
          kind: "tracker",
          score: normalizeScore(score, 100, 0.9),
          trending: normalizeScore(score, 100, 0.8),
        }],
      });
    // Global trackers rank Japanese titles higher, which used to fill the first cards with manga.
    const candidates = [
      ...Array.from({ length: 30 }, (_, index) => tracked(`manga-${index}`, "manga", 95 - (index % 5))),
      ...Array.from({ length: 30 }, (_, index) => tracked(`manhwa-${index}`, "manhwa", 75 - (index % 5))),
    ];

    const sections = buildRecommendationSections(candidates, mixedProfile, { nowMs: NOW, limitPerSection: 20 });
    for (const key of ["becauseYouRatedHighly", "highConfidence", "trendingNearYourTaste"] as const) {
      const items = sections.find((section) => section.key === key)?.items ?? [];
      const formats = items.map((item) => item.candidate.contentType);
      const ratings = items.map((item) => item.badge?.score ?? 0);
      expect(items.length, key).toBeGreaterThan(0);
      // Global trackers rate Japanese titles higher; the row still holds plenty of manhwa like the library.
      expect(formats.filter((format) => format === "manhwa").length, key).toBeGreaterThanOrEqual(items.length * 0.4);
      expect(formats.filter((format) => format === "manga").length, key).toBeGreaterThanOrEqual(1);
      // The first cards already show the mix instead of a block of higher-rated manga.
      expect(formats.slice(0, 5).filter((format) => format === "manhwa").length, key).toBeGreaterThanOrEqual(2);
      for (const format of ["manga", "manhwa"] as const) {
        const formatRatings = ratings.filter((_, index) => formats[index] === format);
        expect(formatRatings, `${key} ${format}`).toEqual([...formatRatings].sort((a, b) => b - a));
      }
    }
  });

  it("puts new series before sequels and one-shots, best rated first, and keeps fresh rows by date", () => {
    const profile = buildTasteProfile(Array.from({ length: 4 }, (_, index) => ({
      id: `seed-${index}`,
      title: `Seed ${index}`,
      tags: ["Action", "Fantasy"],
      contentType: "manhwa" as const,
      implicitWeight: 0.8,
      status: "reading" as const,
    })));
    const tracked = (id: string, title: string, score: number, overrides: Partial<RecommendationCandidate> = {}) =>
      candidate(id, {
        title,
        tags: ["Action", "Fantasy"],
        contentType: "manhwa",
        providers: [{
          providerId: "anilist",
          providerName: "AniList",
          kind: "tracker",
          score: normalizeScore(score, 100, 0.9),
          trending: normalizeScore(score, 100, 0.8),
        }],
        ...overrides,
      });
    const candidates = [
      tracked("mid", "Mid Series", 70),
      tracked("sequel", "Known Series: Second Arc", 95),
      tracked("season", "Other Tale Season 2", 93),
      tracked("pilot", "Pilot Story", 92, { format: "ONE_SHOT" }),
      tracked("top", "Top Series", 88),
      tracked("low", "Low Series", 60),
      tracked("unrated", "Unrated Series", 0, { providers: [{ providerId: "anilist", providerName: "AniList", kind: "tracker" }] }),
    ];

    const sections = buildRecommendationSections(candidates, profile, {
      nowMs: NOW,
      limitPerSection: 20,
      knownTitleKeys: ["comic:known series"],
    });
    const listed = sections.flatMap((section) => section.key === "freshInYourSources" ? [] : section.items);
    const kindById = new Map(listed.map((item) => [item.candidate.id, item.releaseKind]));
    expect(kindById.get("sequel")).toBe("continuation");
    expect(kindById.get("season")).toBe("continuation");
    expect(kindById.get("pilot")).toBe("oneShot");
    expect(kindById.get("top")).toBe("series");

    for (const section of sections) {
      if (section.key === "freshInYourSources" || section.items.length < 2) continue;
      const order = section.items.map((item) => ({
        secondary: item.releaseKind === "series" ? 0 : 1,
        rating: item.badge?.score ?? -1,
      }));
      const sorted = [...order].sort((a, b) => (a.secondary - b.secondary) || (b.rating - a.rating));
      expect(order, section.key).toEqual(sorted);
    }
  });

  it("tells sequels, side stories and one-shots from new series", () => {
    const known = new Set(["comic:solo leveling", "comic:gate"]);
    const comic = (title: string, overrides: Partial<RecommendationCandidate> = {}) =>
      candidate(title, { title, contentType: "manhwa", tags: ["Action"], ...overrides });

    expect(recommendationReleaseKind(comic("Solo Leveling: Ragnarok"), known)).toBe("continuation");
    expect(recommendationReleaseKind(comic("Solo Leveling - Ragnarok"), known)).toBe("continuation");
    expect(recommendationReleaseKind(comic("The Tower 2nd Season"), known)).toBe("continuation");
    expect(recommendationReleaseKind(comic("Hero Side Story"), known)).toBe("continuation");
    expect(recommendationReleaseKind(comic("Umineko no Naku Koro ni Chiru Episode 8"), known)).toBe("continuation");
    expect(recommendationReleaseKind(comic("Umineko no Naku Koro ni Episode 1"), known)).toBe("series");
    expect(recommendationReleaseKind(comic("Higurashi no Naku Koro ni - Dai 4-wa: Himatsubushi-hen"), known)).toBe("continuation");
    expect(recommendationReleaseKind(comic("Higurashi no Naku Koro ni - Dai 1-wa: Onikakushi-hen"), known)).toBe("series");
    expect(recommendationReleaseKind(comic("Ace of the Diamond act II"), known)).toBe("continuation");
    expect(recommendationReleaseKind(comic("Active Raid"), known)).toBe("series");
    expect(recommendationReleaseKind(comic("Chainsaw Man", { format: "ONE_SHOT" }), known)).toBe("oneShot");
    expect(recommendationReleaseKind(comic("Look Back", { tags: ["Drama", "One-shot"] }), known)).toBe("oneShot");
    // A short known name starts too many unrelated titles, and a number alone is not a sequel.
    expect(recommendationReleaseKind(comic("Gate: Another World"), known)).toBe("series");
    expect(recommendationReleaseKind(comic("Kaiju No. 8"), known)).toBe("series");
    expect(recommendationReleaseKind(comic("Part-Time Hero"), known)).toBe("series");
    expect(recommendationReleaseKind(comic("Unknown Saga: Rise"), known)).toBe("series");
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

  it("ranks source-only novels like comics: without dates, ratings or genres they reach no row", () => {
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
    expect(freshIds).toHaveLength(0);
    expect(trendingIds).toHaveLength(0);
  });

  it("recommends novels by genre, like comics: only genre matches reach the taste rows", () => {
    const novelReader = buildTasteProfile([0, 1, 2, 3].map((index) => ({
      id: `library-novel-${index}`, title: `Library Novel ${index}`, tags: ["Fantasy", "Cultivation"],
      contentType: "novel" as const, userRating: 8, status: "reading" as const,
    })));
    const sourceNovels = Array.from({ length: 24 }, (_, index) =>
      candidate(`source-novel-${index}`, {
        contentType: "novel",
        tags: index % 2 === 0 ? ["novel", "webnovel", "en"] : ["Fantasy", "Cultivation"],
        providers: [
          {
            providerId: "ln-central",
            providerName: "Central Novels",
            kind: "source",
            availability: normalizeScore(1, 1, 0.82),
            popularity: { value: 0.58 + ((index % 5) * 0.06), confidence: 0.36, method: "novel-source-result" },
            trending: { value: 0.22, confidence: 0.28, method: "novel-source-result" },
            recency: { value: 0.24, confidence: 0.3, method: "novel-source-result" },
          },
        ],
      }),
    );

    const sections = buildRecommendationSections(sourceNovels, novelReader, { nowMs: NOW, limitPerSection: 60 });
    const sectionIds = (key: RecommendationSection["key"]) =>
      sections.find((section) => section.key === key)?.items.map((item) => item.candidate.id) ?? [];
    const untagged = (id: string) => Number(id.split("-").pop()) % 2 === 0;

    for (const key of ["becauseYouRatedHighly", "highConfidence", "trendingNearYourTaste"] as const) {
      expect(sectionIds(key).length).toBeGreaterThan(0);
      expect(sectionIds(key).filter(untagged)).toEqual([]);
    }
  });

  it("keeps untagged novels out of the taste rows of a comic reader", () => {
    const comicReader = buildTasteProfile([0, 1, 2, 3].map((index) => ({
      id: `library-manga-${index}`, title: `Library Manga ${index}`, tags: ["Action", "Murim"],
      contentType: "manga" as const, userRating: 9, status: "completed" as const,
    })));
    const untaggedNovels = Array.from({ length: 12 }, (_, index) =>
      candidate(`source-novel-${index}`, {
        contentType: "novel",
        tags: ["novel"],
        providers: [
          {
            providerId: "ln-central",
            providerName: "Central Novels",
            kind: "source",
            availability: normalizeScore(1, 1, 0.82),
            popularity: { value: 0.8, confidence: 0.5, method: "novel-source-result" },
          },
        ],
      }),
    );

    const sections = buildRecommendationSections(untaggedNovels, comicReader, { nowMs: NOW, limitPerSection: 60 });

    expect(sections.find((section) => section.key === "trendingNearYourTaste")?.items).toHaveLength(0);
    expect(sections.find((section) => section.key === "highConfidence")?.items).toHaveLength(0);
  });

  it("matches one taste of an eclectic reader instead of diluting it across the whole profile", () => {
    const eclecticProfile = buildTasteProfile([
      ...[0, 1, 2].map((index) => ({
        id: `romance-${index}`, title: `Romance ${index}`, tags: ["Romance", "Drama", "School"],
        contentType: "manga" as const, userRating: 9, status: "completed" as const,
      })),
      ...[0, 1, 2].map((index) => ({
        id: `action-${index}`, title: `Action ${index}`, tags: ["Action", "Martial Arts", "Murim"],
        contentType: "manga" as const, userRating: 9, status: "completed" as const,
      })),
      ...[0, 1, 2].map((index) => ({
        id: `horror-${index}`, title: `Horror ${index}`, tags: ["Horror", "Mystery", "Psychological"],
        contentType: "manga" as const, userRating: 9, status: "completed" as const,
      })),
    ]);
    const romance = candidate("school-romance", {
      tags: ["Romance", "School", "Drama"],
      contentType: "manga",
      providers: [{ providerId: "source", providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) }],
    });

    expect(scoreRecommendationCandidate(romance, eclecticProfile, NOW).personalRatingAffinity).toBeGreaterThan(0.8);
    const becauseIds = buildRecommendationSections([romance], eclecticProfile, { nowMs: NOW })
      .find((section) => section.key === "becauseYouRatedHighly")?.items.map((item) => item.candidate.id);
    expect(becauseIds).toEqual(["school-romance"]);
  });

  it("keeps titles with disliked tags out of the rows that promise your taste", () => {
    const dislikeProfile = buildTasteProfile([
      { id: "liked-1", title: "Liked 1", tags: ["Action", "Fantasy"], contentType: "manga", userRating: 10, status: "completed" },
      { id: "liked-2", title: "Liked 2", tags: ["Action", "Adventure"], contentType: "manga", userRating: 9, status: "completed" },
      { id: "dropped-1", title: "Dropped 1", tags: ["Harem"], contentType: "manga", userRating: 3, status: "dropped" },
      { id: "dropped-2", title: "Dropped 2", tags: ["Harem", "Ecchi"], contentType: "manga", userRating: 2, status: "dropped" },
    ]);
    const providers = [
      { providerId: "source", providerName: "Source", kind: "source" as const, availability: normalizeScore(1, 1, 0.8) },
      {
        providerId: "anilist",
        providerName: "AniList",
        kind: "tracker" as const,
        score: normalizeScore(90, 100, 0.9),
        trending: normalizeScore(95, 100, 0.9),
      },
    ];
    const sections = buildRecommendationSections([
      candidate("action-harem", { tags: ["Action", "Fantasy", "Harem"], contentType: "manga", providers }),
      candidate("clean-action", { tags: ["Action", "Fantasy", "Adventure"], contentType: "manga", providers }),
    ], dislikeProfile, { nowMs: NOW });

    const idsFor = (key: RecommendationSection["key"]) =>
      sections.find((section) => section.key === key)?.items.map((item) => item.candidate.id) ?? [];
    for (const key of ["becauseYouRatedHighly", "highConfidence", "trendingNearYourTaste"] as const) {
      expect(idsFor(key)).not.toContain("action-harem");
    }
    expect(sections.flatMap((section) => section.items.map((item) => item.candidate.id))).toContain("clean-action");
    expect(scoreRecommendationCandidate(
      candidate("action-harem", { tags: ["Action", "Fantasy", "Harem"], contentType: "manga", providers }),
      dislikeProfile,
      NOW,
    ).negativeTagPenalty).toBeGreaterThan(0.5);
  });

  it("spreads near-identical titles apart inside a row", () => {
    const clone = (id: string, score: number) => ({
      item: {
        candidate: candidate(id, { tags: ["Action", "Dungeon", "Regression"] }),
        breakdown: scoreRecommendationCandidate(candidate(id, { tags: ["Action", "Dungeon", "Regression"] }), profile, NOW),
        badge: null,
      },
      score,
    });
    const distinct = {
      item: {
        candidate: candidate("distinct", { tags: ["Action", "Martial Arts"] }),
        breakdown: scoreRecommendationCandidate(candidate("distinct", { tags: ["Action", "Martial Arts"] }), profile, NOW),
        badge: null,
      },
      score: 0.8,
    };

    const ordered = rerankForDiversity([clone("clone-1", 0.86), clone("clone-2", 0.85), clone("clone-3", 0.84), distinct])
      .map((item) => item.candidate.id);

    expect(ordered[0]).toBe("clone-1");
    expect(ordered[1]).toBe("distinct");
    expect(ordered).toHaveLength(4);
  });

  it("never repeats a work across rows of a large mixed page", () => {
    const pool = Array.from({ length: 120 }, (_, index) => candidate(`mixed-${index}`, {
      title: `Mixed ${index % 90}`,
      tags: [["Action", "Dungeon"], ["Action", "Martial Arts"], ["Mystery"], ["Cooking", "Slice of Life"]][index % 4],
      updatedAtMs: NOW - ((index % 9) * 86_400_000),
      providers: [
        { providerId: `source-${index % 3}`, providerName: "Source", kind: "source", availability: normalizeScore(1, 1, 0.8) },
        {
          providerId: "anilist",
          providerName: "AniList",
          kind: "tracker",
          score: normalizeScore(60 + (index % 40), 100, 0.9),
          trending: normalizeScore(index % 100, 100, 0.8),
        },
      ],
    }));

    const sections = buildRecommendationSections(pool, profile, { nowMs: NOW, limitPerSection: 40 });
    const seen = new Set<string>();
    for (const section of sections) {
      for (const item of section.items) {
        const identityKeys = recommendationCandidateIdentityKeys(item.candidate);
        expect(identityKeys.some((key) => seen.has(key))).toBe(false);
        for (const key of identityKeys) seen.add(key);
      }
    }
    expect(sections.filter((section) => section.items.length > 0).length).toBeGreaterThanOrEqual(4);
  });

  it("matches source genre labels against tracker genres for the taste rows", () => {
    // MANGA Plus names genres "Battle / Action" and "Sci-Fi / Fantasy"; trackers say "Action", "Sci-Fi", "Fantasy".
    const sourceGenreProfile = buildTasteProfile([
      {
        id: "one-piece",
        title: "One Piece",
        tags: ["Battle / Action", "Sci-Fi / Fantasy"],
        contentType: "manga",
        implicitWeight: 0.55,
        status: "reading",
      },
    ]);
    const providers = [
      { providerId: "mangaplus", providerName: "MANGA Plus", kind: "source" as const, availability: normalizeScore(1, 1, 0.8) },
      {
        providerId: "anilist",
        providerName: "AniList",
        kind: "tracker" as const,
        score: normalizeScore(82, 100, 0.9),
        trending: normalizeScore(90, 100, 0.9),
      },
    ];
    const actionPick = candidate("kagurabachi", {
      title: "Kagurabachi",
      tags: ["Action", "Supernatural", "Manga", "Releasing"],
      contentType: "manga",
      providers,
    });
    const romancePick = candidate("quiet-romance", {
      tags: ["Romance", "Slice of Life", "Manga"],
      contentType: "manga",
      providers,
    });

    expect([...sourceGenreProfile.tagWeights.keys()].sort()).toEqual(["action", "fantasy", "sci fi"]);
    expect(scoreRecommendationCandidate(actionPick, sourceGenreProfile, NOW).matchedTagCount).toBe(1);

    const sections = buildRecommendationSections([actionPick, romancePick], sourceGenreProfile, { nowMs: NOW });
    const idsFor = (key: RecommendationSection["key"]) =>
      sections.find((section) => section.key === key)?.items.map((item) => item.candidate.id) ?? [];
    const tasteRowIds = ["becauseYouRatedHighly", "highConfidence", "trendingNearYourTaste"].flatMap((key) =>
      idsFor(key as RecommendationSection["key"]));

    expect(tasteRowIds).toContain("kagurabachi");
    expect(idsFor("outsideYourUsualReads")).not.toContain("kagurabachi");
    expect(tasteRowIds).not.toContain("quiet-romance");
    expect(idsFor("outsideYourUsualReads")).toContain("quiet-romance");
  });

  it("folds genre spellings and counts a genre once per library work", () => {
    const aliasProfile = buildTasteProfile([
      {
        id: "romcom",
        title: "Rom-com",
        tags: ["Romantic Comedy", "Shonen", "Battle / Action", "Action"],
        contentType: "manga",
        userRating: 9,
        status: "completed",
      },
    ]);
    const weight = aliasProfile.tagWeights.get("action");

    expect([...aliasProfile.tagWeights.keys()].sort()).toEqual(["action", "comedy", "romance", "shounen"]);
    for (const tag of ["comedy", "romance", "shounen"]) {
      expect(aliasProfile.tagWeights.get(tag)).toBe(weight);
    }
    expect(scoreRecommendationCandidate(
      candidate("tracker-romcom", { tags: ["Romance", "Comedy", "Shounen"], contentType: "manga" }),
      aliasProfile,
      NOW,
    ).matchedTagCount).toBe(3);
  });

  it("applies a blocked genre to compound source labels without widening a blocked compound", () => {
    const sourceProvider = [
      { providerId: "source", providerName: "Source", kind: "source" as const, availability: normalizeScore(1, 1, 0.8) },
    ];
    const sections = buildRecommendationSections([
      candidate("compound-action", { tags: ["Battle / Action"], providers: sourceProvider }),
      candidate("romcom", { tags: ["Romantic Comedy"], providers: sourceProvider }),
      candidate("plain-comedy", { tags: ["Comedy"], providers: sourceProvider }),
    ], profile, {
      blockedTags: ["Action", "Romantic Comedy"],
      nowMs: NOW,
    });
    const ids = sections.flatMap((section) => section.items.map((item) => item.candidate.id));

    expect(ids).not.toContain("compound-action");
    expect(ids).not.toContain("romcom");
    expect(ids).toContain("plain-comedy");
  });
});
