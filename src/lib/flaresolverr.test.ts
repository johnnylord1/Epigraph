import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { httpFetch, invoke, gql, updateSettings, settings } = vi.hoisted(() => ({
  httpFetch: vi.fn(),
  invoke: vi.fn(),
  gql: vi.fn(),
  updateSettings: vi.fn(),
  settings: {
    flareSolverrUrl: "http://localhost:8191",
    flareSolverrEnabled: false,
    flareSolverrTimeout: 60,
    flareSolverrSessionName: "aethon",
    flareSolverrSessionTtl: 15,
    flareSolverrFallback: false,
  },
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: httpFetch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./client", () => ({ gql }));
vi.mock("../store/state.svelte", () => ({ store: { settings }, updateSettings }));

import {
  isFlareSolverrEligibleFailure,
  normalizedFlareSolverrEndpoint,
  saveFlareSolverrConfig,
  startDockerFlareSolverrAndEnable,
  startLocalFlareSolverrAndEnable,
  testFlareSolverrEndpoint,
  waitForFlareSolverrEndpoint,
} from "./flaresolverr";

describe("FlareSolverr integration contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes configured endpoints to the v1 API", () => {
    expect(normalizedFlareSolverrEndpoint("http://127.0.0.1:8191/path")).toBe("http://127.0.0.1:8191/v1");
    expect(() => normalizedFlareSolverrEndpoint("not a url")).toThrow();
  });

  it("distinguishes healthy and invalid responses", async () => {
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    await expect(testFlareSolverrEndpoint()).resolves.toBe(true);

    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "error" }), { status: 503 }));
    await expect(testFlareSolverrEndpoint()).resolves.toBe(false);
  });

  it("aborts an unresponsive endpoint after the bounded timeout", async () => {
    vi.useFakeTimers();
    httpFetch.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const request = testFlareSolverrEndpoint().catch((error) => error as Error);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(request).resolves.toMatchObject({ name: "AbortError" });
    vi.useRealTimers();
  });

  it("persists a recovered healthy configuration through the existing mutation", async () => {
    gql.mockResolvedValueOnce({});
    await saveFlareSolverrConfig({ enabled: true, url: " http://127.0.0.1:8191 ", fallback: true });

    expect(gql).toHaveBeenCalledWith(expect.stringContaining("setSettings"), expect.objectContaining({
      flareSolverrEnabled: true,
      flareSolverrUrl: "http://127.0.0.1:8191",
      flareSolverrAsResponseFallback: true,
    }));
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ flareSolverrEnabled: true }));
  });

  it.each([
    ["Cloudflare challenge returned HTTP 403", true],
    ["java.lang.AbstractMethodError: okhttp ABI mismatch", false],
    ["HTTP 404 source removed", false],
    ["Parser found no element in HTML document", false],
    ["HTTP 401 login required", false],
    ["ECONNREFUSED source.example", false],
  ])("only considers confirmed anti-bot failures eligible: %s", (message, eligible) => {
    expect(isFlareSolverrEligibleFailure(new Error(message))).toBe(eligible);
  });

  it("polls readiness with bounded attempts and no fixed startup sleep", async () => {
    httpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "error" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    const readiness = waitForFlareSolverrEndpoint("http://localhost:8191", {
      attempts: 2,
      intervalMs: 0,
      probeTimeoutMs: 50,
    });

    await expect(readiness).resolves.toBe(true);
    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["local", startLocalFlareSolverrAndEnable, "start_flaresolverr_local"],
    ["docker", startDockerFlareSolverrAndEnable, "start_flaresolverr_docker"],
  ])("enables the %s runtime only after its API is healthy", async (_kind, start, command) => {
    invoke
      .mockResolvedValueOnce({ startedNow: true })
      .mockResolvedValueOnce({ endpointOwned: true });
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    gql.mockResolvedValueOnce({});

    await start();

    expect(invoke).toHaveBeenNthCalledWith(1, command);
    expect(httpFetch).toHaveBeenCalledWith("http://localhost:8191/v1", expect.objectContaining({
      body: JSON.stringify({ cmd: "sessions.list" }),
    }));
    expect(gql).toHaveBeenCalledWith(expect.stringContaining("setSettings"), expect.objectContaining({
      flareSolverrEnabled: true,
      flareSolverrAsResponseFallback: true,
    }));
  });

  it("does not enable FlareSolverr when bounded readiness is exhausted", async () => {
    vi.useFakeTimers();
    invoke
      .mockResolvedValueOnce({ startedNow: true })
      .mockResolvedValueOnce({ running: false });
    httpFetch.mockResolvedValue(new Response(JSON.stringify({ status: "error" }), { status: 503 }));

    const start = startLocalFlareSolverrAndEnable().catch((error) => error as Error);
    await vi.runAllTimersAsync();

    await expect(start).resolves.toMatchObject({
      message: "Local FlareSolverr did not become reachable.",
    });

    expect(gql).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenNthCalledWith(2, "stop_flaresolverr_local");
    vi.useRealTimers();
  });

  it("cleans up a newly started runtime when configuration persistence fails", async () => {
    invoke
      .mockResolvedValueOnce({ startedNow: true })
      .mockResolvedValueOnce({ endpointOwned: true })
      .mockResolvedValueOnce({ running: false });
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    gql.mockRejectedValueOnce(new Error("settings unavailable"));

    await expect(startLocalFlareSolverrAndEnable()).rejects.toThrow("settings unavailable");

    expect(invoke).toHaveBeenNthCalledWith(3, "stop_flaresolverr_local");
  });

  it("does not stop a pre-existing runtime after a readiness failure", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValueOnce({ startedNow: false });
    httpFetch.mockResolvedValue(new Response(JSON.stringify({ status: "error" }), { status: 503 }));

    const start = startLocalFlareSolverrAndEnable().catch((error) => error as Error);
    await vi.runAllTimersAsync();
    await expect(start).resolves.toMatchObject({ message: "Local FlareSolverr did not become reachable." });

    expect(invoke).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reports cleanup failure instead of silently hiding a residual runtime", async () => {
    vi.useFakeTimers();
    invoke
      .mockResolvedValueOnce({ startedNow: true })
      .mockRejectedValueOnce(new Error("owned process did not stop"));
    httpFetch.mockResolvedValue(new Response(JSON.stringify({ status: "error" }), { status: 503 }));

    const start = startLocalFlareSolverrAndEnable().catch((error) => error as Error);
    await vi.runAllTimersAsync();

    await expect(start).resolves.toMatchObject({
      message: expect.stringContaining("Managed FlareSolverr cleanup also failed"),
    });
    vi.useRealTimers();
  });

  it("coalesces concurrent start requests", async () => {
    invoke
      .mockResolvedValueOnce({ startedNow: true })
      .mockResolvedValueOnce({ endpointOwned: true });
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    gql.mockResolvedValueOnce({});

    const first = startLocalFlareSolverrAndEnable();
    const second = startLocalFlareSolverrAndEnable();
    await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(gql).toHaveBeenCalledOnce();
  });

  it("rejects and cleans up a healthy endpoint owned by another process", async () => {
    invoke
      .mockResolvedValueOnce({ startedNow: true })
      .mockResolvedValueOnce({ endpointOwned: false })
      .mockResolvedValueOnce({ running: false });
    httpFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));

    await expect(startLocalFlareSolverrAndEnable()).rejects.toThrow("endpoint is not owned");

    expect(invoke).toHaveBeenNthCalledWith(3, "stop_flaresolverr_local");
    expect(gql).not.toHaveBeenCalled();
  });

  it("keeps manga anti-bot handling delegated and process cleanup ownership-scoped", () => {
    const integrationSource = readFileSync("src/lib/flaresolverr.ts", "utf8");
    const nativeSource = readFileSync("src-tauri/src/lib.rs", "utf8");
    const settingsSource = readFileSync("src/components/settings/Settings.svelte", "utf8");

    expect(integrationSource).toContain('cmd: "sessions.list"');
    expect(integrationSource).not.toMatch(/cmd:\s*["']request\.(?:get|post)["']/i);
    expect(nativeSource).toMatch(/const FLARESOLVERR_IMAGE: &str = "ghcr\.io\/flaresolverr\/flaresolverr@sha256:[a-f0-9]{64}";/);
    expect(nativeSource).not.toMatch(/const FLARESOLVERR_IMAGE: &str = "[^"]*:latest";/);
    expect(nativeSource).toContain("FLARESOLVERR_DOCKER_OWNER_LABEL");
    expect(nativeSource).toContain("AssignProcessToJobObject");
    expect(nativeSource).toContain("CREATE_SUSPENDED");
    expect(nativeSource).toContain('"127.0.0.1:8191:8191"');
    expect(nativeSource).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(nativeSource).toContain("lock_exclusive");
    expect(nativeSource).not.toMatch(/process\.name\(\)\.eq_ignore_ascii_case\(["']flaresolverr/i);
    expect(settingsSource).toContain("startLocalFlareSolverrAndEnable");
    expect(settingsSource).toContain("startDockerFlareSolverrAndEnable");
    expect(settingsSource).not.toMatch(/invoke<[^>]+>\(["']start_flaresolverr_(?:local|docker)["']/);
  });
});
