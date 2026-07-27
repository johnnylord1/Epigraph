import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const COMPONENTS_ROOT = resolve(process.cwd(), "src/components");

// Existing callers migrate incrementally. Adding a new direct caller is forbidden.
const LEGACY_DIRECT_GRAPHQL_COMPONENTS = new Set([
  "pages/BrowseV3.svelte",
  "pages/Downloads.svelte",
  "pages/Home.svelte",
  "pages/Library.svelte",
  "pages/MassMigrateModal.svelte",
  "pages/MigrateModal.svelte",
  "pages/SeriesDetail.svelte",
  "pages/SourcesView.svelte",
  "reader/Reader.svelte",
  "search/SearchPalette.svelte",
  "settings/Settings.svelte",
  "shared/MangaPreview.svelte",
  "shared/TrackingPanel.svelte",
]);

function walkSvelteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return walkSvelteFiles(path);
    return entry.isFile() && entry.name.endsWith(".svelte") ? [path] : [];
  });
}

function importsDirectGraphql(source: string): boolean {
  return /import\s*\{[^}]*\bgql(?:Upload)?\b[^}]*\}\s*from\s*["'][^"']*\/client["']/s.test(source);
}

describe("source runtime GraphQL boundary", () => {
  test("prevents new components from importing the raw GraphQL client", () => {
    expect(statSync(COMPONENTS_ROOT).isDirectory()).toBe(true);

    const directCallers = walkSvelteFiles(COMPONENTS_ROOT)
      .filter((path) => importsDirectGraphql(readFileSync(path, "utf8")))
      .map((path) => relative(COMPONENTS_ROOT, path).replaceAll("\\", "/"))
      .sort();

    const unexpected = directCallers.filter(
      (path) => !LEGACY_DIRECT_GRAPHQL_COMPONENTS.has(path),
    );
    expect(unexpected).toEqual([]);
  });
});
