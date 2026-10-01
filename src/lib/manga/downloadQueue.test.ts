import { describe, expect, test } from "vitest";
import type { DownloadQueueItem } from "../types";
import { hasSettledSeriesDownload } from "./downloadQueue";

function item(id: number, state: DownloadQueueItem["state"]): DownloadQueueItem {
  return { progress: 0, state, chapter: { id, name: `Ch ${id}`, mangaId: 1, pageCount: 1, manga: { id: 1, title: "Series" } } } as DownloadQueueItem;
}

describe("hasSettledSeriesDownload", () => {
  const series = new Set([1, 2, 3]);

  test("reports a series chapter that left the queue or finished", () => {
    expect(hasSettledSeriesDownload([item(1, "DOWNLOADING"), item(2, "QUEUED")], [item(2, "DOWNLOADING")], series)).toBe(true);
    expect(hasSettledSeriesDownload([item(1, "DOWNLOADING")], [item(1, "FINISHED")], series)).toBe(true);
    expect(hasSettledSeriesDownload([item(1, "DOWNLOADING")], [item(1, "ERROR")], series)).toBe(true);
  });

  test("ignores chapters still downloading, already settled, or from another series", () => {
    expect(hasSettledSeriesDownload([item(1, "QUEUED")], [item(1, "DOWNLOADING")], series)).toBe(false);
    expect(hasSettledSeriesDownload([item(1, "FINISHED"), item(2, "ERROR")], [], series)).toBe(false);
    expect(hasSettledSeriesDownload([item(9, "DOWNLOADING")], [], series)).toBe(false);
    expect(hasSettledSeriesDownload([], [], series)).toBe(false);
  });
});
