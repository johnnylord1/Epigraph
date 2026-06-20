import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LibraryCardVM } from "../../lib/library/contracts";
import LibraryCardGrid from "./LibraryCardGrid.svelte";
import VirtualLibraryCardGrid from "./VirtualLibraryCardGrid.svelte";

describe("LibraryCardGrid", () => {
  afterEach(() => cleanup());

  test("renders shared cards with stable identity and keyboard activation", async () => {
    const onOpen = vi.fn();
    const items: LibraryCardVM[] = [
      {
        id: "comic:1",
        title: "First Card",
        subtitle: undefined,
        coverSrc: null,
        coverFit: "cover",
        badges: [],
        metaChips: [],
        progress: null,
        selectable: true,
        selected: false,
        disabled: false,
      },
      {
        id: "book:2",
        title: "Second Card",
        subtitle: "Author",
        coverSrc: null,
        coverFit: "contain",
        badges: [{ kind: "subtype", label: "EPUB" }],
        metaChips: ["12 sections"],
        progress: { primaryLabel: "4 / 12 read", secondaryLabel: "33%", percent: 0.33 },
        selectable: false,
        selected: false,
        disabled: false,
      },
    ];

    render(LibraryCardGrid, {
      props: {
        items,
        onOpen,
      },
    });

    const first = screen.getByRole("button", { name: /First Card/i });
    const second = screen.getByRole("button", { name: /Second Card/i });

    expect(first.getAttribute("data-card-id")).toBe("comic:1");
    expect(second.getAttribute("data-card-id")).toBe("book:2");

    await fireEvent.click(first);
    expect(onOpen).toHaveBeenCalledWith("comic:1", expect.any(MouseEvent));

    onOpen.mockClear();
    await fireEvent.keyDown(second, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("book:2", expect.any(KeyboardEvent));

    onOpen.mockClear();
    await fireEvent.keyDown(second, { key: " " });
    expect(onOpen).toHaveBeenCalledWith("book:2", expect.any(KeyboardEvent));
  });

  test("applies explicit items-per-row density to the grid style", () => {
    const items: LibraryCardVM[] = [{
      id: "comic:1",
      title: "Density Card",
      subtitle: undefined,
      coverSrc: null,
      coverFit: "cover",
      badges: [],
      metaChips: [],
      progress: null,
      selectable: true,
      selected: false,
      disabled: false,
    }];

    const { container } = render(LibraryCardGrid, {
      props: {
        items,
        viewMode: "grid",
        effectiveColumns: 4,
      },
    });

    const grid = container.querySelector(".grid");
    expect(grid?.getAttribute("style")).toContain("--library-columns: 4");
    expect(grid?.getAttribute("style")).not.toContain("--library-card-max");
  });

  test("updates the virtual window from the external scroll container after remount-like scroll changes", async () => {
    const scroller = document.createElement("div");
    let scrollTop = 0;
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      },
      configurable: true,
    });
    document.body.appendChild(scroller);

    const items: LibraryCardVM[] = Array.from({ length: 240 }, (_, index) => ({
      id: `book:${index}`,
      title: `Book ${index}`,
      subtitle: undefined,
      coverSrc: null,
      coverFit: "cover",
      badges: [],
      metaChips: [],
      progress: null,
      selectable: false,
      selected: false,
      disabled: false,
    }));

    try {
      render(VirtualLibraryCardGrid, {
        props: {
          items,
          scrollElement: scroller,
          viewMode: "grid",
          effectiveColumns: 4,
          virtualizeAfter: 20,
        },
      });

      expect(await screen.findByRole("button", { name: "Book 0" })).toBeTruthy();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      scroller.scrollTop = 5_520;
      await fireEvent.scroll(scroller);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Book 0" })).toBeNull();
        const renderedIndexes = screen.getAllByRole("button")
          .map((button) => Number(button.getAttribute("aria-label")?.replace("Book ", "")))
          .filter(Number.isFinite);
        expect(Math.min(...renderedIndexes)).toBeGreaterThan(0);
      });
    } finally {
      scroller.remove();
    }
  });
});
