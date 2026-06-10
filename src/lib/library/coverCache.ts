import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getServerAuthHeader, getServerUrl, thumbUrl } from "../client";
import type { Manga } from "../types";

type CoverCacheScope = {
  profileId?: string | null;
  serverUrl?: string | null;
};

const stableCoverUrls = new Map<string, string>();

function scopeProfileId(scope: CoverCacheScope) {
  return scope.profileId?.trim() || "default";
}

function scopeServerUrl(scope: CoverCacheScope) {
  return scope.serverUrl?.trim() || getServerUrl();
}

function cacheLookupKey(scope: CoverCacheScope, manga: Manga) {
  return [
    scopeProfileId(scope).toLowerCase(),
    scopeServerUrl(scope).toLowerCase(),
    manga.id,
    manga.thumbnailUrl ?? "",
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
  const path = await invoke<string | null>("get_cached_library_cover", {
    profileId: scopeProfileId(scope),
    serverUrl: scopeServerUrl(scope),
    mangaId: manga.id,
    thumbnailUrl: manga.thumbnailUrl,
  }).catch(() => null);

  return path ? coverPathAsUrl(path) : null;
}

export async function cacheLibraryCoverFromServer(
  scope: CoverCacheScope,
  manga: Manga,
): Promise<string | null> {
  if (!manga.thumbnailUrl) return null;
  const path = await invoke<string | null>("cache_library_cover", {
    profileId: scopeProfileId(scope),
    serverUrl: scopeServerUrl(scope),
    mangaId: manga.id,
    thumbnailUrl: manga.thumbnailUrl,
    coverUrl: thumbUrl(manga.thumbnailUrl),
    authHeader: getServerAuthHeader(),
  }).catch(() => null);

  return path ? coverPathAsUrl(path) : null;
}

export function libraryCoverCacheKey(scope: CoverCacheScope, manga: Manga) {
  return cacheLookupKey(scope, manga);
}
