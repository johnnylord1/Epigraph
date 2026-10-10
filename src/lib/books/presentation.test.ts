import { beforeEach, describe, expect, it } from "vitest";
import { presentBookWithCoverSrc } from "./presentation";
import type { BookEntry, BookProgress } from "./types";
import { applyAppLanguage } from "../i18n/runtime";

beforeEach(() => {
  applyAppLanguage("en");
});

const book: BookEntry = {
  id: "epub-demo",
  title: "Demo Book",
  author: "Author",
  description: "Desc",
  coverPath: "C:\\cover.png",
  subtype: "epub",
  createdAt: 1,
  updatedAt: 2,
  importPath: "C:\\demo.epub",
  assetPath: "C:\\demo.epub",
  sectionCount: 10,
  tocCount: 10,
  spineCount: 10,
  sectionsSummary: Array.from({ length: 10 }, (_, index) => ({
    id: `section-${index}`,
    label: `Section ${index + 1}`,
    href: `chapter-${index + 1}.xhtml`,
    depth: 0,
    order: index,
  })),
};

const progress: BookProgress = {
  bookId: "epub-demo",
  location: "loc",
  href: "chapter-3.xhtml",
  progressPercent: 0.3,
  lastReadAt: 123,
};

describe("presentBookWithCoverSrc", () => {
  it("derives presentation from explicit inputs without resolving assets itself", () => {
    const presented = presentBookWithCoverSrc(book, {
      ...progress,
      progressPercent: 0.8,
    }, "book://cover");

    expect(presented.id).toBe("epub-demo");
    expect(presented.coverSrc).toBe("book://cover");
    expect(presented.authorLabel).toBe("Author");
    expect(presented.sectionCount).toBe(10);
    // Reading chapter 3: only the two chapters behind it are read.
    expect(presented.progressSummary).toBe("2 / 10 read");
    expect(presented.progressValueLabel).toBe("2");
    expect(presented.progressTotalLabel).toBe("/ 10 chapters");
    expect(presented.sectionCountLabel).toBe("10 chapters");
  });

  it("counts the chapter being read only once the book is finished", () => {
    const lastChapter = { ...progress, href: "chapter-10.xhtml" };

    expect(presentBookWithCoverSrc(book, { ...lastChapter, progressPercent: 0.9 }, null).readSectionCount).toBe(9);
    expect(presentBookWithCoverSrc(book, { ...lastChapter, progressPercent: 0.99 }, null).readSectionCount).toBe(10);
    expect(presentBookWithCoverSrc(book, { ...progress, href: "chapter-1.xhtml", progressPercent: 0.05 }, null).progressValueLabel).toBe("5%");
  });

  it("prefers page count labels for PDFs without outline sections", () => {
    const presented = presentBookWithCoverSrc({
      ...book,
      id: "pdf-demo",
      subtype: "pdf",
      pageCount: 42,
      sectionCount: 0,
      sectionsSummary: [],
      tocCount: 0,
      spineCount: 0,
    }, {
      ...progress,
      bookId: "pdf-demo",
      href: null,
      pageIndex: 12,
      totalPages: 42,
    }, "book://pdf-cover");

    expect(presented.pageCount).toBe(42);
    expect(presented.pageCountLabel).toBe("42 pages");
    expect(presented.sectionCountLabel).toBe("42 pages");
    expect(presented.readSectionCount).toBe(12);
    expect(presented.progressValueLabel).toBe("12");
    expect(presented.progressTotalLabel).toBe("/ 42 pages");
    expect(presented.progressSummary).toBe("12 / 42 pages");
  });

  it("uses percentage only when an EPUB has no navigable chapter structure", () => {
    const presented = presentBookWithCoverSrc({
      ...book,
      id: "unstructured-epub",
      sectionCount: 0,
      sectionsSummary: [],
      tocCount: 0,
      spineCount: 0,
    }, {
      ...progress,
      bookId: "unstructured-epub",
      href: null,
      progressPercent: 0.4,
    }, null);

    expect(presented.readSectionCount).toBe(0);
    expect(presented.progressValueLabel).toBe("40%");
    expect(presented.progressTotalLabel).toBe("progress");
    expect(presented.progressSummary).toBe("40% read");
  });
});
