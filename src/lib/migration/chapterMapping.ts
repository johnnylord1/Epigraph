import type { NovelDetailChapter, PersistedNovelChapterEntry } from "../novels/domain";
import type { Chapter } from "../types";

export type MangaChapterMatchReason =
  | "real-url"
  | "chapter-number"
  | "chapter-number-title-scanlator"
  | "chapter-number-title"
  | "chapter-number-scanlator";

export interface MangaChapterMatch {
  oldChapter: Chapter;
  newChapter: Chapter;
  reason: MangaChapterMatchReason;
}

export type NovelChapterMatchReason =
  | "path-title"
  | "chapter-number"
  | "chapter-number-title"
  | "chapter-number-order"
  | "title"
  | "title-order";

export interface NovelChapterMatch {
  oldChapter: PersistedNovelChapterEntry;
  newChapter: NovelDetailChapter;
  reason: NovelChapterMatchReason;
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeUrl(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function finiteNumberKey(value: number): string | null {
  return Number.isFinite(value) ? String(value) : null;
}

function extractedChapterNumber(value: string): string | null {
  const normalized = normalizeText(value);
  const marked = normalized.match(
    /\b(?:chapter|chap|ch|capitulo|cap|episode|ep)\s*(\d+(?:[.,]\d+)?)\b/,
  );
  const raw = marked?.[1] ?? (/^\d+(?:[.,]\d+)?$/.test(normalized) ? normalized : null);
  if (!raw) return null;
  const parsed = Number(raw.replace(",", "."));
  return finiteNumberKey(parsed);
}

function pairUniqueByKey<TOld, TNew, TReason extends string>(input: {
  oldItems: readonly TOld[];
  newItems: readonly TNew[];
  oldUsed: Set<TOld>;
  newUsed: Set<TNew>;
  oldKey: (item: TOld) => string | null;
  newKey: (item: TNew) => string | null;
  reason: TReason;
  add: (oldItem: TOld, newItem: TNew, reason: TReason) => void;
}): void {
  const oldByKey = new Map<string, TOld[]>();
  const newByKey = new Map<string, TNew[]>();

  for (const item of input.oldItems) {
    if (input.oldUsed.has(item)) continue;
    const key = input.oldKey(item);
    if (!key) continue;
    oldByKey.set(key, [...(oldByKey.get(key) ?? []), item]);
  }
  for (const item of input.newItems) {
    if (input.newUsed.has(item)) continue;
    const key = input.newKey(item);
    if (!key) continue;
    newByKey.set(key, [...(newByKey.get(key) ?? []), item]);
  }

  for (const [key, oldMatches] of oldByKey) {
    const newMatches = newByKey.get(key) ?? [];
    if (oldMatches.length !== 1 || newMatches.length !== 1) continue;
    input.add(oldMatches[0]!, newMatches[0]!, input.reason);
  }
}

export function matchMangaChapters(
  oldChapters: readonly Chapter[],
  newChapters: readonly Chapter[],
): MangaChapterMatch[] {
  const matches: MangaChapterMatch[] = [];
  const oldUsed = new Set<Chapter>();
  const newUsed = new Set<Chapter>();
  const add = (oldChapter: Chapter, newChapter: Chapter, reason: MangaChapterMatchReason) => {
    if (oldUsed.has(oldChapter) || newUsed.has(newChapter)) return;
    oldUsed.add(oldChapter);
    newUsed.add(newChapter);
    matches.push({ oldChapter, newChapter, reason });
  };

  pairUniqueByKey({
    oldItems: oldChapters,
    newItems: newChapters,
    oldUsed,
    newUsed,
    oldKey: (chapter) => normalizeUrl(chapter.realUrl),
    newKey: (chapter) => normalizeUrl(chapter.realUrl),
    reason: "real-url",
    add,
  });

  const oldByNumber = new Map<string, Chapter[]>();
  const newByNumber = new Map<string, Chapter[]>();
  for (const chapter of oldChapters) {
    if (oldUsed.has(chapter)) continue;
    const key = finiteNumberKey(chapter.chapterNumber);
    if (key) oldByNumber.set(key, [...(oldByNumber.get(key) ?? []), chapter]);
  }
  for (const chapter of newChapters) {
    if (newUsed.has(chapter)) continue;
    const key = finiteNumberKey(chapter.chapterNumber);
    if (key) newByNumber.set(key, [...(newByNumber.get(key) ?? []), chapter]);
  }

  for (const [numberKey, oldGroup] of oldByNumber) {
    const newGroup = newByNumber.get(numberKey) ?? [];
    if (oldGroup.length === 1 && newGroup.length === 1) {
      add(oldGroup[0]!, newGroup[0]!, "chapter-number");
      continue;
    }
    if (newGroup.length === 0) continue;

    pairUniqueByKey({
      oldItems: oldGroup,
      newItems: newGroup,
      oldUsed,
      newUsed,
      oldKey: (chapter) => {
        const title = normalizeText(chapter.name);
        const scanlator = normalizeText(chapter.scanlator);
        return title && scanlator ? `${title}|${scanlator}` : null;
      },
      newKey: (chapter) => {
        const title = normalizeText(chapter.name);
        const scanlator = normalizeText(chapter.scanlator);
        return title && scanlator ? `${title}|${scanlator}` : null;
      },
      reason: "chapter-number-title-scanlator",
      add,
    });
    pairUniqueByKey({
      oldItems: oldGroup,
      newItems: newGroup,
      oldUsed,
      newUsed,
      oldKey: (chapter) => normalizeText(chapter.name) || null,
      newKey: (chapter) => normalizeText(chapter.name) || null,
      reason: "chapter-number-title",
      add,
    });
    pairUniqueByKey({
      oldItems: oldGroup,
      newItems: newGroup,
      oldUsed,
      newUsed,
      oldKey: (chapter) => normalizeText(chapter.scanlator) || null,
      newKey: (chapter) => normalizeText(chapter.scanlator) || null,
      reason: "chapter-number-scanlator",
      add,
    });
  }

  return matches;
}

export function matchNovelChapters(
  oldChapters: readonly PersistedNovelChapterEntry[],
  newChapters: readonly NovelDetailChapter[],
): NovelChapterMatch[] {
  const matches: NovelChapterMatch[] = [];
  const oldUsed = new Set<PersistedNovelChapterEntry>();
  const newUsed = new Set<NovelDetailChapter>();
  const add = (
    oldChapter: PersistedNovelChapterEntry,
    newChapter: NovelDetailChapter,
    reason: NovelChapterMatchReason,
  ) => {
    if (oldUsed.has(oldChapter) || newUsed.has(newChapter)) return;
    oldUsed.add(oldChapter);
    newUsed.add(newChapter);
    matches.push({ oldChapter, newChapter, reason });
  };

  pairUniqueByKey({
    oldItems: oldChapters,
    newItems: newChapters,
    oldUsed,
    newUsed,
    oldKey: (chapter) => {
      const path = normalizeText(chapter.path);
      const title = normalizeText(chapter.title);
      return path && title ? `${path}|${title}` : null;
    },
    newKey: (chapter) => {
      const path = normalizeText(chapter.path);
      const title = normalizeText(chapter.title);
      return path && title ? `${path}|${title}` : null;
    },
    reason: "path-title",
    add,
  });

  pairUniqueByKey({
    oldItems: oldChapters,
    newItems: newChapters,
    oldUsed,
    newUsed,
    oldKey: (chapter) => {
      const number = extractedChapterNumber(chapter.title);
      const title = normalizeText(chapter.title);
      return number && title ? `${number}|${title}` : null;
    },
    newKey: (chapter) => {
      const number = extractedChapterNumber(chapter.title);
      const title = normalizeText(chapter.title);
      return number && title ? `${number}|${title}` : null;
    },
    reason: "chapter-number-title",
    add,
  });

  pairUniqueByKey({
    oldItems: oldChapters,
    newItems: newChapters,
    oldUsed,
    newUsed,
    oldKey: (chapter) => extractedChapterNumber(chapter.title),
    newKey: (chapter) => extractedChapterNumber(chapter.title),
    reason: "chapter-number",
    add,
  });

  const oldNumberGroups = new Map<string, PersistedNovelChapterEntry[]>();
  const newNumberGroups = new Map<string, NovelDetailChapter[]>();
  for (const chapter of oldChapters) {
    if (oldUsed.has(chapter)) continue;
    const key = extractedChapterNumber(chapter.title);
    if (key) oldNumberGroups.set(key, [...(oldNumberGroups.get(key) ?? []), chapter]);
  }
  for (const chapter of newChapters) {
    if (newUsed.has(chapter)) continue;
    const key = extractedChapterNumber(chapter.title);
    if (key) newNumberGroups.set(key, [...(newNumberGroups.get(key) ?? []), chapter]);
  }
  for (const [numberKey, oldGroup] of oldNumberGroups) {
    const newGroup = newNumberGroups.get(numberKey) ?? [];
    pairUniqueByKey({
      oldItems: oldGroup,
      newItems: newGroup,
      oldUsed,
      newUsed,
      oldKey: (chapter) => finiteNumberKey(chapter.order),
      newKey: (chapter) => finiteNumberKey(chapter.order),
      reason: "chapter-number-order",
      add,
    });
  }

  pairUniqueByKey({
    oldItems: oldChapters,
    newItems: newChapters,
    oldUsed,
    newUsed,
    oldKey: (chapter) => normalizeText(chapter.title) || null,
    newKey: (chapter) => normalizeText(chapter.title) || null,
    reason: "title",
    add,
  });

  const oldTitleGroups = new Map<string, PersistedNovelChapterEntry[]>();
  const newTitleGroups = new Map<string, NovelDetailChapter[]>();
  for (const chapter of oldChapters) {
    if (oldUsed.has(chapter)) continue;
    const key = normalizeText(chapter.title);
    if (key) oldTitleGroups.set(key, [...(oldTitleGroups.get(key) ?? []), chapter]);
  }
  for (const chapter of newChapters) {
    if (newUsed.has(chapter)) continue;
    const key = normalizeText(chapter.title);
    if (key) newTitleGroups.set(key, [...(newTitleGroups.get(key) ?? []), chapter]);
  }
  for (const [titleKey, oldGroup] of oldTitleGroups) {
    const newGroup = newTitleGroups.get(titleKey) ?? [];
    pairUniqueByKey({
      oldItems: oldGroup,
      newItems: newGroup,
      oldUsed,
      newUsed,
      oldKey: (chapter) => finiteNumberKey(chapter.order),
      newKey: (chapter) => finiteNumberKey(chapter.order),
      reason: "title-order",
      add,
    });
  }

  return matches;
}
