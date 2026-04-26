import { gql } from "../client";
import { FETCH_SOURCE_MANGA } from "../queries";
import type { Manga } from "../types";
import { resolveSearchResultsWithFallback } from "../search/queryFallback";

export async function fetchSourceMangaSearchWithFallback(input: {
  sourceId: string;
  query: string;
  signal?: AbortSignal;
}): Promise<Manga[]> {
  return resolveSearchResultsWithFallback(input.query, async (attemptTerm) => {
    const result = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
      FETCH_SOURCE_MANGA,
      { source: input.sourceId, type: "SEARCH", page: 1, query: attemptTerm },
      input.signal,
    );
    return result.fetchSourceManga.mangas ?? [];
  });
}
