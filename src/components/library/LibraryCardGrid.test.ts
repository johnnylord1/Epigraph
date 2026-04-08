import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LibraryCardVM } from "../../lib/library/contracts";
import LibraryCardGrid from "./LibraryCardGrid.svelte";

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
});
