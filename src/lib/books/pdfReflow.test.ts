import { describe, expect, it } from "vitest";
import {
  assemblePdfTextElements,
  classifyPdfImage,
  collectPdfImageCandidates,
  getReflowElementKey,
  pruneReflowedPages,
  resolvePageFromReflowElementKey,
  resolveReflowElementKeyForPage,
  shouldRetainImageWithText,
  type PdfTextItemLike,
  type ReflowedPage,
} from "./pdfReflow";

function item(str: string, x: number, y: number, width = str.length * 7, height = 12): PdfTextItemLike {
  return {
    str,
    width,
    height,
    transform: [height, 0, 0, height, x, y],
  };
}

describe("assemblePdfTextElements", () => {
  it("merges text runs into lines and groups consecutive lines into paragraphs", () => {
    const elements = assemblePdfTextElements([
      item("Novel Title", 260, 770),
      item("12", 300, 22),
      item("The quick", 72, 700),
      item("brown fox", 140, 700),
      item("jumped over the lazy dog", 72, 678),
      item("A second paragraph starts here.", 72, 620),
    ], { width: 612, height: 792 }, {
      repeatedMarkers: ["Novel Title"],
    });

    expect(elements).toEqual([
      {
        type: "paragraph",
        text: "The quick brown fox jumped over the lazy dog",
      },
      {
        type: "paragraph",
        text: "A second paragraph starts here.",
      },
    ]);
  });

  it("filters compact running headers from the top-right margin", () => {
    const elements = assemblePdfTextElements([
      item("とある魔術の禁書目録", 400, 803, 110, 10.6),
      item("Actual prose begins on this line", 140, 759, 240, 13),
      item("and continues normally.", 85, 742, 180, 13),
      item("20", 500, 64, 12, 12),
    ], { width: 595.4, height: 841.8 });

    expect(elements).toEqual([
      {
        type: "paragraph",
        text: "Actual prose begins on this line and continues normally.",
      },
    ]);
  });

  it("promotes oversized short lines to headings", () => {
    const elements = assemblePdfTextElements([
      item("CHAPTER ONE", 120, 710, 180, 24),
      item("A quiet paragraph begins here", 72, 660, 240, 12),
      item("and continues on the next line.", 72, 638, 245, 12),
    ], { width: 612, height: 792 });

    expect(elements).toEqual([
      { type: "heading", text: "CHAPTER ONE", level: 1 },
      {
        type: "paragraph",
        text: "A quiet paragraph begins here and continues on the next line.",
      },
    ]);
  });
});

describe("PDF illustration filtering", () => {
  const viewport = { width: 600, height: 800 };

  it("discards backgrounds and tiny decorative images while retaining illustrations", () => {
    expect(classifyPdfImage({ objectId: "bg", width: 600, height: 760 }, viewport)).toBe("background");
    expect(classifyPdfImage({ objectId: "dot", width: 24, height: 24 }, viewport)).toBe("decorative");
    expect(classifyPdfImage({ objectId: "illo", width: 320, height: 260 }, viewport)).toBe("illustration");
  });

  it("uses drawn image dimensions from PDF transforms instead of intrinsic bitmap dimensions", () => {
    const candidates = collectPdfImageCandidates({
      fnArray: [10, 12, 85, 11, 10, 12, 85, 11],
      argsArray: [
        [],
        [600, 0, 0, 840, 0, 0],
        ["full-page-illustration", 1504, 2124],
        [],
        [],
        [320, 0, 0, 260, 40, 120],
        ["inline-illustration", 1600, 1300],
        [],
      ],
    }, viewport, {
      save: 10,
      restore: 11,
      transform: 12,
      paintImageXObject: 85,
    });

    expect(candidates).toEqual([
      {
        objectId: "full-page-illustration",
        width: 600,
        height: 840,
        intrinsicWidth: 1504,
        intrinsicHeight: 2124,
        operatorIndex: 2,
      },
      {
        objectId: "inline-illustration",
        width: 320,
        height: 260,
        intrinsicWidth: 1600,
        intrinsicHeight: 1300,
        operatorIndex: 6,
      },
    ]);
  });

  it("drops large page-width image washes on dense text pages", () => {
    const repeatedPageWash = { objectId: "page-bg", width: 578, height: 517 };

    expect(shouldRetainImageWithText(repeatedPageWash, { width: 595.4, height: 841.8 }, 0)).toBe(false);
    expect(shouldRetainImageWithText(repeatedPageWash, { width: 595.4, height: 841.8 }, 4, false)).toBe(true);
    expect(shouldRetainImageWithText(repeatedPageWash, { width: 595.4, height: 841.8 }, 17)).toBe(false);
  });

  it("can aggressively clean large watermarks on sparse text pages", () => {
    const watermark = { objectId: "watermark", width: 578, height: 517 };
    const viewport = { width: 595.4, height: 841.8 };
    const landscapeViewport = { width: 841.8, height: 595.4 };
    const fullPageIllustration = { objectId: "illustration", width: 595.4, height: 841.8 };

    expect(shouldRetainImageWithText(watermark, viewport, 0, true)).toBe(false);
    expect(shouldRetainImageWithText(watermark, landscapeViewport, 0, true)).toBe(false);
    expect(shouldRetainImageWithText(watermark, viewport, 2, true)).toBe(false);
    expect(shouldRetainImageWithText(watermark, viewport, 2, false)).toBe(true);
    expect(shouldRetainImageWithText(fullPageIllustration, viewport, 0, true)).toBe(true);
  });
});

describe("PDF reflow progress mapping", () => {
  it("maps paragraph anchors to source pages and back", () => {
    const pages: ReflowedPage[] = [
      {
        pageNumber: 3,
        elements: [
          { type: "image", objectId: "img_1", width: 200, height: 200 },
          { type: "paragraph", text: "The first readable paragraph." },
        ],
      },
      {
        pageNumber: 4,
        elements: [
          { type: "heading", text: "Next", level: 2 },
        ],
      },
    ];

    const key = resolveReflowElementKeyForPage(pages, 3);
    expect(key).toBe(getReflowElementKey(3, 1));
    expect(resolvePageFromReflowElementKey(key)).toBe(3);
    expect(resolvePageFromReflowElementKey(resolveReflowElementKeyForPage(pages, 4))).toBe(4);
  });

  it("keeps only a bounded window of extracted reflow pages", () => {
    const pages: ReflowedPage[] = Array.from({ length: 12 }, (_, index) => ({
      pageNumber: index + 1,
      elements: [{ type: "paragraph", text: `Page ${index + 1}` }],
    }));

    expect(pruneReflowedPages(pages, 6, 2).map((page) => page.pageNumber)).toEqual([4, 5, 6, 7, 8]);
    expect(pruneReflowedPages(pages, 1, 2).map((page) => page.pageNumber)).toEqual([1, 2, 3]);
  });
});
