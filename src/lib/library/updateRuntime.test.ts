import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLibraryUpdateMangaPatches,
  beginLibraryUpdateSession,
  clearStaleLibraryUpdateInFlight,
  endLibraryUpdateSession,
  formatLibraryUpdateFinalSummary,
  formatLibraryUpdateProgress,
  formatLibraryUpdateStalled,
  formatLibraryUpdateWaiting,
  libraryUpdateProgressNumbers,
  showLibraryUpdateProgress,
} from "./updateRuntime";
import { LIBRARY_UPDATE_TOAST_ID, showProgressToast, store } from "../../store/state.svelte";
import { applyAppLanguage } from "../i18n/runtime";

describe("library update runtime helpers", () => {
  beforeEach(() => {
    applyAppLanguage("en");
    vi.restoreAllMocks();
    store.libraryUpdateInFlight = false;
    store.toasts = [];
  });

  const libraryToast = () => store.toasts.find((toast) => toast.id === LIBRARY_UPDATE_TOAST_ID);

  it("formats running progress with bounded numbers", () => {
    const jobsInfo = {
      isRunning: true,
      finishedJobs: 7,
      totalJobs: 20,
      skippedMangasCount: 3,
    };

    expect(formatLibraryUpdateProgress(jobsInfo)).toBe("Checking titles 7/20 - 35%, 3 skipped by folder rules.");
    expect(libraryUpdateProgressNumbers(jobsInfo)).toEqual({
      current: 7,
      total: 20,
      percent: 35,
    });
  });

  it("does not show 100 percent before the final title is finished", () => {
    const jobsInfo = {
      isRunning: true,
      finishedJobs: 631,
      totalJobs: 633,
      skippedMangasCount: 0,
    };

    expect(formatLibraryUpdateProgress(jobsInfo)).toBe("Checking titles 631/633 - 99%.");
    expect(libraryUpdateProgressNumbers(jobsInfo)).toEqual({
      current: 631,
      total: 633,
      percent: 99,
    });
  });

  it("uses complete copy only after all titles finish", () => {
    expect(formatLibraryUpdateProgress({
      isRunning: true,
      finishedJobs: 633,
      totalJobs: 633,
    })).toBe("Finalizing update for 633 titles.");
    expect(libraryUpdateProgressNumbers({
      isRunning: true,
      finishedJobs: 633,
      totalJobs: 633,
    })?.percent).toBe(99);

    expect(formatLibraryUpdateProgress({
      isRunning: false,
      finishedJobs: 633,
      totalJobs: 633,
    })).toBe("Checked 633/633 titles - complete.");

    expect(formatLibraryUpdateProgress({
      isRunning: false,
      finishedJobs: 128,
      totalJobs: 633,
    })).toBe("Stopped after 128/633 titles.");
  });

  it("keeps final summaries specific after UI reconciliation", () => {
    expect(formatLibraryUpdateFinalSummary("Comics library", {
      isRunning: false,
      finishedJobs: 633,
      totalJobs: 633,
    })).toBe("Comics library: checked 633/633 titles.");

    expect(formatLibraryUpdateFinalSummary("Comics library", {
      isRunning: false,
      finishedJobs: 633,
      totalJobs: 633,
    }, 6)).toBe("Comics library: checked 633/633 titles, 6 with issues.");

    expect(formatLibraryUpdateFinalSummary("Library", {
      isRunning: false,
      finishedJobs: 128,
      totalJobs: 633,
    }, 1)).toBe("Library: stopped after 128/633 titles, 1 with issues.");
  });

  it("keeps waiting and preparation text stable", () => {
    expect(formatLibraryUpdateProgress({ isRunning: true, totalJobs: 0, finishedJobs: 0 }))
      .toBe("Suwayomi is checking your library.");
    expect(formatLibraryUpdateProgress({ isRunning: false, totalJobs: 0, finishedJobs: 0 }))
      .toBe("Preparing library update.");
    expect(formatLibraryUpdateWaiting()).toBe("Waiting for Suwayomi progress.");
    expect(libraryUpdateProgressNumbers({ totalJobs: 0, finishedJobs: 0 })).toBeUndefined();
  });

  it("explains stalled progress without pretending the update finished", () => {
    expect(formatLibraryUpdateStalled({
      isRunning: true,
      finishedJobs: 576,
      totalJobs: 633,
    }, 22_400)).toBe("Checking titles 576/633 - waiting on a slow source (22s).");

    showLibraryUpdateProgress("Checking titles 576/633 - 90%.", 0, { current: 576, total: 633, percent: 90 });
    expect(libraryToast()?.progress).toMatchObject({ active: true, percent: 90 });
    expect(libraryToast()?.duration).toBe(0);

    showLibraryUpdateProgress("Library update stopped.", 1800, {
      current: 576,
      total: 633,
      percent: 90,
    }, "info");

    expect(libraryToast()?.progress?.active).toBe(false);
    expect(libraryToast()?.kind).toBe("info");
    expect(libraryToast()?.duration).toBe(1800);
    expect(libraryToast()?.progress?.percent).toBe(90);
  });

  it("stops an update past its source queue through the toast's Stop", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stopSignal = beginLibraryUpdateSession();
    try {
      showLibraryUpdateProgress("Refreshing books.");
      const stop = libraryToast()?.actions?.[0];
      expect(stop?.label).toBe("Stop");

      stop?.run();
      await vi.waitFor(() => expect(libraryToast()?.body).toBe("Stop requested. Finishing the current title before stopping."));

      expect(stopSignal.aborted).toBe(true);
      expect(libraryToast()?.actions).toBeUndefined();
      expect(libraryToast()?.progress?.active).toBe(true);
      // Suwayomi has nothing to stop once the source queue is over.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      endLibraryUpdateSession(stopSignal);
    }
  });

  it("offers no Stop when no update of Epigraph's own is running", () => {
    showLibraryUpdateProgress("Suwayomi is checking your library.");
    expect(libraryToast()?.actions).toBeUndefined();
  });

  it("does not erase a valid cover when a live update patch has an empty thumbnail", () => {
    store.libraryMangaSnapshot = [{
      id: 10,
      title: "Cover Title",
      thumbnailUrl: "/api/v1/manga/10/thumbnail",
      unreadCount: 1,
      downloadCount: 0,
      chapterCount: 5,
    } as never];

    applyLibraryUpdateMangaPatches([{
      manga: {
        id: 10,
        title: "Cover Title",
        thumbnailUrl: "",
        unreadCount: 2,
        downloadCount: 0,
        chapters: { totalCount: 6 },
      },
    } as never]);

    expect(store.libraryMangaSnapshot[0]?.thumbnailUrl).toBe("/api/v1/manga/10/thumbnail");
    expect(store.libraryMangaSnapshot[0]?.unreadCount).toBe(2);
    expect(store.libraryMangaSnapshot[0]?.chapterCount).toBe(6);
  });

  it("clears stale visible progress when the backend update already completed", async () => {
    store.libraryUpdateInFlight = false;
    showProgressToast(LIBRARY_UPDATE_TOAST_ID, {
      kind: "download",
      title: "Library update",
      body: "Checking titles 576/633 - 90%.",
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          libraryUpdateStatus: {
            jobsInfo: {
              isRunning: false,
              finishedJobs: 633,
              totalJobs: 633,
              skippedCategoriesCount: 0,
              skippedMangasCount: 0,
            },
          },
        },
      }),
    })));

    await expect(clearStaleLibraryUpdateInFlight()).resolves.toBe(true);

    expect(store.libraryUpdateInFlight).toBe(false);
    expect(libraryToast()?.progress?.active).toBe(false);
    expect(libraryToast()?.body).toBe("Checked 633/633 titles - complete.");
    expect(libraryToast()?.progress?.percent).toBe(100);
  });
});
