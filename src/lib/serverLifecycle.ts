import { invoke } from "@tauri-apps/api/core";
import type { LibraryUpdateIntensity } from "../store/state.svelte";

export const SERVER_READY_EVENT = "aethon:server-ready";

const SERVER_READY_NOTIFY_DEBOUNCE_MS = 10_000;

let lastReadyNotification: { serverUrl: string; at: number } | null = null;

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

export async function ensureServerAwakeFor(
  reason: ServerWakeReason,
  input: ServerLifecycleInput,
) {
  const serverUrl = input.serverUrl ?? null;
  if (!serverUrl) return false;
  if (await probeServerHealth(serverUrl)) {
    notifyServerReady(serverUrl);
    return true;
  }
  if (!isLoopbackServerUrl(serverUrl)) return false;

  await invoke<void>("spawn_server", {
    binary: input.binary ?? "",
    serverUrl,
    profileId: input.profileId ?? null,
    profileLabel: input.profileLabel ?? null,
    updateIntensity: input.updateIntensity ?? "balanced",
  });

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
  return true;
}

export async function maybeStandbyLocalServer(input: ServerLifecycleInput) {
  const serverUrl = input.serverUrl ?? null;
  if (!isLoopbackServerUrl(serverUrl)) return false;
  if (!(await probeServerHealth(serverUrl))) return false;
  await invoke<void>("kill_server", { serverUrl });
  return true;
}
