import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const REMOVED_SURFACES = [
  "src/components/pages/Discover.svelte",
  "src/components/pages/Extensions.svelte",
  "src/components/shared/SourceBrowse.svelte",
  "src/components/shared/SourceList.svelte",
  "src/components/pages/NovelSources.svelte",
  "src/components/novels/NovelSourceCheckModal.svelte",
  "src/components/novels/NovelSourceStatusDetails.svelte",
  "src/components/settings/NovelRepositoriesPanel.svelte",
  "src/components/library/NovelsLibraryBody.svelte",
  "src/components/pages/Tracking.svelte",
  "src/components/pages/GenreDrillPage.svelte",
  "src/routes.ts",
] as const;

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

describe("removed Legacy surface gate", () => {
  test("keeps every quarantined source physically absent", () => {
    for (const path of REMOVED_SURFACES) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(false);
    }
  });

  test("keeps production imports free of removed surface names", () => {
    const references = projectFiles("src").flatMap((path) =>
      REMOVED_SURFACES
        .filter((removed) => read(path).includes(removed.split("/").at(-1)!))
        .map((removed) => `${path} -> ${removed}`),
    );

    expect(references).toEqual([]);
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
  });

  test("keeps the current Library and tracking surfaces active", () => {
    const library = read("src/components/pages/Library.svelte");
    expect(library).toContain('import BooksLibraryBody from "../library/BooksLibraryBody.svelte"');
    expect(library).toContain('import ComicsLibraryBody from "../library/ComicsLibraryBody.svelte"');
    expect(read("src/components/pages/SeriesDetail.svelte")).toContain(
      'import TrackingPanel from "../shared/TrackingPanel.svelte"',
    );
    expect(read("src/components/pages/NovelDetail.svelte")).toContain(
      'import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte"',
    );
    expect(read("src/components/pages/BookDetail.svelte")).toContain(
      'import NovelTrackingPanel from "../shared/NovelTrackingPanel.svelte"',
    );
  });

  test("keeps repository management in active SourcesView", () => {
    const sources = read("src/components/pages/SourcesView.svelte");
    expect(sources).toContain("novelRepositoryState");
    expect(sources).toContain("refreshNovelRepositoryCatalog");
    expect(read("src/components/settings/Settings.svelte")).not.toContain("NovelRepositoriesPanel");
  });
});
