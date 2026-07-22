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
  normalizedFlareSolverrEndpoint,
  saveFlareSolverrConfig,
  testFlareSolverrEndpoint,
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
});
