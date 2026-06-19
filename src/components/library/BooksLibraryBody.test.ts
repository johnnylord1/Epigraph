import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BooksSectionVM } from "../../lib/library/contracts";
import type { BookEntry } from "../../lib/books/types";
import type { PersistedNovelLibraryEntry } from "../../lib/novels/domain";
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

  test("renders large book shelves through the virtual grid lazy resolver", async () => {
    const { default: BooksLibraryBody } = await import("./BooksLibraryBody.svelte");

    const books = Array.from({ length: 240 }, (_, index) => ({
      id: `book-${index}`,
      title: `Book ${index}`,
      author: null,
      description: null,
      coverPath: null,
      subtype: "epub",
      createdAt: index,
      updatedAt: index,
      importPath: `C:/books/book-${index}.epub`,
      assetPath: `C:/books/library/book-${index}.epub`,
      sectionsSummary: [],
      sectionCount: 1,
      tocCount: 1,
      spineCount: 1,
    })) as BookEntry[];

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
      cards: [],
      dragDropEnabled: false,
      importing: false,
      dropActive: false,
    };

    const { container } = render(BooksLibraryBody, {
      props: {
        vm,
        books,
        totalBooks: books.length,
        viewKey: "large",
        viewMode: "grid",
        preferredColumns: "auto",
        showProgress: true,
        showOutline: true,
      },
    });

    expect(container.querySelector(".virtual-grid")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Book 0" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Book 0" }));
    expect(store.activeBookId).toBe("book-0");
  });

  test("keeps a broken source novel cover on the placeholder", async () => {
    const { default: BooksLibraryBody } = await import("./BooksLibraryBody.svelte");

    const novel = {
      id: "novel-1",
      title: "Source Novel",
      author: "Author",
      description: null,
      coverUrl: "https://example.test/cover.jpg",
      path: "/novel/1",
      status: "Ongoing",
      tags: [],
      chapterCount: 4,
      addedAt: 1,
      updatedAt: 2,
      source: {
        repositoryUrl: "https://example.test/plugins.json",
        repositoryName: "Test",
        pluginId: "plugin-1",
        pluginName: "Plugin One",
        pluginVersion: "1.0.0",
        sourceId: "source-1",
        sourceName: "Source One",
        lang: "en",
      },
    } as PersistedNovelLibraryEntry;

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
      cards: [],
      dragDropEnabled: false,
      importing: false,
      dropActive: false,
    };

    const { container } = render(BooksLibraryBody, {
      props: {
        vm,
        books: [],
        totalBooks: 0,
        novelEntries: [novel],
        viewKey: "novels",
        viewMode: "grid",
        preferredColumns: "auto",
        showProgress: true,
        showOutline: true,
      },
    });

    const img = await screen.findByAltText("Source Novel");
    expect(img).toHaveAttribute("src", "https://example.test/cover.jpg");

    await fireEvent.error(img);

    expect(container.querySelector("img.cover")).toBeNull();
    expect(container.querySelector(".cover-fallback")).toBeTruthy();
  });

  test("renders large source novel shelves through the virtual grid lazy resolver", async () => {
    const { default: BooksLibraryBody } = await import("./BooksLibraryBody.svelte");

    const novels = Array.from({ length: 320 }, (_, index) => ({
      id: `novel-${index}`,
      title: `Novel ${index}`,
      author: index % 2 === 0 ? "Author" : null,
      description: null,
      coverUrl: null,
      path: `/novel/${index}`,
      status: index % 3 === 0 ? "Ongoing" : "Completed",
      tags: ["Fantasy"],
      chapterCount: 12,
      addedAt: index,
      updatedAt: index,
      source: {
        repositoryUrl: "https://example.test/plugins.json",
        repositoryName: "Test",
        pluginId: "plugin-1",
        pluginName: "Plugin One",
        pluginVersion: "1.0.0",
        sourceId: "source-1",
        sourceName: "Source One",
        lang: "en",
      },
    })) as PersistedNovelLibraryEntry[];

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
      cards: [],
      dragDropEnabled: false,
      importing: false,
      dropActive: false,
    };
    const onOpenNovel = vi.fn();
    const target = document.createElement("div");
    target.style.cssText = "display:flex;width:1280px;height:720px;min-height:0;";
    document.body.appendChild(target);

    const { container } = render(BooksLibraryBody, {
      target,
      props: {
        vm,
        books: [],
        totalBooks: 0,
        novelEntries: novels,
        onOpenNovel,
        viewKey: "large-novels",
        viewMode: "grid",
        preferredColumns: "auto",
        showProgress: true,
        showOutline: true,
      },
    });

    expect(container.querySelector(".virtual-grid")).toBeTruthy();
    expect(container.querySelectorAll("[data-card-id]").length).toBeLessThan(80);
    expect(await screen.findByRole("button", { name: /Novel 0/i })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: /Novel 0/i }));

    expect(onOpenNovel).toHaveBeenCalledWith("novel-0");
    expect(store.activeBookId).toBeNull();
  });
});
