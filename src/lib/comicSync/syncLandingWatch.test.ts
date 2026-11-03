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

  it("shows a long sync as it applies, at most once per interval, then lands once it stops", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0, 900));
    clock = 5_000;
    expect(landed(progress(50, 850))).toBe(true);
    clock = 10_000;
    expect(landed(progress(120, 780))).toBe(false);
    clock = 15_000;
    expect(landed(progress(200, 700))).toBe(false);
    clock = 25_000;
    expect(landed(progress(260, 640))).toBe(true);
    clock = 30_000;
    expect(landed(progress(300, 600))).toBe(false);
    // Stalled on retries: what landed so far still waits for the interval, then is shown once.
    clock = 35_000;
    expect(landed(progress(300, 600))).toBe(false);
    clock = 45_000;
    expect(landed(progress(300, 600))).toBe(true);
    expect(landed(progress(300, 600))).toBe(false);
  });

  it("limits changes that keep landing with nothing queued, and shows the last ones", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0));
    const landings: number[] = [];
    for (let tick = 1; tick <= 12; tick += 1) {
      clock = tick * 5_000;
      if (landed(progress(tick * 3))) landings.push(clock);
    }
    expect(landings).toEqual([5_000, 25_000, 45_000]);
    clock = 65_000;
    expect(landed(progress(36))).toBe(true);
    clock = 90_000;
    expect(landed(progress(36))).toBe(false);
  });

  it("shows an isolated change at once after a quiet interval", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0));
    clock = 5_000;
    expect(landed(progress(1))).toBe(true);
    clock = 300_000;
    expect(landed(progress(2))).toBe(true);
  });

  it("waits longer while only reading progress is pending, then lands the end of the sync", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000, 60_000);
    const progressOnly = (applied: number, pending: number) => ({ ...progress(applied, pending), pendingCatalogProjections: 0 });
    landed(progressOnly(0, 40_000));
    clock = 5_000;
    expect(landed(progressOnly(100, 39_900))).toBe(true);
    clock = 30_000;
    expect(landed(progressOnly(600, 39_400))).toBe(false);
    clock = 65_000;
    expect(landed(progressOnly(1_200, 38_800))).toBe(true);
    // Library works still arriving, or an older Core that does not tell: the short interval.
    clock = 85_000;
    expect(landed({ ...progress(1_300, 38_700), pendingCatalogProjections: 4 })).toBe(true);
    clock = 105_000;
    expect(landed(progress(1_400, 38_600))).toBe(true);
    // Nothing left: the last changes wait only the short interval.
    clock = 110_000;
    expect(landed(progressOnly(40_000, 0))).toBe(false);
    clock = 125_000;
    expect(landed(progressOnly(40_000, 0))).toBe(true);
  });

  it("waits as long as a slow reload asks", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0));
    clock = 5_000;
    expect(landed(progress(1), 80_000)).toBe(true);
    clock = 30_000;
    expect(landed(progress(2), 80_000)).toBe(false);
    clock = 85_000;
    expect(landed(progress(3), 80_000)).toBe(true);
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
