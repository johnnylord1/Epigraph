import { translate } from "../i18n/runtime";
import { BookAssetResolver } from "./assets";
import { BOOK_FINISHED_PROGRESS } from "./progress";
import {
  findBookSectionIndex,
  getBookSectionCount,
  getBookSectionsSummary,
} from "./summary";
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
  progressValueLabel: string;
  progressTotalLabel: string;
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
  if (pageCount <= 0) return translate("books_unknownLength");
  return pageCount === 1 ? translate("books_pageCountOne") : translate("bookDetail_pageCount", { count: pageCount });
}

function formatSectionCount(sectionCount: number, subtype: BookSubtype, pageCount: number): string {
  if (sectionCount <= 0) {
    return subtype === "pdf" && pageCount > 0 ? formatPageCount(pageCount) : translate("books_noChapters");
  }
  return sectionCount === 1 ? translate("books_chapterCountOne") : translate("home_chapterCount", { count: sectionCount });
}

function resolveReadSectionCount(
  book: BookEntry,
  progress: BookProgress | null | undefined,
  sectionCount: number,
  readPercent: number,
): number {
  if (sectionCount <= 0) return 0;
  if (readPercent >= BOOK_FINISHED_PROGRESS) return sectionCount;

  // Only chapters wholly behind the reader count as read, as in the library badges; the chapter
  // being read is still unread until the book is finished.
  const sectionIndex = findBookSectionIndex(getBookSectionsSummary(book), progress?.href);
  if (sectionIndex >= 0) return Math.min(sectionCount - 1, sectionIndex);
  if (readPercent <= 0) return 0;
  return Math.max(0, Math.min(sectionCount - 1, Math.floor(readPercent * sectionCount)));
}

function resolveReadPageCount(
  progress: BookProgress | null | undefined,
  pageCount: number,
  readPercent: number,
): number {
  if (pageCount <= 0) return 0;
  if (typeof progress?.pageIndex === "number" && Number.isFinite(progress.pageIndex)) {
    return Math.max(1, Math.min(pageCount, Math.round(progress.pageIndex)));
  }
  if (readPercent <= 0) return 0;
  return Math.max(1, Math.min(pageCount, Math.round(readPercent * (pageCount - 1)) + 1));
}

export function presentBookWithCoverSrc(
  book: BookEntry,
  progress: BookProgress | null | undefined,
  coverSrc: string | null,
): PresentedBook {
  const sectionCount = getBookSectionCount(book);
  const pageCount = Math.max(
    0,
    typeof book.pageCount === "number" ? book.pageCount : 0,
    typeof progress?.totalPages === "number" ? progress.totalPages : 0,
  );
  const readPercent = clampPercent(progress?.progressPercent);
  const usesPageProgress = book.subtype === "pdf" && sectionCount <= 0 && pageCount > 0;
  const readSectionCount = usesPageProgress
    ? resolveReadPageCount(progress, pageCount, readPercent)
    : resolveReadSectionCount(book, progress, sectionCount, readPercent);
  const readPercentLabel = `${Math.round(readPercent * 100)}%`;
  const progressValueLabel = readSectionCount > 0
    ? String(readSectionCount)
    : readPercentLabel;
  const progressTotalLabel = sectionCount > 0
    ? `/ ${formatSectionCount(sectionCount, book.subtype, pageCount)}`
    : usesPageProgress
      ? `/ ${formatPageCount(pageCount)}`
      : translate("books_progress");

  return {
    id: book.id,
    title: book.title,
    authorLabel: book.author?.trim() ? book.author : translate("bookDetail_unknownAuthor"),
    subtype: book.subtype,
    subtypeLabel: formatSubtype(book.subtype),
    coverSrc,
    pageCount,
    pageCountLabel: formatPageCount(pageCount),
    sectionCount,
    sectionCountLabel: formatSectionCount(sectionCount, book.subtype, pageCount),
    readPercent,
    readPercentLabel,
    readSectionCount,
    progressValueLabel,
    progressTotalLabel,
    progressSummary:
      sectionCount > 0
        ? translate("bookDetail_progressRead", { read: readSectionCount, total: sectionCount })
        : usesPageProgress && readSectionCount > 0
          ? translate("books_pagesProgress", { read: readSectionCount, total: pageCount })
          : (readPercent > 0 ? translate("books_percentRead", { percent: readPercentLabel }) : translate("books_unread")),
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
