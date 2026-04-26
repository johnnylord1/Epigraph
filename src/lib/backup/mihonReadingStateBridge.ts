import type { ParsedBackup } from "../reconciliation/types";

export interface MihonReadingStateMangaRef {
  sourceId: string;
  mangaUrl: string;
  mangaTitle: string;
}

export interface MihonReadingStateChapterRef {
  chapterKey: string;
  chapterUrl: string | null;
  chapterName: string | null;
  chapterNumber: number | null;
  sourceOrder: string | null;
}

export interface MihonReadingProgressCandidate extends MihonReadingStateMangaRef, MihonReadingStateChapterRef {
  entityId: string;
  lastPageRead: number;
  read: boolean;
  lastModifiedAtMs: number | null;
}

export interface MihonReadingBookmarkCandidate extends MihonReadingStateMangaRef, MihonReadingStateChapterRef {
  entityId: string;
  bookmarked: true;
  lastModifiedAtMs: number | null;
}

export interface MihonReadingStateBridgeWarning {
  kind: "missing-manga-identity" | "missing-chapter-identity";
  message: string;
  mangaTitle: string | null;
}

export interface MihonReadingStateBridgeResult {
  progress: MihonReadingProgressCandidate[];
  bookmarks: MihonReadingBookmarkCandidate[];
  warnings: MihonReadingStateBridgeWarning[];
}

interface BackupMangaMessage {
  source?: unknown;
  url?: unknown;
  title?: unknown;
  chapters?: unknown;
}

interface BackupChapterMessage {
  url?: unknown;
  name?: unknown;
  read?: unknown;
  bookmark?: unknown;
  lastPageRead?: unknown;
  chapterNumber?: unknown;
  sourceOrder?: unknown;
  lastModifiedAt?: unknown;
  dateFetch?: unknown;
}

function intLikeToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value).toString() : "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && "toString" in value) {
    const text = String(value).trim();
    return text === "[object Object]" ? "" : text;
  }
  return "";
}

function intLikeToNumber(value: unknown): number {
  const text = intLikeToString(value);
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberField(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase();
}

function mangaEntityPrefix(sourceId: string, mangaUrl: string): string {
  return `mihon:${normalizeIdentityPart(sourceId)}:${normalizeIdentityPart(mangaUrl)}`;
}

function chapterIdentity(chapter: BackupChapterMessage): {
  chapterKey: string;
  chapterUrl: string | null;
  chapterName: string | null;
  chapterNumber: number | null;
  sourceOrder: string | null;
} | null {
  const chapterUrl = stringField(chapter.url);
  const chapterName = stringField(chapter.name);
  const chapterNumber = numberField(chapter.chapterNumber);
  const sourceOrder = intLikeToString(chapter.sourceOrder);
  const stablePart = chapterUrl || chapterName || (chapterNumber == null ? "" : String(chapterNumber)) || sourceOrder;

  if (!stablePart) return null;

  return {
    chapterKey: normalizeIdentityPart(stablePart),
    chapterUrl: chapterUrl || null,
    chapterName: chapterName || null,
    chapterNumber,
    sourceOrder: sourceOrder || null,
  };
}

function maxNullableNumber(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function chapterModifiedAt(chapter: BackupChapterMessage): number | null {
  const modified = intLikeToNumber(chapter.lastModifiedAt);
  const fetched = intLikeToNumber(chapter.dateFetch);
  const value = Math.max(modified, fetched);
  return value > 0 ? value : null;
}

function sortByMangaThenChapter<T extends MihonReadingStateMangaRef & MihonReadingStateChapterRef>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const manga = `${a.sourceId}\u0000${a.mangaUrl}\u0000${a.mangaTitle}`.localeCompare(`${b.sourceId}\u0000${b.mangaUrl}\u0000${b.mangaTitle}`);
    if (manga !== 0) return manga;
    const leftOrder = a.sourceOrder == null ? Number.MAX_SAFE_INTEGER : Number(a.sourceOrder);
    const rightOrder = b.sourceOrder == null ? Number.MAX_SAFE_INTEGER : Number(b.sourceOrder);
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    const leftChapter = a.chapterNumber ?? Number.MAX_SAFE_INTEGER;
    const rightChapter = b.chapterNumber ?? Number.MAX_SAFE_INTEGER;
    if (leftChapter !== rightChapter) return leftChapter - rightChapter;
    return a.chapterKey.localeCompare(b.chapterKey);
  });
}

export function extractMihonReadingStateForSync(parsed: Pick<ParsedBackup, "mangaMessages">): MihonReadingStateBridgeResult {
  const progressByEntity = new Map<string, MihonReadingProgressCandidate>();
  const bookmarksByEntity = new Map<string, MihonReadingBookmarkCandidate>();
  const warnings: MihonReadingStateBridgeWarning[] = [];

  for (const rawManga of parsed.mangaMessages) {
    const manga = rawManga as BackupMangaMessage;
    const sourceId = intLikeToString(manga.source);
    const mangaUrl = stringField(manga.url);
    const mangaTitle = stringField(manga.title);

    if (!sourceId || !mangaUrl) {
      warnings.push({
        kind: "missing-manga-identity",
        message: "A Mihon/Tachiyomi manga entry had no stable source/url identity.",
        mangaTitle: mangaTitle || null,
      });
      continue;
    }

    const chapters = Array.isArray(manga.chapters) ? manga.chapters as BackupChapterMessage[] : [];
    const prefix = mangaEntityPrefix(sourceId, mangaUrl);

    for (const chapter of chapters) {
      const identity = chapterIdentity(chapter);
      const lastPageRead = intLikeToNumber(chapter.lastPageRead);
      const isBookmarked = Boolean(chapter.bookmark);
      const isRead = Boolean(chapter.read);

      if (!identity) {
        if (lastPageRead > 0 || isBookmarked) {
          warnings.push({
            kind: "missing-chapter-identity",
            message: "A Mihon/Tachiyomi chapter with reading state had no stable chapter identity.",
            mangaTitle: mangaTitle || null,
          });
        }
        continue;
      }

      const entityId = `${prefix}:chapter:${identity.chapterKey}`;
      const base = {
        sourceId,
        mangaUrl,
        mangaTitle,
        ...identity,
      };
      const lastModifiedAtMs = chapterModifiedAt(chapter);

      if (lastPageRead > 0 || isRead) {
        const candidate: MihonReadingProgressCandidate = {
          ...base,
          entityId: `${entityId}:progress`,
          lastPageRead,
          read: isRead,
          lastModifiedAtMs,
        };
        const previous = progressByEntity.get(candidate.entityId);
        progressByEntity.set(candidate.entityId, previous
          ? {
              ...previous,
              lastPageRead: Math.max(previous.lastPageRead, candidate.lastPageRead),
              read: previous.read || candidate.read,
              lastModifiedAtMs: maxNullableNumber(previous.lastModifiedAtMs, candidate.lastModifiedAtMs),
            }
          : candidate);
      }

      if (isBookmarked) {
        const candidate: MihonReadingBookmarkCandidate = {
          ...base,
          entityId: `${entityId}:bookmark`,
          bookmarked: true,
          lastModifiedAtMs,
        };
        const previous = bookmarksByEntity.get(candidate.entityId);
        bookmarksByEntity.set(candidate.entityId, previous
          ? {
              ...previous,
              lastModifiedAtMs: maxNullableNumber(previous.lastModifiedAtMs, candidate.lastModifiedAtMs),
            }
          : candidate);
      }
    }
  }

  return {
    progress: sortByMangaThenChapter([...progressByEntity.values()]),
    bookmarks: sortByMangaThenChapter([...bookmarksByEntity.values()]),
    warnings,
  };
}
