import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  coerceNovelPluginSettingValue,
  currentNovelPluginSettingValue,
  loadNovelPluginSettingValues,
  parseNovelPluginSettings,
  resetNovelPluginSettingsCacheForTests,
  saveNovelPluginSettingValue,
} from "./pluginSettings";

// Declarations copied from installed LNReader plugins (BoxNovel 2.2.2, WTR-LAB 1.2.3, Komga 1.0.2).
const boxNovel = parseNovelPluginSettings({
  hideLocked: { value: "", label: "Hide locked chapters", type: "Switch" },
});
const wtrLab = parseNovelPluginSettings({
  preferredMode: {
    value: "ai",
    label: "Preferred translation",
    type: "Select",
    options: [
      { label: "AI", value: "ai" },
      { label: "Web+", value: "webplus" },
      { label: "Web", value: "web" },
      { label: "Custom — set the id below", value: "custom" },
    ],
  },
  customMode: { value: "", label: "Custom translation id", type: "Text" },
  fallbackToWeb: { value: true, label: "Fall back to Web when the preferred translation is unavailable", type: "Switch" },
});
const komga = parseNovelPluginSettings({
  email: { value: "", label: "Email", type: "Text" },
  password: { value: "", label: "Password" },
  url: { value: "", label: "URL" },
});
const [hideLocked] = boxNovel;
const [preferredMode, customMode, fallbackToWeb] = wtrLab;
const scope = { profileId: "Main", serverUrl: "http://127.0.0.1:4567/" };

describe("novel plugin settings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetNovelPluginSettingsCacheForTests();
  });

  it("reads the declared settings and treats a missing type as text", () => {
    expect(komga.map((setting) => [setting.key, setting.type])).toEqual([
      ["email", "Text"],
      ["password", "Text"],
      ["url", "Text"],
    ]);
    expect(preferredMode.options.map((option) => option.value)).toEqual(["ai", "webplus", "web", "custom"]);
    expect(parseNovelPluginSettings(undefined)).toEqual([]);
  });

  it("accepts only values the plugin declares", () => {
    expect(coerceNovelPluginSettingValue(hideLocked, true)).toBe(true);
    expect(coerceNovelPluginSettingValue(hideLocked, "true")).toBeUndefined();
    expect(coerceNovelPluginSettingValue(preferredMode, "web")).toBe("web");
    expect(coerceNovelPluginSettingValue(preferredMode, "fast")).toBeUndefined();
    expect(coerceNovelPluginSettingValue(customMode, "x".repeat(4097))).toBeUndefined();
  });

  it("shows the stored value while it still fits, otherwise the default", () => {
    expect(currentNovelPluginSettingValue(preferredMode, { preferredMode: "web" })).toBe("web");
    expect(currentNovelPluginSettingValue(preferredMode, { preferredMode: "gone" })).toBe("ai");
    // BoxNovel declares its switch with an empty string as default: off.
    expect(currentNovelPluginSettingValue(hideLocked, {})).toBe(false);
    expect(currentNovelPluginSettingValue(fallbackToWeb, {})).toBe(true);
    expect(currentNovelPluginSettingValue(customMode, {})).toBe("");
  });

  it("falls back to no values when the file is missing, empty or unreadable", async () => {
    invokeMock.mockResolvedValueOnce(null);
    expect(await loadNovelPluginSettingValues(scope, "p")).toEqual({});
    invokeMock.mockResolvedValueOnce("{not json");
    expect(await loadNovelPluginSettingValues(scope, "p")).toEqual({});
    invokeMock.mockRejectedValueOnce(new Error("disk"));
    expect(await loadNovelPluginSettingValues(scope, "p")).toEqual({});
  });

  it("saves per plugin and profile, keeping other plugins, one write at a time", async () => {
    let file: string | null = JSON.stringify({ version: 1, plugins: { other: { a: 1 } } });
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "read_novel_plugin_settings") return file;
      if (command === "write_novel_plugin_settings") {
        file = args.contents as string;
        return null;
      }
      throw new Error(command);
    });

    await Promise.all([
      saveNovelPluginSettingValue(scope, "wtrlab", preferredMode, "web"),
      saveNovelPluginSettingValue(scope, "wtrlab", fallbackToWeb, false),
    ]);

    expect(JSON.parse(file!)).toEqual({
      version: 1,
      plugins: { other: { a: 1 }, wtrlab: { preferredMode: "web", fallbackToWeb: false } },
    });
    const write = invokeMock.mock.calls.find(([command]) => command === "write_novel_plugin_settings")!;
    expect(write[1]).toMatchObject({ profileId: "main", serverUrl: "http://127.0.0.1:4567" });
    expect(await loadNovelPluginSettingValues(scope, "wtrlab")).toEqual({ preferredMode: "web", fallbackToWeb: false });
  });

  it("reads the file again, so a value sync wrote is shown and kept by the next save", async () => {
    let file: string | null = JSON.stringify({ version: 1, plugins: { wtrlab: { preferredMode: "ai" } } });
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "read_novel_plugin_settings") return file;
      if (command === "write_novel_plugin_settings") {
        file = args.contents as string;
        return null;
      }
      throw new Error(command);
    });

    expect(await loadNovelPluginSettingValues(scope, "wtrlab")).toEqual({ preferredMode: "ai" });
    // Another device chose Web; sync rewrote the file behind the app's back.
    file = JSON.stringify({ version: 1, plugins: { wtrlab: { preferredMode: "web" } } });
    expect(await loadNovelPluginSettingValues(scope, "wtrlab")).toEqual({ preferredMode: "web" });

    await saveNovelPluginSettingValue(scope, "wtrlab", fallbackToWeb, false);
    expect(JSON.parse(file!).plugins.wtrlab).toEqual({ preferredMode: "web", fallbackToWeb: false });
  });

  it("refuses a value the plugin does not offer without writing", async () => {
    await expect(saveNovelPluginSettingValue(scope, "wtrlab", preferredMode, "fast")).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
