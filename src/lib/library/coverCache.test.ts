import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Manga } from "../types";
import {
  cacheLibraryCoverFromServer,
  findUncachedLibraryCovers,
  getCachedLibraryCoverUrl,
  libraryCoverCacheKey,
} from "./coverCache";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol: string) => `${protocol}://${path}`,
  invoke: invokeMock,
}));

vi.mock("../client", () => ({
  getServerAuthHeader: () => "Bearer demo",
  getServerUrl: () => "http://127.0.0.1:4567",
  thumbUrl: (path: string) => `http://127.0.0.1:4567/thumb/${path}`,
}));

describe("library cover cache", () => {
  const manga = {
    id: 42,
    title: "Fresh Cover",
    thumbnailUrl: "/api/v1/manga/42/thumbnail",
    inLibrary: true,
    source: { id: "source-1", displayName: "Source One", name: "source-one" },
  } as Manga;

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("keys persisted covers by cache generation so stale Suwayomi thumbnails can refresh", async () => {
    invokeMock.mockResolvedValue("C:/covers/fresh.webp");

    const baseScope = { profileId: "MAIN", serverUrl: "http://127.0.0.1:4567" };
    const refreshedScope = { ...baseScope, coverCacheGeneration: 3 };

    expect(libraryCoverCacheKey(baseScope, manga)).not.toBe(libraryCoverCacheKey(refreshedScope, manga));

    await getCachedLibraryCoverUrl(refreshedScope, manga);
    expect(invokeMock).toHaveBeenLastCalledWith("get_cached_library_cover", expect.objectContaining({
      mangaId: 42,
      thumbnailUrl: "/api/v1/manga/42/thumbnail?epigraph_cover_generation=3&epigraph_cover_variant=thumb-v2-edge420",
    }));

    await cacheLibraryCoverFromServer(refreshedScope, manga);
    expect(invokeMock).toHaveBeenLastCalledWith("cache_library_cover", expect.objectContaining({
      mangaId: 42,
      thumbnailUrl: "/api/v1/manga/42/thumbnail?epigraph_cover_generation=3&epigraph_cover_variant=thumb-v2-edge420",
      coverUrl: "http://127.0.0.1:4567/thumb//api/v1/manga/42/thumbnail?epigraph_cover_generation=3",
    }));
  });

  it("reuses session cover urls without invoking the native cache lookup again", async () => {
    invokeMock.mockResolvedValue("C:/covers/session.webp");
    const scope = { profileId: "MAIN", serverUrl: "http://127.0.0.1:4567", coverCacheGeneration: 9 };

    await expect(getCachedLibraryCoverUrl(scope, manga)).resolves.toBe("cover://C:/covers/session.webp");
    await expect(getCachedLibraryCoverUrl(scope, manga)).resolves.toBe("cover://C:/covers/session.webp");

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("looks a whole library up in batches and remembers what it found", async () => {
    invokeMock.mockImplementation(async (_command: string, args: { items: { mangaId: number }[] }) => (
      args.items.map(({ mangaId }) => (mangaId % 2 ? null : `C:/covers/${mangaId}.jpg`))
    ));
    const scope = { profileId: "BATCH", serverUrl: "http://127.0.0.1:4567" };
    const library = Array.from({ length: 450 }, (_, index) => ({ ...manga, id: index + 1 })) as Manga[];

    const uncached = await findUncachedLibraryCovers(scope, library);

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "get_cached_library_covers",
      "get_cached_library_covers",
      "get_cached_library_covers",
    ]);
    expect(uncached.map((item) => item.id)).toEqual(library.filter((item) => item.id % 2).map((item) => item.id));
    invokeMock.mockClear();
    await expect(getCachedLibraryCoverUrl(scope, library[1])).resolves.toBe("cover://C:/covers/2.jpg");
    expect(invokeMock).not.toHaveBeenCalled();
    await findUncachedLibraryCovers(scope, library.filter((item) => item.id % 2 === 0));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("treats titles as uncached when the batch lookup fails", async () => {
    invokeMock.mockRejectedValue(new Error("bridge closed"));
    const scope = { profileId: "BATCH-FAIL", serverUrl: "http://127.0.0.1:4567" };

    await expect(findUncachedLibraryCovers(scope, [manga])).resolves.toEqual([manga]);
  });
});
