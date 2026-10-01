import { afterEach, describe, expect, it, vi } from "vitest";
import { createDetachedChannelKey, type SealedDetachedMessage } from "./detachedChannel";
import { createDetachedReaderHost } from "./detachedReaderHost";

const LABEL = "detached-reader-one";

const { tauri } = vi.hoisted(() => ({
  tauri: {
    toMain: (_payload: SealedDetachedMessage) => {},
    toReader: (_event: { payload: unknown }) => {},
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: async (_target: string, _event: string, payload: SealedDetachedMessage) => tauri.toMain(payload),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: LABEL,
    listen: async (_event: string, handler: (event: { payload: unknown }) => void) => {
      tauri.toReader = handler;
      return () => {};
    },
  }),
}));
vi.mock("../tauri/invoke", () => ({ setInvokeRelay: vi.fn() }));

import { connectDetachedReader } from "./detachedReaderClient";

async function connect() {
  const { key, secret } = await createDetachedChannelKey();
  vi.stubGlobal("location", { hash: `#k=${secret}`, pathname: "/detached.html", search: "" });
  vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
  const applied: string[] = [];
  const bridge = {
    connection: () => ({
      runtimeServerUrl: "http://127.0.0.1:4567",
      runtimeServerLabel: null,
      runtimeResolvedLocalProfileId: null,
      runtimeResolvedLocalProfileMeta: null,
    }),
    applyStore: (method: string): unknown => {
      applied.push(method);
      // Suwayomi is away: this request never finishes in the main window.
      return method === "checkAndMarkCompleted" ? new Promise(() => {}) : undefined;
    },
    readerClosed: vi.fn(),
  };
  const host = createDetachedReaderHost({
    bridge,
    invokeCommand: async () => null,
    send: async (_label, sealed) => tauri.toReader({ payload: { iv: sealed.iv, data: sealed.data } }),
  });
  host.register(LABEL, key, { kind: "book", bookId: "book-1" });
  tauri.toMain = (payload) => host.receive(payload);
  return { client: await connectDetachedReader(), host, applied };
}

describe("detached reader client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drains once the main window has taken every message, without waiting on work still running there", async () => {
    const { client, host, applied } = await connect();
    void client.request("checkAndMarkCompleted", [1]).catch(() => {});
    client.notify("addHistory", [{ mangaId: 1 }]);

    const started = Date.now();
    await client.drain();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(applied).toEqual(["checkAndMarkCompleted", "addHistory"]);

    // Closing right after the drain loses nothing the window sent.
    host.forget(LABEL);
    expect(applied).toEqual(["checkAndMarkCompleted", "addHistory"]);
  });
});
