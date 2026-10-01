import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_RUN_STORAGE_KEY, shouldStartFirstRun } from "../lib/firstRun";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("first-run state before the startup splash", () => {
  // Imports the whole store twice from an empty module cache, which alone can take seconds on a busy machine.
  it("keeps setup pending if startup is interrupted before Layout mounts", { timeout: 20_000 }, async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.resetModules();
    const initial = await import("./state.svelte");
    expect(initial.hadPersistedStoreAtStartup).toBe(false);
    expect(initial.store.settings.theme).toBe("light");
    // Normal store persistence can happen during the splash, before first-run UI mounts.
    values.set("epigraph-store", JSON.stringify({ storeVersion: 7, settings: {} }));
    vi.resetModules();
    const restarted = await import("./state.svelte");
    expect(restarted.hadPersistedStoreAtStartup).toBe(true);
    expect(shouldStartFirstRun(values.get(FIRST_RUN_STORAGE_KEY) ?? null, restarted.hadPersistedStoreAtStartup)).toBe(true);
    expect(restarted.store.settings.theme).toBe("light");
  });

  it("does not enroll an existing installation into first run", { timeout: 20_000 }, async () => {
    const values = new Map([["epigraph-store", JSON.stringify({ storeVersion: 7, settings: { theme: "dark" } })]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    vi.resetModules();
    const existing = await import("./state.svelte");
    expect(existing.hadPersistedStoreAtStartup).toBe(true);
    expect(values.has(FIRST_RUN_STORAGE_KEY)).toBe(false);
    expect(shouldStartFirstRun(null, existing.hadPersistedStoreAtStartup)).toBe(false);
  });
});
