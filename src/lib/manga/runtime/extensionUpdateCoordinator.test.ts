import { describe, expect, test, vi } from "vitest";

import { normalizeExtensionCompatibilityState } from "./extensionCompatibility";
import {
  createNativeExtensionBatchDriver,
  ExtensionUpdateCoordinator,
  extensionUpdateCandidate,
  type ExtensionBatchDriver,
  type ExtensionNativeBatchResult,
} from "./extensionUpdateCoordinator";
import type { ExtensionRef } from "./types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function extension(overrides: Partial<ExtensionRef> = {}): ExtensionRef {
  return {
    packageName: "eu.kanade.tachiyomi.extension.en.demo",
    name: "Demo",
    language: "en",
    versionName: "1.4.2",
    versionCode: "2",
    isInstalled: true,
    isObsolete: false,
    hasUpdate: true,
    iconUrl: null,
    storeId: "https://store.example/index.json",
    apkName: "demo.apk",
    apkUrl: "https://store.example/apk/demo-v1.4.2.apk",
    jarUrl: null,
    ...overrides,
  };
}

function result(overrides: Partial<ExtensionNativeBatchResult> = {}): ExtensionNativeBatchResult {
  return {
    batchId: "batch-1",
    runtimeVersion: "v2.3.2243",
    runtimeArtifactSha256: "b".repeat(64),
    approved: [{
      packageName: extension().packageName,
      versionCode: "2",
      versionName: "1.4.2",
      artifactSha256: "c".repeat(64),
      storeId: "https://store.example/index.json",
      storeUrlCanonical: "https://store.example/index.json",
      sourceIds: ["1"],
      status: "HEALTHY",
      failureOwner: "unknown",
      failureCode: null,
      identityConfirmed: true,
    }],
    rejected: [],
    restartedRuntime: true,
    ...overrides,
  };
}

function coordinator(driver: ExtensionBatchDriver) {
  return new ExtensionUpdateCoordinator({
    profileId: "main",
    state: normalizeExtensionCompatibilityState(null, "main"),
    driver,
    now: () => 100,
  });
}

describe("ExtensionUpdateCoordinator", () => {
  test("passes only typed metadata and auth to the native transactional command", async () => {
    invokeMock.mockResolvedValueOnce(result());
    const candidate = extensionUpdateCandidate(extension())!;
    await createNativeExtensionBatchDriver({
      serverUrl: "http://127.0.0.1:4567",
      binary: "managed",
      profileId: "main",
      profileLabel: "Main",
      authorization: "Basic redacted",
    }).runBatch([candidate]);

    expect(invokeMock).toHaveBeenCalledWith("certify_suwayomi_extension_update_batch", {
      serverUrl: "http://127.0.0.1:4567",
      binary: "managed",
      profileId: "main",
      profileLabel: "Main",
      authorization: "Basic redacted",
      items: [candidate],
    });
  });

  test("accepts only installed, current updates with HTTPS store provenance", () => {
    expect(extensionUpdateCandidate(extension())).not.toBeNull();
    expect(extensionUpdateCandidate(extension({ isObsolete: true }))).toBeNull();
    expect(extensionUpdateCandidate(extension({ isInstalled: false }))).toBeNull();
    expect(extensionUpdateCandidate(extension({ apkUrl: null }))).toBeNull();
    expect(extensionUpdateCandidate(extension({ storeId: null }))).toBeNull();
    expect(extensionUpdateCandidate(extension({ apkUrl: "http://store.example/demo.apk" }))).toBeNull();
  });

  test("submits one batch and records approved and rejected evidence independently", async () => {
    const rejected = {
      ...result().approved[0]!,
      packageName: "eu.kanade.tachiyomi.extension.en.rejected",
      artifactSha256: "d".repeat(64),
      sourceIds: [],
      status: "INCOMPATIBLE" as const,
      failureOwner: "extension" as const,
      failureCode: "STRUCTURAL_CERTIFICATION_FAILED",
    };
    const runBatch = vi.fn<ExtensionBatchDriver["runBatch"]>(
      async (_candidates) => result({ rejected: [rejected] }),
    );
    const service = coordinator({ runBatch });
    const batch = await service.run([
      extension(),
      extension({ packageName: rejected.packageName }),
    ]);

    expect(runBatch).toHaveBeenCalledOnce();
    expect(runBatch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(batch.state.records.map((record) => record.status).sort()).toEqual(["HEALTHY", "INCOMPATIBLE"]);
    expect(batch.state.reports.map((report) => report.aggregateStatus).sort()).toEqual(["FAIL", "PASS"]);
    expect(batch.state.reports.every((report) => report.trigger === "AUTOMATIC_STRUCTURAL")).toBe(true);
    expect(service.getPhase()).toBe("COMPLETED");
  });

  test("records no compatibility for an artifact that could not be downloaded or never declared its version", async () => {
    const unavailable = {
      ...result().approved[0]!,
      artifactSha256: "",
      sourceIds: [],
      status: "INCOMPATIBLE" as const,
      failureCode: "ARTIFACT_UNAVAILABLE",
      identityConfirmed: false,
    };
    // Its version is still the installed one, so recording it would mark that version incompatible.
    const undeclared = {
      ...result().approved[0]!,
      packageName: "eu.kanade.tachiyomi.extension.en.undeclared",
      artifactSha256: "d".repeat(64),
      sourceIds: [],
      status: "INCOMPATIBLE" as const,
      failureCode: "STRUCTURAL_CERTIFICATION_FAILED",
      identityConfirmed: false,
    };
    const service = coordinator({
      runBatch: vi.fn(async () => result({ approved: [], rejected: [unavailable, undeclared], restartedRuntime: false })),
    });
    const batch = await service.run([extension(), extension({ packageName: undeclared.packageName })]);

    expect(batch.rejected).toEqual([unavailable, undeclared]);
    expect(batch.state.records).toEqual([]);
    expect(batch.state.reports).toEqual([]);
    expect(service.getPhase()).toBe("COMPLETED");
  });

  test("surfaces native rollback failure without activating anything in the frontend", async () => {
    const service = coordinator({ runBatch: vi.fn(async () => { throw new Error("batch rolled back"); }) });
    await expect(service.run([extension()])).rejects.toThrow("batch rolled back");
    expect(service.getPhase()).toBe("FAILED");
  });
});
