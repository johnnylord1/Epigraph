import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const FILES = [
  "src/components/layout/Layout.svelte",
  "src/components/layout/WindowControlsInline.svelte",
];
const TOKEN_PATTERN = /--component-(?:layout-main|window-inline)-[A-Za-z0-9_-]+/g;
const TOKEN_DEFINITION_PATTERN = /--component-(?:layout-main|window-inline)-[A-Za-z0-9_-]+(?=\s*:)/g;
const STYLE_BLOCK_PATTERN = /<style[^>]*>([\s\S]*?)<\/style>/g;
const DIRECT_THEME_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|(?:radial|linear|conic)-gradient\(|--n-/;
const VISUAL_PROPERTY_PATTERN = /^\s*(border-radius|transition|transform)\s*:\s*([^;]+);/gm;

function readProjectFile(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function uniqueMatches(source: string, pattern: RegExp) {
  return Array.from(new Set(source.match(pattern) ?? [])).sort();
}

describe("active shell compatibility tokens", () => {
  it("defines and consumes the complete active shell compatibility contract", () => {
    const components = FILES.map(readProjectFile).join("\n");
    const consumed = uniqueMatches(components, TOKEN_PATTERN);

    expect(consumed).toHaveLength(8);
    expect(uniqueMatches(readProjectFile("src/styles/tokens.css"), TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
    expect(uniqueMatches(readProjectFile("src/styles/nocturne-theme.css"), TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
  });

  it("keeps active shell consumers free of direct theme values and compatibility aliases", () => {
    for (const file of FILES) {
      const source = readProjectFile(file);
      const styles = Array.from(source.matchAll(STYLE_BLOCK_PATTERN), (match) => match[1] ?? "");
      expect(source.match(DIRECT_THEME_PATTERN), file).toBeNull();
      for (const style of styles) {
        for (const match of style.matchAll(VISUAL_PROPERTY_PATTERN)) {
          expect(match[2].trim().startsWith("var("), `${file}: ${match[1]} uses ${match[2]}`).toBe(true);
        }
      }
    }
  });

  it("covers the shell and every active inline window-control host", () => {
    expect(readProjectFile("src/App.svelte")).toContain("<Layout");
    for (const host of [
      "src/components/pages/Home.svelte",
      "src/components/pages/BrowseV3.svelte",
      "src/components/pages/Downloads.svelte",
      "src/components/settings/Settings.svelte",
      "src/components/library/LibraryHeader.svelte",
    ]) {
      expect(readProjectFile(host), host).toContain("<WindowControlsInline");
    }
  });
});
