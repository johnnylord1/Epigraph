import { store } from "../store/state.svelte";

export type ServerTargetMode = "main" | "test" | "custom";

export interface ServerTargetInfo {
  url: string;
  host: string;
  port: string;
  mode: ServerTargetMode;
  label: string;
  title: string;
}

const DEFAULT_URL = "http://127.0.0.1:4567";

function normalizeUrl(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_URL;
  const trimmed = raw.trim();
  return trimmed ? trimmed.replace(/\/$/, "") : DEFAULT_URL;
}

export function getEffectiveServerUrl(): string {
  return normalizeUrl(store.runtimeServerUrl ?? store.settings.serverUrl);
}

export function getServerTargetInfo(): ServerTargetInfo {
  const url = getEffectiveServerUrl();
  let host = "127.0.0.1";
  let port = "4567";

  try {
    const parsed = new URL(url);
    host = parsed.hostname || host;
    port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {}

  const overrideLabel = typeof store.runtimeServerLabel === "string" && store.runtimeServerLabel.trim()
    ? store.runtimeServerLabel.trim().toUpperCase()
    : null;

  let mode: ServerTargetMode;
  let label: string;

  if (overrideLabel === "MAIN") {
    mode = "main";
    label = "MAIN";
  } else if (overrideLabel === "TEST") {
    mode = "test";
    label = "TEST";
  } else if (port === "4567") {
    mode = "main";
    label = "MAIN";
  } else if (port === "4667") {
    mode = "test";
    label = "TEST";
  } else {
    mode = "custom";
    label = overrideLabel || "CUSTOM";
  }

  return {
    url,
    host,
    port,
    mode,
    label,
    title: `${label} :${port}`,
  };
}
