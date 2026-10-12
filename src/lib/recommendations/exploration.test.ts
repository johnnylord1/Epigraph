import { describe, expect, it } from "vitest";
import { ANILIST_EXPLORATION_GENRES, comicFormatCountries, explorationGenres, tasteCatalogRequests } from "./exploration";
import { recommendationTagTokens } from "./metadata";
import type { RecommendationContentType, TasteProfile } from "./types";

function profile(weights: Record<string, number>, seedCount = 40): TasteProfile {
  const tagWeights = new Map<string, number>();
  for (const [genre, weight] of Object.entries(weights)) {
    for (const token of recommendationTagTokens(genre)) tagWeights.set(token, weight);
  }
  return {
    tagWeights,
    contentTypeWeights: new Map(),
    sourceWeights: new Map(),
    topTags: [],
    positiveTags: [],
    negativeTags: [],
    seedCount,
  };
}

// A heavy action/fantasy reader who touches a few other genres now and then.
const heavyReader = profile({
  Action: 100,
  Fantasy: 90,
  Adventure: 75,
  Comedy: 30,
  Drama: 20,
  Romance: 8,
  Mystery: 2,
  Horror: -5,
});

describe("exploration genres", () => {
  it("searches the genres the reader rarely reads and leaves out the core ones", () => {
    const genres = explorationGenres(heavyReader, { limit: 20 });

    expect(genres).not.toBeNull();
    expect(genres!.include).not.toContain("Drama");
    expect(genres!.include).toContain("Sports");
    expect(genres!.include).not.toContain("Action");
    expect(genres!.include).not.toContain("Comedy");
    expect(genres!.exclude).toEqual(["Action", "Adventure", "Fantasy"]);
  });

  it("never explores the genres shown as the reader's principal ones", () => {
    const reader = { ...heavyReader, topTags: ["action", "fantasy", "adventure", "comedy", "drama", "romance"] };
    const genres = explorationGenres(reader, { limit: 20 });

    expect(genres!.include).not.toContain("Romance");
    expect(genres!.include).toContain("Sports");
    expect(genres!.exclude).toEqual(expect.arrayContaining(["Comedy", "Drama", "Romance"]));
  });

  it("searches each comic format the library holds enough of, most read first", () => {
    const reader = { ...heavyReader, contentTypeWeights: new Map<RecommendationContentType, number>([["manga", 142], ["manhwa", 290], ["manhua", 56], ["novel", 400]]) };
    expect(comicFormatCountries(reader)).toEqual(["KR", "JP", "CN"]);
    const fewManhua = { ...heavyReader, contentTypeWeights: new Map<RecommendationContentType, number>([["manga", 50], ["manhwa", 46], ["manhua", 4]]) };
    expect(comicFormatCountries(fewManhua)).toEqual(["JP", "KR"]);
  });

  it("never explores a genre the reader dislikes", () => {
    const genres = explorationGenres(heavyReader, { limit: 20 });

    expect(genres!.include).not.toContain("Horror");
    expect(genres!.exclude).not.toContain("Horror");
  });

  it("rotates through the rare genres so the row changes from day to day", () => {
    const first = explorationGenres(heavyReader, { limit: 3, rotation: 0 })!.include;
    const next = explorationGenres(heavyReader, { limit: 3, rotation: 1 })!.include;

    expect(first).toHaveLength(3);
    expect(next).toHaveLength(3);
    expect(next.slice(0, 2)).toEqual(first.slice(1));
    expect(ANILIST_EXPLORATION_GENRES).toEqual(expect.arrayContaining([...first, ...next]));
  });

  it("waits for enough reading history before exploring", () => {
    expect(explorationGenres(profile({ Action: 10 }, 3))).toBeNull();
    expect(explorationGenres(profile({}, 40))).toBeNull();
  });

  it("searches the reader's strongest genres in each comic format, in the library's proportions", () => {
    const manhwaReader = {
      ...heavyReader,
      contentTypeWeights: new Map([["manhwa", 290], ["manga", 142], ["manhua", 57], ["novel", 80]] as const),
    };

    expect(tasteCatalogRequests(manhwaReader)).toEqual([
      { country: "JP", genre: "Action", pages: 1 },
      { country: "JP", genre: "Fantasy", pages: 1 },
      { country: "KR", genre: "Action", pages: 2 },
      { country: "KR", genre: "Fantasy", pages: 1 },
      { country: "KR", genre: "Adventure", pages: 1 },
      { country: "CN", genre: "Action", pages: 1 },
    ]);
  });

  it("leaves out a format the library barely holds and never searches a disliked genre", () => {
    const mangaReader = {
      ...profile({ Horror: -5, Mystery: 40, Drama: 30 }),
      contentTypeWeights: new Map([["manga", 95], ["manhwa", 5]] as const),
    };

    expect(tasteCatalogRequests(mangaReader)).toEqual([
      { country: "JP", genre: "Mystery", pages: 3 },
      { country: "JP", genre: "Drama", pages: 3 },
    ]);
    expect(tasteCatalogRequests(profile({ Action: 10 }, 2))).toEqual([]);
  });
});
