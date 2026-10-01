import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const librarySource = readFileSync(new URL("../../components/pages/Library.svelte", import.meta.url), "utf8").replaceAll("\r\n", "\n");

describe("Library download actions", () => {
  it("confirms deleting a title's downloads without waiting on the download queue", () => {
    const start = librarySource.indexOf("async function deleteAllDownloads(manga: Manga)");
    const end = librarySource.indexOf("\n  }\n", start);
    const body = librarySource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // Suwayomi holds a dequeue of a chapter that is not queued for 30 s, and downloaded chapters never are.
    expect(body).not.toContain("DEQUEUE_DOWNLOAD");
    expect(body).toContain("await gql(DELETE_DOWNLOADED_CHAPTERS, { ids });");
    expect(body.indexOf('addToast({ kind: "info", title: translate("detail_download_deletedTitle")'))
      .toBeGreaterThan(body.indexOf("DELETE_DOWNLOADED_CHAPTERS"));
  });
});
