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
  expiresAt: number;
  runtime: Promise<SourceRuntime>;
}

export const MANAGED_RUNTIME_CACHE_TTL_MS = 30_000;

export class ManagedSourceRuntimeCache {
  private cached: CachedRuntime | null = null;

  constructor(
    private readonly createRuntime: (endpoint: string) => Promise<SourceRuntime>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = MANAGED_RUNTIME_CACHE_TTL_MS,
  ) {}

  reset(): void {
    this.cached = null;
  }

  get(endpoint: string): Promise<SourceRuntime> {
    const now = this.now();
    if (this.cached?.endpoint === endpoint && now < this.cached.expiresAt) {
      return this.cached.runtime;
    }

    const runtime = this.createRuntime(endpoint);
    const entry = {
      endpoint,
      expiresAt: now + this.ttlMs,
      runtime,
    };
    this.cached = entry;
    void runtime.catch(() => {
      if (this.cached === entry) this.cached = null;
    });
    return runtime;
  }
}

const managedRuntimeCache = new ManagedSourceRuntimeCache((endpoint) => {
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
  return createSuwayomiSourceRuntime(transport);
});

export function resetManagedSourceRuntime(): void {
  managedRuntimeCache.reset();
}

export function getManagedSourceRuntime(): Promise<SourceRuntime> {
  const endpoint = `${getServerUrl()}/api/graphql`;
  return managedRuntimeCache.get(endpoint);
}
