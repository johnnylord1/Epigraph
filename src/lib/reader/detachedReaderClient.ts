// Reader-window side of a detached reader. Everything this window asks of the main window is sealed with the
// key the main window put in this window's URL fragment; see detachedChannel.ts.
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { setInvokeRelay } from "../tauri/invoke";
import {
  DETACHED_READER_RELAYED_COMMANDS,
  DETACHED_READER_TO_MAIN_EVENT,
  DETACHED_READER_TO_READER_EVENT,
  importDetachedChannelKey,
  isDetachedReaderLabel,
  openDetachedMessage,
  readDetachedReaderSecret,
  sealDetachedMessage,
  trimTrailingUndefined,
  type DetachedToMainMessage,
  type DetachedToReaderMessage,
} from "./detachedChannel";
import type { DetachedReaderContext } from "./detachedReaderHost";

const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;
const DRAIN_TIMEOUT_MS = 5_000;

export interface DetachedReaderClient {
  label: string;
  context: DetachedReaderContext;
  /** Relays a store change; the main window applies and persists it. */
  notify(method: string, args: unknown[]): void;
  /** Relays a store call and resolves with the main window's result. */
  request(method: string, args: unknown[]): Promise<unknown>;
  /** Resolves once every relayed message has been handed to the main window and answered. */
  drain(): Promise<void>;
}

type OutgoingMessage =
  | { kind: "hello"; id: number }
  | { kind: "invoke"; id: number; cmd: string; args: unknown }
  | { kind: "store"; id?: number; method: string; args: unknown[] };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

export async function connectDetachedReader(): Promise<DetachedReaderClient> {
  const webview = getCurrentWebviewWindow();
  const label = webview.label;
  if (!isDetachedReaderLabel(label)) throw new Error("DETACHED_READER_LABEL_INVALID");
  const secret = readDetachedReaderSecret();
  if (!secret) throw new Error("DETACHED_READER_KEY_MISSING");
  // The key is only needed once; keep it out of the address a reload or a crash report could expose.
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  const key = await importDetachedChannelKey(secret);

  let seq = 0;
  let nextId = 0;
  let sendChain: Promise<void> = Promise.resolve();
  let replyChain: Promise<void> = Promise.resolve();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  await webview.listen<unknown>(DETACHED_READER_TO_READER_EVENT, (event) => {
    const payload = event.payload as { iv?: unknown; data?: unknown } | null;
    if (!payload || typeof payload.iv !== "string" || typeof payload.data !== "string") return;
    const sealed = { label, iv: payload.iv, data: payload.data };
    replyChain = replyChain.then(async () => {
      let message: DetachedToReaderMessage;
      try {
        message = await openDetachedMessage<DetachedToReaderMessage>(key, "to-reader", sealed);
      } catch {
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(message.error));
    });
  });

  function send(message: OutgoingMessage) {
    const next = { ...message, seq: ++seq } as DetachedToMainMessage;
    sendChain = sendChain
      .then(async () => emitTo("main", DETACHED_READER_TO_MAIN_EVENT, await sealDetachedMessage(key, "to-main", label, next)))
      .catch((error) => console.warn("Detached reader could not reach the main window:", error));
  }

  function call(message: WithoutId<OutgoingMessage>, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error("DETACHED_READER_MAIN_WINDOW_UNAVAILABLE"));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      send({ ...message, id } as OutgoingMessage);
    });
  }

  const context = await call({ kind: "hello" }, HELLO_TIMEOUT_MS) as DetachedReaderContext;

  setInvokeRelay((cmd, args) => {
    if (DETACHED_READER_RELAYED_COMMANDS.has(cmd)) return call({ kind: "invoke", cmd, args: args ?? {} });
    // Rich presence belongs to the main window; a second window would fight it for the same activity.
    if (cmd.startsWith("discord_rpc_")) return Promise.resolve(null);
    if (cmd === "optimize_discord_cover") return Promise.reject(new Error("DETACHED_READER_COMMAND_UNAVAILABLE"));
    return null;
  });

  return {
    label,
    context,
    notify(method, args) {
      send({ kind: "store", method, args: trimTrailingUndefined(args) });
    },
    request(method, args) {
      return call({ kind: "store", method, args: trimTrailingUndefined(args) });
    },
    async drain() {
      await sendChain;
      const waiting = [...pending.keys()];
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      await new Promise<void>((resolve) => {
        const check = () => (waiting.some((id) => pending.has(id)) && Date.now() < deadline ? setTimeout(check, 25) : resolve());
        check();
      });
    },
  };
}
