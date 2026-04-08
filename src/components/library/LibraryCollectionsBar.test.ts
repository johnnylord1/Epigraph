import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import LibraryCollectionsBar from "./LibraryCollectionsBar.svelte";

describe("LibraryCollectionsBar", () => {
  afterEach(() => cleanup());

  test("renders collections and optional reorder affordances from explicit props", async () => {
    const onSelect = vi.fn();
    const reorderApi = {
      activeId: null,
      targetId: null,
      insertIndex: null,
      onDragStart: vi.fn(),
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
      onDragEnd: vi.fn(),
    };

    render(LibraryCollectionsBar, {
      props: {
        collections: [
          { id: "library", label: "Saved", count: 10, icon: "books", active: true, reorderable: false, isDefault: false },
          { id: "42", label: "Finished", count: 3, icon: "folder", active: false, reorderable: true, isDefault: true },
        ],
        onSelect,
        reorderApi,
      },
    });

    const finished = screen.getByRole("button", { name: /Finished/i });
    expect(finished.getAttribute("draggable")).toBe("true");

    await fireEvent.click(finished);
    await fireEvent.dragStart(finished);

    expect(onSelect).toHaveBeenCalledWith("42");
    expect(reorderApi.onDragStart).toHaveBeenCalled();
  });

  test("forwards dragover, dragleave, drop, and dragend through the explicit reorder api", async () => {
    const reorderApi = {
      activeId: "42",
      targetId: "17",
      insertIndex: 1,
      onDragStart: vi.fn(),
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
      onDragEnd: vi.fn(),
    };

    render(LibraryCollectionsBar, {
      props: {
        collections: [
          { id: "42", label: "Finished", count: 3, icon: "folder", active: false, reorderable: true, isDefault: true },
          { id: "17", label: "Reading", count: 9, icon: "folder", active: true, reorderable: true, isDefault: false },
        ],
        reorderApi,
      },
    });

    const reading = screen.getByRole("button", { name: /Reading/i });
    const dataTransfer = {
      dropEffect: "move",
      effectAllowed: "move",
      setData: vi.fn(),
      getData: vi.fn(() => "42"),
      clearData: vi.fn(),
      files: [],
      items: [],
      types: [],
    };

    await fireEvent.dragOver(reading, { dataTransfer });
    await fireEvent.dragLeave(reading, { dataTransfer });
    await fireEvent.drop(reading, { dataTransfer });
    await fireEvent.dragEnd(reading, { dataTransfer });

    expect(reorderApi.onDragOver).toHaveBeenCalledWith("17", 1, expect.any(Event));
    expect(reorderApi.onDragLeave).toHaveBeenCalledWith("17", expect.any(Event));
    expect(reorderApi.onDrop).toHaveBeenCalledWith("17", 1, expect.any(Event));
    expect(reorderApi.onDragEnd).toHaveBeenCalledWith(expect.any(Event));
  });
});
