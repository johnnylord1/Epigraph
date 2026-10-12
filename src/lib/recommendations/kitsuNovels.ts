import { judgeTitleMatch, type AniListMediaProfile, type AniListTitleHints } from "./anilistMedia";
import { splitCredits } from "./credits";
import { normalizeLogCount, normalizeRank, normalizeToken, normalizedMetric } from "./normalization";
import type { RecommendationCandidate, RecommendationProviderSignal } from "./types";

/**
 * Kitsu's novel catalogue: light novels and web novels, public and without an account. The novel
 * section uses it to recognise library novels and to rate and discover novels when Hardcover (the
 * novel tracker, which needs a token) is not connected. AniList is never asked about novels.
 */

export interface KitsuNovel {
  id: number;
  title: string;
  /** The work's own names (canonical, romaji, English, native). */
  mainTitles: string[];
  /** Its own names followed by the abbreviations. */
  titles: string[];
  /** Kitsu's average rating, 0-100; null until enough users rated it. */
  averageRating: number | null;
  userCount: number | null;
  popularityRank: number | null;
  categories: string[];
  credits: string[];
  coverUrl: string | null;
  startDate: string | null;
  status: string | null;
  adult: boolean;
}

interface KitsuResource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown> | null;
  relationships?: Record<string, { data?: KitsuReference | KitsuReference[] | null } | null> | null;
}

type KitsuReference = { id?: string; type?: string };

const KITSU_API = "https://kitsu.io/api/edge/manga";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_TITLES = 16;
// Kitsu's most read novels have a few tens of thousands of readers.
const POPULAR_USER_COUNT = 30_000;
const RANKED_NOVELS = 25_000;
const CACHE_STORAGE_KEY = "epigraph.recommendations.kitsuNovels.v1";
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const CACHE_MAX_QUERIES = 300;

const NOVEL_FIELDS = [
  "fields%5Bmanga%5D=canonicalTitle,titles,abbreviatedTitles,subtype,averageRating,userCount,popularityRank,startDate,status,ageRating,posterImage,categories,staff",
  "fields%5Bcategories%5D=title",
  "fields%5BmediaStaff%5D=person",
  "fields%5Bpeople%5D=name",
  "include=categories,staff.person",
];

function cleanList(list: unknown[]): string[] {
  return [...new Set(list.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

/** The novels of a Kitsu answer; works of any other kind are left out. */
export function kitsuNovels(payload: unknown): KitsuNovel[] {
  const body = (payload ?? {}) as { data?: KitsuResource[] | null; included?: KitsuResource[] | null };
  const included = new Map((body.included ?? []).map((item) => [`${item.type}:${item.id}`, item]));
  // A to-many relationship holds a list; a to-one relationship, such as a staff credit's person, one reference.
  const resources = (owner: KitsuResource, name: string) => [owner.relationships?.[name]?.data ?? []].flat()
    .map((ref) => included.get(`${ref.type}:${ref.id}`))
    .filter((value): value is KitsuResource => Boolean(value));
  return (body.data ?? []).flatMap((item) => {
    const attributes = item.attributes ?? {};
    const id = Number(item.id);
    if (String(attributes.subtype ?? "").toLowerCase() !== "novel" || !Number.isInteger(id) || id <= 0) return [];
    const titleMap = attributes.titles && typeof attributes.titles === "object" ? Object.values(attributes.titles as Record<string, unknown>) : [];
    const mainTitles = cleanList([attributes.canonicalTitle, ...titleMap]);
    if (mainTitles.length === 0) return [];
    const abbreviations = Array.isArray(attributes.abbreviatedTitles) ? attributes.abbreviatedTitles : [];
    const poster = attributes.posterImage && typeof attributes.posterImage === "object" ? attributes.posterImage as Record<string, unknown> : {};
    const ageRating = String(attributes.ageRating ?? "").toUpperCase();
    return [{
      id,
      title: mainTitles[0],
      mainTitles,
      titles: cleanList([...mainTitles, ...abbreviations]).slice(0, MAX_TITLES),
      averageRating: finiteNumber(attributes.averageRating),
      userCount: finiteNumber(attributes.userCount),
      popularityRank: finiteNumber(attributes.popularityRank),
      categories: cleanList(resources(item, "categories").map((category) => category.attributes?.title)),
      credits: splitCredits(resources(item, "staff")
        .flatMap((staff) => resources(staff, "person"))
        .map((person) => String(person.attributes?.name ?? ""))),
      coverUrl: String(poster.medium ?? poster.small ?? poster.original ?? "") || null,
      startDate: typeof attributes.startDate === "string" ? attributes.startDate : null,
      status: typeof attributes.status === "string" ? attributes.status : null,
      adult: ageRating === "R18",
    }];
  });
}

/** A Kitsu novel as a title-matching profile: a novel, never tied to an AniList entry. */
export function kitsuNovelProfile(novel: KitsuNovel): AniListMediaProfile {
  return {
    id: 0,
    idMal: null,
    country: "",
    format: "NOVEL",
    genres: novel.categories,
    titles: novel.titles,
    mainTitles: novel.mainTitles,
    kitsuId: novel.id,
    ...(novel.credits.length > 0 ? { credits: novel.credits } : {}),
  };
}

/** The novel a title certainly names among Kitsu's answers, or null (see judgeTitleMatch). */
export function matchKitsuNovel(title: string, novels: readonly KitsuNovel[], hints: AniListTitleHints = {}): KitsuNovel | null {
  const match = judgeTitleMatch(title, novels.map(kitsuNovelProfile), hints, { medium: "novel" }).match;
  return match ? novels.find((novel) => novel.id === match.kitsuId) ?? null : null;
}

/** Kitsu's category for a taste tag ("Slice of Life" is "slice-of-life"). */
export function kitsuCategorySlug(tag: string): string {
  return normalizeToken(tag).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

type CachedAnswer = { at: number; novels: KitsuNovel[] };
let answerCache: Map<string, CachedAnswer> | null = null;

function loadAnswerCache(): Map<string, CachedAnswer> {
  if (answerCache) return answerCache;
  answerCache = new Map();
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Record<string, CachedAnswer> : {};
    const now = Date.now();
    for (const [key, entry] of Object.entries(stored ?? {})) {
      if (entry && typeof entry.at === "number" && now - entry.at < CACHE_TTL_MS && Array.isArray(entry.novels)) {
        answerCache.set(key, entry);
      }
    }
  } catch {
    // Unreadable cache: ask Kitsu again.
  }
  return answerCache;
}

function rememberAnswer(key: string, novels: KitsuNovel[]) {
  const cache = loadAnswerCache();
  cache.delete(key);
  cache.set(key, { at: Date.now(), novels });
  while (cache.size > CACHE_MAX_QUERIES) cache.delete(cache.keys().next().value!);
  try {
    globalThis.localStorage?.setItem(CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Storage full or blocked: the in-memory cache still serves this session.
  }
}

export function resetKitsuNovelCacheForTests() {
  answerCache = null;
}

export interface KitsuRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Thrown when Kitsu does not answer; `retryAfterMs` is set when it asked to wait. */
export class KitsuRequestError extends Error {
  constructor(readonly retryAfterMs: number | null) {
    super("Kitsu did not answer");
  }
}

async function requestNovels(params: string[], options: KitsuRequestOptions): Promise<KitsuNovel[]> {
  const key = params.join("&");
  const cached = loadAnswerCache().get(key);
  if (cached) return cached.novels;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new KitsuRequestError(null);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort);
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${KITSU_API}?${[...params, ...NOVEL_FIELDS].join("&")}`, {
      headers: { Accept: "application/vnd.api+json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers?.get?.("retry-after") ?? NaN);
      throw new KitsuRequestError(Number.isFinite(retryAfter) ? retryAfter * 1000 : null);
    }
    const novels = kitsuNovels(await response.json());
    rememberAnswer(key, novels);
    return novels;
  } catch (error) {
    throw error instanceof KitsuRequestError ? error : new KitsuRequestError(null);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

/** Novels Kitsu finds by a title. */
export function searchKitsuNovels(query: string, limit: number, options: KitsuRequestOptions = {}): Promise<KitsuNovel[]> {
  const text = query.trim();
  if (!text) return Promise.resolve([]);
  return requestNovels([
    `filter%5Btext%5D=${encodeURIComponent(text)}`,
    "filter%5Bsubtype%5D=novel",
    `page%5Blimit%5D=${limit}`,
  ], options);
}

/**
 * The most read novels of a Kitsu category. Kitsu ignores a category it does not have and answers
 * with every novel, so only novels that carry the category are kept.
 */
export async function discoverKitsuNovels(
  category: string,
  limit: number,
  options: KitsuRequestOptions = {},
  offset = 0,
): Promise<KitsuNovel[]> {
  const slug = kitsuCategorySlug(category);
  if (!slug) return [];
  const novels = await requestNovels([
    `filter%5Bcategories%5D=${encodeURIComponent(slug)}`,
    "filter%5Bsubtype%5D=novel",
    "sort=popularityRank",
    `page%5Blimit%5D=${limit}`,
    ...(offset > 0 ? [`page%5Boffset%5D=${offset}`] : []),
  ], options);
  return novels.filter((novel) => novel.categories.some((title) => kitsuCategorySlug(title) === slug));
}

/** What Kitsu says of a novel: its rating, how many read it and how high it ranks. */
export function kitsuNovelToProvider(novel: KitsuNovel): RecommendationProviderSignal {
  const readers = novel.userCount ?? 0;
  // A rating from a handful of readers says little.
  const ratingConfidence = readers >= 1_000 ? 0.86 : readers >= 100 ? 0.72 : 0.5;
  return {
    providerId: "kitsu",
    providerName: "Kitsu",
    kind: "tracker",
    remoteId: String(novel.id),
    iconKey: "kitsu",
    ...(novel.averageRating != null
      ? { score: normalizedMetric(novel.averageRating / 100, ratingConfidence, "kitsu-average-rating", `${novel.averageRating}%`) }
      : {}),
    ...(readers > 0 ? { popularity: normalizeLogCount(readers, POPULAR_USER_COUNT, 0.7) } : {}),
    ...(novel.popularityRank ? { trending: normalizeRank(novel.popularityRank, RANKED_NOVELS, 0.36) } : {}),
  };
}

/** A novel Kitsu suggests for the reader's taste, as a recommendation. */
export function kitsuNovelToRecommendationCandidate(novel: KitsuNovel, queryTags: readonly string[] = []): RecommendationCandidate {
  const startedAt = novel.startDate ? Date.parse(novel.startDate) : NaN;
  const tags = [...new Set(["novel", ...novel.categories, ...queryTags])];
  return {
    id: `kitsu-novel:${novel.id}`,
    title: novel.title,
    alternativeTitles: novel.titles.filter((title) => title !== novel.title),
    coverUrl: novel.coverUrl,
    tags,
    contentType: "novel",
    status: novel.status,
    inLibrary: false,
    safety: novel.adult ? "adult" : "safe",
    publishedAtMs: Number.isFinite(startedAt) ? startedAt : null,
    format: "NOVEL",
    providers: [kitsuNovelToProvider(novel), {
      providerId: "kitsu-catalog",
      providerName: "Kitsu",
      kind: "source",
      remoteId: String(novel.id),
      availability: { value: 0.72, confidence: 0.6, method: "kitsu-catalog" },
    }],
  };
}
