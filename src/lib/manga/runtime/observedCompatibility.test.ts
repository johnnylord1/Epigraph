import { describe, expect, test, vi } from "vitest";

import { runExplicitCompatibilityProbe } from "./observedCompatibility";
import type { SourceRuntime } from "./types";

function runtime(): SourceRuntime {
  return {
    getRuntimeInfo: vi.fn(async () => ({
      name: "Suwayomi",
      version: "v2.3.2243",
      revision: null,
      buildType: null,
      buildTime: null,
      profileId: "suwayomi-v23" as const,
      schemaHash: "schema",
      compatible: true,
    })),
    getRuntimeFingerprint: vi.fn(async () => ({
      serverVersion: "v2.3.2243",
      canonicalSchemaHash: "schema",
      capabilitiesHash: "capabilities",
      endpointIdentity: "http://127.0.0.1:4567/api/graphql",
      instanceNonce: null,
      localRuntimeGeneration: "2",
    })),
    getCapabilities: vi.fn(),
    listStores: vi.fn(),
    addStore: vi.fn(),
    removeStore: vi.fn(),
    listExtensions: vi.fn(),
    refreshExtensions: vi.fn(),
    getSourcePreferences: vi.fn(async () => []),
    updateSourcePreference: vi.fn(async () => []),
    listSources: vi.fn(async () => [{
      id: "7",
      name: "Fixture",
      displayName: "Fixture",
      language: "en",
      iconUrl: null,
      isNsfw: false,
      supportsLatest: true,
      isConfigurable: false,
      extensionPackageName: "fixture.extension",
    }]),
    installExtension: vi.fn(),
    updateExtension: vi.fn(),
    uninstallExtension: vi.fn(),
    search: vi.fn(async () => ({ items: [], hasNextPage: false })),
    getDetails: vi.fn(),
    getChapters: vi.fn(),
    getPages: vi.fn(),
  };
}

describe("observed compatibility probe", () => {
  test("records an explicit live execution without claiming parser internals", async () => {
    const report = await runExplicitCompatibilityProbe(runtime(), {
      profileId: "main",
      packageName: "fixture.extension",
      versionCode: "10",
      runtimeScope: "LOCAL_OWNED",
      reportId: "report-1",
      now: (() => {
        let current = 10;
        return () => current++;
      })(),
    });
    expect(report.trigger).toBe("EXPLICIT_LIVE");
    expect(report.sourceId).toBe("7");
    expect(report.stages.find((stage) => stage.id === "live-search")?.status).toBe("PASS");
    expect(report.stages.find((stage) => stage.id === "http-parser-internals")?.status)
      .toBe("NOT_OBSERVED");
    expect(report.aggregateStatus).toBe("DEGRADED");
  });

  test("fails structural registration and skips live traffic when no source is registered", async () => {
    const fixture = runtime();
    vi.mocked(fixture.listSources).mockResolvedValueOnce([]);
    const report = await runExplicitCompatibilityProbe(fixture, {
      profileId: "main",
      packageName: "missing.extension",
      versionCode: "1",
      runtimeScope: "REMOTE_SHARED",
      reportId: "report-2",
    });
    expect(report.aggregateStatus).toBe("FAIL");
    expect(fixture.search).not.toHaveBeenCalled();
    expect(report.runtimeScope).toBe("REMOTE_SHARED");
  });
});
