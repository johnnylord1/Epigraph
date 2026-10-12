import {
  aniListSearchQuery,
  aniListTitleMatchKey,
  aniListTitleStatus,
  cachedAniListTitleMatch,
  matchAniListTitles,
  pickAniListTitleMatch,
  type AniListMediaProfile,
  type AniListResponseInfo,
  type AniListTitleMatchEntry,
} from "./anilistMedia";

/**
 * Where library works are looked up, in order: AniList, then Kitsu, then MyAnimeList, then the other
 * trackers the user is logged in to on Suwayomi. A work AniList does not know is searched on the next
 * provider, and so on until one recognises it. Every provider's answer (misses included) is kept, so
 * each work is asked about once per provider.
 */

export type TitleLookupStatus = "matched" | "missed" | "pending";

/** Whether the provider answered; a provider that does not is skipped after a few tries. */
export type TitleProviderOutcome = { ok: true; nextDelayMs?: number } | { ok: false; retryAfterMs?: number | null };

export interface TitleProvider {
  id: string;
  /** Titles one request covers. */
  batchSize: number;
  /** Least time between two requests. */
  intervalMs: number;
  status(entry: AniListTitleMatchEntry): TitleLookupStatus;
  /** Looks the titles up and stores what it finds. */
  lookUp(entries: AniListTitleMatchEntry[]): Promise<TitleProviderOutcome>;
}

export interface TitleProviderTracker {
  id: number;
  name: string;
  isLoggedIn?: boolean | null;
}

type GqlRequest = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
export interface TitleProviderDeps {
  fetchImpl?: typeof fetch;
  gql?: GqlRequest;
}

type ProviderSearch = { ok: true; profiles: AniListMediaProfile[] } | { ok: false; retryAfterMs: number | null };

interface ProviderMatchEntry {
  at: number;
  v: number;
  /** The work found, absent when the provider has none by that title. */
  p?: AniListMediaProfile;
}

const PROVIDER_MATCH_STORAGE_KEY = "epigraph.recommendations.titleProviderMatch.v1";
const PROVIDER_MATCH_VERSION = 1;
const REQUEST_TIMEOUT_MS = 8_000;
const RESULTS_PER_TITLE = 5;
const MAX_STORED_TITLES = 16;
// AniList allowed 90 requests a minute for years and 30 lately; it says which in every answer.
const DEFAULT_ANILIST_PER_MINUTE = 30;
const KITSU_INTERVAL_MS = 300;
// Jikan allows three requests a second and sixty a minute.
const JIKAN_INTERVAL_MS = 1_100;
const SUWAYOMI_TRACKER_INTERVAL_MS = 700;
const JIKAN_FAILURES_BEFORE_TRACKER = 2;
// Trackers whose Suwayomi search finds works by name. AniList, Kitsu and MyAnimeList are asked
// directly; library trackers (Komga, Kavita, Suwayomi) have no catalogue to search.
const SEARCHABLE_TRACKER_PATTERN = /mangaupdates|manga updates|shikimori|bangumi/i;

const KITSU_SUBTYPES: Record<string, { format: string; country: string }> = {
  manga: { format: "MANGA", country: "JP" },
  manhwa: { format: "MANGA", country: "KR" },
  manhua: { format: "MANGA", country: "CN" },
  oneshot: { format: "ONE_SHOT", country: "JP" },
  doujin: { format: "MANGA", country: "JP" },
  oel: { format: "MANGA", country: "" },
  novel: { format: "NOVEL", country: "" },
};

let providerMatches: Map<string, Record<string, ProviderMatchEntry>> | null = null;

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

function storedProfile(value: unknown): AniListMediaProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<AniListMediaProfile>;
  const remote = item.trackerRemote;
  return {
    id: typeof item.id === "number" ? item.id : 0,
    idMal: typeof item.idMal === "number" ? item.idMal : null,
    country: typeof item.country === "string" ? item.country : "",
    format: typeof item.format === "string" ? item.format : "",
    genres: strings(item.genres),
    titles: strings(item.titles),
    mainTitles: strings(item.mainTitles),
    ...(typeof item.provider === "string" ? { provider: item.provider } : {}),
    ...(remote && typeof remote.trackerId === "number" && typeof remote.remoteId === "string"
      ? { trackerRemote: { trackerId: remote.trackerId, remoteId: remote.remoteId } }
      : {}),
  };
}

function loadProviderMatches(): Map<string, Record<string, ProviderMatchEntry>> {
  if (providerMatches) return providerMatches;
  providerMatches = new Map();
  let stored: unknown = {};
  try {
    const raw = globalThis.localStorage?.getItem(PROVIDER_MATCH_STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    // Unreadable cache: start empty and look the titles up again.
  }
  if (!stored || typeof stored !== "object") return providerMatches;
  for (const [key, byProvider] of Object.entries(stored as Record<string, unknown>)) {
    if (!byProvider || typeof byProvider !== "object") continue;
    const entries: Record<string, ProviderMatchEntry> = {};
    for (const [provider, value] of Object.entries(byProvider as Record<string, unknown>)) {
      const entry = value as Partial<ProviderMatchEntry> | null;
      if (!entry || typeof entry.at !== "number" || typeof entry.v !== "number") continue;
      const profile = storedProfile(entry.p);
      entries[provider] = { at: entry.at, v: entry.v, ...(profile ? { p: profile } : {}) };
    }
    providerMatches.set(key, entries);
  }
  return providerMatches;
}

function saveProviderMatches() {
  if (!providerMatches) return;
  try {
    globalThis.localStorage?.setItem(PROVIDER_MATCH_STORAGE_KEY, JSON.stringify(Object.fromEntries(providerMatches)));
  } catch {
    // Storage full or blocked: the in-memory cache still serves this session.
  }
}

export function resetTitleProviderCacheForTests() {
  providerMatches = null;
}

/** Whether a provider other than AniList recognised a title, has none by it, or is still to be asked. */
export function providerTitleStatus(provider: string, title: string): TitleLookupStatus {
  const key = aniListTitleMatchKey(title);
  if (!key) return "missed";
  const entry = loadProviderMatches().get(key)?.[provider];
  if (!entry) return "pending";
  if (entry.p) return "matched";
  return entry.v >= PROVIDER_MATCH_VERSION ? "missed" : "pending";
}

export function recordProviderTitleMatch(provider: string, title: string, profile: AniListMediaProfile | null, nowMs = Date.now()) {
  const key = aniListTitleMatchKey(title);
  if (!key) return;
  const cache = loadProviderMatches();
  const entries = { ...(cache.get(key) ?? {}) };
  entries[provider] = { at: nowMs, v: PROVIDER_MATCH_VERSION, ...(profile ? { p: { ...profile, provider } } : {}) };
  cache.set(key, entries);
  saveProviderMatches();
}

/** The work a library title was recognised as by any provider, without a request; null when unknown. */
export function cachedLibraryTitleMatch(title: string): AniListMediaProfile | null {
  const aniList = cachedAniListTitleMatch(title);
  if (aniList) return aniList;
  const entries = loadProviderMatches().get(aniListTitleMatchKey(title));
  if (!entries) return null;
  const found = Object.entries(entries).filter(([, entry]) => entry.p).sort(([a], [b]) => providerRank(a) - providerRank(b));
  return found[0]?.[1].p ?? null;
}

/** Cached matches of several titles, keyed by the caller's key. */
export function cachedLibraryTitleMatches(entries: ReadonlyArray<{ key: string; title: string }>): Map<string, AniListMediaProfile> {
  const result = new Map<string, AniListMediaProfile>();
  for (const entry of entries) {
    const profile = cachedLibraryTitleMatch(entry.title);
    if (profile) result.set(entry.key, profile);
  }
  return result;
}

function providerRank(provider: string): number {
  if (provider === "kitsu") return 0;
  if (provider === "mal") return 1;
  return 2 + Number(provider.replace(/^tracker:/, "") || 0) / 1e6;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; json: unknown } | { ok: false; retryAfterMs: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const retryAfter = Number(response.headers?.get?.("retry-after") ?? NaN);
      return { ok: false, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null };
    }
    return { ok: true, json: await response.json() };
  } catch {
    return { ok: false, retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

function cleanTitles(list: unknown[]): string[] {
  return [...new Set(list.map((title) => String(title ?? "").trim()).filter(Boolean))];
}

interface KitsuResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown> | null;
  relationships?: Record<string, { data?: Array<{ id?: string; type?: string }> | null } | null> | null;
}

/** Kitsu works from a search answer, with their genres and the AniList and MAL ids Kitsu maps them to. */
export function kitsuProfiles(payload: unknown): AniListMediaProfile[] {
  const body = (payload ?? {}) as { data?: KitsuResource[] | null; included?: KitsuResource[] | null };
  const included = new Map((body.included ?? []).map((item) => [`${item.type}:${item.id}`, item.attributes ?? {}]));
  const profiles: AniListMediaProfile[] = [];
  for (const item of body.data ?? []) {
    const attributes = item.attributes ?? {};
    const subtype = KITSU_SUBTYPES[String(attributes.subtype ?? "").toLowerCase()] ?? { format: "MANGA", country: "" };
    const related = (name: string) => (item.relationships?.[name]?.data ?? [])
      .map((ref) => included.get(`${ref.type}:${ref.id}`))
      .filter((value): value is Record<string, unknown> => Boolean(value));
    let id = 0;
    let idMal: number | null = null;
    for (const mapping of related("mappings")) {
      const site = String(mapping.externalSite ?? "");
      const externalId = Number(mapping.externalId);
      if (!Number.isInteger(externalId) || externalId <= 0) continue;
      if (site === "anilist/manga") id = externalId;
      if (site === "myanimelist/manga") idMal = externalId;
    }
    const titleMap = attributes.titles && typeof attributes.titles === "object" ? Object.values(attributes.titles as Record<string, unknown>) : [];
    const mainTitles = cleanTitles([attributes.canonicalTitle, ...titleMap]);
    profiles.push({
      id,
      idMal,
      country: subtype.country,
      format: subtype.format,
      genres: cleanTitles(related("categories").map((category) => category.title)),
      titles: cleanTitles([...mainTitles, ...strings(attributes.abbreviatedTitles)]).slice(0, MAX_STORED_TITLES),
      mainTitles,
    });
  }
  return profiles;
}

function jikanFormat(type: string): { format: string; country: string } {
  const value = type.toLowerCase();
  if (value.includes("novel")) return { format: "NOVEL", country: "" };
  if (value === "manhwa") return { format: "MANGA", country: "KR" };
  if (value === "manhua") return { format: "MANGA", country: "CN" };
  if (value === "one-shot") return { format: "ONE_SHOT", country: "JP" };
  if (value === "manga" || value === "doujinshi") return { format: "MANGA", country: "JP" };
  return { format: "MANGA", country: "" };
}

/** MyAnimeList works from a Jikan search answer. */
export function jikanProfiles(payload: unknown): AniListMediaProfile[] {
  type Named = { name?: string | null };
  const body = (payload ?? {}) as {
    data?: Array<{
      mal_id?: number;
      type?: string | null;
      title?: string | null;
      title_english?: string | null;
      title_japanese?: string | null;
      title_synonyms?: string[] | null;
      titles?: Array<{ title?: string | null }> | null;
      genres?: Named[] | null;
      explicit_genres?: Named[] | null;
      themes?: Named[] | null;
    }> | null;
  };
  return (body.data ?? []).flatMap((item) => {
    if (typeof item.mal_id !== "number" || item.mal_id <= 0) return [];
    const { format, country } = jikanFormat(String(item.type ?? ""));
    const mainTitles = cleanTitles([item.title, item.title_english, item.title_japanese]);
    const names = (list: Named[] | null | undefined) => (list ?? []).map((entry) => entry.name);
    return [{
      id: 0,
      idMal: item.mal_id,
      country,
      format,
      genres: cleanTitles([...names(item.genres), ...names(item.explicit_genres), ...names(item.themes)]),
      titles: cleanTitles([...mainTitles, ...(item.title_synonyms ?? []), ...(item.titles ?? []).map((entry) => entry.title)]).slice(0, MAX_STORED_TITLES),
      mainTitles,
    }];
  });
}

export interface TrackerSearchResult {
  remoteId?: string | number | null;
  title?: string | null;
  publishingType?: string | null;
}

/** Works from a Suwayomi tracker search, which only names each one. */
export function trackerSearchProfiles(trackerId: number, kind: "mal" | "generic", results: readonly TrackerSearchResult[]): AniListMediaProfile[] {
  return results.flatMap((result) => {
    const remoteId = String(result.remoteId ?? "").trim();
    const title = String(result.title ?? "").trim();
    if (!remoteId || remoteId === "0" || !title) return [];
    const type = String(result.publishingType ?? "").toLowerCase();
    const format = type.includes("novel") ? "NOVEL" : type.includes("one") ? "ONE_SHOT" : "MANGA";
    const country = type.includes("manhwa") ? "KR" : type.includes("manhua") ? "CN" : type.includes("manga") ? "JP" : "";
    const malId = Number(remoteId);
    return [{
      id: 0,
      idMal: kind === "mal" && Number.isInteger(malId) && malId > 0 ? malId : null,
      country,
      format,
      genres: [],
      titles: [title],
      mainTitles: [title],
      ...(kind === "generic" ? { trackerRemote: { trackerId, remoteId } } : {}),
    }];
  });
}

const SEARCH_TRACKER_TITLES = `
  query SearchTrackerTitles($trackerId: Int!, $query: String!) {
    searchTracker(input: { trackerId: $trackerId, query: $query }) {
      trackSearches { remoteId title publishingType }
    }
  }
`;

async function searchKitsu(fetchImpl: typeof fetch, query: string): Promise<ProviderSearch> {
  const params = [
    `filter%5Btext%5D=${encodeURIComponent(query)}`,
    `page%5Blimit%5D=${RESULTS_PER_TITLE}`,
    "include=categories,mappings",
    "fields%5Bmanga%5D=canonicalTitle,titles,abbreviatedTitles,subtype,categories,mappings",
    "fields%5Bcategories%5D=title",
    "fields%5Bmappings%5D=externalSite,externalId",
  ];
  const answer = await fetchJson(fetchImpl, `https://kitsu.io/api/edge/manga?${params.join("&")}`, { Accept: "application/vnd.api+json" });
  return answer.ok ? { ok: true, profiles: kitsuProfiles(answer.json) } : answer;
}

async function searchJikan(fetchImpl: typeof fetch, query: string): Promise<ProviderSearch> {
  const answer = await fetchJson(fetchImpl, `https://api.jikan.moe/v4/manga?q=${encodeURIComponent(query)}&limit=${RESULTS_PER_TITLE}`, { Accept: "application/json" });
  return answer.ok ? { ok: true, profiles: jikanProfiles(answer.json) } : answer;
}

async function searchTracker(gql: GqlRequest, trackerId: number, kind: "mal" | "generic", query: string): Promise<ProviderSearch> {
  try {
    const data = await gql<{ searchTracker?: { trackSearches?: TrackerSearchResult[] | null } | null }>(SEARCH_TRACKER_TITLES, { trackerId, query });
    return { ok: true, profiles: trackerSearchProfiles(trackerId, kind, data.searchTracker?.trackSearches ?? []) };
  } catch {
    return { ok: false, retryAfterMs: null };
  }
}

function trackerKind(tracker: TitleProviderTracker): "anilist" | "mal" | "kitsu" | "generic" {
  const name = tracker.name.toLowerCase();
  if (name.includes("anilist")) return "anilist";
  if (name.includes("myanimelist") || name === "mal") return "mal";
  if (name.includes("kitsu")) return "kitsu";
  return "generic";
}

function aniListProvider(fetchImpl: typeof fetch | undefined): TitleProvider {
  return {
    id: "anilist",
    batchSize: 20,
    intervalMs: Math.ceil(60_000 / DEFAULT_ANILIST_PER_MINUTE),
    status: (entry) => aniListTitleStatus(entry.title),
    async lookUp(entries) {
      const response: { info?: AniListResponseInfo } = {};
      await matchAniListTitles(entries, { maxRequests: 1, fetchImpl, onResponse: (info) => { response.info = info; } });
      const info = response.info;
      if (!info?.ok) return { ok: false, retryAfterMs: info?.retryAfterMs ?? null };
      // Each request waits its share of the minute AniList allows, or the rest of the minute once
      // it is used up.
      const perMinute = info.perMinute && info.perMinute > 0 ? info.perMinute : DEFAULT_ANILIST_PER_MINUTE;
      return { ok: true, nextDelayMs: info.remaining === 0 ? 60_000 : Math.ceil(60_000 / perMinute) + 100 };
    },
  };
}

/** Looks each title up on its own: the providers below answer one search per request. */
function singleTitleProvider(
  id: string,
  intervalMs: number,
  search: (query: string) => Promise<ProviderSearch & { exactOnly?: boolean }>,
): TitleProvider {
  return {
    id,
    batchSize: 1,
    intervalMs,
    status: (entry) => providerTitleStatus(id, entry.title),
    async lookUp(entries) {
      for (const entry of entries) {
        const answer = await search(aniListSearchQuery(entry.title));
        if (!answer.ok) return { ok: false, retryAfterMs: answer.retryAfterMs };
        const match = pickAniListTitleMatch(entry.title, answer.profiles, entry, { exactOnly: answer.exactOnly });
        recordProviderTitleMatch(id, entry.title, match);
      }
      return { ok: true };
    },
  };
}

/**
 * The providers to ask, in order. AniList and Kitsu are public; MyAnimeList is asked through Jikan,
 * or through the user's MyAnimeList tracker while Jikan is down; MangaUpdates, Shikimori and Bangumi
 * only through a tracker the user is logged in to.
 */
export function titleProviderChain(trackers: readonly TitleProviderTracker[], deps: TitleProviderDeps = {}): TitleProvider[] {
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  const gql: GqlRequest = deps.gql ?? (async (query, variables) => (await import("../startupClient")).gql(query, variables));
  const loggedIn = trackers.filter((tracker) => tracker.isLoggedIn);
  const malTracker = loggedIn.find((tracker) => trackerKind(tracker) === "mal");
  const chain: TitleProvider[] = [aniListProvider(fetchImpl)];
  if (fetchImpl) chain.push(singleTitleProvider("kitsu", KITSU_INTERVAL_MS, (query) => searchKitsu(fetchImpl, query)));

  if (fetchImpl || malTracker) {
    let jikanFailures = fetchImpl ? 0 : JIKAN_FAILURES_BEFORE_TRACKER;
    chain.push(singleTitleProvider("mal", JIKAN_INTERVAL_MS, async (query) => {
      if (fetchImpl && jikanFailures < JIKAN_FAILURES_BEFORE_TRACKER) {
        const answer = await searchJikan(fetchImpl, query);
        if (answer.ok || !malTracker) {
          jikanFailures = answer.ok ? 0 : jikanFailures + 1;
          return answer;
        }
        jikanFailures += 1;
      }
      // The tracker search names each work in one language only, so only the same title is accepted.
      const answer = await searchTracker(gql, malTracker!.id, "mal", query);
      return { ...answer, exactOnly: true };
    }));
  }

  for (const tracker of loggedIn) {
    if (trackerKind(tracker) !== "generic" || !SEARCHABLE_TRACKER_PATTERN.test(tracker.name)) continue;
    chain.push(singleTitleProvider(`tracker:${tracker.id}`, SUWAYOMI_TRACKER_INTERVAL_MS, async (query) => ({
      ...(await searchTracker(gql, tracker.id, "generic", query)),
      exactOnly: true,
    })));
  }
  return chain;
}
