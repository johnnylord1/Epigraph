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
  const clientModule = String.raw`["'][^"']*\/client["']`;
  return new RegExp(
    String.raw`import\s*\{[^}]*\bgql(?:Upload)?\b[^}]*\}\s*from\s*${clientModule}`,
    "s",
  ).test(source)
    || new RegExp(String.raw`import\s*\*\s*as\s+\w+\s*from\s*${clientModule}`, "s").test(source)
    || new RegExp(String.raw`import\s*\(\s*${clientModule}\s*\)`, "s").test(source);
}

describe("source runtime GraphQL boundary", () => {
  test("detects named, namespace, and dynamic access to the raw GraphQL client", () => {
    expect(importsDirectGraphql('import { gql as rawGql } from "../../lib/client";')).toBe(true);
    expect(importsDirectGraphql('import * as client from "../../lib/client";')).toBe(true);
    expect(importsDirectGraphql('const client = await import("../../lib/client");')).toBe(true);
    expect(importsDirectGraphql('import { getServerUrl } from "../../lib/client";')).toBe(false);
  });

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
