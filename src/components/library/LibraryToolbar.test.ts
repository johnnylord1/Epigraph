import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LibraryToolbarVM } from "../../lib/library/contracts";
import LibraryToolbar from "./LibraryToolbar.svelte";

describe("LibraryToolbar", () => {
  afterEach(() => cleanup());

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
});
