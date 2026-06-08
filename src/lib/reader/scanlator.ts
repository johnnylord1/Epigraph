import type { Chapter } from "../types";

export interface MangaReaderPreference {
  preferredScanlator: string;
  scanlatorFilter: string[];
}

function normalizeScanlator(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function effectiveScanlator(chapter: Pick<Chapter, "scanlator">, fallback?: string | null): string {
  return normalizeScanlator(chapter.scanlator) || normalizeScanlator(fallback);
}

export function listScanlators(chapters: Chapter[], fallback?: string | null): string[] {
  return Array.from(
    new Set(
      chapters
        .map((chapter) => effectiveScanlator(chapter, fallback))
        .filter((value): value is string => value.length > 0),
    ),
  );
}

export function normalizeMangaReaderPreference(
  value: Partial<MangaReaderPreference> | null | undefined,
): MangaReaderPreference {
  const preferredScanlator = normalizeScanlator(value?.preferredScanlator);
  const scanlatorFilter = Array.isArray(value?.scanlatorFilter)
    ? Array.from(
        new Set(
          value.scanlatorFilter
            .map((entry) => normalizeScanlator(entry))
            .filter((entry): entry is string => entry.length > 0),
        ),
      )
    : [];

  return {
    preferredScanlator,
    scanlatorFilter,
  };
}

export function buildReaderChapterList(
  chapters: Chapter[],
  prefs: Partial<MangaReaderPreference> | null | undefined,
  fallbackScanlator?: string | null,
): Chapter[] {
  const normalizedPrefs = normalizeMangaReaderPreference(prefs);
  const filterSet = new Set(normalizedPrefs.scanlatorFilter);

  const canonical = [...chapters]
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .filter((chapter) => {
      if (filterSet.size === 0) return true;
      return filterSet.has(effectiveScanlator(chapter, fallbackScanlator));
    });

  if (!normalizedPrefs.preferredScanlator) return canonical;

  const grouped = new Map<string, Chapter[]>();
  const order: string[] = [];

  for (const chapter of canonical) {
    const key = String(chapter.chapterNumber);
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key)!.push(chapter);
  }

  return order.flatMap((key) => {
    const group = grouped.get(key) ?? [];
    const preferred = group.filter(
      (chapter) => effectiveScanlator(chapter, fallbackScanlator) === normalizedPrefs.preferredScanlator,
    );
    const remaining = group.filter(
      (chapter) => effectiveScanlator(chapter, fallbackScanlator) !== normalizedPrefs.preferredScanlator,
    );
    return [...preferred, ...remaining];
  });
}

export function resolveReaderChapterTarget(chapter: Chapter, chapterList: Chapter[]): Chapter | null {
  const exact = chapterList.find((entry) => entry.id === chapter.id);
  if (exact) return exact;
  if (chapterList.length === 0) return null;

  let closest = chapterList[0];
  let bestDistance = Math.abs(chapterList[0].sourceOrder - chapter.sourceOrder);

  for (const candidate of chapterList.slice(1)) {
    const distance = Math.abs(candidate.sourceOrder - chapter.sourceOrder);
    if (distance < bestDistance) {
      closest = candidate;
      bestDistance = distance;
    }
  }

  return closest;
}
