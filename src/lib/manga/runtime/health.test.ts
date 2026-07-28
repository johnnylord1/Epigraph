import { describe, expect, test, vi } from "vitest";

import { SourceRuntimeError } from "./errors";
import {
  SourceHealthProbeCache,
  classifyExtensionFailure,
  collectStructuralExtensionHealth,
  probeSourceReachability,
} from "./health";
import type { ExtensionRef, ExtensionStore, SourceRef, SourceRuntime } from "./types";

const store: ExtensionStore = {
  id: "https://example.test/store.json",
  name: "Example",
  indexUrl: "https://example.test/store.json",
  badgeLabel: null,
  signingFingerprint: null,
  contactWebsite: null,
  contactDiscord: null,
  extensionListUrl: null,
  isLegacy: false,
};

function extension(overrides: Partial<ExtensionRef> = {}): ExtensionRef {
  return {
    packageName: "eu.kanade.tachiyomi.extension.en.demo",
    name: "Demo",
    language: "en",
    versionName: "1.0.0",
    versionCode: "1",
    isInstalled: true,
    isObsolete: false,
    hasUpdate: false,
    iconUrl: null,
    storeId: store.id,
    apkName: "demo.apk",
    apkUrl: null,
    jarUrl: null,
    ...overrides,
  };
}

function source(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    id: "10",
    name: "Demo",
    displayName: "Demo",
    language: "en",
    iconUrl: null,
    isNsfw: false,
    supportsLatest: true,
    isConfigurable: false,
    extensionPackageName: extension().packageName,
    ...overrides,
  };
}

function runtimeFixture(
  extensions: readonly ExtensionRef[] = [extension()],
  sources: readonly SourceRef[] = [source()],
): SourceRuntime {
  return {
    getRuntimeInfo: vi.fn(async () => ({
      name: "Suwayomi",
      version: "v2.3.2243",
      revision: null,
      buildType: "Stable",
      buildTime: null,
      profileId: "suwayomi-v23",
      schemaHash: "a".repeat(64),
      compatible: true,
    })),
    listStores: vi.fn(async () => [store]),
    listExtensions: vi.fn(async () => extensions),
    listSources: vi.fn(async () => sources),
  } as unknown as SourceRuntime;
}

describe("extension structural health", () => {
  test("correlates stores, installed artifacts, loaded extensions, and registered sources without website access", async () => {
    const runtime = runtimeFixture();
    const snapshot = await collectStructuralExtensionHealth(runtime, { now: () => 100 });

    expect(snapshot).toMatchObject({ level: 0, observedAt: 100, stale: false });
    expect(snapshot.extensions[0]).toMatchObject({
      packageName: extension().packageName,
      overall: "healthy",
      sourceIds: ["10"],
    });
    expect(snapshot.extensions[0]?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "store", status: "healthy" }),
      expect.objectContaining({ dimension: "load", status: "healthy" }),
      expect.objectContaining({ dimension: "reachability", status: "unknown" }),
    ]));
    expect(runtime.search).toBeUndefined();
  });

  test("distinguishes an unloaded content extension from a helper extension", async () => {
    const content = extension();
    const helper = extension({
      packageName: "eu.kanade.tachiyomi.extension.all.tachidesk",
      name: "Suwayomi bridge",
    });
    const snapshot = await collectStructuralExtensionHealth(runtimeFixture([content, helper], []));

    expect(snapshot.extensions.find((item) => item.packageName === content.packageName)).toMatchObject({
      overall: "unhealthy",
      checks: expect.arrayContaining([
        expect.objectContaining({ dimension: "load", code: "EXTENSION_NOT_LOADED" }),
      ]),
    });
    expect(snapshot.extensions.find((item) => item.packageName === helper.packageName)?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "load", status: "not_applicable" }),
      ]),
    );
  });

  test("preserves the last valid inventory during a transient runtime failure", async () => {
    const previous = await collectStructuralExtensionHealth(runtimeFixture(), { now: () => 100 });
    const offline = runtimeFixture();
    vi.mocked(offline.getRuntimeInfo).mockRejectedValue(new Error("ECONNREFUSED"));

    const snapshot = await collectStructuralExtensionHealth(offline, {
      previous,
      now: () => 200,
    });

    expect(snapshot).toMatchObject({ stale: true, observedAt: 200 });
    expect(snapshot.runtime).toMatchObject({ status: "degraded", code: "SOURCE_OFFLINE" });
    expect(snapshot.extensions).toEqual(previous.extensions);
  });
});

describe("extension failure classification", () => {
  test.each([
    ["java.lang.AbstractMethodError: parse response", "EXTENSION_INCOMPATIBLE", false],
    ["java.lang.NoSuchFieldError: Companion", "EXTENSION_INCOMPATIBLE", false],
    ["ClassCastException: okhttp3.Response cannot be cast to okhttp3.Response", "EXTENSION_INCOMPATIBLE", false],
    ["DemoInterceptor does not implement kotlin.jvm.functions.Function1", "EXTENSION_INCOMPATIBLE", false],
    ["JsonDecodingException: missing field", "EXTENSION_INCOMPATIBLE", false],
    ["Cloudflare challenge returned HTTP 403", "ANTIBOT_CHALLENGE", true],
    ["HTTP 401 login required", "AUTHENTICATION_REQUIRED", false],
    ["HTTP 429 too many requests", "RATE_LIMITED", true],
    ["ENOTFOUND source.example", "SOURCE_OFFLINE", true],
    ["Required setting is not configured", "CONFIGURATION_REQUIRED", false],
  ])("classifies %s", (message, code, retryable) => {
    expect(classifyExtensionFailure(new Error(message))).toMatchObject({ code, retryable });
  });
});

describe("explicit source reachability probe", () => {
  test("uses a bounded cache and does not repeat a fresh source request", async () => {
    let now = 1_000;
    const cache = new SourceHealthProbeCache(60_000, 2, () => now);
    const search = vi.fn(async () => ({ items: [], hasNextPage: false }));
    const runtime = { search } as unknown as SourceRuntime;

    const first = await probeSourceReachability(runtime, { sourceId: "10" }, cache);
    const cached = await probeSourceReachability(runtime, { sourceId: "10" }, cache);

    expect(first.status).toBe("healthy");
    expect(cached).toBe(first);
    expect(search).toHaveBeenCalledOnce();

    now += 60_001;
    await probeSourceReachability(runtime, { sourceId: "10" }, cache);
    expect(search).toHaveBeenCalledTimes(2);
  });

  test("keeps last-known-good evidence for transient failures but not ABI failures", async () => {
    const cache = new SourceHealthProbeCache();
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: 1 }], hasNextPage: false })
      .mockRejectedValueOnce(new Error("request timeout"))
      .mockRejectedValueOnce(new Error("AbstractMethodError"));
    const runtime = { search } as unknown as SourceRuntime;

    const healthy = await probeSourceReachability(runtime, { sourceId: "10", force: true }, cache);
    const transient = await probeSourceReachability(runtime, { sourceId: "10", force: true }, cache);
    const incompatible = await probeSourceReachability(runtime, { sourceId: "10", force: true }, cache);

    expect(transient).toMatchObject({
      status: "degraded",
      stale: true,
      lastKnownHealthyAt: healthy.lastKnownHealthyAt,
      itemCount: 1,
    });
    expect(incompatible).toMatchObject({
      status: "unhealthy",
      stale: false,
      classification: "EXTENSION_INCOMPATIBLE",
    });
  });

  test("does not preserve expired last-known-good evidence", async () => {
    let now = 1_000;
    const cache = new SourceHealthProbeCache(100, 2, () => now);
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [{ id: 1 }], hasNextPage: false })
      .mockRejectedValueOnce(new Error("request timeout"));
    const runtime = { search } as unknown as SourceRuntime;

    await probeSourceReachability(runtime, { sourceId: "10", force: true }, cache);
    now += 101;
    const report = await probeSourceReachability(runtime, { sourceId: "10", force: true }, cache);

    expect(report).toMatchObject({
      status: "degraded",
      stale: false,
      lastKnownHealthyAt: null,
      itemCount: null,
    });
  });

  test("classifies the bounded probe timeout as a transient offline state", async () => {
    vi.useFakeTimers();
    const runtime = {
      search: vi.fn(({ signal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })),
    } as unknown as SourceRuntime;

    const pending = probeSourceReachability(runtime, {
      sourceId: "10",
      timeoutMs: 500,
    }, new SourceHealthProbeCache());
    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toMatchObject({
      status: "degraded",
      classification: "SOURCE_OFFLINE",
    });
    vi.useRealTimers();
  });

  test("propagates caller cancellation instead of recording a false health failure", async () => {
    const controller = new AbortController();
    const runtime = {
      search: vi.fn(async ({ signal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new SourceRuntimeError(
          "NETWORK_FAILURE",
          "cancelled",
          { retryable: true },
        )), { once: true });
      })),
    } as unknown as SourceRuntime;

    const pending = probeSourceReachability(runtime, {
      sourceId: "10",
      signal: controller.signal,
    }, new SourceHealthProbeCache());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "NETWORK_FAILURE" });
  });
});
