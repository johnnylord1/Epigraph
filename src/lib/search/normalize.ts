const SEARCH_STOP_WORDS = new Set(["a", "as", "da", "das", "de", "do", "dos", "e", "em", "na", "no", "o", "of", "os", "the"]);

export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTokens(value: string | null | undefined): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !SEARCH_STOP_WORDS.has(token));
}

export function normalizedIncludes(haystack: string | null | undefined, needle: string): boolean {
  const normalizedNeedle = normalizeSearchText(needle);
  return normalizedNeedle.length > 0 && normalizeSearchText(haystack).includes(normalizedNeedle);
}
