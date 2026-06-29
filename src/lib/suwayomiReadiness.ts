import { gql } from "./client";

export type SuwayomiReadinessTarget = "graphql" | "extensions" | "sources";

interface ReadinessOptions {
  attempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const READINESS_QUERIES: Record<SuwayomiReadinessTarget, string> = {
  graphql: `query AethonGraphqlReady { __typename }`,
  extensions: `
    query AethonExtensionsReady {
      extensions {
        nodes {
          pkgName
          isInstalled
        }
      }
    }
  `,
  sources: `
    query AethonSourcesReady {
      sources {
        nodes {
          id
          displayName
        }
      }
    }
  `,
};

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export function isTransientSuwayomiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    !message.trim() ||
    normalized.includes("empty graphql error") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("aborted") ||
    normalized.includes("timeout") ||
    normalized.includes("suwayomi http 500") ||
    normalized.includes("database may be already in use") ||
    normalized.includes("file is locked") ||
    normalized.includes("not responding") ||
    normalized.includes("not reachable") ||
    normalized.includes("could not reach")
  );
}

function hasExpectedPayload(target: SuwayomiReadinessTarget, data: any) {
  if (target === "graphql") return data?.__typename === "Query";
  if (target === "extensions") return Array.isArray(data?.extensions?.nodes);
  return Array.isArray(data?.sources?.nodes);
}

export async function waitForSuwayomiGraphqlReady(
  target: SuwayomiReadinessTarget = "graphql",
  options: ReadinessOptions = {},
) {
  const attempts = Math.max(1, options.attempts ?? 8);
  const delayMs = Math.max(100, options.delayMs ?? 700);
  const timeoutMs = Math.max(500, options.timeoutMs ?? 4000);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const data = await gql<any>(READINESS_QUERIES[target], undefined, options.signal, timeoutMs);
      if (hasExpectedPayload(target, data)) return true;
    } catch (error) {
      if (!isTransientSuwayomiError(error) || attempt === attempts - 1) return false;
    }
    if (attempt < attempts - 1) await sleep(delayMs, options.signal);
  }

  return false;
}
