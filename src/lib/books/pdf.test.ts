import { describe, expect, it, vi } from "vitest";
import {
  configurePdfJsWorker,
  createPdfDocumentInit,
  createPdfPageHref,
  extractPdfBookData,
  resolvePdfSectionLabel,
} from "./pdf";

function makeDocumentRef(overrides: Record<string, unknown> = {}) {
  return {
    numPages: 12,
    getMetadata: vi.fn(async () => ({
      info: {
        Title: "The PDF Title",
        Author: "The PDF Author",
        Subject: "The PDF Subject",
        ISBN: "978-0-306-40615-7",
      },
      metadata: {
        get: vi.fn((key: string) => {
          if (key === "dc:title") return "The XMP Title";
          if (key === "dc:creator") return "The XMP Author";
          if (key === "dc:description") return "The XMP Description";
          return null;
        }),
      },
    })),
    getOutline: vi.fn(async () => ([
      { title: "Intro", dest: [{ num: 0 }], items: [] },
      { title: "Chapter One", dest: "chapter-one", items: [] },
    ])),
    getDestination: vi.fn(async (name: string) => {
      if (name === "chapter-one") return [{ num: 4 }];
      return null;
    }),
    getPageIndex: vi.fn(async (ref: { num: number }) => ref.num),
    destroy: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("extractPdfBookData", () => {
  it("extracts metadata, outline sections, page count, and a persisted cover", async () => {
    const documentRef = makeDocumentRef();
    const deps = {
      loadPdfDocument: vi.fn(async () => documentRef),
      renderPdfCoverBase64: vi.fn(async () => "Zm9vYmFy"),
      resolveAssetUrl: vi.fn(() => "book://demo.pdf"),
      writeBookCover: vi.fn(async () => "C:\\books\\covers\\demo.jpg"),
    };

    const result = await extractPdfBookData("C:\\books\\demo.pdf", "pdf-demo", "Fallback title", deps);

    expect(result.title).toBe("The PDF Title");
    expect(result.author).toBe("The PDF Author");
    expect(result.description).toBe("The PDF Subject");
    expect(result.isbns).toEqual(["9780306406157"]);
    expect(result.pageCount).toBe(12);
    expect(result.coverPath).toBe("C:\\books\\covers\\demo.jpg");
    expect(result.sectionsSummary).toEqual([
      { id: "pdf-outline:1:1", label: "Intro", href: "page:1", depth: 0 },
      { id: "pdf-outline:2:5", label: "Chapter One", href: "page:5", depth: 0 },
    ]);
    expect(result.sectionCount).toBe(2);
    expect(result.tocCount).toBe(2);
    expect(deps.resolveAssetUrl).toHaveBeenCalledWith("C:\\books\\demo.pdf");
    expect(deps.writeBookCover).toHaveBeenCalledWith("pdf-demo", "Zm9vYmFy", "jpg");
    expect(documentRef.destroy).toHaveBeenCalled();
  });

  it("falls back to filename title and page-only structure when metadata is absent", async () => {
    const documentRef = makeDocumentRef({
      getMetadata: vi.fn(async () => ({ info: {}, metadata: null })),
      getOutline: vi.fn(async () => null),
    });
    const deps = {
      loadPdfDocument: vi.fn(async () => documentRef),
      renderPdfCoverBase64: vi.fn(async () => null),
      resolveAssetUrl: vi.fn(() => "book://plain.pdf"),
      writeBookCover: vi.fn(async () => "unused"),
    };

    const result = await extractPdfBookData("C:\\books\\plain.pdf", "pdf-plain", "Plain PDF", deps);

    expect(result.title).toBe("Plain PDF");
    expect(result.author).toBeNull();
    expect(result.description).toBeNull();
    expect(result.isbns).toEqual([]);
    expect(result.coverPath).toBeNull();
    expect(result.pageCount).toBe(12);
    expect(result.sectionsSummary).toEqual([]);
    expect(result.sectionCount).toBe(0);
    expect(result.tocCount).toBe(0);
    expect(deps.writeBookCover).not.toHaveBeenCalled();
  });
});

describe("createPdfDocumentInit", () => {
  it("keeps range and streaming enabled for custom protocol URLs", () => {
    expect(createPdfDocumentInit("http://book.localhost/demo.pdf")).toEqual({
      url: "http://book.localhost/demo.pdf",
      disableWorker: true,
      disableRange: false,
      disableStream: false,
      disableAutoFetch: false,
    });
  });
});

describe("configurePdfJsWorker", () => {
  it("fills workerSrc once for pdfjs environments that need an explicit worker URL", () => {
    const pdfjsLib = {
      GlobalWorkerOptions: {},
    };

    configurePdfJsWorker(pdfjsLib);
    expect(typeof pdfjsLib.GlobalWorkerOptions.workerSrc).toBe("string");
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toContain("pdf.worker");
  });
});

describe("resolvePdfSectionLabel", () => {
  it("uses the nearest outline label at or before the current page", () => {
    expect(resolvePdfSectionLabel([
      { id: "s1", label: "Intro", href: createPdfPageHref(1), depth: 0 },
      { id: "s2", label: "Chapter Two", href: createPdfPageHref(8), depth: 0 },
    ], 9)).toBe("Chapter Two");
    expect(resolvePdfSectionLabel([], 3)).toBe("Page 3");
  });
});
