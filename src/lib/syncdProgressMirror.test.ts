import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  PROGRESS_MIRROR_DEBOUNCE_MS,
  requestCatalogMirror,
  requestProgressMirror,
  resetProgressMirrorRequestsForTests,
} from "./syncdProgressMirror";

describe("progress mirror requests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(true);
    resetProgressMirrorRequestsForTests();
  });

  afterEach(() => {
    resetProgressMirrorRequestsForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("coalesces a burst of edits into one request after the debounce", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    requestProgressMirror({ mangaIds: [3], chapterIds: [508] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS - 1);
    requestProgressMirror({ mangaIds: [3, 4], chapterIds: [508, 509, 0, -2, 1.5] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS - 1);
    expect(invokeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("syncd_request_progress_mirror", {
      mangaIds: [3, 4],
      chapterIds: [508, 509],
    });

    // The next edit starts a fresh batch.
    requestProgressMirror({ chapterIds: [600] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).toHaveBeenLastCalledWith("syncd_request_progress_mirror", { mangaIds: [], chapterIds: [600] });
  });

  test("a category edit requests a tick without ids", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    requestCatalogMirror();
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).toHaveBeenCalledWith("syncd_request_progress_mirror", { mangaIds: [], chapterIds: [] });

    // The flag is consumed by the request it rode on.
    invokeMock.mockClear();
    requestProgressMirror({ mangaIds: [-1] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("swallows command failures because the periodic mirror is the fallback", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock.mockRejectedValueOnce(new Error("Core is away"));
    requestProgressMirror({ mangaIds: [3] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("does nothing outside Tauri or without valid ids", () => {
    requestProgressMirror({ mangaIds: [3], chapterIds: [508] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).not.toHaveBeenCalled();

    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    requestProgressMirror({ mangaIds: [0], chapterIds: [Number.NaN] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
