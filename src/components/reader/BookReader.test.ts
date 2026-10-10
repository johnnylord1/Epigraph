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

  it("never starts a second page render on the canvas while one is still fetching the page", () => {
    const render = source.slice(source.indexOf("async function renderPdfPage("), source.indexOf("async function drawPdfPage("));
    const guard = render.indexOf("if (pdfRenderBusy) {");
    const claim = render.indexOf("pdfRenderBusy = true;");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
    expect(claim).toBeLessThan(render.indexOf("await drawPdfPage(targetPage)"));
    expect(render).toContain("await renderPdfPage(queuedPage);");
  });

  it("flushes authoritative book progress when the reader closes or the app exits", () => {
    expect(source).toContain("flushBookLibraryPersistence");
    expect(source).toContain('window.addEventListener("pagehide", flushBookProgress)');
    expect(source).toContain("await flushBookLibraryPersistence()");
  });
});

describe("BookReader EPUB resume", () => {
  it("shows the saved spot again after the reader stylesheet reflows the text", () => {
    const load = source.slice(source.indexOf("async function loadEpub("), source.indexOf("async function renderPdfPage("));
    const firstDisplay = load.indexOf("if (target) await rendition.display(target);");
    const theme = load.indexOf("applyEpubTheme();", firstDisplay);
    const redisplay = load.indexOf("await rendition.display(target);", theme);
    expect(firstDisplay).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(firstDisplay);
    expect(redisplay).toBeGreaterThan(theme);
    expect(load.slice(theme, redisplay)).toContain("fonts?.ready");
    expect(load.slice(theme, redisplay)).toContain("if (token !== loadToken || currentRendition !== rendition) return;");
  });

  it("saves the position once, after opening settles on the saved spot", () => {
    const load = source.slice(source.indexOf("async function loadEpub("), source.indexOf("async function renderPdfPage("));
    const restoring = load.indexOf("epubRestoring = true;");
    const relocated = load.indexOf('rendition.on("relocated"');
    const lastDisplay = load.lastIndexOf("await rendition.display(target);");
    const settled = load.indexOf("epubRestoring = false;");
    expect(restoring).toBeGreaterThan(-1);
    expect(relocated).toBeGreaterThan(restoring);
    expect(load).toContain("updateEpubProgress(location, !epubRestoring);");
    expect(settled).toBeGreaterThan(lastDisplay);
    expect(load.indexOf("persistEpubProgress();", settled)).toBeGreaterThan(settled);
    const locations = source.slice(
      source.indexOf("async function generateEpubLocationsInBackground("),
      source.indexOf("async function loadEpub("),
    );
    expect(locations).toContain("if (!epubRestoring && pageNumber !== shownPercent) persistEpubProgress();");
  });
});
