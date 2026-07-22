import type { BooksCategory } from "../../store/state.svelte";

export function normalizeBooksCategoryUpdateRule(
  value: unknown,
): NonNullable<BooksCategory["includeInUpdate"]> {
  return value === "EXCLUDE" || value === "INCLUDE" ? value : "UNSET";
}

export function getBooksUpdateExcludedBookIds(
  categories: readonly BooksCategory[],
  assignments: Record<string, string[]>,
): Set<string> {
  const excludedCategoryIds = new Set(
    categories
      .filter((category) => normalizeBooksCategoryUpdateRule(category.includeInUpdate) === "EXCLUDE")
      .map((category) => category.id),
  );
  if (!excludedCategoryIds.size) return new Set();

  const excludedBookIds = new Set<string>();
  for (const [bookId, categoryIds] of Object.entries(assignments)) {
    if ((categoryIds ?? []).some((categoryId) => excludedCategoryIds.has(categoryId))) {
      excludedBookIds.add(bookId);
    }
  }
  return excludedBookIds;
}
