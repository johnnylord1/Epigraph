import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ACTIVE_LIBRARY_FILES = [
  "src/components/pages/Library.svelte",
  "src/components/library/BooksLibraryBody.svelte",
  "src/components/library/ComicsLibraryBody.svelte",
  "src/components/library/BooksTypeSelector.svelte",
  "src/components/library/LibraryCard.svelte",
  "src/components/library/LibraryCardGrid.svelte",
  "src/components/library/LibraryCollectionsBar.svelte",
  "src/components/library/LibraryDensityRail.svelte",
  "src/components/library/LibraryDisplayPopover.svelte",
  "src/components/library/LibraryHeader.svelte",
  "src/components/library/LibraryShell.svelte",
  "src/components/library/LibraryToolbar.svelte",
  "src/components/library/VirtualLibraryCardGrid.svelte",
] as const;

const TOKEN_SOURCE_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function stripAllowedAssetPayloads(css: string): string {
  return css.replace(/url\("data:image\/svg\+xml,[^)]+\"\)/g, "url(--asset)");
}

describe("Library theme token contract", () => {
  it("uses the same search glyph contract as the other app topbars", () => {
    const source = read("src/components/library/LibraryToolbar.svelte");

    expect(source).toContain('<span class="n-search__icon material-symbols-outlined" aria-hidden="true">search</span>');
    expect(source).not.toContain("MagnifyingGlass");
  });

  it("keeps active Library components free of direct color functions and Nocturne internals", () => {
    const directColorPattern = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/i;
    const nocturneInternalPrefix = "--" + "n-";
    const violations = ACTIVE_LIBRARY_FILES.flatMap((file) => {
      const contents = stripAllowedAssetPayloads(read(file));
      return contents
        .split(/\r?\n/)
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => directColorPattern.test(text) || text.includes(nocturneInternalPrefix));
    });

    expect(violations).toEqual([]);
  });

  it("consumes every component Library token defined for the milestone", () => {
    const definitions = new Set<string>();
    for (const file of TOKEN_SOURCE_FILES) {
      const contents = read(file);
      for (const match of contents.matchAll(/--component-library-[A-Za-z0-9_-]+\s*:/g)) {
        definitions.add(match[0].slice(0, -1).trim());
      }
    }

    const componentContents = ACTIVE_LIBRARY_FILES.map(read).join("\n");
    const unused = [...definitions].filter((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`var\\(${escaped}(?:[,)]|\\s)`).test(componentContents);
    });

    expect(unused).toEqual([]);
  });
});
