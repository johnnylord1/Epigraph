import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  mutationMayChangeCatalog,
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
      catalog: false,
    });

    // The next edit starts a fresh batch.
    requestProgressMirror({ chapterIds: [600] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).toHaveBeenLastCalledWith("syncd_request_progress_mirror", { mangaIds: [], chapterIds: [600], catalog: false });
  });

  test("a catalog edit requests a tick flagged as a catalog change", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    requestCatalogMirror();
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).toHaveBeenCalledWith("syncd_request_progress_mirror", { mangaIds: [], chapterIds: [], catalog: true });

    // The flag is consumed by the request it rode on.
    invokeMock.mockClear();
    requestProgressMirror({ mangaIds: [-1] });
    vi.advanceTimersByTime(PROGRESS_MIRROR_DEBOUNCE_MS);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("only progress, download and tracker mutations leave the catalog revision alone", () => {
    for (const document of [
      "mutation UpdateChaptersProgress($ids: [Int!]!) { updateChapters(input: { ids: $ids, patch: { isRead: true } }) { chapters { id } } }",
      "# reading\nmutation { a: enqueueChapterDownloads(input: { ids: [1] }) { clientMutationId } b: updateTrack(input: { recordId: 1 }) { trackRecord { id } } }",
      'mutation { updateChapter(input: { id: 1, patch: { lastPageRead: 3 }, note: "} createCategory {" }) { chapter { id } } }',
    ]) {
      expect(mutationMayChangeCatalog(document), document).toBe(false);
    }
    for (const document of [
      "mutation UpdateManga($id: Int!) { updateManga(input: { id: $id, patch: { inLibrary: true } }) { manga { id } } }",
      "mutation { updateChapters(input: { ids: [1] }) { clientMutationId } createCategory(input: { name: \"x\" }) { category { id } } }",
      "mutation { updateChapter: updateExtension(input: { id: \"x\" }) { extension { pkgName } } }",
      "mutation RestoreBackup($backup: Upload!) { restoreBackup(input: { backup: $backup }) { id } }",
      "",
    ]) {
      expect(mutationMayChangeCatalog(document), document).toBe(true);
    }
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
