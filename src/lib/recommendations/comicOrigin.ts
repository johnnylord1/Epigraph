import type { TrackRecord } from "../types";

export type ComicContentType = "manga" | "manhwa" | "manhua";

/** Comic format per tracker entry, keyed by `comicOriginKey(trackerId, remoteId)`. */
export type ComicOriginsByTrackerEntry = ReadonlyMap<string, ComicContentType>;

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const ANILIST_PAGE_SIZE = 50;
const CACHE_STORAGE_KEY = "epigraph.recommendations.anilistCountry.v1";

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

// AniList id -> country of origin ("" when AniList has none). A work's country never changes, so
// entries are kept across sessions and only unseen ids reach the network.
let countryCache: Map<number, string> | null = null;

function loadCountryCache(): Map<number, string> {
  if (countryCache) return countryCache;
  countryCache = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    for (const [id, country] of Object.entries(parsed)) {
      const numericId = Number(id);
      if (Number.isInteger(numericId) && typeof country === "string") countryCache.set(numericId, country);
    }
  } catch {
    // Unreadable cache: start empty and refetch.
  }
  return countryCache;
}

function saveCountryCache(cache: Map<number, string>) {
  try {
    globalThis.localStorage?.setItem(CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Storage full or blocked: the in-memory cache still serves this session.
  }
}

export function resetComicOriginCacheForTests() {
  countryCache = null;
}

/**
 * Countries of origin for AniList manga ids. Cached ids resolve without a request; at most
 * `maxRequests` pages are fetched per call so a large tracker history never floods AniList, and
 * the rest resolve on later refreshes. Failures leave ids unresolved instead of throwing.
 */
export async function fetchAniListCountries(
  ids: readonly number[],
  options: { signal?: AbortSignal; maxRequests?: number; fetchImpl?: typeof fetch } = {},
): Promise<Map<number, string>> {
  const cache = loadCountryCache();
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const missing = uniqueIds.filter((id) => !cache.has(id));
  const fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  const maxRequests = options.maxRequests ?? 8;

  let changed = false;
  for (let page = 0; fetchImpl && page < maxRequests && page * ANILIST_PAGE_SIZE < missing.length; page += 1) {
    if (options.signal?.aborted) break;
    const batch = missing.slice(page * ANILIST_PAGE_SIZE, (page + 1) * ANILIST_PAGE_SIZE);
    try {
      const response = await fetchImpl(ANILIST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: `query ComicOrigins($ids: [Int]) {
            Page(perPage: ${ANILIST_PAGE_SIZE}) { media(id_in: $ids, type: MANGA) { id countryOfOrigin } }
          }`,
          variables: { ids: batch },
        }),
        signal: options.signal,
      });
      if (!response.ok) break;
      const payload = await response.json() as {
        data?: { Page?: { media?: Array<{ id?: number; countryOfOrigin?: string | null }> } };
      };
      const media = payload.data?.Page?.media;
      if (!media) break;
      const found = new Map(media.filter((item) => typeof item.id === "number").map((item) => [item.id!, item.countryOfOrigin ?? ""]));
      for (const id of batch) cache.set(id, found.get(id) ?? "");
      changed = true;
    } catch {
      break;
    }
  }
  if (changed) saveCountryCache(cache);

  return new Map(uniqueIds.filter((id) => cache.has(id)).map((id) => [id, cache.get(id)!]));
}
