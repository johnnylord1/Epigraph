import { describe, expect, it } from "vitest";
import {
  NOVEL_RUNTIME_ALLOWED_ACTIONS,
  NOVEL_SOURCE_SNAPSHOT_DENYLIST,
  createDefaultNovelRuntimeCapabilityProfile,
  isNovelRuntimeActionWhitelisted,
  normalizeNovelRepositoryUrl,
  sanitizeNovelSourceSnapshotForSync,
} from "./contracts";

describe("novels contracts", () => {
  it("normalizes repository URLs without trailing slash drift", () => {
    expect(normalizeNovelRepositoryUrl(" https://example.com/plugins.min.json/// ")).toBe(
      "https://example.com/plugins.min.json",
    );
  });

  it("uses a deny-by-default runtime action whitelist", () => {
    expect(isNovelRuntimeActionWhitelisted("source.search")).toBe(true);
    expect(isNovelRuntimeActionWhitelisted("source.settings.read")).toBe(true);
    expect(isNovelRuntimeActionWhitelisted("source.settings.write")).toBe(false);
    expect(isNovelRuntimeActionWhitelisted("source.secret-read")).toBe(false);
    expect(NOVEL_RUNTIME_ALLOWED_ACTIONS).toContain("source.details");
    expect(NOVEL_RUNTIME_ALLOWED_ACTIONS).not.toContain("source.settings.write");
  });

  it("creates a minimal default capability profile for the hidden host", () => {
    expect(createDefaultNovelRuntimeCapabilityProfile()).toEqual({
      hostKind: "tauri-webview-window",
      invokeWhitelist: NOVEL_RUNTIME_ALLOWED_ACTIONS,
      supportsCancel: true,
      supportsHealth: true,
    });
  });

  it("sanitizes sync snapshots to portable metadata only", () => {
    const snapshot = sanitizeNovelSourceSnapshotForSync({
      repositories: [
        { url: "https://plugins.example.com/plugins.min.json/" },
        { url: "https://plugins.example.com/plugins.min.json" },
      ],
      installedPlugins: [
        {
          pluginId: "plugin.en.example",
          version: "1.2.3",
          repositoryUrl: "https://plugins.example.com/plugins.min.json/",
          enabled: true,
          trustState: "trusted",
        },
      ],
      availableSourceIds: ["source-1", "source-1", "source-2"],
      pluginSettings: {
        "plugin.en.example": {
          region: "us",
          token: "secret-token",
          cookies: "do-not-sync",
        },
      },
    }, {
      entries: [
        { pluginId: "plugin.en.example", key: "region" },
      ],
    });

    expect(snapshot).toEqual({
      repositories: [
        { url: "https://plugins.example.com/plugins.min.json" },
        { url: "https://plugins.example.com/plugins.min.json" },
      ],
      installedPlugins: [
        {
          pluginId: "plugin.en.example",
          version: "1.2.3",
          repositoryUrl: "https://plugins.example.com/plugins.min.json",
          enabled: true,
          trustState: "trusted",
        },
      ],
      availableSourceIds: ["source-1", "source-2"],
      whitelistedPluginSettingKeys: [
        { pluginId: "plugin.en.example", key: "region" },
      ],
    });
    expect(snapshot.whitelistedPluginSettingKeys).not.toContainEqual({
      pluginId: "plugin.en.example",
      key: "token",
    });
    expect(NOVEL_SOURCE_SNAPSHOT_DENYLIST).toContain("cookies");
  });
});
