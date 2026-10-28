import type { LibraryCardVM } from "./contracts";
import type { LibraryViewMode } from "../libraryDisplay";

export interface VirtualLibraryRow {
  index: number;
  startIndex: number;
  items: LibraryCardVM[];
}

export function buildVirtualLibraryRows(
  items: LibraryCardVM[],
  effectiveColumns: number,
): VirtualLibraryRow[] {
  const columns = Math.max(1, Math.floor(effectiveColumns || 1));
  const rows: VirtualLibraryRow[] = [];

  for (let startIndex = 0; startIndex < items.length; startIndex += columns) {
    rows.push({
      index: rows.length,
      startIndex,
      items: items.slice(startIndex, startIndex + columns),
    });
  }

  return rows;
}

// A list row is its 2:3 cover plus 16px of padding and the 2px row gap.
export function estimateLibraryVirtualRowSize(viewMode: LibraryViewMode, listCoverWidth = 46): number {
  if (viewMode === "list") return Math.round(listCoverWidth * 1.5) + 18;
  if (viewMode === "compact_grid") return 236;
  return 276;
}

export function virtualRowsToItemRange(
  rowStartIndex: number,
  rowEndIndex: number,
  effectiveColumns: number,
  itemCount: number,
) {
  const columns = Math.max(1, Math.floor(effectiveColumns || 1));
  const startIndex = Math.max(0, Math.min(itemCount, rowStartIndex * columns));
  const endIndex = Math.max(
    startIndex,
    Math.min(itemCount, (rowEndIndex + 1) * columns),
  );

  return { startIndex, endIndex };
}
