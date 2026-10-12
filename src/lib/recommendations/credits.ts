/**
 * Who made a work (authors, artists, studios), as evidence that two listings are the same work. A
 * title alone can name several works ("Chrysalis" is a web novel by RinoZ and another work's
 * abbreviation); the same author confirms the match, a different one rules it out.
 */

export type CreditRelation = "match" | "conflict" | "unknown";

// Sources fill the author field with these when they do not know it.
const PLACEHOLDER_CREDITS = new Set([
  "unknown",
  "unknow",
  "desconhecido",
  "desconocido",
  "autor desconhecido",
  "anonymous",
  "anonimo",
  "na",
  "none",
  "null",
  "tba",
  "tbd",
  "updating",
  "various",
  "varios",
  "author",
  "autor",
]);
// "Redice Studio" and "REDICE" are the same studio.
const IGNORED_CREDIT_WORDS = new Set(["studio", "studios", "estudio"]);
const MAX_CREDITS = 12;

function words(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word && !IGNORED_CREDIT_WORDS.has(word));
}

/**
 * Comparable forms of a name, so "Jung Yoon-Kang", "Yoon-Kang Jung", "Kim, Carnby" (MyAnimeList's
 * "last, first") and "Chu-Gong" / "Chugong" compare equal. Empty for placeholders.
 */
export function creditKeys(name: string): string[] {
  const list = words(name);
  const joined = list.join("");
  if (joined.length < 2 || PLACEHOLDER_CREDITS.has(list.join(" "))) return [];
  return [...new Set([joined, [...list].sort().join("")])];
}

/**
 * The names in what a source puts in its author or artist field: "Chugong, DUBU (Redice Studio)"
 * lists three. Placeholders ("Unknown", "Desconhecido") are left out.
 */
export function splitCredits(values: ReadonlyArray<string | null | undefined> | string | null | undefined): string[] {
  const list = typeof values === "string" ? [values] : values ?? [];
  const names: string[] = [];
  for (const value of list) {
    const text = String(value ?? "");
    const parts = text
      .replace(/[()（）[\]【】]/g, ",")
      .split(/[,;/|&、，・＆]|\s+(?:and|e|y|x|with)\s+/i);
    for (const part of parts) {
      const name = part.trim();
      if (name && creditKeys(name).length > 0 && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, MAX_CREDITS);
}

/**
 * Whether the library's credits and a work's agree: "match" when they share a name, "conflict" when
 * both name someone and nobody in common, "unknown" when either side names nobody.
 */
export function creditRelation(
  library: readonly string[] | null | undefined,
  work: readonly string[] | null | undefined,
): CreditRelation {
  const libraryKeys = new Set((library ?? []).flatMap(creditKeys));
  const workKeys = (work ?? []).flatMap(creditKeys);
  if (libraryKeys.size === 0 || workKeys.length === 0) return "unknown";
  return workKeys.some((key) => libraryKeys.has(key)) ? "match" : "conflict";
}
