import type { BookEntry, BookProgress } from "./types";

type ReconciledBookIdentityState = {
  books: BookEntry[];
  bookProgress: BookProgress[];
  idRemap: Map<string, string>;
};

function normalizedFingerprint(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function preferCanonicalString(canonical: string, incoming: string): string {
  return canonical.trim() ? canonical : incoming;
}

function preferCanonicalNullableString(
  canonical: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  return typeof canonical === "string" && canonical.trim()
    ? canonical
    : (typeof incoming === "string" && incoming.trim() ? incoming : null);
}

function preferCanonicalArray<T>(canonical: T[] | undefined, incoming: T[] | undefined): T[] | undefined {
  return Array.isArray(canonical) && canonical.length ? canonical : incoming;
}

function preferCanonicalNumber(canonical: number | undefined, incoming: number | undefined): number | undefined {
  return typeof canonical === "number" ? canonical : incoming;
}

function preferCanonicalNullableNumber(
  canonical: number | null | undefined,
  incoming: number | null | undefined,
): number | null {
  return typeof canonical === "number" && canonical > 0
    ? canonical
    : (typeof incoming === "number" && incoming > 0 ? incoming : null);
}

export function findBookByFingerprint(
  books: BookEntry[],
  assetFingerprint: string | null | undefined,
): BookEntry | undefined {
  const fingerprint = normalizedFingerprint(assetFingerprint);
  if (!fingerprint) return undefined;
  return books.find((book) => normalizedFingerprint(book.assetFingerprint) === fingerprint);
}

export function mergeCanonicalBookEntries(canonical: BookEntry, incoming: BookEntry): BookEntry {
  const createdAtCandidates = [canonical.createdAt, incoming.createdAt].filter((value) => value > 0);
  const mergedCoverUrl = preferCanonicalNullableString(canonical.coverUrl, incoming.coverUrl);

  return {
    id: canonical.id,
    assetFingerprint:
      normalizedFingerprint(canonical.assetFingerprint)
      ?? normalizedFingerprint(incoming.assetFingerprint)
      ?? undefined,
    title: preferCanonicalString(canonical.title, incoming.title),
    author: preferCanonicalNullableString(canonical.author, incoming.author),
    description: preferCanonicalNullableString(canonical.description, incoming.description),
    genres: preferCanonicalArray(canonical.genres, incoming.genres),
    isbns: preferCanonicalArray(canonical.isbns, incoming.isbns),
    metadataBackfillVersion: Math.max(canonical.metadataBackfillVersion ?? 0, incoming.metadataBackfillVersion ?? 0) || undefined,
    coverPath: preferCanonicalNullableString(canonical.coverPath, incoming.coverPath),
    coverUrl: mergedCoverUrl ?? undefined,
    hardcoverBookId: preferCanonicalNullableNumber(canonical.hardcoverBookId, incoming.hardcoverBookId),
    hardcoverCoverUrl: preferCanonicalNullableString(canonical.hardcoverCoverUrl, incoming.hardcoverCoverUrl),
    subtype: canonical.subtype,
    createdAt: createdAtCandidates.length ? Math.min(...createdAtCandidates) : canonical.createdAt,
    updatedAt: Math.max(canonical.updatedAt, incoming.updatedAt),
    importPath: preferCanonicalString(canonical.importPath, incoming.importPath),
    assetPath: preferCanonicalString(canonical.assetPath, incoming.assetPath),
    toc: preferCanonicalArray(canonical.toc, incoming.toc),
    spine: preferCanonicalArray(canonical.spine, incoming.spine),
    tocCount: preferCanonicalNumber(canonical.tocCount, incoming.tocCount),
    spineCount: preferCanonicalNumber(canonical.spineCount, incoming.spineCount),
    sectionsSummary: preferCanonicalArray(canonical.sectionsSummary, incoming.sectionsSummary),
    sectionCount: preferCanonicalNumber(canonical.sectionCount, incoming.sectionCount),
  };
}

function mergeCanonicalBookProgress(canonical: BookProgress, incoming: BookProgress): BookProgress {
  if (incoming.lastReadAt > canonical.lastReadAt) return incoming;
  if (incoming.lastReadAt < canonical.lastReadAt) return canonical;
  return incoming.progressPercent >= canonical.progressPercent ? incoming : canonical;
}

export function reconcileBookIdentityState(
  books: BookEntry[],
  bookProgress: BookProgress[],
): ReconciledBookIdentityState {
  const sortedBooks = [...books].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );

  const canonicalBooks: BookEntry[] = [];
  const fingerprintIndex = new Map<string, number>();
  const canonicalIds = new Set<string>();
  const idRemap = new Map<string, string>();

  for (const book of sortedBooks) {
    const fingerprint = normalizedFingerprint(book.assetFingerprint);
    const nextBook = fingerprint ? { ...book, assetFingerprint: fingerprint } : book;

    if (!fingerprint) {
      canonicalBooks.push(nextBook);
      canonicalIds.add(nextBook.id);
      idRemap.set(book.id, nextBook.id);
      continue;
    }

    const existingIndex = fingerprintIndex.get(fingerprint);
    if (existingIndex == null) {
      canonicalBooks.push(nextBook);
      canonicalIds.add(nextBook.id);
      fingerprintIndex.set(fingerprint, canonicalBooks.length - 1);
      idRemap.set(book.id, nextBook.id);
      continue;
    }

    const merged = mergeCanonicalBookEntries(canonicalBooks[existingIndex], nextBook);
    canonicalBooks[existingIndex] = merged;
    canonicalIds.add(merged.id);
    idRemap.set(book.id, merged.id);
  }

  const progressByBookId = new Map<string, BookProgress>();
  const sortedProgress = [...bookProgress].sort(
    (a, b) => b.lastReadAt - a.lastReadAt || b.progressPercent - a.progressPercent,
  );

  for (const progress of sortedProgress) {
    const mappedBookId = idRemap.get(progress.bookId) ?? progress.bookId;
    if (!canonicalIds.has(mappedBookId)) continue;

    const normalizedProgress = { ...progress, bookId: mappedBookId };
    const existing = progressByBookId.get(mappedBookId);
    progressByBookId.set(
      mappedBookId,
      existing ? mergeCanonicalBookProgress(existing, normalizedProgress) : normalizedProgress,
    );
  }

  return {
    books: canonicalBooks.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt),
    bookProgress: [...progressByBookId.values()].sort((a, b) => b.lastReadAt - a.lastReadAt),
    idRemap,
  };
}
