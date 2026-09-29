import { describe, expect, it } from "vitest";
import * as canonical from "./storageRuntime";
import * as facade from "../../components/settings/settingsStorageRuntime";

describe("canonical backup storage runtime", () => {
  it("preserves the Settings loader identity and extension through the compatibility facade", () => {
    expect(facade.SETTINGS_EPIGRAPH_BACKUP_EXTENSION).toBe(canonical.SETTINGS_EPIGRAPH_BACKUP_EXTENSION);
    expect(facade.loadSettingsStorageRuntime).toBe(canonical.loadSettingsStorageRuntime);
  });
  it("shares the lazy cached promise and runtime across both import paths", async () => {
    const pending = canonical.loadSettingsStorageRuntime();
    expect(facade.loadSettingsStorageRuntime()).toBe(pending);
    expect(canonical.loadSettingsStorageRuntime()).toBe(pending);
    const runtime = await pending;
    expect(await facade.loadSettingsStorageRuntime()).toBe(runtime);
    expect(runtime.parseMihonBackup).toBeTypeOf("function");
    expect(runtime.buildEpigraphRestorePlan).toBeTypeOf("function");
    expect(runtime.restoreEpigraphBooksPayload).toBeTypeOf("function");
  // This loads the real lazy dependency graph; cold Svelte transforms can exceed 5s.
  }, 30_000);
});
