/** Where the reader was looking: an element, how far into it the top of the view fell, and where that line sat on screen. */
export type ScrollAnchor = {
  element: HTMLElement;
  ratio: number;
  offset: number;
};

/** Pixels below the top edge treated as the line being read, so a sliver of the previous block does not win. */
const READING_LINE_INSET = 24;

/**
 * Remembers the block at the top of a scrolling viewer before its text is resized, so the same
 * passage can be put back in place afterwards. Candidates are checked in document order.
 */
export function captureScrollAnchor(viewer: HTMLElement, candidates: Iterable<HTMLElement>): ScrollAnchor | null {
  const viewerTop = viewer.getBoundingClientRect().top;
  const line = viewerTop + Math.min(READING_LINE_INSET, viewer.clientHeight / 2);
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= line) continue;
    const ratio = rect.top >= line ? 0 : (line - rect.top) / rect.height;
    return { element, ratio, offset: Math.max(rect.top, line) - viewerTop };
  }
  return null;
}

/** Scrolls the viewer so the anchored passage sits where it was when it was captured. */
export function restoreScrollAnchor(viewer: HTMLElement, anchor: ScrollAnchor | null) {
  if (!anchor || !anchor.element.isConnected || !viewer.contains(anchor.element)) return;
  const rect = anchor.element.getBoundingClientRect();
  const target = rect.top + rect.height * anchor.ratio - viewer.getBoundingClientRect().top;
  const delta = target - anchor.offset;
  if (Number.isFinite(delta) && Math.abs(delta) >= 1) viewer.scrollTop += delta;
}
