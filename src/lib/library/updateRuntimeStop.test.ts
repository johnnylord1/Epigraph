import { beforeEach, describe, expect, it, vi } from "vitest";

const { gqlMock, fetchChaptersMock } = vi.hoisted(() => ({
  gqlMock: vi.fn(),
  fetchChaptersMock: vi.fn(),
}));

vi.mock("../client", () => ({
  gql: gqlMock,
  getServerUrl: () => "http://127.0.0.1:4567",
  getServerAuthHeader: () => null,
}));
vi.mock("../serverLifecycle", () => ({ ensureServerAwakeFor: vi.fn(async () => true) }));
vi.mock("../suwayomiUpdateLock.svelte", () => ({
  withSuwayomiOperationLease: (_name: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../manga/runtime", () => ({ fetchSourceMangaChapters: fetchChaptersMock }));

import {
  beginLibraryUpdateSession,
  clearStaleLibraryUpdateInFlight,
  endLibraryUpdateSession,
  runSharedLibraryUpdate,
  showNovelLibraryRefreshProgress,
  stopSharedLibraryUpdate,
} from "./updateRuntime";
import { LIBRARY_UPDATE_TOAST_ID, store } from "../../store/state.svelte";
import { applyAppLanguage } from "../i18n/runtime";

const libraryToast = () => store.toasts.find((toast) => toast.id === LIBRARY_UPDATE_TOAST_ID);

function manga(id: number) {
  return { id, title: `Title ${id}`, inLibrary: true, sourceId: "1", source: { id: "1", name: "Source", displayName: "Source" } };
}

describe("stopping a library update", () => {
  beforeEach(() => {
    applyAppLanguage("en");
    store.toasts = [];
    store.libraryMangaSnapshot = [manga(1), manga(2), manga(3)] as never;
    gqlMock.mockReset();
    gqlMock.mockResolvedValue({ categories: { nodes: [] } });
    fetchChaptersMock.mockReset();
  });

  it("ends the source queue at the next title and marks the run cancelled", async () => {
    const stopSignal = beginLibraryUpdateSession();
    let stopOffered = false;
    const bodiesAfterStop: string[] = [];
    fetchChaptersMock.mockImplementation(async () => {
      stopOffered ||= libraryToast()?.actions?.[0]?.label === "Stop";
      await stopSharedLibraryUpdate();
      return { fetchChapters: { chapters: [] } };
    });
    const stopRequested = "Stop requested. Finishing the current title before stopping.";
    const showProgress = store.showProgressToast.bind(store);
    const progressSpy = vi.spyOn(store, "showProgressToast").mockImplementation((id, toast) => {
      const body = toast.body ?? "";
      if (bodiesAfterStop.length > 0 || body === stopRequested) bodiesAfterStop.push(body);
      return showProgress(id, toast);
    });

    try {
      const run = await runSharedLibraryUpdate({ reason: "manual-library-update" });

      expect(stopOffered).toBe(true);
      // The title in flight finishes after Stop without bringing back the "checking" text.
      expect(bodiesAfterStop[0]).toBe(stopRequested);
      expect(bodiesAfterStop.some((body) => body.startsWith("Checking"))).toBe(false);
      expect(fetchChaptersMock).toHaveBeenCalledTimes(1);
      expect(run.cancelled).toBe(true);
      // The caller's later steps see the same stop.
      expect(stopSignal.aborted).toBe(true);
      expect(libraryToast()?.actions).toBeUndefined();
    } finally {
      progressSpy.mockRestore();
      endLibraryUpdateSession(stopSignal);
    }
  });

  it("runs every title when nobody stops it", async () => {
    const stopSignal = beginLibraryUpdateSession();
    fetchChaptersMock.mockResolvedValue({ fetchChapters: { chapters: [] } });

    try {
      const run = await runSharedLibraryUpdate({ reason: "manual-library-update" });

      expect(fetchChaptersMock).toHaveBeenCalledTimes(3);
      expect(run.cancelled).toBe(false);
      expect(stopSignal.aborted).toBe(false);
      // The caller still has steps to run, so the toast stays open and can still be stopped.
      expect(libraryToast()?.progress?.active).toBe(true);
      expect(libraryToast()?.actions?.[0]?.label).toBe("Stop");
    } finally {
      endLibraryUpdateSession(stopSignal);
    }
  });

  it("keeps an open books update in flight while Suwayomi itself is idle", async () => {
    const stopSignal = beginLibraryUpdateSession();
    vi.stubGlobal("fetch", async () => { throw new TypeError("direct status unavailable"); });
    gqlMock.mockResolvedValue({ libraryUpdateStatus: { jobsInfo: { isRunning: false, totalJobs: 0, finishedJobs: 0 } } });
    store.setLibraryUpdateInFlight(true);
    showNovelLibraryRefreshProgress({ checked: 1, total: 10, currentTitle: "Novel", newChapters: 0, failed: 0 });

    try {
      // An automatic update or the dialog asking whether the run is stale must not end it mid-way.
      expect(await clearStaleLibraryUpdateInFlight()).toBe(false);
      expect(store.libraryUpdateInFlight).toBe(true);
      expect(libraryToast()?.progress?.active).toBe(true);
      expect(libraryToast()?.body).not.toBe("Library update complete.");
    } finally {
      endLibraryUpdateSession(stopSignal);
      store.setLibraryUpdateInFlight(false);
      vi.unstubAllGlobals();
    }
  });

  it("keeps the stop notice while the books refresh finishes its current title", async () => {
    const stopSignal = beginLibraryUpdateSession();
    showNovelLibraryRefreshProgress({ checked: 1, total: 10, currentTitle: "Novel", newChapters: 0, failed: 0 });

    try {
      await stopSharedLibraryUpdate();
      showNovelLibraryRefreshProgress({ checked: 2, total: 10, currentTitle: "Novel 2", newChapters: 0, failed: 0 });

      expect(libraryToast()?.body).toBe("Stop requested. Finishing the current title before stopping.");
      expect(libraryToast()?.progress?.current).toBe(2);
    } finally {
      endLibraryUpdateSession(stopSignal);
    }
  });
});
