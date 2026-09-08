/// <reference types="@vitest/browser/matchers" />
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import { resetNovelLibraryStateCacheForTests } from "../../lib/novels/libraryState";
import type { PersistedNovelLibraryState } from "../../lib/novels/domain";

const { disk, readChapter } = vi.hoisted(() => ({
  disk: { state: null as any, failNextSave: false, failures: 0, writes: 0, pending: null as Promise<void> | null, reads: 0, pendingFirstRead: null as Promise<void> | null, firstReadMissing: false, pendingFirstWrite: null as Promise<void> | null },
  readChapter: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: any) => {
    if (command === "read_novel_library_state") {
      disk.reads++;
      if (disk.reads === 1 && disk.pendingFirstRead) await disk.pendingFirstRead;
      if (disk.reads === 1 && disk.firstReadMissing) return null;
      return JSON.stringify(disk.state);
    }
    if (command === "write_novel_library_state") {
      disk.writes++;
      if (disk.writes === 1 && disk.pendingFirstWrite) await disk.pendingFirstWrite;
      if (disk.pending) await disk.pending;
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
    disk.writes = 0;
    disk.pending = null;
    disk.reads = 0;
    disk.pendingFirstRead = null;
    disk.firstReadMissing = false;
    disk.pendingFirstWrite = null;
    localStorage.removeItem("epigraph-novels-library-state");
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

  async function mountedReader() {
    const result = render(NovelReader);
    await waitFor(() => expect(result.container.querySelector("article")?.textContent).toContain("Reading paragraph"));
    return { ...result, viewer: result.container.querySelector<HTMLElement>(".novel-viewer")! };
  }

  test("restore preparation drains queued progress, coalesces calls, and closes before authorizing restore", async () => {
    const { component, viewer } = await mountedReader();
    let release!: () => void;
    disk.pending = new Promise<void>((resolve) => { release = resolve; });
    await scrollTo(viewer, 0.3);
    await waitFor(() => expect(disk.writes).toBe(1));
    await scrollTo(viewer, 0.6);
    let authorized = false;
    const first = component.prepareNovelReaderForRestore();
    const second = component.prepareNovelReaderForRestore();
    void first.then((result: { ok: boolean }) => { authorized = result.ok; });
    await scrollTo(viewer, 0.9);
    expect(authorized).toBe(false);
    expect(store.activeNovelReader).not.toBeNull();
    release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(store.activeNovelReader).toBeNull();
    expect(disk.state.progress[0]?.progressPercent).toBeCloseTo(0.3, 1);
    const writes = disk.writes;
    expect(await component.prepareNovelReaderForRestore()).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(disk.writes).toBe(writes);
    expect(writes).toBe(2);
  });

  test("restore preparation refuses a failed persistence boundary and retains reader state for retry", async () => {
    const { component, viewer } = await mountedReader();
    await scrollTo(viewer, 0.4);
    disk.failNextSave = true;
    expect(await component.prepareNovelReaderForRestore()).toMatchObject({ ok: false, code: "RESTORE_REFUSED_READER_NOT_FLUSHED" });
    expect(store.activeNovelReader).not.toBeNull();
    expect(await component.prepareNovelReaderForRestore()).toEqual({ ok: true });
    expect(disk.state.progress[0]?.progressPercent).toBeCloseTo(0.2, 1);
  });

  test("restore preparation with no active or pending reader is a no-op", async () => {
    store.activeNovelReader = null;
    const { component } = render(NovelReader);
    expect(await component.prepareNovelReaderForRestore()).toEqual({ ok: true });
    expect(disk.writes).toBe(0);
  });

  test("the normal close button still persists and closes, including retry after a save failure", async () => {
    const { container, viewer } = await mountedReader();
    await scrollTo(viewer, 0.4);
    disk.failNextSave = true;
    await fireEvent.click(container.querySelector(".reader-back-link")!);
    await waitFor(() => expect(disk.failures).toBe(1));
    expect(store.activeNovelReader).not.toBeNull();
    await scrollTo(viewer, 0.6);
    await fireEvent.click(container.querySelector(".reader-back-link")!);
    await waitFor(() => expect(store.activeNovelReader).toBeNull());
    expect(disk.state.progress[0]?.progressPercent).toBeCloseTo(0.3, 1);
  });

  test("a pending bookmark is drained and new bookmarks are refused during preparation", async () => {
    const { component, container } = await mountedReader();
    let release!: () => void;
    disk.pending = new Promise<void>((resolve) => { release = resolve; });
    const bookmark = container.querySelector<HTMLButtonElement>("button[title='Bookmark']")!;
    expect(bookmark).not.toBeNull();
    await fireEvent.click(bookmark);
    await waitFor(() => expect(disk.writes).toBe(1));
    const preparation = component.prepareNovelReaderForRestore();
    await fireEvent.click(bookmark);
    release();
    expect(await preparation).toEqual({ ok: true });
    expect(disk.state.bookmarks).toHaveLength(1);
    expect(disk.writes).toBe(1);
  });

  test("restore preparation timeout refuses authorization while the original save remains protected", async () => {
    const { component, viewer } = await mountedReader();
    let release!: () => void;
    disk.pending = new Promise<void>((resolve) => { release = resolve; });
    await scrollTo(viewer, 0.4);
    vi.useFakeTimers();
    try {
      const preparation = component.prepareNovelReaderForRestore();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await preparation).toMatchObject({ ok: false, code: "RESTORE_REFUSED_READER_NOT_FLUSHED", reason: "timeout" });
      expect(store.activeNovelReader).not.toBeNull();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.activeNovelReader).not.toBeNull();
      expect(await component.prepareNovelReaderForRestore()).toEqual({ ok: true });
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  test("restore timeout also protects an already-pending ordinary close", async () => {
    const { component, container, viewer } = await mountedReader();
    let release!: () => void;
    disk.pending = new Promise<void>((resolve) => { release = resolve; });
    await scrollTo(viewer, 0.4);
    await fireEvent.click(container.querySelector(".reader-back-link")!);
    vi.useFakeTimers();
    try {
      const preparation = component.prepareNovelReaderForRestore();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await preparation).toMatchObject({ ok: false, reason: "timeout" });
      const retryWhilePending = component.prepareNovelReaderForRestore();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(await retryWhilePending).toMatchObject({ ok: false });
      expect(store.activeNovelReader).not.toBeNull();
      expect(disk.writes).toBe(1);
      expect(await component.prepareNovelReaderForRestore()).toEqual({ ok: true });
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  test("restore preparation waits for a pending scope load that can migrate legacy state", async () => {
    let release!: () => void;
    disk.pendingFirstRead = new Promise<void>((resolve) => { release = resolve; });
    const { component } = await mountedReader();
    let authorized = false;
    const preparation = component.prepareNovelReaderForRestore();
    void preparation.then((result: { ok: boolean }) => { authorized = result.ok; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(authorized).toBe(false);
    release();
    expect(await preparation).toEqual({ ok: true });
  });

  test("ordinary close does not wait for a pending chapter network read", async () => {
    let release!: (value: { content: string }) => void;
    readChapter.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { container } = render(NovelReader);
    await waitFor(() => expect(readChapter).toHaveBeenCalled());
    await fireEvent.click(container.querySelector(".reader-back-link")!);
    await waitFor(() => expect(store.activeNovelReader).toBeNull());
    release({ content });
    expect(disk.writes).toBe(0);
  });

  test("a late legacy migration cannot replace acknowledged reading progress during preparation", async () => {
    localStorage.setItem("epigraph-novels-library-state", JSON.stringify({ "profile:test": disk.state }));
    disk.firstReadMissing = true;
    let release!: () => void;
    disk.pendingFirstWrite = new Promise<void>((resolve) => { release = resolve; });
    const { component, viewer } = await mountedReader();
    await scrollTo(viewer, 0.6);
    await waitFor(() => expect(disk.state.progress[0]?.progressPercent).toBeCloseTo(0.3, 1));
    const preparation = component.prepareNovelReaderForRestore();
    release();
    expect(await preparation).toEqual({ ok: true });
    expect(disk.state.progress[0]?.progressPercent).toBeCloseTo(0.3, 1);
  });
});
