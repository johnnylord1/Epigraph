import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("server lifecycle notifications", () => {
  // Startup lazily loads the managed runtime, whose graph reaches the message catalog; transform it once
  // up front so each test measures lifecycle work rather than the cold catalog transform.
  beforeAll(async () => {
    await import("./manga/runtime/managed");
    vi.resetModules();
  }, 30_000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock("@tauri-apps/api/core");
    vi.resetModules();
  });

  it("delegates clean local startup to one backend orchestration command", async () => {
    const invoke = vi.fn(async () => undefined);
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { prepareManagedServerStartup } = await import("./serverLifecycle");

    const started = await prepareManagedServerStartup({
      serverUrl: "http://127.0.0.1:4567",
      binary: "",
      updateIntensity: "balanced",
      profileId: "main",
      profileLabel: "MAIN",
    });

    expect(started).toBe(true);
    expect(invoke.mock.calls).toEqual([
      ["prepare_managed_server_startup", {
        binary: "",
        serverUrl: "http://127.0.0.1:4567",
        profileId: "main",
        profileLabel: "MAIN",
        updateIntensity: "balanced",
      }],
    ]);
  });

  it("lets concurrent wake requests for the same server share one probe and spawn", async () => {
    let healthy = false;
    const invoke = vi.fn(async (command: string) => {
      if (command === "probe_server_health") return healthy;
      if (command === "spawn_server") healthy = true;
      return undefined;
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { ensureServerAwakeFor } = await import("./serverLifecycle");
    const input = { serverUrl: "http://127.0.0.1:4567", profileId: "main" };

    const wakes = [
      ensureServerAwakeFor("library-covers", input),
      ensureServerAwakeFor("browse", input),
      ensureServerAwakeFor("downloads", input),
    ];
    await vi.runAllTimersAsync();

    expect(await Promise.all(wakes)).toEqual([true, true, true]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "probe_server_health",
      "spawn_server",
      "probe_server_health",
    ]);

    // Once that wake settles, the next request checks the server again.
    await expect(ensureServerAwakeFor("reader", input)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("dedupes repeated ready notifications for the same server", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", class {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });

    const { SERVER_READY_EVENT, notifyServerReady } = await import("./serverLifecycle");

    notifyServerReady("http://127.0.0.1:4567");
    notifyServerReady("http://127.0.0.1:4567");

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: SERVER_READY_EVENT,
      detail: { serverUrl: "http://127.0.0.1:4567", at: 1_000 },
    });

    vi.advanceTimersByTime(10_001);
    notifyServerReady("http://127.0.0.1:4567");

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it("does not suppress ready notifications for a different server", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", class {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });

    const { notifyServerReady } = await import("./serverLifecycle");

    notifyServerReady("http://127.0.0.1:4567");
    notifyServerReady("http://127.0.0.1:4568");

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it("announces a server the startup stopped waiting for once it answers", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", class {
      type: string;
      detail: unknown;

      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    const { SERVER_READY_EVENT, announceServerWhenReady } = await import("./serverLifecycle");
    let ready = false;
    const isReady = vi.fn(async () => ready);

    announceServerWhenReady("http://127.0.0.1:4567", isReady, { intervalMs: 2000 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(isReady).toHaveBeenCalledTimes(3);
    expect(dispatchEvent).not.toHaveBeenCalled();

    ready = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: SERVER_READY_EVENT,
      detail: { serverUrl: "http://127.0.0.1:4567" },
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(isReady).toHaveBeenCalledTimes(4);
  });

  it("stops probing when cancelled or after giving up", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const { announceServerWhenReady } = await import("./serverLifecycle");
    const cancelledProbe = vi.fn(async () => false);
    const stop = announceServerWhenReady("http://127.0.0.1:4567", cancelledProbe, { intervalMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cancelledProbe).toHaveBeenCalledTimes(1);

    const downProbe = vi.fn(async () => false);
    announceServerWhenReady("http://127.0.0.1:4567", downProbe, { intervalMs: 2000, giveUpAfterMs: 5000 });
    // Checks at 0, 2 s, 4 s and one last time at 6 s, then nothing more for the rest of the minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(downProbe).toHaveBeenCalledTimes(4);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
