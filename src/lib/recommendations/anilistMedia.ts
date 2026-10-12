import { normalizeToken } from "./normalization";

/**
 * What AniList knows about a work: the standard genres, the publisher's country and every title it
 * goes by. Sources often list a work with no genres or under another name, so this fills the taste
 * profile and lets the same work be recognised under any of its names.
 */
export interface AniListMediaProfile {
  id: number;
  idMal: number | null;
  /** Country of origin ("JP", "KR", "CN", ...), "" when AniList has none. */
  country: string;
  /** AniList format ("MANGA", "NOVEL", "ONE_SHOT"), "" when unknown. */
  format: string;
  genres: string[];
  /** Romaji, English and native titles followed by the synonyms. */
  titles: string[];
  /** Romaji, English and native titles alone, when the profile comes from a search. */
  mainTitles?: string[];
  /** Where a work AniList does not know was found ("kitsu", "mal", "tracker:7"); absent for AniList. */
  provider?: string;
  /** The work's entry on the Suwayomi tracker it was found on, when that tracker is not AniList or MAL. */
  trackerRemote?: { trackerId: number; remoteId: string };
}

interface AniListMediaPayload {
  id?: number;
  idMal?: number | null;
  countryOfOrigin?: string | null;
  format?: string | null;
  genres?: Array<string | null> | null;
  synonyms?: Array<string | null> | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
}

interface TitleMatchEntry {
  /** Matched AniList id, 0 when no work matched closely enough. */
  id: number;
  at: number;
  /** Matching rules the entry was made with; misses from older rules are looked up again. */
  v?: number;
  /** 1 when the whole title found nothing and its first words are still to be searched. */
  s?: 1;
}

/** How an AniList request went, for pacing the next one. */
export interface AniListResponseInfo {
  ok: boolean;
  status: number;
  retryAfterMs: number | null;
  /** Requests AniList currently allows per minute, and how many are left in this minute. */
  perMinute: number | null;
  remaining: number | null;
}

/** What the library already says about a work, used to tell apart AniList works sharing its name. */
export interface AniListTitleHints {
  /** Country the source's format points to ("KR" for manhwa, "CN" for manhua). */
  country?: string | null;
  genres?: readonly string[] | null;
}

export type AniListTitleMatchEntry = { key: string; title: string } & AniListTitleHints;

type FetchOptions = {
  signal?: AbortSignal;
  maxRequests?: number;
  fetchImpl?: typeof fetch;
  onResponse?: (info: AniListResponseInfo) => void;
};

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const ID_PAGE_SIZE = 50;
// AniList refuses queries above 500 complexity points; each title's two searches cost 24.
const TITLES_PER_SEARCH_REQUEST = 20;
const RESULTS_PER_TITLE = 5;
const MAX_STORED_SYNONYMS = 12;
const MEDIA_CACHE_STORAGE_KEY = "epigraph.recommendations.anilistMedia.v1";
const TITLE_MATCH_CACHE_STORAGE_KEY = "epigraph.recommendations.anilistTitleMatch.v1";
// Each title is looked up once. Misses are searched again only when the matching rules change.
const TITLE_MATCH_VERSION = 5;
// AniList's public search leaves out adult works unless they are asked for separately.
const ADULT_RESULTS_PER_TITLE = 3;
// AniList finds nothing for some long titles ("Mamahaha no Tsurego ga Moto Kanodatta" is spelled
// "Motokano datta" there); their first words are searched again, accepting only the same title.
const SHORT_QUERY_WORDS = 3;
// Fuzzy matches only cover small spelling differences ("Solo Leveling" / "Solo-Leveling!").
const FUZZY_TITLE_MATCH_MIN = 0.92;
const FUZZY_TITLE_RUNNER_UP_MAX = 0.85;
const PROSE_FORMATS = new Set(["NOVEL"]);
// Works sharing a name are told apart by genres only when one clearly fits the library's better.
const GENRE_TIE_BREAK_MIN = 2;

const MEDIA_PROFILE_FIELDS = `
  id
  idMal
  countryOfOrigin
  format
  genres
  synonyms
  title { romaji english native }
`;

// AniList id -> profile (null when AniList does not know the id). Genres and titles barely change,
// so entries are kept across sessions and only unseen ids reach the network.
let mediaCache: Map<number, AniListMediaProfile | null> | null = null;
let titleMatchCache: Map<string, TitleMatchEntry> | null = null;

function readStoredRecord(key: string): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    // Unreadable cache: start empty and refetch.
    return {};
  }
}

function writeStoredRecord(key: string, value: Record<string, unknown>) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the in-memory cache still serves this session.
  }
}

function loadMediaCache(): Map<number, AniListMediaProfile | null> {
  if (mediaCache) return mediaCache;
  mediaCache = new Map();
  for (const [id, value] of Object.entries(readStoredRecord(MEDIA_CACHE_STORAGE_KEY))) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) continue;
    if (value === null) mediaCache.set(numericId, null);
    else if (value && typeof value === "object") mediaCache.set(numericId, sanitizeStoredProfile(numericId, value as Partial<AniListMediaProfile>));
  }
  return mediaCache;
}

function sanitizeStoredProfile(id: number, value: Partial<AniListMediaProfile>): AniListMediaProfile {
  const strings = (list: unknown) => Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  return {
    id,
    idMal: typeof value.idMal === "number" ? value.idMal : null,
    country: typeof value.country === "string" ? value.country : "",
    format: typeof value.format === "string" ? value.format : "",
    genres: strings(value.genres),
    titles: strings(value.titles),
    ...(Array.isArray(value.mainTitles) ? { mainTitles: strings(value.mainTitles) } : {}),
  };
}

function saveMediaCache() {
  if (mediaCache) writeStoredRecord(MEDIA_CACHE_STORAGE_KEY, Object.fromEntries(mediaCache));
}

function loadTitleMatchCache(): Map<string, TitleMatchEntry> {
  if (titleMatchCache) return titleMatchCache;
  titleMatchCache = new Map();
  for (const [key, value] of Object.entries(readStoredRecord(TITLE_MATCH_CACHE_STORAGE_KEY))) {
    const entry = value as Partial<TitleMatchEntry> | null;
    if (entry && typeof entry.id === "number" && typeof entry.at === "number") {
      titleMatchCache.set(key, {
        id: entry.id,
        at: entry.at,
        ...(typeof entry.v === "number" ? { v: entry.v } : {}),
        ...(entry.s === 1 ? { s: 1 as const } : {}),
      });
    }
  }
  return titleMatchCache;
}

function saveTitleMatchCache() {
  if (titleMatchCache) writeStoredRecord(TITLE_MATCH_CACHE_STORAGE_KEY, Object.fromEntries(titleMatchCache));
}

export function resetAniListMediaCacheForTests() {
  mediaCache = null;
  titleMatchCache = null;
}

export function aniListMediaProfileFromPayload(item: AniListMediaPayload): AniListMediaProfile | null {
  if (typeof item.id !== "number") return null;
  const clean = (list: Array<string | null | undefined>) => list.map((title) => String(title ?? "").trim()).filter(Boolean);
  const mainTitles = clean([item.title?.romaji, item.title?.english, item.title?.native]);
  const titles = [...mainTitles, ...clean((item.synonyms ?? []).slice(0, MAX_STORED_SYNONYMS))];
  return {
    id: item.id,
    idMal: typeof item.idMal === "number" && item.idMal > 0 ? item.idMal : null,
    country: String(item.countryOfOrigin ?? "").trim().toUpperCase(),
    format: String(item.format ?? "").trim().toUpperCase(),
    genres: (item.genres ?? []).map((genre) => String(genre ?? "").trim()).filter(Boolean),
    titles: [...new Set(titles)],
    mainTitles: [...new Set(mainTitles)],
  };
}

function resolveFetch(options: FetchOptions) {
  return options.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
}

function headerNumber(response: Response, name: string): number | null {
  const raw = response.headers?.get?.(name);
  const value = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function postAniList(
  fetchImpl: typeof fetch,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
  onResponse?: FetchOptions["onResponse"],
) {
  let response: Response;
  try {
    response = await fetchImpl(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (error) {
    onResponse?.({ ok: false, status: 0, retryAfterMs: null, perMinute: null, remaining: null });
    throw error;
  }
  const retryAfter = headerNumber(response, "retry-after");
  const info: AniListResponseInfo = {
    ok: response.ok,
    status: response.status,
    retryAfterMs: retryAfter === null ? null : retryAfter * 1000,
    perMinute: headerNumber(response, "x-ratelimit-limit"),
    remaining: headerNumber(response, "x-ratelimit-remaining"),
  };
  if (!response.ok) {
    onResponse?.(info);
    return null;
  }
  const payload = await response.json() as { data?: Record<string, { media?: AniListMediaPayload[] } | null> | null };
  onResponse?.({ ...info, ok: Boolean(payload.data) });
  return payload.data ?? null;
}

/**
 * Profiles for AniList manga ids. Cached ids resolve without a request; at most `maxRequests` pages
 * of 50 are fetched per call so a large tracker history never floods AniList, and the rest resolve
 * on later refreshes. Ids AniList does not know map to null. Failures leave ids unresolved.
 */
export async function fetchAniListMediaProfiles(
  ids: readonly number[],
  options: FetchOptions = {},
): Promise<Map<number, AniListMediaProfile | null>> {
  const cache = loadMediaCache();
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const missing = uniqueIds.filter((id) => !cache.has(id));
  const fetchImpl = resolveFetch(options);
  const maxRequests = options.maxRequests ?? 8;

  let changed = false;
  for (let page = 0; fetchImpl && page < maxRequests && page * ID_PAGE_SIZE < missing.length; page += 1) {
    if (options.signal?.aborted) break;
    const batch = missing.slice(page * ID_PAGE_SIZE, (page + 1) * ID_PAGE_SIZE);
    try {
      const data = await postAniList(fetchImpl, `query MediaProfiles($ids: [Int]) {
        Page(perPage: ${ID_PAGE_SIZE}) { media(id_in: $ids, type: MANGA) { ${MEDIA_PROFILE_FIELDS} } }
      }`, { ids: batch }, options.signal, options.onResponse);
      const media = data?.Page?.media;
      if (!media) break;
      const found = new Map<number, AniListMediaProfile>();
      for (const item of media) {
        const profile = aniListMediaProfileFromPayload(item);
        if (profile) found.set(profile.id, profile);
      }
      for (const id of batch) cache.set(id, found.get(id) ?? null);
      changed = true;
    } catch {
      break;
    }
  }
  if (changed) saveMediaCache();

  return new Map(uniqueIds.filter((id) => cache.has(id)).map((id) => [id, cache.get(id) ?? null]));
}

// "[Official]", "(Webtoon)" and "- Manhwa" are labels sources add, not part of the name.
const TITLE_LABEL_PATTERN = /\s*[[(（【][^\])）】]*[\])）】]\s*/g;
const TITLE_SUFFIX_PATTERN = /\s*[-–—:|]\s*(official|webtoon|manhwa|manhua|manga|comic|colou?red|raw|scans?)\s*$/i;
// Adaptations are often listed as "<novel name> THE COMIC"; sources add "R-18" to adult works.
const TITLE_TRAILING_LABEL_PATTERN = /\s+(the comic|r-?18)\s*$/i;

function withoutTitleLabels(title: string): string {
  return title
    .replace(TITLE_LABEL_PATTERN, " ")
    .replace(TITLE_SUFFIX_PATTERN, "")
    .replace(TITLE_TRAILING_LABEL_PATTERN, "")
    .trim();
}

/** Normalized form of a title for matching, without the labels sources append. */
export function aniListTitleMatchKey(title: string): string {
  const original = String(title ?? "");
  const normalized = normalizeToken(withoutTitleLabels(original) || original);
  return normalized.replace(/^the /, "");
}

/**
 * The title as AniList's search understands it: without source labels and with plain punctuation.
 * AniList finds nothing for "Aristocrat’s Revenge" (curly apostrophe) but finds "Aristocrat's Revenge".
 */
export function aniListSearchQuery(title: string): string {
  const original = String(title ?? "").trim();
  const cleaned = withoutTitleLabels(original
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[‘’‚‛ʼ`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s*[–—]\s*/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || original;
}

function bigrams(value: string): Map<string, number> {
  const compact = value.replace(/ /g, "");
  const grams = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Dice coefficient over character pairs, 1 for identical keys. */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let leftSize = 0;
  let rightSize = 0;
  let shared = 0;
  for (const count of left.values()) leftSize += count;
  for (const [gram, count] of right) {
    rightSize += count;
    shared += Math.min(count, left.get(gram) ?? 0);
  }
  return leftSize + rightSize > 0 ? (2 * shared) / (leftSize + rightSize) : 0;
}

/**
 * The AniList work a comic title refers to, or null when no result is clearly it. Sources and
 * trackers often name a work differently, so a wrong match is worse than none: only an exact title
 * (any language or synonym) or a near-identical spelling is accepted, never an ambiguous pick, and
 * novels are never matched to comics.
 */
export function pickAniListTitleMatch(
  title: string,
  results: readonly AniListMediaProfile[],
  hints: AniListTitleHints = {},
  options: { exactOnly?: boolean } = {},
): AniListMediaProfile | null {
  const key = aniListTitleMatchKey(title);
  if (!key) return null;
  const compactKey = compactTitle(key);
  const comics = results.filter((item) => !PROSE_FORMATS.has(item.format));
  const scored = comics.map((item) => {
    const keys = item.titles.map(aniListTitleMatchKey).filter(Boolean);
    return {
      item,
      exact: keys.some((candidate) => compactTitle(candidate) === compactKey) || isCombinedTitle(compactKey, keys),
      similarity: Math.max(0, ...keys.map((candidate) => titleSimilarity(key, candidate))),
    };
  });

  const exact = scored.filter((entry) => entry.exact);
  if (exact.length === 1) return exact[0].item;
  if (exact.length > 1) {
    // A one-shot pilot often shares the series' name; the series is the work being read.
    const series = exact.filter((entry) => entry.item.format !== "ONE_SHOT").map((entry) => entry.item);
    if (series.length === 1) return series[0];
    // A work named so outright beats works that only list the name among their other names.
    const named = series.filter((item) => item.mainTitles?.some((candidate) => compactTitle(aniListTitleMatchKey(candidate)) === compactKey));
    if (named.length === 1) return named[0];
    return pickAmongSameNamedWorks(named.length > 1 ? named : series, hints);
  }

  if (options.exactOnly || compactKey.length < 6) return null;
  const ranked = scored.sort((a, b) => b.similarity - a.similarity);
  const [best, runnerUp] = ranked;
  if (!best || best.similarity < FUZZY_TITLE_MATCH_MIN) return null;
  if (runnerUp && runnerUp.similarity > FUZZY_TITLE_RUNNER_UP_MAX) return null;
  return best.item;
}

// Spacing differs between sources and AniList ("Moto Kanodatta" / "Motokano datta").
function compactTitle(key: string): string {
  return key.replace(/ /g, "");
}

// Sources often join a work's romaji and English names into one title
// ("Ihou no Otome Monster Girls in Another World").
function isCombinedTitle(compactKey: string, keys: readonly string[]): boolean {
  return keys.some((first) => keys.some((second) => first !== second && compactTitle(first + second) === compactKey));
}

/** The first words of a long title, searched when the whole title finds nothing; null for short titles. */
function shortSearchQuery(matchKey: string): string | null {
  const words = matchKey.split(" ");
  return words.length > SHORT_QUERY_WORDS ? words.slice(0, SHORT_QUERY_WORDS).join(" ") : null;
}

// "Leviathan" or "Player" name several works; the library's format and genres tell which one is read.
function pickAmongSameNamedWorks(works: AniListMediaProfile[], hints: AniListTitleHints): AniListMediaProfile | null {
  let remaining = works;
  const country = String(hints.country ?? "").trim().toUpperCase();
  if (country) {
    const sameCountry = remaining.filter((work) => work.country === country);
    if (sameCountry.length === 1) return sameCountry[0];
    if (sameCountry.length > 1) remaining = sameCountry;
  }
  const genres = new Set((hints.genres ?? []).map(normalizeToken).filter(Boolean));
  if (genres.size === 0 || remaining.length < 2) return null;
  const ranked = remaining
    .map((work) => ({ work, shared: work.genres.filter((genre) => genres.has(normalizeToken(genre))).length }))
    .sort((a, b) => b.shared - a.shared);
  const [best, runnerUp] = ranked;
  return best.shared >= GENRE_TIE_BREAK_MIN && best.shared - (runnerUp?.shared ?? 0) >= GENRE_TIE_BREAK_MIN ? best.work : null;
}

function isSettledMiss(entry: TitleMatchEntry): boolean {
  return entry.id === 0 && !entry.s && (entry.v ?? 1) >= TITLE_MATCH_VERSION;
}

function isShortQueryPending(entry: TitleMatchEntry | undefined): boolean {
  return entry?.id === 0 && entry.s === 1 && entry.v === TITLE_MATCH_VERSION;
}

/**
 * Finds the AniList work for titles that have no AniList tracker entry, keyed by the caller's key.
 * Ten titles share one request and at most `maxRequests` are sent per call; titles already looked
 * up resolve from the cache, misses included. Pass the most useful titles first.
 */
export async function matchAniListTitles(
  entries: ReadonlyArray<AniListTitleMatchEntry>,
  options: FetchOptions & { nowMs?: number; cachedOnly?: boolean } = {},
): Promise<Map<string, AniListMediaProfile>> {
  const media = loadMediaCache();
  const matches = loadTitleMatchCache();
  const nowMs = options.nowMs ?? Date.now();
  const result = new Map<string, AniListMediaProfile>();
  const pending = new Map<string, string[]>();

  for (const entry of entries) {
    const matchKey = aniListTitleMatchKey(entry.title);
    if (!matchKey) continue;
    const cached = matches.get(matchKey);
    if (cached && cached.id > 0 && media.get(cached.id)) {
      result.set(entry.key, media.get(cached.id)!);
      continue;
    }
    if (cached && isSettledMiss(cached)) continue;
    const keys = pending.get(matchKey) ?? [];
    keys.push(entry.key);
    if (keys.length === 1) pending.set(matchKey, keys);
  }

  const fetchImpl = resolveFetch(options);
  const queue = [...pending.keys()];
  const maxRequests = options.cachedOnly ? 0 : options.maxRequests ?? 3;
  const entryByMatchKey = new Map<string, AniListTitleMatchEntry>();
  for (const entry of entries) {
    const matchKey = aniListTitleMatchKey(entry.title);
    if (!entryByMatchKey.has(matchKey)) entryByMatchKey.set(matchKey, entry);
  }
  let changed = false;
  // A title the whole search finds nothing for is searched again by its first words, ahead of the
  // titles not searched yet. The pending short search is stored, so a call that runs out of budget
  // first leaves it for the next call instead of repeating the whole search.
  const jobs: Array<{ matchKey: string; shortQuery: string | null }> = queue.map((matchKey) => ({
    matchKey,
    shortQuery: isShortQueryPending(matches.get(matchKey)) ? shortSearchQuery(matchKey) : null,
  }));
  const record = (matchKey: string, match: AniListMediaProfile | null) => {
    matches.set(matchKey, { id: match?.id ?? 0, at: nowMs, v: TITLE_MATCH_VERSION });
    if (!match) return;
    media.set(match.id, match);
    for (const key of pending.get(matchKey) ?? []) result.set(key, match);
  };

  for (let request = 0; fetchImpl && request < maxRequests && jobs.length > 0; request += 1) {
    if (options.signal?.aborted) break;
    const batch = jobs.splice(0, TITLES_PER_SEARCH_REQUEST);
    const retries: typeof jobs = [];
    const variables: Record<string, string> = {};
    const selections = batch.map(({ matchKey, shortQuery }, index) => {
      variables[`q${index}`] = shortQuery ?? aniListSearchQuery(entryByMatchKey.get(matchKey)?.title ?? matchKey);
      return `r${index}: Page(perPage: ${RESULTS_PER_TITLE}) { media(search: $q${index}, type: MANGA) { ...MediaProfile } }
      a${index}: Page(perPage: ${ADULT_RESULTS_PER_TITLE}) { media(search: $q${index}, type: MANGA, isAdult: true) { ...MediaProfile } }`;
    });
    const query = `query TitleMatches(${batch.map((_, index) => `$q${index}: String`).join(", ")}) {
      ${selections.join("\n      ")}
    }
    fragment MediaProfile on Media { ${MEDIA_PROFILE_FIELDS} }`;
    try {
      const data = await postAniList(fetchImpl, query, variables, options.signal, options.onResponse);
      if (!data) break;
      batch.forEach(({ matchKey, shortQuery }, index) => {
        const page = data[`r${index}`];
        if (!page?.media) return;
        const found = [...page.media, ...(data[`a${index}`]?.media ?? [])];
        const retryQuery = shortQuery ? null : shortSearchQuery(matchKey);
        if (found.length === 0 && retryQuery) {
          matches.set(matchKey, { id: 0, at: nowMs, v: TITLE_MATCH_VERSION, s: 1 });
          retries.push({ matchKey, shortQuery: retryQuery });
          return;
        }
        // The adult search also returns works the plain search found; one work is never a tie with itself.
        const profiles = [...new Map(found
          .map(aniListMediaProfileFromPayload)
          .filter((item): item is AniListMediaProfile => item !== null)
          .map((item) => [item.id, item] as const)).values()];
        const entry = entryByMatchKey.get(matchKey);
        record(matchKey, pickAniListTitleMatch(entry?.title ?? matchKey, profiles, entry ?? {}, { exactOnly: Boolean(shortQuery) }));
      });
      jobs.unshift(...retries);
      changed = true;
    } catch {
      break;
    }
  }
  if (changed) {
    saveTitleMatchCache();
    saveMediaCache();
  }
  return result;
}

/** The AniList work a title was already matched to, without a request; null when unknown. */
export function cachedAniListTitleMatch(title: string): AniListMediaProfile | null {
  const cached = loadTitleMatchCache().get(aniListTitleMatchKey(title));
  return cached && cached.id > 0 ? loadMediaCache().get(cached.id) ?? null : null;
}

/** Whether AniList matched a title, settled that it has no such work, or is still to be asked. */
export function aniListTitleStatus(title: string): "matched" | "missed" | "pending" {
  const key = aniListTitleMatchKey(title);
  if (!key) return "missed";
  const cached = loadTitleMatchCache().get(key);
  if (cached && cached.id > 0 && loadMediaCache().get(cached.id)) return "matched";
  return cached && isSettledMiss(cached) ? "missed" : "pending";
}

/** Whether a title still waits for its lookup (never looked up, or missed under older rules). */
export function isAniListTitlePending(title: string): boolean {
  return aniListTitleStatus(title) === "pending";
}

/** Number of titles still waiting for a lookup, for scheduling follow-up batches. */
export function pendingAniListTitleCount(titles: readonly string[]): number {
  return new Set(titles.filter(isAniListTitlePending).map(aniListTitleMatchKey)).size;
}

/** Tags with AniList's genres added once; the source's own wording wins on duplicates. */
export function withAniListGenres(tags: readonly string[] | null | undefined, profile: AniListMediaProfile | null | undefined): string[] {
  const merged = new Map<string, string>();
  for (const tag of [...(tags ?? []), ...(profile?.genres ?? [])]) {
    const key = normalizeToken(tag);
    if (key && !merged.has(key)) merged.set(key, tag);
  }
  return [...merged.values()];
}

/** The work's other names, for recognising it when a source or tracker lists it differently. */
export function aniListAlternativeTitles(title: string | null | undefined, profile: AniListMediaProfile | null | undefined): string[] {
  const own = normalizeToken(String(title ?? ""));
  return (profile?.titles ?? []).filter((candidate) => {
    const key = normalizeToken(candidate);
    return key && key !== own;
  });
}
