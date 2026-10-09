/** Reads of one title less than this far apart show as one session. */
export const READING_SESSION_GAP_MS = 30 * 60 * 1000;

/** Splits newest-first reads into sessions: back-to-back reads of the same title, each close to the one before. */
export function groupReadingSessions<T>(
  items: readonly T[],
  titleOf: (item: T) => unknown,
  readAtOf: (item: T) => number,
): T[][] {
  const sessions: T[][] = [];
  let i = 0;
  while (i < items.length) {
    const anchor = items[i];
    const session = [anchor];
    let j = i + 1;
    while (
      j < items.length
      && titleOf(items[j]) === titleOf(anchor)
      && readAtOf(anchor) - readAtOf(items[j]) <= READING_SESSION_GAP_MS
    ) session.push(items[j++]);
    sessions.push(session);
    i = j;
  }
  return sessions;
}
