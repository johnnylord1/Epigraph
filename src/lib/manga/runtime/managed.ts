import {
  getServerAuthHeader,
  getServerUrl,
} from "../../client";
import { assertSuwayomiWritesAllowed } from "../../suwayomiUpdateLock.svelte";
import { createSuwayomiSourceRuntime } from "./factory";
import { SuwayomiTransport } from "./transport";
import type { SourceRuntime } from "./types";

interface CachedRuntime {
  endpoint: string;
  runtime: Promise<SourceRuntime>;
}

let cached: CachedRuntime | null = null;

export function resetManagedSourceRuntime(): void {
  cached = null;
}

export function getManagedSourceRuntime(): Promise<SourceRuntime> {
  const endpoint = `${getServerUrl()}/api/graphql`;
  if (cached?.endpoint === endpoint) return cached.runtime;

  const transport = new SuwayomiTransport({
    endpoint,
    headers: () => {
      const authorization = getServerAuthHeader();
      const headers: Record<string, string> = {};
      if (authorization) headers.Authorization = authorization;
      return headers;
    },
    beforeMutation: assertSuwayomiWritesAllowed,
  });
  const runtime = createSuwayomiSourceRuntime(transport);
  cached = { endpoint, runtime };
  void runtime.catch(() => {
    if (cached?.runtime === runtime) cached = null;
  });
  return runtime;
}
