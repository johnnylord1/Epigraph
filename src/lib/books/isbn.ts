function isValidIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const total = [...value].reduce((sum, character, index) => {
    const digit = character === "X" ? 10 : Number(character);
    return sum + digit * (10 - index);
  }, 0);
  return total % 11 === 0;
}

function isValidIsbn13(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  const total = [...value.slice(0, 12)].reduce(
    (sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (total % 10)) % 10 === Number(value[12]);
}

export function normalizeIsbn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replace(/[^0-9X]/g, "");
  if (normalized.length === 10 && isValidIsbn10(normalized)) return normalized;
  if (normalized.length === 13 && isValidIsbn13(normalized)) return normalized;
  return null;
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStrings(entry, depth + 1));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .flatMap((entry) => collectStrings(entry, depth + 1));
  }
  return [];
}

export function extractIsbns(...values: unknown[]): string[] {
  const result = new Set<string>();
  for (const text of values.flatMap((value) => collectStrings(value))) {
    const candidates = text.match(/(?:97[89][\s-]*)?\d[\d\s-]{7,}[\dXx]/g) ?? [text];
    for (const candidate of candidates) {
      const isbn = normalizeIsbn(candidate);
      if (isbn) result.add(isbn);
    }
  }
  return [...result];
}
