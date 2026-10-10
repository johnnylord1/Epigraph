import { describe, expect, it } from "vitest";
import {
  buildBookSectionSummary,
  createBookSectionSnapshot,
  findBookSectionIndex,
  getBookSectionCount,
  getBookSectionsSummary,
  needsBookSectionBackfill,
  normalizeBookHrefKey,
  resolveBookSectionHrefFromProgress,
  resolveBookSectionLabel,
  resolveBookSectionProgress,
} from "./summary";
import type { BookEntry, BookSpineItem, BookTocItem } from "./types";

describe("normalizeBookHrefKey", () => {
  it("strips fragments, query strings, and path noise", () => {
    expect(normalizeBookHrefKey("./Text/Chapter-1.xhtml#part-2?ignored=yes")).toBe(
      "text/chapter-1.xhtml",
    );
  });
});

describe("buildBookSectionSummary", () => {
  it("prefers TOC labels while keeping spine order", () => {
    const spine: BookSpineItem[] = [
      { id: "s1", href: "OPS/Text/ch1.xhtml", label: "ch1.xhtml" },
      { id: "s2", href: "OPS/Text/ch2.xhtml", label: "ch2.xhtml" },
    ];
    const toc: BookTocItem[] = [
      { id: "t1", href: "OPS/Text/ch1.xhtml#top", label: "Chapter 1", depth: 0 },
      { id: "t2", href: "OPS/Text/ch2.xhtml?from=toc", label: "Chapter 2", depth: 1 },
    ];

    const sections = buildBookSectionSummary(toc, spine);

    expect(sections).toHaveLength(2);
    expect(sections.map((item) => item.label)).toEqual(["Chapter 1", "Chapter 2"]);
    expect(sections.map((item) => item.href)).toEqual([
      "OPS/Text/ch1.xhtml",
      "OPS/Text/ch2.xhtml",
    ]);
    expect(sections.map((item) => item.depth)).toEqual([0, 1]);
  });

  it("matches by basename when TOC and spine differ by base path", () => {
    const spine: BookSpineItem[] = [
      { id: "s1", href: "EPUB/Text/chapter-01.xhtml", label: "chapter-01.xhtml" },
    ];
    const toc: BookTocItem[] = [
      { id: "t1", href: "Text/chapter-01.xhtml#start", label: "Chapter 01", depth: 0 },
    ];

    const sections = buildBookSectionSummary(toc, spine);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      label: "Chapter 01",
      href: "EPUB/Text/chapter-01.xhtml",
      depth: 0,
    });
  });

  it("appends unmatched TOC items once after spine-backed sections", () => {
    const spine: BookSpineItem[] = [
      { id: "s1", href: "OPS/ch1.xhtml", label: "ch1.xhtml" },
    ];
    const toc: BookTocItem[] = [
      { id: "t1", href: "OPS/ch1.xhtml", label: "Chapter 1", depth: 0 },
      { id: "t2", href: "OPS/appendix.xhtml", label: "Appendix", depth: 0 },
      { id: "t3", href: "OPS/appendix.xhtml#fragment", label: "Appendix", depth: 0 },
    ];

    const sections = buildBookSectionSummary(toc, spine);

    expect(sections).toHaveLength(2);
    expect(sections.map((item) => item.label)).toEqual(["Chapter 1", "Appendix"]);
  });

  it("creates a persisted snapshot and reads it back without rebuilding", () => {
    const spine: BookSpineItem[] = [
      { id: "s1", href: "OPS/ch1.xhtml", label: "ch1.xhtml" },
    ];
    const toc: BookTocItem[] = [
      { id: "t1", href: "OPS/ch1.xhtml", label: "Chapter 1", depth: 0 },
    ];

    const snapshot = createBookSectionSnapshot(toc, spine);
    const book = {
      id: "book-1",
      title: "Example",
      author: null,
      description: null,
      coverPath: null,
      subtype: "epub",
      createdAt: 0,
      updatedAt: 0,
      importPath: "example.epub",
      assetPath: "example.epub",
      toc,
      spine,
      ...snapshot,
    } satisfies BookEntry;

    expect(needsBookSectionBackfill(book)).toBe(false);
    expect(getBookSectionCount(book)).toBe(1);
    expect(getBookSectionsSummary(book).map((item) => item.label)).toEqual(["Chapter 1"]);
  });

  it("matches sections by normalized href for labels and fallback progress", () => {
    const sections = [
      { id: "s1", label: "Chapter 1", href: "OPS/Text/ch1.xhtml", depth: 0 },
      { id: "s2", label: "Chapter 2", href: "OPS/Text/ch2.xhtml", depth: 0 },
      { id: "s3", label: "Chapter 3", href: "OPS/Text/ch3.xhtml", depth: 0 },
    ];

    expect(findBookSectionIndex(sections, "./Text/ch2.xhtml#frag")).toBe(1);
    expect(resolveBookSectionLabel(sections, "./Text/ch2.xhtml#frag")).toBe("Chapter 2");
    expect(resolveBookSectionProgress(sections, "./Text/ch2.xhtml#frag")).toBeCloseTo(1 / 3);
    expect(resolveBookSectionProgress(sections, "OPS/Text/ch3.xhtml")).toBeCloseTo(2 / 3);
    expect(resolveBookSectionHrefFromProgress(sections, 0.49)).toBe("OPS/Text/ch2.xhtml");
    expect(resolveBookSectionHrefFromProgress(sections, 2 / 3)).toBe("OPS/Text/ch3.xhtml");
    expect(resolveBookSectionHrefFromProgress(sections, 1)).toBe("OPS/Text/ch3.xhtml");
  });
});
