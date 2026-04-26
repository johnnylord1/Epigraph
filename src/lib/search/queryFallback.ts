const SEARCH_STOP_WORDS = new Set([
  "a",
  "as",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "in",
  "na",
  "no",
  "o",
  "of",
  "on",
  "os",
  "the",
  "to",
]);

function collapseSearchWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function removeSearchDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}+/gu, "");
}

function normalizeSearchSymbols(value: string): string {
  return collapseSearchWhitespace(value.replace(/[^\p{L}\p{N}]+/gu, " "));
}

function shouldKeepSearchToken(token: string): boolean {
  return token.length >= 4 && !SEARCH_STOP_WORDS.has(token.toLowerCase());
}

export function buildSearchAttemptTerms(searchTerm: string): string[] {
  const original = collapseSearchWhitespace(searchTerm);
  const normalizedSymbols = normalizeSearchSymbols(original);
  const accentFolded = removeSearchDiacritics(normalizedSymbols);
  const compact = normalizedSymbols.replace(/\s+/g, "");
  const accentFoldedCompact = accentFolded.replace(/\s+/g, "");
  const tokenFallbacks = accentFolded
    .split(" ")
    .filter((token) => shouldKeepSearchToken(token))
    .sort((left, right) => right.length - left.length)
    .slice(0, 2);

  return [...new Set([
    original,
    normalizedSymbols,
    accentFolded,
    ...tokenFallbacks,
    compact.length >= 4 ? compact : null,
    accentFoldedCompact.length >= 4 ? accentFoldedCompact : null,
  ].filter((value): value is string => Boolean(value)))];
}

export async function resolveSearchResultsWithFallback<TResult>(
  searchTerm: string,
  executeSearch: (attemptTerm: string) => Promise<TResult[]>,
): Promise<TResult[]> {
  const attemptTerms = buildSearchAttemptTerms(searchTerm);
  let lastError: unknown = null;
  let hadSuccessfulAttempt = false;

  for (const attemptTerm of attemptTerms) {
    try {
      const results = await executeSearch(attemptTerm);
      hadSuccessfulAttempt = true;
      if (results.length > 0) {
        return results;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!hadSuccessfulAttempt && lastError) {
    throw lastError;
  }

  return [];
}
