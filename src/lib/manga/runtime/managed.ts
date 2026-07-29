import {
  getServerAuthHeader,
  getServerUrl,
} from "../../client";
import {
  acquireSuwayomiOperationLease,
  assertSuwayomiWritesAllowed,
} from "../../suwayomiUpdateLock.svelte";
import { createSuwayomiSourceRuntime } from "./factory";
import { SuwayomiTransport } from "./transport";
import type { SourceRuntime } from "./types";

interface CachedRuntime {
  endpoint: string;
  generation: number;
  expiresAt: number;
  runtime: Promise<SourceRuntime>;
}

export const MANAGED_RUNTIME_CACHE_TTL_MS = 30_000;

export class ManagedSourceRuntimeCache {
  private cached: CachedRuntime | null = null;
  private generation = 0;

  constructor(
    private readonly createRuntime: (endpoint: string, generation: number) => Promise<SourceRuntime>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = MANAGED_RUNTIME_CACHE_TTL_MS,
  ) {}

  reset(): void {
    this.generation += 1;
    this.cached = null;
  }

  get(endpoint: string): Promise<SourceRuntime> {
    const now = this.now();
    if (
      this.cached?.endpoint === endpoint
      && this.cached.generation === this.generation
      && now < this.cached.expiresAt
    ) {
      return this.cached.runtime;
    }

    const runtime = this.createRuntime(endpoint, this.generation);
    const entry = {
      endpoint,
      generation: this.generation,
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

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

const managedRuntimeCache = new ManagedSourceRuntimeCache((endpoint, generation) => {
  const transport = new SuwayomiTransport({
    endpoint,
    headers: () => {
      const authorization = getServerAuthHeader();
      const headers: Record<string, string> = {};
      if (authorization) headers.Authorization = authorization;
      return headers;
    },
    beforeMutation: assertSuwayomiWritesAllowed,
    beginMutationLease: () => acquireSuwayomiOperationLease("mutation"),
  });
  return createSuwayomiSourceRuntime(transport, {
    endpointIdentity: transport.getEndpointIdentity(),
    localRuntimeGeneration: isLoopbackEndpoint(endpoint) ? String(generation) : null,
  });
});

export function resetManagedSourceRuntime(): void {
  managedRuntimeCache.reset();
}

export function getManagedSourceRuntime(): Promise<SourceRuntime> {
  const endpoint = `${getServerUrl()}/api/graphql`;
  return managedRuntimeCache.get(endpoint);
}
