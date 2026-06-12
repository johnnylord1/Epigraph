import { describe, expect, it } from "vitest";
import { mangaCoverPath, resolveMangaCover, resolveMangaCoverUrl } from "./coverResolver";

describe("manga cover resolver", () => {
  it("normalizes cover paths from strings and manga-like objects", () => {
    expect(mangaCoverPath(" /api/v1/manga/1/thumbnail ")).toBe("/api/v1/manga/1/thumbnail");
    expect(mangaCoverPath({ thumbnailUrl: " /api/v1/manga/2/thumbnail " })).toBe("/api/v1/manga/2/thumbnail");
    expect(mangaCoverPath(null)).toBe("");
  });

  it("uses persistent storage policy for library-like contexts", () => {
    const cover = resolveMangaCover({ thumbnailUrl: "/thumbs/series-a" }, { context: "library" });

    expect(cover?.persistence).toBe("persistent");
    expect(cover?.context).toBe("library");
    expect(cover?.url).toContain("/thumbs/series-a");
  });

  it("uses memory policy for source browsing by default", () => {
    const cover = resolveMangaCover("/thumbs/search-result", { context: "browse" });

    expect(cover?.persistence).toBe("memory");
  });

  it("can append a cache generation without changing the source path", () => {
    const cover = resolveMangaCover("/thumbs/series-b", {
      context: "home",
      cacheGeneration: 7,
    });

    expect(cover?.path).toBe("/thumbs/series-b");
    expect(resolveMangaCoverUrl("/thumbs/series-b", { cacheGeneration: 7 })).toContain("aethon_cover_generation=7");
  });
});
