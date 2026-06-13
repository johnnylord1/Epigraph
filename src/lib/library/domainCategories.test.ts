import { describe, expect, it } from "vitest";

import {
  getBooksUpdateExcludedBookIds,
  toggleBooksCategoryUpdateRule,
} from "./domainCategories";
import type { BooksCategory } from "../../store/state.svelte";

function category(id: string, includeInUpdate?: BooksCategory["includeInUpdate"]): BooksCategory {
  return {
    id,
    name: id,
    order: id === "blocked" ? 1 : 2,
    includeInUpdate,
  };
}

describe("books category update rules", () => {
  it("collects every book assigned to an excluded folder", () => {
    const excluded = getBooksUpdateExcludedBookIds(
      [category("blocked", "EXCLUDE"), category("saved", "UNSET")],
      {
        "novel-a": ["blocked", "saved"],
        "novel-b": ["saved"],
        "novel-c": ["blocked"],
      },
    );

    expect([...excluded].sort()).toEqual(["novel-a", "novel-c"]);
  });

  it("toggles a folder between normal updates and skipped updates", () => {
    const [blocked] = toggleBooksCategoryUpdateRule([category("blocked", "UNSET")], "blocked");
    expect(blocked?.includeInUpdate).toBe("EXCLUDE");

    const [included] = toggleBooksCategoryUpdateRule([blocked!], "blocked");
    expect(included?.includeInUpdate).toBe("UNSET");
  });

  it("keeps old categories updateable when they do not have an explicit rule", () => {
    const excluded = getBooksUpdateExcludedBookIds(
      [category("legacy")],
      { "novel-a": ["legacy"] },
    );

    expect(excluded.size).toBe(0);
  });
});
