import { describe, expect, it } from "vitest";
import type { Manga, Tracker } from "../types";
import type { BookEntry } from "../books/types";
import { buildSearchRecommendations, normalizeScore, recommendationTitleKey, recommendationTrackerRemoteKey } from ".";

describe("search recommendation engine", () => {
  it("builds a taste profile, merges candidate sources, and returns renderable sections", () => {
    const favorite = createManga({
      id: 1,
      title: "Dungeon Favorite",
      genre: ["Action", "Dungeon"],
      inLibrary: true,
    });
    const sourceHit = createManga({
      id: 2,
      title: "Shared Hit",
      genre: ["Action", "Regression"],
      inLibrary: false,
    });
    const trackers: Tracker[] = [
      {
        id: 10,
        name: "AniList",
        icon: "",
        isLoggedIn: true,
        authUrl: null,
        supportsPrivateTracking: false,
        scores: [],
        statuses: [],
      },
    ];

    const result = buildSearchRecommendations({
      libraryManga: [favorite],
      sourceResults: [sourceHit],
      trackerResults: [
        {
          id: 10,
          trackerId: 10,
          remoteId: "shared",
          title: "Shared Hit",
          coverUrl: null,
          summary: null,
          publishingStatus: "RELEASING",
          publishingType: "MANHWA",
          startDate: "2026-01-01",
          totalChapters: 0,
          trackingUrl: null,
        },
      ],
      trackers,
      extraCandidates: [
        {
          id: "tracker-scored",
          title: "Tracker Scored",
          tags: ["Action"],
          contentType: "manhwa",
          providers: [
            {
              providerId: "10",
              providerName: "AniList",
              kind: "tracker",
              score: normalizeScore(90, 100, 0.9),
            },
          ],
        },
      ],
    }, {
      includeInLibrary: false,
      nowMs: Date.parse("2026-04-27T12:00:00.000Z"),
    });

    expect(result.profile.topTags).toContain("action");
    expect(result.candidates.find((candidate) => candidate.title === "Shared Hit")?.providers)
      .toHaveLength(2);
    expect(result.sections.some((section) => section.items.length > 0)).toBe(true);
    expect(result.sections.flatMap((section) => section.items).some((item) => item.candidate.id === "manga:1"))
      .toBe(false);
  });

  it("uses known local and tracker libraries as taste input without recommending them by default", () => {
    const favorite = createManga({
      id: 1,
      title: "Dungeon Favorite",
      genre: ["Action", "Dungeon"],
      inLibrary: true,
    });
    const localDuplicate = createManga({
      id: 2,
      title: "Dungeon Favorite",
      genre: ["Action"],
      inLibrary: false,
    });
    const newSourceHit = createManga({
      id: 3,
      title: "Brand New Dungeon",
      genre: ["Action", "Dungeon"],
      inLibrary: false,
    });
    const knownRemoteKey = recommendationTrackerRemoteKey(10, "known-remote");
    const knownTitleKey = recommendationTitleKey("Dungeon Favorite", "manga");
    const knownTrackerTitleKey = recommendationTitleKey("Known Tracker Title", "manga");

    const hiddenResult = buildSearchRecommendations({
      libraryManga: [favorite],
      sourceResults: [localDuplicate, newSourceHit],
      trackerResults: [
        {
          id: 10,
          trackerId: 10,
          remoteId: "known-remote",
          title: "Known Tracker Title",
          coverUrl: "https://example.com/known.jpg",
          summary: null,
          publishingStatus: "RELEASING",
          publishingType: "MANGA",
          startDate: "2026-01-01",
          totalChapters: 0,
          trackingUrl: null,
          score: 90,
          scoreMax: 100,
        },
      ],
    }, {
      includeInLibrary: false,
      knownTitleKeys: [knownTitleKey, knownTrackerTitleKey],
      knownProviderKeys: knownRemoteKey ? [knownRemoteKey] : [],
      nowMs: Date.parse("2026-04-27T12:00:00.000Z"),
    });

    const hiddenIds = hiddenResult.sections.flatMap((section) => section.items.map((item) => item.candidate.id));
    expect(hiddenResult.profile.topTags).toContain("action");
    expect(hiddenIds).not.toContain("manga:1");
    expect(hiddenIds).not.toContain("manga:2");
    expect(hiddenIds).not.toContain("tracker:10:known-remote");
    expect(hiddenIds).toContain("manga:3");

    const includedResult = buildSearchRecommendations({
      libraryManga: [favorite],
      sourceResults: [localDuplicate, newSourceHit],
      trackerResults: [],
    }, {
      includeInLibrary: true,
      knownTitleKeys: [knownTitleKey, knownTrackerTitleKey],
      nowMs: Date.parse("2026-04-27T12:00:00.000Z"),
    });

    const includedTitles = includedResult.sections.flatMap((section) => section.items.map((item) => item.candidate.title));
    expect(includedTitles).toContain("Dungeon Favorite");
  });

  it("supports prose recommendations from novels and local books without tracker input", () => {
    const book: BookEntry = {
      id: "book-1",
      title: "Local EPUB",
      author: "Novel Author",
      description: null,
      coverPath: null,
      subtype: "epub",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      updatedAt: Date.parse("2026-04-01T00:00:00.000Z"),
      importPath: "local.epub",
      assetPath: "local.epub",
      sectionCount: 24,
    };

    const result = buildSearchRecommendations({
      libraryBooks: [book],
      tagsByBookId: new Map([["book-1", ["Fantasy"]]]),
      libraryNovels: [
        {
          id: "novel-1",
          title: "Central Novel",
          author: "Novel Author",
          description: null,
          coverUrl: null,
          path: "/central",
          status: "ongoing",
          tags: ["Fantasy", "Cultivation"],
          source: {
            id: "central",
            name: "Central Novel",
            lang: "pt",
            site: "https://centralnovel.com",
          },
          chapterCount: 88,
          addedAt: 0,
          updatedAt: Date.parse("2026-04-10T00:00:00.000Z"),
        },
      ],
    }, {
      includeInLibrary: true,
      nowMs: Date.parse("2026-04-27T12:00:00.000Z"),
    });

    expect(result.profile.topTags).toContain("fantasy");
    expect(result.profile.topTags).toContain("cultivation");
    expect(result.profile.topTags).not.toContain("epub");
    expect(result.profile.topTags).not.toContain("novel");
    expect(result.candidates.map((candidate) => candidate.contentType).sort()).toEqual(["book", "novel"]);
    expect(result.sections.some((section) => section.items.length > 0)).toBe(true);
  });
});

function createManga(patch: Partial<Manga>): Manga {
  return {
    id: 1,
    title: "Title",
    thumbnailUrl: "",
    inLibrary: false,
    genre: [],
    source: {
      id: "source",
      name: "Source",
      displayName: "Source",
    },
    ...patch,
  };
}
