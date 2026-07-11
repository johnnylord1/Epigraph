import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const HOME_PATH = "src/components/pages/Home.svelte";
const TOKEN_PATTERN = /--component-home-[A-Za-z0-9_-]+/g;
const TOKEN_DEFINITION_PATTERN = /--component-home-[A-Za-z0-9_-]+(?=\s*:)/g;
const STYLE_BLOCK_PATTERN = /<style[^>]*>([\s\S]*?)<\/style>/g;
const DIRECT_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|(?:radial|linear|conic)-gradient\(|--n-/;
const VISUAL_PROPERTY_PATTERN = /^\s*(box-shadow|backdrop-filter|border-radius|z-index|opacity|filter|transition|transform)\s*:\s*([^;]+);/gm;

function readProjectFile(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function uniqueMatches(source: string, pattern: RegExp) {
  return Array.from(new Set(source.match(pattern) ?? [])).sort();
}

function customProperty(source: string, token: string) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing ${token}`);
  return match[1].trim();
}

function rgba(value: string): [number, number, number, number] {
  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (!match) throw new Error(`Expected rgb color, received ${value}`);
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

function contrastOver(color: [number, number, number, number], background: [number, number, number]) {
  const composite = color.slice(0, 3).map((channel, index) => channel * color[3] + background[index] * (1 - color[3]));
  const luminance = (channels: number[]) => {
    const values = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  };
  return (luminance(composite) + 0.05) / (luminance(background) + 0.05);
}

describe("Home theme tokens", () => {
  it("defines and consumes the complete Home token contract", () => {
    const home = readProjectFile(HOME_PATH);
    const defaults = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const consumed = uniqueMatches(home, TOKEN_PATTERN);

    expect(consumed).toHaveLength(74);
    expect(uniqueMatches(defaults, TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
    expect(uniqueMatches(nocturne, TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
  });

  it("keeps Home styles free of direct theme values and compatibility tokens", () => {
    const home = readProjectFile(HOME_PATH);
    const styles = Array.from(home.matchAll(STYLE_BLOCK_PATTERN), (match) => match[1] ?? "");

    expect(styles).toHaveLength(1);
    expect(styles[0].match(DIRECT_COLOR_PATTERN)).toBeNull();
    for (const match of styles[0].matchAll(VISUAL_PROPERTY_PATTERN)) {
      const value = match[2].trim();
      expect(value === "inherit" || value.startsWith("var("), `${match[1]} uses ${value}`).toBe(true);
    }
  });

  it("keeps normal-size Nocturne Home text at WCAG AA contrast", () => {
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const panel: [number, number, number] = [28, 27, 27];
    const textTokens = [
      "--component-home-muted-fg",
      "--component-home-subtle-fg",
      "--component-home-meta-fg",
      "--component-home-faint-fg",
      "--component-home-quiet-fg",
      "--component-home-label-fg",
      "--component-home-chart-label-fg",
      "--component-home-source-meta-fg",
      "--component-home-history-fg",
      "--component-home-tracking-muted-fg",
    ];

    for (const token of textTokens) {
      expect(contrastOver(rgba(customProperty(nocturne, token)), panel), token).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the active route and search-layer selectors intact", () => {
    const layout = readProjectFile("src/components/layout/Layout.svelte");
    const home = readProjectFile(HOME_PATH);

    expect(layout).toContain('home: () => import("../pages/Home.svelte")');
    expect(home).toContain("home-search-dim");
    expect(home).toContain("aethon-home-search-engaged");
    expect(home).toContain("home-continue-grid");
  });
});
