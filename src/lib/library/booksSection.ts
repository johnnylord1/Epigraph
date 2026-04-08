import { createBookLibraryCardId } from "./cardIdentity";
import type {
  BooksLibraryActions,
  BooksSectionVM,
  BooksStatusFilterId,
  BooksTypeFilterId,
  BooksTypeOptionVM,
  LibraryFilterOptionVM,
  LibrarySectionKind,
  LibrarySortOptionVM,
} from "./contracts";
import {
  BOOKS_ALL_CATEGORY_ID,
  buildBooksCategoryCollections,
  filterBookIdsByCategory,
} from "./domainCategories";
import { hasBookLocalAsset } from "../books/availability";
import { presentBookWithCoverSrc } from "../books/presentation";
import { getBookSectionCount } from "../books/summary";
import type { BookEntry, BookProgress } from "../books/types";
import type {
  BooksCategory,
  BooksLibraryStatusFilter,
  BooksLibraryTypeFilter,
  LibrarySortDir,
} from "../../store/state.svelte";

export type BooksLibrarySortMode = "az" | "author" | "recentlyAdded" | "recentlyRead" | "sectionCount";

export interface BuildBooksSectionInput {
  librarySection: LibrarySectionKind;
  profileLabel?: string | null;
  books: BookEntry[];
  progressByBookId: ReadonlyMap<string, BookProgress | undefined>;
  coverSrcByBookId?: ReadonlyMap<string, string | null>;
  categories: BooksCategory[];
  categoryAssignments: Record<string, string[]>;
  activeCategoryId: string | null;
  typeFilter: BooksLibraryTypeFilter;
  search: string;
  sortMode: BooksLibrarySortMode;
  sortDir: LibrarySortDir;
  statusFilter: BooksLibraryStatusFilter;
  loading: boolean;
  error: string | null;
  importing?: boolean;
  dropActive?: boolean;
}

export interface BooksSectionState {
  typeCounts: Record<BooksTypeFilterId, number>;
  filteredBooks: BookEntry[];
  vm: BooksSectionVM;
}

export const BOOKS_SORT_OPTIONS: LibrarySortOptionVM[] = [
  { id: "az", label: "A-Z" },
  { id: "author", label: "Author" },
  { id: "recentlyAdded", label: "Recently added" },
  { id: "recentlyRead", label: "Recently read" },
  { id: "sectionCount", label: "Book contents" },
];

export const BOOKS_FILTER_OPTIONS: LibraryFilterOptionVM[] = [
  { id: "all", label: "All books" },
  { id: "unopened", label: "Unopened" },
  { id: "in_progress", label: "In progress" },
  { id: "finished", label: "Finished" },
];

function buildSectionTabs(librarySection: LibrarySectionKind) {
  return [
    { id: "comics" as const, label: "Comics", icon: "stack" as const, active: librarySection === "comics" },
    { id: "books" as const, label: "Books", icon: "book" as const, active: librarySection === "books" },
  ];
}

function buildStatusFilteredBooks(
  books: BookEntry[],
  progressByBookId: ReadonlyMap<string, BookProgress | undefined>,
  statusFilter: BooksLibraryStatusFilter,
): BookEntry[] {
  if (statusFilter === "all") return books;

  return books.filter((book) => {
    const pct = progressByBookId.get(book.id)?.progressPercent ?? 0;
    switch (statusFilter) {
      case "unopened":
        return pct <= 0.001;
      case "in_progress":
        return pct > 0.001 && pct < 0.98;
      case "finished":
        return pct >= 0.98;
      default:
        return true;
    }
  });
}

function buildTypeCounts(categoryScopedBooks: BookEntry[]): Record<BooksTypeFilterId, number> {
  const epub = categoryScopedBooks.filter((book) => book.subtype === "epub").length;
  const pdf = categoryScopedBooks.filter((book) => book.subtype === "pdf").length;
  return {
    all: categoryScopedBooks.length,
    epub,
    pdf,
    sources: 0,
  };
}

function buildTypeOptions(
  activeType: BooksLibraryTypeFilter,
  typeCounts: Record<BooksTypeFilterId, number>,
): BooksTypeOptionVM[] {
  return [
    { id: "all", label: "All", count: typeCounts.all, active: activeType === "all" },
    { id: "epub", label: "EPUB", count: typeCounts.epub, active: activeType === "epub" },
    { id: "pdf", label: "PDF", count: typeCounts.pdf, active: activeType === "pdf" },
    { id: "sources", label: "Sources", count: typeCounts.sources, active: activeType === "sources" },
  ];
}

function buildTypeFilteredBooks(
  books: BookEntry[],
  typeFilter: BooksLibraryTypeFilter,
): BookEntry[] {
  if (typeFilter === "all") return books;
  if (typeFilter === "sources") return [];
  return books.filter((book) => book.subtype === typeFilter);
}

function buildSearchFilteredBooks(books: BookEntry[], search: string): BookEntry[] {
  const query = search.trim().toLowerCase();
  if (!query) return books;

  return books.filter((book) => {
    const title = book.title.toLowerCase();
    const author = book.author?.toLowerCase() ?? "";
    return title.includes(query) || author.includes(query);
  });
}

function sortBooks(
  books: BookEntry[],
  progressByBookId: ReadonlyMap<string, BookProgress | undefined>,
  sortMode: BooksLibrarySortMode,
  sortDir: LibrarySortDir,
): BookEntry[] {
  return [...books].sort((left, right) => {
    const leftProgress = progressByBookId.get(left.id);
    const rightProgress = progressByBookId.get(right.id);
    let cmp = 0;

    switch (sortMode) {
      case "az":
        cmp = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        break;
      case "author":
        cmp = (left.author ?? "").localeCompare(right.author ?? "", undefined, { sensitivity: "base" });
        if (cmp === 0) {
          cmp = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
        }
        break;
      case "recentlyAdded":
        cmp = left.updatedAt - right.updatedAt;
        break;
      case "recentlyRead":
        cmp = (leftProgress?.lastReadAt ?? 0) - (rightProgress?.lastReadAt ?? 0);
        break;
      case "sectionCount":
        cmp = getBookSectionCount(left) - getBookSectionCount(right);
        break;
    }

    return sortDir === "asc" ? cmp : -cmp;
  });
}

function buildBooksEmptyMessage(
  input: BuildBooksSectionInput,
  filteredBooks: BookEntry[],
): string {
  if (input.typeFilter === "sources" && input.books.length >= 0) {
    return "No books from sources yet.";
  }
  if (input.books.length === 0) {
    if (input.profileLabel) {
      return `This ${input.profileLabel} profile has no imported books yet. Drag EPUB or PDF files here to import them.`;
    }
    return "Drag EPUB or PDF files into the Books shelf to import them.";
  }
  if (filteredBooks.length === 0) {
    return "No books match the current search or filters.";
  }
  return "";
}

function buildCategoryScopedBooks(input: BuildBooksSectionInput): BookEntry[] {
  const ids = filterBookIdsByCategory(
    input.books.map((book) => book.id),
    input.activeCategoryId,
    input.categoryAssignments,
  );
  const allowedIds = new Set(ids);
  return input.activeCategoryId ? input.books.filter((book) => allowedIds.has(book.id)) : [...input.books];
}

export function buildFilteredBooks(input: BuildBooksSectionInput): BookEntry[] {
  const categoryScoped = buildCategoryScopedBooks(input);
  const typeFiltered = buildTypeFilteredBooks(categoryScoped, input.typeFilter);
  const statusFiltered = buildStatusFilteredBooks(typeFiltered, input.progressByBookId, input.statusFilter);
  const searched = buildSearchFilteredBooks(statusFiltered, input.search);
  return sortBooks(searched, input.progressByBookId, input.sortMode, input.sortDir);
}

export function buildBooksSectionState(input: BuildBooksSectionInput): BooksSectionState {
  const categoryScopedBooks = buildCategoryScopedBooks(input);
  const typeCounts = buildTypeCounts(categoryScopedBooks);
  const filteredBooks = buildFilteredBooks(input);
  const coverSrcByBookId = input.coverSrcByBookId ?? new Map<string, string | null>();

  const vm: BooksSectionVM = {
    kind: "books",
    sectionTabs: buildSectionTabs(input.librarySection),
    collections: buildBooksCategoryCollections(
      input.categories,
      input.categoryAssignments,
      input.activeCategoryId,
      input.books.length,
    ),
    typeOptions: buildTypeOptions(input.typeFilter, typeCounts),
    activeCategoryId: input.activeCategoryId,
    activeType: input.typeFilter,
    activeStatus: input.statusFilter,
    toolbar: {
      searchValue: input.search,
      searchPlaceholder: "Search books",
      sortMode: input.sortMode,
      sortDir: input.sortDir,
      sortOptions: BOOKS_SORT_OPTIONS,
      filterValue: input.statusFilter,
      filterOptions: BOOKS_FILTER_OPTIONS,
    },
    loading: input.loading,
    error: input.error,
    emptyMessage: buildBooksEmptyMessage(input, filteredBooks),
    cards: filteredBooks.map((book) => {
      const progress = input.progressByBookId.get(book.id);
      const coverSrc = coverSrcByBookId.get(book.id) ?? null;
      const presented = presentBookWithCoverSrc(book, progress, coverSrc);
      const hasLocalAsset = hasBookLocalAsset(book);
      const badges = [{ kind: "subtype" as const, label: presented.subtypeLabel }];
      if (!hasLocalAsset) {
        badges.push({ kind: "status" as const, label: "Missing file" });
      }
      const metaChips = [presented.sectionCountLabel];
      if (!hasLocalAsset) {
        metaChips.push("Metadata only");
      }

      return {
        id: createBookLibraryCardId(book.id),
        title: presented.title,
        subtitle: presented.authorLabel,
        coverSrc: presented.coverSrc,
        coverFit: "cover" as const,
        badges,
        metaChips,
        progress: presented.showProgress
          ? {
              primaryLabel: presented.progressSummary,
              secondaryLabel: presented.readPercentLabel,
              percent: presented.readPercent,
            }
          : null,
        selectable: false,
        selected: false,
        disabled: !hasLocalAsset,
      };
    }),
    dragDropEnabled: input.typeFilter !== "sources",
    importing: input.importing ?? false,
    dropActive: input.dropActive ?? false,
  };

  return {
    typeCounts,
    filteredBooks,
    vm,
  };
}

export function buildBooksSectionVM(input: BuildBooksSectionInput): BooksSectionVM {
  return buildBooksSectionState(input).vm;
}

export function normalizeBooksCategorySelection(collectionId: string): string | null {
  return collectionId === BOOKS_ALL_CATEGORY_ID ? null : collectionId;
}

export function createBooksLibraryActions(actions: BooksLibraryActions): BooksLibraryActions {
  return actions;
}
