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
  coverPath: string | null;
  /** Legacy migration-only field. Never use as an active render source. */
  coverUrl?: string | null;
  subtype: BookSubtype;
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
  toc: BookTocItem[];
  spine: BookSpineItem[];
  cover: ParsedBookCover | null;
}
