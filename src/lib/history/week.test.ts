import { describe, expect, it } from "vitest";
import { FALLBACK_MINUTES_PER_CHAPTER, summarizeReadingWeek } from "./week";

describe("summarizeReadingWeek", () => {
  const start = 1_000;

  it("counts logged completions with their own minutes", () => {
    const summary = summarizeReadingWeek(
      [
        { chapterId: 1, readAt: 1_500, minutes: 7 },
        { chapterId: 1, readAt: 1_600, minutes: 3 },
        { chapterId: 2, readAt: 500, minutes: 9 },
      ],
      [],
      start,
    );
    expect(summary).toEqual({ chapterCount: 1, minutes: 10 });
  });

  it("counts reads synced from other devices that never reached the local log", () => {
    const summary = summarizeReadingWeek(
      [{ chapterId: 1, readAt: 1_500, minutes: 7 }],
      [
        { chapterId: 1, readAt: 1_500 },
        { chapterId: 3, readAt: 2_000 },
        { chapterId: 4, readAt: 900 },
      ],
      start,
    );
    expect(summary).toEqual({ chapterCount: 2, minutes: 7 + FALLBACK_MINUTES_PER_CHAPTER });
  });
});
