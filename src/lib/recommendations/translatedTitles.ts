import { titleSimilarity } from "./anilistMedia";

/**
 * Whether a title in one language and a title in another name the same work. A library novel read
 * from a Brazilian source is listed under its Portuguese title ("Lorde dos Mistérios"), which the
 * catalogues do not know; they list it in English ("Lord of the Mysteries"). Without a dictionary,
 * their words are compared as cognates: lorde and lord, mistérios and mysteries.
 */

// Articles, prepositions and the like, in the languages sources and catalogues write titles in.
const STOP_WORDS = new Set([
  "the", "and", "for", "from", "into", "with", "that", "this", "was", "are", "his", "her",
  "dos", "das", "nos", "nas", "com", "como", "uma", "para", "pelo", "pela", "que", "seu", "sua", "mais",
  "los", "las", "del", "con", "por", "una",
]);
const MIN_WORD_LENGTH = 3;
const MIN_COGNATE_LENGTH = 4;
const COGNATE_SIMILARITY_MIN = 0.7;
// Two titles are translations of each other when most words of the shorter one have a cognate.
const TRANSLATED_TITLE_MIN_PAIRS = 2;
const TRANSLATED_TITLE_MIN_COVERAGE = 0.6;

function plain(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function contentWords(title: string): string[] {
  return plain(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(word));
}

// Spellings that differ between the languages for the same sound: mystery/mistério, mechanic/mecânico.
function spelling(word: string): string {
  return word
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/ch/g, "c")
    .replace(/[yk]/g, (letter) => (letter === "y" ? "i" : "c"))
    .replace(/(.)\1+/g, "$1");
}

/** Whether two words are the same word in two languages ("lorde" and "lord", "trono" and "throne"). */
export function areCognates(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < MIN_COGNATE_LENGTH) return false;
  const left = spelling(a);
  const right = spelling(b);
  if (left === right) return true;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  // A shared stem with only an ending apart: arcanista/arcana, misterios/misteries.
  if (prefix >= MIN_COGNATE_LENGTH && prefix >= Math.min(left.length, right.length) - 3) return true;
  return titleSimilarity(left, right) >= COGNATE_SIMILARITY_MIN;
}

/** How many words of two titles pair up as cognates, each word used once, and the share of the shorter title they cover. */
export function titleCognates(a: string, b: string): { pairs: number; coverage: number } {
  const left = contentWords(a);
  const right = contentWords(b);
  const used = new Set<number>();
  let pairs = 0;
  for (const word of left) {
    const index = right.findIndex((other, position) => !used.has(position) && areCognates(word, other));
    if (index < 0) continue;
    used.add(index);
    pairs += 1;
  }
  const shorter = Math.min(left.length, right.length);
  return { pairs, coverage: shorter > 0 ? pairs / shorter : 0 };
}

/** Whether one title reads as a translation of the other: most of their words are cognates. */
export function isTranslatedTitle(a: string, b: string): boolean {
  const { pairs, coverage } = titleCognates(a, b);
  return pairs >= TRANSLATED_TITLE_MIN_PAIRS && coverage >= TRANSLATED_TITLE_MIN_COVERAGE;
}

/**
 * Whether two titles say the same words, articles and spelling aside ("Lord of Mysteries", "Lord of
 * the Mysteries"); a number tells a sequel apart ("Lord of Mysteries 2").
 */
export function haveSameWords(a: string, b: string): boolean {
  const words = contentWords(a).length;
  const numbers = (title: string) => (title.match(/\d+/g) ?? []).map(Number).join(" ");
  return words > 0 && words === contentWords(b).length && numbers(a) === numbers(b) && titleCognates(a, b).pairs === words;
}
