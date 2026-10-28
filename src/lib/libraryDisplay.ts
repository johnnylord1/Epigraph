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
  listCoverWidth: number;
}

// The list has one item per row, so the density setting sizes its covers instead: fewer items per
// row means bigger covers. Auto keeps the list's original size.
const LIST_COVER_WIDTHS: Record<LibraryPreferredGridColumns, number> = {
  auto: 46,
  4: 72,
  5: 64,
  6: 57,
  7: 51,
  8: 46,
  9: 41,
  10: 36,
};

export function listCoverWidthFor(preferredColumns: LibraryPreferredGridColumns): number {
  return LIST_COVER_WIDTHS[preferredColumns] ?? LIST_COVER_WIDTHS.auto;
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
    listCoverWidth: listCoverWidthFor(input.preferredColumns),
  };
}
