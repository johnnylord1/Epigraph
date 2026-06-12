import { describe, expect, it } from "vitest";
import {
  formatLibraryUpdateProgress,
  formatLibraryUpdateWaiting,
  libraryUpdateProgressNumbers,
} from "./updateRuntime";

describe("library update runtime helpers", () => {
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
  });

  it("keeps waiting and preparation text stable", () => {
    expect(formatLibraryUpdateProgress({ isRunning: true, totalJobs: 0, finishedJobs: 0 }))
      .toBe("Suwayomi is checking your library.");
    expect(formatLibraryUpdateProgress({ isRunning: false, totalJobs: 0, finishedJobs: 0 }))
      .toBe("Preparing library update.");
    expect(formatLibraryUpdateWaiting()).toBe("Waiting for Suwayomi progress.");
    expect(libraryUpdateProgressNumbers({ totalJobs: 0, finishedJobs: 0 })).toBeUndefined();
  });
});
