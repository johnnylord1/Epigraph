import { existsSync, readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import { applyAppLanguage } from "../../lib/i18n/runtime";
import type { ObservedCompatibilityReport } from "../../lib/manga/runtime";
import ExtensionSettingsPanel from "./ExtensionSettingsPanel.svelte";

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

describe("observed compatibility stages", () => {
  afterEach(() => {
    cleanup();
    applyAppLanguage("en");
  });

  test("shows stage names and results in the app language", () => {
    const stage = (id: string, label: string, status: ObservedCompatibilityReport["stages"][number]["status"]) =>
      ({ id, label, kind: "DETERMINISTIC" as const, status, durationMs: null, failureCode: null });
    const report: ObservedCompatibilityReport = {
      schemaVersion: 1,
      reportId: "report-1",
      profileId: "profile-1",
      packageName: "eu.kanade.tachiyomi.extension.en.example",
      versionCode: "1",
      artifactSha256: null,
      runtimeVersion: "v2.0",
      runtimeArtifactSha256: null,
      adapterProfile: "suwayomi",
      endpointIdentity: "local",
      runtimeScope: "LOCAL_OWNED",
      trigger: "EXPLICIT_LIVE",
      sourceId: "1",
      startedAt: 1,
      completedAt: 2,
      aggregateStatus: "DEGRADED",
      stages: [
        stage("runtime-readiness", "Runtime readiness", "PASS"),
        stage("live-search", "Live search", "INCONCLUSIVE"),
        stage("http-parser-internals", "HTTP and parser internals", "NOT_OBSERVED"),
        stage("future-stage", "Future stage", "TIMED_OUT"),
      ],
    };
    applyAppLanguage("pt-BR");
    render(ExtensionSettingsPanel, {
      extension: {
        apkName: "example.apk", pkgName: report.packageName, name: "Example", lang: "en", versionName: "1.0",
        isInstalled: true, isObsolete: false, hasUpdate: false, iconUrl: null, kind: "manga",
      },
      compatibilityReport: report,
      onClose: () => {},
      onInstall: () => {},
      onRemove: () => {},
      onSelectPreferenceSource: () => {},
      onUpdatePreference: () => {},
    });

    const stages = [...document.querySelectorAll(".compatibilityStages > div")].map((row) => row.textContent?.replace(/\s+/g, " ").trim());
    expect(stages).toEqual([
      "Runtime pronto Aprovado",
      "Busca ao vivo Inconclusivo",
      "HTTP e parser internos Não observado",
      "Future stage Tempo esgotado",
    ]);
    expect(screen.queryByText("PASS")).toBeNull();
  });
});
