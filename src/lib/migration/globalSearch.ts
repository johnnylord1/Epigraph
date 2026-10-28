import type { Manga } from "../types";
import { fetchSourceMangaSearchWithFallback } from "../manga/sourceSearch";
import { bestTitleScore } from "./titleMatcher";

export interface ScoredMangaResult {
  manga: Manga;
  similarity: number;
}

export interface SourceSearchOutcome {
  results: ScoredMangaResult[];
  error: string | null;
}

export interface SearchSourcesLiveInput {
  sourceIds: string[];
  query: string;
  /** The title the results are scored against: the work being migrated. */
  title: string;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  search?: typeof fetchSourceMangaSearchWithFallback;
  /** Called once per source as soon as that source answers, never after the signal aborts. */
  onSourceDone: (sourceId: string, outcome: SourceSearchOutcome) => void;
}

// Searches every source for the same query, a few at a time, and reports each source the moment
// it answers, so a slow or failing source never holds back the results of the others.
export async function searchSourcesLive(input: SearchSourcesLiveInput): Promise<void> {
  const search = input.search ?? fetchSourceMangaSearchWithFallback;
  const query = input.query.trim();
  const queue = [...input.sourceIds];
  const limit = Math.max(1, Math.min(input.concurrency ?? 4, queue.length));
  if (!query || queue.length === 0) return;

  const worker = async () => {
    while (queue.length > 0 && !input.signal?.aborted) {
      const sourceId = queue.shift()!;
      let outcome: SourceSearchOutcome;
      try {
        const mangas = await search({ sourceId, query, signal: input.signal, timeoutMs: input.timeoutMs ?? 15000 });
        outcome = {
          results: mangas
            .map((manga) => ({ manga, similarity: bestTitleScore(input.title, manga.title) }))
            .sort((left, right) => right.similarity - left.similarity),
          error: null,
        };
      } catch (error) {
        outcome = { results: [], error: error instanceof Error ? error.message : String(error) };
      }
      if (input.signal?.aborted) return;
      input.onSourceDone(sourceId, outcome);
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));
}
