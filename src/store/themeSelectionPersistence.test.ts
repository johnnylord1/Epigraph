import { afterEach, describe, expect, test, vi } from "vitest";

const STORE_KEY = "epigraph-store";
const STORE_VERSION = 7;

async function loadSettings(settings: Record<string, unknown>) {
  vi.resetModules();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => key === STORE_KEY ? JSON.stringify({ storeVersion: STORE_VERSION, settings }) : null,
    setItem: vi.fn(),
  });
  const module = await import("./state.svelte");
  return module.store.settings;
}

async function loadSettingsTheme(settings: Record<string, unknown>) {
  return (await loadSettings(settings)).theme;
}

describe("theme selection persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test("preserves a saved builtin dark theme instead of migrating it to Nocturne", async () => {
    await expect(loadSettingsTheme({ theme: "dark" })).resolves.toBe("dark");
  });

  test("falls back to Nocturne for unknown themes and missing custom documents", async () => {
    await expect(loadSettingsTheme({ theme: "solarized" })).resolves.toBe("nocturne");
    await expect(loadSettingsTheme({ theme: "custom:missing", customThemes: [] })).resolves.toBe("nocturne");
  });

  test("preserves a saved valid custom theme when its document is present", async () => {
    const settings = await loadSettings({
      theme: "custom:present",
      customThemes: [{
        version: 5,
        id: "custom:present",
        name: "Present",
        base: "dark",
        primitives: { accent: "#abcdef" },
        motion: "soft",
      }],
    });

    expect(settings.theme).toBe("custom:present");
    expect(settings.customThemes).toEqual([{
      version: 5,
      id: "custom:present",
      name: "Present",
      base: "dark",
      primitives: { accent: "#abcdef" },
      motion: "soft",
    }]);
  });

  test("drops a corrupt saved custom document and falls back to Nocturne", async () => {
    const settings = await loadSettings({
      theme: "custom:corrupt",
      customThemes: [{ id: "custom:corrupt", name: "Corrupt" }],
    });

    expect(settings.theme).toBe("nocturne");
    expect(settings.customThemes).toEqual([]);
  });
});
