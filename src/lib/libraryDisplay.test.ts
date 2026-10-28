import { describe, expect, it } from "vitest";
import {
  computeEffectiveLibraryColumns,
  computeLibraryLayout,
  getLibraryDisplaySpec,
  listCoverWidthFor,
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

  it("turns the density setting into the list's cover size", () => {
    const widths = ([4, 5, 6, 7, 8, 9, 10] as const).map(listCoverWidthFor);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(new Set(widths).size).toBe(widths.length);
    expect(listCoverWidthFor("auto")).toBe(46);
    expect(computeLibraryLayout({ availableWidth: 640, preferredColumns: 4, mode: "list" }).listCoverWidth).toBe(72);
  });
});
