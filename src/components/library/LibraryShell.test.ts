import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LibraryCollectionVM, LibrarySectionTabVM, LibraryToolbarVM } from "../../lib/library/contracts";
import LibraryShell from "./LibraryShell.svelte";

describe("LibraryShell", () => {
  afterEach(() => cleanup());

  test("renders the shared shell with callback-driven section chrome", async () => {
    const sectionTabs: LibrarySectionTabVM[] = [
      { id: "comics", label: "Comics", icon: "stack", active: true },
      { id: "books", label: "Books", icon: "book", active: false },
    ];
    const collections: LibraryCollectionVM[] = [
      { id: "library", label: "Saved", count: 12, icon: "books", active: true, reorderable: false, isDefault: false },
    ];
    const toolbar: LibraryToolbarVM = {
      searchValue: "",
      searchPlaceholder: "Search",
      sortMode: "az",
      sortDir: "asc",
      sortOptions: [{ id: "az", label: "A-Z" }],
      filterValue: "ALL",
      filterOptions: [{ id: "ALL", label: "All statuses" }],
    };

    const onSectionChange = vi.fn();
    const onCollectionSelect = vi.fn();

    render(LibraryShell, {
      props: {
        sectionTabs,
        collections,
        toolbar,
        branchesEnabled: false,
        sortDefaultMode: "az",
        sortDefaultDir: "asc",
        filterDefaultValue: "ALL",
        onSectionChange,
        onCollectionSelect,
      },
    });

    expect(screen.getByText("Library")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: /Books/i }));
    await fireEvent.click(screen.getByRole("button", { name: /Saved/i }));

    expect(onSectionChange).toHaveBeenCalledWith("books");
    expect(onCollectionSelect).toHaveBeenCalledWith("library");
  });
});
