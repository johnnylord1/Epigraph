import { beforeEach, describe, expect, it } from "vitest";
import { applyAppLanguage } from "../i18n/runtime";
import { buildBooksSectionState } from "./booksSection";
import type { BookEntry, BookProgress } from "../books/types";
import type { BooksCategory } from "../../store/state.svelte";

function book(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    id: "epub-alpha",
    title: "Alpha Book",
    author: "Alice",
    description: "Desc",
    coverPath: "C:\\alpha.png",
    subtype: "epub",
    createdAt: 1,
    updatedAt: 10,
    importPath: "C:\\alpha.epub",
    assetPath: "C:\\alpha.epub",
    tocCount: 4,
    spineCount: 4,
    sectionCount: 4,
    sectionsSummary: [
      { id: "s1", label: "Section 1", href: "s1.xhtml", depth: 0 },
      { id: "s2", label: "Section 2", href: "s2.xhtml", depth: 0 },
      { id: "s3", label: "Section 3", href: "s3.xhtml", depth: 0 },
      { id: "s4", label: "Section 4", href: "s4.xhtml", depth: 0 },
    ],
    ...overrides,
  };
}

function progress(bookId: string, overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId,
    location: "loc",
    href: "chapter.xhtml",
    progressPercent: 0.5,
    lastReadAt: 50,
    ...overrides,
  };
}

function booksCategory(overrides: Partial<BooksCategory> = {}): BooksCategory {
  return {
    id: "books-category:favorites",
    name: "Favorites",
    order: 1,
    ...overrides,
  };
}

describe("buildBooksSectionState", () => {
  beforeEach(() => {
    applyAppLanguage("en");
  });

  it("derives Books category rows, type counts, and stable book ids from explicit cover input", () => {
    const alpha = book();
    const beta = book({
      id: "pdf-beta",
      title: "Beta PDF",
      author: "Bob",
      subtype: "pdf",
      coverPath: null,
      updatedAt: 20,
      sectionCount: 0,
      tocCount: 0,
      spineCount: 0,
      pageCount: 87,
      sectionsSummary: [],
    });

    const state = buildBooksSectionState({
      librarySection: "books",
      books: [alpha, beta],
      progressByBookId: new Map<string, BookProgress | undefined>([
        [alpha.id, progress(alpha.id, { progressPercent: 0.25, lastReadAt: 100 })],
        [beta.id, progress(beta.id, { progressPercent: 1, lastReadAt: 200 })],
      ]),
      coverSrcByBookId: new Map([
        [alpha.id, "book://alpha"],
        [beta.id, null],
      ]),
      categories: [booksCategory()],
      categoryAssignments: { [alpha.id]: ["books-category:favorites"] },
      activeCategoryId: null,
      typeFilter: "all",
      search: "",
      sortMode: "recentlyRead",
      sortDir: "desc",
      statusFilter: "all",
      loading: false,
      error: null,
    });

    expect(state.typeCounts).toEqual({ all: 2, epub: 1, pdf: 1, sources: 0 });
    expect(state.filteredBooks.map((entry) => entry.id)).toEqual(["pdf-beta", "epub-alpha"]);
    expect(state.vm.cards.map((card) => card.id)).toEqual(["book:pdf-beta", "book:epub-alpha"]);
    expect(state.vm.cards[0].metaChips).toEqual(["Finished"]);
    expect(state.vm.cards[1].coverSrc).toBe("book://alpha");
    expect(state.vm.cards[1].subtitle).toBe("EPUB");
    expect(state.vm.cards[1].metaChips).toEqual(["In progress"]);
    expect(state.vm.cards[1].sourceMetricBanner?.newCount).toBe(3);
    expect(state.vm.cards[1].progress?.secondaryLabel).toBe("/ 4 chapters");
    expect(state.vm.collections.map((entry) => entry.label)).toEqual(["All", "Favorites"]);
    expect(state.vm.typeOptions.map((entry) => entry.label)).toEqual(["All", "EPUB", "PDF", "Sources"]);
  });

  it("keeps a PDF in progress until its last page", () => {
    const pdf = book({
      id: "pdf-gamma",
      subtype: "pdf",
      sectionCount: 0,
      tocCount: 0,
      spineCount: 0,
      pageCount: 3,
      sectionsSummary: [],
    });
    const stateAt = (progressPercent: number) => buildBooksSectionState({
      librarySection: "books",
      books: [pdf],
      progressByBookId: new Map<string, BookProgress | undefined>([[pdf.id, progress(pdf.id, { progressPercent })]]),
      coverSrcByBookId: new Map([[pdf.id, null]]),
      categories: [],
      categoryAssignments: {},
      activeCategoryId: null,
      typeFilter: "all",
      search: "",
      sortMode: "recentlyRead",
      sortDir: "desc",
      statusFilter: "all",
      loading: false,
      error: null,
    }).vm.cards[0];

    expect(stateAt(0.5).metaChips).toEqual(["In progress"]);
    expect(stateAt(0.5).sourceMetricBanner?.newCount).toBe(1);
    expect(stateAt(1).metaChips).toEqual(["Finished"]);
  });

  it("counts a book opened at its first page as in progress", () => {
    const epub = book();
    const stateWith = (entry: BookProgress | undefined, statusFilter: "all" | "unopened" | "in_progress") => buildBooksSectionState({
      librarySection: "books",
      books: [epub],
      progressByBookId: new Map<string, BookProgress | undefined>([[epub.id, entry]]),
      coverSrcByBookId: new Map([[epub.id, null]]),
      categories: [],
      categoryAssignments: {},
      activeCategoryId: null,
      typeFilter: "all",
      search: "",
      sortMode: "recentlyRead",
      sortDir: "desc",
      statusFilter,
      loading: false,
      error: null,
    }).vm.cards;
    const opened = progress(epub.id, { progressPercent: 0 });

    expect(stateWith(opened, "all")[0].metaChips).toEqual(["In progress"]);
    expect(stateWith(opened, "in_progress")).toHaveLength(1);
    expect(stateWith(opened, "unopened")).toHaveLength(0);
    expect(stateWith(undefined, "all")[0].metaChips).toEqual(["Not started"]);
    expect(stateWith(undefined, "unopened")).toHaveLength(1);
  });

  it("keeps category, type, and status filters independent", () => {
    const alpha = book();
    const beta = book({
      id: "epub-gamma",
      title: "Gamma Stories",
      author: "Gina",
      updatedAt: 30,
    });

    const state = buildBooksSectionState({
      librarySection: "books",
      books: [alpha, beta],
      progressByBookId: new Map<string, BookProgress | undefined>([
        [alpha.id, progress(alpha.id, { progressPercent: 0 })],
        [beta.id, progress(beta.id, { progressPercent: 0.75 })],
      ]),
      coverSrcByBookId: new Map([
        [alpha.id, "book://alpha"],
        [beta.id, "book://gamma"],
      ]),
      categories: [booksCategory()],
      categoryAssignments: { [beta.id]: ["books-category:favorites"] },
      activeCategoryId: "books-category:favorites",
      typeFilter: "epub",
      search: "gamma",
      sortMode: "az",
      sortDir: "asc",
      statusFilter: "in_progress",
      loading: false,
      error: null,
    });

    expect(state.filteredBooks.map((entry) => entry.id)).toEqual(["epub-gamma"]);
    expect(state.vm.cards[0].id).toBe("book:epub-gamma");
    expect(state.vm.emptyMessage).toBe("");
    expect(state.vm.collections[1].active).toBe(true);
    expect(state.vm.typeOptions.find((entry) => entry.id === "epub")?.active).toBe(true);
  });

  it("shows the dedicated zero-state message for Sources", () => {
    const state = buildBooksSectionState({
      librarySection: "books",
      books: [book()],
      progressByBookId: new Map<string, BookProgress | undefined>(),
      coverSrcByBookId: new Map(),
      categories: [],
      categoryAssignments: {},
      activeCategoryId: null,
      typeFilter: "sources",
      search: "",
      sortMode: "recentlyAdded",
      sortDir: "desc",
      statusFilter: "all",
      loading: false,
      error: null,
    });

    expect(state.filteredBooks).toEqual([]);
    expect(state.vm.emptyMessage).toBe("No source novels in this library yet.");
    expect(state.vm.dragDropEnabled).toBe(false);
  });

  it("marks metadata-only books as disabled with an explicit missing-file state", () => {
    const state = buildBooksSectionState({
      librarySection: "books",
      books: [
        book({
          id: "metadata-only-epub",
          coverPath: null,
          importPath: "",
          assetPath: "",
        }),
      ],
      progressByBookId: new Map<string, BookProgress | undefined>([
        ["metadata-only-epub", progress("metadata-only-epub", { progressPercent: 0.5 })],
      ]),
      coverSrcByBookId: new Map(),
      categories: [],
      categoryAssignments: {},
      activeCategoryId: null,
      typeFilter: "all",
      search: "",
      sortMode: "recentlyAdded",
      sortDir: "desc",
      statusFilter: "all",
      loading: false,
      error: null,
    });

    expect(state.vm.cards[0]).toEqual(
      expect.objectContaining({
        disabled: true,
        metaChips: expect.arrayContaining(["Metadata only"]),
        badges: expect.arrayContaining([
          expect.objectContaining({ kind: "status", label: "Missing file" }),
        ]),
        sourceMetricBanner: expect.objectContaining({ newCount: 2 }),
      }),
    );
  });

  it("sorts recently added by import date, not by the last progress update", () => {
    const state = buildBooksSectionState({
      librarySection: "books",
      books: [
        book({ id: "epub-old", title: "Old Import", createdAt: 100, updatedAt: 900 }),
        book({ id: "epub-new", title: "New Import", createdAt: 500, updatedAt: 600 }),
      ],
      progressByBookId: new Map<string, BookProgress | undefined>(),
      coverSrcByBookId: new Map(),
      categories: [],
      categoryAssignments: {},
      activeCategoryId: null,
      typeFilter: "all",
      search: "",
      sortMode: "recentlyAdded",
      sortDir: "desc",
      statusFilter: "all",
      loading: false,
      error: null,
    });

    expect(state.filteredBooks.map((entry) => entry.title)).toEqual(["New Import", "Old Import"]);
  });
});
