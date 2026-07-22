import { createBookSectionSnapshot, needsBookSectionBackfill } from "./summary";
import type { BookEntry } from "./types";

export const BOOK_METADATA_BACKFILL_VERSION = 2;

export function isUsableBookCoverUrl(coverUrl: string | null | undefined): boolean {
  return typeof coverUrl === "string" && coverUrl.startsWith("data:image/") && coverUrl.length > 64;
}

export function isCanonicalBookVisualState(book: Pick<BookEntry, "coverPath" | "coverUrl">): boolean {
  if (book.coverPath) return true;
  return !isUsableBookCoverUrl(book.coverUrl);
}

export function needsBookMetadataBackfill(
  book: Pick<BookEntry, "assetPath" | "metadataBackfillVersion">,
): boolean {
  return Boolean(book.assetPath)
    && book.metadataBackfillVersion !== BOOK_METADATA_BACKFILL_VERSION;
}

export function needsCanonicalBookMigration(
  book: Pick<
    BookEntry,
    "assetFingerprint" | "tocCount" | "spineCount" | "sectionsSummary" | "sectionCount" | "coverPath" | "coverUrl" | "toc" | "spine" | "subtype" | "pageCount" | "assetPath" | "metadataBackfillVersion"
  >,
): boolean {
  return !(
    book.assetFingerprint
    && (book.subtype !== "pdf" || typeof book.pageCount === "number")
    && typeof book.tocCount === "number"
    && typeof book.spineCount === "number"
    && !needsBookSectionBackfill(book)
    && isCanonicalBookVisualState(book)
    && book.coverUrl === undefined
    && book.toc === undefined
    && book.spine === undefined
    && !needsBookMetadataBackfill(book)
  );
}

export function toPersistedBookEntry(book: BookEntry): BookEntry {
  const rawToc = Array.isArray(book.toc) ? book.toc : [];
  const rawSpine = Array.isArray(book.spine) ? book.spine : [];
  const keepLegacyCoverUrl = !book.coverPath && isUsableBookCoverUrl(book.coverUrl);
  const snapshot =
    needsBookSectionBackfill(book) && (rawToc.length || rawSpine.length)
      ? createBookSectionSnapshot(rawToc, rawSpine)
      : {
          sectionsSummary: book.sectionsSummary ?? [],
          sectionCount: typeof book.sectionCount === "number"
            ? book.sectionCount
            : (book.sectionsSummary?.length ?? 0),
          tocCount: typeof book.tocCount === "number" ? book.tocCount : rawToc.length,
          spineCount: typeof book.spineCount === "number" ? book.spineCount : rawSpine.length,
        };

  return {
    ...book,
    ...snapshot,
    pageCount: typeof book.pageCount === "number" ? book.pageCount : null,
    coverUrl: keepLegacyCoverUrl ? book.coverUrl : undefined,
    toc: undefined,
    spine: undefined,
  };
}
