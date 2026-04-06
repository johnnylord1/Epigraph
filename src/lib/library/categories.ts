import type { Category } from "../types";

export const COMPLETED_CATEGORY_NAME = "Completed";
export const COMPLETED_CATEGORY_LABEL = "Finished";

function normalizeCategoryToken(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

export function isCompletedCategory(category: Pick<Category, "name"> | null | undefined): boolean {
  return normalizeCategoryToken(category?.name) === normalizeCategoryToken(COMPLETED_CATEGORY_NAME);
}

export function normalizeCategories<T extends Category>(cats: T[]): T[] {
  const seenIds = new Set<number>();
  let sawCompleted = false;

  return cats.filter((cat) => {
    if (seenIds.has(cat.id)) return false;
    seenIds.add(cat.id);

    if (!isCompletedCategory(cat)) return true;
    if (sawCompleted) return false;

    sawCompleted = true;
    return true;
  });
}

export function getCategoryDisplayName(category: Pick<Category, "name"> | null | undefined): string {
  if (!category) return "";
  return isCompletedCategory(category) ? COMPLETED_CATEGORY_LABEL : category.name;
}
