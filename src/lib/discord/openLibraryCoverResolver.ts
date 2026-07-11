import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { extractIsbns } from "../books/isbn";
import type { BookEntry } from "../books/types";
import { isDiscordPublicImageUrl } from "./coverResolver";

const OPEN_LIBRARY_SEARCH_URL = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_TIMEOUT_MS = 2_000;

type OpenLibraryBook = Pick<BookEntry, "title" | "author" | "isbns">;

type OpenLibraryDocument = {
  title?: unknown;
  author_name?: unknown;
  cover_i?: unknown;
  isbn?: unknown;
};

type OpenLibraryFetch = typeof tauriFetch;

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ")
    : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string" ? [value] : [];
}

function coverUrl(document: OpenLibraryDocument): string | null {
  const coverId = Number(document.cover_i);
  if (!Number.isSafeInteger(coverId) || coverId <= 0) return null;
  const url = `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false`;
  return isDiscordPublicImageUrl(url) ? url : null;
}

function authorMatches(expected: string, candidates: string[]): boolean {
  const normalizedExpected = normalizedText(expected);
  if (!normalizedExpected) return true;
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizedText(candidate);
    if (!normalizedCandidate) return false;
    return normalizedCandidate === normalizedExpected
      || normalizedCandidate.includes(normalizedExpected)
      || normalizedExpected.includes(normalizedCandidate);
  });
}

function selectByIsbn(documents: OpenLibraryDocument[], isbns: string[]): string | null {
  const expected = new Set(isbns);
  for (const document of documents) {
    if (!extractIsbns(document.isbn).some((isbn) => expected.has(isbn))) continue;
    const url = coverUrl(document);
    if (url) return url;
  }
  return null;
}

function selectByTitleAndAuthor(documents: OpenLibraryDocument[], book: OpenLibraryBook): string | null {
  const title = normalizedText(book.title);
  if (!title) return null;
  const matches = documents.filter((document) =>
    normalizedText(document.title) === title
    && (!book.author || authorMatches(book.author, stringList(document.author_name)))
    && coverUrl(document),
  );
  if (!matches.length) return null;

  if (!book.author) {
    const coverIds = new Set(matches.map((document) => Number(document.cover_i)));
    if (coverIds.size !== 1) return null;
  }
  return coverUrl(matches[0] ?? {});
}

async function searchOpenLibrary(
  params: URLSearchParams,
  fetchImpl: OpenLibraryFetch,
): Promise<OpenLibraryDocument[]> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), OPEN_LIBRARY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${OPEN_LIBRARY_SEARCH_URL}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json() as { docs?: unknown };
    return Array.isArray(payload.docs) ? payload.docs as OpenLibraryDocument[] : [];
  } catch {
    return [];
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function createOpenLibraryBookDiscordTrackerKey(book: OpenLibraryBook): string {
  return [
    "openlibrary-book-v1",
    ...extractIsbns(book.isbns),
    normalizedText(book.title),
    normalizedText(book.author),
  ].join(":");
}

export async function resolveOpenLibraryBookDiscordCover(
  book: OpenLibraryBook,
  fetchImpl: OpenLibraryFetch = tauriFetch,
): Promise<string | null> {
  const isbns = extractIsbns(book.isbns);
  if (isbns.length) {
    const documents = await searchOpenLibrary(new URLSearchParams({
      isbn: isbns[0] ?? "",
      fields: "cover_i,isbn,title,author_name",
      limit: "5",
    }), fetchImpl);
    const matched = selectByIsbn(documents, isbns);
    if (matched) return matched;
  }

  const title = book.title.trim();
  if (!title) return null;
  const params = new URLSearchParams({
    title,
    fields: "cover_i,isbn,title,author_name",
    limit: "8",
  });
  if (book.author?.trim()) params.set("author", book.author.trim());
  const documents = await searchOpenLibrary(params, fetchImpl);
  return selectByTitleAndAuthor(documents, book);
}
