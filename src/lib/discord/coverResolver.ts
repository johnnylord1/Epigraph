import { FALLBACK_COVER_ASSET } from "./types";

const PRIVATE_HOSTS = new Set(["localhost", "0.0.0.0"]);

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host) || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  if (match) {
    const octet = Number(match[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return host === "::1" || host === "[::1]";
}

export function isDiscordPublicImageUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeDiscordCoverImage(value: string): string {
  return value.trim();
}

export function resolveDiscordCover(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (isDiscordPublicImageUrl(value)) return normalizeDiscordCoverImage(value);
  }
  return FALLBACK_COVER_ASSET;
}
