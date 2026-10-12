import { creditRelation, splitCredits, type CreditRelation } from "./credits";
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
  /** Who made it (authors, artists, studios), when the provider names them. */
  credits?: string[];
  /** Where a work AniList does not know was found ("kitsu", "mal", "tracker:7"); absent for AniList. */
  provider?: string;
  /** The work's entry on the Suwayomi tracker it was found on, when that tracker is not AniList or MAL. */
  trackerRemote?: { trackerId: number; remoteId: string };
  /** The book's Hardcover id, when it was found there. */
  hardcoverId?: number;
}

/**
 * Comics and prose are looked up and cached apart, so a novel never takes its comic adaptation's
 * place. "novel" covers web novels, light novels and books alike: they differ in where they are
 * published and tracked, not in how a title is recognised. Novels are looked up on Hardcover only.
 */
export type TitleMedium = "comic" | "novel";

/**
 * What a title search settled: the work the title certainly names, or failing that the work it most
 * likely names. A likely work is only a hint (for the tracking panel's search), never a match.
 */
export interface TitleJudgement {
  match: AniListMediaProfile | null;
  candidate: AniListMediaProfile | null;
}

type StaffName = { full?: string | null; native?: string | null; alternative?: Array<string | null> | null } | null;

interface AniListMediaPayload {
  id?: number;
  idMal?: number | null;
  countryOfOrigin?: string | null;
  format?: string | null;
  genres?: Array<string | null> | null;
  synonyms?: Array<string | null> | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  staff?: { nodes?: Array<{ name?: StaffName } | null> | null } | null;
}

interface TitleMatchEntry {
  /** Matched AniList id, 0 when no work matched for certain. */
  id: number;
  at: number;
  /** Matching rules the entry was made with; entries from older rules are looked up again. */
  v?: number;
  /** Search still to make: 1 the title's first words, 2 the works of the title's author. */
  s?: 1 | 2;
  /** 1 when a work fits the title but not for certain: the title stays pending. */
  u?: 1;
  /** That likely work's AniList id. */
  c?: number;
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
  /** Authors, artists and studios the library names. */
  credits?: readonly string[] | null;
}

export type AniListTitleMatchEntry = { key: string; title: string; medium?: TitleMedium } & AniListTitleHints;

type FetchOptions = {
  signal?: AbortSignal;
  maxRequests?: number;
  fetchImpl?: typeof fetch;
  onResponse?: (info: AniListResponseInfo) => void;
};

const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const ID_PAGE_SIZE = 50;
// AniList refuses queries above 500 complexity points; each title's two searches cost 30 with the staff.
const TITLES_PER_SEARCH_REQUEST = 16;
const AUTHORS_PER_SEARCH_REQUEST = 8;
const STAFF_PER_WORK = 6;
const WORKS_PER_STAFF = 15;
const RESULTS_PER_TITLE = 5;
const MAX_STORED_SYNONYMS = 12;
const MEDIA_CACHE_STORAGE_KEY = "epigraph.recommendations.anilistMedia.v1";
const TITLE_MATCH_CACHE_STORAGE_KEY = "epigraph.recommendations.anilistTitleMatch.v1";
// Each title is looked up once, and again only when the matching rules change.
const TITLE_MATCH_VERSION = 6;
// AniList's public search leaves out adult works unless they are asked for separately.
const ADULT_RESULTS_PER_TITLE = 3;
// AniList finds nothing for some long titles ("Mamahaha no Tsurego ga Moto Kanodatta" is spelled
// "Motokano datta" there); their first words are searched again, accepting only the same title.
const SHORT_QUERY_WORDS = 3;
// Fuzzy matches only cover small spelling differences in long titles ("Beginning After the Ends").
const FUZZY_TITLE_MATCH_MIN = 0.92;
const FUZZY_TITLE_RUNNER_UP_MAX = 0.85;
const FUZZY_TITLE_MIN_WORDS = 3;
const FUZZY_TITLE_MIN_LENGTH = 12;
// The same author vouches for a title spelled a little differently ("Lord of Mysteries").
const CREDITED_TITLE_MATCH_MIN = 0.8;
// A title shorter than this ("Chrysalis", "Player") names too many works to trust on its own.
const DISTINCTIVE_TITLE_MIN_WORDS = 2;
const DISTINCTIVE_TITLE_MIN_LENGTH = 8;
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
const STAFF_FIELDS = `staff(perPage: ${STAFF_PER_WORK}) { nodes { name { full native alternative } } }`;
// Names searched per library work when its title finds nothing for certain (author, artist).
const CREDITS_SEARCHED_PER_WORK = 2;

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
    ...(Array.isArray(value.credits) ? { credits: strings(value.credits) } : {}),
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
        ...(entry.s === 1 || entry.s === 2 ? { s: entry.s } : {}),
        ...(entry.u === 1 ? { u: 1 as const } : {}),
        ...(typeof entry.c === "number" && entry.c > 0 ? { c: entry.c } : {}),
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
  const credits = staffCredits((item.staff?.nodes ?? []).map((node) => node?.name ?? null));
  return {
    id: item.id,
    idMal: typeof item.idMal === "number" && item.idMal > 0 ? item.idMal : null,
    country: String(item.countryOfOrigin ?? "").trim().toUpperCase(),
    format: String(item.format ?? "").trim().toUpperCase(),
    genres: (item.genres ?? []).map((genre) => String(genre ?? "").trim()).filter(Boolean),
    titles: [...new Set(titles)],
    mainTitles: [...new Set(mainTitles)],
    ...(credits.length > 0 ? { credits } : {}),
  };
}

/** Every name of the people credited, so a pen name or the native spelling is recognised too. */
function staffCredits(names: StaffName[]): string[] {
  const credits = names.flatMap((name) => [name?.full, name?.native, ...(name?.alternative ?? []).slice(0, 3)]);
  return splitCredits(credits.map((credit) => String(credit ?? "").trim()).filter(Boolean));
}

function resolveFetch(options: FetchOptions) {
  return options.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
}

function headerNumber(response: Response, name: string): number | null {
  const raw = response.headers?.get?.(name);
  const value = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function postAniList(
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

interface ScoredWork {
  item: AniListMediaProfile;
  /** The title is one of the work's own names (romaji, English, native), not only a synonym. */
  exactMain: boolean;
  exact: boolean;
  similarity: number;
  credit: CreditRelation;
}

function fitsMedium(item: AniListMediaProfile, medium: TitleMedium): boolean {
  return medium === "comic" ? !PROSE_FORMATS.has(item.format) : PROSE_FORMATS.has(item.format);
}

function isDistinctiveTitle(key: string): boolean {
  return key.split(" ").length >= DISTINCTIVE_TITLE_MIN_WORDS && compactTitle(key).length >= DISTINCTIVE_TITLE_MIN_LENGTH;
}

/**
 * Which work a title names. A wrong match is worse than none: a work counts only when it is certain
 * (the same author or studio with the same or a nearly identical title; or, when the library names
 * no author, the work's own name, distinctive enough and unique). A work that only might be it (a
 * synonym or abbreviation of a short title, a different author, several works of that name) is
 * returned as the candidate and the title stays pending. Comics never match novels and the reverse.
 */
export function judgeTitleMatch(
  title: string,
  results: readonly AniListMediaProfile[],
  hints: AniListTitleHints = {},
  options: { exactOnly?: boolean; medium?: TitleMedium } = {},
): TitleJudgement {
  const none: TitleJudgement = { match: null, candidate: null };
  const key = aniListTitleMatchKey(title);
  if (!key) return none;
  const compactKey = compactTitle(key);
  const medium = options.medium ?? "comic";
  const scored: ScoredWork[] = results.filter((item) => fitsMedium(item, medium)).map((item) => {
    const keys = item.titles.map(aniListTitleMatchKey).filter(Boolean);
    const mainKeys = (item.mainTitles ?? item.titles).map(aniListTitleMatchKey).filter(Boolean);
    const exactMain = mainKeys.some((candidate) => compactTitle(candidate) === compactKey) || isCombinedTitle(compactKey, mainKeys);
    return {
      item,
      exactMain,
      exact: exactMain || keys.some((candidate) => compactTitle(candidate) === compactKey) || isCombinedTitle(compactKey, keys),
      similarity: Math.max(0, ...keys.map((candidate) => titleSimilarity(key, candidate))),
      credit: creditRelation(hints.credits, item.credits),
    };
  });
  const likely = (list: ScoredWork[]): TitleJudgement => ({ match: null, candidate: list[0]?.item ?? null });

  // The same author or studio confirms a title that reads the same or nearly the same.
  const credited = scored
    .filter((entry) => entry.credit === "match" && (entry.exact || entry.similarity >= CREDITED_TITLE_MATCH_MIN))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.similarity - a.similarity);
  if (credited.length > 0) {
    // Several listings of the same title by the same author are one work (Hardcover keeps duplicates).
    const pick = pickOneWork(credited, hints) ?? (credited[0].exact ? credited[0] : null);
    return pick ? { match: pick.item, candidate: null } : likely(credited);
  }

  // A different author means a different work of the same name, or names spelled too differently
  // to tell: either way it is not certain.
  const open = scored.filter((entry) => entry.credit !== "conflict");
  const conflicting = scored.filter((entry) => entry.credit === "conflict" && (entry.exact || entry.similarity >= FUZZY_TITLE_MATCH_MIN));
  const exact = open.filter((entry) => entry.exact);
  if (exact.length > 0) {
    const pick = pickOneWork(exact, hints);
    if (!pick) return likely(exact);
    // A short title is trusted only as the work's own name and when the library's format or genres
    // picked it; synonyms and abbreviations ("Chrysalis") need a distinctive title.
    const certain = isDistinctiveTitle(key) || (pick.exactMain && (pick.byHints || sameCountry(pick.item, hints)));
    return certain ? { match: pick.item, candidate: null } : likely([pick]);
  }

  if (!options.exactOnly && compactKey.length >= 6) {
    const ranked = [...open].sort((a, b) => b.similarity - a.similarity);
    const [best, runnerUp] = ranked;
    if (best && best.similarity >= FUZZY_TITLE_MATCH_MIN) {
      const clear = !runnerUp || runnerUp.similarity <= FUZZY_TITLE_RUNNER_UP_MAX;
      const long = key.split(" ").length >= FUZZY_TITLE_MIN_WORDS && compactKey.length >= FUZZY_TITLE_MIN_LENGTH;
      return clear && long ? { match: best.item, candidate: null } : likely([best]);
    }
  }
  return conflicting.length > 0 ? likely(conflicting) : none;
}

/** The work a title certainly names, or null; see judgeTitleMatch. */
export function pickAniListTitleMatch(
  title: string,
  results: readonly AniListMediaProfile[],
  hints: AniListTitleHints = {},
  options: { exactOnly?: boolean; medium?: TitleMedium } = {},
): AniListMediaProfile | null {
  return judgeTitleMatch(title, results, hints, options).match;
}

function sameCountry(item: AniListMediaProfile, hints: AniListTitleHints): boolean {
  const country = String(hints.country ?? "").trim().toUpperCase();
  return Boolean(country) && item.country === country;
}

/** One work out of several that fit, or null when nothing tells them apart. */
function pickOneWork(entries: ScoredWork[], hints: AniListTitleHints): (ScoredWork & { byHints: boolean }) | null {
  if (entries.length === 1) return { ...entries[0], byHints: false };
  let pool = entries.filter((entry) => entry.exact);
  if (pool.length === 1) return { ...pool[0], byHints: false };
  if (pool.length === 0) pool = entries;
  // A one-shot pilot often shares the series' name; the series is the work being read.
  const series = pool.filter((entry) => entry.item.format !== "ONE_SHOT");
  if (series.length === 1) return { ...series[0], byHints: false };
  if (series.length > 1) pool = series;
  // A work named so outright beats works that only list the name among their other names.
  const named = pool.filter((entry) => entry.exactMain);
  if (named.length === 1) return { ...named[0], byHints: false };
  const remaining = named.length > 1 ? named : pool;
  const chosen = pickAmongSameNamedWorks(remaining.map((entry) => entry.item), hints);
  const entry = chosen ? remaining.find((candidate) => candidate.item === chosen) : undefined;
  return entry ? { ...entry, byHints: true } : null;
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

/** Where a title's lookup is kept: comics under the title, prose under "n|" and the title. */
export function titleLookupKey(title: string, medium: TitleMedium = "comic"): string {
  const key = aniListTitleMatchKey(title);
  return key && medium === "novel" ? `n|${key}` : key;
}

function isCurrent(entry: TitleMatchEntry | undefined): entry is TitleMatchEntry {
  return Boolean(entry) && (entry!.v ?? 1) >= TITLE_MATCH_VERSION;
}

/** Looked up under the current rules with nothing left to search: matched, likely or missed. */
function isSettled(entry: TitleMatchEntry | undefined): boolean {
  return isCurrent(entry) && !entry.s;
}

function isShortQueryPending(entry: TitleMatchEntry | undefined): boolean {
  return isCurrent(entry) && entry.id === 0 && entry.s === 1;
}

type StaffPayload = { name?: StaffName; staffMedia?: { nodes?: AniListMediaPayload[] | null } | null };

/**
 * The works of the library's authors, artists or studios. Only people whose name is the one the
 * library gives count: AniList's staff search also returns people with similar names.
 */
function creditedWorks(credits: readonly string[], found: ReadonlyArray<StaffPayload | null | undefined>): AniListMediaProfile[] {
  const works = new Map<number, AniListMediaProfile>();
  for (const person of found) {
    const names = staffCredits([person?.name ?? null]);
    if (creditRelation(credits, names) !== "match") continue;
    for (const node of person?.staffMedia?.nodes ?? []) {
      const work = aniListMediaProfileFromPayload(node);
      if (!work) continue;
      const known = works.get(work.id);
      works.set(work.id, { ...work, credits: [...new Set([...(known?.credits ?? []), ...names])] });
    }
  }
  return [...works.values()];
}

/**
 * Finds the AniList work for titles that have no AniList tracker entry, keyed by the caller's key.
 * Titles share requests and at most `maxRequests` are sent per call; titles already looked up
 * resolve from the cache, misses included. A title found for certain is returned; a title AniList
 * only might know is kept as pending with that likely work, never returned. A title its search does
 * not settle is searched again through its authors' works. Pass the most useful titles first.
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
  const entryByLookupKey = new Map<string, AniListTitleMatchEntry>();

  for (const entry of entries) {
    const lookupKey = titleLookupKey(entry.title, entry.medium);
    if (!lookupKey) continue;
    const cached = matches.get(lookupKey);
    if (isSettled(cached)) {
      const found = cached!.id > 0 ? media.get(cached!.id) : null;
      if (found) result.set(entry.key, found);
      continue;
    }
    if (!entryByLookupKey.has(lookupKey)) entryByLookupKey.set(lookupKey, entry);
    const keys = pending.get(lookupKey) ?? [];
    keys.push(entry.key);
    if (keys.length === 1) pending.set(lookupKey, keys);
  }

  const fetchImpl = resolveFetch(options);
  const maxRequests = options.cachedOnly ? 0 : options.maxRequests ?? 3;
  let changed = false;
  // A title the whole search finds nothing for is searched again by its first words, ahead of the
  // titles not searched yet; a title still unsettled after that, through its authors' works. The
  // search still to make is stored, so a call that runs out of budget leaves it for the next call
  // instead of repeating the searches already made.
  const jobs: Array<{ lookupKey: string; shortQuery: string | null }> = [];
  const creditJobs: string[] = [];
  for (const lookupKey of pending.keys()) {
    const cached = matches.get(lookupKey);
    if (isCurrent(cached) && cached.s === 2) creditJobs.push(lookupKey);
    else jobs.push({ lookupKey, shortQuery: isShortQueryPending(cached) ? shortSearchQuery(aniListTitleMatchKey(entryByLookupKey.get(lookupKey)!.title)) : null });
  }
  const creditsOf = (lookupKey: string) => splitCredits(entryByLookupKey.get(lookupKey)?.credits ?? []);
  const record = (lookupKey: string, judgement: TitleJudgement, searchCredits: boolean) => {
    const { match, candidate } = judgement;
    const likely = match ? null : candidate ?? media.get(matches.get(lookupKey)?.c ?? 0) ?? null;
    const next: TitleMatchEntry = { id: match?.id ?? 0, at: nowMs, v: TITLE_MATCH_VERSION };
    if (!match && searchCredits && creditsOf(lookupKey).length > 0) {
      next.s = 2;
      creditJobs.push(lookupKey);
    }
    if (likely) {
      next.u = 1;
      next.c = likely.id;
      media.set(likely.id, likely);
    }
    matches.set(lookupKey, next);
    if (!match) return;
    media.set(match.id, match);
    for (const key of pending.get(lookupKey) ?? []) result.set(key, match);
  };

  for (let request = 0; fetchImpl && request < maxRequests && (jobs.length > 0 || creditJobs.length > 0); request += 1) {
    if (options.signal?.aborted) break;
    try {
      if (jobs.length > 0) {
        const batch = jobs.splice(0, TITLES_PER_SEARCH_REQUEST);
        const retries: typeof jobs = [];
        const variables: Record<string, string> = {};
        const selections = batch.map(({ lookupKey, shortQuery }, index) => {
          const entry = entryByLookupKey.get(lookupKey)!;
          // Comics leave novels out of the search, so a novel never crowds out its adaptation.
          const format = entry.medium === "novel" ? ", format: NOVEL" : ", format_not: NOVEL";
          variables[`q${index}`] = shortQuery ?? aniListSearchQuery(entry.title);
          return `r${index}: Page(perPage: ${RESULTS_PER_TITLE}) { media(search: $q${index}, type: MANGA${format}) { ...MediaProfile ${STAFF_FIELDS} } }
      a${index}: Page(perPage: ${ADULT_RESULTS_PER_TITLE}) { media(search: $q${index}, type: MANGA, isAdult: true${format}) { ...MediaProfile } }`;
        });
        const query = `query TitleMatches(${batch.map((_, index) => `$q${index}: String`).join(", ")}) {
      ${selections.join("\n      ")}
    }
    fragment MediaProfile on Media { ${MEDIA_PROFILE_FIELDS} }`;
        const data = await postAniList(fetchImpl, query, variables, options.signal, options.onResponse);
        if (!data) break;
        batch.forEach(({ lookupKey, shortQuery }, index) => {
          const page = data[`r${index}`];
          if (!page?.media) return;
          const entry = entryByLookupKey.get(lookupKey)!;
          const found = [...page.media, ...(data[`a${index}`]?.media ?? [])];
          const retryQuery = shortQuery ? null : shortSearchQuery(aniListTitleMatchKey(entry.title));
          if (found.length === 0 && retryQuery) {
            matches.set(lookupKey, { id: 0, at: nowMs, v: TITLE_MATCH_VERSION, s: 1 });
            retries.push({ lookupKey, shortQuery: retryQuery });
            return;
          }
          // The adult search also returns works the plain search found; one work is never a tie with itself.
          const profiles = new Map<number, AniListMediaProfile>();
          for (const item of found) {
            const profile = aniListMediaProfileFromPayload(item);
            if (profile && !profiles.get(profile.id)?.credits) profiles.set(profile.id, profile);
          }
          const judgement = judgeTitleMatch(entry.title, [...profiles.values()], entry, { exactOnly: Boolean(shortQuery), medium: entry.medium });
          record(lookupKey, judgement, true);
        });
        jobs.unshift(...retries);
      } else {
        const batch: Array<{ lookupKey: string; names: string[] }> = [];
        let nameCount = 0;
        while (creditJobs.length > 0) {
          const names = creditsOf(creditJobs[0]).slice(0, CREDITS_SEARCHED_PER_WORK);
          if (batch.length > 0 && nameCount + names.length > AUTHORS_PER_SEARCH_REQUEST) break;
          batch.push({ lookupKey: creditJobs.shift()!, names });
          nameCount += names.length;
        }
        const variables: Record<string, string> = {};
        const selections: string[] = [];
        for (const { names } of batch) {
          for (const name of names) {
            const index = selections.length;
            variables[`s${index}`] = name;
            selections.push(`s${index}: Page(perPage: 2) { staff(search: $s${index}) { name { full native alternative } staffMedia(type: MANGA, perPage: ${WORKS_PER_STAFF}) { nodes { ...MediaProfile } } } }`);
          }
        }
        const query = `query CreditedWorks(${selections.map((_, index) => `$s${index}: String`).join(", ")}) {
      ${selections.join("\n      ")}
    }
    fragment MediaProfile on Media { ${MEDIA_PROFILE_FIELDS} }`;
        const data = await postAniList(fetchImpl, query, variables, options.signal, options.onResponse) as unknown as Record<string, { staff?: StaffPayload[] | null } | null> | null;
        if (!data) {
          creditJobs.unshift(...batch.map((job) => job.lookupKey));
          break;
        }
        let index = 0;
        for (const { lookupKey, names } of batch) {
          const found = names.flatMap(() => data[`s${index++}`]?.staff ?? []);
          const entry = entryByLookupKey.get(lookupKey)!;
          const medium = entry.medium ?? "comic";
          const works = creditedWorks(creditsOf(lookupKey), found).filter((work) => fitsMedium(work, medium));
          const judgement = judgeTitleMatch(entry.title, works, entry, { medium });
          // The library's author has a single work of this kind: very likely the one read, under a
          // name AniList does not list (a translated title). A hint, never a match.
          const only = works.filter((work) => work.format !== "ONE_SHOT");
          record(lookupKey, { match: judgement.match, candidate: judgement.candidate ?? (only.length === 1 ? only[0] : null) }, false);
        }
      }
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

export type TitleMatchStatus = "matched" | "uncertain" | "missed" | "pending";

/**
 * Whether AniList matched a title for certain, knows only a work it might be ("uncertain", which
 * leaves the title pending for the library), settled that it has no such work, or is still to be
 * asked (never asked, a search left, or asked under older matching rules).
 */
export function aniListTitleStatus(title: string, medium: TitleMedium = "comic"): TitleMatchStatus {
  const key = titleLookupKey(title, medium);
  if (!key) return "missed";
  const cached = loadTitleMatchCache().get(key);
  if (!isSettled(cached)) return "pending";
  if (cached!.id > 0 && loadMediaCache().get(cached!.id)) return "matched";
  return cached!.u ? "uncertain" : "missed";
}

/** The AniList work a title was matched to for certain, without a request; null when unknown. */
export function cachedAniListTitleMatch(title: string, medium: TitleMedium = "comic"): AniListMediaProfile | null {
  const cached = loadTitleMatchCache().get(titleLookupKey(title, medium));
  return isSettled(cached) && cached!.id > 0 ? loadMediaCache().get(cached!.id) ?? null : null;
}

/** The AniList work a title most likely names when it names none for certain, as a hint only. */
export function cachedAniListTitleCandidate(title: string, medium: TitleMedium = "comic"): AniListMediaProfile | null {
  const cached = loadTitleMatchCache().get(titleLookupKey(title, medium));
  return isCurrent(cached) && cached.id === 0 && cached.c ? loadMediaCache().get(cached.c) ?? null : null;
}

/** Whether a title still waits for its lookup (never looked up, or looked up under older rules). */
export function isAniListTitlePending(title: string, medium: TitleMedium = "comic"): boolean {
  return aniListTitleStatus(title, medium) === "pending";
}

/** Number of titles still waiting for a lookup, for scheduling follow-up batches. */
export function pendingAniListTitleCount(titles: readonly string[], medium: TitleMedium = "comic"): number {
  return new Set(titles.filter((title) => isAniListTitlePending(title, medium)).map((title) => titleLookupKey(title, medium))).size;
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
