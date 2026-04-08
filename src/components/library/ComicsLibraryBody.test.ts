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
});
