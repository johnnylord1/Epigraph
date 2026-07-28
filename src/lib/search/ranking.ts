import { normalizeSearchText, searchTokens } from "./normalize";
import type { SearchContext, SearchResult } from "./types";

const CONTEXT_BOOST: Record<SearchContext, Record<string, number>> = {
  home: { library: 6, books: 6, browse: 4, settings: 3, downloads: 3, actions: 2 },
  library: { library: 8, books: 8, collections: 7 },
  browse: { browse: 8, sources: 7, filters: 6 },
  settings: { settings: 8 },
  downloads: { downloads: 8 },
};

function scoreField(query: string, value: string | undefined, exact: number, starts: number, partial: number): number {
  const normalizedValue = normalizeSearchText(value);
  if (!normalizedValue) return 0;
  if (normalizedValue === query) return exact;
  if (normalizedValue.startsWith(query)) return starts;
  if (normalizedValue.includes(query)) return partial;
  return 0;
}

export function scoreSearchResult(result: SearchResult, query: string, context: SearchContext): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  let matchScore = scoreField(normalizedQuery, result.title, 100, 80, 60);
  matchScore = Math.max(matchScore, scoreField(normalizedQuery, result.description, 28, 22, 16));
  matchScore += (result.keywords ?? []).reduce((best, keyword) => Math.max(best, scoreField(normalizedQuery, keyword, 34, 28, 20)), 0);
  const queryTokens = searchTokens(normalizedQuery);
  if (queryTokens.length > 1) {
    const searchable = normalizeSearchText([result.title, result.description, ...(result.keywords ?? [])].join(" "));
    if (queryTokens.every((token) => searchable.includes(token))) matchScore += 12;
  }
  if (matchScore <= 0) return 0;
  return matchScore + (CONTEXT_BOOST[context][result.group] ?? 0);
}

export function rankSearchResults(results: SearchResult[], query: string, context: SearchContext): SearchResult[] {
  const byId = new Map<string, SearchResult>();
  for (const result of results) {
    const score = scoreSearchResult(result, query, context);
    if (score <= 0) continue;
    const current = byId.get(result.id);
    if (!current || (current.score ?? 0) < score) byId.set(result.id, { ...result, score });
  }
  return [...byId.values()].sort((left, right) => {
    const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return left.title.localeCompare(right.title);
  });
}
