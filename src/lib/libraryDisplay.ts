export type LibraryViewMode = "grid" | "compact_grid" | "list";

export type LibraryPreferredGridColumns =
  | "auto"
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12;

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
}

const DISPLAY_SPECS: Record<LibraryViewMode, LibraryDisplaySpec> = {
  grid: {
    mode: "grid",
    gap: 16,
    minCardWidth: 140,
    targetCardWidth: 170,
  },
  compact_grid: {
    mode: "compact_grid",
    gap: 10,
    minCardWidth: 116,
    targetCardWidth: 146,
  },
  list: {
    mode: "list",
    gap: 0,
    minCardWidth: 0,
    targetCardWidth: 0,
  },
};

function clampColumns(value: number): number {
  return Math.max(1, Math.min(12, Math.floor(value)));
}

function widthForColumns(availableWidth: number, columns: number, gap: number): number {
  if (columns <= 1) return availableWidth;
  return (availableWidth - gap * (columns - 1)) / columns;
}

function getMaxColumnsForWidth(availableWidth: number, minCardWidth: number, gap: number): number {
  if (availableWidth <= 0) return 1;
  const raw = Math.floor((availableWidth + gap) / (minCardWidth + gap));
  return clampColumns(Math.max(1, raw));
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
    const targetCardWidth = Math.max(minCardWidth, input.targetCardWidth ?? minCardWidth);
    const autoCandidate = clampColumns(
      Math.max(1, Math.floor((availableWidth + gap) / (targetCardWidth + gap))),
    );
    return Math.min(autoCandidate, maxColumnsThatFit);
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
  };
}
