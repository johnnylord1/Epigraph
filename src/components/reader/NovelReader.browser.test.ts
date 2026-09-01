/// <reference types="@vitest/browser/matchers" />
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import { resetNovelLibraryStateCacheForTests } from "../../lib/novels/libraryState";
import type { PersistedNovelLibraryState } from "../../lib/novels/domain";

const { disk, readChapter } = vi.hoisted(() => ({
  disk: { state: null as any, failNextSave: false, failures: 0 },
  readChapter: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: any) => {
    if (command === "read_novel_library_state") return JSON.stringify(disk.state);
    if (command === "write_novel_library_state") {
      if (disk.failNextSave) { disk.failNextSave = false; disk.failures++; throw new Error("Disk temporarily unavailable"); }
      disk.state = JSON.parse(args.contents);
    }
    return null;
  }), convertFileSrc: (path: string) => path,
}));
vi.mock("../../lib/novels/sources", () => ({ readInstalledNovelChapter: readChapter }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, close: vi.fn() }) }));
vi.mock("../../lib/novels/offlineChapters", () => ({ loadCachedNovelChapter: async () => null, saveCachedNovelChapter: async () => {} }));
vi.mock("../../lib/discord", () => ({ setGenericReading: vi.fn(async () => {}), setTtsPresence: vi.fn(async () => {}) }));

import NovelReader from "./NovelReader.svelte";
const content = Array.from({ length: 80 }, (_, index) => `<p>Reading paragraph ${index}. A quiet afternoon in the library.</p>`).join("");

async function scrollTo(viewer: HTMLElement, fraction: number) {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  viewer.scrollTop = (viewer.scrollHeight - viewer.clientHeight) * fraction;
  await fireEvent.scroll(viewer);
}

describe("novel reader progress lifecycle", () => {
  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {};
    resetNovelLibraryStateCacheForTests();
    disk.failNextSave = false;
    disk.failures = 0;
    disk.state = {
      version: 1, scopeKey: "profile:test", updatedAtMs: 1,
      entries: [{ id: "novel", title: "Reading fixture", author: null, description: null, coverUrl: null, path: "/novel", status: "ONGOING", tags: [],
        source: { sourceId: "fixture", sourceName: "Fixture", pluginId: "fixture", pluginName: "Fixture", repositoryUrl: null }, chapterCount: 2, addedAt: 1, updatedAt: 1 }],
      chapters: [0, 1].map((index) => ({ id: `chapter-${index}`, novelId: "novel", path: `/chapter-${index}`, title: `Chapter ${index + 1}`, order: index, releaseTime: null, unread: true })),
      progress: [], bookmarks: [], history: [],
    } satisfies PersistedNovelLibraryState;
    readChapter.mockReset();
    readChapter.mockResolvedValue({ content });
    store.settings = { ...DEFAULT_SETTINGS, discordRpc: false };
    store.runtimeResolvedLocalProfileId = "test";
    store.activeNovelDetail = null;
    store.activeNovelReader = { novelId: "novel", chapterId: "chapter-0", chapterPath: "/chapter-0", chapterTitle: "Chapter 1", sourceId: "fixture" };
  });
  afterEach(() => { cleanup(); store.activeNovelReader = null; delete (window as any).__TAURI_INTERNALS__; });

  test("does not mark the next chapter as read while its content is loading", async () => {
    const { container } = render(NovelReader);
    await waitFor(() => expect(container.querySelector("article")?.textContent).toContain("Reading paragraph"));
    const viewer = container.querySelector<HTMLElement>(".novel-viewer")!;
    await scrollTo(viewer, 0.4);
    await waitFor(() => expect(disk.state.progress[0]?.progressPercent).toBeCloseTo(0.2, 1));
    let finishLoad!: (value: { content: string }) => void;
    readChapter.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
    await fireEvent.click(screen.getByTitle("Next"));
    await waitFor(() => expect(finishLoad).toBeTypeOf("function"));
    await fireEvent.scroll(viewer);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(disk.state.chapters[1].unread).toBe(true);
    finishLoad({ content });
  });

  test("recovers a failed save and persists subsequent reading", async () => {
    const { container } = render(NovelReader);
    await waitFor(() => expect(container.querySelector("article")?.textContent).toContain("Reading paragraph"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const viewer = container.querySelector<HTMLElement>(".novel-viewer")!;
    disk.failNextSave = true;
    await scrollTo(viewer, 0.3);
    await waitFor(() => expect(disk.failures).toBe(1));
    await scrollTo(viewer, 0.6);
    await waitFor(() => expect(disk.state.progress[0]?.progressPercent).toBeCloseTo(0.3, 1));
    expect(disk.state.chapters[0].unread).toBe(true);
  });
});
