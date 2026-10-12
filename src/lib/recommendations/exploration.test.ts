import { describe, expect, it } from "vitest";
import { ANILIST_EXPLORATION_GENRES, explorationGenres } from "./exploration";
import { recommendationTagTokens } from "./metadata";
import type { TasteProfile } from "./types";

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
});
