export type LibraryViewMode = "grid" | "compact_grid" | "list";

export type LibraryPreferredGridColumns =
  | "auto"
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10;

export interface LibraryDisplaySpec {
  mode: LibraryViewMode;
  gap: number;
  minCardWidth: number;
  targetCardWidth: number;
}

export interface ComputeEffectiveLibraryColumnsInput {
  availableWidth: number;
  preferredColumns: LibraryPreferredGridColumns;
  minCardWidth: number;
  gap: number;
  mode: LibraryViewMode;
  targetCardWidth?: number;
}

export interface LibraryLayoutResult extends LibraryDisplaySpec {
  preferredColumns: LibraryPreferredGridColumns;
  effectiveColumns: number;
  isList: boolean;
  /** Height of one list row when the density fixes how many fit on screen; null keeps the natural size. */
  listRowHeight: number | null;
}

export const LIBRARY_LIST_ROW_GAP = 2;
// Below this a row cannot hold its title and meta line, so fewer rows fit instead.
const MIN_LIST_ROW_HEIGHT = 44;

/** The scroll container's height without its padding, so the first and last list rows are not cut off. */
export function measureListViewportHeight(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return element.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
}

/**
 * The grid divides the width by the density; the list has one item per row, so it divides the
 * visible height instead: 4 means four rows fill the screen. Auto keeps the list's natural size.
 */
export function computeListRowHeight(
  availableHeight: number,
  preferredColumns: LibraryPreferredGridColumns,
): number | null {
  if (preferredColumns === "auto" || availableHeight <= 0) return null;
  const rows = clampColumns(preferredColumns);
  const height = Math.floor((availableHeight + LIBRARY_LIST_ROW_GAP) / rows) - LIBRARY_LIST_ROW_GAP;
  return Math.max(MIN_LIST_ROW_HEIGHT, height);
}

const DISPLAY_SPECS: Record<LibraryViewMode, LibraryDisplaySpec> = {
  grid: {
    mode: "grid",
    gap: 16,
    minCardWidth: 140,
    targetCardWidth: 148,
  },
  compact_grid: {
    mode: "compact_grid",
    gap: 16,
    minCardWidth: 140,
    targetCardWidth: 148,
  },
  list: {
    mode: "list",
    gap: 0,
    minCardWidth: 0,
    targetCardWidth: 0,
  },
};

function clampColumns(value: number): number {
  return Math.max(4, Math.min(10, Math.floor(value)));
}

function widthForColumns(availableWidth: number, columns: number, gap: number): number {
  if (columns <= 1) return availableWidth;
  return (availableWidth - gap * (columns - 1)) / columns;
}

function getMaxColumnsForWidth(availableWidth: number, minCardWidth: number, gap: number): number {
  if (availableWidth <= 0) return 1;
  const raw = Math.floor((availableWidth + gap) / (minCardWidth + gap));
  return Math.max(1, Math.min(10, raw));
}

export function getLibraryDisplaySpec(mode: LibraryViewMode): LibraryDisplaySpec {
  return DISPLAY_SPECS[mode];
}

export function computeEffectiveLibraryColumns(input: ComputeEffectiveLibraryColumnsInput): number {
  if (input.mode === "list") return 1;

  const availableWidth = Math.max(0, input.availableWidth);
  const minCardWidth = Math.max(1, input.minCardWidth);
  const gap = Math.max(0, input.gap);
  const maxColumnsThatFit = getMaxColumnsForWidth(availableWidth, minCardWidth, gap);

  if (input.preferredColumns === "auto") {
    return maxColumnsThatFit;
  }

  let columns = Math.min(clampColumns(input.preferredColumns), maxColumnsThatFit);
  while (columns > 1 && widthForColumns(availableWidth, columns, gap) < minCardWidth) {
    columns -= 1;
  }
  return columns;
}

export function computeLibraryLayout(input: {
  availableWidth: number;
  availableHeight?: number;
  preferredColumns: LibraryPreferredGridColumns;
  mode: LibraryViewMode;
}): LibraryLayoutResult {
  const spec = getLibraryDisplaySpec(input.mode);
  const effectiveColumns = computeEffectiveLibraryColumns({
    availableWidth: input.availableWidth,
    preferredColumns: input.preferredColumns,
    minCardWidth: spec.minCardWidth,
    gap: spec.gap,
    mode: input.mode,
    targetCardWidth: spec.targetCardWidth,
  });

  return {
    ...spec,
    preferredColumns: input.preferredColumns,
    effectiveColumns,
    isList: input.mode === "list",
    listRowHeight: input.mode === "list"
      ? computeListRowHeight(input.availableHeight ?? 0, input.preferredColumns)
      : null,
  };
}
