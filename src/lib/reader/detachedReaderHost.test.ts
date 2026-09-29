import { describe, expect, it, vi } from "vitest";
import {
  createDetachedChannelKey,
  openDetachedMessage,
  sealDetachedMessage,
  type DetachedToReaderMessage,
  type SealedDetachedMessage,
} from "./detachedChannel";
import { createDetachedReaderHost, detachedWindowPlacement, type DetachedReaderTarget } from "./detachedReaderHost";

const LABEL = "detached-reader-one";
const TARGET: DetachedReaderTarget = { kind: "book", bookId: "book-1" };

async function setup(options: { leaseTtlMs?: number } = {}) {
  const { key } = await createDetachedChannelKey();
  const replies: DetachedToReaderMessage[] = [];
  const bridge = {
    connection: () => ({
      runtimeServerUrl: "http://127.0.0.1:4567",
      runtimeServerLabel: "Local",
      runtimeResolvedLocalProfileId: "p1",
      runtimeResolvedLocalProfileMeta: null,
    }),
    applyStore: vi.fn((method: string, _args: unknown[]): unknown => (method === "checkAndMarkCompleted" ? "marked" : undefined)),
    readerClosed: vi.fn(),
  };
  let tokens = 0;
  const invokeCommand = vi.fn(async (cmd: string, args: unknown): Promise<unknown> => {
    if (cmd === "begin_suwayomi_runtime_operation") return `lease-${++tokens}`;
    if (cmd === "end_suwayomi_runtime_operation") return true;
    return { cmd, args };
  });
  const send = vi.fn(async (label: string, sealed: SealedDetachedMessage) => {
    expect(label).toBe(LABEL);
    replies.push(await openDetachedMessage<DetachedToReaderMessage>(key, "to-reader", sealed));
  });
  const host = createDetachedReaderHost({ bridge, invokeCommand, send, leaseTtlMs: options.leaseTtlMs });
  host.register(LABEL, key, TARGET);
  let seq = 0;
  const post = async (message: Record<string, unknown>, options: { seq?: number; sealKey?: CryptoKey } = {}) => {
    host.receive(await sealDetachedMessage(options.sealKey ?? key, "to-main", LABEL, { ...message, seq: options.seq ?? ++seq }));
  };
  // Sealing and opening go through WebCrypto, which resolves on later macrotasks.
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const reply = (id: number) => replies.find((entry) => entry.id === id);
  return { host, bridge, invokeCommand, post, settle, reply, replies };
}

describe("detached reader host", () => {
  it("answers hello with the connection and the window's target", async () => {
    const { post, settle, reply } = await setup();
    await post({ kind: "hello", id: 1 });
    await settle();
    expect(reply(1)).toEqual({
      kind: "result",
      id: 1,
      ok: true,
      value: {
        runtimeServerUrl: "http://127.0.0.1:4567",
        runtimeServerLabel: "Local",
        runtimeResolvedLocalProfileId: "p1",
        runtimeResolvedLocalProfileMeta: null,
        target: TARGET,
      },
    });
  });

  it("runs only allowlisted commands", async () => {
    const { post, settle, reply, invokeCommand } = await setup();
    await post({ kind: "invoke", id: 1, cmd: "read_book_library_state", args: { x: 1 } });
    await post({ kind: "invoke", id: 2, cmd: "write_book_library_state", args: {} });
    await settle();
    expect(reply(1)).toMatchObject({ ok: true, value: { cmd: "read_book_library_state", args: { x: 1 } } });
    expect(reply(2)).toMatchObject({ ok: false, error: "DETACHED_READER_COMMAND_UNAVAILABLE:write_book_library_state" });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("ignores replays, unknown windows and messages sealed with another key", async () => {
    const { host, post, settle, replies, invokeCommand } = await setup();
    await post({ kind: "invoke", id: 1, cmd: "read_file_base64", args: {} }, { seq: 5 });
    await post({ kind: "invoke", id: 2, cmd: "read_file_base64", args: {} }, { seq: 5 });
    await post({ kind: "invoke", id: 3, cmd: "read_file_base64", args: {} }, { seq: 4 });
    const stranger = await createDetachedChannelKey();
    await post({ kind: "invoke", id: 4, cmd: "read_file_base64", args: {} }, { seq: 9, sealKey: stranger.key });
    host.receive(await sealDetachedMessage(stranger.key, "to-main", "detached-reader-two", { kind: "hello", id: 5, seq: 1 }));
    host.receive({ label: "main", iv: "a", data: "b" });
    await settle();
    expect(replies.map((entry) => entry.id)).toEqual([1]);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("applies allowlisted store changes and refuses the rest", async () => {
    const { post, settle, reply, bridge } = await setup();
    await post({ kind: "store", method: "addHistory", args: [{ id: 1 }] });
    await post({ kind: "store", id: 7, method: "checkAndMarkCompleted", args: [3, []] });
    await post({ kind: "store", id: 8, method: "clearAllData", args: [] });
    await settle();
    expect(bridge.applyStore).toHaveBeenCalledWith("addHistory", [{ id: 1 }]);
    expect(reply(7)).toMatchObject({ ok: true, value: "marked" });
    expect(reply(8)).toMatchObject({ ok: false, error: "DETACHED_READER_STORE_UNAVAILABLE:clearAllData" });
    expect(bridge.applyStore).not.toHaveBeenCalledWith("clearAllData", expect.anything());
  });

  it("tracks mutation leases per window and releases them when the window goes away", async () => {
    const { host, post, settle, reply, invokeCommand, bridge } = await setup();
    await post({ kind: "invoke", id: 1, cmd: "begin_suwayomi_runtime_operation", args: { scope: "maintenance" } });
    await post({ kind: "invoke", id: 2, cmd: "begin_suwayomi_runtime_operation", args: { scope: "mutation" } });
    await post({ kind: "invoke", id: 3, cmd: "begin_suwayomi_runtime_operation", args: { scope: "mutation" } });
    await post({ kind: "invoke", id: 4, cmd: "end_suwayomi_runtime_operation", args: { token: "lease-from-main" } });
    await post({ kind: "invoke", id: 5, cmd: "end_suwayomi_runtime_operation", args: { token: "lease-1" } });
    await settle();
    expect(reply(1)).toMatchObject({ ok: false });
    expect(reply(2)).toMatchObject({ ok: true, value: "lease-1" });
    expect(reply(3)).toMatchObject({ ok: true, value: "lease-2" });
    expect(reply(4)).toMatchObject({ ok: true, value: false });
    expect(reply(5)).toMatchObject({ ok: true, value: true });
    expect(invokeCommand).not.toHaveBeenCalledWith("end_suwayomi_runtime_operation", { token: "lease-from-main" });
    expect(invokeCommand).not.toHaveBeenCalledWith("begin_suwayomi_runtime_operation", { scope: "maintenance" });

    invokeCommand.mockClear();
    host.forget(LABEL);
    expect(invokeCommand.mock.calls).toEqual([["end_suwayomi_runtime_operation", { token: "lease-2" }]]);
    expect(bridge.readerClosed).toHaveBeenCalledTimes(1);
    expect(host.sessions.has(LABEL)).toBe(false);
    host.forget(LABEL);
    expect(bridge.readerClosed).toHaveBeenCalledTimes(1);
  });

  it("returns a lease a hung window keeps past its time limit, once", { timeout: 10000 }, async () => {
    const { host, post, settle, reply, invokeCommand } = await setup({ leaseTtlMs: 2000 });
    await post({ kind: "invoke", id: 1, cmd: "begin_suwayomi_runtime_operation", args: { scope: "mutation" } });
    await post({ kind: "invoke", id: 2, cmd: "begin_suwayomi_runtime_operation", args: { scope: "mutation" } });
    await settle();
    await post({ kind: "invoke", id: 3, cmd: "end_suwayomi_runtime_operation", args: { token: "lease-2" } });
    await settle();
    expect(reply(3)).toMatchObject({ ok: true, value: true });
    const ends = () => invokeCommand.mock.calls.filter(([cmd]) => cmd === "end_suwayomi_runtime_operation");
    expect(ends()).toHaveLength(1);
    await vi.waitFor(() => expect(ends()).toHaveLength(2), { timeout: 5000, interval: 50 });
    expect(ends()).toEqual([
      ["end_suwayomi_runtime_operation", { token: "lease-2" }],
      ["end_suwayomi_runtime_operation", { token: "lease-1" }],
    ]);
    // The window wakes up and returns it itself, then closes: neither ends it a second time.
    await post({ kind: "invoke", id: 4, cmd: "end_suwayomi_runtime_operation", args: { token: "lease-1" } });
    await settle();
    expect(reply(4)).toMatchObject({ ok: true, value: false });
    host.forget(LABEL);
    expect(ends()).toHaveLength(2);
  });

  it("returns a lease that arrives after its window went away", async () => {
    const { host, post, settle, invokeCommand, replies } = await setup();
    let release!: (token: string) => void;
    invokeCommand.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await post({ kind: "invoke", id: 1, cmd: "begin_suwayomi_runtime_operation", args: { scope: "mutation" } });
    await settle();
    host.forget(LABEL);
    release("late-lease");
    await settle();
    expect(invokeCommand).toHaveBeenCalledWith("end_suwayomi_runtime_operation", { token: "late-lease" });
    expect(replies).toEqual([]);
  });
});

describe("detached reader window placement", () => {
  const monitor = (x: number, y: number, width: number, height: number, scaleFactor = 1) => ({
    scaleFactor,
    workArea: { position: { x, y }, size: { width, height } },
  }) as Parameters<typeof detachedWindowPlacement>[0];

  it("centres the window in the work area of the main window's monitor, left of the primary one too", () => {
    expect(detachedWindowPlacement(monitor(0, 0, 1920, 1032))).toEqual({ x: 410, y: 106, width: 1100, height: 820 });
    expect(detachedWindowPlacement(monitor(-1920, 0, 1920, 1080))).toEqual({ x: -1510, y: 130, width: 1100, height: 820 });
  });

  it("scales the default size to the monitor and keeps it inside a small work area", () => {
    expect(detachedWindowPlacement(monitor(2560, 0, 3840, 2100, 1.5))).toEqual({ x: 3655, y: 435, width: 1650, height: 1230 });
    expect(detachedWindowPlacement(monitor(0, 0, 1280, 680, 1.25))).toEqual({ x: 0, y: 0, width: 1280, height: 680 });
  });
});
