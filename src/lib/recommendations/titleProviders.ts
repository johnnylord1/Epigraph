import {
  aniListSearchQuery,
  aniListTitleMatchKey,
  aniListTitleStatus,
  cachedAniListTitleCandidate,
  cachedAniListTitleMatch,
  judgeTitleMatch,
  matchAniListTitles,
  titleLookupKey,
  type AniListMediaProfile,
  type AniListResponseInfo,
  type AniListTitleMatchEntry,
  type TitleJudgement,
  type TitleMatchStatus,
  type TitleMedium,
} from "./anilistMedia";
import { creditRelation, splitCredits } from "./credits";
import { KitsuRequestError, kitsuNovelProfile, searchKitsuNovels, type KitsuNovel } from "./kitsuNovels";
import { haveSameWords, isTranslatedTitle, titleCognates } from "./translatedTitles";

/**
 * Where library works are looked up, in order. Comics: AniList, then Kitsu, then MyAnimeList, then
 * the other trackers the user is logged in to on Suwayomi. Novels and books: Hardcover, the novel
 * section's own tracker, while it is connected, then Kitsu's novel catalogue (light and web novels)
 * and Open Library (books), which need no account, and last the author's works, for a novel a source
 * lists under a translated title. NovelUpdates has no API and turns programs away. AniList is never
 * asked about novels.
 * A work one provider does not know for certain is searched on the next, and so on until one
 * recognises it. Every provider's answer (misses and likely works included) is kept, so each work is
 * asked about once per provider. Nothing is ever tracked: a recognised work only feeds the
 * recommendations and the tracking panel's suggestion.
 */

export type TitleLookupStatus = TitleMatchStatus;

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
  /** 1 when that work only might be the one the title names: a hint, and the title stays pending. */
  u?: 1;
}

/** The library's novels and books, as Hardcover search answers them. */
export interface HardcoverBookResult {
  id: number;
  title: string;
  authors?: readonly string[] | null;
  genres?: readonly string[] | null;
}

/** Hardcover search through the user's connection; it throws `{ retryAfterMs }`-free errors when rate limited. */
export interface HardcoverTitleSearch {
  search(query: string): Promise<HardcoverBookResult[]>;
  /** Time to wait before the next search after an error, null when the error is not a rate limit. */
  retryAfterMs(error: unknown): number | null;
}

const PROVIDER_MATCH_STORAGE_KEY = "epigraph.recommendations.titleProviderMatch.v1";
// Each title is asked about again when the matching rules change, matches included.
const PROVIDER_MATCH_VERSION = 4;
const REQUEST_TIMEOUT_MS = 8_000;
const RESULTS_PER_TITLE = 5;
const MAX_STORED_TITLES = 16;
// AniList allowed 90 requests a minute for years and 30 lately; it says which in every answer.
const DEFAULT_ANILIST_PER_MINUTE = 30;
const KITSU_INTERVAL_MS = 300;
// Jikan allows three requests a second and sixty a minute.
const JIKAN_INTERVAL_MS = 1_100;
const SUWAYOMI_TRACKER_INTERVAL_MS = 700;
// Hardcover allows 60 requests a minute.
const HARDCOVER_INTERVAL_MS = 1_100;
const JIKAN_FAILURES_BEFORE_TRACKER = 2;
// Trackers whose Suwayomi search finds works by name. AniList, Kitsu and MyAnimeList are asked
// directly; library trackers (Komga, Kavita, Suwayomi) have no catalogue to search.
const SEARCHABLE_TRACKER_PATTERN = /mangaupdates|manga updates|shikimori|bangumi/i;
const NOVEL_PROVIDERS = new Set(["hardcover", "kitsu", "openlibrary", "author"]);
// Open Library asks for no more than one request a second.
const OPEN_LIBRARY_INTERVAL_MS = 1_100;
// An author's books on Open Library, one listing per edition or volume.
const AUTHOR_BOOKS_LIMIT = 20;
// Open Library's subjects mix genres with places, people and list names; only the genres are kept.
const OPEN_LIBRARY_GENRES: ReadonlyArray<[RegExp, string]> = [
  [/^(epic |high |urban |dark )?fantasy( fiction)?$/i, "Fantasy"],
  [/^(hard )?(science fiction|sci-fi)$/i, "Sci-Fi"],
  [/^(romance|love stories)( fiction)?$/i, "Romance"],
  [/^(mystery|detective)( fiction| and detective stories)?$/i, "Mystery"],
  [/^(thrillers?|suspense)( fiction)?$/i, "Thriller"],
  [/^horror( fiction| tales)?$/i, "Horror"],
  [/^historical fiction$/i, "Historical"],
  [/^adventure( fiction| stories)?$/i, "Adventure"],
  [/^(humou?r|humorous fiction|comedy)$/i, "Comedy"],
  [/^(drama|domestic fiction)$/i, "Drama"],
  [/^psychological fiction$/i, "Psychological"],
  [/^(young adult|young adult fiction)$/i, "Young Adult"],
  [/^(dystopias|dystopian fiction)$/i, "Dystopian"],
  [/^(magic|wizards)$/i, "Magic"],
];

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
// Each author's books, asked for once a session however many of their novels the library has.
const authorBooks = new Map<string, AniListMediaProfile[]>();

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
    ...(Array.isArray(item.credits) ? { credits: strings(item.credits) } : {}),
    ...(typeof item.hardcoverId === "number" ? { hardcoverId: item.hardcoverId } : {}),
    ...(typeof item.kitsuId === "number" ? { kitsuId: item.kitsuId } : {}),
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
      entries[provider] = { at: entry.at, v: entry.v, ...(profile ? { p: profile } : {}), ...(profile && entry.u === 1 ? { u: 1 as const } : {}) };
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
  authorBooks.clear();
}

/**
 * Whether a provider other than AniList recognised a title for certain, knows only a work it might
 * be, has none by it, or is still to be asked (never asked, or asked under older matching rules).
 */
export function providerTitleStatus(provider: string, title: string, medium: TitleMedium = "comic"): TitleLookupStatus {
  const key = titleLookupKey(title, medium);
  if (!key) return "missed";
  const entry = loadProviderMatches().get(key)?.[provider];
  if (!entry || entry.v < PROVIDER_MATCH_VERSION) return "pending";
  if (entry.p) return entry.u ? "uncertain" : "matched";
  return "missed";
}

/** Stores what a provider settled about a title: the work it names for certain, a likely work, or none. */
export function recordProviderTitleJudgement(
  provider: string,
  title: string,
  judgement: TitleJudgement,
  medium: TitleMedium = "comic",
  nowMs = Date.now(),
) {
  const key = titleLookupKey(title, medium);
  if (!key) return;
  const cache = loadProviderMatches();
  const entries = { ...(cache.get(key) ?? {}) };
  const work = judgement.match ?? judgement.candidate;
  entries[provider] = {
    at: nowMs,
    v: PROVIDER_MATCH_VERSION,
    ...(work ? { p: { ...work, provider } } : {}),
    ...(work && !judgement.match ? { u: 1 as const } : {}),
  };
  cache.set(key, entries);
  saveProviderMatches();
}

export function recordProviderTitleMatch(provider: string, title: string, profile: AniListMediaProfile | null, nowMs = Date.now()) {
  recordProviderTitleJudgement(provider, title, { match: profile, candidate: null }, "comic", nowMs);
}

function providerWorks(title: string, medium: TitleMedium, certain: boolean): AniListMediaProfile[] {
  const entries = loadProviderMatches().get(titleLookupKey(title, medium));
  if (!entries) return [];
  return Object.entries(entries)
    // Novels are recognised on their own providers only.
    .filter(([id, entry]) => entry.p && entry.v >= PROVIDER_MATCH_VERSION && Boolean(entry.u) !== certain && (medium === "comic" || NOVEL_PROVIDERS.has(id)))
    .sort(([a], [b]) => providerRank(a) - providerRank(b))
    .map(([, entry]) => entry.p!);
}

/** The work a library title was recognised as for certain by any provider, without a request; null when unknown. */
export function cachedLibraryTitleMatch(title: string, medium: TitleMedium = "comic"): AniListMediaProfile | null {
  return (medium === "comic" ? cachedAniListTitleMatch(title) : null) ?? providerWorks(title, medium, true)[0] ?? null;
}

/**
 * The work a library title most likely names when no provider recognised it for certain, for the
 * tracking panel to suggest. Never a match: the title stays pending and nothing is tracked.
 */
export function cachedLibraryTitleCandidate(title: string, medium: TitleMedium = "comic"): AniListMediaProfile | null {
  if (cachedLibraryTitleMatch(title, medium)) return null;
  return (medium === "comic" ? cachedAniListTitleCandidate(title) : null) ?? providerWorks(title, medium, false)[0] ?? null;
}

/** Cached matches of several titles, keyed by the caller's key. */
export function cachedLibraryTitleMatches(
  entries: ReadonlyArray<{ key: string; title: string }>,
  medium: TitleMedium = "comic",
): Map<string, AniListMediaProfile> {
  const result = new Map<string, AniListMediaProfile>();
  for (const entry of entries) {
    const profile = cachedLibraryTitleMatch(entry.title, medium);
    if (profile) result.set(entry.key, profile);
  }
  return result;
}

function providerRank(provider: string): number {
  if (provider === "kitsu") return 0;
  if (provider === "mal") return 1;
  if (provider === "hardcover") return 2;
  if (provider === "openlibrary") return 3;
  if (provider === "author") return 3.5;
  return 4 + Number(provider.replace(/^tracker:/, "") || 0) / 1e6;
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

/**
 * Kitsu works from a search answer, with their genres, their staff and the AniList and MAL ids Kitsu
 * maps them to.
 */
export function kitsuProfiles(payload: unknown): AniListMediaProfile[] {
  const body = (payload ?? {}) as { data?: KitsuResource[] | null; included?: KitsuResource[] | null };
  const included = new Map((body.included ?? []).map((item) => [`${item.type}:${item.id}`, item]));
  const resources = (owner: KitsuResource, name: string) => (owner.relationships?.[name]?.data ?? [])
    .map((ref) => included.get(`${ref.type}:${ref.id}`))
    .filter((value): value is KitsuResource => Boolean(value));
  const profiles: AniListMediaProfile[] = [];
  for (const item of body.data ?? []) {
    const attributes = item.attributes ?? {};
    const subtype = KITSU_SUBTYPES[String(attributes.subtype ?? "").toLowerCase()] ?? { format: "MANGA", country: "" };
    const related = (name: string) => resources(item, name).map((resource) => resource.attributes ?? {});
    const credits = splitCredits(resources(item, "staff")
      .flatMap((staff) => resources(staff, "person"))
      .map((person) => String(person.attributes?.name ?? "")));
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
      ...(credits.length > 0 ? { credits } : {}),
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
      authors?: Named[] | null;
    }> | null;
  };
  return (body.data ?? []).flatMap((item) => {
    if (typeof item.mal_id !== "number" || item.mal_id <= 0) return [];
    const { format, country } = jikanFormat(String(item.type ?? ""));
    const mainTitles = cleanTitles([item.title, item.title_english, item.title_japanese]);
    const names = (list: Named[] | null | undefined) => (list ?? []).map((entry) => entry.name);
    // MyAnimeList writes people "Last, First"; the comma is not a list.
    const credits = cleanTitles(names(item.authors).map((name) => String(name ?? "").replace(/,/g, " ")));
    return [{
      id: 0,
      idMal: item.mal_id,
      country,
      format,
      genres: cleanTitles([...names(item.genres), ...names(item.explicit_genres), ...names(item.themes)]),
      titles: cleanTitles([...mainTitles, ...(item.title_synonyms ?? []), ...(item.titles ?? []).map((entry) => entry.title)]).slice(0, MAX_STORED_TITLES),
      mainTitles,
      ...(credits.length > 0 ? { credits } : {}),
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

/** Books from a Hardcover search, which names each one once, with its authors. */
export function hardcoverProfiles(results: readonly HardcoverBookResult[]): AniListMediaProfile[] {
  return results.flatMap((book) => {
    const title = String(book.title ?? "").trim();
    if (!Number.isInteger(book.id) || book.id <= 0 || !title) return [];
    const credits = splitCredits([...(book.authors ?? [])]);
    return [{
      id: 0,
      idMal: null,
      country: "",
      format: "NOVEL",
      genres: cleanTitles([...(book.genres ?? [])]),
      titles: [title],
      mainTitles: [title],
      hardcoverId: book.id,
      ...(credits.length > 0 ? { credits } : {}),
    }];
  });
}

interface OpenLibraryWork {
  key?: string | null;
  title?: string | null;
  subtitle?: string | null;
  alternative_title?: string[] | null;
  author_name?: string[] | null;
  subject?: string[] | null;
}

/** Books from an Open Library search, with their authors and the genres among their subjects. */
export function openLibraryProfiles(payload: unknown): AniListMediaProfile[] {
  const body = (payload ?? {}) as { docs?: OpenLibraryWork[] | null };
  return (body.docs ?? []).flatMap((work) => {
    const title = String(work.title ?? "").trim();
    if (!title || !String(work.key ?? "").startsWith("/works/")) return [];
    const credits = splitCredits([...(work.author_name ?? [])]);
    const genres = cleanTitles((work.subject ?? []).flatMap((subject) =>
      OPEN_LIBRARY_GENRES.filter(([pattern]) => pattern.test(String(subject).trim())).map(([, genre]) => genre)));
    const mainTitles = cleanTitles([title, work.subtitle ? `${title}: ${work.subtitle}` : null]);
    return [{
      id: 0,
      idMal: null,
      country: "",
      format: "NOVEL",
      genres,
      titles: cleanTitles([...mainTitles, ...(work.alternative_title ?? [])]).slice(0, MAX_STORED_TITLES),
      mainTitles,
      ...(credits.length > 0 ? { credits } : {}),
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
    "include=categories,mappings,staff.person",
    "fields%5Bmanga%5D=canonicalTitle,titles,abbreviatedTitles,subtype,categories,mappings,staff",
    "fields%5Bcategories%5D=title",
    "fields%5Bmappings%5D=externalSite,externalId",
    "fields%5BmediaStaff%5D=person",
    "fields%5Bpeople%5D=name",
  ];
  const answer = await fetchJson(fetchImpl, `https://kitsu.io/api/edge/manga?${params.join("&")}`, { Accept: "application/vnd.api+json" });
  return answer.ok ? { ok: true, profiles: kitsuProfiles(answer.json) } : answer;
}

async function searchKitsuNovelCatalogue(fetchImpl: typeof fetch, query: string): Promise<ProviderSearch> {
  try {
    return { ok: true, profiles: (await searchKitsuNovels(query, RESULTS_PER_TITLE, { fetchImpl })).map(kitsuNovelProfile) };
  } catch (error) {
    return { ok: false, retryAfterMs: error instanceof KitsuRequestError ? error.retryAfterMs : null };
  }
}

async function searchOpenLibrary(fetchImpl: typeof fetch, query: string): Promise<ProviderSearch> {
  const fields = "key,title,subtitle,alternative_title,author_name,subject";
  const answer = await fetchJson(
    fetchImpl,
    `https://openlibrary.org/search.json?title=${encodeURIComponent(query)}&limit=${RESULTS_PER_TITLE}&fields=${fields}`,
    { Accept: "application/json" },
  );
  return answer.ok ? { ok: true, profiles: openLibraryProfiles(answer.json) } : answer;
}

async function searchOpenLibraryAuthor(fetchImpl: typeof fetch, author: string): Promise<ProviderSearch> {
  const key = author.trim().toLowerCase();
  const known = authorBooks.get(key);
  if (known) return { ok: true, profiles: known };
  const fields = "key,title,subtitle,alternative_title,author_name,subject";
  const answer = await fetchJson(
    fetchImpl,
    `https://openlibrary.org/search.json?author=${encodeURIComponent(author)}&limit=${AUTHOR_BOOKS_LIMIT}&fields=${fields}`,
    { Accept: "application/json" },
  );
  if (!answer.ok) return answer;
  const profiles = openLibraryProfiles(answer.json);
  authorBooks.set(key, profiles);
  return { ok: true, profiles };
}

/** The series a volume belongs to: "Lord of Mysteries, Vol. 2" is "Lord of Mysteries". */
export function seriesTitle(title: string): string {
  return title
    .replace(/[\s,:–-]*\b(?:vol(?:ume)?|book|part|livro)\.?\s*\d+\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

type AuthorJudgement = { ok: true; judgement: TitleJudgement } | { ok: false; retryAfterMs: number | null };

/**
 * An author's series as Kitsu's novel catalogue lists it, for its id and genres; null when Kitsu has
 * none by those words. The author already settled which work it is, so a main title with the same
 * words is enough, or else one that only adds a subtitle ("Apocalypse Bringer Mynoghra: World Conquest
 * Starts with…"). Kitsu's other names are left out: they name sequels after the first work.
 */
async function kitsuSeries(fetchImpl: typeof fetch, name: string): Promise<KitsuNovel | null> {
  const novels = await searchKitsuNovels(name, RESULTS_PER_TITLE, { fetchImpl });
  const withTitle = (same: (title: string) => boolean) => novels.find((novel) => novel.mainTitles.some(same));
  return withTitle((title) => haveSameWords(name, title))
    ?? withTitle((title) => haveSameWords(name, title.split(/\s*[:：~]\s*/)[0]))
    ?? null;
}

/**
 * Which of its author's works a novel listed under a translated title is ("Lorde dos Mistérios" is
 * Cuttlefish That Loves Diving's "Lord of Mysteries"). A work counts only when the library's author
 * wrote it and its title reads as a translation of the library's; one work of several is never picked
 * on a guess. Otherwise the author's closest work is a hint at most and the novel stays pending.
 * It costs one request per author, and one on Kitsu once a work is recognised; titles are compared here.
 */
async function judgeByAuthorWorks(fetchImpl: typeof fetch, entry: AniListTitleMatchEntry): Promise<AuthorJudgement> {
  const none: AuthorJudgement = { ok: true, judgement: { match: null, candidate: null } };
  const author = entry.credits?.[0];
  if (!author) return none;
  const answer = await searchOpenLibraryAuthor(fetchImpl, author);
  if (!answer.ok) return answer;
  // One listing per series, written by the library's author; manga adaptations are other works.
  const series = new Map<string, AniListMediaProfile>();
  for (const book of answer.profiles) {
    const title = book.mainTitles?.[0] ?? book.titles[0];
    if (!title || /\(manga\)/i.test(title) || creditRelation(entry.credits, book.credits) !== "match") continue;
    const name = seriesTitle(title);
    const key = aniListTitleMatchKey(name);
    if (key && !series.has(key)) series.set(key, { ...book, titles: cleanTitles([name, ...book.titles]), mainTitles: [name] });
  }
  const works = [...series.values()];
  if (works.length === 0) return none;

  const translated = works.filter((work) => work.titles.some((title) => isTranslatedTitle(entry.title, title)));
  if (translated.length === 1) {
    // The work as Kitsu's novel catalogue lists it, for its id and genres, when it does.
    const [work] = translated;
    try {
      const novel = await kitsuSeries(fetchImpl, work.mainTitles![0]);
      return { ok: true, judgement: { match: novel ? { ...kitsuNovelProfile(novel), credits: work.credits } : work, candidate: null } };
    } catch (error) {
      return { ok: false, retryAfterMs: error instanceof KitsuRequestError ? error.retryAfterMs : null };
    }
  }
  const closeness = (work: AniListMediaProfile) => Math.max(0, ...work.titles.map((title) => titleCognates(entry.title, title).pairs));
  const [closest] = [...(translated.length > 0 ? translated : works)].sort((a, b) => closeness(b) - closeness(a));
  // A work is suggested only when its title shares words with the library's; being the author's only one is no sign.
  const hinted = translated.length > 0 || closeness(closest) > 0;
  return { ok: true, judgement: { match: null, candidate: hinted ? closest : null } };
}

function authorWorksProvider(fetchImpl: typeof fetch): TitleProvider {
  return {
    id: "author",
    batchSize: 1,
    intervalMs: OPEN_LIBRARY_INTERVAL_MS,
    status: (entry) => providerTitleStatus("author", entry.title, "novel"),
    async lookUp(entries) {
      for (const entry of entries) {
        const answer = await judgeByAuthorWorks(fetchImpl, entry);
        if (!answer.ok) return { ok: false, retryAfterMs: answer.retryAfterMs };
        recordProviderTitleJudgement("author", entry.title, answer.judgement, "novel");
      }
      return { ok: true };
    },
  };
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
    batchSize: 16,
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
  medium: TitleMedium,
  search: (query: string) => Promise<ProviderSearch & { exactOnly?: boolean }>,
): TitleProvider {
  return {
    id,
    batchSize: 1,
    intervalMs,
    status: (entry) => providerTitleStatus(id, entry.title, medium),
    async lookUp(entries) {
      for (const entry of entries) {
        const answer = await search(aniListSearchQuery(entry.title));
        if (!answer.ok) return { ok: false, retryAfterMs: answer.retryAfterMs };
        const judgement = judgeTitleMatch(entry.title, answer.profiles, entry, { exactOnly: answer.exactOnly, medium });
        recordProviderTitleJudgement(id, entry.title, judgement, medium);
      }
      return { ok: true };
    },
  };
}

async function searchHardcover(hardcover: HardcoverTitleSearch, query: string): Promise<ProviderSearch> {
  try {
    return { ok: true, profiles: hardcoverProfiles(await hardcover.search(query)) };
  } catch (error) {
    return { ok: false, retryAfterMs: hardcover.retryAfterMs(error) };
  }
}

/**
 * The providers to ask, in order. AniList and Kitsu are public; MyAnimeList is asked through Jikan,
 * or through the user's MyAnimeList tracker while Jikan is down; MangaUpdates, Shikimori and Bangumi
 * only through a tracker the user is logged in to. Novels: Hardcover while it is connected, then
 * Kitsu's novel catalogue and Open Library, both public, then the author's works on both.
 */
export function titleProviderChain(
  trackers: readonly TitleProviderTracker[],
  deps: TitleProviderDeps & { hardcover?: HardcoverTitleSearch | null } = {},
  medium: TitleMedium = "comic",
): TitleProvider[] {
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  if (medium === "novel") {
    const hardcover = deps.hardcover;
    const novelChain: TitleProvider[] = [];
    if (hardcover) novelChain.push(singleTitleProvider("hardcover", HARDCOVER_INTERVAL_MS, medium, (query) => searchHardcover(hardcover, query)));
    if (fetchImpl) {
      novelChain.push(singleTitleProvider("kitsu", KITSU_INTERVAL_MS, medium, (query) => searchKitsuNovelCatalogue(fetchImpl, query)));
      novelChain.push(singleTitleProvider("openlibrary", OPEN_LIBRARY_INTERVAL_MS, medium, (query) => searchOpenLibrary(fetchImpl, query)));
      novelChain.push(authorWorksProvider(fetchImpl));
    }
    return novelChain;
  }
  const gql: GqlRequest = deps.gql ?? (async (query, variables) => (await import("../startupClient")).gql(query, variables));
  const loggedIn = trackers.filter((tracker) => tracker.isLoggedIn);
  const malTracker = loggedIn.find((tracker) => trackerKind(tracker) === "mal");
  const chain: TitleProvider[] = [aniListProvider(fetchImpl)];
  if (fetchImpl) chain.push(singleTitleProvider("kitsu", KITSU_INTERVAL_MS, medium, (query) => searchKitsu(fetchImpl, query)));

  if (fetchImpl || malTracker) {
    let jikanFailures = fetchImpl ? 0 : JIKAN_FAILURES_BEFORE_TRACKER;
    chain.push(singleTitleProvider("mal", JIKAN_INTERVAL_MS, medium, async (query) => {
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
    chain.push(singleTitleProvider(`tracker:${tracker.id}`, SUWAYOMI_TRACKER_INTERVAL_MS, medium, async (query) => ({
      ...(await searchTracker(gql, tracker.id, "generic", query)),
      exactOnly: true,
    })));
  }
  return chain;
}
