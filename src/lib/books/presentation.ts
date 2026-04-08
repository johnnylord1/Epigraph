import { BookAssetResolver } from "./assets";
import { getBookSectionCount } from "./summary";
import type { BookEntry, BookProgress, BookSubtype } from "./types";

export interface PresentedBook {
  id: string;
  title: string;
  authorLabel: string;
  subtype: BookSubtype;
  subtypeLabel: string;
  coverSrc: string | null;
  pageCount: number;
  pageCountLabel: string;
  sectionCount: number;
  sectionCountLabel: string;
  readPercent: number;
  readPercentLabel: string;
  readSectionCount: number;
  progressSummary: string;
  showProgress: boolean;
  description: string | null;
}

function clampPercent(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatSubtype(subtype: BookSubtype): string {
  return subtype.toUpperCase();
}

function formatPageCount(pageCount: number): string {
  if (pageCount <= 0) return "Unknown length";
  return `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
}

function formatSectionCount(sectionCount: number, subtype: BookSubtype, pageCount: number): string {
  if (sectionCount <= 0) {
    return subtype === "pdf" && pageCount > 0 ? formatPageCount(pageCount) : "No sections";
  }
  return `${sectionCount} ${sectionCount === 1 ? "section" : "sections"}`;
}

export function presentBookWithCoverSrc(
  book: BookEntry,
  progress: BookProgress | null | undefined,
  coverSrc: string | null,
): PresentedBook {
  const sectionCount = getBookSectionCount(book);
  const pageCount = Math.max(0, typeof book.pageCount === "number" ? book.pageCount : 0);
  const readPercent = clampPercent(progress?.progressPercent);
  const readSectionCount =
    sectionCount > 0
      ? Math.min(sectionCount, Math.round(readPercent * sectionCount))
      : 0;

  return {
    id: book.id,
    title: book.title,
    authorLabel: book.author?.trim() ? book.author : "Unknown author",
    subtype: book.subtype,
    subtypeLabel: formatSubtype(book.subtype),
    coverSrc,
    pageCount,
    pageCountLabel: formatPageCount(pageCount),
    sectionCount,
    sectionCountLabel: formatSectionCount(sectionCount, book.subtype, pageCount),
    readPercent,
    readPercentLabel: `${Math.round(readPercent * 100)}%`,
    readSectionCount,
    progressSummary:
      sectionCount > 0
        ? `${readSectionCount} / ${sectionCount} read`
        : (readPercent > 0 ? `${Math.round(readPercent * 100)}% read` : "Unread"),
    showProgress: sectionCount > 0 || !!progress,
    description: book.description,
  };
}

/**
 * Convenience presenter for existing UI call sites.
 *
 * Keep this out of pure selector paths because `resolveCoverSrc` currently
 * uses a stable-url cache under the hood.
 */
export function presentBook(book: BookEntry, progress: BookProgress | null | undefined): PresentedBook {
  return presentBookWithCoverSrc(
    book,
    progress,
    BookAssetResolver.resolveCoverSrc(book),
  );
}
