import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Category, Manga } from "../../lib/types";
import type { ComicsSectionVM } from "../../lib/library/contracts";
import { store } from "../../store/state.svelte";
import ComicsLibraryBody from "./ComicsLibraryBody.svelte";

describe("ComicsLibraryBody", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    store.activeManga = null;
    store.libraryScrollTop = 0;
    store.libraryVisibleCount = 0;
    store.libraryReturnToMangaId = null;
  });

  test("keeps selection and context menu ownership outside the shared grid", async () => {
    const manga = {
      id: 1,
      title: "Sample Manga",
      thumbnailUrl: null,
      inLibrary: true,
      downloadCount: 2,
      unreadCount: 4,
      source: { id: "source-1" },
    } as Manga;
    const category = {
      id: 10,
      name: "Finished",
      order: 1,
      default: false,
      mangas: { nodes: [manga] },
    } as unknown as Category;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [{
        id: "comic:1",
        title: "Sample Manga",
        subtitle: undefined,
        coverSrc: null,
        coverFit: "cover",
        badges: [{ kind: "unread", label: "4" }],
        metaChips: [],
        progress: null,
        selectable: true,
        selected: false,
        disabled: false,
      }],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    render(ComicsLibraryBody, {
      props: {
        vm,
        mangas: [manga],
        categories: [category],
        categoryMangaMap: new Map([[10, [manga]]]),
        renderLimit: 48,
        viewKey: "library",
        onRemoveFromLibrary: vi.fn(),
        onAddToLibrary: vi.fn(),
        onDeleteAllDownloads: vi.fn(),
        onToggleCategory: vi.fn(),
        onCreateAndAssign: vi.fn(),
        onCreateCategory: vi.fn(),
      },
    });

    const card = screen.getByRole("button", { name: /Sample Manga/i });
    await fireEvent.click(card, { ctrlKey: true });
    expect(await screen.findByText(/1 selected/i)).toBeTruthy();
    await fireEvent.click(screen.getByTitle(/Cancel \(Esc\)/i));

    await fireEvent.contextMenu(card);
    expect(await screen.findByText(/Select this manga/i)).toBeTruthy();
  });

  test("renders clickable cards from manga data when the section vm omits card VMs", async () => {
    const manga = {
      id: 7,
      title: "Returned From Reader",
      thumbnailUrl: null,
      inLibrary: true,
      downloadCount: 0,
      unreadCount: 3,
      chapterCount: 10,
      source: { id: "source-1", displayName: "Source One" },
    } as Manga;

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    render(ComicsLibraryBody, {
      props: {
        vm,
        mangas: [manga],
        categories: [],
        categoryMangaMap: new Map(),
        renderLimit: 48,
        viewKey: "library",
        onRemoveFromLibrary: vi.fn(),
        onAddToLibrary: vi.fn(),
        onDeleteAllDownloads: vi.fn(),
        onToggleCategory: vi.fn(),
        onCreateAndAssign: vi.fn(),
        onCreateCategory: vi.fn(),
      },
    });

    const card = screen.getByRole("button", { name: /Returned From Reader/i });
    expect(card.getAttribute("data-card-id")).toBe("comic:7");
    expect(card.textContent).toContain("3");
    expect(card.textContent).not.toContain("🌐");
    expect(card.textContent).toContain("Source One");
    expect(card.textContent).toContain("Reading");
    expect(card.textContent).not.toContain("Unknown");

    await fireEvent.click(card);
    expect(store.activeManga?.id).toBe(7);
  });

  test("renders comics in pages and loads the next page on demand", async () => {
    const mangas = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      title: `Paged Manga ${index + 1}`,
      thumbnailUrl: null,
      inLibrary: true,
      unreadCount: index + 1,
      chapterCount: 10,
      source: { id: "source-1", displayName: "Source One" },
    })) as Manga[];

    const vm: ComicsSectionVM = {
      kind: "comics",
      sectionTabs: [],
      collections: [],
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search",
        sortMode: "az",
        sortDir: "asc",
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      loading: false,
      error: null,
      emptyMessage: "Empty",
      cards: [],
      selectionEnabled: true,
      selectedIds: new Set(),
      showBulkBar: false,
    };

    render(ComicsLibraryBody, {
      props: {
        vm,
        mangas,
        categories: [],
        categoryMangaMap: new Map(),
        renderLimit: 2,
        viewKey: "library",
        onRemoveFromLibrary: vi.fn(),
        onAddToLibrary: vi.fn(),
        onDeleteAllDownloads: vi.fn(),
        onToggleCategory: vi.fn(),
        onCreateAndAssign: vi.fn(),
        onCreateCategory: vi.fn(),
      },
    });

    expect(screen.getByRole("button", { name: /Paged Manga 1/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paged Manga 2/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Paged Manga 3/i })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: /Load 2 more/i }));

    expect(screen.getByRole("button", { name: /Paged Manga 3/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paged Manga 4/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Paged Manga 5/i })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: /Paged Manga 3/i }));
    expect(store.activeManga?.id).toBe(3);
  });
});
