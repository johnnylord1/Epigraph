import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("server lifecycle notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
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
});
