import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../lib/i18n/runtime";

const { win, closeRequested, flushAllMangaProgress } = vi.hoisted(() => {
  const closeRequested: Array<(event: { preventDefault(): void }) => void> = [];
  return {
    closeRequested,
    // Suwayomi is away: saving the last page never finishes.
    flushAllMangaProgress: vi.fn(() => new Promise<void>(() => {})),
    win: {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      onResized: vi.fn(async () => () => {}),
      onCloseRequested: vi.fn(async (handler: (event: { preventDefault(): void }) => void) => {
        closeRequested.push(handler);
        return () => {};
      }),
      destroy: vi.fn(async () => {}),
    },
  };
});

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
// The window closes while it is still loading, before any reader opened.
vi.mock("../../lib/books/libraryState", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/books/libraryState")>(),
  reloadBookLibraryState: () => new Promise(() => {}),
}));
vi.mock("../../lib/reader/mangaProgressRuntime", () => ({
  configureDetachedMangaProgress: vi.fn(),
  flushAllMangaProgress,
}));

import DetachedReaderApp from "./DetachedReaderApp.svelte";

describe("DetachedReaderApp", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("closes without waiting for Suwayomi to save reading progress", async () => {
    const client = {
      label: "detached-reader-test",
      context: {
        runtimeServerUrl: "http://127.0.0.1:4567",
        runtimeServerLabel: null,
        runtimeResolvedLocalProfileId: null,
        runtimeResolvedLocalProfileMeta: null,
        target: { kind: "book", bookId: "book-1" },
      },
      notify: vi.fn(),
      request: vi.fn(async () => null),
      drain: vi.fn(async () => {}),
    };
    render(DetachedReaderApp, { props: { client: client as never } });
    await vi.waitFor(() => expect(closeRequested).toHaveLength(1));

    vi.useFakeTimers();
    const preventDefault = vi.fn();
    closeRequested[0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushAllMangaProgress).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(client.request).toHaveBeenCalledWith("flushBookLibraryPersistence", []);
    expect(client.drain).toHaveBeenCalledTimes(1);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });
});
