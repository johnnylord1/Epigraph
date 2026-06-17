import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getServerAuthHeader, getServerUrl } from "../client";
import { resolveMangaCoverUrl } from "../manga/coverResolver";
import type { Manga } from "../types";

type CoverCacheScope = {
  profileId?: string | null;
  serverUrl?: string | null;
  coverCacheGeneration?: number | string | null;
};

const LIBRARY_COVER_CACHE_VARIANT = "thumb-v2-edge420";

const stableCoverUrls = new Map<string, string>();
const sessionCoverUrls = new Map<string, string>();

function scopeProfileId(scope: CoverCacheScope) {
  return scope.profileId?.trim() || "default";
}

function scopeServerUrl(scope: CoverCacheScope) {
  return scope.serverUrl?.trim() || getServerUrl();
}

function cacheThumbnailUrl(scope: CoverCacheScope, manga: Manga) {
  const generation = `${scope.coverCacheGeneration ?? ""}`.trim();
  const thumbnailUrl = manga.thumbnailUrl ?? "";
  const separator = thumbnailUrl.includes("?") ? "&" : "?";
  const marker = generation
    ? `aethon_cover_generation=${encodeURIComponent(generation)}&aethon_cover_variant=${LIBRARY_COVER_CACHE_VARIANT}`
    : `aethon_cover_variant=${LIBRARY_COVER_CACHE_VARIANT}`;
  return `${thumbnailUrl}${separator}${marker}`;
}

function cacheLookupKey(scope: CoverCacheScope, manga: Manga) {
  return [
    scopeProfileId(scope).toLowerCase(),
    scopeServerUrl(scope).toLowerCase(),
    manga.id,
    cacheThumbnailUrl(scope, manga),
  ].join("::");
}

function coverPathAsUrl(path: string) {
  const cached = stableCoverUrls.get(path);
  if (cached) return cached;
  const url = convertFileSrc(path, "cover");
  stableCoverUrls.set(path, url);
  return url;
}

export async function getCachedLibraryCoverUrl(
  scope: CoverCacheScope,
  manga: Manga,
): Promise<string | null> {
  if (!manga.thumbnailUrl) return null;
  const lookupKey = cacheLookupKey(scope, manga);
  const sessionUrl = sessionCoverUrls.get(lookupKey);
  if (sessionUrl) return sessionUrl;
  const path = await invoke<string | null>("get_cached_library_cover", {
    profileId: scopeProfileId(scope),
    serverUrl: scopeServerUrl(scope),
    mangaId: manga.id,
    thumbnailUrl: cacheThumbnailUrl(scope, manga),
  }).catch(() => null);

  if (!path) return null;
  const url = coverPathAsUrl(path);
  sessionCoverUrls.set(lookupKey, url);
  return url;
}

export async function cacheLibraryCoverFromServer(
  scope: CoverCacheScope,
  manga: Manga,
): Promise<string | null> {
  if (!manga.thumbnailUrl) return null;
  const lookupKey = cacheLookupKey(scope, manga);
  const path = await invoke<string | null>("cache_library_cover", {
    profileId: scopeProfileId(scope),
    serverUrl: scopeServerUrl(scope),
    mangaId: manga.id,
    thumbnailUrl: cacheThumbnailUrl(scope, manga),
    coverUrl: resolveMangaCoverUrl(manga, {
      context: "library",
      persistence: "persistent",
      cacheGeneration: scope.coverCacheGeneration,
    }),
    authHeader: getServerAuthHeader(),
  }).catch(() => null);

  if (!path) return null;
  const url = coverPathAsUrl(path);
  sessionCoverUrls.set(lookupKey, url);
  return url;
}

export function libraryCoverCacheKey(scope: CoverCacheScope, manga: Manga) {
  return cacheLookupKey(scope, manga);
}

export function getSessionLibraryCoverUrl(scope: CoverCacheScope, manga: Manga): string | null {
  return sessionCoverUrls.get(cacheLookupKey(scope, manga)) ?? null;
}

export function setSessionLibraryCoverUrl(scope: CoverCacheScope, manga: Manga, url: string) {
  sessionCoverUrls.set(cacheLookupKey(scope, manga), url);
}

export function clearSessionLibraryCoverUrl(scope: CoverCacheScope, manga: Manga) {
  sessionCoverUrls.delete(cacheLookupKey(scope, manga));
}
