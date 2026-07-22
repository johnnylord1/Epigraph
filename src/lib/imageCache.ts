import type { Action } from "svelte/action";
import { getServerAuthHeader, getServerUrl } from "./client";
import {
  IMAGE_CACHE_MAX_BYTES,
  IMAGE_CACHE_MAX_ENTRIES,
  registerImageCacheStatsReader,
  registerImageCacheTrim,
  type ImageCacheStats,
} from "./imageCacheMetrics";
import { traceMediaAudit } from "./mediaAudit";

type HttpModule = typeof import("@tauri-apps/plugin-http");

const MAX_CONCURRENT_FETCHES = 6;

type MediaAuditEvent = {
  event: string;
  url?: string;
  origin?: string;
  resultProtocol?: string;
  transport?: string;
  authHeaderAttached?: boolean;
  urlContainsCredentials?: boolean;
  cacheHit?: boolean;
  priorityIndex?: number;
  count?: number;
  status?: number;
  error?: string;
};

type CacheEntry = {
  key: string;
  sourceUrl: string;
  blobUrl: string;
  sizeBytes: number;
  refCount: number;
  lastAccess: number;
};

export type ResolvedMediaLease = {
  resolvedUrl: string;
  release: () => void;
};

export { getImageCacheStats, type ImageCacheStats } from "./imageCacheMetrics";

const blobCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();
const fetchQueue: Array<() => void> = [];

let httpModulePromise: Promise<HttpModule> | null = null;
let accessClock = 0;
let totalCachedBytes = 0;
let activeFetches = 0;

function describeUrl(url: string): Pick<MediaAuditEvent, "url" | "origin" | "urlContainsCredentials"> {
  try {
    const parsed = new URL(url);
    return {
      url: `${parsed.origin}${parsed.pathname}`,
      origin: parsed.origin,
      urlContainsCredentials: Boolean(parsed.username || parsed.password),
    };
  } catch {
    return { url, urlContainsCredentials: false };
  }
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildCacheKey(url: string, authHeader: string): string {
  return `${authHeader}::${url}`;
}

function touchEntry(entry: CacheEntry): void {
  entry.lastAccess = ++accessClock;
}

function revokeEntry(entry: CacheEntry): void {
  URL.revokeObjectURL(entry.blobUrl);
  totalCachedBytes = Math.max(0, totalCachedBytes - entry.sizeBytes);
  blobCache.delete(entry.key);
}

function evictInactiveEntries(forceAll = false): void {
  const candidates = [...blobCache.values()]
    .filter((entry) => entry.refCount === 0)
    .sort((left, right) => left.lastAccess - right.lastAccess);

  const shouldContinue = () =>
    forceAll || blobCache.size > IMAGE_CACHE_MAX_ENTRIES || totalCachedBytes > IMAGE_CACHE_MAX_BYTES;

  while (candidates.length && shouldContinue()) {
    const next = candidates.shift();
    if (!next) break;
    const liveEntry = blobCache.get(next.key);
    if (!liveEntry || liveEntry.refCount !== 0) continue;
    revokeEntry(liveEntry);
  }
}

function scheduleFetch<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeFetches += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          activeFetches = Math.max(0, activeFetches - 1);
          fetchQueue.shift()?.();
        });
    };

    if (activeFetches < MAX_CONCURRENT_FETCHES) {
      run();
    } else {
      fetchQueue.push(run);
    }
  });
}

async function getHttpModule(): Promise<HttpModule> {
  httpModulePromise ??= import("@tauri-apps/plugin-http");
  return httpModulePromise;
}

function fetchWithTimeout(
  fetchFn: typeof import("@tauri-apps/plugin-http").fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 60000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetchFn(url, { ...init, signal: controller.signal })
    .then((res) => {
      clearTimeout(timer);
      return res;
    })
    .catch((err) => {
      clearTimeout(timer);
      throw err;
    });
}

async function ensureResolvedBlobEntry(url: string): Promise<CacheEntry> {
  const authHeader = getServerAuthHeader();
  if (!authHeader) {
    throw new Error("Authenticated media fetch requires a server auth header.");
  }

  const key = buildCacheKey(url, authHeader);
  const cached = blobCache.get(key);
  if (cached) {
    touchEntry(cached);
    traceMediaAudit({
      event: "auth.cache.hit",
      ...describeUrl(url),
      resultProtocol: protocolOf(cached.blobUrl),
      cacheHit: true,
    });
    return cached;
  }

  const active = inflight.get(key);
  if (active) {
    traceMediaAudit({
      event: "auth.fetch.inflight",
      ...describeUrl(url),
      transport: "tauri-plugin-http.fetch",
      authHeaderAttached: true,
    });
    return active;
  }

  traceMediaAudit({
    event: "auth.fetch.start",
    ...describeUrl(url),
    transport: "tauri-plugin-http.fetch",
    authHeaderAttached: true,
  });

  const request = scheduleFetch(() => getHttpModule()
    .then(({ fetch }) =>
      fetchWithTimeout(fetch, url, {
        headers: {
          Authorization: authHeader,
        },
      })))
    .then(async (response) => {
      if (!response.ok) {
        traceMediaAudit({
          event: "auth.fetch.error",
          ...describeUrl(url),
          transport: "tauri-plugin-http.fetch",
          authHeaderAttached: true,
          status: response.status,
        });
        throw new Error(`Media HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const entry: CacheEntry = {
        key,
        sourceUrl: url,
        blobUrl: URL.createObjectURL(blob),
        sizeBytes: blob.size,
        refCount: 0,
        lastAccess: 0,
      };
      touchEntry(entry);
      blobCache.set(key, entry);
      totalCachedBytes += entry.sizeBytes;
      evictInactiveEntries();
      traceMediaAudit({
        event: "auth.fetch.ok",
        ...describeUrl(url),
        resultProtocol: protocolOf(entry.blobUrl),
        transport: "tauri-plugin-http.fetch",
        authHeaderAttached: true,
        status: response.status,
      });
      return entry;
    })
    .catch((error) => {
      traceMediaAudit({
        event: "auth.fetch.exception",
        ...describeUrl(url),
        transport: "tauri-plugin-http.fetch",
        authHeaderAttached: true,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

export function requiresAuthenticatedMediaFetch(url: string | null | undefined): boolean {
  if (!url || !isHttpUrl(url)) return false;

  const authHeader = getServerAuthHeader();
  if (!authHeader) return false;

  try {
    const mediaUrl = new URL(url);
    const serverUrl = new URL(getServerUrl());
    return mediaUrl.origin === serverUrl.origin;
  } catch {
    return false;
  }
}

export async function acquireResolvedMediaUrl(url: string): Promise<ResolvedMediaLease> {
  if (!requiresAuthenticatedMediaFetch(url)) {
    return {
      resolvedUrl: url,
      release: () => {},
    };
  }

  const entry = await ensureResolvedBlobEntry(url);
  entry.refCount += 1;
  touchEntry(entry);

  let released = false;
  return {
    resolvedUrl: entry.blobUrl,
    release: () => {
      if (released) return;
      released = true;
      releaseResolvedMediaUrl(url);
    },
  };
}

export function acquireCachedResolvedMediaUrl(url: string): ResolvedMediaLease | null {
  if (!requiresAuthenticatedMediaFetch(url)) {
    return {
      resolvedUrl: url,
      release: () => {},
    };
  }

  const authHeader = getServerAuthHeader();
  if (!authHeader) return null;

  const entry = blobCache.get(buildCacheKey(url, authHeader));
  if (!entry) return null;

  entry.refCount += 1;
  touchEntry(entry);
  traceMediaAudit({
    event: "auth.cache.sync.hit",
    ...describeUrl(url),
    resultProtocol: protocolOf(entry.blobUrl),
    cacheHit: true,
  });

  let released = false;
  return {
    resolvedUrl: entry.blobUrl,
    release: () => {
      if (released) return;
      released = true;
      releaseResolvedMediaUrl(url);
    },
  };
}

export async function warmResolvedMediaUrl(url: string): Promise<void> {
  if (!requiresAuthenticatedMediaFetch(url)) return;
  await ensureResolvedBlobEntry(url);
}

export function releaseResolvedMediaUrl(url: string): void {
  if (!requiresAuthenticatedMediaFetch(url)) return;

  const authHeader = getServerAuthHeader();
  if (!authHeader) return;

  const entry = blobCache.get(buildCacheKey(url, authHeader));
  if (!entry) return;
  entry.refCount = Math.max(0, entry.refCount - 1);
  touchEntry(entry);
  evictInactiveEntries();
}

export async function getResolvedMediaUrl(url: string): Promise<string> {
  const lease = await acquireResolvedMediaUrl(url);
  const resolvedUrl = lease.resolvedUrl;
  lease.release();
  return resolvedUrl;
}

export async function preloadBlobUrls(urls: string[], priorityIndex = 0): Promise<string[]> {
  const unique = Array.from(new Set(urls.filter(Boolean)));
  if (unique.length === 0) return [];

  const clampedIndex = Math.max(0, Math.min(unique.length - 1, priorityIndex));
  const priorityUrl = unique[clampedIndex];
  traceMediaAudit({
    event: "auth.preload.priority",
    ...describeUrl(priorityUrl),
    priorityIndex: clampedIndex,
    count: unique.length,
  });
  await warmResolvedMediaUrl(priorityUrl).catch(() => {});

  const remaining = unique.filter((candidate) => candidate !== priorityUrl);
  await Promise.all(remaining.map((candidate) => warmResolvedMediaUrl(candidate).catch(() => {})));

  return Promise.all(unique.map((candidate) => getResolvedMediaUrl(candidate).catch(() => candidate)));
}

export function resetImageCache(): void {
  inflight.clear();
  for (const entry of blobCache.values()) {
    URL.revokeObjectURL(entry.blobUrl);
  }
  blobCache.clear();
  totalCachedBytes = 0;
}

export function trimImageCache(forceAll = false): void {
  evictInactiveEntries(forceAll);
}

function readImageCacheStats(): ImageCacheStats {
  let activeLeaseCount = 0;
  for (const entry of blobCache.values()) {
    activeLeaseCount += entry.refCount;
  }

  return {
    entryCount: blobCache.size,
    inflightCount: inflight.size,
    totalCachedBytes,
    activeLeaseCount,
    maxEntries: IMAGE_CACHE_MAX_ENTRIES,
    maxBytes: IMAGE_CACHE_MAX_BYTES,
  };
}

registerImageCacheStatsReader(readImageCacheStats);
registerImageCacheTrim(trimImageCache);

export const resolvedImage: Action<HTMLImageElement, string | null | undefined> = (node, initialUrl) => {
  let requestToken = 0;
  let currentRelease: (() => void) | null = null;
  let currentInputUrl = "";
  let currentResolvedUrl = "";
  let failedInputUrl = "";

  const releaseCurrent = () => {
    currentRelease?.();
    currentRelease = null;
  };

  const rememberFailedInput = () => {
    if (currentInputUrl) failedInputUrl = currentInputUrl;
  };

  node.addEventListener?.("error", rememberFailedInput);

  const applyUrl = async (nextUrl: string | null | undefined) => {
    const token = ++requestToken;
    const candidate = nextUrl ?? "";

    if (candidate && candidate === currentInputUrl && candidate === failedInputUrl) {
      return;
    }

    if (candidate && candidate === currentInputUrl && node.src === currentResolvedUrl) {
      return;
    }

    if (candidate !== currentInputUrl) {
      failedInputUrl = "";
    }

    currentInputUrl = candidate;
    releaseCurrent();

    if (!candidate) {
      currentResolvedUrl = "";
      node.removeAttribute("src");
      return;
    }

    const cachedLease = acquireCachedResolvedMediaUrl(candidate);
    if (cachedLease) {
      currentRelease = cachedLease.release;
      currentResolvedUrl = cachedLease.resolvedUrl;
      if (node.src !== cachedLease.resolvedUrl) {
        node.src = cachedLease.resolvedUrl;
      }
      return;
    }

    try {
      const lease = await acquireResolvedMediaUrl(candidate);
      if (token !== requestToken) {
        lease.release();
        return;
      }

      currentRelease = lease.release;
      if (!requiresAuthenticatedMediaFetch(candidate)) {
        traceMediaAudit({
          event: "direct.src.applied",
          ...describeUrl(candidate),
          resultProtocol: protocolOf(lease.resolvedUrl),
          authHeaderAttached: false,
        });
      } else {
        traceMediaAudit({
          event: "auth.blob.src.applied",
          ...describeUrl(candidate),
          resultProtocol: protocolOf(lease.resolvedUrl),
          transport: "tauri-plugin-http.fetch",
          authHeaderAttached: true,
        });
      }
      currentResolvedUrl = lease.resolvedUrl;
      node.src = lease.resolvedUrl;
    } catch {
      if (token === requestToken) {
        traceMediaAudit({
          event: "auth.blob.src.fallback",
          ...describeUrl(candidate),
          resultProtocol: protocolOf(candidate),
          authHeaderAttached: false,
        });
        currentResolvedUrl = candidate;
        node.src = candidate;
      }
    }
  };

  void applyUrl(initialUrl);

  return {
    update(nextUrl) {
      void applyUrl(nextUrl);
    },
    destroy() {
      requestToken += 1;
      node.removeEventListener?.("error", rememberFailedInput);
      releaseCurrent();
    },
  };
};
