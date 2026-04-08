import type { BookEntry } from "./types";

export const MISSING_BOOK_ASSET_MESSAGE =
  "This book was restored without its original EPUB or PDF file. Re-import the file to read it.";

export function hasBookLocalAsset(book: Pick<BookEntry, "assetPath"> | null | undefined): boolean {
  return typeof book?.assetPath === "string" && book.assetPath.trim().length > 0;
}
