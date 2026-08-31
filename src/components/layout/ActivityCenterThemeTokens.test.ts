import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ActivityOverlay from "./ActivityOverlay.svelte";
import { store } from "../../store/state.svelte";
import { resolveCssColor } from "../../test/themeColor";

const ROOT = process.cwd();
const ACTIVITY_FILES = [
  "src/components/layout/ActivityButton.svelte",
  "src/components/layout/ActivityOverlay.svelte",
  "src/components/layout/RecentActivity.svelte",
];

const TOKEN_PATTERN = /--component-activity-[A-Za-z0-9_-]+/g;
const TOKEN_DEFINITION_PATTERN = /--component-activity-[A-Za-z0-9_-]+(?=\s*:)/g;
const STYLE_BLOCK_PATTERN = /<style[^>]*>([\s\S]*?)<\/style>/g;
const DIRECT_VISUAL_VALUE_PATTERN =
  /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|(?:radial|linear)-gradient\(|--n-|box-shadow\s*:\s*(?!\s*var\()|backdrop-filter\s*:\s*(?!\s*var\()|border-radius\s*:\s*(?!\s*var\()|z-index\s*:\s*\d|opacity\s*:\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*;/;

function readProjectFile(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function uniqueMatches(source: string, pattern: RegExp) {
  return Array.from(new Set(source.match(pattern) ?? [])).sort();
}

function resolveCssNumber(source: string, token: string): number {
  const properties = new Map(
    Array.from(source.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm), (match) => [match[1], match[2].trim()] as const),
  );
  const resolveValue = (value: string, seen = new Set<string>()): number => {
    const variable = value.match(/^var\((--[\w-]+)\)$/);
    if (!variable) return Number(value);
    const name = variable[1];
    if (seen.has(name)) throw new Error(`Cyclic CSS number reference: ${name}`);
    const next = properties.get(name);
    if (!next) throw new Error(`Missing CSS number reference: ${name}`);
    return resolveValue(next, new Set([...seen, name]));
  };
  const value = properties.get(token);
  if (!value) throw new Error(`Missing ${token}`);
  return resolveValue(value, new Set([token]));
}

function composite(color: [number, number, number, number], background: [number, number, number]) {
  return color.slice(0, 3).map((channel, index) => channel * color[3] + background[index] * (1 - color[3]));
}

function contrast(foreground: number[], background: number[]) {
  const luminance = (color: number[]) => {
    const channels = color.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe("Activity Center theme tokens", () => {
  beforeEach(() => {
    store.activityPanelReturnPage = "home";
    store.history = [];
    store.libraryUpdateNotifications = [];
    store.libraryUpdateIssues = [];
    store.systemNotifications = [];
  });

  afterEach(() => cleanup());

  it("defines and consumes the complete Activity Center token contract", () => {
    const components = ACTIVITY_FILES.map(readProjectFile).join("\n");
    const defaults = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const consumed = uniqueMatches(components, TOKEN_PATTERN);

    expect(consumed).toHaveLength(74);
    expect(uniqueMatches(defaults, TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
    expect(uniqueMatches(nocturne, TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
  });

  it("keeps Activity Center styles free of direct theme values and compatibility tokens", () => {
    for (const file of ACTIVITY_FILES) {
      const source = readProjectFile(file);
      const styles = Array.from(source.matchAll(STYLE_BLOCK_PATTERN), (match) => match[1] ?? "");
      expect(styles.length, `${file} should expose a style block`).toBeGreaterThan(0);
      for (const style of styles) {
        expect(style.match(DIRECT_VISUAL_VALUE_PATTERN), `${file} contains a direct visual value`).toBeNull();
      }
    }
  });

  it("keeps normal-size Nocturne Activity Center text at WCAG AA contrast", () => {
    const defaults = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const theme = `${defaults}\n${nocturne}`;
    const panel: [number, number, number] = [18, 17, 22];
    const textTokens = [
      "--component-activity-center-text",
      "--component-activity-center-title",
      "--component-activity-center-muted",
      "--component-activity-center-subtle",
      "--component-activity-center-faint",
      "--component-activity-center-filter-fg",
    ];

    for (const token of textTokens) {
      const ratio = contrast(composite(resolveCssColor(theme, token), panel), panel);
      expect(ratio, `${token} should meet WCAG AA`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the Activity Center above the Library header and hero", () => {
    const theme = `${readProjectFile("src/styles/tokens.css")}\n${readProjectFile("src/styles/nocturne-theme.css")}`;

    expect(resolveCssNumber(theme, "--component-activity-overlay-z-index"))
      .toBeGreaterThan(resolveCssNumber(theme, "--component-library-header-z-index"));
  });

  it("renders the active Activity Center overlay", () => {
    render(ActivityOverlay);

    expect(screen.getByRole("dialog", { name: "Recent activity" })).toBeTruthy();
    expect(document.querySelector(".activity-root")).toBeTruthy();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(4);
  });
});
