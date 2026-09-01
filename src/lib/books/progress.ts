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

export function resolveBookResumeTarget(progress: BookProgress | null | undefined): string | null {
  if (!progress) return null;
  return progress.location ?? progress.href ?? null;
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
