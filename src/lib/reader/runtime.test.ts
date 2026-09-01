import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { attachReaderCloseGuard, clampReaderPage, selectDominantReaderPage } from "./runtime";

describe("reader runtime helpers", () => {
  it("waits for a durable save before allowing native window close", async () => {
    let handler!: (event: { preventDefault(): void }) => Promise<void>;
    let prevented = 0;
    let closed = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const dispose = await attachReaderCloseGuard({
      onCloseRequested: async (callback) => { handler = callback; return () => {}; },
      close: async () => { closed++; },
    }, () => pending, () => {});
    const closing = handler({ preventDefault: () => { prevented++; } });
    expect(prevented).toBe(1);
    expect(closed).toBe(0);
    finish();
    await closing;
    expect(closed).toBe(1);
    dispose();
  });

  it("keeps the window open after a failed flush and lets the user retry", async () => {
    let handler!: (event: { preventDefault(): void }) => Promise<void>;
    let closed = 0;
    let attempts = 0;
    const errors: unknown[] = [];
    await attachReaderCloseGuard({
      onCloseRequested: async (callback) => { handler = callback; return () => {}; },
      close: async () => { closed++; },
    }, async () => { if (++attempts === 1) throw new Error("disk full"); }, (error) => { errors.push(error); });
    await handler({ preventDefault() {} });
    expect(closed).toBe(0);
    expect(errors).toHaveLength(1);
    await handler({ preventDefault() {} });
    expect(closed).toBe(1);
  });

  it("clamps imported and stale page positions", () => {
    expect(clampReaderPage(-20, 40)).toBe(1);
    expect(clampReaderPage(91, 40)).toBe(40);
    expect(clampReaderPage(Number.NaN, 40)).toBe(1);
  });

  it("selects the most visible page deterministically", () => {
    expect(selectDominantReaderPage([
      { pageNumber: 7, visibleRatio: 0.4, centerDistance: 30 },
      { pageNumber: 8, visibleRatio: 0.8, centerDistance: 90 },
      { pageNumber: 9, visibleRatio: 0.8, centerDistance: 20 },
    ])).toBe(9);
  });

  it("ignores pages outside the actual viewport", () => {
    expect(selectDominantReaderPage([
      { pageNumber: 3, visibleRatio: 0, centerDistance: 0 },
    ])).toBeNull();
  });
});

describe("reader runtime integration", () => {
  const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("allows the native close listener to finish the approved close", () => {
    const capability = JSON.parse(source("src-tauri/capabilities/default.json"));
    expect(capability.permissions).toContain("core:window:allow-destroy");
  });

  it("coalesces longstrip work and separates preload from auto append", () => {
    const mangaReader = source("src/components/reader/Reader.svelte");
    expect(mangaReader).toContain("scrollTrackingRafId = requestAnimationFrame(processScroll)");
    expect(mangaReader).toContain("if (pct >= 0.80) preloadNextChapter()");
    expect(mangaReader).toContain("if (autoNext) appendNextChapter()");
    expect(mangaReader).toContain("autoAppendedChapterIds.has(next.id)");
  });

  it("bounds resume work and leaves overlayBars unchanged", () => {
    const mangaReader = source("src/components/reader/Reader.svelte");
    expect(mangaReader).toContain("if (attempts < 120) resumeRafId = requestAnimationFrame(scrollToResumePage)");
    expect(mangaReader).toContain("const overlayBars = $derived(store.settings.overlayBars ?? false)");
  });

  it("invalidates stale novel and book continuations", () => {
    const novelReader = source("src/components/reader/NovelReader.svelte");
    const bookReader = source("src/components/reader/BookReader.svelte");
    expect(novelReader).toContain("const generation = ++chapterLoadGeneration");
    expect(novelReader).toContain("if (!isCurrent()) return");
    expect(bookReader).toContain("token !== loadToken || documentRef !== currentPdfDoc");
    expect(bookReader).toContain("if (signature === lastProgressSignature) return");
  });

  it("keeps the idle lock out of all active readers", () => {
    const app = source("src/App.svelte");
    expect(app).toContain("&& !store.activeNovelReader");
  });
});
