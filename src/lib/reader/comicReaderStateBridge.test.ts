import { describe, expect, it } from "vitest";
import {
  canonicalizeSuwayomiServerKey,
  comicHistoryId,
  comicMediaKey,
  comicPageBookmarkId,
} from "./comicReaderStateBridge";

describe("comic reader Core identity", () => {
  it("canonicalizes equivalent Suwayomi origins before hashing", async () => {
    expect(canonicalizeSuwayomiServerKey("HTTP://Example.COM:80/api/"))
      .toBe("http://example.com/api");
    await expect(comicMediaKey("HTTP://Example.COM:80/api/", 42))
      .resolves.toBe(await comicMediaKey("http://example.com/api", "42"));
  });

  it("creates deterministic cross-platform history and page bookmark ids", async () => {
    const comicId = await comicMediaKey("https://reader.example:443/", 7);
    expect(comicHistoryId(comicId)).toBe(`comic.history::${comicId}`);
    await expect(comicPageBookmarkId(comicId, 11, 3))
      .resolves.toBe(await comicPageBookmarkId(comicId, "11", 3));
    await expect(comicPageBookmarkId(comicId, 11, 4))
      .resolves.not.toBe(await comicPageBookmarkId(comicId, 11, 3));
  });
});
