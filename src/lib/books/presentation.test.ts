import { describe, expect, it } from "vitest";
import { presentBookWithCoverSrc } from "./presentation";
import type { BookEntry, BookProgress } from "./types";

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
    const presented = presentBookWithCoverSrc(book, progress, "book://cover");

    expect(presented.id).toBe("epub-demo");
    expect(presented.coverSrc).toBe("book://cover");
    expect(presented.authorLabel).toBe("Author");
    expect(presented.sectionCount).toBe(10);
    expect(presented.progressSummary).toBe("3 / 10 read");
    expect(presented.sectionCountLabel).toBe("10 chapters");
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
    }, "book://pdf-cover");

    expect(presented.pageCount).toBe(42);
    expect(presented.pageCountLabel).toBe("42 pages");
    expect(presented.sectionCountLabel).toBe("42 pages");
  });
});
