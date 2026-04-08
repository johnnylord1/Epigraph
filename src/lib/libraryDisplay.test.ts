import { describe, expect, it } from "vitest";
import {
  computeEffectiveLibraryColumns,
  computeLibraryLayout,
  getLibraryDisplaySpec,
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

    expect(columns).toBe(6);
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
      preferredColumns: 12,
      mode: "grid",
    });

    expect(layout.effectiveColumns).toBe(4);
  });

  it("allows denser layouts on large windows", () => {
    const layout = computeLibraryLayout({
      availableWidth: 1920,
      preferredColumns: 12,
      mode: "compact_grid",
    });

    expect(layout.effectiveColumns).toBe(12);
  });

  it("ignores columns in list mode", () => {
    const layout = computeLibraryLayout({
      availableWidth: 640,
      preferredColumns: 12,
      mode: "list",
    });

    expect(layout.isList).toBe(true);
    expect(layout.effectiveColumns).toBe(1);
  });
});
