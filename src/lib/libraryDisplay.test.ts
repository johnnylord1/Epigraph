import { describe, expect, it, vi } from "vitest";
import {
  computeEffectiveLibraryColumns,
  computeLibraryLayout,
  getLibraryDisplaySpec,
  computeListRowHeight,
  LIBRARY_LIST_ROW_GAP,
  measureListViewportHeight,
} from "./libraryDisplay";

describe("libraryDisplay", () => {
  it("uses sensible auto density in grid mode", () => {
    const spec = getLibraryDisplaySpec("grid");
    const columns = computeEffectiveLibraryColumns({
      availableWidth: 1200,
      preferredColumns: "auto",
      minCardWidth: spec.minCardWidth,
      gap: spec.gap,
      mode: "grid",
      targetCardWidth: spec.targetCardWidth,
    });

    expect(columns).toBe(7);
  });

  it("keeps auto density fluid as windows narrow", () => {
    const wide = computeLibraryLayout({
      availableWidth: 760,
      preferredColumns: "auto",
      mode: "grid",
    });
    const narrow = computeLibraryLayout({
      availableWidth: 540,
      preferredColumns: "auto",
      mode: "grid",
    });

    expect(wide.effectiveColumns).toBe(4);
    expect(narrow.effectiveColumns).toBe(3);
  });

  it("uses the same items-per-row rule for grid and compact modes", () => {
    const grid = computeLibraryLayout({
      availableWidth: 1200,
      preferredColumns: "auto",
      mode: "grid",
    });
    const compact = computeLibraryLayout({
      availableWidth: 1200,
      preferredColumns: "auto",
      mode: "compact_grid",
    });

    expect(compact.effectiveColumns).toBe(grid.effectiveColumns);
  });

  it("respects explicit preferred columns when they fit", () => {
    const layout = computeLibraryLayout({
      availableWidth: 1700,
      preferredColumns: 10,
      mode: "compact_grid",
    });

    expect(layout.effectiveColumns).toBe(10);
  });

  it("clamps explicit preferred columns on narrow windows", () => {
    const layout = computeLibraryLayout({
      availableWidth: 760,
      preferredColumns: 10,
      mode: "grid",
    });

    expect(layout.effectiveColumns).toBe(4);
  });

  it("normalizes legacy explicit densities below four", () => {
    const layout = computeLibraryLayout({
      availableWidth: 760,
      preferredColumns: 2 as never,
      mode: "grid",
    });

    expect(layout.effectiveColumns).toBe(4);
  });

  it("allows denser layouts on large windows", () => {
    const layout = computeLibraryLayout({
      availableWidth: 1920,
      preferredColumns: 10,
      mode: "compact_grid",
    });

    expect(layout.effectiveColumns).toBe(10);
  });

  it("ignores columns in list mode", () => {
    const layout = computeLibraryLayout({
      availableWidth: 640,
      preferredColumns: 10,
      mode: "list",
    });

    expect(layout.isList).toBe(true);
    expect(layout.effectiveColumns).toBe(1);
  });

  it("fits the chosen number of list rows in the visible height", () => {
    for (const rows of [4, 7, 10] as const) {
      const height = computeListRowHeight(560, rows);
      expect(height).not.toBeNull();
      expect(rows * (height! + LIBRARY_LIST_ROW_GAP)).toBeLessThanOrEqual(560 + LIBRARY_LIST_ROW_GAP);
      expect((rows + 1) * (height! + LIBRARY_LIST_ROW_GAP)).toBeGreaterThan(560 + LIBRARY_LIST_ROW_GAP);
    }
    expect(computeListRowHeight(560, "auto")).toBeNull();
    expect(computeListRowHeight(0, 4)).toBeNull();
    expect(computeListRowHeight(200, 10)).toBe(44);
    expect(computeLibraryLayout({ availableWidth: 640, availableHeight: 560, preferredColumns: 4, mode: "list" }).listRowHeight).toBe(138);
    expect(computeLibraryLayout({ availableWidth: 640, availableHeight: 560, preferredColumns: 4, mode: "grid" }).listRowHeight).toBeNull();
  });

  it("measures the list height without the scroll container padding", () => {
    vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "20px", paddingBottom: "24px" }));
    try {
      expect(measureListViewportHeight({ clientHeight: 583 } as HTMLElement)).toBe(539);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
