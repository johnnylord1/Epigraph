import { invoke } from "@tauri-apps/api/core";

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
  if (await probeServerHealth(serverUrl)) return true;
  if (!isLoopbackServerUrl(serverUrl)) return false;

  await invoke<void>("spawn_server", {
    binary: input.binary ?? "",
    serverUrl,
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await probeServerHealth(serverUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 600 : 1000));
  }

  console.warn(`Suwayomi did not wake for ${reason}.`);
  return false;
}

export async function maybeStandbyLocalServer(input: ServerLifecycleInput) {
  const serverUrl = input.serverUrl ?? null;
  if (!isLoopbackServerUrl(serverUrl)) return false;
  if (!(await probeServerHealth(serverUrl))) return false;
  await invoke<void>("kill_server", { serverUrl });
  return true;
}
