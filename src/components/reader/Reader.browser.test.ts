/// <reference types="@vitest/browser/matchers" />
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
});
