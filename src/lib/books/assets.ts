import {
  canRenderBookCoverPath,
  canRenderEmbeddedImage,
  computeFileSha256,
  filePathAsStableUrl,
  dropCachedFileStableUrl,
  isUsableBookCoverUrl,
  readFileAsArrayBuffer,
  writeBookCover,
} from "./storage";
import { extractPdfBookData } from "./pdf";
import { createBookSectionSnapshot, needsBookSectionBackfill } from "./summary";
import type { BookEntry, BookSubtype, ParsedEpubBook } from "./types";
import { parseEpubArchive } from "./epub";

type CanonicalBookPatch = Partial<BookEntry>;
export interface ResolvedBookPreviewAsset {
  subtype: BookSubtype;
  title: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

const canonicalizationInFlight = new Map<string, Promise<CanonicalBookPatch | null>>();

const IMAGE_EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const MIME_BY_BOOK_SUBTYPE: Record<BookSubtype, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
};
const BOOK_METADATA_BACKFILL_VERSION = 1;

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getBookRawToc(book: Pick<BookEntry, "toc">) {
  return Array.isArray(book.toc) ? book.toc : [];
}

function getBookRawSpine(book: Pick<BookEntry, "spine">) {
  return Array.isArray(book.spine) ? book.spine : [];
}

function parseLegacyCoverDataUrl(coverUrl: string): { bytesBase64: string; ext: string } | null {
  const match = coverUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;

  const mediaType = match[1].toLowerCase();
  const bytesBase64 = match[2];
  const ext = IMAGE_EXT_BY_MEDIA_TYPE[mediaType];
  if (!ext || !bytesBase64) return null;

  return { bytesBase64, ext };
}

export async function computeBookAssetFingerprint(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return arrayBufferToHex(digest);
}

export function isCanonicalBookVisualState(book: Pick<BookEntry, "coverPath" | "coverUrl">): boolean {
  if (book.coverPath) return true;
  return !isUsableBookCoverUrl(book.coverUrl);
}

function needsBookGenresBackfill(book: Pick<BookEntry, "subtype" | "genres" | "assetPath" | "metadataBackfillVersion">): boolean {
  return book.subtype === "epub"
    && Boolean(book.assetPath)
    && book.metadataBackfillVersion !== BOOK_METADATA_BACKFILL_VERSION
    && (!Array.isArray(book.genres) || book.genres.length === 0);
}

export function needsCanonicalBookMigration(
  book: Pick<
    BookEntry,
    "assetFingerprint" | "tocCount" | "spineCount" | "sectionsSummary" | "sectionCount" | "coverPath" | "coverUrl" | "toc" | "spine" | "subtype" | "pageCount" | "genres" | "assetPath" | "metadataBackfillVersion"
  >,
): boolean {
  return !(
    book.assetFingerprint &&
    (book.subtype !== "pdf" || typeof book.pageCount === "number") &&
    typeof book.tocCount === "number" &&
    typeof book.spineCount === "number" &&
    !needsBookSectionBackfill(book) &&
    isCanonicalBookVisualState(book) &&
    book.coverUrl === undefined &&
    book.toc === undefined &&
    book.spine === undefined &&
    !needsBookGenresBackfill(book)
  );
}

export function toPersistedBookEntry(book: BookEntry): BookEntry {
  const rawToc = getBookRawToc(book);
  const rawSpine = getBookRawSpine(book);
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

async function buildCanonicalPatch(book: BookEntry): Promise<CanonicalBookPatch | null> {
  const patch: CanonicalBookPatch = {};
  const rawToc = getBookRawToc(book);
  const rawSpine = getBookRawSpine(book);
  let assetBufferPromise: Promise<ArrayBuffer> | null = null;
  let parsedEpubPromise: Promise<ParsedEpubBook> | null = null;
  const getAssetBuffer = () => {
    assetBufferPromise ??= readFileAsArrayBuffer(book.assetPath);
    return assetBufferPromise;
  };
  const getParsedEpub = () => {
    parsedEpubPromise ??= getAssetBuffer().then((buffer) => parseEpubArchive(buffer, book.title));
    return parsedEpubPromise;
  };

  if (!book.assetFingerprint) {
    patch.assetFingerprint = await computeFileSha256(book.assetPath);
  }

  let effectiveCoverPath = book.coverPath;

  if (effectiveCoverPath) {
    const isRenderableExistingCover = await canRenderBookCoverPath(effectiveCoverPath);
    if (!isRenderableExistingCover) {
      effectiveCoverPath = null;
      patch.coverPath = null;
    }
  }

  if (!effectiveCoverPath && isUsableBookCoverUrl(book.coverUrl)) {
    const payload = parseLegacyCoverDataUrl(book.coverUrl);
    if (payload) {
      const isRenderableLegacyCover = await canRenderEmbeddedImage(
        payload.bytesBase64,
        `image/${payload.ext === "jpg" ? "jpeg" : payload.ext}`,
      );
      if (isRenderableLegacyCover) {
        effectiveCoverPath = await writeBookCover(book.id, payload.bytesBase64, payload.ext);
        patch.coverPath = effectiveCoverPath;
      }
    }
  }

  if (!effectiveCoverPath && book.subtype === "epub") {
    try {
      const parsed = await getParsedEpub();
      if (parsed.cover) {
        const isRenderableEmbeddedCover = await canRenderEmbeddedImage(
          parsed.cover.bytesBase64,
          parsed.cover.mediaType,
        );
        if (isRenderableEmbeddedCover) {
          effectiveCoverPath = await writeBookCover(book.id, parsed.cover.bytesBase64, parsed.cover.ext);
          patch.coverPath = effectiveCoverPath;
        } else if (book.coverPath) {
          patch.coverPath = null;
        }
      } else if (book.coverPath) {
        patch.coverPath = null;
      }
    } catch {
      if (book.coverPath) {
        patch.coverPath = null;
      }
    }
  }

  if (needsBookGenresBackfill(book)) {
    try {
      const parsed = await getParsedEpub();
      if (parsed.genres.length > 0) {
        patch.genres = parsed.genres;
      }
      patch.metadataBackfillVersion = BOOK_METADATA_BACKFILL_VERSION;
    } catch {
      // Metadata backfill is best-effort and must not block existing books.
    }
  }

  if (book.subtype === "pdf") {
    const parsed = await extractPdfBookData(book.assetPath, book.id, book.title);
    patch.title = parsed.title;
    patch.author = parsed.author;
    patch.description = parsed.description;
    patch.pageCount = parsed.pageCount;
    patch.sectionsSummary = parsed.sectionsSummary;
    patch.sectionCount = parsed.sectionCount;
    patch.tocCount = parsed.tocCount;
    patch.spineCount = parsed.spineCount;
    if (!effectiveCoverPath && parsed.coverPath) {
      patch.coverPath = parsed.coverPath;
    }
  }

  if (needsBookSectionBackfill(book) && (rawToc.length || rawSpine.length)) {
    Object.assign(patch, createBookSectionSnapshot(rawToc, rawSpine));
  } else {
    if (typeof book.tocCount !== "number" && typeof patch.tocCount !== "number") patch.tocCount = rawToc.length;
    if (typeof book.spineCount !== "number" && typeof patch.spineCount !== "number") patch.spineCount = rawSpine.length;
  }

  if (book.coverUrl !== undefined) patch.coverUrl = undefined;
  if (book.toc !== undefined) patch.toc = undefined;
  if (book.spine !== undefined) patch.spine = undefined;

  return Object.keys(patch).length ? patch : null;
}

async function ensureCanonicalBookEntry(book: BookEntry): Promise<CanonicalBookPatch | null> {
  if (!needsCanonicalBookMigration(book)) {
    return null;
  }

  const cached = canonicalizationInFlight.get(book.id);
  if (cached) return cached;

  const task = buildCanonicalPatch(book).finally(() => {
    canonicalizationInFlight.delete(book.id);
  });
  canonicalizationInFlight.set(book.id, task);
  return task;
}

function resolveCoverSrc(book: Pick<BookEntry, "coverPath" | "updatedAt">): string | null {
  if (!book.coverPath) return null;
  const baseUrl = filePathAsStableUrl(book.coverPath, "book");
  const version = typeof book.updatedAt === "number" ? book.updatedAt : 0;
  return `${baseUrl}?v=${version}`;
}

function resolvePdfSourceUrl(book: Pick<BookEntry, "assetPath" | "updatedAt">): string {
  const baseUrl = filePathAsStableUrl(book.assetPath, "book");
  const version = typeof book.updatedAt === "number" ? book.updatedAt : 0;
  return `${baseUrl}?v=${version}`;
}

function resolveEpubSourceUrl(book: Pick<BookEntry, "assetPath" | "updatedAt">): string {
  const baseUrl = filePathAsStableUrl(book.assetPath, "book");
  const version = typeof book.updatedAt === "number" ? book.updatedAt : 0;
  return `${baseUrl}?v=${version}`;
}

async function readAsset(book: Pick<BookEntry, "assetPath">): Promise<ArrayBuffer> {
  return readFileAsArrayBuffer(book.assetPath);
}

async function resolvePreviewAsset(
  book: Pick<BookEntry, "assetPath" | "subtype" | "title">,
): Promise<ResolvedBookPreviewAsset> {
  return {
    subtype: book.subtype,
    title: book.title,
    mimeType: MIME_BY_BOOK_SUBTYPE[book.subtype],
    bytes: await readAsset(book),
  };
}

async function ensureCoverSrc(book: Pick<BookEntry, "coverPath" | "updatedAt">): Promise<string | null> {
  return resolveCoverSrc(book);
}

function dropCoverSrc(path: string | null | undefined) {
  if (!path) return;
  dropCachedFileStableUrl(path, "book");
}

export const BookAssetResolver = {
  resolveCoverSrc,
  resolveEpubSourceUrl,
  resolvePdfSourceUrl,
  ensureCoverSrc,
  dropCoverSrc,
  readAsset,
  resolvePreviewAsset,
  needsCanonicalBookMigration,
  ensureCanonicalBookEntry,
  toPersistedBookEntry,
};

export function createImportedBookId(subtype: BookSubtype, fingerprint: string): string {
  return `${subtype}-${fingerprint}`;
}
