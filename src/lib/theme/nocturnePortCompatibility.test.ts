import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const PORT_PATH = "src/styles/nocturne-port.css";
const PORT_LEGACY_TOKENS: string[] = [];
const DIRECT_COLOR_PATTERN = /#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|(?<![-\w])(?:white|black)(?![-\w])/g;
const PORT_DERIVED_SINGLE_SOURCES = [
  "--color-chip-surface-source",
  "--color-rating-star-source",
  "--color-recommendation-pill-dark-source",
  "--color-recommendation-pill-ink-source",
  "--color-recommendation-pill-light-source",
  "--color-settings-danger-soft-source",
  "--color-soft-control-text-source",
];
const PORT_DERIVED_COMPONENT_ALIASES = new Map([
  ["--color-chip-surface-source", "--component-chip-surface-source"],
  ["--color-rating-star-source", "--component-sources-metric-rating-star-source"],
  ["--color-recommendation-pill-dark-source", "--component-sources-metric-recommendation-dark-source"],
  ["--color-recommendation-pill-ink-source", "--component-sources-metric-recommendation-ink-source"],
  ["--color-recommendation-pill-light-source", "--component-sources-metric-recommendation-light-source"],
  ["--color-soft-control-text-source", "--component-soft-control-fg-source"],
]);

function readProjectFile(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function productionCorpus(path: string): string {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return productionCorpus(child);
      if (!/\.(?:css|svelte|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
      return [readProjectFile(child)];
    })
    .join("\n");
}

function definitions(source: string): string[] {
  return Array.from(source.matchAll(/^\s*(--[A-Za-z0-9_-]+)\s*:/gm), (match) => match[1])
    .filter((token, index, tokens) => tokens.indexOf(token) === index)
    .sort();
}

function references(source: string, prefix: string): string[] {
  return Array.from(source.matchAll(new RegExp(`var\\((${prefix}[A-Za-z0-9_-]+)`, "g")), (match) => match[1])
    .filter((token, index, tokens) => tokens.indexOf(token) === index)
    .sort();
}

function withoutDefinitions(source: string, token: string): string {
  return source.replace(new RegExp(`${token}\\s*:[^;]+;`, "g"), "");
}

function directColorCount(source: string): number {
  return source.match(DIRECT_COLOR_PATTERN)?.length ?? 0;
}

function portDerivedSources(source: string): string[] {
  return definitions(source).filter((token) =>
    token.startsWith("--color-splash-")
      || token.startsWith("--color-settings-density-")
      || token.startsWith("--color-settings-preview-")
      || token.startsWith("--color-settings-selection-")
      || PORT_DERIVED_SINGLE_SOURCES.includes(token),
  );
}

function componentAliasForSource(source: string): string {
  return PORT_DERIVED_COMPONENT_ALIASES.get(source) ?? source.replace("--color-", "--component-");
}

describe("Nocturne port compatibility contract", () => {
  test("keeps the port last in the active CSS cascade", () => {
    const globalCss = readProjectFile("src/styles/global.css");
    const tokens = globalCss.indexOf('@import "./tokens.css"');
    const nocturne = globalCss.indexOf('@import "./nocturne-theme.css"');
    const port = globalCss.indexOf('@import "./nocturne-port.css"');

    expect(tokens).toBeGreaterThan(-1);
    expect(nocturne).toBeGreaterThan(tokens);
    expect(port).toBeGreaterThan(nocturne);
  });

  test("classifies every port-local token as active or Legacy", () => {
    const port = readProjectFile(PORT_PATH);
    const corpus = productionCorpus("src");
    const defined = definitions(port);
    const active = defined.filter((token) => {
      if (PORT_LEGACY_TOKENS.includes(token)) return false;
      const source = withoutDefinitions(corpus, token);
      return source.includes(`var(${token}`) || source.includes(`setProperty("${token}`);
    });
    const legacy = defined.filter((token) => !active.includes(token));

    expect(defined).toHaveLength(43);
    expect(active).toHaveLength(43);
    expect(legacy).toEqual(PORT_LEGACY_TOKENS);
    expect(port).not.toMatch(/^\s*--color-info-bg\s*:/m);
    expect(port).not.toMatch(/^\s*--splash-(?:error|ink-muted)\s*:/m);
    expect(readProjectFile("src/styles/tokens.css")).toContain(
      "--component-settings-info-bg: var(--color-info-bg);",
    );
  });

  test("retires compatibility aliases while preserving canonical shell geometry", () => {
    const port = readProjectFile(PORT_PATH);
    const themeLayers = `${readProjectFile("src/styles/tokens.css")}\n${readProjectFile("src/styles/nocturne-theme.css")}`;

    expect(references(port, "--n-")).toEqual([]);
    expect(themeLayers).not.toMatch(/^\s*--n-[A-Za-z0-9_-]+\s*:/m);
    expect(themeLayers).toContain("--shell-search-width-focus: calc(380px * var(--hud-scale));");
    expect(themeLayers).toContain("--shell-sidebar-rail-width: calc(62px * var(--hud-scale));");
  });

  test("keeps all four port sections attached to active hosts", () => {
    expect(readProjectFile("src/components/layout/SplashScreen.svelte")).toContain("epigraph-port--splash");
    expect(readProjectFile("src/components/layout/Layout.svelte")).toContain("epigraph-app-shell");
    expect(readProjectFile("src/components/settings/Settings.svelte")).toContain("epigraph-port--settings");
    expect(readProjectFile("src/components/library/LibraryCard.svelte")).toContain("source-metric-banner");
    expect(readProjectFile("src/components/pages/BrowseV3.svelte")).toContain("searchRecommendationCard");
  });

  test("derives every port color from semantic sources", () => {
    const port = readProjectFile(PORT_PATH);
    const tokens = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const shellStart = port.indexOf(".epigraph-app-shell {");
    const settingsStart = port.indexOf(".epigraph-port--settings {");
    const metricsLabel = port.indexOf("Shared Source & Tracker Metric Banner");
    const metricsStart = port.lastIndexOf("/*", metricsLabel);
    const derivedSources = portDerivedSources(tokens);

    expect(shellStart).toBeGreaterThan(0);
    expect(settingsStart).toBeGreaterThan(shellStart);
    expect(metricsStart).toBeGreaterThan(settingsStart);
    expect(directColorCount(port.slice(0, shellStart))).toBe(0);
    expect(directColorCount(port.slice(shellStart, settingsStart))).toBe(0);
    expect(directColorCount(port.slice(settingsStart, metricsStart))).toBe(0);
    expect(directColorCount(port.slice(metricsStart))).toBe(0);
    expect(directColorCount(port)).toBe(0);
    expect(derivedSources).toHaveLength(44);
    for (const token of derivedSources) {
      const component = componentAliasForSource(token);
      expect(nocturne).toMatch(new RegExp(`${token}\\s*:`));
      expect(tokens).toContain(`${component}: var(${token});`);
      expect(port).toContain(`var(${component})`);
    }
  });

  test("limits exact port colors to the builtin Nocturne document", () => {
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const selector = '[data-theme="nocturne"]:not([data-custom-theme]) {';
    const selectorStart = nocturne.indexOf(selector);
    const selectorEnd = nocturne.indexOf("\n}", selectorStart);
    const builtinBlock = nocturne.slice(selectorStart, selectorEnd);
    const derivedSources = portDerivedSources(readProjectFile("src/styles/tokens.css"));

    expect(selectorStart).toBeGreaterThan(-1);
    expect(selectorEnd).toBeGreaterThan(selectorStart);
    expect(derivedSources).toHaveLength(44);
    for (const token of derivedSources) {
      expect(builtinBlock).toMatch(new RegExp(`${token}\\s*:`));
      expect(nocturne.slice(0, selectorStart)).not.toMatch(new RegExp(`${token}\\s*:`));
      expect(nocturne.slice(selectorEnd + 2)).not.toMatch(new RegExp(`${token}\\s*:`));
    }
  });
});
