import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LibraryCardVM } from "../../lib/library/contracts";
import LibraryCardGrid from "./LibraryCardGrid.svelte";
import VirtualLibraryCardGrid from "./VirtualLibraryCardGrid.svelte";
import {
  DEFAULT_LIBRARY_MOTION_ENVIRONMENT,
  setLibraryMotionEnvironment,
} from "../../lib/library/motionGate";

describe("LibraryCardGrid", () => {
  afterEach(() => {
    cleanup();
    setLibraryMotionEnvironment(DEFAULT_LIBRARY_MOTION_ENVIRONMENT);
    vi.unstubAllGlobals();
  });

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

  test("renders cover progress from each card progress percent", () => {
    const items: LibraryCardVM[] = [{
      id: "comic:progress",
      title: "Progress Card",
      subtitle: undefined,
      coverSrc: null,
      coverFit: "cover",
      badges: [],
      metaChips: [],
      progress: { primaryLabel: "3", secondaryLabel: "/ 10 chapters", percent: 0.3 },
      selectable: true,
      selected: false,
      disabled: false,
    }];

    const { container } = render(LibraryCardGrid, {
      props: {
        items,
        viewMode: "grid",
        showProgress: true,
      },
    });

    const fill = container.querySelector(".cover-progress-fill");
    expect(fill?.getAttribute("style")?.replace(/\s/g, "")).toContain("--cover-progress-width:30%");
  });

  test("keeps compact mode to cover, title, and numeric chapter badges", () => {
    const items: LibraryCardVM[] = [{
      id: "comic:compact",
      title: "Compact Card",
      subtitle: "Source Name",
      coverSrc: null,
      coverFit: "cover",
      badges: [],
      metaChips: ["ONGOING"],
      progress: { primaryLabel: "3", secondaryLabel: "/ 10 chapters", percent: 0.3 },
      selectable: true,
      selected: false,
      disabled: false,
      sourceMetricBanner: {
        flagLabel: "en",
        downloadedCount: 2,
        newCount: 8,
        sourceName: "Example Source",
      },
    }];

    const { container } = render(LibraryCardGrid, {
      props: {
        items,
        viewMode: "compact_grid",
        showProgress: true,
      },
    });

    expect(screen.getByText("Compact Card")).toBeTruthy();
    expect(screen.queryByText("Source Name")).toBeNull();
    expect(container.querySelector(".cover-progress-track")).toBeNull();
    expect(container.querySelector(".source-metric-flag")).toBeNull();
    expect(container.querySelector(".source-metric-pill")?.textContent).toContain("2");
    expect(container.querySelector(".source-metric-pill")?.textContent).toContain("8");
    expect(container.querySelector(".source-metric-unread")?.classList.contains("has-flag")).toBe(false);
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

  test("keeps an inactive virtual grid quiet without removing its cards", async () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true, configurable: true });
    document.body.appendChild(scroller);
    const onVisibleRangeChange = vi.fn();
    const item: LibraryCardVM = {
      id: "comic:quiet",
      title: "Quiet Card",
      subtitle: undefined,
      coverSrc: null,
      coverFit: "cover",
      badges: [],
      metaChips: [],
      progress: { primaryLabel: "1 / 2", secondaryLabel: "50%", percent: 0.5 },
      selectable: false,
      selected: false,
      disabled: false,
    };

    try {
      const view = render(VirtualLibraryCardGrid, {
        props: {
          items: [item],
          scrollElement: scroller,
          active: false,
          onVisibleRangeChange,
          virtualizeAfter: 20,
        },
      });

      expect(await screen.findByRole("button", { name: "Quiet Card" })).toBeTruthy();
      const retainedCard = screen.getByRole("button", { name: "Quiet Card" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(onVisibleRangeChange).not.toHaveBeenCalled();
      expect(retainedCard.classList.contains("library-motion-running")).toBe(false);

      await view.rerender({
        items: [item],
        scrollElement: scroller,
        active: true,
        onVisibleRangeChange,
        virtualizeAfter: 20,
      });
      await waitFor(() => expect(onVisibleRangeChange).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: "Quiet Card" })).toBe(retainedCard);
    } finally {
      scroller.remove();
    }
  });

  test("opens liquid motion only after the card intersects the real scroll viewport", async () => {
    class MockIntersectionObserver {
      static instances: MockIntersectionObserver[] = [];
      private target: Element | null = null;

      constructor(private readonly callback: IntersectionObserverCallback) {
        MockIntersectionObserver.instances.push(this);
      }

      observe(target: Element) { this.target = target; }
      unobserve() { this.target = null; }
      disconnect() { this.target = null; }
      trigger(visible: boolean) {
        if (!this.target) return;
        this.callback([{
          target: this.target,
          isIntersecting: visible,
          intersectionRatio: visible ? 1 : 0,
        } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    setLibraryMotionEnvironment({
      libraryVisible: true,
      windowFocused: true,
      shellIdle: false,
      motionEnabled: true,
    });

    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true, configurable: true });
    document.body.appendChild(scroller);
    const item: LibraryCardVM = {
      id: "comic:visible",
      title: "Visible Card",
      subtitle: undefined,
      coverSrc: null,
      coverFit: "cover",
      badges: [],
      metaChips: [],
      progress: { primaryLabel: "1 / 2", secondaryLabel: "50%", percent: 0.5 },
      selectable: false,
      selected: false,
      disabled: false,
    };

    try {
      render(VirtualLibraryCardGrid, {
        props: {
          items: [item],
          scrollElement: scroller,
          active: true,
          virtualizeAfter: 20,
        },
      });

      const card = await screen.findByRole("button", { name: "Visible Card" });
      expect(card.classList.contains("library-motion-running")).toBe(false);
      MockIntersectionObserver.instances[0]?.trigger(true);
      await waitFor(() => expect(card.classList.contains("library-motion-running")).toBe(true));
      MockIntersectionObserver.instances[0]?.trigger(false);
      await waitFor(() => expect(card.classList.contains("library-motion-running")).toBe(false));
    } finally {
      scroller.remove();
    }
  });
});
