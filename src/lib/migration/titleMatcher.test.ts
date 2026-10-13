import { describe, expect, it } from "vitest";
import {
  MIN_TITLE_MATCH_SCORE,
  alternativeTitles,
  bestTitleScore,
  mainTitle,
  significantWords,
  titleScore,
  titleSearchQueries,
} from "./titleMatcher";

describe("titleMatcher", () => {
  it("ignores punctuation, dashes, case, quotes and accents", () => {
    expect(titleScore(
      "A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right",
      "A pig-slaughtering knife cutting through all realms — makes sense, right?",
    )).toBe(1);
    expect(titleScore("Doctor’s Rebirth", "Doctor's Rebirth")).toBe(1);
    expect(titleScore("Pokémon Adventures", "Pokemon Adventures")).toBe(1);
  });

  it("ranks the exact title above a similar one and rejects look-alikes", () => {
    const wanted = "After Rebirth, I Used Mirror Reversal For Vengeance";
    expect(bestTitleScore(wanted, "After Rebirth, I Used Mirror Reversal for Vengeance")).toBe(1);
    expect(bestTitleScore(wanted, "After Rebirth, I Married My Scumbag Ex's Arch-Enemy")).toBeLessThan(MIN_TITLE_MATCH_SCORE);
    expect(bestTitleScore(wanted, "Touken Ranbu - Reversal Mirror")).toBeLessThan(MIN_TITLE_MATCH_SCORE);
  });

  it("matches a title with or without its subtitle, below the full title", () => {
    const partial = titleScore("Apotheosis", "Apotheosis – Ascension To Godhood");
    expect(partial).toBeGreaterThanOrEqual(MIN_TITLE_MATCH_SCORE);
    expect(partial).toBeLessThan(1);
    expect(titleScore("Apotheosis", "The Spring-Autumn Apotheosis")).toBeLessThan(MIN_TITLE_MATCH_SCORE);
  });

  it("builds plain and shorter fallback queries", () => {
    const queries = titleSearchQueries("A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right");
    expect(queries[0]).toBe("A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right");
    expect(queries).toContain("a pig slaughtering knife cutting through all realms makes sense right");
    expect(queries).toContain("a pig slaughtering knife cutting through all realms");
    expect(titleSearchQueries("Apotheosis")).toEqual(["Apotheosis"]);
  });

  it("drops brackets and subtitles from the main title", () => {
    expect(mainTitle("Solo Leveling: Ragnarok")).toBe("Solo Leveling");
    expect(mainTitle("Berserk (Official)")).toBe("Berserk");
    expect(mainTitle("Pig-Slaughtering")).toBeNull();
  });

  it("reads other names from a listed or inline description block", () => {
    const listed = "Story text.\n\n**Alternative Names**:\n- A Pig-Slaughtering Knife Cutting Through All Realms - Makes Sense, Right?\n"
      + "- Pig Slayer\n\n**Year**: 2025\n**Language**: ZH";
    expect(alternativeTitles(listed)).toEqual([
      "A Pig-Slaughtering Knife Cutting Through All Realms - Makes Sense, Right?",
      "Pig Slayer",
    ]);
    expect(alternativeTitles("Alternative Names: Solo Leveling • Only I Level Up\nStatus: Ongoing"))
      .toEqual(["Solo Leveling", "Only I Level Up"]);
    expect(alternativeTitles("A hunter wakes up. **Year**: 2018")).toEqual([]);
    expect(alternativeTitles(null)).toEqual([]);
  });

  it("keeps only the words long enough to tell series apart", () => {
    expect([...significantWords("Almighty Pig-Slaughtering Knife")]).toEqual(["almighty", "pig", "slaughtering", "knife"]);
    expect([...significantWords("The God of War")]).toEqual(["the", "god", "war"]);
  });
});
