import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/reader/BookReader.svelte"),
  "utf8",
);

describe("BookReader PDF initialization", () => {
  it("loads scrolled PDFs without requiring the paginated canvas", () => {
    expect(source).toContain('flow !== "scrolled"');
    expect(source).toContain('store.settings.bookReaderFlow === "scrolled"');
    expect(source).toContain('scrollToPdfPage(pageNumber, "auto")');
  });

  it("retries visible scrolled pages after the PDF document becomes ready", () => {
    expect(source).toContain("let pdfDocumentGeneration = $state(0)");
    expect(source).toContain("pdfDocumentGeneration += 1");
    expect(source).toContain("documentGeneration: pdfDocumentGeneration");
  });

  it("does not let initial scroll observers persist placeholder progress", () => {
    expect(source).toContain("if (loading || Date.now() < suspendReflowProgressUntil) return");
    expect(source).toContain("selectDominantReaderPage(visiblePdfPages.values())");
  });
});
