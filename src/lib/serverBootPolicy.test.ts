import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_BOOT_FALLBACK_MS,
  shouldAutoStartManagedServer,
  shouldBootFromLibrarySnapshot,
} from "./serverBootPolicy";

describe("server boot policy", () => {
  it("boots from snapshot only when standby can fully satisfy startup", () => {
    expect(shouldBootFromLibrarySnapshot({
      standbyEnabled: true,
      hasSnapshot: true,
      attachOnly: false,
      updateDue: false,
    })).toBe(true);

    expect(shouldBootFromLibrarySnapshot({
      standbyEnabled: true,
      hasSnapshot: true,
      attachOnly: false,
      updateDue: true,
    })).toBe(false);
  });

  it("opens the saved library once a start has waited too long for the server", () => {
    const waiting = { standbyEnabled: false, hasSnapshot: true, attachOnly: false, updateDue: true };
    expect(shouldBootFromLibrarySnapshot({ ...waiting, waitedMs: SNAPSHOT_BOOT_FALLBACK_MS - 1 })).toBe(false);
    expect(shouldBootFromLibrarySnapshot({ ...waiting, waitedMs: SNAPSHOT_BOOT_FALLBACK_MS })).toBe(true);
    expect(shouldBootFromLibrarySnapshot({ ...waiting, hasSnapshot: false, waitedMs: SNAPSHOT_BOOT_FALLBACK_MS })).toBe(false);
    expect(shouldBootFromLibrarySnapshot({ ...waiting, attachOnly: true, waitedMs: SNAPSHOT_BOOT_FALLBACK_MS })).toBe(false);
  });

  it("auto-starts the managed server when an update is due even if a snapshot exists", () => {
    expect(shouldAutoStartManagedServer({
      attachOnly: false,
      isLoopback: true,
      autoStartServer: true,
      standbyEnabled: true,
      hasSnapshot: true,
      updateDue: true,
    })).toBe(true);
  });

  it("auto-starts the managed server when the user enabled auto-start, even if snapshot boot is enough", () => {
    expect(shouldAutoStartManagedServer({
      attachOnly: false,
      isLoopback: true,
      autoStartServer: true,
      standbyEnabled: true,
      hasSnapshot: true,
      updateDue: false,
    })).toBe(true);
  });

  it("keeps the managed server asleep only when auto-start is disabled", () => {
    expect(shouldAutoStartManagedServer({
      attachOnly: false,
      isLoopback: true,
      autoStartServer: false,
      standbyEnabled: true,
      hasSnapshot: true,
      updateDue: false,
    })).toBe(false);
  });
});
