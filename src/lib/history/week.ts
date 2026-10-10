/** Minutes credited to a read that has no timing of its own, matching the store's read log default. */
export const FALLBACK_MINUTES_PER_CHAPTER = 5;

interface TimedRead {
  chapterId: number;
  readAt: number;
}

interface LoggedRead extends TimedRead {
  minutes: number;
}

/**
 * Chapters and minutes read since `startMs`. The read log only has completions on this
 * computer, so chapters that appear only in history (opened here, or read on a paired
 * device) still count, with an estimated time.
 */
export function summarizeReadingWeek(
  readLog: readonly LoggedRead[],
  history: readonly TimedRead[],
  startMs: number,
): { chapterCount: number; minutes: number } {
  const chapterIds = new Set<number>();
  let minutes = 0;
  for (const entry of readLog) {
    if (entry.readAt < startMs) continue;
    chapterIds.add(entry.chapterId);
    minutes += Number(entry.minutes) || 0;
  }
  for (const entry of history) {
    if (entry.readAt < startMs || chapterIds.has(entry.chapterId)) continue;
    chapterIds.add(entry.chapterId);
    minutes += FALLBACK_MINUTES_PER_CHAPTER;
  }
  return { chapterCount: chapterIds.size, minutes };
}
