/**
 * One queue for every AniList request the app makes. AniList allows a few dozen requests a minute
 * (30 while degraded) and answers more with 429s, which the webview reports as network errors
 * because they carry no CORS headers. Feeds that each fire their own burst used up the minute in a
 * few seconds and starved one another. The gate starts requests by priority and never more than the
 * minute allows, shares and caches repeated queries, and retries a request that failed once the
 * minute has passed.
 */

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const WINDOW_MS = 60_000;
const DEFAULT_PER_MINUTE = 30;
// Left unused each minute for requests made outside the gate (another window, a lookup in flight).
const RESERVED_PER_MINUTE = 1;
const MAX_IN_FLIGHT = 4;
const RETRIES_AFTER_FAILURE = 1;
const MEMORY_CACHE_MS = 10 * 60_000;
const PERSIST_STORAGE_KEY = "epigraph.recommendations.anilistCatalog.v1";
const PERSIST_MAX_ENTRIES = 40;
const PERSIST_MAX_AGE_MS = 24 * 60 * 60_000;

/** Lower starts first: what fills the visible rows, then lookups, then extras. */
export const ANILIST_PRIORITY = { feed: 0, lookup: 1, extra: 2 } as const;
export type AniListPriority = (typeof ANILIST_PRIORITY)[keyof typeof ANILIST_PRIORITY];

interface ScheduleOptions {
  priority?: AniListPriority;
  signal?: AbortSignal;
}

interface Job {
  priority: number;
  seq: number;
  attempts: number;
  run: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface GateDeps {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function abortError(): Error {
  return typeof DOMException === "function"
    ? new DOMException("The operation was aborted.", "AbortError")
    : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");
}

function headerNumber(response: Response, name: string): number | null {
  const value = Number(response.headers?.get?.(name) ?? NaN);
  return Number.isFinite(value) ? value : null;
}

export function createAniListGate(deps: GateDeps = {}) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const started: number[] = [];
  const queue: Job[] = [];
  let perMinute = DEFAULT_PER_MINUTE;
  // The fewest requests AniList said were left this minute, and how many started since it said so.
  let remaining: { value: number; at: number; startedAfter: number } | null = null;
  let blockedUntil = 0;
  let inFlight = 0;
  let seq = 0;
  let timer: unknown = null;

  function waitMs(time: number): number {
    while (started.length > 0 && started[0] <= time - WINDOW_MS) started.shift();
    if (remaining && remaining.at <= time - WINDOW_MS) remaining = null;
    if (time < blockedUntil) return blockedUntil - time;
    const windowLeft = perMinute - RESERVED_PER_MINUTE - started.length;
    const headerLeft = remaining ? remaining.value - RESERVED_PER_MINUTE - remaining.startedAfter : Infinity;
    if (windowLeft > 0 && headerLeft > 0) return 0;
    const windowFrees = windowLeft > 0 ? 0 : started[0] + WINDOW_MS - time;
    const headerFrees = headerLeft > 0 || !remaining ? 0 : remaining.at + WINDOW_MS - time;
    return Math.max(1, windowFrees, headerFrees);
  }

  function observe(response: Response) {
    const limit = headerNumber(response, "x-ratelimit-limit");
    if (limit !== null && limit > 0) perMinute = limit;
    const left = headerNumber(response, "x-ratelimit-remaining");
    if (left === null) return;
    const time = now();
    // Responses arrive out of order; the lowest count is the one closest to the truth.
    if (!remaining || left <= remaining.value - remaining.startedAfter) {
      remaining = { value: left, at: time, startedAfter: 0 };
    }
  }

  function block(ms: number) {
    blockedUntil = Math.max(blockedUntil, now() + ms);
  }

  function enqueue(job: Job) {
    const index = queue.findIndex((queued) => queued.priority > job.priority
      || (queued.priority === job.priority && queued.seq > job.seq));
    if (index < 0) queue.push(job);
    else queue.splice(index, 0, job);
  }

  function settle(job: Job) {
    if (job.onAbort) job.signal?.removeEventListener("abort", job.onAbort);
  }

  function retryOrFail(job: Job, error: unknown) {
    if (job.attempts <= RETRIES_AFTER_FAILURE && !job.signal?.aborted) {
      enqueue(job);
      return;
    }
    settle(job);
    job.reject(error);
  }

  function start(job: Job) {
    started.push(now());
    if (remaining) remaining.startedAfter += 1;
    inFlight += 1;
    job.attempts += 1;
    job.run().then((response) => {
      inFlight -= 1;
      observe(response);
      if (response.status === 429) {
        const retryAfter = headerNumber(response, "retry-after");
        block(retryAfter !== null ? retryAfter * 1000 : WINDOW_MS);
        retryOrFail(job, new Error("AniList rate limit (429)"));
      } else {
        settle(job);
        job.resolve(response);
      }
      pump();
    }, (error: unknown) => {
      inFlight -= 1;
      if (isAbortError(error) || job.signal?.aborted) {
        settle(job);
        job.reject(error);
      } else {
        // A 429 without CORS headers reaches here as a network error.
        block(WINDOW_MS);
        retryOrFail(job, error);
      }
      pump();
    });
  }

  function pump() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    while (queue.length > 0 && inFlight < MAX_IN_FLIGHT) {
      const wait = waitMs(now());
      if (wait > 0) {
        timer = setTimer(() => {
          timer = null;
          pump();
        }, wait);
        return;
      }
      start(queue.shift()!);
    }
  }

  /** Runs `run` once AniList's minute allows it; resolves with its response. */
  function schedule(run: () => Promise<Response>, options: ScheduleOptions = {}): Promise<Response> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    return new Promise<Response>((resolve, reject) => {
      const job: Job = {
        priority: options.priority ?? ANILIST_PRIORITY.lookup,
        seq: seq++,
        attempts: 0,
        run,
        resolve,
        reject,
        signal: options.signal,
      };
      if (options.signal) {
        job.onAbort = () => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1);
          settle(job);
          reject(abortError());
          pump();
        };
        options.signal.addEventListener("abort", job.onAbort, { once: true });
      }
      enqueue(job);
      pump();
    });
  }

  return {
    schedule,
    /** Queued requests, for tests and diagnostics. */
    get pending() {
      return queue.length;
    },
  };
}

export type AniListGate = ReturnType<typeof createAniListGate>;

let sharedGate: AniListGate | null = null;

export function aniListGate(): AniListGate {
  sharedGate ??= createAniListGate();
  return sharedGate;
}

/** A fetch for AniList that waits its turn in the shared gate. */
export const gatedAniListFetch: typeof fetch = (input, init) =>
  aniListGate().schedule(() => fetch(input, init), {
    priority: ANILIST_PRIORITY.lookup,
    signal: init?.signal ?? undefined,
  });

type CachedData = { at: number; data: unknown };

const memoryCache = new Map<string, CachedData>();
const inFlightRequests = new Map<string, { promise: Promise<unknown>; waiters: number; controller: AbortController }>();
let persistedCache: Map<string, CachedData> | null = null;

function loadPersistedCache(): Map<string, CachedData> {
  if (persistedCache) return persistedCache;
  persistedCache = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(PERSIST_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") {
      const oldest = Date.now() - PERSIST_MAX_AGE_MS;
      for (const [key, value] of Object.entries(parsed as Record<string, CachedData>)) {
        if (value && typeof value.at === "number" && value.at > oldest && "data" in value) persistedCache.set(key, value);
      }
    }
  } catch {
    // Unreadable cache: start empty and refetch.
  }
  return persistedCache;
}

function persist(key: string, entry: CachedData) {
  const cache = loadPersistedCache();
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > PERSIST_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  try {
    globalThis.localStorage?.setItem(PERSIST_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Storage full or blocked: the memory cache still serves this session.
  }
}

export interface AniListRequestOptions extends ScheduleOptions {
  /** Keep the answer across sessions this long; catalogs change slowly. */
  persistMs?: number;
}

/**
 * The `data` of an AniList GraphQL query, through the shared gate. The same query asked again
 * within a few minutes, or while it is still on its way, is answered once.
 */
export async function requestAniList<T>(
  body: { query: string; variables?: Record<string, unknown> },
  options: AniListRequestOptions = {},
): Promise<T> {
  const key = JSON.stringify(body);
  const time = Date.now();
  const cached = memoryCache.get(key);
  if (cached && time - cached.at < MEMORY_CACHE_MS) return cached.data as T;
  if (options.persistMs) {
    const stored = loadPersistedCache().get(key);
    if (stored && time - stored.at < options.persistMs) {
      memoryCache.set(key, stored);
      return stored.data as T;
    }
  }
  if (options.signal?.aborted) throw abortError();

  let shared = inFlightRequests.get(key);
  if (!shared) {
    const controller = new AbortController();
    const promise = aniListGate().schedule(() => fetch(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: key,
      signal: controller.signal,
    }), { priority: options.priority, signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`AniList request failed (${response.status})`);
      const payload = await response.json() as { data?: unknown; errors?: unknown };
      if (!payload?.data) throw new Error("AniList returned no data");
      const entry = { at: Date.now(), data: payload.data };
      memoryCache.set(key, entry);
      if (options.persistMs) persist(key, entry);
      return payload.data;
    }).finally(() => {
      inFlightRequests.delete(key);
    });
    shared = { promise, waiters: 0, controller };
    inFlightRequests.set(key, shared);
  }

  // Each caller can stop waiting; the request itself is dropped only when nobody waits for it.
  const entry = shared;
  entry.waiters += 1;
  const signal = options.signal;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      entry.promise.then((data) => resolve(data as T), reject);
      if (signal) {
        onAbort = () => {
          reject(abortError());
          if (entry.waiters <= 1) entry.controller.abort();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  } finally {
    entry.waiters -= 1;
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Test hook: forget cached answers and the shared gate. */
export function resetAniListGateForTests() {
  sharedGate = null;
  memoryCache.clear();
  inFlightRequests.clear();
  persistedCache = null;
}
