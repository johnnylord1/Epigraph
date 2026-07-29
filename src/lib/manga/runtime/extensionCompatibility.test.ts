import { describe, expect, test } from "vitest";

import {
  EXTENSION_COMPATIBILITY_SCHEMA_VERSION,
  MAX_OBSERVED_COMPATIBILITY_REPORTS,
  aggregateObservedCompatibilityStages,
  extensionCompatibilityIdentity,
  latestObservedCompatibilityReport,
  normalizeExtensionCompatibilityState,
  upsertObservedCompatibilityReport,
  upsertExtensionCompatibilityRecord,
  type ExtensionCompatibilityRecord,
  type ObservedCompatibilityReport,
  type ObservedCompatibilityStage,
} from "./extensionCompatibility";

function record(overrides: Partial<ExtensionCompatibilityRecord> = {}): ExtensionCompatibilityRecord {
  return {
    schemaVersion: 1,
    profileId: "main",
    packageName: "eu.kanade.tachiyomi.extension.en.demo",
    versionCode: "12",
    versionName: "1.4.12",
    artifactSha256: "a".repeat(64),
    storeId: "keiyoushi",
    storeUrlCanonical: "https://store.example/index.json/",
    runtimeVersion: "v2.3.2243",
    runtimeArtifactSha256: "b".repeat(64),
    sourceIds: ["2", "1", "2"],
    testedSourceIds: ["1"],
    certificationScope: "SMOKE",
    status: "HEALTHY",
    failureOwner: "unknown",
    failureCode: null,
    checkedAt: 10,
    lastHealthyAt: 10,
    ...overrides,
  };
}

function report(overrides: Partial<ObservedCompatibilityReport> = {}): ObservedCompatibilityReport {
  const stages: ObservedCompatibilityStage[] = [{
    id: "extension-load",
    label: "Extension load",
    kind: "DETERMINISTIC",
    status: "PASS",
    durationMs: 12,
    failureCode: null,
  }];
  return {
    schemaVersion: 1,
    reportId: "batch:demo:12",
    profileId: "main",
    packageName: "eu.kanade.tachiyomi.extension.en.demo",
    versionCode: "12",
    artifactSha256: "a".repeat(64),
    runtimeVersion: "v2.3.2243",
    runtimeArtifactSha256: "b".repeat(64),
    adapterProfile: "suwayomi-v23",
    endpointIdentity: "http://127.0.0.1:4567/api/graphql",
    runtimeScope: "LOCAL_OWNED",
    trigger: "AUTOMATIC_STRUCTURAL",
    sourceId: null,
    startedAt: 10,
    completedAt: 22,
    aggregateStatus: "PASS",
    stages,
    ...overrides,
  };
}

describe("extension compatibility registry", () => {
  test("normalizes schema and canonical evidence without collapsing distinct artifacts", () => {
    const state = normalizeExtensionCompatibilityState({
      schemaVersion: 0,
      records: [record(), record({ artifactSha256: "c".repeat(64) })],
    }, "main");

    expect(state.schemaVersion).toBe(EXTENSION_COMPATIBILITY_SCHEMA_VERSION);
    expect(state.records).toHaveLength(2);
    expect(state.records[0]?.sourceIds).toEqual(["1", "2"]);
    expect(state.records[0]?.storeUrlCanonical).toBe("https://store.example/index.json");
  });

  test("uses profile, store, runtime and both artifact hashes in logical identity", () => {
    const baseline = record();
    expect(extensionCompatibilityIdentity(baseline)).not.toBe(
      extensionCompatibilityIdentity(record({ storeId: "manual" })),
    );
    expect(extensionCompatibilityIdentity(baseline)).not.toBe(
      extensionCompatibilityIdentity(record({ runtimeArtifactSha256: "d".repeat(64) })),
    );
  });

  test("atomically replaces only an identical evidence record", () => {
    const state = normalizeExtensionCompatibilityState({ records: [record()] }, "main");
    const next = upsertExtensionCompatibilityRecord(state, record({ checkedAt: 20 }));
    expect(next.records).toHaveLength(1);
    expect(next.records[0]?.checkedAt).toBe(20);
  });

  test("drops incomplete or untrusted hash records during migration", () => {
    const state = normalizeExtensionCompatibilityState({
      records: [record(), record({ artifactSha256: "not-a-hash" })],
    }, "main");
    expect(state.records).toHaveLength(1);
  });

  test("migrates V1 state without inventing observed reports", () => {
    const state = normalizeExtensionCompatibilityState({
      schemaVersion: 1,
      records: [record()],
    }, "main");
    expect(state.schemaVersion).toBe(EXTENSION_COMPATIBILITY_SCHEMA_VERSION);
    expect(state.reports).toEqual([]);
  });

  test("does not infer local ownership from incomplete persisted evidence", () => {
    const state = normalizeExtensionCompatibilityState({
      reports: [{
        ...report(),
        runtimeScope: undefined,
      }],
    }, "main");
    expect(state.reports[0]?.runtimeScope).toBe("REMOTE_SHARED");
  });

  test("distinguishes deterministic failures from observational degradation", () => {
    const deterministic: ObservedCompatibilityStage[] = [{
      ...report().stages[0]!,
      status: "FAIL",
    }];
    const observational: ObservedCompatibilityStage[] = [{
      ...report().stages[0]!,
      kind: "OBSERVATIONAL",
      status: "TIMED_OUT",
    }, {
      ...report().stages[0]!,
      id: "registration",
      status: "PASS",
    }];
    expect(aggregateObservedCompatibilityStages(deterministic)).toBe("FAIL");
    expect(aggregateObservedCompatibilityStages(observational)).toBe("DEGRADED");
  });

  test("upserts reports atomically and returns the latest package evidence", () => {
    const state = normalizeExtensionCompatibilityState(null, "main");
    const first = upsertObservedCompatibilityReport(state, report());
    const next = upsertObservedCompatibilityReport(first, report({
      reportId: "batch:demo:13",
      versionCode: "13",
      completedAt: 30,
    }));
    expect(next.reports).toHaveLength(2);
    expect(latestObservedCompatibilityReport(next, report().packageName)?.versionCode).toBe("13");
  });

  test("bounds report retention and redacts diagnostic stage fields", () => {
    const reports = Array.from({ length: MAX_OBSERVED_COMPATIBILITY_REPORTS + 5 }, (_, index) => report({
      reportId: `report:${index}`,
      completedAt: index,
      stages: [{
        ...report().stages[0]!,
        label: "Authorization: Bearer secret-value",
        failureCode: "token=private-value",
      }],
    }));
    const state = normalizeExtensionCompatibilityState({ reports }, "main");
    expect(state.reports).toHaveLength(MAX_OBSERVED_COMPATIBILITY_REPORTS);
    expect(state.reports[0]?.stages[0]?.label).not.toContain("secret-value");
    expect(state.reports[0]?.stages[0]?.failureCode).not.toContain("private-value");
  });
});
