import { acquireSuwayomiOperationLease } from "./suwayomiUpdateLock.svelte";
import { store } from "../store/state.svelte";
import { translate } from "./i18n/runtime";
import {
  getServerAuthHeader,
  getServerUrl,
} from "./startupClient";
import { serverFileUrl, thumbUrl } from "./clientUrls";

export { getServerAuthHeader, getServerUrl } from "./startupClient";
export { serverFileUrl, thumbUrl } from "./clientUrls";

export function isGraphqlMutation(query: string): boolean {
  let index = 0;
  while (index < query.length) {
    const char = query[index];
    if (char === "#") {
      const nextLine = query.indexOf("\n", index + 1);
      index = nextLine === -1 ? query.length : nextLine + 1;
      continue;
    }
    if (char === "," || /\s/.test(char)) {
      index += 1;
      continue;
    }
    break;
  }
  return query.slice(index, index + 8).toLowerCase() === "mutation"
    && !/[A-Za-z0-9_]/.test(query[index + 8] ?? "");
}

function gqlUrl(): string {
  return `${getServerUrl()}/api/graphql`;
}

function captureRequestContext() {
  const url = gqlUrl();
  const authHeader = getServerAuthHeader();
  const profileId = store.runtimeResolvedLocalProfileId;
  return {
    url,
    authHeader,
    assertCurrent() {
      if (url !== gqlUrl() || authHeader !== getServerAuthHeader() || profileId !== store.runtimeResolvedLocalProfileId) {
        throw new Error(translate("errors.connectionChanged"));
      }
    },
  };
}

interface GQLResponse<T> {
  data: T;
  errors?: { message: string }[];
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export async function fetchWithRetry(
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
      const response = await fetch(url, { ...init, signal });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return response;
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError" || signal?.aborted;
      if (isAbort) throw new DOMException("Aborted", "AbortError");
      if (i === retries - 1) throw error;
      await abortableSleep(delayMs * Math.pow(1.5, i), signal);
    }
  }
  throw new Error("unreachable");
}

const DEFAULT_GQL_TIMEOUT_MS = 12000;

/**
 * Without a caller signal the request is bounded by the default timeout. A caller signal keeps
 * ownership of cancellation and disables the default, but an explicit `timeoutMs` is always
 * honoured: readiness probes pass both and must not hang on a JVM that accepts the connection
 * without answering.
 */
export function resolveGqlTimeoutMs(signal: AbortSignal | undefined, timeoutMs: number | undefined): number | null {
  const effective = timeoutMs ?? (signal ? null : DEFAULT_GQL_TIMEOUT_MS);
  return effective !== null && Number.isFinite(effective) && effective > 0 ? effective : null;
}

export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const context = captureRequestContext();
  const mutation = isGraphqlMutation(query);
  const releaseMutationLease = mutation
    ? await acquireSuwayomiOperationLease("mutation")
    : null;
  const requestTimeoutMs = resolveGqlTimeoutMs(signal, timeoutMs);
  const controller = requestTimeoutMs === null ? null : new AbortController();
  const forwardCallerAbort = () => controller?.abort();
  if (controller && signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardCallerAbort, { once: true });
  }
  const effectiveSignal = controller?.signal ?? signal;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    context.assertCurrent();
    if (controller && requestTimeoutMs !== null) {
      timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
    }
    const { authHeader } = context;
    const response = await fetchWithRetry(context.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeader ? { Authorization: authHeader } : {}) },
      body: JSON.stringify({ query, variables }),
    }, effectiveSignal, mutation ? 1 : 3);
    if (effectiveSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!response.ok) throw new Error(`Suwayomi HTTP ${response.status}`);

    const json = await response.json() as GQLResponse<T>;
    if (effectiveSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (json.errors?.length) {
      const message = json.errors.map((error) => error.message?.trim()).filter(Boolean).join("; ");
      throw new Error(message || "Suwayomi returned an empty GraphQL error.");
    }
    return json.data;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", forwardCallerAbort);
    await releaseMutationLease?.();
  }
}

export async function gqlUpload<T>(
  query: string,
  variables: Record<string, unknown>,
  uploads: Record<string, File>,
  signal?: AbortSignal,
): Promise<T> {
  const context = captureRequestContext();
  const mutation = isGraphqlMutation(query);
  const releaseMutationLease = mutation
    ? await acquireSuwayomiOperationLease("mutation")
    : null;

  const form = new FormData();
  const map: Record<string, string[]> = {};
  let index = 0;

  for (const [variablePath] of Object.entries(uploads)) {
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

  try {
    context.assertCurrent();
    const { authHeader } = context;
    const response = await fetchWithRetry(context.url, {
      method: "POST",
      headers: authHeader ? { Authorization: authHeader } : {},
      body: form,
    }, signal, mutation ? 1 : 3);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!response.ok) throw new Error(`Suwayomi HTTP ${response.status}`);

    const json = await response.json() as GQLResponse<T>;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (json.errors?.length) {
      const message = json.errors.map((error) => error.message?.trim()).filter(Boolean).join("; ");
      throw new Error(message || "Suwayomi returned an empty GraphQL error.");
    }
    return json.data;
  } finally {
    await releaseMutationLease?.();
  }
}
