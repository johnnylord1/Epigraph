import { describe, expect, it } from "vitest";
import { SuwayomiAdapter } from "./adapter";
import {
  CompatibilityProfileV21,
  CompatibilityProfileV23,
} from "./compatibility";
import { collectStructuralExtensionHealth } from "./health";
import { SuwayomiTransport } from "./transport";

const endpoint = process.env.AETHON_SUWAYOMI_LIVE_ENDPOINT;
const profileId = process.env.AETHON_SUWAYOMI_LIVE_PROFILE ?? "v23";

describe.runIf(Boolean(endpoint))("Suwayomi live compatibility contract", () => {
  it("executes the selected profile against a disposable runtime", async () => {
    const profile = profileId === "v21"
      ? new CompatibilityProfileV21()
      : new CompatibilityProfileV23();
    const adapter = new SuwayomiAdapter(
      new SuwayomiTransport({
        endpoint: String(endpoint),
        retries: 0,
        defaultTimeoutMs: 15_000,
      }),
      profile,
    );

    const info = await adapter.getRuntimeInfo();
    expect(info.compatible).toBe(true);
    expect(info.profileId).toBe(profile.id);
    await expect(adapter.listStores()).resolves.toBeDefined();
    await expect(adapter.listExtensions()).resolves.toBeDefined();
    await expect(adapter.listSources()).resolves.toBeDefined();
    await expect(collectStructuralExtensionHealth(adapter)).resolves.toMatchObject({
      level: 0,
      stale: false,
      runtime: { status: "healthy" },
      manager: { status: "healthy" },
    });
  }, 60_000);
});
