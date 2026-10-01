import type { DownloadQueueItem } from "../types";

function isActiveDownload(item: DownloadQueueItem) {
  return item.state === "QUEUED" || item.state === "DOWNLOADING";
}

/** True when a chapter of the series was downloading and no longer is: it finished or was dropped. */
export function hasSettledSeriesDownload(previous: DownloadQueueItem[], next: DownloadQueueItem[], seriesChapterIds: Set<number>) {
  const stillActive = new Set(next.filter(isActiveDownload).map(item => item.chapter.id));
  return previous.some(item => isActiveDownload(item) && seriesChapterIds.has(item.chapter.id) && !stillActive.has(item.chapter.id));
}
