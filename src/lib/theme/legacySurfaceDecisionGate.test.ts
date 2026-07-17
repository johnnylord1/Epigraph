import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, posix, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();

const LEGACY_SURFACE_IMPORTERS = new Map<string, string[]>([
  ["src/components/pages/Discover.svelte", []],
  ["src/components/pages/Extensions.svelte", ["src/routes.ts"]],
  ["src/components/shared/SourceBrowse.svelte", ["src/components/pages/Discover.svelte"]],
  ["src/components/shared/SourceList.svelte", []],
  ["src/components/pages/NovelSources.svelte", []],
  ["src/components/novels/NovelSourceCheckModal.svelte", ["src/components/settings/NovelRepositoriesPanel.svelte"]],
  ["src/components/novels/NovelSourceStatusDetails.svelte", [
    "src/components/pages/NovelSources.svelte",
    "src/components/settings/NovelRepositoriesPanel.svelte",
  ]],
  ["src/components/settings/NovelRepositoriesPanel.svelte", []],
  ["src/components/library/NovelsLibraryBody.svelte", []],
  ["src/components/pages/Tracking.svelte", []],
  ["src/components/pages/GenreDrillPage.svelte", []],
  ["src/routes.ts", []],
]);

function projectFiles(path: string): string[] {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return projectFiles(child);
    if (!/\.(?:svelte|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [child];
  });
}

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

function resolveSpecifier(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = normalize(posix.normalize(posix.join(dirname(normalize(importer)), specifier)));
  if (extname(candidate)) return candidate;
  for (const suffix of [".svelte", ".ts"]) {
    const resolved = `${candidate}${suffix}`;
    try {
      read(resolved);
      return resolved;
    } catch {
      // Try the next supported source extension.
    }
  }
  return candidate;
}

function importedTargets(path: string): string[] {
  const source = read(path);
  const specifiers = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
  return specifiers
    .map((specifier) => resolveSpecifier(path, specifier))
    .filter((target): target is string => target !== null);
}

describe("Legacy surface decision gate", () => {
  const files = projectFiles("src");
  const importGraph = new Map(files.map((path) => [path, importedTargets(path)]));

  test("freezes the complete quarantined import graph", () => {
    for (const [target, expectedImporters] of LEGACY_SURFACE_IMPORTERS) {
      const importers = files
        .filter((path) => path !== target && importGraph.get(path)?.includes(target))
        .sort();
      expect(importers, target).toEqual([...expectedImporters].sort());
    }
  });

  test("keeps every quarantine chain unreachable from a non-Legacy root", () => {
    const legacy = new Set(LEGACY_SURFACE_IMPORTERS.keys());
    const externalImporters = [...legacy].flatMap((target) =>
      files
        .filter((path) => !legacy.has(path) && importGraph.get(path)?.includes(target))
        .map((path) => `${path} -> ${target}`),
    );

    expect(externalImporters).toEqual([]);
  });

  test("keeps the active shell on the modern page loaders", () => {
    const layout = read("src/components/layout/Layout.svelte");
    for (const page of ["Home", "Library", "Search", "Downloads", "Settings"]) {
      expect(layout).toContain(`../${page === "Settings" ? "settings" : "pages"}/${page}.svelte`);
    }
    expect(layout).not.toContain("../../routes");
    expect(layout).not.toContain("../routes");
  });

  test("keeps BrowseV3 and SourcesView as the active discovery/source surfaces", () => {
    expect(read("src/components/pages/Search.svelte")).toContain('import BrowseV3 from "./BrowseV3.svelte"');
    const browse = read("src/components/pages/BrowseV3.svelte");
    expect(browse).toContain('import SourcesView from "./SourcesView.svelte"');
    expect(browse).not.toContain("Discover.svelte");
    expect(browse).not.toContain("Extensions.svelte");
  });

  test("keeps the current Library and tracking surfaces independent from Legacy pages", () => {
    const library = read("src/components/pages/Library.svelte");
    expect(library).toContain('import BooksLibraryBody from "../library/BooksLibraryBody.svelte"');
    expect(library).toContain('import ComicsLibraryBody from "../library/ComicsLibraryBody.svelte"');
    expect(library).not.toContain("NovelsLibraryBody.svelte");

    expect(read("src/components/pages/SeriesDetail.svelte")).toContain(
      'import TrackingPanel from "../shared/TrackingPanel.svelte"',
    );
    expect(read("src/components/pages/NovelDetail.svelte")).toContain(
      'import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte"',
    );
  });

  test("keeps the old novel repository panel outside active Settings", () => {
    const settings = read("src/components/settings/Settings.svelte");
    expect(settings).not.toContain("NovelRepositoriesPanel.svelte");
    expect(settings).toContain("novelRepositoryState");
  });
});
