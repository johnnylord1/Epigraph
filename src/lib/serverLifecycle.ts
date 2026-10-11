import { invoke } from "@tauri-apps/api/core";
import type { LibraryUpdateIntensity } from "../store/state.svelte";

export const SERVER_READY_EVENT = "epigraph:server-ready";

const SERVER_READY_NOTIFY_DEBOUNCE_MS = 10_000;

let lastReadyNotification: { serverUrl: string; at: number } | null = null;
// Servers already announced since they were last seen down. A wake that finds one of them still answering
// has nothing new to announce: re-announcing made every visit to Browse reload its whole catalog.
const serversKnownReady = new Set<string>();

async function resetManagedSourceRuntimeCache() {
  const { resetManagedSourceRuntime } = await import("./manga/runtime/managed");
  resetManagedSourceRuntime();
}

export type ServerWakeReason =
  | "startup"
  | "manual-library-update"
  | "auto-library-update"
  | "library-category-members"
  | "library-covers"
  | "browse"
  | "downloads"
  | "reader"
  | "series-detail";

export interface ServerLifecycleInput {
  serverUrl: string | null | undefined;
  binary?: string | null;
  updateIntensity?: LibraryUpdateIntensity | null;
  profileId?: string | null;
  profileLabel?: string | null;
}

export function notifyServerReady(serverUrl: string | null | undefined) {
  if (!serverUrl || typeof window === "undefined") return;
  serversKnownReady.add(serverUrl);
  const now = Date.now();
  if (
    lastReadyNotification?.serverUrl === serverUrl
    && now - lastReadyNotification.at < SERVER_READY_NOTIFY_DEBOUNCE_MS
  ) {
    return;
  }
  lastReadyNotification = { serverUrl, at: now };
  window.dispatchEvent(new CustomEvent(SERVER_READY_EVENT, {
    detail: {
      serverUrl,
      at: now,
    },
  }));
}

/**
 * A start that opened the saved library stops waiting for Suwayomi, but the pages that need it should still
 * load as soon as it answers, so keep probing in the background and announce it once.
 */
export function announceServerWhenReady(
  serverUrl: string | null | undefined,
  isReady: () => Promise<boolean>,
  { intervalMs = 2000, giveUpAfterMs = 10 * 60_000 } = {},
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = Date.now() + giveUpAfterMs;
  const check = async () => {
    timer = null;
    if (stopped || !serverUrl) return;
    if (await isReady().catch(() => false)) {
      if (!stopped) notifyServerReady(serverUrl);
      return;
    }
    if (!stopped && Date.now() < deadline) timer = setTimeout(check, intervalMs);
  };
  void check();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

export function isLoopbackServerUrl(serverUrl: string | null | undefined) {
  if (!serverUrl) return false;
  try {
    const parsed = new URL(serverUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

export async function probeServerHealth(serverUrl: string | null | undefined) {
  if (!serverUrl) return false;
  try {
    return await invoke<boolean>("probe_server_health", { serverUrl });
  } catch {
    return false;
  }
}

// Callers that ask while a wake is already running for the same server share it instead of probing on their own.
const wakesInFlight = new Map<string, Promise<boolean>>();

export function ensureServerAwakeFor(
  reason: ServerWakeReason,
  input: ServerLifecycleInput,
) {
  const serverUrl = input.serverUrl ?? null;
  if (!serverUrl) return Promise.resolve(false);
  const key = `${serverUrl}|${input.profileId ?? ""}`;
  const running = wakesInFlight.get(key);
  if (running) return running;
  const wake = wakeServer(reason, serverUrl, input).finally(() => wakesInFlight.delete(key));
  wakesInFlight.set(key, wake);
  return wake;
}

async function wakeServer(
  reason: ServerWakeReason,
  serverUrl: string,
  input: ServerLifecycleInput,
) {
  if (await probeServerHealth(serverUrl)) {
    if (!serversKnownReady.has(serverUrl)) notifyServerReady(serverUrl);
    return true;
  }
  serversKnownReady.delete(serverUrl);
  if (!isLoopbackServerUrl(serverUrl)) return false;

  await invoke<void>("spawn_server", {
    binary: input.binary ?? "",
    serverUrl,
    profileId: input.profileId ?? null,
    profileLabel: input.profileLabel ?? null,
    updateIntensity: input.updateIntensity ?? "balanced",
  });
  await resetManagedSourceRuntimeCache();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await probeServerHealth(serverUrl)) {
      notifyServerReady(serverUrl);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 600 : 1000));
  }

  console.warn(`Suwayomi did not wake for ${reason}.`);
  return false;
}

export async function configureLocalServerRuntime(input: ServerLifecycleInput) {
  const serverUrl = input.serverUrl ?? null;
  if (!isLoopbackServerUrl(serverUrl)) return false;
  await invoke<void>("configure_local_server_runtime", {
    serverUrl,
    profileId: input.profileId ?? null,
    profileLabel: input.profileLabel ?? null,
    updateIntensity: input.updateIntensity ?? "balanced",
  });
  await resetManagedSourceRuntimeCache();
  return true;
}

export async function prepareManagedServerStartup(input: ServerLifecycleInput) {
  const serverUrl = input.serverUrl ?? null;
  if (!isLoopbackServerUrl(serverUrl)) return false;

  const commandInput = {
    binary: input.binary ?? "",
    serverUrl,
    profileId: input.profileId ?? null,
    profileLabel: input.profileLabel ?? null,
    updateIntensity: input.updateIntensity ?? "balanced",
  };
  await invoke<void>("prepare_managed_server_startup", commandInput);
  await resetManagedSourceRuntimeCache();
  return true;
}

export async function maybeStandbyLocalServer(input: ServerLifecycleInput) {
  const serverUrl = input.serverUrl ?? null;
  if (!isLoopbackServerUrl(serverUrl)) return false;
  if (!(await probeServerHealth(serverUrl))) return false;
  serversKnownReady.delete(serverUrl);
  await invoke<void>("kill_server", { serverUrl });
  await resetManagedSourceRuntimeCache();
  return true;
}
