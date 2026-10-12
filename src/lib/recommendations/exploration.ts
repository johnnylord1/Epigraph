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

  const genres = ANILIST_EXPLORATION_GENRES.map((genre) => {
    const weights = recommendationTagTokens(genre).map((token) => profile.tagWeights.get(token) ?? 0);
    const disliked = weights.some((weight) => weight < 0);
    const match = Math.sqrt(Math.max(0, ...weights) / strongest);
    return { genre, match, disliked };
  });

  const rare = genres
    .filter((entry) => !entry.disliked && entry.match < RARE_GENRE_MATCH_MAX)
    .sort((a, b) => a.match - b.match)
    .slice(0, EXPLORATION_GENRE_POOL)
    .map((entry) => entry.genre);
  if (rare.length === 0) return null;
  const limit = Math.min(options.limit ?? 4, rare.length);
  const start = Math.abs(Math.trunc(options.rotation ?? 0)) % rare.length;
  const include = Array.from({ length: limit }, (_, index) => rare[(start + index) % rare.length]);
  return {
    include,
    exclude: genres.filter((entry) => entry.match >= CORE_GENRE_MATCH_MIN).map((entry) => entry.genre),
  };
}
