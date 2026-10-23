import { describe, expect, it, vi } from "vitest";

vi.mock("../syncdDesktop", () => ({ syncdGetSyncProgressIfRunning: vi.fn() }));

import { createSyncLandingDetector } from "./syncLandingWatch";

const progress = (appliedProjections: number, pendingProjections = 0, pendingDetails = 0) => ({
  appliedProjections,
  pendingProjections,
  pendingTrackerLogins: 0,
  pendingDetails,
});

describe("createSyncLandingDetector", () => {
  it("takes the first reading as the baseline", () => {
    const landed = createSyncLandingDetector();
    expect(landed(progress(40))).toBe(false);
    expect(landed(progress(40))).toBe(false);
  });

  it("lands once when applied changes leave nothing pending", () => {
    const landed = createSyncLandingDetector();
    landed(progress(0));
    expect(landed(progress(3))).toBe(true);
    expect(landed(progress(3))).toBe(false);
  });

  it("waits while Core is still applying, then lands once it stops", () => {
    const landed = createSyncLandingDetector();
    landed(progress(0, 900));
    expect(landed(progress(50, 850))).toBe(false);
    expect(landed(progress(120, 780))).toBe(false);
    // Stalled on retries: what landed so far is shown instead of waiting for the rest.
    expect(landed(progress(120, 780))).toBe(true);
    expect(landed(progress(120, 780))).toBe(false);
  });

  it("lands when the last work's details finish loading", () => {
    const landed = createSyncLandingDetector();
    landed(progress(5, 0, 12));
    expect(landed(progress(5, 0, 4))).toBe(false);
    expect(landed(progress(5, 0, 0))).toBe(true);
  });

  it("treats a restarted Core as new changes and ignores missing readings", () => {
    const landed = createSyncLandingDetector();
    landed(progress(70));
    expect(landed(null)).toBe(false);
    expect(landed(progress(0))).toBe(true);
  });
});
