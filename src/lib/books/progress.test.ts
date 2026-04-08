import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBookBookmark,
  getBookProgressPrecision,
  mergeBookProgress,
  normalizeBookBookmark,
  normalizeBookProgress,
  resolveBookResumeTarget,
} from "./progress";

describe("normalizeBookProgress", () => {
  it("keeps EPUB progress fields and backfills optional reader fields", () => {
    expect(normalizeBookProgress({
      bookId: "book-1",
      location: "epubcfi(/6/2)",
      href: "OPS/ch1.xhtml",
      progressPercent: 0.42,
      lastReadAt: 123,
    })).toEqual({
      bookId: "book-1",
      location: "epubcfi(/6/2)",
      href: "OPS/ch1.xhtml",
      progressPercent: 0.42,
      lastReadAt: 123,
      pageIndex: null,
      totalPages: null,
      sectionLabel: null,
      renderer: null,
    });
  });

  it("normalizes PDF progress fields", () => {
    expect(normalizeBookProgress({
      bookId: "pdf-1",
      progressPercent: 0.5,
      lastReadAt: 456,
      pageIndex: 12,
      totalPages: 24,
      sectionLabel: "Page 12",
      renderer: "pdf",
    })).toEqual({
      bookId: "pdf-1",
      location: null,
      href: null,
      progressPercent: 0.5,
      lastReadAt: 456,
      pageIndex: 12,
      totalPages: 24,
      sectionLabel: "Page 12",
      renderer: "pdf",
    });
  });
});

describe("book bookmarks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes persisted bookmark data", () => {
    expect(normalizeBookBookmark({
      bookId: "book-1",
      location: "epubcfi(/6/4)",
      href: "OPS/ch2.xhtml",
      progressPercent: 0.8,
      label: "Chapter 2",
      savedAt: 789,
    })).toEqual({
      bookId: "book-1",
      location: "epubcfi(/6/4)",
      href: "OPS/ch2.xhtml",
      pageIndex: null,
      progressPercent: 0.8,
      label: "Chapter 2",
      savedAt: 789,
    });
  });

  it("preserves entry labels when creating a bookmark", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);

    expect(createBookBookmark({
      bookId: "pdf-1",
      location: null,
      href: null,
      pageIndex: 5,
      progressPercent: 0.25,
      label: "Page 5",
    })).toEqual({
      bookId: "pdf-1",
      location: null,
      href: null,
      pageIndex: 5,
      progressPercent: 0.25,
      label: "Page 5",
      savedAt: 1_700_000_000_000,
    });
  });
});

describe("book progress precedence", () => {
  it("treats EPUB locations as stronger than href-only fallback", () => {
    expect(getBookProgressPrecision(normalizeBookProgress({
      bookId: "book-1",
      location: "epubcfi(/6/2)",
      href: "OPS/ch1.xhtml",
      progressPercent: 0.42,
      lastReadAt: 123,
      renderer: "epub",
    }))).toBe("precise");

    expect(getBookProgressPrecision(normalizeBookProgress({
      bookId: "book-1",
      href: "OPS/ch1.xhtml",
      progressPercent: 0.1,
      lastReadAt: 124,
      renderer: "epub",
    }))).toBe("fallback");
  });

  it("never lets weaker fallback overwrite stronger precise EPUB progress", () => {
    const merged = mergeBookProgress(
      {
        bookId: "book-1",
        location: "epubcfi(/6/2)",
        href: "OPS/ch1.xhtml",
        progressPercent: 0.42,
        lastReadAt: 100,
        sectionLabel: "Chapter 1",
        renderer: "epub",
      },
      {
        bookId: "book-1",
        location: null,
        href: "OPS/ch9.xhtml",
        progressPercent: 0.9,
        lastReadAt: 200,
        sectionLabel: "Chapter 9",
        renderer: "epub",
      },
    );

    expect(merged).toMatchObject({
      location: "epubcfi(/6/2)",
      href: "OPS/ch1.xhtml",
      progressPercent: 0.42,
      sectionLabel: "Chapter 1",
      lastReadAt: 200,
      renderer: "epub",
    });
  });

  it("promotes fallback EPUB progress to precise progress when a location arrives", () => {
    const merged = mergeBookProgress(
      {
        bookId: "book-1",
        location: null,
        href: "OPS/ch4.xhtml",
        progressPercent: 0.25,
        lastReadAt: 100,
        sectionLabel: "Chapter 4",
        renderer: "epub",
      },
      {
        bookId: "book-1",
        location: "epubcfi(/6/18)",
        href: null,
        progressPercent: 0.31,
        lastReadAt: 150,
        sectionLabel: null,
        renderer: "epub",
      },
    );

    expect(merged).toMatchObject({
      location: "epubcfi(/6/18)",
      href: "OPS/ch4.xhtml",
      progressPercent: 0.31,
      sectionLabel: "Chapter 4",
      lastReadAt: 150,
      renderer: "epub",
    });
  });

  it("prefers the precise resume target when both precise and fallback values exist", () => {
    expect(resolveBookResumeTarget({
      bookId: "book-1",
      location: "epubcfi(/6/8)",
      href: "OPS/ch2.xhtml",
      progressPercent: 0.2,
      lastReadAt: 123,
      renderer: "epub",
    })).toBe("epubcfi(/6/8)");

    expect(resolveBookResumeTarget({
      bookId: "book-2",
      location: null,
      href: "OPS/ch3.xhtml",
      progressPercent: 0.3,
      lastReadAt: 123,
      renderer: "epub",
    })).toBe("OPS/ch3.xhtml");

    expect(resolveBookResumeTarget({
      bookId: "book-3",
      location: null,
      href: null,
      progressPercent: 0,
      lastReadAt: 0,
      renderer: "epub",
    })).toBeNull();
  });

  it("keeps the strongest persisted progress across a serialize/hydrate roundtrip", () => {
    const persisted = normalizeBookProgress(JSON.parse(JSON.stringify(mergeBookProgress(
      {
        bookId: "book-1",
        location: null,
        href: "OPS/ch4.xhtml",
        progressPercent: 0.25,
        lastReadAt: 100,
        sectionLabel: "Chapter 4",
        renderer: "epub",
      },
      {
        bookId: "book-1",
        location: "epubcfi(/6/18)",
        href: "OPS/ch4.xhtml",
        progressPercent: 0.31,
        lastReadAt: 150,
        sectionLabel: "Chapter 4",
        renderer: "epub",
      },
    ))));

    const mergedAfterHydration = mergeBookProgress(persisted, {
      bookId: "book-1",
      location: null,
      href: "OPS/ch9.xhtml",
      progressPercent: 0.9,
      lastReadAt: 200,
      sectionLabel: "Chapter 9",
      renderer: "epub",
    });

    expect(persisted).toMatchObject({
      location: "epubcfi(/6/18)",
      href: "OPS/ch4.xhtml",
      progressPercent: 0.31,
      sectionLabel: "Chapter 4",
    });
    expect(mergedAfterHydration).toMatchObject({
      location: "epubcfi(/6/18)",
      href: "OPS/ch4.xhtml",
      progressPercent: 0.31,
      sectionLabel: "Chapter 4",
      lastReadAt: 200,
    });
  });
});
