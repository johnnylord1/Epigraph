import { describe, expect, it } from "vitest";

import { canonicalNovelTitleCandidates, normalizeNovelTitleAliasKey } from "./titleAliases";

describe("novel title aliases", () => {
  it("normalizes accents and filler title terms", () => {
    expect(normalizeNovelTitleAliasKey("Lorde dos Mistérios (Light Novel) Vol. 1")).toBe("lorde dos misterios");
  });

  it("adds known canonical English title candidates after the source title", () => {
    expect(canonicalNovelTitleCandidates("Lorde dos Mistérios")).toEqual([
      "Lorde dos Mistérios",
      "Lord of the Mysteries",
    ]);
  });

  it("adds trusted aliases for source-localized novel titles", () => {
    expect(canonicalNovelTitleCandidates("A Evolu\u00e7\u00e3o de um Goblin ao \u00c1pice")).toEqual([
      "A Evolu\u00e7\u00e3o de um Goblin ao \u00c1pice",
      "The Evolution of a Goblin to the Peak",
    ]);
  });

  it("normalizes typographic apostrophes in English titles", () => {
    expect(normalizeNovelTitleAliasKey("A Returner\u2019s Magic Should Be Special")).toBe(
      "a returners magic should be special",
    );
  });

  it("keeps unknown titles cheap and unchanged", () => {
    expect(canonicalNovelTitleCandidates("A Brand New Novel")).toEqual(["A Brand New Novel"]);
  });
});
