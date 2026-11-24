import { describe, expect, it, vi } from "vitest";
import type { Category } from "../types";
import { completedCategoryCleanupPlan, loadCategoriesWithMembers } from "./categories";

function category(id: number, name: string, memberIds?: number[]): Category {
  return {
    id,
    name,
    order: id,
    default: id === 0,
    ...(memberIds ? { mangas: { nodes: memberIds.map((mangaId) => ({ id: mangaId, inLibrary: true })) } } : {}),
  } as Category;
}

describe("completedCategoryCleanupPlan", () => {
  it("finds duplicate Completed folders before display normalization hides them", () => {
    const plan = completedCategoryCleanupPlan([
      category(8, "Completed"),
      category(4, "completed"),
      category(2, "Reading"),
      category(0, "COMPLETED"),
    ]);

    expect(plan.keep?.id).toBe(0);
    expect(plan.duplicates.map(({ id }) => id)).toEqual([4, 8]);
  });

  it("returns no keeper when Completed does not exist", () => {
    expect(completedCategoryCleanupPlan([category(1, "Reading")])).toEqual({
      keep: null,
      duplicates: [],
    });
  });
});

describe("loadCategoriesWithMembers", () => {
  it("keeps the membership when the Completed category already exists", async () => {
    const withMembers = [category(1, "Brabos", [10, 11]), category(2, "Completed", [])];
    const fetchWithMembers = vi.fn(async () => withMembers);

    const result = await loadCategoriesWithMembers(fetchWithMembers, async (categories) => categories);

    expect(result).toBe(withMembers);
    expect(fetchWithMembers).toHaveBeenCalledTimes(1);
  });

  it("fetches membership again when the ensure callback returns a summary", async () => {
    // A restored backup has user categories but no Completed category yet.
    const beforeCreate = [category(1, "Brabos", [10, 11])];
    const afterCreate = [category(1, "Brabos", [10, 11]), category(2, "Completed", [])];
    const fetchWithMembers = vi.fn()
      .mockResolvedValueOnce(beforeCreate)
      .mockResolvedValueOnce(afterCreate);
    const summary = [category(1, "Brabos"), category(2, "Completed")];

    const result = await loadCategoriesWithMembers(fetchWithMembers, async () => summary);

    expect(fetchWithMembers).toHaveBeenCalledTimes(2);
    expect(result.map((entry) => entry.mangas?.nodes.map((manga) => manga.id))).toEqual([[10, 11], []]);
  });
});
