import { describe, expect, it } from "vitest";
import {
  findBookByFingerprint,
  mergeCanonicalBookEntries,
  reconcileBookIdentityState,
} from "./identity";
import type { BookEntry, BookProgress } from "./types";

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    id: "book-1",
    assetFingerprint: "abc123",
    title: "Example",
    author: "Author",
    description: null,
    coverPath: "C:\\books\\cover.jpg",
    subtype: "epub",
    createdAt: 10,
    updatedAt: 20,
    importPath: "C:\\imports\\example.epub",
    assetPath: "C:\\app\\books\\example.epub",
    sectionsSummary: [{ id: "1", label: "Chapter 1", href: "OPS/ch1.xhtml", depth: 0 }],
    sectionCount: 1,
    tocCount: 1,
    spineCount: 1,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId: "book-1",
    location: "epubcfi(/6/2)",
    href: "OPS/ch1.xhtml",
    progressPercent: 0.4,
    lastReadAt: 100,
    ...overrides,
  };
}

describe("findBookByFingerprint", () => {
  it("matches fingerprints case-insensitively", () => {
    const book = makeBook({ assetFingerprint: "ABC123" });
    expect(findBookByFingerprint([book], "abc123")).toEqual(book);
  });
});

describe("mergeCanonicalBookEntries", () => {
  it("keeps the canonical id while preserving canonical metadata", () => {
    const canonical = makeBook({
      id: "canonical-id",
      createdAt: 10,
      updatedAt: 20,
      description: "Old description",
      title: "Canonical title",
    });
    const incoming = makeBook({
      id: "legacy-id",
      updatedAt: 50,
      description: "New description",
      title: "Legacy title",
      importPath: "D:\\Downloads\\example.epub",
      assetPath: "C:\\app\\books\\updated.epub",
    });

    const merged = mergeCanonicalBookEntries(canonical, incoming);

    expect(merged.id).toBe("canonical-id");
    expect(merged.createdAt).toBe(10);
    expect(merged.updatedAt).toBe(50);
    expect(merged.title).toBe("Canonical title");
    expect(merged.description).toBe("Old description");
    expect(merged.importPath).toBe("C:\\imports\\example.epub");
    expect(merged.assetPath).toBe("C:\\app\\books\\example.epub");
  });

  it("fills missing canonical fields from a legacy duplicate", () => {
    const canonical = makeBook({
      id: "canonical-id",
      author: null,
      description: null,
      coverPath: null,
      sectionsSummary: undefined,
      sectionCount: undefined,
      tocCount: undefined,
      spineCount: undefined,
    });
    const incoming = makeBook({
      id: "legacy-id",
      author: "Recovered author",
      description: "Recovered description",
      coverPath: "C:\\legacy\\cover.jpg",
      sectionsSummary: [{ id: "2", label: "Recovered chapter", href: "OPS/ch2.xhtml", depth: 0 }],
      sectionCount: 1,
      tocCount: 1,
      spineCount: 1,
    });

    const merged = mergeCanonicalBookEntries(canonical, incoming);

    expect(merged.id).toBe("canonical-id");
    expect(merged.author).toBe("Recovered author");
    expect(merged.description).toBe("Recovered description");
    expect(merged.coverPath).toBe("C:\\legacy\\cover.jpg");
    expect(merged.sectionsSummary).toHaveLength(1);
    expect(merged.sectionCount).toBe(1);
  });
});

describe("reconcileBookIdentityState", () => {
  it("dedupes books by fingerprint and remaps progress to the canonical id", () => {
    const canonical = makeBook({
      id: "canonical-id",
      assetFingerprint: "deadbeef",
      updatedAt: 200,
      title: "Newest copy",
    });
    const duplicate = makeBook({
      id: "legacy-id",
      assetFingerprint: "DEADBEEF",
      updatedAt: 100,
      title: "Old copy",
    });
    const unrelated = makeBook({
      id: "other-id",
      assetFingerprint: "otherfp",
      title: "Other book",
      updatedAt: 150,
    });

    const latestDuplicateProgress = makeProgress({
      bookId: "legacy-id",
      progressPercent: 0.8,
      lastReadAt: 300,
      href: "OPS/ch2.xhtml",
    });
    const canonicalProgress = makeProgress({
      bookId: "canonical-id",
      progressPercent: 0.3,
      lastReadAt: 200,
    });

    const state = reconcileBookIdentityState(
      [duplicate, canonical, unrelated],
      [canonicalProgress, latestDuplicateProgress],
    );

    expect(state.books).toHaveLength(2);
    expect(state.books[0].id).toBe("canonical-id");
    expect(state.books[0].title).toBe("Newest copy");
    expect(state.idRemap.get("legacy-id")).toBe("canonical-id");
    expect(state.bookProgress).toEqual([
      {
        bookId: "canonical-id",
        location: "epubcfi(/6/2)",
        href: "OPS/ch2.xhtml",
        progressPercent: 0.8,
        lastReadAt: 300,
      },
    ]);
  });
});
