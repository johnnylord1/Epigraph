import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

const DETAIL_SURFACE_FILES = [
  "src/components/shared/SeriesDetailV3Shell.svelte",
  "src/components/pages/SeriesDetail.svelte",
  "src/components/pages/NovelDetail.svelte",
  "src/components/pages/BookDetail.svelte",
  "src/components/shared/DetailDownloadMenu.svelte",
] as const;

const TRACKING_SURFACE_FILES = [
  "src/components/shared/TrackingPanel.svelte",
  "src/components/shared/NovelTrackingPanel.svelte",
] as const;

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function componentStyleBlocks(source: string) {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
}

function milestoneDefinitions(source: string, prefix: "detail" | "tracking") {
  const start = source.indexOf("Marco 17 - Detail surfaces");
  expect(start).toBeGreaterThanOrEqual(0);
  return new Set(
    [...source.slice(start).matchAll(new RegExp(`(--component-${prefix}-[\\w-]+)\\s*:`, "g"))].map((match) => match[1]),
  );
}

function consumedTokens(source: string, prefix: "detail" | "tracking") {
  return new Set(
    [...source.matchAll(new RegExp(`var\\((--component-${prefix}-[\\w-]+)`, "g"))].map((match) => match[1]),
  );
}

describe("detail surfaces theme tokens", () => {
  test("keeps detail routes and tracking overlays active", () => {
    const layout = readRepoFile("src/components/layout/Layout.svelte");
    const series = readRepoFile("src/components/pages/SeriesDetail.svelte");
    const novel = readRepoFile("src/components/pages/NovelDetail.svelte");
    const book = readRepoFile("src/components/pages/BookDetail.svelte");

    expect(layout).toContain('series: () => import("../pages/SeriesDetail.svelte")');
    expect(layout).toContain('book: () => import("../pages/BookDetail.svelte")');
    expect(layout).toContain('novel: () => import("../pages/NovelDetail.svelte")');
    expect(series).toContain('import SeriesDetailV3Shell from "../shared/SeriesDetailV3Shell.svelte"');
    expect(series).toContain('import TrackingPanel from "../shared/TrackingPanel.svelte"');
    expect(novel).toContain('import SeriesDetailV3Shell from "../shared/SeriesDetailV3Shell.svelte"');
    expect(novel).toContain('import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte"');
    expect(book).toContain('import SeriesDetailV3Shell from "../shared/SeriesDetailV3Shell.svelte"');
    expect(book).toContain('import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte"');
  });

  test("keeps migrated app styles free of direct visual values and Nocturne internals", () => {
    const directVisualPattern =
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|--n-|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|z-index:\s*\d|opacity:\s*0\.\d|border-radius:\s*(?:\d|50%)/;

    const offenders = [...DETAIL_SURFACE_FILES, ...TRACKING_SURFACE_FILES].flatMap((file) =>
      componentStyleBlocks(readRepoFile(file)).at(-1)!
        .split(/\r?\n/)
        .map((text, index) => ({ file, line: index + 1, text: text.trim() }))
        .filter(({ text }) => text.length > 0 && directVisualPattern.test(text)),
    );

    expect(offenders).toEqual([]);
  });

  test("defines and consumes every Marco 17 detail and tracking token", () => {
    const tokensCss = readRepoFile("src/styles/tokens.css");
    const nocturne = readRepoFile("src/styles/nocturne-theme.css");
    const detailSource = DETAIL_SURFACE_FILES.map(readRepoFile).join("\n");
    const trackingSource = TRACKING_SURFACE_FILES.map(readRepoFile).join("\n");

    const detailDefinitions = milestoneDefinitions(tokensCss, "detail");
    const trackingDefinitions = milestoneDefinitions(tokensCss, "tracking");
    const detailNocturne = milestoneDefinitions(nocturne, "detail");
    const trackingNocturne = milestoneDefinitions(nocturne, "tracking");
    const detailConsumed = consumedTokens(detailSource, "detail");
    const trackingConsumed = consumedTokens(trackingSource, "tracking");

    const detailUnused = [...detailDefinitions].filter((token) => !detailConsumed.has(token)).sort();
    const trackingUnused = [...trackingDefinitions].filter((token) => !trackingConsumed.has(token)).sort();
    const detailUndefined = [...detailConsumed].filter((token) => !detailDefinitions.has(token)).sort();
    const trackingUndefined = [...trackingConsumed].filter((token) => !trackingDefinitions.has(token)).sort();
    const detailMissingNocturne = [...detailConsumed].filter((token) => !detailNocturne.has(token)).sort();
    const trackingMissingNocturne = [...trackingConsumed].filter((token) => !trackingNocturne.has(token)).sort();

    expect(detailDefinitions.size).toBe(254);
    expect(detailConsumed.size).toBe(254);
    expect(trackingDefinitions.size).toBe(117);
    expect(trackingConsumed.size).toBe(114);
    expect(detailUnused).toEqual([]);
    expect(trackingUnused).toEqual([
      "--component-tracking-record-tracker-icon-text-background",
      "--component-tracking-record-tracker-icon-text-border",
      "--component-tracking-record-tracker-icon-text-color",
    ]);
    expect(detailUndefined).toEqual([]);
    expect(trackingUndefined).toEqual([]);
    expect(detailMissingNocturne).toEqual([]);
    expect(trackingMissingNocturne).toEqual([]);
  });

  test("keeps global detail component tokens independent from local series aliases", () => {
    const tokenFiles = [
      "src/styles/tokens.css",
      "src/styles/nocturne-theme.css",
    ] as const;

    const leakedAliases = tokenFiles.flatMap((file) =>
      readRepoFile(file)
        .split(/\r?\n/)
        .map((text, index) => ({ file, line: index + 1, text: text.trim() }))
        .filter(({ text }) => /^--component-detail-[\w-]+:.*var\(--series-/.test(text)),
    );

    expect(leakedAliases).toEqual([]);
  });

  test("documents the standalone novel export HTML as the only direct-color exception", () => {
    const novel = readRepoFile("src/components/pages/NovelDetail.svelte");
    const exportedHtmlStyle = novel.match(/const html = `[^`]*<style>([\s\S]*?)<\/style>[^`]*`;/)?.[1] ?? "";

    expect(exportedHtmlStyle).toContain("background:#111");
    expect(exportedHtmlStyle).toContain("color:#e8e4eb");
    expect(exportedHtmlStyle).toContain("color:#d3c4ff");
    expect(exportedHtmlStyle).toContain("border-top:1px solid #2c2933");
  });
});
