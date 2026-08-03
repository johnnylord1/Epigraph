import { store } from "../store/state.svelte";

const DEFAULT_URL = "http://127.0.0.1:4567";
const RESERVED_TEST_PORT = 4667;

function getServerUrlFromWindow(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.title.match(/\[[^\]]*:(\d{2,5})\]/);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535 || port === RESERVED_TEST_PORT) return null;
  return `http://127.0.0.1:${port}`;
}

function getSavedSettingsServerUrl(): string | null {
  const raw = store.settings.serverUrl;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = raw.replace(/\/$/, "");
  try {
    const parsed = new URL(normalized);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const host = parsed.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (loopback && port === RESERVED_TEST_PORT) return null;
  } catch {}
  return normalized;
}

export function getServerUrl(): string {
  const url = store.runtimeServerUrl
    ?? store.runtimeResolvedLocalProfileMeta?.serverUrl
    ?? getServerUrlFromWindow()
    ?? getSavedSettingsServerUrl();
  return typeof url === "string" && url.trim() ? url.replace(/\/$/, "") : DEFAULT_URL;
}

export function getServerAuthHeader(): string | null {
  const settings = store.settings;
  if (!settings.serverAuthEnabled) return null;
  const user = typeof settings.serverAuthUser === "string" ? settings.serverAuthUser.trim() : "";
  const pass = typeof settings.serverAuthPass === "string" ? settings.serverAuthPass.trim() : "";
  return user && pass ? `Basic ${btoa(`${user}:${pass}`)}` : null;
}

export function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 12000,
): Promise<T> {
  return import("./client").then(({ gql: request }) => request<T>(query, variables, signal, timeoutMs));
}
