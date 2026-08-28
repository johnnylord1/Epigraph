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
  progressByBookId?: Map<string, BookProgress>;
  tagsByBookId?: Map<string, string[]>;
  extraCandidates?: RecommendationCandidate[];
  extraSeeds?: TasteProfileSeedItem[];
}

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
  const mangaCandidateOptions = {
    trackRecordsByMangaId: input.trackRecordsByMangaId,
    trackerNameById,
    trackerIconById,
    nowMs: options.nowMs,
  };

  const seeds = [
    ...(input.libraryManga ?? []).map((manga) =>
      mangaToTasteProfileSeed(manga, { trackRecordsByMangaId: input.trackRecordsByMangaId }),
    ),
    ...(input.libraryNovels ?? []).map(novelToTasteProfileSeed),
    ...(input.libraryBooks ?? []).map((book) =>
      bookToTasteProfileSeed(book, {
        progressByBookId: input.progressByBookId,
        tagsByBookId: input.tagsByBookId,
      }),
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
