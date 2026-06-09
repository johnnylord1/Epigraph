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

  it("keeps unknown titles cheap and unchanged", () => {
    expect(canonicalNovelTitleCandidates("A Brand New Novel")).toEqual(["A Brand New Novel"]);
  });
});
