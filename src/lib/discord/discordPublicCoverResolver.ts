import { canResolveDiscordCover, canRunDiscordCoverImprovement } from "./coverImprovementGate";
import { isDiscordPublicImageUrl, normalizeDiscordCoverImage } from "./coverResolver";
import type { DiscordCoverCacheStorage, DiscordCoverSource, DiscordCoverWorkKind } from "./discordCoverService";
import type { DiscordPrivacySettings } from "./types";

export const DISCORD_PUBLIC_COVER_RESOLVER_VERSION = "tracker-cover-first-v6";
export const DISCORD_PUBLIC_COVER_CACHE_TTL_MS = 70 * 60 * 60 * 1000;
export const DISCORD_PUBLIC_WORKER_COVER_CACHE_TTL_MS = 2 * 60 * 60 * 1000 + 45 * 60 * 1000;

const CACHE_PREFIX = `epigraph.discord.publicCover.${DISCORD_PUBLIC_COVER_RESOLVER_VERSION}.`;

export type DiscordPublicCoverSource = "existing" | "tracker" | "worker";

export interface DiscordPublicCoverResult {
  url: string;
  source: DiscordPublicCoverSource;
}

export interface ResolveDiscordPublicCoverInput {
  settings: Partial<DiscordPrivacySettings>;
  workKind: DiscordCoverWorkKind;
  workId: string | number;
  existingPublicCoverUrl?: string | null;
  trackerKey?: string | null;
  resolveTrackerCover?: (() => Promise<string | null | undefined> | string | null | undefined) | null;
  workerSource?: DiscordCoverSource | null;
  resolveWorkerCover?: ((source: DiscordCoverSource) => Promise<string | null | undefined>) | null;
}

interface PublicCoverCacheEntry {
  url: string;
  source: DiscordPublicCoverSource;
  expiresAt: number;
}

interface DiscordPublicCoverResolverOptions {
  now?: () => number;
  storage?: DiscordCoverCacheStorage | null;
}

export interface DiscordPublicCoverFingerprintInput {
  workKind: DiscordCoverWorkKind;
  workId: string | number;
  existingPublicCoverUrl?: string | null;
  trackerKey?: string | null;
  workerSource?: DiscordCoverSource | null;
  version?: string;
}

function defaultStorage(): DiscordCoverCacheStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fallbackHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(input);
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

function normalizePublicCoverUrl(url: string | null | undefined): string | null {
  return isDiscordPublicImageUrl(url) ? normalizeDiscordCoverImage(String(url).trim()) : null;
}

function normalizeWorkId(workId: string | number): string | null {
  const normalized = String(workId).trim();
  return normalized || null;
}

function sourceFingerprintInput(source: DiscordCoverSource | null | undefined): Record<string, unknown> | null {
  const value = typeof source?.value === "string" ? source.value.trim() : "";
  if (!source || !value) return null;
  return {
    type: source.type,
    value,
    trustedLocalBaseUrl: source.type === "trusted-thumbnail" ? source.trustedLocalBaseUrl ?? null : null,
    hasAuthHeader: source.type === "trusted-thumbnail" ? Boolean(source.authHeader) : false,
  };
}

function canUseWorkerSource(source: DiscordCoverSource | null | undefined): source is DiscordCoverSource {
  const value = typeof source?.value === "string" ? source.value.trim() : "";
  if (!source || !value) return false;
  return source.type !== "public-url" || isDiscordPublicImageUrl(value);
}

export async function createDiscordPublicCoverFingerprint(input: DiscordPublicCoverFingerprintInput): Promise<string> {
  const workId = normalizeWorkId(input.workId);
  if (!workId) return "";
  return sha256Hex(JSON.stringify({
    version: input.version ?? DISCORD_PUBLIC_COVER_RESOLVER_VERSION,
    kind: input.workKind,
    id: workId,
    existing: normalizePublicCoverUrl(input.existingPublicCoverUrl),
    trackerKey: input.trackerKey ?? null,
    workerSource: sourceFingerprintInput(input.workerSource),
  }));
}

function parseCacheEntry(value: string | null, now: number): PublicCoverCacheEntry | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PublicCoverCacheEntry>;
    if (!parsed || typeof parsed.url !== "string" || typeof parsed.expiresAt !== "number") return null;
    if (parsed.source !== "existing" && parsed.source !== "tracker" && parsed.source !== "worker") return null;
    const url = normalizePublicCoverUrl(parsed.url);
    if (!url || parsed.expiresAt <= now) return null;
    return { url, source: parsed.source, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export class DiscordPublicCoverResolver {
  private readonly now: () => number;
  private readonly storage: DiscordCoverCacheStorage | null;
  private readonly inFlight = new Map<string, Promise<DiscordPublicCoverResult | null>>();

  constructor(options: DiscordPublicCoverResolverOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
  }

  async resolve(input: ResolveDiscordPublicCoverInput): Promise<DiscordPublicCoverResult | null> {
    if (!canResolveDiscordCover(input.settings)) return null;

    const workId = normalizeWorkId(input.workId);
    if (!workId) return null;
    const canUseWorker = canRunDiscordCoverImprovement(input.settings);

    const fingerprint = await createDiscordPublicCoverFingerprint({
      workKind: input.workKind,
      workId,
      existingPublicCoverUrl: input.existingPublicCoverUrl,
      trackerKey: input.resolveTrackerCover ? input.trackerKey ?? "tracker" : null,
      workerSource: canUseWorker ? input.workerSource : null,
    });
    const cacheKey = `${CACHE_PREFIX}${fingerprint}`;
    const now = this.now();
    const cached = parseCacheEntry(this.storage?.getItem(cacheKey) ?? null, now);
    if (cached) return { url: cached.url, source: cached.source };
    if (this.storage) this.storage.removeItem(cacheKey);

    const active = this.inFlight.get(fingerprint);
    if (active) return active;

    const task = this.resolveFresh(input, cacheKey, canUseWorker).finally(() => {
      this.inFlight.delete(fingerprint);
    });
    this.inFlight.set(fingerprint, task);
    return task;
  }

  private async resolveFresh(
    input: ResolveDiscordPublicCoverInput,
    cacheKey: string,
    canUseWorker: boolean,
  ): Promise<DiscordPublicCoverResult | null> {
    const existing = normalizePublicCoverUrl(input.existingPublicCoverUrl);
    if (existing) return { url: existing, source: "existing" };

    if (input.resolveTrackerCover) {
      try {
        const tracker = normalizePublicCoverUrl(await input.resolveTrackerCover());
        if (tracker) return this.store(cacheKey, { url: tracker, source: "tracker" });
      } catch {}
    }

    if (canUseWorker && canUseWorkerSource(input.workerSource) && input.resolveWorkerCover) {
      try {
        const worker = normalizePublicCoverUrl(await input.resolveWorkerCover(input.workerSource));
        if (worker) return this.store(cacheKey, { url: worker, source: "worker" });
      } catch {}
    }

    return null;
  }

  private store(cacheKey: string, result: DiscordPublicCoverResult): DiscordPublicCoverResult {
    const ttl = result.source === "worker"
      ? DISCORD_PUBLIC_WORKER_COVER_CACHE_TTL_MS
      : DISCORD_PUBLIC_COVER_CACHE_TTL_MS;
    const expiresAt = this.now() + ttl;
    this.storage?.setItem(cacheKey, JSON.stringify({
      url: result.url,
      source: result.source,
      expiresAt,
    }));
    return result;
  }
}

export const discordPublicCoverResolver = new DiscordPublicCoverResolver();
