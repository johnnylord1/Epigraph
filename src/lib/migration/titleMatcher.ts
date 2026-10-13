/**
 * Compares series titles as different sources write them: case, punctuation, dashes, quotes and
 * accents are ignored, and a title that only drops or adds a subtitle still matches, though less
 * strongly than the full title. Mirrors the mobile app's TitleMatcher.
 */

/** Lowest score a search result needs to be taken as the same series. */
export const MIN_TITLE_MATCH_SCORE = 0.5;

/** A score at which searching further queries cannot find a better match worth the wait. */
export const STRONG_TITLE_MATCH_SCORE = 0.9;

const BRACKETS = /[([{<][^)\]}>]*[)\]}>]/g;
// Where a subtitle usually starts: a dash, a colon, or "~".
const SUBTITLE_SPLIT = /\s+[-–—~]\s+|\s*[:：]\s+|\s*[–—~]\s*/;

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Similarity of two titles, from 0 (unrelated) to 1 (the same title). */
export function titleScore(lhs: string, rhs: string): number {
  const a = normalizeTitle(lhs);
  const b = normalizeTitle(rhs);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const edits = 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);

  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));
  const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
  const words = (2 * shared) / (wordsA.size + wordsB.size);

  // "Apotheosis" and "Apotheosis - Ascension to Godhood": one is the start of the other.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const prefix = long.startsWith(`${short} `) ? 0.5 + (0.4 * short.length) / long.length : 0;

  return Math.min(Math.max(edits, words, prefix), 0.99);
}

/** The main title without bracketed notes or a subtitle, when it differs from [title]. */
export function mainTitle(title: string): string | null {
  const withoutBrackets = title.replace(BRACKETS, " ").trim();
  const main = (withoutBrackets.split(SUBTITLE_SPLIT)[0] ?? "").trim();
  const normalized = normalizeTitle(main);
  return normalized && normalized !== normalizeTitle(title) ? main : null;
}

/**
 * Queries to try, in order, when searching another source for [title]: the title itself, then
 * plain-text forms that sources with strict keyword search can still find.
 */
export function titleSearchQueries(title: string): string[] {
  const plain = normalizeTitle(title);
  const main = mainTitle(title);
  const words = plain.split(" ");
  const firstWords = words.length > 4 ? words.slice(0, 4).join(" ") : null;
  const seen = new Set<string>();
  return [title.trim(), plain, main ? normalizeTitle(main) : null, firstWords]
    .filter((query): query is string => Boolean(query && query.trim()))
    .filter((query) => {
      const key = query.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Best score of [candidate] against [title] or its main title. */
export function bestTitleScore(title: string, candidate: string): number {
  const full = titleScore(title, candidate);
  const main = mainTitle(title);
  return Math.max(full, main ? titleScore(main, candidate) * 0.95 : 0);
}

/** Words of [title] long enough to tell two series apart ("a", "of" and the like are left out). */
export function significantWords(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(" ").filter((word) => word.length >= 3));
}

// "Alternative Names: a • b" on one line, or "**Alternative Names**:" followed by "- a" lines.
const ALTERNATIVE_NAMES_HEADER =
  /^[*_ \t]*(?:alternative|alternate|alt\.?|other|associated)[ \t]+(?:names?|titles?)[*_ \t]*:[*_ \t]*(.*)$/im;
const LIST_ITEM = /^\s*[-•*]\s+(.+)$/;
const INLINE_SEPARATORS = /\s*[•;|]\s*|\s+\/\s+/;

/** Other names of a series as sources list them in its description, or none when it has no such list. */
export function alternativeTitles(description: string | null | undefined): string[] {
  if (!description?.trim()) return [];
  const header = ALTERNATIVE_NAMES_HEADER.exec(description);
  if (!header) return [];
  const inline = (header[1] ?? "").trim();
  let names: string[];
  if (inline) {
    names = inline.split(INLINE_SEPARATORS);
  } else {
    names = [];
    const following = description.slice(header.index + header[0].length).split(/\r?\n/).slice(1);
    for (const line of following) {
      const item = LIST_ITEM.exec(line);
      if (!item) break;
      names.push(item[1]!);
    }
  }
  return [...new Set(names.map((name) => name.trim()).filter((name) => normalizeTitle(name)))];
}
