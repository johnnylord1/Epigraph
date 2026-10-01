import { translate } from "./i18n/runtime";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { SET_FLARESOLVERR } from "./queries";
import { gql } from "./client";
import { isConfirmedAntibotChallengeMessage, sourceAccessErrorMessage } from "./sourceAccess";
import { store, updateSettings } from "../store/state.svelte";

const FLARESOLVERR_READINESS_ATTEMPTS = 12;
const FLARESOLVERR_READINESS_INTERVAL_MS = 500;
const FLARESOLVERR_READINESS_PROBE_TIMEOUT_MS = 1500;
type FlareSolverrStartStatus = { startedNow?: boolean; endpointOwned?: boolean };
type FlareSolverrConfigPatch = Partial<{
  timeout: number;
  sessionName: string;
  sessionTtl: number;
  fallback: boolean;
}>;
let localStart: Promise<void> | null = null;
let startRelay: (() => Promise<unknown>) | null = null;
let dockerStart: Promise<void> | null = null;

export function normalizedFlareSolverrEndpoint(rawUrl = store.settings.flareSolverrUrl || "http://localhost:8191") {
  const url = new URL(rawUrl.trim() || "http://localhost:8191");
  return `${url.origin}/v1`;
}

export async function testFlareSolverrEndpoint(
  rawUrl = store.settings.flareSolverrUrl || "http://localhost:8191",
  timeoutMs = 6000,
) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await tauriFetch(normalizedFlareSolverrEndpoint(rawUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "sessions.list" }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as { status?: string } | null;
    return body?.status === "ok";
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function isFlareSolverrEligibleFailure(error: unknown): boolean {
  return isConfirmedAntibotChallengeMessage(sourceAccessErrorMessage(error));
}

export async function waitForFlareSolverrEndpoint(
  rawUrl: string,
  options: { attempts?: number; intervalMs?: number; probeTimeoutMs?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? FLARESOLVERR_READINESS_ATTEMPTS);
  const intervalMs = Math.max(0, options.intervalMs ?? FLARESOLVERR_READINESS_INTERVAL_MS);
  const probeTimeoutMs = Math.max(1, options.probeTimeoutMs ?? FLARESOLVERR_READINESS_PROBE_TIMEOUT_MS);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await testFlareSolverrEndpoint(rawUrl, probeTimeoutMs)) return true;
    } catch {
      // Startup can refuse connections until Chromium and the local API are ready.
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
    }
  }
  return false;
}

export async function saveFlareSolverrConfig(patch: Partial<{
  enabled: boolean;
  url: string;
  timeout: number;
  sessionName: string;
  sessionTtl: number;
  fallback: boolean;
}> = {}) {
  const next = {
    enabled: patch.enabled ?? store.settings.flareSolverrEnabled,
    url: patch.url ?? store.settings.flareSolverrUrl ?? "http://localhost:8191",
    timeout: patch.timeout ?? store.settings.flareSolverrTimeout ?? 60,
    sessionName: patch.sessionName ?? store.settings.flareSolverrSessionName ?? "epigraph",
    sessionTtl: patch.sessionTtl ?? store.settings.flareSolverrSessionTtl ?? 15,
    fallback: patch.fallback ?? store.settings.flareSolverrFallback ?? false,
  };

  await gql(SET_FLARESOLVERR, {
    flareSolverrEnabled: next.enabled,
    flareSolverrUrl: next.url.trim(),
    flareSolverrTimeout: next.timeout,
    flareSolverrSessionName: next.sessionName.trim(),
    flareSolverrSessionTtl: next.sessionTtl,
    flareSolverrAsResponseFallback: next.fallback,
  });
  updateSettings({
    flareSolverrEnabled: next.enabled,
    flareSolverrUrl: next.url,
    flareSolverrTimeout: next.timeout,
    flareSolverrSessionName: next.sessionName,
    flareSolverrSessionTtl: next.sessionTtl,
    flareSolverrFallback: next.fallback,
  });
}

async function startManagedFlareSolverrAndEnable(
  startCommand: "start_flaresolverr_local" | "start_flaresolverr_docker",
  statusCommand: "get_flaresolverr_local_status" | "get_flaresolverr_docker_status",
  stopCommand: "stop_flaresolverr_local" | "stop_flaresolverr_docker",
  unavailableMessage: string,
  configPatch: FlareSolverrConfigPatch,
) {
  const status = await invoke<FlareSolverrStartStatus>(startCommand);
  const url = "http://localhost:8191";
  try {
    const ready = await waitForFlareSolverrEndpoint(url);
    if (!ready) throw new Error(unavailableMessage);
    const current = await invoke<FlareSolverrStartStatus>(statusCommand);
    if (!current.endpointOwned) throw new Error("FlareSolverr is reachable, but the endpoint is not owned by this Epigraph runtime.");
    await saveFlareSolverrConfig({ ...configPatch, enabled: true, url, fallback: configPatch.fallback ?? true });
  } catch (error) {
    if (status.startedNow) {
      try {
        await invoke(stopCommand);
      } catch (cleanupError) {
        throw new Error(
          translate("flaresolverr_cleanupFailed", { error: sourceAccessErrorMessage(error), cleanup: sourceAccessErrorMessage(cleanupError) }),
          { cause: error },
        );
      }
    }
    throw error;
  }
}

/** In a detached reader window the main window starts the service, since only it may run app commands. */
export function setFlareSolverrStartRelay(next: (() => Promise<unknown>) | null) {
  startRelay = next;
}

export function startLocalFlareSolverrAndEnable(configPatch: FlareSolverrConfigPatch = {}): Promise<void> {
  if (startRelay) return startRelay().then(() => undefined);
  localStart ??= startManagedFlareSolverrAndEnable(
    "start_flaresolverr_local",
    "get_flaresolverr_local_status",
    "stop_flaresolverr_local",
    translate("flaresolverr_localUnreachable"),
    configPatch,
  ).finally(() => { localStart = null; });
  return localStart;
}

export function startDockerFlareSolverrAndEnable(configPatch: FlareSolverrConfigPatch = {}): Promise<void> {
  dockerStart ??= startManagedFlareSolverrAndEnable(
    "start_flaresolverr_docker",
    "get_flaresolverr_docker_status",
    "stop_flaresolverr_docker",
    translate("flaresolverr_dockerUnreachable"),
    configPatch,
  ).finally(() => { dockerStart = null; });
  return dockerStart;
}
