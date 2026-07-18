import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { THEME_TOKEN_KEYS } from "./contract";

const ROOT = process.cwd();
const PORT_PATH = "src/styles/nocturne-port.css";
const PORT_LEGACY_TOKENS = ["--color-info-bg", "--splash-error", "--splash-ink-muted"];
const PORT_N_REFERENCES = [
  "--n-toolbar-cluster-padding",
  "--n-toolbar-cluster-radius",
  "--n-toolbar-divider-height",
  "--n-toolbar-icon-btn-size",
];
const ACTIVE_GEOMETRY_BRIDGES = new Map([
  ["--n-hud-scale", "--hud-scale"],
  ["--n-topbar-height-base", "--shell-topbar-height-base"],
  ["--n-sidebar-width-base", "--shell-sidebar-width-base"],
  ["--n-topbar-height", "--shell-topbar-height"],
  ["--n-sidebar-width", "--shell-sidebar-width"],
  ["--n-sidebar-rail-width", "--shell-sidebar-rail-width"],
  ["--n-sidebar-edge-x", "--shell-sidebar-edge-x"],
  ["--n-sidebar-edge-y", "--shell-sidebar-edge-y"],
  ["--n-sidebar-radius", "--shell-sidebar-radius"],
  ["--n-sidebar-padding-y", "--shell-sidebar-padding-y"],
  ["--n-sidebar-gap", "--shell-sidebar-gap"],
  ["--n-sidebar-btn-size", "--shell-sidebar-button-size"],
  ["--n-sidebar-btn-radius", "--shell-sidebar-button-radius"],
  ["--n-brand-size", "--shell-brand-size"],
  ["--n-brand-offset-top", "--shell-brand-offset-top"],
  ["--n-brand-offset-bottom", "--shell-brand-offset-bottom"],
  ["--n-topbar-pad-x", "--shell-topbar-padding-x"],
  ["--n-topbar-gap", "--shell-topbar-gap"],
  ["--n-search-width", "--shell-search-width"],
  ["--n-search-width-focus", "--shell-search-width-focus"],
  ["--n-search-height", "--shell-search-height"],
  ["--n-search-icon-offset", "--shell-search-icon-offset"],
  ["--n-search-icon-size", "--shell-search-icon-size"],
  ["--n-search-padding-right", "--shell-search-padding-right"],
  ["--n-search-padding-left", "--shell-search-padding-left"],
  ["--n-icon-btn-size", "--shell-icon-button-size"],
  ["--n-icon-btn-radius", "--shell-icon-button-radius"],
  ["--n-segmented-height", "--shell-segmented-height"],
] as const);
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
const PORT_N_COLOR_ALIASES = new Map([
  ["--n-surface-container-high", "--color-modal"],
  ["--n-surface-container-highest", "--color-surface-secondary"],
  ["--n-primary", "--color-accent"],
  ["--n-primary-container", "--accent-bright"],
  ["--n-on-primary", "--color-on-accent-strong"],
  ["--n-on-surface", "--text-primary"],
  ["--n-on-surface-variant", "--text-secondary"],
  ["--n-gradient-primary", "--gradient-accent-primary"],
] as const);

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

function declarationMap(source: string): Map<string, string> {
  return new Map(
    Array.from(source.matchAll(/^\s*(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]*?);/gm), (match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

function reachesAny(
  token: string,
  roots: ReadonlySet<string>,
  values: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): boolean {
  if (roots.has(token)) return true;
  if (seen.has(token)) return false;
  const nextSeen = new Set(seen).add(token);
  return Array.from((values.get(token) ?? "").matchAll(/var\((--[A-Za-z0-9_-]+)/g), (match) => match[1])
    .some((reference) => reachesAny(reference, roots, values, nextSeen));
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

    expect(defined).toHaveLength(46);
    expect(active).toHaveLength(43);
    expect(legacy).toEqual(PORT_LEGACY_TOKENS);
    expect(port).toContain("--color-info-bg: var(--component-settings-info-bg);");
    expect(readProjectFile("src/styles/tokens.css")).toContain(
      "--component-settings-info-bg: var(--color-info-bg);",
    );
  });

  test("keeps only audited Legacy --n-* references in the active port", () => {
    expect(references(readProjectFile(PORT_PATH), "--n-")).toEqual(PORT_N_REFERENCES);
  });

  test("derives all 28 former active geometry aliases from canonical shell tokens", () => {
    const port = readProjectFile(PORT_PATH);
    const fallbackValues = declarationMap(readProjectFile("src/styles/tokens.css"));
    const nocturneValues = declarationMap(readProjectFile("src/styles/nocturne-theme.css"));

    expect(ACTIVE_GEOMETRY_BRIDGES).toHaveLength(28);
    for (const [alias, canonical] of ACTIVE_GEOMETRY_BRIDGES) {
      expect(fallbackValues.get(alias), `${alias} fallback bridge`).toBe(`var(${canonical})`);
      expect(nocturneValues.get(alias), `${alias} Nocturne bridge`).toBe(`var(${canonical})`);
      expect(port, `${alias} active port consumer`).not.toContain(`var(${alias}`);
    }
  });

  test("keeps active port color and motion consumers on canonical tokens", () => {
    const port = readProjectFile(PORT_PATH);
    const migratedAliases = [
      "--n-duration-fast",
      "--n-duration-normal",
      "--n-ease-spring",
      "--n-gradient-primary",
      "--n-on-primary",
      "--n-on-surface",
      "--n-on-surface-variant",
      "--n-primary",
      "--n-primary-container",
    ];

    for (const token of migratedAliases) expect(port).not.toContain(`var(${token}`);
  });

  test("derives every referenced --n-* color alias from the editable theme contract", () => {
    const tokens = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const fallbackValues = declarationMap(tokens);
    const nocturneValues = declarationMap(nocturne);
    const editableRoots = new Set(THEME_TOKEN_KEYS.map((name) => `--${name}`));

    expect(PORT_N_COLOR_ALIASES).toHaveLength(8);
    for (const [alias, semantic] of PORT_N_COLOR_ALIASES) {
      expect(nocturneValues.get(alias), `${alias} must be a semantic compatibility alias`).toBe(`var(${semantic})`);
      expect(reachesAny(semantic, editableRoots, fallbackValues), `${alias} must reach the V4 contract`).toBe(true);
    }
  });

  test("keeps all four port sections attached to active hosts", () => {
    expect(readProjectFile("src/components/layout/SplashScreen.svelte")).toContain("aethon-port--splash");
    expect(readProjectFile("src/components/layout/Layout.svelte")).toContain("aethon-app-shell");
    expect(readProjectFile("src/components/settings/Settings.svelte")).toContain("aethon-port--settings");
    expect(readProjectFile("src/components/library/LibraryCard.svelte")).toContain("source-metric-banner");
    expect(readProjectFile("src/components/pages/BrowseV3.svelte")).toContain("searchRecommendationCard");
  });

  test("derives every port color from semantic sources", () => {
    const port = readProjectFile(PORT_PATH);
    const tokens = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const shellStart = port.indexOf(".aethon-app-shell {");
    const settingsStart = port.indexOf(".aethon-port--settings {");
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
