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

export function completedCategoryCleanupPlan<T extends Category>(
  cats: T[],
): { keep: T | null; duplicates: T[] } {
  const completed = cats.filter(isCompletedCategory);
  if (completed.length === 0) return { keep: null, duplicates: [] };

  const sorted = [...completed].sort((a, b) => {
    if (a.default !== b.default) return a.default ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.id - b.id;
  });
  return { keep: sorted[0] ?? null, duplicates: sorted.slice(1) };
}

// Duplicate cleanup uses a summary refetch with no members, so reload membership when needed.
export async function loadCategoriesWithMembers<T extends Category>(
  fetchWithMembers: () => Promise<T[]>,
  ensureCompleted: (categories: T[]) => Promise<T[]>,
): Promise<T[]> {
  const categories = await ensureCompleted(await fetchWithMembers());
  if (categories.some((category) => Array.isArray(category.mangas?.nodes))) return categories;
  return normalizeCategories(await fetchWithMembers());
}

export function getCategoryDisplayName(category: Pick<Category, "name"> | null | undefined): string {
  if (!category) return "";
  return isCompletedCategory(category) ? COMPLETED_CATEGORY_LABEL : category.name;
}
