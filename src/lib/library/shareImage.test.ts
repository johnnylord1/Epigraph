import { expect, test, vi } from "vitest";
import type { Manga } from "../types";
import { getCachedLibraryCoverUrl } from "./coverCache";
import { loadShareCover } from "./shareImage";

vi.mock("./coverCache", () => ({
  getCachedLibraryCoverUrl: vi.fn(),
  cacheLibraryCoverFromServer: vi.fn(),
}));

test("uses the visible cover URL when the cached file cannot be decoded", async () => {
  const cachedUrl = "https://example.com/cached.png";
  const visibleUrl = "https://example.com/cover.png";
  const bitmap = { close: vi.fn() };
  vi.mocked(getCachedLibraryCoverUrl).mockResolvedValue(cachedUrl);
  const fetchCover = vi.fn<typeof fetch>().mockImplementation(async () => new Response("cover"));
  vi.stubGlobal("fetch", fetchCover);
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValueOnce(new Error("invalid cached image")).mockResolvedValue(bitmap));
  try {
    await expect(loadShareCover({ id: 1, thumbnailUrl: visibleUrl } as Manga, {})).resolves.toBe(bitmap);
    expect(fetchCover.mock.calls.map(([url]) => url)).toEqual([cachedUrl, visibleUrl]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("aborts a timed-out cover and releases a bitmap that decoded late", async () => {
  vi.useFakeTimers();
  try {
    const close = vi.fn();
    let finishDecoding!: (bitmap: Pick<ImageBitmap, "close">) => void;
    const decode = vi.fn(() => new Promise((resolve) => { finishDecoding = resolve; }));
    const fetchCover = vi.fn<typeof fetch>().mockResolvedValue(new Response("cover bytes"));
    vi.stubGlobal("fetch", fetchCover);
    vi.stubGlobal("createImageBitmap", decode);
    vi.mocked(getCachedLibraryCoverUrl).mockResolvedValue("https://example.com/cover.png");

    const cover = loadShareCover({ thumbnailUrl: "/cover.png" } as Manga, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(decode).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(cover).resolves.toBeNull();

    finishDecoding({ close });
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fetchCover.mock.calls[0][1]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
