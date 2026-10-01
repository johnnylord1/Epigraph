/** The chapters a "download next N" action takes: `start` and those after it in reading order, whatever order
 * the chapter list is displayed in. Nothing when `start` is not in the list. */
export function nextChaptersInReadingOrder<T>(readingOrder: readonly T[], start: T | null | undefined, count: number): T[] {
  const index = start == null ? -1 : readingOrder.indexOf(start);
  return index < 0 ? [] : readingOrder.slice(index, index + count);
}
