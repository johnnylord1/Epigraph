import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Manga } from "../types";
import {
  cacheLibraryCoverFromServer,
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

  it("keeps persisted lookup stable across cover cache generations", async () => {
    invokeMock.mockResolvedValue("C:/covers/fresh.webp");

    const baseScope = { profileId: "MAIN", serverUrl: "http://127.0.0.1:4567" };
    const refreshedScope = { ...baseScope, coverCacheGeneration: 3 };

    expect(libraryCoverCacheKey(baseScope, manga)).toBe(libraryCoverCacheKey(refreshedScope, manga));

    await getCachedLibraryCoverUrl(refreshedScope, manga);
    expect(invokeMock).toHaveBeenLastCalledWith("get_cached_library_cover", expect.objectContaining({
      mangaId: 42,
      thumbnailUrl: "/api/v1/manga/42/thumbnail",
    }));

    await cacheLibraryCoverFromServer(refreshedScope, manga);
    expect(invokeMock).toHaveBeenLastCalledWith("cache_library_cover", expect.objectContaining({
      mangaId: 42,
      thumbnailUrl: "/api/v1/manga/42/thumbnail",
      coverUrl: "http://127.0.0.1:4567/thumb//api/v1/manga/42/thumbnail",
    }));
  });
});
