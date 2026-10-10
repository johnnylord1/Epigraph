import type { BookBookmarkEntry, BookProgress, BookSubtype } from "./types";

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRenderer(value: unknown): BookSubtype | null {
  return value === "pdf" || value === "epub" ? value : null;
}

function clampPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export const BOOK_FINISHED_PROGRESS = 0.98;

export function isBookFinished(progress: Pick<BookProgress, "progressPercent"> | null | undefined): boolean {
  return clampPercent(progress?.progressPercent) >= BOOK_FINISHED_PROGRESS;
}

export function isBookInProgress(progress: Pick<BookProgress, "progressPercent"> | null | undefined): boolean {
  const value = clampPercent(progress?.progressPercent);
  return value > 0.001 && value < BOOK_FINISHED_PROGRESS;
}

export type BookProgressPrecision = "empty" | "fallback" | "precise";

export function normalizeBookProgress(progress: unknown): BookProgress {
  const entry = progress as any;
  return {
    bookId: String(entry?.bookId ?? ""),
    location: readOptionalString(entry?.location),
    href: readOptionalString(entry?.href),
    progressPercent: clampPercent(entry?.progressPercent),
    lastReadAt: typeof entry?.lastReadAt === "number" && Number.isFinite(entry.lastReadAt)
      ? entry.lastReadAt
      : 0,
    pageIndex: readOptionalNumber(entry?.pageIndex),
    totalPages: readOptionalNumber(entry?.totalPages),
    sectionLabel: readOptionalString(entry?.sectionLabel),
    renderer: readRenderer(entry?.renderer),
  };
}

export function normalizeBookBookmark(bookmark: unknown): BookBookmarkEntry {
  const entry = bookmark as any;
  return {
    bookId: String(entry?.bookId ?? ""),
    location: readOptionalString(entry?.location),
    href: readOptionalString(entry?.href),
    pageIndex: readOptionalNumber(entry?.pageIndex),
    progressPercent: clampPercent(entry?.progressPercent),
    label: typeof entry?.label === "string" ? entry.label : undefined,
    savedAt: typeof entry?.savedAt === "number" && Number.isFinite(entry.savedAt)
      ? entry.savedAt
      : 0,
  };
}

export function createBookBookmark(entry: Omit<BookBookmarkEntry, "savedAt">, label?: string): BookBookmarkEntry {
  return { ...entry, label: label ?? entry.label, savedAt: Date.now() };
}

function inferProgressRenderer(progress: BookProgress): BookSubtype | null {
  if (progress.renderer) return progress.renderer;
  if (typeof progress.pageIndex === "number") return "pdf";
  if (progress.location || progress.href) return "epub";
  return null;
}

export function getBookProgressPrecision(progress: BookProgress | null | undefined): BookProgressPrecision {
  if (!progress) return "empty";
  const renderer = inferProgressRenderer(progress);
  if (renderer === "pdf") {
    return typeof progress.pageIndex === "number" ? "precise" : "empty";
  }
  if (progress.location) return "precise";
  if (progress.href) return "fallback";
  return "empty";
}

function precisionWeight(precision: BookProgressPrecision): number {
  switch (precision) {
    case "precise": return 2;
    case "fallback": return 1;
    default: return 0;
  }
}

export interface ReadiumLocatorPosition {
  href: string;
  /** Position inside the section, 0..1. */
  progression: number | null;
}

/** The phone saves EPUB positions as Readium locators (JSON) instead of epub.js CFIs. */
export function parseReadiumLocator(location: string | null | undefined): ReadiumLocatorPosition | null {
  if (!location || !location.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(location) as { href?: unknown; locations?: { progression?: unknown; fragments?: unknown } };
    if (typeof parsed.href !== "string" || !parsed.href) return null;
    const fragment = Array.isArray(parsed.locations?.fragments) && typeof parsed.locations.fragments[0] === "string"
      ? parsed.locations.fragments[0]
      : null;
    const href = fragment && !parsed.href.includes("#") ? `${parsed.href}#${fragment}` : parsed.href;
    const progression = readOptionalNumber(parsed.locations?.progression);
    return { href, progression: progression === null ? null : Math.max(0, Math.min(1, progression)) };
  } catch {
    return null;
  }
}

export function resolveBookResumeTarget(progress: BookProgress | null | undefined): string | null {
  if (!progress) return null;
  const readium = parseReadiumLocator(progress.location);
  if (readium) return readium.href;
  return progress.location ?? progress.href ?? null;
}

type EpubSpineLike = {
  get(target: string): unknown;
  spineItems?: Array<{ href?: string }>;
};

/** The app keeps section hrefs as paths inside the EPUB zip; epub.js knows them relative to the package document. */
export function resolveEpubDisplayTarget(
  spine: EpubSpineLike | null | undefined,
  target: string | null | undefined,
): string | undefined {
  if (!target) return undefined;
  if (!spine || target.startsWith("epubcfi(") || spine.get(target)) return target;
  const hashIndex = target.indexOf("#");
  const path = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
  const items = (spine.spineItems ?? []).filter((item): item is { href: string } => Boolean(item.href));
  const byPath = items.filter((item) => path === item.href || path.endsWith(`/${item.href}`));
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const byName = byPath.length > 0 ? byPath : items.filter((item) => item.href.slice(item.href.lastIndexOf("/") + 1) === basename);
  // The longest suffix wins so "Text/c1.xhtml" is not mistaken for "Notes/c1.xhtml".
  const match = byName.sort((left, right) => right.href.length - left.href.length);
  if (byPath.length === 0 && byName.length !== 1) return undefined;
  return match[0] ? `${match[0].href}${hash}` : undefined;
}

export function mergeBookProgress(
  current: BookProgress | null | undefined,
  incoming: BookProgress,
): BookProgress {
  const next = normalizeBookProgress(incoming);
  const existing = current ? normalizeBookProgress(current) : null;
  if (!existing || existing.bookId !== next.bookId) {
    return next;
  }

  const existingPrecision = getBookProgressPrecision(existing);
  const nextPrecision = getBookProgressPrecision(next);
  const existingWeight = precisionWeight(existingPrecision);
  const nextWeight = precisionWeight(nextPrecision);

  if (nextWeight > existingWeight) {
    return normalizeBookProgress({
      ...existing,
      ...next,
      href: next.href ?? existing.href,
      sectionLabel: next.sectionLabel ?? existing.sectionLabel,
      totalPages: next.totalPages ?? existing.totalPages,
      renderer: next.renderer ?? existing.renderer ?? inferProgressRenderer(next) ?? inferProgressRenderer(existing),
      lastReadAt: Math.max(existing.lastReadAt, next.lastReadAt),
    });
  }

  if (nextWeight < existingWeight) {
    return normalizeBookProgress({
      ...existing,
      href: existing.href ?? next.href,
      sectionLabel: existing.sectionLabel ?? next.sectionLabel,
      totalPages: existing.totalPages ?? next.totalPages,
      renderer: existing.renderer ?? next.renderer ?? inferProgressRenderer(existing) ?? inferProgressRenderer(next),
      lastReadAt: Math.max(existing.lastReadAt, next.lastReadAt),
    });
  }

  return normalizeBookProgress({
    ...existing,
    ...next,
    location: next.location ?? existing.location,
    href: next.href ?? existing.href,
    pageIndex: next.pageIndex ?? existing.pageIndex,
    totalPages: next.totalPages ?? existing.totalPages,
    sectionLabel: next.sectionLabel ?? existing.sectionLabel,
    renderer: next.renderer ?? existing.renderer ?? inferProgressRenderer(next) ?? inferProgressRenderer(existing),
    lastReadAt: Math.max(existing.lastReadAt, next.lastReadAt),
  });
}
