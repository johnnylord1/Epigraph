import { store } from "../store/state.svelte";

const DEFAULT_URL = "http://127.0.0.1:4567";

export function getServerUrl(): string {
  const url = store.runtimeServerUrl ?? store.settings.serverUrl;
  return typeof url === "string" && url.trim() ? url.replace(/\/$/, "") : DEFAULT_URL;
}

function getAuthHeader(): Record<string, string> {
  const s = store.settings;
  if (!s.serverAuthEnabled) return {};
  const user = typeof s.serverAuthUser === "string" ? s.serverAuthUser.trim() : "";
  const pass = typeof s.serverAuthPass === "string" ? s.serverAuthPass.trim() : "";
  if (user && pass) return { Authorization: `Basic ${btoa(`${user}:${pass}`)}` };
  return {};
}

function gqlUrl(): string { return `${getServerUrl()}/api/graphql`; }

export function getServerAuthHeader(): string | null {
  return getAuthHeader().Authorization ?? null;
}

export function serverFileUrl(path: string): string {
  if (!path) return getServerUrl();
  if (path.startsWith("http")) return path;
  return `${getServerUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function thumbUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `${getServerUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

interface GQLResponse<T> {
  data: T;
  errors?: { message: string }[];
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  retries = 3,
  delayMs = 300,
): Promise<Response> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  for (let i = 0; i < retries; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    try {
      const res = await fetch(url, { ...init, signal });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return res;
    } catch (e: any) {
      const isAbort = e?.name === "AbortError" || signal?.aborted;
      if (isAbort) throw new DOMException("Aborted", "AbortError");
      if (i === retries - 1) throw e;
      await abortableSleep(delayMs * Math.pow(1.5, i), signal);
    }
  }
  throw new Error("unreachable");
}

export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 12000,
): Promise<T> {
  const controller = signal ? null : new AbortController();
  const effectiveSignal = signal ?? controller?.signal;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    if (controller && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    const res = await fetchWithRetry(gqlUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ query, variables }),
    }, effectiveSignal);

    if (effectiveSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!res.ok) throw new Error(`Suwayomi HTTP ${res.status}`);

    const json: GQLResponse<T> = await res.json();

    if (effectiveSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (json.errors?.length) {
      const message = json.errors.map((error) => error.message?.trim()).filter(Boolean).join("; ");
      throw new Error(message || "Suwayomi returned an empty GraphQL error.");
    }

    return json.data;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function gqlUpload<T>(
  query: string,
  variables: Record<string, unknown>,
  uploads: Record<string, File>,
  signal?: AbortSignal,
): Promise<T> {
  const form = new FormData();
  const map: Record<string, string[]> = {};
  let index = 0;

  for (const [variablePath, file] of Object.entries(uploads)) {
    map[String(index)] = [variablePath];
    index += 1;
  }

  form.append("operations", JSON.stringify({ query, variables }));
  form.append("map", JSON.stringify(map));

  index = 0;
  for (const file of Object.values(uploads)) {
    form.append(String(index), file);
    index += 1;
  }

  const res = await fetchWithRetry(gqlUrl(), {
    method: "POST",
    headers: { ...getAuthHeader() },
    body: form,
  }, signal);

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!res.ok) throw new Error(`Suwayomi HTTP ${res.status}`);

  const json: GQLResponse<T> = await res.json();

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (json.errors?.length) {
    const message = json.errors.map((error) => error.message?.trim()).filter(Boolean).join("; ");
    throw new Error(message || "Suwayomi returned an empty GraphQL error.");
  }

  return json.data;
}
