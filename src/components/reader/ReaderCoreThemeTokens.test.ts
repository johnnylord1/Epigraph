import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const READER_FILES = [
  "src/components/reader/Reader.svelte",
  "src/components/reader/BookReader.svelte",
  "src/components/reader/NovelReader.svelte",
];

const TOKEN_PATTERN = /--component-reader-core-[A-Za-z0-9_-]+/g;
const TOKEN_DEFINITION_PATTERN = /--component-reader-core-[A-Za-z0-9_-]+(?=\s*:)/g;
const CUSTOM_PROPERTY_DEFINITION_PATTERN = /--[A-Za-z0-9_-]+(?=\s*:)/g;
const CUSTOM_PROPERTY_REFERENCE_PATTERN = /var\((--[A-Za-z0-9_-]+)(\s*,[^)]+)?\)/g;
const READER_TOKEN_DECLARATION_PATTERN = /--component-reader-core-[A-Za-z0-9_-]+\s*:\s*[^;]+;/g;
const STYLE_BLOCK_PATTERN = /<style[^>]*>([\s\S]*?)<\/style>/g;

const DIRECT_VISUAL_VALUE_PATTERN =
  /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|(?:radial|linear)-gradient\(|--n-|box-shadow\s*:\s*(?!\s*var\()|backdrop-filter\s*:\s*(?!\s*var\()|border-radius\s*:\s*(?!\s*var\()|z-index\s*:\s*(?!\s*var\()|opacity\s*:\s*(?!\s*var\()/;

function readProjectFile(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function uniqueMatches(source: string, pattern: RegExp) {
  return Array.from(new Set(source.match(pattern) ?? [])).sort();
}

function styleBlocks(source: string) {
  return Array.from(source.matchAll(STYLE_BLOCK_PATTERN), (match) => match[1] ?? "");
}

function selectorBlock(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = source.indexOf("\n}", start);
  return end < 0 ? "" : source.slice(start, end + 2);
}

describe("Reader core theme tokens", () => {
  it("defines every Reader core component token in defaults and Nocturne and consumes each token", () => {
    const componentSources = READER_FILES.map(readProjectFile).join("\n");
    const defaultTokens = readProjectFile("src/styles/tokens.css");
    const nocturneTokens = readProjectFile("src/styles/nocturne-theme.css");

    const consumed = uniqueMatches(componentSources, TOKEN_PATTERN);
    const defaultDefined = uniqueMatches(defaultTokens, TOKEN_DEFINITION_PATTERN);
    const nocturneDefined = uniqueMatches(nocturneTokens, TOKEN_DEFINITION_PATTERN);

    expect(consumed).toHaveLength(116);
    expect(defaultDefined).toEqual(consumed);
    expect(nocturneDefined).toEqual(consumed);
  });

  it("keeps Reader core style blocks free of direct visual values", () => {
    for (const file of READER_FILES) {
      const styles = styleBlocks(readProjectFile(file));
      expect(styles.length, `${file} should expose a style block`).toBeGreaterThan(0);

      for (const [index, style] of styles.entries()) {
        expect(
          style.match(DIRECT_VISUAL_VALUE_PATTERN),
          `${file} style block ${index + 1} contains a direct visual value`
        ).toBeNull();
      }
    }
  });

  it("keeps Nocturne Reader core aliases resolvable", () => {
    const defaultTokens = readProjectFile("src/styles/tokens.css");
    const nocturneTokens = readProjectFile("src/styles/nocturne-theme.css");
    const defaultDefined = new Set(uniqueMatches(defaultTokens, CUSTOM_PROPERTY_DEFINITION_PATTERN));
    const nocturneDefined = new Set(uniqueMatches(
      `${defaultTokens}\n${nocturneTokens}`,
      CUSTOM_PROPERTY_DEFINITION_PATTERN,
    ));
    const defaultDeclarations = defaultTokens.match(READER_TOKEN_DECLARATION_PATTERN) ?? [];
    const declarations = nocturneTokens.match(READER_TOKEN_DECLARATION_PATTERN) ?? [];
    const defaultReferences = defaultDeclarations.flatMap((declaration) =>
      Array.from(declaration.matchAll(CUSTOM_PROPERTY_REFERENCE_PATTERN), (match) => ({
        token: match[1],
        hasFallback: Boolean(match[2]),
      })),
    );
    const references = declarations.flatMap((declaration) =>
      Array.from(declaration.matchAll(CUSTOM_PROPERTY_REFERENCE_PATTERN), (match) => ({
        token: match[1],
        hasFallback: Boolean(match[2]),
      }))
    );

    expect(defaultReferences.filter(({ token, hasFallback }) => !hasFallback && !defaultDefined.has(token))).toEqual([]);
    expect(references.filter(({ token, hasFallback }) => !hasFallback && !nocturneDefined.has(token))).toEqual([]);
  });

  it("resolves prose palette dependent tokens in the viewer context", () => {
    const dynamicTokens = [
      "--component-reader-core-prose-viewer-bg",
      "--component-reader-core-prose-viewer-fg",
      "--component-reader-core-prose-panel-bg",
      "--component-reader-core-epub-bg",
      "--component-reader-core-epub-fg",
      "--component-reader-core-pdf-reflow-fg",
      "--component-reader-core-pdf-placeholder-fg",
    ];
    const defaults = selectorBlock(readProjectFile("src/styles/tokens.css"), ":where(.book-viewer, .novel-viewer)");
    const nocturne = selectorBlock(
      readProjectFile("src/styles/nocturne-theme.css"),
      '[data-theme="nocturne"] :where(.book-viewer, .novel-viewer)'
    );

    expect(uniqueMatches(defaults, TOKEN_DEFINITION_PATTERN)).toEqual(dynamicTokens.sort());
    expect(uniqueMatches(nocturne, TOKEN_DEFINITION_PATTERN)).toEqual(dynamicTokens.sort());
  });

  it("documents functional prose palette exceptions that must stay outside theme tokens", () => {
    const book = readProjectFile("src/components/reader/BookReader.svelte");
    const novel = readProjectFile("src/components/reader/NovelReader.svelte");

    expect(book).toContain('if (proseTheme === "sepia") return { text: "#2b2118", bg: "#efe1c9", surface: "#f6ead4" };');
    expect(book).toContain('.getPropertyValue("--component-reader-core-epub-link-fg")');
    expect(book).toContain('style="background:#efe1c9;"');

    expect(novel).toContain('if (proseTheme === "sepia") return { text: "#2b2118", bg: "#efe1c9", surface: "#f6ead4" };');
    expect(novel).toContain('style="background:#efe1c9;"');
  });
});
