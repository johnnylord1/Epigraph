import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { SET_FLARESOLVERR } from "./queries";
import { gql } from "./client";
import { store, updateSettings } from "../store/state.svelte";

export function normalizedFlareSolverrEndpoint(rawUrl = store.settings.flareSolverrUrl || "http://localhost:8191") {
  const url = new URL(rawUrl.trim() || "http://localhost:8191");
  return `${url.origin}/v1`;
}

export async function testFlareSolverrEndpoint(rawUrl = store.settings.flareSolverrUrl || "http://localhost:8191") {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 6000);
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
    sessionName: patch.sessionName ?? store.settings.flareSolverrSessionName ?? "aethon",
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

export async function startLocalFlareSolverrAndEnable() {
  await invoke("start_flaresolverr_local");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 2500));
  const url = "http://localhost:8191";
  const ready = await testFlareSolverrEndpoint(url);
  if (!ready) throw new Error("Local FlareSolverr did not become reachable.");
  await saveFlareSolverrConfig({ enabled: true, url, fallback: true });
}

export async function startDockerFlareSolverrAndEnable() {
  await invoke("start_flaresolverr_docker");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 2500));
  const url = "http://localhost:8191";
  const ready = await testFlareSolverrEndpoint(url);
  if (!ready) throw new Error("Docker FlareSolverr did not become reachable.");
  await saveFlareSolverrConfig({ enabled: true, url, fallback: true });
}
