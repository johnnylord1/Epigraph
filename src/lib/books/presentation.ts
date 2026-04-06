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

function formatSectionCount(sectionCount: number, subtype: BookSubtype): string {
  if (sectionCount <= 0) {
    return subtype === "pdf" ? "No outline" : "No sections";
  }
  return `${sectionCount} ${sectionCount === 1 ? "section" : "sections"}`;
}

export function presentBook(book: BookEntry, progress: BookProgress | null | undefined): PresentedBook {
  const sectionCount = getBookSectionCount(book);
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
    coverSrc: BookAssetResolver.resolveCoverSrc(book),
    sectionCount,
    sectionCountLabel: formatSectionCount(sectionCount, book.subtype),
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
