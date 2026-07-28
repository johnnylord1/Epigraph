import { describe, expect, test } from "vitest";
import { normalizeSearchText, searchTokens } from "./normalize";

describe("search normalization", () => {
  test("folds case, accents, punctuation, and whitespace", () => {
    expect(normalizeSearchText("  Ação — São   Paulo! ")).toBe("acao sao paulo");
  });

  test("removes short stop words from ranking tokens", () => {
    expect(searchTokens("A Tale of the Moon")).toEqual(["tale", "moon"]);
  });
});
