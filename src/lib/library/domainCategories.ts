import type { BooksCategory } from "../../store/state.svelte";
import type { LibraryCollectionVM } from "./contracts";

export type LibraryCategoryDomain = "comics" | "books";

export const BOOKS_ALL_CATEGORY_ID = "all";

export interface BooksCategoryMutationResult {
  categories: BooksCategory[];
  assignments: Record<string, string[]>;
}

export function sortBooksCategories(categories: BooksCategory[]): BooksCategory[] {
  return [...categories].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

export function normalizeBooksCategoryAssignments(
  assignments: Record<string, string[]>,
  validCategoryIds: Iterable<string>,
): Record<string, string[]> {
  const valid = new Set(validCategoryIds);
  return Object.fromEntries(
    Object.entries(assignments).map(([bookId, ids]) => [
      bookId,
      [...new Set((ids ?? []).filter((id) => valid.has(id)))],
    ]),
  );
}

export function countBooksForCategory(
  categoryId: string,
  assignments: Record<string, string[]>,
): number {
  let count = 0;
  for (const ids of Object.values(assignments)) {
    if (ids.includes(categoryId)) count += 1;
  }
  return count;
}

export function isBookAssignedToCategory(
  bookId: string,
  categoryId: string,
  assignments: Record<string, string[]>,
): boolean {
  return (assignments[bookId] ?? []).includes(categoryId);
}

export function filterBookIdsByCategory(
  bookIds: string[],
  activeCategoryId: string | null,
  assignments: Record<string, string[]>,
): string[] {
  if (!activeCategoryId) return bookIds;
  return bookIds.filter((bookId) => isBookAssignedToCategory(bookId, activeCategoryId, assignments));
}

export function toggleBookCategoryAssignment(
  assignments: Record<string, string[]>,
  bookId: string,
  categoryId: string,
): Record<string, string[]> {
  const current = new Set(assignments[bookId] ?? []);
  if (current.has(categoryId)) current.delete(categoryId);
  else current.add(categoryId);

  return {
    ...assignments,
    [bookId]: [...current],
  };
}

export function createBooksCategory(
  categories: BooksCategory[],
  name: string,
): BooksCategory {
  const trimmed = name.trim();
  const order = (sortBooksCategories(categories).at(-1)?.order ?? 0) + 1;
  return {
    id: `books-category:${crypto.randomUUID()}`,
    name: trimmed,
    order,
    includeInUpdate: "UNSET",
  };
}

export function normalizeBooksCategoryUpdateRule(
  value: unknown,
): NonNullable<BooksCategory["includeInUpdate"]> {
  return value === "EXCLUDE" || value === "INCLUDE" ? value : "UNSET";
}

export function renameBooksCategory(
  categories: BooksCategory[],
  categoryId: string,
  name: string,
): BooksCategory[] {
  return sortBooksCategories(
    categories.map((category) =>
      category.id === categoryId ? { ...category, name: name.trim() } : category,
    ),
  );
}

export function toggleBooksCategoryUpdateRule(
  categories: BooksCategory[],
  categoryId: string,
): BooksCategory[] {
  return sortBooksCategories(
    categories.map((category) =>
      category.id === categoryId
        ? {
            ...category,
            includeInUpdate: normalizeBooksCategoryUpdateRule(category.includeInUpdate) === "EXCLUDE"
              ? "UNSET"
              : "EXCLUDE",
          }
        : category,
    ),
  );
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

export function deleteBooksCategory(
  categories: BooksCategory[],
  assignments: Record<string, string[]>,
  categoryId: string,
): BooksCategoryMutationResult {
  const nextCategories = sortBooksCategories(
    categories.filter((category) => category.id !== categoryId)
      .map((category, index) => ({ ...category, order: index + 1 })),
  );

  const nextAssignments = Object.fromEntries(
    Object.entries(assignments).map(([bookId, ids]) => [
      bookId,
      ids.filter((id) => id !== categoryId),
    ]),
  );

  return {
    categories: nextCategories,
    assignments: nextAssignments,
  };
}

export function moveBooksCategory(
  categories: BooksCategory[],
  categoryId: string,
  direction: -1 | 1,
): BooksCategory[] {
  const sortable = sortBooksCategories(categories);
  const index = sortable.findIndex((category) => category.id === categoryId);
  if (index < 0) return sortable;

  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= sortable.length) return sortable;

  const reordered = [...sortable];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(nextIndex, 0, moved);

  return reordered.map((category, orderIndex) => ({
    ...category,
    order: orderIndex + 1,
  }));
}

export function buildBooksCategoryCollections(
  categories: BooksCategory[],
  assignments: Record<string, string[]>,
  activeCategoryId: string | null,
  allCount: number,
): LibraryCollectionVM[] {
  const sorted = sortBooksCategories(categories);

  return [
    {
      id: BOOKS_ALL_CATEGORY_ID,
      label: "All",
      count: allCount,
      icon: "stack",
      active: activeCategoryId === null,
      reorderable: false,
      isDefault: true,
    },
    ...sorted.map((category) => ({
      id: category.id,
      label: category.name,
      count: countBooksForCategory(category.id, assignments),
      icon: "folder" as const,
      active: activeCategoryId === category.id,
      reorderable: true,
      isDefault: false,
    })),
  ];
}
