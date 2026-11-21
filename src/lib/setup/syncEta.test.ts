import { beforeEach, describe, expect, it } from "vitest";
import { applyAppLanguage } from "../i18n/runtime";
import { createSyncEta, syncEtaText } from "./syncEta";

describe("sync ETA", () => {
  beforeEach(() => applyAppLanguage("en"));

  it("waits for a steady pace before guessing", () => {
    const eta = createSyncEta(120_000, 20_000);
    expect(eta.sample(0, 10_000)).toBeNull();
    expect(eta.sample(10_000, 9_000)).toBeNull();
    // 2,000 changes in 20 s leave 8,000 for 80 s.
    expect(eta.sample(20_000, 8_000)).toBe(80);
  });

  it("shows nothing while stalled, unknown or done, and starts over after it", () => {
    const eta = createSyncEta(120_000, 20_000);
    eta.sample(0, 500);
    expect(eta.sample(30_000, 500)).toBeNull();
    expect(eta.sample(33_000, null)).toBeNull();
    expect(eta.sample(36_000, 0)).toBeNull();
    expect(eta.sample(39_000, 400)).toBeNull();
  });

  it("a rise while the phone uploads does not throw the pace off", () => {
    const eta = createSyncEta(120_000, 20_000);
    eta.sample(0, 1_000);
    eta.sample(10_000, 1_200);
    // 400 sent in 30 s from the first sample: 600 left take 45 s.
    expect(eta.sample(30_000, 600)).toBe(45);
  });

  it("follows the recent pace once the window moves", () => {
    const eta = createSyncEta(120_000, 20_000);
    eta.sample(0, 10_000);
    eta.sample(60_000, 4_000);
    eta.sample(180_000, 3_400);
    // The window now starts at 60 s: 1,200 sent in 180 s, so 2,800 left take 420 s.
    expect(eta.sample(240_000, 2_800)).toBe(420);
  });

  it("reads in minutes and hours", () => {
    expect(syncEtaText(59)).toBe("Less than a minute left.");
    expect(syncEtaText(61)).toBe("About 2 min left.");
    expect(syncEtaText(5_500)).toBe("About 2 h left.");
  });
});
