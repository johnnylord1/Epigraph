import { describe, expect, test } from "vitest";

import {
  EXTENSION_COMPATIBILITY_SCHEMA_VERSION,
  extensionCompatibilityIdentity,
  normalizeExtensionCompatibilityState,
  upsertExtensionCompatibilityRecord,
  type ExtensionCompatibilityRecord,
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
});
