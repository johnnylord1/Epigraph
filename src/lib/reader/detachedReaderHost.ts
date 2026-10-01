// Main-window side of detached reader windows. The main window creates each window with a fresh key, answers
// its sealed requests, and applies the store changes it relays, so persistence keeps a single writer.
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Monitor } from "@tauri-apps/api/window";
import type { Chapter, Manga } from "../types";
import type { ActiveNovelDetailState, ActiveNovelReaderState } from "../novels/domain";
import {
  createDetachedChannelKey,
  DETACHED_READER_LABEL_PREFIX,
  DETACHED_READER_QUERY,
  DETACHED_READER_RELAYED_COMMANDS,
  DETACHED_READER_STORE_METHODS,
  DETACHED_READER_TO_MAIN_EVENT,
  DETACHED_READER_TO_READER_EVENT,
  isSealedDetachedMessage,
  openDetachedMessage,
  sealDetachedMessage,
  type DetachedToMainMessage,
  type DetachedToReaderMessage,
  type SealedDetachedMessage,
} from "./detachedChannel";

export type DetachedReaderTarget =
  | { kind: "manga"; chapter: Chapter; chapterList: Chapter[]; manga: Manga | null; pageUrls?: string[] }
  | { kind: "book"; bookId: string }
  | { kind: "novel"; reader: ActiveNovelReaderState; detail: ActiveNovelDetailState | null };

export interface DetachedReaderConnection {
  runtimeServerUrl: string | null;
  runtimeServerLabel: string | null;
  runtimeResolvedLocalProfileId: string | null;
  runtimeResolvedLocalProfileMeta: unknown;
}

export interface DetachedReaderContext extends DetachedReaderConnection {
  target: DetachedReaderTarget;
}

export interface DetachedReaderMainBridge {
  connection(): DetachedReaderConnection;
  applyStore(method: string, args: unknown[]): unknown;
  readerClosed(label: string): void;
}

export interface DetachedReaderHostDeps {
  bridge: DetachedReaderMainBridge;
  invokeCommand(cmd: string, args: unknown): Promise<unknown>;
  send(label: string, sealed: SealedDetachedMessage): Promise<void>;
  /** How long a window may hold one mutation lease before the main window returns it. */
  leaseTtlMs?: number;
}

interface DetachedReaderSession {
  label: string;
  key: CryptoKey;
  lastSeq: number;
  target: DetachedReaderTarget;
  chain: Promise<void>;
  /** Suwayomi operation leases this window holds, with the timer that returns each one if the window hangs. */
  leases: Map<string, ReturnType<typeof setTimeout>>;
}

const BEGIN_LEASE_COMMAND = "begin_suwayomi_runtime_operation";
const END_LEASE_COMMAND = "end_suwayomi_runtime_operation";
// A reader's mutation gives up after the 12 s GraphQL timeout, so a lease still held long after that belongs to
// a window that stopped answering; holding it would keep library updates and maintenance waiting indefinitely.
const DEFAULT_LEASE_TTL_MS = 120_000;

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

export function createDetachedReaderHost(deps: DetachedReaderHostDeps) {
  const sessions = new Map<string, DetachedReaderSession>();
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  function releaseLease(session: DetachedReaderSession, token: string) {
    const timer = session.leases.get(token);
    if (timer === undefined) return false;
    clearTimeout(timer);
    session.leases.delete(token);
    return true;
  }

  async function reply(label: string, session: DetachedReaderSession, message: DetachedToReaderMessage) {
    if (sessions.get(label) !== session) return;
    await deps.send(label, await sealDetachedMessage(session.key, "to-reader", label, message)).catch(() => {});
  }

  function answer(label: string, session: DetachedReaderSession, id: number, work: () => unknown) {
    void Promise.resolve()
      .then(work)
      .then(
        (value) => reply(label, session, { kind: "result", id, ok: true, value: value ?? null }),
        (error) => reply(label, session, { kind: "result", id, ok: false, error: describeError(error) }),
      );
  }

  async function runCommand(session: DetachedReaderSession, cmd: string, args: unknown) {
    if (!DETACHED_READER_RELAYED_COMMANDS.has(cmd)) throw new Error(`DETACHED_READER_COMMAND_UNAVAILABLE:${cmd}`);
    const fields = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    if (cmd === BEGIN_LEASE_COMMAND) {
      // A reader only writes chapter progress; the other scopes guard maintenance that belongs to the main window.
      if (fields.scope !== "mutation") throw new Error(`DETACHED_READER_COMMAND_UNAVAILABLE:${cmd}`);
      const token = await deps.invokeCommand(cmd, { scope: "mutation" });
      if (typeof token === "string") {
        if (sessions.get(session.label) === session) {
          session.leases.set(token, setTimeout(() => {
            if (releaseLease(session, token)) void deps.invokeCommand(END_LEASE_COMMAND, { token }).catch(() => {});
          }, leaseTtlMs));
        }
        else await deps.invokeCommand(END_LEASE_COMMAND, { token }).catch(() => {});
      }
      return token;
    }
    if (cmd === END_LEASE_COMMAND) {
      const token = fields.token;
      if (typeof token !== "string" || !releaseLease(session, token)) return false;
      return deps.invokeCommand(cmd, { token });
    }
    return deps.invokeCommand(cmd, args ?? {});
  }

  function dispatch(label: string, session: DetachedReaderSession, message: DetachedToMainMessage) {
    if (message.kind === "hello") {
      answer(label, session, message.id, () => ({ ...deps.bridge.connection(), target: session.target } satisfies DetachedReaderContext));
      return;
    }
    if (message.kind === "invoke") {
      answer(label, session, message.id, () => runCommand(session, message.cmd, message.args));
      return;
    }
    if (message.kind === "store") {
      const args = Array.isArray(message.args) ? message.args : [];
      const work = () => {
        if (!DETACHED_READER_STORE_METHODS.has(message.method)) throw new Error(`DETACHED_READER_STORE_UNAVAILABLE:${message.method}`);
        return deps.bridge.applyStore(message.method, args);
      };
      if (typeof message.id === "number") answer(label, session, message.id, work);
      else void Promise.resolve().then(work).catch((error) => console.warn("Detached reader update was refused:", error));
    }
  }

  function receive(payload: unknown) {
    if (!isSealedDetachedMessage(payload)) return;
    const label = payload.label;
    const session = sessions.get(label);
    if (!session) return;
    session.chain = session.chain.then(async () => {
      let message: DetachedToMainMessage;
      try {
        message = await openDetachedMessage<DetachedToMainMessage>(session.key, "to-main", payload);
      } catch {
        return; // Not sealed by this window; another webview can see and send these events.
      }
      if (!Number.isSafeInteger(message?.seq) || message.seq <= session.lastSeq) return;
      session.lastSeq = message.seq;
      dispatch(label, session, message);
    });
  }

  return {
    sessions,
    receive,
    register(label: string, key: CryptoKey, target: DetachedReaderTarget) {
      sessions.set(label, { label, key, lastSeq: 0, target, chain: Promise.resolve(), leases: new Map() });
    },
    forget(label: string) {
      const session = sessions.get(label);
      if (!session) return;
      sessions.delete(label);
      for (const token of [...session.leases.keys()]) {
        releaseLease(session, token);
        void deps.invokeCommand(END_LEASE_COMMAND, { token }).catch(() => {});
      }
      deps.bridge.readerClosed(label);
    },
  };
}

type DetachedReaderHost = ReturnType<typeof createDetachedReaderHost>;
let hostPromise: Promise<DetachedReaderHost> | null = null;

async function createStoreBridge(): Promise<DetachedReaderMainBridge> {
  const state = await import("../../store/state.svelte");
  const { adoptClosedWindowMangaProgress, getMangaProgressForScope } = await import("./mangaProgressRuntime");
  const { getServerUrl } = await import("../client");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const methods: Record<string, (...args: any[]) => unknown> = {
    addHistory: state.addHistory,
    addBookmark: state.addBookmark,
    removeBookmark: state.removeBookmark,
    updateSettings: state.updateSettings,
    setBookProgress: state.setBookProgress,
    addBookBookmark: state.addBookBookmark,
    removeBookBookmark: state.removeBookBookmark,
    flushBookLibraryPersistence: state.flushBookLibraryPersistence,
    checkAndMarkCompleted: (mangaId: number, chapters: Chapter[]) => state.checkAndMarkCompleted(mangaId, chapters),
    setSettingsOpen: (open: boolean) => {
      state.setSettingsOpen(open === true);
      const main = getCurrentWindow();
      void main.unminimize().catch(() => {}).then(() => main.setFocus()).catch(() => {});
    },
    // Novel chapters come from the runtime host only this window runs, and only this window writes the library.
    loadNovelChapter: async (scope: unknown, reader: unknown) => {
      const novels = await import("../novels/readerData");
      return novels.loadNovelChapterContent(novels.readNovelReaderScope(scope), novels.readNovelReaderTarget(reader));
    },
    saveNovelReaderChanges: async (scope: unknown, changes: unknown) => {
      const novels = await import("../novels/readerData");
      await novels.saveNovelReaderChanges(novels.readNovelReaderScope(scope), novels.readNovelReaderChanges(changes));
      state.bumpContentSetupVersion();
    },
    // A novel window asks for FlareSolverr when its source shows a challenge; the saved setting reaches it as usual.
    startFlareSolverr: async () => {
      const { startLocalFlareSolverrAndEnable } = await import("../flaresolverr");
      await startLocalFlareSolverrAndEnable();
    },
    // Page lists come from here so windows opening the same chapter share one request (see fetchSourceChapterPages).
    fetchChapterPages: async (chapterId: unknown, mangaId: unknown) => {
      if (!Number.isSafeInteger(chapterId) || !Number.isSafeInteger(mangaId)) throw new Error("DETACHED_READER_CHAPTER_INVALID");
      const { fetchSourceChapterPages } = await import("../manga/runtime/sourceOperations");
      return (await fetchSourceChapterPages({ chapterId: chapterId as number, mangaId: mangaId as number })).fetchChapterPages.pages;
    },
    // Only the page count crosses over; the window reads each downloaded page itself through `offline-page`.
    openOfflineMangaChapter: async (input: unknown) => (await import("./offlineManga")).openOfflineMangaChapterForWindow(input),
    mangaProgressSaved: (scope: string, progress: { chapterId: number; lastPageRead: number; isRead: boolean }) => {
      if (typeof scope !== "string" || !progress || !Number.isSafeInteger(progress.chapterId)) return;
      getMangaProgressForScope(scope).seed(progress.chapterId, progress.lastPageRead, progress.isRead === true);
    },
  };
  return {
    connection: () => ({
      runtimeServerUrl: state.store.runtimeServerUrl,
      runtimeServerLabel: state.store.runtimeServerLabel,
      runtimeResolvedLocalProfileId: state.store.runtimeResolvedLocalProfileId,
      runtimeResolvedLocalProfileMeta: state.store.runtimeResolvedLocalProfileMeta,
    }),
    applyStore: (method, args) => methods[method]?.(...args),
    readerClosed: (label) => {
      state.store.noteDetachedReaderClosed();
      // A window closes without waiting for Suwayomi, so this window's queue for the same connection takes over the
      // progress it left and keeps retrying it, even when no reader ran here yet.
      const profileId = state.store.runtimeResolvedLocalProfileId;
      getMangaProgressForScope(profileId ? `profile:${profileId}` : `server:${getServerUrl()}`);
      adoptClosedWindowMangaProgress(label);
    },
  };
}

function getHost(): Promise<DetachedReaderHost> {
  hostPromise ??= (async () => {
    const host = createDetachedReaderHost({
      bridge: await createStoreBridge(),
      invokeCommand: (cmd, args) => invoke(cmd, args as Record<string, unknown>),
      send: (label, sealed) => emitTo(label, DETACHED_READER_TO_READER_EVENT, sealed),
    });
    await listen<unknown>(DETACHED_READER_TO_MAIN_EVENT, (event) => host.receive(event.payload));
    return host;
  })().catch((error) => {
    hostPromise = null;
    throw error;
  });
  return hostPromise;
}

const DETACHED_WINDOW_WIDTH = 1100;
const DETACHED_WINDOW_HEIGHT = 820;

export interface DetachedWindowPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centres a new reader window in the work area of the monitor that shows the main window, at the default size
 * scaled to that monitor and kept inside it. Physical pixels, so monitors with different scales agree. */
export function detachedWindowPlacement(monitor: Pick<Monitor, "scaleFactor" | "workArea">): DetachedWindowPlacement {
  const { position, size } = monitor.workArea;
  const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
  const width = Math.min(Math.round(DETACHED_WINDOW_WIDTH * scale), size.width);
  const height = Math.min(Math.round(DETACHED_WINDOW_HEIGHT * scale), size.height);
  return {
    x: position.x + Math.round((size.width - width) / 2),
    y: position.y + Math.round((size.height - height) / 2),
    width,
    height,
  };
}

const REMEMBERED_PLACEMENT_KEY = "epigraph-detached-reader-placement";

/** The size and position the last reader window had, if its centre is still on a monitor. It is kept inside
 * that monitor's work area, so a window saved on a larger or since rearranged monitor stays reachable. */
export function rememberedWindowPlacement(
  saved: unknown,
  monitors: ReadonlyArray<Pick<Monitor, "workArea">>,
): DetachedWindowPlacement | null {
  if (!saved || typeof saved !== "object") return null;
  const { x, y, width, height } = saved as Record<string, unknown>;
  if (![x, y, width, height].every(Number.isSafeInteger) || (width as number) < 1 || (height as number) < 1) return null;
  const centreX = (x as number) + (width as number) / 2;
  const centreY = (y as number) + (height as number) / 2;
  const area = monitors.map((monitor) => monitor.workArea).find(({ position, size }) =>
    centreX >= position.x && centreX < position.x + size.width && centreY >= position.y && centreY < position.y + size.height);
  if (!area) return null;
  const fitWidth = Math.min(width as number, area.size.width);
  const fitHeight = Math.min(height as number, area.size.height);
  const clamp = (value: number, start: number, room: number) => Math.min(Math.max(value, start), start + room);
  return {
    x: clamp(x as number, area.position.x, area.size.width - fitWidth),
    y: clamp(y as number, area.position.y, area.size.height - fitHeight),
    width: fitWidth,
    height: fitHeight,
  };
}

function readRememberedPlacement(): unknown {
  try {
    const raw = localStorage.getItem(REMEMBERED_PLACEMENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function mainWindowPlacement(): Promise<DetachedWindowPlacement | null> {
  try {
    const { availableMonitors, currentMonitor } = await import("@tauri-apps/api/window");
    const remembered = rememberedWindowPlacement(readRememberedPlacement(), await availableMonitors().catch(() => []));
    if (remembered) return remembered;
    const monitor = await currentMonitor();
    return monitor && monitor.workArea.size.width > 0 && monitor.workArea.size.height > 0
      ? detachedWindowPlacement(monitor)
      : null;
  } catch {
    return null;
  }
}

/** Keeps the size and position a reader window was last left at, so the next one opens there. Fullscreen,
 * maximized and minimized states are skipped; the window returns to its normal bounds from them. */
async function rememberPlacement(windowHandle: WebviewWindow): Promise<() => void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = async () => {
    try {
      const states = await Promise.all([windowHandle.isFullscreen(), windowHandle.isMaximized(), windowHandle.isMinimized()]);
      if (states.some(Boolean)) return;
      const [position, size] = await Promise.all([windowHandle.outerPosition(), windowHandle.innerSize()]);
      const placement: DetachedWindowPlacement = { x: position.x, y: position.y, width: size.width, height: size.height };
      localStorage.setItem(REMEMBERED_PLACEMENT_KEY, JSON.stringify(placement));
    } catch {
      // The window is closing, or storage is unavailable; the last saved placement stays.
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 300);
  };
  const unlisten = await Promise.all([windowHandle.onMoved(schedule), windowHandle.onResized(schedule)]).catch(() => []);
  return () => {
    clearTimeout(timer);
    for (const stop of unlisten) stop();
  };
}

/** Moves a window created hidden to its place, then shows it. A window that cannot be shown
 * is destroyed rather than left open and invisible. */
async function showAt(windowHandle: WebviewWindow, placement: DetachedWindowPlacement): Promise<void> {
  try {
    // Position first: moving to a monitor with another scale resizes the window, and the size set next wins.
    await windowHandle.setPosition(new PhysicalPosition(placement.x, placement.y));
    await windowHandle.setSize(new PhysicalSize(placement.width, placement.height));
  } catch (error) {
    console.warn("[detached-reader] could not place the window on the main window's monitor", error);
  }
  try {
    await windowHandle.show();
  } catch (error) {
    await windowHandle.destroy().catch(() => {});
    throw error;
  }
  await windowHandle.setFocus().catch(() => {});
}

function createLabel() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return `${DETACHED_READER_LABEL_PREFIX}${Date.now().toString(36)}${random}`;
}

/** Opens the reader for `target` in its own window. Resolves once the window exists. */
export async function openDetachedReader(target: DetachedReaderTarget, title: string): Promise<void> {
  const host = await getHost();
  const { key, secret } = await createDetachedChannelKey();
  const label = createLabel();
  const placement = await mainWindowPlacement();
  host.register(label, key, target);
  const windowHandle = new WebviewWindow(label, {
    url: `index.html?${DETACHED_READER_QUERY}=1#k=${secret}`,
    title,
    width: DETACHED_WINDOW_WIDTH,
    height: DETACHED_WINDOW_HEIGHT,
    minWidth: 480,
    minHeight: 360,
    // Without a known monitor, fall back to the primary one; otherwise place it before it is seen.
    center: placement === null,
    visible: placement === null,
    focus: true,
    decorations: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      void windowHandle.once("tauri://created", () => resolve());
      void windowHandle.once("tauri://error", (event) => reject(new Error(String(event.payload))));
    });
  } catch (error) {
    host.sessions.delete(label);
    throw error;
  }
  let destroyed = false;
  let stopRemembering = () => {};
  void windowHandle.once("tauri://destroyed", () => {
    destroyed = true;
    stopRemembering();
    host.forget(label);
  });
  if (placement) await showAt(windowHandle, placement);
  stopRemembering = await rememberPlacement(windowHandle);
  if (destroyed) stopRemembering();
}
