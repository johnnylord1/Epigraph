import { createImportedBookId } from "./assets";
import { createBookSectionSnapshot } from "./summary";
import {
  canRenderEmbeddedImage,
  computeFileSha256,
  copyImportedBook,
  readFileAsArrayBuffer,
  writeBookCover,
} from "./storage";
import { resolveImportedBookFingerprint } from "./import";
import { findBookByFingerprint } from "./identity";
import { parseEpubArchive } from "./epub";
import { extractPdfBookData } from "./pdf";
import type { BookEntry, BookSubtype } from "./types";

const SUPPORTED_IMPORTED_BOOK_EXTENSIONS = new Set<BookSubtype>(["epub", "pdf"]);

export type ImportedBookResult = {
  entry: BookEntry;
  existing: BookEntry | null;
  subtype: BookSubtype;
};

export function fileBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "Imported book";
}

export function fileStem(path: string): string {
  return fileBasename(path).replace(/\.[^.]+$/i, "");
}

export function bookSubtypeFromPath(path: string): BookSubtype | null {
  const match = path.match(/\.([^.\\/]+)$/i);
  const ext = match?.[1]?.toLowerCase();
  if (ext === "epub" || ext === "pdf") {
    return ext;
  }
  return null;
}

export function isSupportedBookImportPath(path: string): boolean {
  const subtype = bookSubtypeFromPath(path);
  return subtype !== null && SUPPORTED_IMPORTED_BOOK_EXTENSIONS.has(subtype);
}

export async function importLocalBookFile(
  sourcePath: string,
  input: {
    existingBooks: BookEntry[];
    now?: number;
  },
): Promise<ImportedBookResult> {
  const subtype = bookSubtypeFromPath(sourcePath);
  if (!subtype) {
    throw new Error(`Unsupported book import path: ${sourcePath}`);
  }

  const now = input.now ?? Date.now();
  const { assetFingerprint } = await resolveImportedBookFingerprint(sourcePath, subtype, {
    computeFileSha256,
  });
  const existing = findBookByFingerprint(input.existingBooks, assetFingerprint);
  const id = existing?.id ?? createImportedBookId(subtype, assetFingerprint);
  const assetPath = await copyImportedBook(sourcePath, id);

  if (subtype === "epub") {
    const buffer = await readFileAsArrayBuffer(assetPath);
    const parsed = await parseEpubArchive(buffer, fileStem(sourcePath));

    let coverPath: string | null = existing?.coverPath ?? null;
    if (parsed.cover) {
      const isRenderableCover = await canRenderEmbeddedImage(
        parsed.cover.bytesBase64,
        parsed.cover.mediaType,
      );
      if (isRenderableCover) {
        try {
          coverPath = await writeBookCover(id, parsed.cover.bytesBase64, parsed.cover.ext);
        } catch {
          coverPath = existing?.coverPath ?? null;
        }
      } else {
        coverPath = null;
      }
    }

    return {
      existing: existing ?? null,
      subtype,
      entry: {
        id,
        assetFingerprint,
        title: parsed.title,
        author: parsed.author,
        description: parsed.description,
        genres: parsed.genres,
        metadataBackfillVersion: 1,
        coverPath,
        subtype,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        importPath: sourcePath,
        assetPath,
        ...createBookSectionSnapshot(parsed.toc, parsed.spine),
      },
    };
  }

  return {
    existing: existing ?? null,
    subtype,
    entry: {
      id,
      assetFingerprint,
      ...(await extractPdfBookData(assetPath, id, fileStem(sourcePath) || "Imported PDF")),
      subtype: "pdf",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      importPath: sourcePath,
      assetPath,
    },
  };
}
