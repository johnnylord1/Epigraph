import { describe, expect, test } from "vitest";
import type { LibraryCardVM } from "./contracts";
import {
  buildVirtualLibraryRows,
  estimateLibraryVirtualRowSize,
  virtualRowsToItemRange,
} from "./virtualGrid";

function card(id: string): LibraryCardVM {
  return {
    id,
    title: id,
    subtitle: undefined,
    coverSrc: null,
    coverFit: "cover",
    badges: [],
    metaChips: [],
    progress: null,
    selectable: false,
    selected: false,
    disabled: false,
  };
}

describe("library virtual grid helpers", () => {
  test("chunks cards by effective columns while preserving item identity", () => {
    const rows = buildVirtualLibraryRows(
      ["a", "b", "c", "d", "e"].map(card),
      2,
    );

    expect(rows).toEqual([
      { index: 0, startIndex: 0, items: [card("a"), card("b")] },
      { index: 1, startIndex: 2, items: [card("c"), card("d")] },
      { index: 2, startIndex: 4, items: [card("e")] },
    ]);
  });

  test("normalizes invalid column counts", () => {
    expect(buildVirtualLibraryRows([card("a"), card("b")], 0)).toHaveLength(2);
  });

  test("converts virtual row range to item range", () => {
    expect(virtualRowsToItemRange(1, 3, 4, 20)).toEqual({
      startIndex: 4,
      endIndex: 16,
    });
    expect(virtualRowsToItemRange(2, 5, 4, 11)).toEqual({
      startIndex: 8,
      endIndex: 11,
    });
  });

  test("keeps deterministic row estimates per view mode", () => {
    expect(estimateLibraryVirtualRowSize("list")).toBeGreaterThan(0);
    expect(estimateLibraryVirtualRowSize("compact_grid")).toBeLessThan(estimateLibraryVirtualRowSize("grid"));
    expect(estimateLibraryVirtualRowSize("list", 72)).toBeGreaterThan(estimateLibraryVirtualRowSize("list", 36));
  });
});
