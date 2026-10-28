import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LibraryToolbarVM } from "../../lib/library/contracts";
import { store } from "../../store/state.svelte";
import LibraryToolbar from "./LibraryToolbar.svelte";

describe("LibraryToolbar", () => {
  afterEach(() => {
    store.closeSearchPalette(false);
    cleanup();
  });

  test("renders search, sort, and filter controls from VM and callback props", async () => {
    const toolbar: LibraryToolbarVM = {
      searchValue: "",
      searchPlaceholder: "Search books",
      sortMode: "recentlyAdded",
      sortDir: "desc",
      sortOptions: [
        { id: "recentlyAdded", label: "Recently added" },
        { id: "az", label: "A-Z" },
      ],
      filterValue: "ALL",
      filterOptions: [
        { id: "ALL", label: "All books" },
        { id: "FINISHED", label: "Finished" },
      ],
    };

    const onSearchChange = vi.fn();
    const onSortModeChange = vi.fn();
    const onSortDirToggle = vi.fn();
    const onFilterChange = vi.fn();

    render(LibraryToolbar, {
      props: {
        toolbar,
        displaySettings: {
          viewMode: "grid",
          preferredColumns: "auto",
          showProgress: true,
          showOutline: true,
        },
        sortDefaultMode: "recentlyAdded",
        sortDefaultDir: "desc",
        filterDefaultValue: "ALL",
        onSearchChange,
        onSortModeChange,
        onSortDirToggle,
        onFilterChange,
      },
    });

    await fireEvent.input(screen.getByPlaceholderText("Search books"), {
      currentTarget: { value: "chrysalis" },
      target: { value: "chrysalis" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("chrysalis");

    await fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /A-Z/i }));
    expect(onSortModeChange).toHaveBeenCalledWith("az");

    await fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Finished/i }));
    expect(onFilterChange).toHaveBeenCalledWith("FINISHED");

    await fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: /Descending/i }));
    expect(onSortDirToggle).toHaveBeenCalled();
  });

  test("shows the import button only when an import action is given", async () => {
    const props = {
      displaySettings: {
        viewMode: "grid" as const,
        preferredColumns: "auto" as const,
        showProgress: true,
        showOutline: true,
      },
      toolbar: {
        searchValue: "",
        searchPlaceholder: "Search books",
        sortMode: "recentlyAdded",
        sortDir: "desc" as const,
        sortOptions: [],
        filterValue: "ALL",
        filterOptions: [],
      },
      sortDefaultMode: "recentlyAdded",
      sortDefaultDir: "desc" as const,
      filterDefaultValue: "ALL",
    };
    const first = render(LibraryToolbar, { props });
    expect(screen.queryByRole("button", { name: "Import books" })).toBeNull();
    first.unmount();

    const onImport = vi.fn();
    render(LibraryToolbar, { props: { ...props, onImport, importLabel: "Import books" } });
    await fireEvent.click(screen.getByRole("button", { name: "Import books" }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  test("keeps the density slider working in list mode, where it sizes the covers", async () => {
    const onPreferredColumnsChange = vi.fn();
    render(LibraryToolbar, {
      props: {
        displaySettings: { viewMode: "list", preferredColumns: "auto", showProgress: true, showOutline: true },
        toolbar: {
          searchValue: "",
          searchPlaceholder: "Search comics",
          sortMode: "az",
          sortDir: "asc",
          sortOptions: [],
          filterValue: "ALL",
          filterOptions: [],
        },
        sortDefaultMode: "az",
        sortDefaultDir: "asc",
        filterDefaultValue: "ALL",
        onPreferredColumnsChange,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const slider = screen.getByRole("slider", { name: "Cover size" }) as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    await fireEvent.input(slider, { target: { value: "1" } });
    expect(onPreferredColumnsChange).toHaveBeenCalledWith(4);
  });
});
