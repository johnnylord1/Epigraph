import { describe, expect, test } from "vitest";
import { rankSearchResults } from "./ranking";
import type { SearchResult } from "./types";

const result = (id: string, title: string, group = "library"): SearchResult => ({
  id,
  type: "page",
  title,
  group,
  groupLabel: group,
  action: { kind: "navigate", page: "home" },
});

describe("search ranking", () => {
  test("prioritizes exact and prefix matches and deduplicates ids", () => {
    const ranked = rankSearchResults([result("partial", "The Moon Reader"), result("exact", "Moon"), result("exact", "Moon")], "moon", "home");
    expect(ranked.map((entry) => entry.id)).toEqual(["exact", "partial"]);
  });

  test("normalizes accents before ranking", () => {
    expect(rankSearchResults([result("one", "Ação")], "acao", "home")).toHaveLength(1);
  });

  test("does not include unrelated entries only because they belong to the active context", () => {
    const ranked = rankSearchResults([
      result("match", "Theme editor", "settings"),
      result("unrelated", "Download storage", "settings"),
    ], "theme", "settings");

    expect(ranked.map((entry) => entry.id)).toEqual(["match"]);
  });
});
