import type { Manga, TrackRecord, TrackSearch, Tracker } from "../types";
import type { BookEntry, BookProgress } from "../books/types";
import type { PersistedNovelLibraryEntry } from "../novels/domain";
import {
  bookToRecommendationCandidate,
  bookToTasteProfileSeed,
  mangaToRecommendationCandidate,
  mangaToTasteProfileSeed,
  mergeRecommendationCandidates,
  novelToRecommendationCandidate,
  novelToTasteProfileSeed,
  trackerSearchToRecommendationCandidate,
} from "./adapters";
import type { AniListMediaProfile } from "./anilistMedia";
import type { ComicOriginsByTrackerEntry } from "./comicOrigin";
import { buildRecommendationSections } from "./ranking";
import { buildTasteProfile } from "./tasteProfile";
import type {
  BuildRecommendationSectionsOptions,
  RecommendationCandidate,
  RecommendationSection,
  TasteProfile,
  TasteProfileSeedItem,
} from "./types";

export interface SearchRecommendationInput {
  libraryManga?: Manga[];
  libraryNovels?: PersistedNovelLibraryEntry[];
  libraryBooks?: BookEntry[];
  sourceResults?: Manga[];
  trackerResults?: TrackSearch[];
  trackers?: Tracker[];
  trackRecordsByMangaId?: Map<number, TrackRecord[]>;
  /** Country-of-origin formats for tracker entries; outranks source and tag guesses. */
  comicOrigins?: ComicOriginsByTrackerEntry;
  /** AniList genres, titles and country per manga id; fills works the sources describe poorly. */
  aniListByMangaId?: ReadonlyMap<number, AniListMediaProfile>;
  progressByBookId?: Map<string, BookProgress>;
  tagsByBookId?: Map<string, string[]>;
  extraCandidates?: RecommendationCandidate[];
  extraSeeds?: TasteProfileSeedItem[];
  /**
   * The user's rating and status on the tracker a library novel or book is tracked on, by its seed id
   * ("novel:<id>", "book:<id>"): their opinion of the library work itself.
   */
  trackedOpinions?: ReadonlyMap<string, TrackedOpinion>;
}

export type TrackedOpinion = Pick<TasteProfileSeedItem, "userRating" | "userRatingMax" | "status">;

export interface SearchRecommendationResult {
  profile: TasteProfile;
  candidates: RecommendationCandidate[];
  sections: RecommendationSection[];
}

export function buildSearchRecommendations(
  input: SearchRecommendationInput,
  options: BuildRecommendationSectionsOptions = {},
): SearchRecommendationResult {
  const trackerNameById = new Map((input.trackers ?? []).map((tracker) => [tracker.id, tracker.name]));
  const trackerIconById = new Map((input.trackers ?? []).map((tracker) => [tracker.id, tracker.icon || tracker.name]));
  const trackerStatusNamesById = new Map((input.trackers ?? []).map((tracker) => [
    tracker.id,
    new Map((tracker.statuses ?? []).map((status) => [status.value, status.name])),
  ]));
  const mangaCandidateOptions = {
    trackRecordsByMangaId: input.trackRecordsByMangaId,
    trackerNameById,
    trackerIconById,
    nowMs: options.nowMs,
    comicOrigins: input.comicOrigins,
    aniListByMangaId: input.aniListByMangaId,
  };

  const withOpinion = (seed: TasteProfileSeedItem): TasteProfileSeedItem => {
    const opinion = input.trackedOpinions?.get(seed.id);
    if (!opinion) return seed;
    return {
      ...seed,
      ...(opinion.userRating != null ? { userRating: opinion.userRating, userRatingMax: opinion.userRatingMax } : {}),
      ...(opinion.status && opinion.status !== "unknown" ? { status: opinion.status } : {}),
    };
  };
  const seeds = [
    ...(input.libraryManga ?? []).map((manga) =>
      mangaToTasteProfileSeed(manga, {
        trackRecordsByMangaId: input.trackRecordsByMangaId,
        trackerStatusNamesById,
        comicOrigins: input.comicOrigins,
        aniListByMangaId: input.aniListByMangaId,
      }),
    ),
    ...(input.libraryNovels ?? []).map((novel) => withOpinion(novelToTasteProfileSeed(novel))),
    ...(input.libraryBooks ?? []).map((book) =>
      withOpinion(bookToTasteProfileSeed(book, {
        progressByBookId: input.progressByBookId,
        tagsByBookId: input.tagsByBookId,
      })),
    ),
    ...(input.extraSeeds ?? []),
  ];

  const profile = buildTasteProfile(seeds);
  const candidates = mergeRecommendationCandidates([
    ...(input.sourceResults ?? []).map((manga) => mangaToRecommendationCandidate(manga, mangaCandidateOptions)),
    ...(input.trackerResults ?? []).map((result) =>
      trackerSearchToRecommendationCandidate(result, { trackerNameById, trackerIconById }),
    ),
    ...(input.libraryManga ?? []).map((manga) => mangaToRecommendationCandidate(manga, mangaCandidateOptions)),
    ...(input.libraryNovels ?? []).map(novelToRecommendationCandidate),
    ...(input.libraryBooks ?? []).map(bookToRecommendationCandidate),
    ...(input.extraCandidates ?? []),
  ]);

  return {
    profile,
    candidates,
    sections: buildRecommendationSections(candidates, profile, options),
  };
}
