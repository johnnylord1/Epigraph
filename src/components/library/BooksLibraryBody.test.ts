import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BooksSectionVM } from "../../lib/library/contracts";
import type { BookEntry } from "../../lib/books/types";
import { store } from "../../store/state.svelte";

let dragHandler: ((event: { payload: { type: string; paths: string[] } }) => void) | undefined;

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: async (callback: typeof dragHandler) => {
      dragHandler = callback;
      return () => {
        dragHandler = undefined;
      };
    },
  }),
}));

describe("BooksLibraryBody", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    store.activeBookId = null;
    store.libraryScrollTop = 0;
    dragHandler = undefined;
  });

  test("keeps drag-and-drop overlay and book-open ownership outside the shared grid", async () => {
    const { default: BooksLibraryBody } = await import("./BooksLibraryBody.svelte");

    const book = {
      id: "book-1",
      title: "Chrysalis",
      author: "RinoZ",
      description: null,
      coverPath: null,
      subtype: "epub",
      createdAt: 1,
      updatedAt: 1,
      importPath: "C:/books/chrysalis.epub",
      assetPath: "C:/books/library/chrysalis.epub",
      sectionsSummary: [],
      sectionCount: 12,
      tocCount: 12,
      spineCount: 12,
    } as BookEntry;

    const vm: BooksSectionVM = {
      kind: "books",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search books",
        sortMode: "recentlyAdded",
        sortDir: "desc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [{
        id: "book:book-1",
        title: "Chrysalis",
        subtitle: "RinoZ",
        coverSrc: null,
        coverFit: "contain",
        badges: [{ kind: "subtype", label: "EPUB" }],
        metaChips: ["12 sections"],
        progress: { primaryLabel: "0 / 12 read", secondaryLabel: "0%", percent: 0 },
        selectable: false,
        selected: false,
        disabled: false,
      }],
      dragDropEnabled: true,
      importing: false,
      dropActive: false,
    };

    render(BooksLibraryBody, {
      props: {
        vm,
        books: [book],
        totalBooks: 1,
        viewKey: "all",
      },
    });

    expect(dragHandler).toBeTypeOf("function");
    dragHandler?.({ payload: { type: "enter", paths: ["C:/books/chrysalis.epub"] } });
    expect(await screen.findByText(/Drop EPUB or PDF files here/i)).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: /Chrysalis/i }));
    expect(store.activeBookId).toBe("book-1");
  });
});
