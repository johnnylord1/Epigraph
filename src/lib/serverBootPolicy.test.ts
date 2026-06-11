import { describe, expect, it } from "vitest";
import {
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

  it("keeps the managed server asleep when snapshot boot is enough", () => {
    expect(shouldAutoStartManagedServer({
      attachOnly: false,
      isLoopback: true,
      autoStartServer: true,
      standbyEnabled: true,
      hasSnapshot: true,
      updateDue: false,
    })).toBe(false);
  });
});
