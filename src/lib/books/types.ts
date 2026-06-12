export type BookSubtype = "epub" | "pdf";

export interface BookTocItem {
  id: string;
  label: string;
  href: string;
  depth: number;
}

export interface BookSpineItem {
  id: string;
  href: string;
  label: string;
}

export interface BookSectionSummaryItem {
  id: string;
  label: string;
  href: string;
  depth: number;
}

export interface BookEntry {
  id: string;
  assetFingerprint?: string;
  title: string;
  author: string | null;
  description: string | null;
  genres?: string[];
  coverPath: string | null;
  /** Legacy migration-only field. Never use as an active render source. */
  coverUrl?: string | null;
  subtype: BookSubtype;
  pageCount?: number | null;
  createdAt: number;
  updatedAt: number;
  importPath: string;
  assetPath: string;
  /** Legacy backfill-only fields. New canonical books persist summary/counts instead. */
  toc?: BookTocItem[];
  spine?: BookSpineItem[];
  tocCount?: number;
  spineCount?: number;
  sectionsSummary?: BookSectionSummaryItem[];
  sectionCount?: number;
}

export interface BookProgress {
  bookId: string;
  location: string | null;
  href: string | null;
  progressPercent: number;
  lastReadAt: number;
  pageIndex?: number | null;
  totalPages?: number | null;
  sectionLabel?: string | null;
  renderer?: BookSubtype | null;
}

export interface BookBookmarkEntry {
  bookId: string;
  location: string | null;
  href: string | null;
  pageIndex: number | null;
  progressPercent: number;
  label?: string;
  savedAt: number;
}

export interface ParsedBookCover {
  bytesBase64: string;
  ext: string;
  mediaType: string;
}

export interface ParsedEpubBook {
  title: string;
  author: string | null;
  description: string | null;
  genres: string[];
  toc: BookTocItem[];
  spine: BookSpineItem[];
  cover: ParsedBookCover | null;
}
