import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sourcesView = readFileSync("src/components/pages/SourcesView.svelte", "utf8");
const settingsPanel = readFileSync("src/components/pages/ExtensionSettingsPanel.svelte", "utf8");

describe("official source preferences surface", () => {
  test("loads manga preferences through SourceRuntime and keeps LNReader read-only", () => {
    expect(sourcesView).toContain("runtime.getSourcePreferences");
    expect(sourcesView).toContain("runtime.updateSourcePreference");
    expect(sourcesView).toContain('status: "pending"');
    expect(sourcesView).not.toContain("Promise.allSettled");
    expect(sourcesView).toContain("readInstalledNovelSourceRuntimeSummary");
    expect(sourcesView).not.toContain("source.settings.write");
  });

  test("does not retain the fake session settings or credential controls", () => {
    expect(existsSync("src/store/mockSettingsStore.ts")).toBe(false);
    expect(sourcesView).not.toContain("mockSettingsStore");
    expect(settingsPanel).not.toContain("MockExtensionSettings");
    expect(settingsPanel).not.toContain("ui_mockLocalState");
    expect(settingsPanel).not.toContain("ui_optionalToken");
  });

  test("binds updates to the expected preference identity and preserves future types", () => {
    expect(settingsPanel).toContain("expectedKey: preference.key");
    expect(settingsPanel).toContain("expectedType: preference.type");
    expect(settingsPanel).toContain('preference.type === "UnsupportedPreference"');
    expect(settingsPanel).toContain('preferenceAccess === "read-write"');
  });
});
