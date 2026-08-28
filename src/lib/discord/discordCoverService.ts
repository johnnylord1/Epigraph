import { isDiscordPublicImageUrl, normalizeDiscordCoverImage } from "./coverResolver";
import { canRunDiscordCoverImprovement } from "./coverImprovementGate";
import type { DiscordPrivacySettings } from "./types";

export const DISCORD_COVER_COMPOSITOR_VERSION = "cover-compositor-v9";
export const DISCORD_COVER_CACHE_TTL_MS = 70 * 60 * 60 * 1000;

const CACHE_PREFIX = `epigraph.discord.optimizedCover.${DISCORD_COVER_COMPOSITOR_VERSION}.`;

export type DiscordCoverWorkKind = "comic" | "book" | "novel";
export type DiscordCoverSource =
  | { type: "public-url"; value: string | null | undefined }
  | { type: "trusted-local-path"; value: string | null | undefined }
  | {
      type: "trusted-thumbnail";
      value: string | null | undefined;
      trustedLocalBaseUrl?: string | null | undefined;
      authHeader?: string | null | undefined;
    };

export interface ResolveOptimizedDiscordCoverInput {
  settings: Partial<DiscordPrivacySettings>;
  workKind: DiscordCoverWorkKind;
  workId: string | number;
  source: DiscordCoverSource;
}

interface NormalizedDiscordCoverSource {
  type: DiscordCoverSource["type"];
  value: string;
  trustedLocalBaseUrl?: string | null;
  authHeader?: string | null;
}

export interface DiscordCoverProcessorInput {
  workKind: DiscordCoverWorkKind;
  workId: string;
  fingerprint: string;
  algorithmVersion: string;
  source: NormalizedDiscordCoverSource;
}

export type DiscordCoverProcessorResult =
  | string
  | { url: string | null | undefined; expiresAt?: number | null }
  | null
  | undefined;

export type DiscordCoverProcessor = (input: DiscordCoverProcessorInput) => Promise<DiscordCoverProcessorResult>;

export interface DiscordCoverCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DiscordCoverServiceOptions {
  now?: () => number;
  storage?: DiscordCoverCacheStorage | null;
  processor?: DiscordCoverProcessor | null;
}

interface OptimizeDiscordCoverResponse {
  url: string;
  expiresAt?: number | null;
}

interface OptimizedCoverCacheEntry {
  url: string;
  expiresAt: number;
}

interface DiscordCoverFingerprintInput {
  workKind: DiscordCoverWorkKind;
  workId: string;
  source: NormalizedDiscordCoverSource;
  algorithmVersion?: string;
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

function normalizeSource(source: DiscordCoverSource): NormalizedDiscordCoverSource | null {
  const value = typeof source.value === "string" ? source.value.trim() : "";
  if (!value) return null;

  if (source.type === "public-url") {
    return isDiscordPublicImageUrl(value)
      ? { type: source.type, value: normalizeDiscordCoverImage(value) }
      : null;
  }

  if (source.type === "trusted-thumbnail") {
    return {
      type: source.type,
      value,
      trustedLocalBaseUrl: source.trustedLocalBaseUrl ?? null,
      authHeader: source.authHeader ?? null,
    };
  }

  return { type: source.type, value };
}

async function tauriDiscordCoverProcessor(input: DiscordCoverProcessorInput): Promise<DiscordCoverProcessorResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const source = input.source;
  const request = {
    sourceUrl: source.type === "public-url" || source.type === "trusted-thumbnail" ? source.value : null,
    localPath: source.type === "trusted-local-path" ? source.value : null,
    trustedLocalBaseUrl: source.type === "trusted-thumbnail"
      ? source.trustedLocalBaseUrl ?? null
      : null,
    authHeader: source.type === "trusted-thumbnail"
      ? source.authHeader ?? null
      : null,
  };
  const response = await invoke<OptimizeDiscordCoverResponse>("optimize_discord_cover", { input: request });
  return { url: response.url, expiresAt: response.expiresAt ?? null };
}

export async function createDiscordCoverFingerprint(input: DiscordCoverFingerprintInput): Promise<string> {
  return sha256Hex(JSON.stringify({
    version: input.algorithmVersion ?? DISCORD_COVER_COMPOSITOR_VERSION,
    kind: input.workKind,
    id: input.workId,
    sourceType: input.source.type,
    source: input.source.value,
  }));
}

function parseCacheEntry(value: string | null, now: number): OptimizedCoverCacheEntry | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<OptimizedCoverCacheEntry>;
    if (!parsed || typeof parsed.url !== "string" || typeof parsed.expiresAt !== "number") return null;
    if (!isDiscordPublicImageUrl(parsed.url)) return null;
    if (parsed.expiresAt <= now) return null;
    return { url: parsed.url, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function normalizeProcessorResult(result: DiscordCoverProcessorResult): { url: string; expiresAt?: number | null } | null {
  if (typeof result === "string") {
    return isDiscordPublicImageUrl(result) ? { url: normalizeDiscordCoverImage(result) } : null;
  }
  if (!result || typeof result.url !== "string" || !isDiscordPublicImageUrl(result.url)) return null;
  return {
    url: normalizeDiscordCoverImage(result.url),
    expiresAt: typeof result.expiresAt === "number" ? result.expiresAt : null,
  };
}

export class DiscordCoverService {
  private readonly now: () => number;
  private readonly storage: DiscordCoverCacheStorage | null;
  private readonly processor: DiscordCoverProcessor | null;
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(options: DiscordCoverServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.processor = options.processor ?? tauriDiscordCoverProcessor;
  }

  async resolveOptimizedCover(input: ResolveOptimizedDiscordCoverInput): Promise<string | null> {
    if (!canRunDiscordCoverImprovement(input.settings)) return null;

    const source = normalizeSource(input.source);
    if (!source) return null;

    const workId = String(input.workId).trim();
    if (!workId) return null;

    const fingerprint = await createDiscordCoverFingerprint({
      workKind: input.workKind,
      workId,
      source,
    });
    const cacheKey = `${CACHE_PREFIX}${fingerprint}`;
    const now = this.now();
    const cached = parseCacheEntry(this.storage?.getItem(cacheKey) ?? null, now);
    if (cached) return cached.url;
    if (this.storage) this.storage.removeItem(cacheKey);

    const active = this.inFlight.get(fingerprint);
    if (active) return active;

    const task = this.runProcessor({
      workKind: input.workKind,
      workId,
      fingerprint,
      algorithmVersion: DISCORD_COVER_COMPOSITOR_VERSION,
      source,
    }, cacheKey).finally(() => {
      this.inFlight.delete(fingerprint);
    });

    this.inFlight.set(fingerprint, task);
    return task;
  }

  private async runProcessor(input: DiscordCoverProcessorInput, cacheKey: string): Promise<string | null> {
    if (!this.processor) return null;

    try {
      const result = normalizeProcessorResult(await this.processor(input));
      if (!result) return null;

      const now = this.now();
      const maxExpiresAt = now + DISCORD_COVER_CACHE_TTL_MS;
      const expiresAt = Math.min(
        typeof result.expiresAt === "number" && Number.isFinite(result.expiresAt)
          ? result.expiresAt
          : maxExpiresAt,
        maxExpiresAt,
      );

      if (expiresAt <= now) return null;

      this.storage?.setItem(cacheKey, JSON.stringify({ url: result.url, expiresAt }));
      return result.url;
    } catch {
      return null;
    }
  }
}

export const discordCoverService = new DiscordCoverService();
