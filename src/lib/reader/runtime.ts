export interface VisibleReaderPage {
  pageNumber: number;
  visibleRatio: number;
  centerDistance: number;
}

export function clampReaderPage(pageNumber: number, totalPages: number): number {
  const upper = Math.max(1, Math.trunc(totalPages) || 1);
  const candidate = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1;
  return Math.max(1, Math.min(upper, candidate));
}

export function selectDominantReaderPage(
  candidates: Iterable<VisibleReaderPage>,
): number | null {
  let selected: VisibleReaderPage | null = null;
  for (const candidate of candidates) {
    if (candidate.visibleRatio <= 0) continue;
    if (
      !selected
      || candidate.visibleRatio > selected.visibleRatio
      || (
        candidate.visibleRatio === selected.visibleRatio
        && candidate.centerDistance < selected.centerDistance
      )
      || (
        candidate.visibleRatio === selected.visibleRatio
        && candidate.centerDistance === selected.centerDistance
        && candidate.pageNumber < selected.pageNumber
      )
    ) {
      selected = candidate;
    }
  }
  return selected?.pageNumber ?? null;
}
