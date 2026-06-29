import { gql } from "../client";
import { FETCH_SOURCE_MANGA } from "../queries";
import type { Manga } from "../types";
import { resolveSearchResultsWithFallback } from "../search/queryFallback";

export async function fetchSourceMangaSearchWithFallback(input: {
  sourceId: string;
  query: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Manga[]> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 18000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", abortFromParent, { once: true });

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    return await resolveSearchResultsWithFallback(input.query, async (attemptTerm) => {
      const result = await gql<{ fetchSourceManga: { mangas: Manga[] } }>(
        FETCH_SOURCE_MANGA,
        { source: input.sourceId, type: "SEARCH", page: 1, query: attemptTerm },
        controller.signal,
      );
      return result.fetchSourceManga.mangas ?? [];
    });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}
