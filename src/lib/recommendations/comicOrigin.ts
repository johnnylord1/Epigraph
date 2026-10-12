import type { TrackRecord } from "../types";
import { fetchAniListMediaProfiles, resetAniListMediaCacheForTests } from "./anilistMedia";

export type ComicContentType = "manga" | "manhwa" | "manhua";

/** Comic format per tracker entry, keyed by `comicOriginKey(trackerId, remoteId)`. */
export type ComicOriginsByTrackerEntry = ReadonlyMap<string, ComicContentType>;

export function comicOriginKey(trackerId: number | string, remoteId: number | string): string {
  return `${trackerId}:${remoteId}`;
}

export function comicTypeFromCountry(country: string | null | undefined): ComicContentType | null {
  const code = String(country ?? "").trim().toUpperCase();
  if (code === "KR") return "manhwa";
  if (code === "CN" || code === "TW" || code === "HK") return "manhua";
  if (code === "JP") return "manga";
  return null;
}

/** The publisher's country beats source and tag guesses, which call most aggregator manhwa "manga". */
export function comicOriginForRecords(
  records: readonly Pick<TrackRecord, "trackerId" | "remoteId">[] | undefined,
  origins: ComicOriginsByTrackerEntry | undefined,
): ComicContentType | null {
  if (!records?.length || !origins?.size) return null;
  for (const record of records) {
    const origin = origins.get(comicOriginKey(record.trackerId, record.remoteId));
    if (origin) return origin;
  }
  return null;
}

export function resetComicOriginCacheForTests() {
  resetAniListMediaCacheForTests();
}

/**
 * Countries of origin for AniList manga ids ("" when AniList has none), read from the shared
 * AniList profile cache. See `fetchAniListMediaProfiles` for the request budget.
 */
export async function fetchAniListCountries(
  ids: readonly number[],
  options: { signal?: AbortSignal; maxRequests?: number; fetchImpl?: typeof fetch } = {},
): Promise<Map<number, string>> {
  const profiles = await fetchAniListMediaProfiles(ids, options);
  return new Map([...profiles].map(([id, profile]) => [id, profile?.country ?? ""]));
}
