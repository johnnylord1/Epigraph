import { describe, expect, it, vi } from "vitest";

vi.mock("./assets", () => ({
  BookAssetResolver: {
    resolveCoverSrc: (book: { coverPath?: string | null; updatedAt?: number }) =>
      book.coverPath ? `book://${book.coverPath}?v=${book.updatedAt ?? 0}` : null,
  },
}));

import { presentBook } from "./presentation";
import type { BookEntry, BookProgress } from "./types";

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    id: "book-1",
    title: "Example",
    author: null,
    description: null,
    coverPath: "C:\\books\\cover.jpg",
    subtype: "epub",
    createdAt: 0,
    updatedAt: 42,
    importPath: "C:\\books\\example.epub",
    assetPath: "C:\\books\\example.epub",
    sectionsSummary: [{ id: "s1", label: "Chapter 1", href: "OPS/ch1.xhtml", depth: 0 }],
    sectionCount: 1,
    tocCount: 1,
    spineCount: 1,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<BookProgress> = {}): BookProgress {
  return {
    bookId: "book-1",
    location: null,
    href: null,
    progressPercent: 0.5,
    lastReadAt: 1,
    ...overrides,
  };
}

describe("presentBook", () => {
  it("normalizes the same canonical presentation fields for shelf and detail", () => {
    const sections = Array.from({ length: 12 }, (_, index) => ({
      id: `s${index + 1}`,
      label: `Chapter ${index + 1}`,
      href: `OPS/ch${index + 1}.xhtml`,
      depth: 0,
    }));
    const presented = presentBook(
      makeBook({ author: "RinoZ", sectionsSummary: sections, sectionCount: sections.length, tocCount: sections.length, spineCount: sections.length }),
      makeProgress({ progressPercent: 0.25 }),
    );

    expect(presented.title).toBe("Example");
    expect(presented.authorLabel).toBe("RinoZ");
    expect(presented.subtypeLabel).toBe("EPUB");
    expect(presented.coverSrc).toBe("book://C:\\books\\cover.jpg?v=42");
    expect(presented.sectionCount).toBe(12);
    expect(presented.sectionCountLabel).toBe("12 sections");
    expect(presented.readSectionCount).toBe(3);
    expect(presented.progressSummary).toBe("3 / 12 read");
    expect(presented.readPercentLabel).toBe("25%");
  });

  it("uses graceful fallbacks for missing author and missing outline", () => {
    const presented = presentBook(
      makeBook({ author: null, subtype: "pdf", sectionCount: 0, sectionsSummary: [], coverPath: null }),
      null,
    );

    expect(presented.authorLabel).toBe("Unknown author");
    expect(presented.coverSrc).toBeNull();
    expect(presented.sectionCountLabel).toBe("No outline");
    expect(presented.progressSummary).toBe("Unread");
    expect(presented.showProgress).toBe(false);
  });
});
