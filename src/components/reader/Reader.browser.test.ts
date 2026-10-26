/// <reference types="@vitest/browser/matchers" />
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import type { Chapter, Manga } from "../../lib/types";
import { resetMangaProgressRuntimeForTests } from "../../lib/reader/mangaProgressRuntime";

const { fetchPages, writes } = vi.hoisted(() => ({
  fetchPages: vi.fn(),
  writes: [] as Array<{ ids: number[]; lastPageRead: number; isRead: boolean }>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../../lib/manga/runtime", () => ({ fetchSourceChapterPages: fetchPages }));
vi.mock("../../lib/client", () => ({
  getServerUrl: () => "http://127.0.0.1:0",
  getServerAuthHeader: () => ({}),
  serverFileUrl: (url: string) => url,
  gql: vi.fn(async (query: string, variables: any) => {
    if (query.includes("GetChapterProgress")) return { chapter: { id: variables.id, lastPageRead: 0, isRead: false } };
    if (query.includes("UpdateChaptersProgress")) writes.push({ ...variables });
    return {};
  }),
  thumbUrl: (url: string) => url,
}));
vi.mock("../../lib/imageCache", () => ({
  acquireResolvedMediaUrl: vi.fn(async (url: string) => ({ url, release: () => {} })),
  preloadBlobUrls: vi.fn(async () => {}), resetImageCache: vi.fn(),
  resolvedImage: (node: HTMLImageElement, input: any) => { node.src = typeof input === "string" ? input : input.url; return { destroy() {} }; }, warmResolvedMediaUrl: vi.fn(async () => {}),
}));
vi.mock("../../lib/discord", () => ({ setReading: vi.fn(async () => {}), clearActivity: vi.fn(async () => {}) }));

import Reader from "./Reader.svelte";

function key(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("manga reader progress lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    resetMangaProgressRuntimeForTests();
    writes.length = 0;
    fetchPages.mockReset();
    const page = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="white"/></svg>')}`;
    fetchPages.mockResolvedValue({ fetchChapterPages: { pages: Array.from({ length: 10 }, () => page) } });
    store.settings = { ...DEFAULT_SETTINGS, pageStyle: "single", readingDirection: "ltr", autoMarkRead: true, autoBookmark: false, discordRpc: false };
    store.activeManga = { id: 91, title: "Reader certification", thumbnailUrl: "", inLibrary: true } as Manga;
    store.activeChapter = { id: 81, mangaId: 91, name: "Chapter 1", pageCount: 10, lastPageRead: 0, isRead: false } as Chapter;
    store.activeChapterList = [store.activeChapter];
    store.pageUrls = [];
    store.pageNumber = 1;
    store.bookmarks = [];
    store.history = [];
    store.readLog = [];
  });
  afterEach(() => { cleanup(); store.activeChapter = null; store.activeManga = null; });

  test.each(["single", "fade"] as const)("advances to page four without reloading and saves partial progress in %s", async (style) => {
    store.settings.pageStyle = style;
    render(Reader);
    await waitFor(() => expect(store.pageUrls).toHaveLength(10));
    key("ArrowRight");
    await waitFor(() => expect(store.pageNumber).toBe(2));
    key("ArrowRight");
    await waitFor(() => expect(store.pageNumber).toBe(3));
    key("ArrowRight");
    await waitFor(() => expect(store.pageNumber).toBe(4));
    await waitFor(() => expect(writes.at(-1)).toEqual({ ids: [81], lastPageRead: 3, isRead: false }));
    expect(fetchPages).toHaveBeenCalledTimes(1);
    expect(store.readLog).toHaveLength(0);
  });

  test("turns pages from keys pressed while the page viewer has focus", async () => {
    const { container } = render(Reader);
    await waitFor(() => expect(store.pageUrls).toHaveLength(10));
    const viewer = container.querySelector<HTMLElement>(".viewer")!;
    viewer.focus();
    expect(document.activeElement).toBe(viewer);
    viewer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await waitFor(() => expect(store.pageNumber).toBe(2));
  });

  test("records history and bookmarks once per page, not again when settings are re-adopted", async () => {
    store.settings.autoBookmark = true;
    const history = vi.spyOn(store, "addHistory");
    const bookmark = vi.spyOn(store, "addBookmark");
    try {
      render(Reader);
      await waitFor(() => expect(store.pageUrls).toHaveLength(10));
      key("ArrowRight");
      await waitFor(() => expect(store.pageNumber).toBe(2));
      await waitFor(() => expect(bookmark).toHaveBeenCalled());
      const calls = [history.mock.calls.length, bookmark.mock.calls.length];

      // A detached window replaces its settings whenever another window persists state.
      store.settings = { ...store.settings };
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect([history.mock.calls.length, bookmark.mock.calls.length]).toEqual(calls);
    } finally {
      history.mockRestore();
      bookmark.mockRestore();
    }
  });

  test("keeps longstrip images and scroll position stable after saving a page", async () => {
    store.settings.pageStyle = "longstrip";
    store.settings.autoNextChapter = false;
    const { container } = render(Reader);
    await waitFor(() => expect(container.querySelectorAll("img[data-local-page]")).toHaveLength(10));
    const images = [...container.querySelectorAll<HTMLImageElement>("img[data-local-page]")];
    await waitFor(() => expect(images[3].complete && images[3].naturalHeight > 0).toBe(true));
    const viewer = container.querySelector<HTMLElement>(".viewer")!;
    await fireEvent.pointerDown(viewer);
    images[3].scrollIntoView({ block: "start" });
    await waitFor(() => expect(writes.at(-1)?.lastPageRead).toBe(3));
    const savedTop = viewer.scrollTop;
    expect(savedTop).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(container.querySelector('img[data-local-page="4"]')).toBe(images[3]);
    expect(viewer.scrollTop).toBe(savedTop);
  });

  test("keeps the longstrip page under the read line when the viewer is resized, as fullscreen does", async () => {
    store.settings.pageStyle = "longstrip";
    store.settings.fitMode = "width";
    store.settings.autoNextChapter = false;
    const { container } = render(Reader);
    await waitFor(() => expect(container.querySelectorAll("img[data-local-page]")).toHaveLength(10));
    const images = [...container.querySelectorAll<HTMLImageElement>("img[data-local-page]")];
    await waitFor(() => expect(images.slice(0, 5).every((img) => img.complete && img.naturalHeight > 0)).toBe(true));
    const viewer = container.querySelector<HTMLElement>(".viewer")!;
    const readLine = () => viewer.getBoundingClientRect().top + viewer.clientHeight * 0.2;
    const pageUnderLine = () => images.findLast((img) => img.getBoundingClientRect().top <= readLine())!;
    const depthIntoPage = (img: HTMLElement) => {
      const box = img.getBoundingClientRect();
      return (readLine() - box.top) / box.height;
    };

    await fireEvent.pointerDown(viewer);
    const page4 = images[3].getBoundingClientRect();
    viewer.scrollTop += page4.top + page4.height * 0.6 - readLine();
    await waitFor(() => expect(store.pageNumber).toBe(4));

    try {
      // Leaving and entering fullscreen: the strip reflows to the new width and height.
      for (const [width, height] of [[900, 600], [1280, 800]]) {
        const before = viewer.clientWidth;
        await page.viewport(width, height);
        await waitFor(() => expect(viewer.clientWidth).not.toBe(before));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(pageUnderLine()).toBe(images[3]);
        expect(depthIntoPage(images[3])).toBeCloseTo(0.6, 1);
        expect(store.pageNumber).toBe(4);
      }
    } finally {
      await page.viewport(1280, 800);
    }
  });

  test.each(["height", "screen"] as const)("keeps longstrip slices of one width aligned when fitting to %s", async (fitMode) => {
    const slice = (height: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${height}"><rect width="400" height="${height}" fill="white"/></svg>`)}`;
    fetchPages.mockResolvedValue({ fetchChapterPages: { pages: [slice(600), slice(3000), slice(600), slice(3000)] } });
    store.settings.pageStyle = "longstrip";
    store.settings.fitMode = fitMode;
    store.settings.autoNextChapter = false;
    const { container } = render(Reader);
    await waitFor(() => expect(container.querySelectorAll("img[data-local-page]")).toHaveLength(4));
    const images = [...container.querySelectorAll<HTMLImageElement>("img[data-local-page]")];
    await waitFor(() => expect(images.every((img) => img.complete && img.naturalHeight > 0)).toBe(true));
    // A slice taller than the viewer used to be capped to its height and shrink narrower.
    expect(new Set(images.map((img) => Math.round(img.getBoundingClientRect().width)))).toEqual(new Set([400]));
  });

  test("opens a page taller than the viewer at its top", async () => {
    const tall = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="3000"><rect width="400" height="3000" fill="white"/></svg>')}`;
    fetchPages.mockResolvedValue({ fetchChapterPages: { pages: [tall, tall] } });
    store.settings.fitMode = "original";
    const { container } = render(Reader);
    await waitFor(() => expect(store.pageUrls).toHaveLength(2));
    const viewer = container.querySelector<HTMLElement>(".viewer")!;
    const image = await waitFor(() => {
      const img = viewer.querySelector<HTMLImageElement>("img")!;
      expect(img.complete && img.naturalHeight > 0).toBe(true);
      return img;
    });
    viewer.scrollTop = 0;
    // Centering alone pushed the top of the page above the viewer, out of scroll reach.
    expect(image.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewer.getBoundingClientRect().top - 1);
  });

  test("opening an unread chapter at its saved final page does not complete it", async () => {
    store.activeChapter = { ...store.activeChapter!, lastPageRead: 9 };
    store.activeChapterList = [store.activeChapter];
    render(Reader);
    await waitFor(() => expect(store.pageNumber).toBe(10));
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(writes).toEqual([]);
    expect(store.activeChapter?.isRead).toBe(false);
    expect(store.readLog).toHaveLength(0);
  });

  test("persists the zero-based final page and completion exactly once after real navigation", async () => {
    render(Reader);
    await waitFor(() => expect(store.pageUrls).toHaveLength(10));

    for (let page = 2; page <= 10; page += 1) {
      key("ArrowRight");
      await waitFor(() => expect(store.pageNumber).toBe(page));
    }

    await waitFor(() => expect(writes.at(-1)).toEqual({ ids: [81], lastPageRead: 9, isRead: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(writes.filter((entry) => entry.isRead)).toHaveLength(1);
    expect(store.readLog).toHaveLength(1);
  });

  test("a detached window opens on the page list the main window handed over, once", async () => {
    const handedOver = Array.from({ length: 3 }, (_, index) => `http://127.0.0.1:0/api/v1/manga/91/chapter/1/page/${index}`);
    render(Reader, { props: { initialPages: { chapterId: 81, urls: handedOver } } });
    await waitFor(() => expect(store.pageUrls).toEqual(handedOver));
    expect(fetchPages).not.toHaveBeenCalled();
    cleanup();

    store.pageUrls = [];
    render(Reader, { props: { initialPages: { chapterId: 999, urls: handedOver } } });
    await waitFor(() => expect(store.pageUrls).toHaveLength(10));
    expect(fetchPages).toHaveBeenCalledTimes(1);
  });

  test("a chapter the source cannot reach is explained without the raw exception and retried on request", async () => {
    fetchPages.mockRejectedValueOnce(new Error("Exception while fetching data (/fetchChapterPages) : Connection refused: getsockopt\r\n\r\njava.io.IOException: Connection refused: getsockopt"));
    const { container, getByRole } = render(Reader);
    await waitFor(() => expect(container.textContent).toContain("The source did not respond."));
    expect(container.textContent).not.toContain("java.io.IOException");

    await fireEvent.click(getByRole("button", { name: "Retry chapter" }));
    await waitFor(() => expect(store.pageUrls).toHaveLength(10));
    expect(fetchPages).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("The source did not respond.");
  });
});
