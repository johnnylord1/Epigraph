import { recommendationTagTokens } from "./metadata";
import type { TasteProfile } from "./types";

/** AniList's comic genres, without the adult ones. */
export const ANILIST_EXPLORATION_GENRES = [
  "Action",
  "Adventure",
  "Comedy",
  "Drama",
  "Fantasy",
  "Horror",
  "Mahou Shoujo",
  "Mecha",
  "Music",
  "Mystery",
  "Psychological",
  "Romance",
  "Sci-Fi",
  "Slice of Life",
  "Sports",
  "Supernatural",
  "Thriller",
] as const;

const MIN_EXPLORATION_SEEDS = 5;
// Only the rarest genres are worth exploring; the window rotates through them so the row changes.
const EXPLORATION_GENRE_POOL = 8;
// Same square-root scale as tag affinity in ranking: a genre at 4% of the reader's strongest
// still matches 0.2, so only genres below this can carry a title outside the reader's habits.
const RARE_GENRE_MATCH_MAX = 0.35;
const CORE_GENRE_MATCH_MIN = 0.85;
// Same count as the principal genres the page shows and the ranking keeps out of "outside".
const PRINCIPAL_GENRE_COUNT = 6;

export interface ExplorationGenres {
  /** Genres the reader rarely reads: a rotating window over the rarest ones. */
  include: string[];
  /** Genres the reader reads the most; titles carrying one of them are not outside the usual. */
  exclude: string[];
}

/**
 * Genres to search when looking for works outside the reader's habits. Catalogs trend toward
 * the same few genres a heavy reader already has, so without a search of its own the
 * "outside your usual reads" row has almost nothing to pick from.
 */
export function explorationGenres(
  profile: TasteProfile,
  options: { limit?: number; rotation?: number } = {},
): ExplorationGenres | null {
  if (profile.seedCount < MIN_EXPLORATION_SEEDS) return null;
  let strongest = 0;
  for (const weight of profile.tagWeights.values()) {
    if (weight > strongest) strongest = weight;
  }
  if (strongest <= 0) return null;

  // The reader's principal genres (the ones the page names as their taste) are never "outside".
  const principal = new Set(profile.topTags.slice(0, PRINCIPAL_GENRE_COUNT));
  const isPrincipal = (genre: string) => recommendationTagTokens(genre).some((token) => principal.has(token));
  const genres = ANILIST_EXPLORATION_GENRES.map((genre) => {
    const weights = recommendationTagTokens(genre).map((token) => profile.tagWeights.get(token) ?? 0);
    const disliked = weights.some((weight) => weight < 0);
    const match = Math.sqrt(Math.max(0, ...weights) / strongest);
    return { genre, match, disliked, principal: isPrincipal(genre) };
  });

  const rare = genres
    .filter((entry) => !entry.disliked && !entry.principal && entry.match < RARE_GENRE_MATCH_MAX)
    .sort((a, b) => a.match - b.match)
    .slice(0, EXPLORATION_GENRE_POOL)
    .map((entry) => entry.genre);
  if (rare.length === 0) return null;
  const limit = Math.min(options.limit ?? 4, rare.length);
  const start = Math.abs(Math.trunc(options.rotation ?? 0)) % rare.length;
  const include = Array.from({ length: limit }, (_, index) => rare[(start + index) % rare.length]);
  return {
    include,
    exclude: genres
      .filter((entry) => entry.match >= CORE_GENRE_MATCH_MIN || entry.principal)
      .map((entry) => entry.genre),
  };
}

export type ComicCountry = "JP" | "KR" | "CN";

export interface TasteCatalogRequest {
  /** AniList country of origin: Japan for manga, Korea for manhwa, China for manhua. */
  country: ComicCountry;
  /** One of the reader's strongest AniList genres (AniList's genre_in needs every listed genre). */
  genre: string;
  /** Pages of works the reader does not have yet to look for. */
  pages: number;
}

const TASTE_CATALOG_GENRE_LIMIT = 3;
const TASTE_CATALOG_PAGE_BUDGET = 6;
// Below this share of the library a format gets no search of its own.
const TASTE_CATALOG_MIN_SHARE = 0.1;
const COMIC_FORMAT_COUNTRIES: Array<["manga" | "manhwa" | "manhua", ComicCountry]> = [
  ["manga", "JP"],
  ["manhwa", "KR"],
  ["manhua", "CN"],
];

/**
 * The comic formats the library holds enough of to search apart, as AniList countries, most read
 * first. Catalogs sorted by score are mostly Japanese; asked per country, a manhwa reader's
 * searches bring manhwa in the library's proportions.
 */
export function comicFormatCountries(profile: TasteProfile): ComicCountry[] {
  const weights = COMIC_FORMAT_COUNTRIES.map(([format, country]) => ({
    country,
    weight: Math.max(0, profile.contentTypeWeights.get(format) ?? 0),
  }));
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return [];
  return weights
    .filter((entry) => entry.weight / total >= TASTE_CATALOG_MIN_SHARE)
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.country);
}

/**
 * Catalog searches that follow the reader's taste: their strongest genres, in each comic format
 * the library holds, with pages in proportion to it, shared out over the genres. Trending catalogs
 * are mostly Japanese and mostly what a heavy reader already has, so a manhwa reader would
 * otherwise get only manga.
 */
export function tasteCatalogRequests(profile: TasteProfile): TasteCatalogRequest[] {
  if (profile.seedCount < MIN_EXPLORATION_SEEDS) return [];
  const genres = ANILIST_EXPLORATION_GENRES
    .map((genre) => {
      const weights = recommendationTagTokens(genre).map((token) => profile.tagWeights.get(token) ?? 0);
      return { genre, weight: weights.some((weight) => weight < 0) ? 0 : Math.max(0, ...weights) };
    })
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TASTE_CATALOG_GENRE_LIMIT)
    .map((entry) => entry.genre);
  if (genres.length === 0) return [];

  const weights = COMIC_FORMAT_COUNTRIES.map(([format, country]) => ({
    country,
    weight: Math.max(0, profile.contentTypeWeights.get(format) ?? 0),
  }));
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return [];
  return weights
    .filter((entry) => entry.weight / total >= TASTE_CATALOG_MIN_SHARE)
    .flatMap((entry) => {
      const pages = Math.max(1, Math.round((entry.weight / total) * TASTE_CATALOG_PAGE_BUDGET));
      return genres
        .map((genre, index) => ({
          country: entry.country,
          genre,
          pages: Math.floor(pages / genres.length) + (index < pages % genres.length ? 1 : 0),
        }))
        .filter((request) => request.pages > 0);
    });
}
