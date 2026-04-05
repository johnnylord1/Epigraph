export function normalizeText(input: string | null | undefined): string {
  return (input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isNumericStub(input: string | null | undefined): boolean {
  const normalized = normalizeText(input);
  return !!normalized && /^\d+$/.test(normalized);
}

export function tokenize(input: string | null | undefined): string[] {
  return normalizeText(input)
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function diceCoefficient(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return (2 * overlap) / (aTokens.size + bTokens.size);
}

export function extractSlug(input: string | null | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const slashIndex = raw.lastIndexOf("/");
  const slug = slashIndex >= 0 ? raw.slice(slashIndex + 1) : raw;
  return normalizeText(slug.replace(/\.[a-z0-9]+$/i, ""));
}

export function safeNumberSimilarity(left: number | null | undefined, right: number | null | undefined): number {
  if (!left || !right || left <= 0 || right <= 0) return 0;
  const max = Math.max(left, right);
  const delta = Math.abs(left - right);
  return Math.max(0, 1 - delta / max);
}
