import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireResolvedMediaUrl,
  getImageCacheStats,
  preloadBlobUrls,
  releaseResolvedMediaUrl,
  requiresAuthenticatedMediaFetch,
  resetImageCache,
  resolvedImage,
} from "./imageCache";
import { updateSettings } from "../store/state.svelte";

const fetchMock = vi.fn();
const createObjectUrlMock = vi.fn();
const revokeObjectUrlMock = vi.fn();
let createObjectUrlSpy: { mockRestore(): void } | null = null;
let revokeObjectUrlSpy: { mockRestore(): void } | null = null;

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

describe("imageCache", () => {
  beforeEach(() => {
    resetImageCache();
    fetchMock.mockReset();
    createObjectUrlMock.mockReset();
    revokeObjectUrlMock.mockReset();
    createObjectUrlMock.mockImplementation(() => `blob:${Math.random()}`);
    createObjectUrlSpy?.mockRestore();
    revokeObjectUrlSpy?.mockRestore();
    createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockImplementation(createObjectUrlMock);
    revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectUrlMock);
    updateSettings({
      serverUrl: "http://127.0.0.1:4567",
      serverAuthEnabled: false,
      serverAuthUser: "",
      serverAuthPass: "",
    });
  });

  afterEach(() => {
    resetImageCache();
    createObjectUrlSpy?.mockRestore();
    revokeObjectUrlSpy?.mockRestore();
    createObjectUrlSpy = null;
    revokeObjectUrlSpy = null;
  });

  it("keeps the direct plain URL path when auth is disabled", async () => {
    const url = "http://127.0.0.1:4567/api/v1/cover";

    const lease = await acquireResolvedMediaUrl(url);

    expect(lease.resolvedUrl).toBe(url);
    expect(requiresAuthenticatedMediaFetch(url)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses plugin-http with an auth header for same-origin media when auth is enabled", async () => {
    updateSettings({
      serverAuthEnabled: true,
      serverAuthUser: "demo",
      serverAuthPass: "secret",
    });
    fetchMock.mockResolvedValue(new Response(new Blob(["cover"]), { status: 200 }));

    const url = "http://127.0.0.1:4567/api/v1/cover";
    const lease = await acquireResolvedMediaUrl(url);

    expect(lease.resolvedUrl.startsWith("blob:")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: `Basic ${btoa("demo:secret")}`,
      }),
    }));
  });

  it("does not proxy external media through authenticated fetches", async () => {
    updateSettings({
      serverAuthEnabled: true,
      serverAuthUser: "demo",
      serverAuthPass: "secret",
    });

    const url = "https://example.com/cover.png";
    const lease = await acquireResolvedMediaUrl(url);

    expect(lease.resolvedUrl).toBe(url);
    expect(requiresAuthenticatedMediaFetch(url)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedupes preload fetches and keeps priority order safe", async () => {
    updateSettings({
      serverAuthEnabled: true,
      serverAuthUser: "demo",
      serverAuthPass: "secret",
    });
    fetchMock.mockImplementation(() => Promise.resolve(new Response(new Blob(["page"]), { status: 200 })));

    const urls = [
      "http://127.0.0.1:4567/page-1",
      "http://127.0.0.1:4567/page-2",
      "http://127.0.0.1:4567/page-1",
    ];

    const resolved = await preloadBlobUrls(urls, 1);

    expect(resolved).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4567/page-2");
  });

  it("revokes blob URLs only after the final release", async () => {
    updateSettings({
      serverAuthEnabled: true,
      serverAuthUser: "demo",
      serverAuthPass: "secret",
    });
    createObjectUrlMock.mockReturnValue("blob:cover");
    fetchMock.mockResolvedValue(new Response(new Blob(["cover"]), { status: 200 }));

    const url = "http://127.0.0.1:4567/api/v1/cover";
    const first = await acquireResolvedMediaUrl(url);
    const second = await acquireResolvedMediaUrl(url);

    first.release();
    expect(revokeObjectUrlMock).not.toHaveBeenCalled();

    second.release();
    releaseResolvedMediaUrl(url);
    expect(revokeObjectUrlMock).not.toHaveBeenCalled();

    resetImageCache();
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:cover");
  });

  it("resolvedImage releases the previous media lease on update and destroy", async () => {
    updateSettings({
      serverAuthEnabled: true,
      serverAuthUser: "demo",
      serverAuthPass: "secret",
    });
    createObjectUrlMock
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    fetchMock
      .mockResolvedValueOnce(new Response(new Blob(["one"]), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(["two"]), { status: 200 }));

    const node = {
      src: "",
      removeAttribute: vi.fn(),
    } as unknown as HTMLImageElement;
    const action = resolvedImage(node, "http://127.0.0.1:4567/page-1");
    if (!action) throw new Error("resolvedImage must return action controls");
    await Promise.resolve();
    await Promise.resolve();

    action.update?.("http://127.0.0.1:4567/page-2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    action.destroy?.();
    expect(getImageCacheStats().activeLeaseCount).toBe(0);
    resetImageCache();

    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:first");
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:second");
  });

  it("releases an obsolete async lease after the image source changes", async () => {
    updateSettings({
      serverAuthEnabled: true,
      serverAuthUser: "demo",
      serverAuthPass: "secret",
    });

    let resolveFirst!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    }));
    fetchMock.mockResolvedValueOnce(new Response(new Blob(["second"]), { status: 200 }));

    const node = {
      src: "",
      removeAttribute: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLImageElement;
    const action = resolvedImage(node, "http://127.0.0.1:4567/page-stale");
    if (!action) throw new Error("resolvedImage must return action controls");
    action.update?.("http://127.0.0.1:4567/page-current");

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFirst(new Response(new Blob(["first"]), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getImageCacheStats().activeLeaseCount).toBe(1);
    action.destroy?.();
    expect(getImageCacheStats().activeLeaseCount).toBe(0);
  });

  it("resolvedImage does not reapply the same failed source until the url changes", async () => {
    let srcWrites = 0;
    let nodeSrc = "";
    let errorHandler: () => void = () => {
      throw new Error("Expected resolvedImage to register an error handler");
    };
    const node = {
      get src() {
        return nodeSrc;
      },
      set src(value: string) {
        srcWrites += 1;
        nodeSrc = value;
      },
      removeAttribute: vi.fn(),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "error") errorHandler = handler;
      }),
      removeEventListener: vi.fn(),
    } as unknown as HTMLImageElement;

    const action = resolvedImage(node, "https://example.test/broken.jpg");
    if (!action) throw new Error("resolvedImage must return action controls");
    await Promise.resolve();

    expect(srcWrites).toBe(1);
    errorHandler();

    action.update?.("https://example.test/broken.jpg");
    await Promise.resolve();

    expect(srcWrites).toBe(1);

    action.update?.("https://example.test/broken.jpg?retry=1");
    await Promise.resolve();

    expect(srcWrites).toBe(2);
  });
});
