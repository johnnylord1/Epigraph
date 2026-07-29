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

  it("does not let initial scroll observers persist placeholder progress", () => {
    expect(source).toContain("if (!loading) syncPdfProgress(pageNum)");
    expect(source).toContain("if (!loading) {");
  });
});
