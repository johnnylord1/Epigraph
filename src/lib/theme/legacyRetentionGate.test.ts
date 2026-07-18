import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const NOCTURNE_PATH = "src/styles/nocturne-theme.css";
const PORT_PATH = "src/styles/nocturne-port.css";

const LEGACY_BRIDGES = [
  "--n-hud-scale",
  "--n-primary",
  "--n-primary-container",
  "--n-on-primary",
  "--n-on-surface",
  "--n-on-surface-variant",
  "--n-gradient-primary",
  "--n-duration-fast",
  "--n-duration-normal",
  "--n-ease-spring",
  "--n-topbar-height-base",
  "--n-sidebar-width-base",
  "--n-topbar-height",
  "--n-sidebar-width",
  "--n-sidebar-rail-width",
  "--n-sidebar-edge-x",
  "--n-sidebar-edge-y",
  "--n-sidebar-radius",
  "--n-sidebar-padding-y",
  "--n-sidebar-gap",
  "--n-sidebar-btn-size",
  "--n-sidebar-btn-radius",
  "--n-brand-size",
  "--n-brand-offset-top",
  "--n-brand-offset-bottom",
  "--n-topbar-pad-x",
  "--n-topbar-gap",
  "--n-search-width",
  "--n-search-width-focus",
  "--n-search-height",
  "--n-search-icon-offset",
  "--n-search-icon-size",
  "--n-search-padding-right",
  "--n-search-padding-left",
  "--n-icon-btn-size",
  "--n-icon-btn-radius",
  "--n-segmented-height",
  "--n-popover-bg",
  "--n-popover-border",
  "--n-popover-shadow",
  "--n-popover-label",
  "--n-popover-text",
  "--n-popover-text-strong",
  "--n-popover-meta",
  "--n-popover-item-hover",
] as const;

const UNREFERENCED_LEGACY_ALIASES = [
  "--n-bg",
  "--n-bg-top",
  "--n-gradient-bg",
  "--n-line",
  "--n-line-strong",
  "--n-on-primary-container",
  "--n-outline-variant",
  "--n-popover-control-bg",
  "--n-popover-control-border",
  "--n-surface-container",
  "--n-surface-container-low",
  "--n-surface-container-high",
  "--n-surface-container-highest",
] as const;

const SELECTOR_ONLY_LEGACY_ALIASES = [
  "--n-toolbar-cluster-padding",
  "--n-toolbar-cluster-radius",
  "--n-toolbar-divider-height",
  "--n-toolbar-icon-btn-size",
] as const;

const LEGACY_ACTIVITY_ALIASES = [
  "--activity-panel",
  "--activity-panel-soft",
  "--activity-line",
  "--activity-line-soft",
  "--activity-text",
  "--activity-title",
  "--activity-muted",
  "--activity-subtle",
  "--activity-faint",
  "--activity-accent",
  "--activity-accent-soft",
  "--activity-accent-line",
  "--activity-danger",
] as const;

const UNCONSUMED_COMPONENT_TOKENS = [
  "--component-button-fg",
  "--component-card-radius",
  "--component-popover-radius",
  "--component-tab-bg-active",
  "--component-tab-fg-active",
] as const;

const PROMOTED_COMPONENT_TOKENS = [
  "--component-popover-bg",
  "--component-popover-border",
  "--component-popover-shadow",
] as const;

const PORT_LOCAL_LEGACY_DECLARATIONS = [
  "--color-info-bg",
  "--splash-error",
  "--splash-ink-muted",
] as const;

const AUTHORING_AND_STORE_FILES = [
  "src/components/settings/ThemeEditor.svelte",
  "src/lib/theme/builtinCss.ts",
  "src/lib/theme/contract.ts",
  "src/lib/theme/document.ts",
  "src/lib/theme/provider.ts",
  "src/store/state.svelte.ts",
] as const;

const COMPATIBILITY_CONSUMER_FILES = new Set([
  "src/styles/nocturne-port.css",
]);

function projectFiles(path: string): string[] {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return projectFiles(child);
    if (!/\.(?:css|svelte|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [child];
  });
}

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withoutDeclaration(source: string, token: string): string {
  return source.replace(new RegExp(`^\\s*${escapeRegExp(token)}\\s*:[\\s\\S]*?;`, "gm"), "");
}

function referencesIn(path: string, token: string): number {
  const source = withoutDeclaration(read(path), token);
  return source.match(new RegExp(`${escapeRegExp(token)}(?![A-Za-z0-9_-])`, "g"))?.length ?? 0;
}

function declarations(source: string, prefix: string): string[] {
  return [...source.matchAll(new RegExp(`^\\s*(${escapeRegExp(prefix)}[A-Za-z0-9_-]+)\\s*:`, "gm"))]
    .map((match) => match[1])
    .sort();
}

describe("Legacy theme retention evidence", () => {
  const files = projectFiles("src");
  const nocturne = read(NOCTURNE_PATH);
  const port = read(PORT_PATH);

  test("freezes all 62 --n-* aliases as retained compatibility inventory", () => {
    const expected = [
      ...LEGACY_BRIDGES,
      ...UNREFERENCED_LEGACY_ALIASES,
      ...SELECTOR_ONLY_LEGACY_ALIASES,
    ].sort();

    expect(declarations(nocturne, "--n-")).toEqual(expected);
    expect(LEGACY_BRIDGES).toHaveLength(45);
    expect(UNREFERENCED_LEGACY_ALIASES).toHaveLength(13);
    expect(SELECTOR_ONLY_LEGACY_ALIASES).toHaveLength(4);
  });

  test("keeps active production independent from retained --n-* aliases", () => {
    const activeReferences = files
      .filter((path) => !COMPATIBILITY_CONSUMER_FILES.has(path))
      .flatMap((path) =>
        [...LEGACY_BRIDGES, ...UNREFERENCED_LEGACY_ALIASES, ...SELECTOR_ONLY_LEGACY_ALIASES]
          .filter((token) => referencesIn(path, token) > 0)
          .map((token) => `${path}:${token}`),
      );

    expect(activeReferences).toEqual([]);
  });

  test("keeps Syncd active after decoupling its final --n-* dependency", () => {
    expect(referencesIn(NOCTURNE_PATH, "--n-on-surface")).toBe(0);
    expect(nocturne).toContain("--component-syncd-input-fg: var(--text-primary);");
    expect(read("src/components/settings/SyncdConnectionPanel.svelte")).toContain(
      "var(--component-syncd-input-fg)",
    );
    expect(read("src/components/settings/Settings.svelte")).toContain("SyncdConnectionPanel");
  });

  test("keeps the 17 non-bridge Legacy aliases unreferenced or selector-only", () => {
    for (const token of UNREFERENCED_LEGACY_ALIASES) {
      expect(files.reduce((count, path) => count + referencesIn(path, token), 0), token).toBe(0);
    }
    for (const token of SELECTOR_ONLY_LEGACY_ALIASES) {
      const consumers = files.filter((path) => referencesIn(path, token) > 0);
      expect(consumers, token).toEqual([PORT_PATH]);
    }
  });

  test("keeps all 13 --activity-* aliases defined and unreferenced", () => {
    expect(declarations(nocturne, "--activity-")).toEqual([...LEGACY_ACTIVITY_ALIASES].sort());
    for (const token of LEGACY_ACTIVITY_ALIASES) {
      expect(files.reduce((count, path) => count + referencesIn(path, token), 0), token).toBe(0);
    }
  });

  test("retains exactly five unconsumed component tokens for compatibility", () => {
    const themeDefinitions = `${read("src/styles/tokens.css")}\n${nocturne}`;
    for (const token of UNCONSUMED_COMPONENT_TOKENS) {
      expect(themeDefinitions, `${token} must remain defined`).toMatch(new RegExp(`${escapeRegExp(token)}\\s*:`));
      expect(files.reduce((count, path) => count + referencesIn(path, token), 0), token).toBe(0);
    }
  });

  test("removes the 89 tokens exclusive to the quarantined repository surface", () => {
    const definitions = new Set(
      [...`${read("src/styles/tokens.css")}\n${nocturne}`.matchAll(/(--component-novel-repositories-[\w-]+)\s*:/g)]
        .map((match) => match[1]),
    );

    expect(definitions).toEqual(new Set());
  });

  test("keeps the other three historical component tokens classified Active", () => {
    for (const token of PROMOTED_COMPONENT_TOKENS) {
      expect(referencesIn(NOCTURNE_PATH, token), token).toBeGreaterThan(0);
    }
    expect(read("src/components/pages/Downloads.svelte")).toContain("n-popover-menu");
    expect(read("src/components/library/LibraryToolbar.svelte")).toContain("n-popover-menu");
  });

  test("retains the three port-local declarations without local consumers", () => {
    for (const token of PORT_LOCAL_LEGACY_DECLARATIONS) {
      expect(port, `${token} must remain declared`).toMatch(new RegExp(`${escapeRegExp(token)}\\s*:`));
      expect(referencesIn(PORT_PATH, token), token).toBe(0);
    }
  });

  test("finds no literal dynamic API access for retained aliases", () => {
    const dynamicApiPattern = /(?:setProperty|getPropertyValue|removeProperty)\s*\(\s*["']([^"']+)["']/g;
    const dynamicTokens = files.flatMap((path) =>
      [...read(path).matchAll(dynamicApiPattern)].map((match) => `${path}:${match[1]}`),
    );
    const retained = new Set<string>([
      ...LEGACY_BRIDGES,
      ...UNREFERENCED_LEGACY_ALIASES,
      ...SELECTOR_ONLY_LEGACY_ALIASES,
      ...LEGACY_ACTIVITY_ALIASES,
      ...UNCONSUMED_COMPONENT_TOKENS,
    ]);

    expect(dynamicTokens.filter((entry) => retained.has(entry.slice(entry.indexOf(":") + 1)))).toEqual([]);
  });

  test("keeps retained aliases outside ThemeEditor, documents, presets, provider, and stores", () => {
    const retained = [
      ...LEGACY_BRIDGES,
      ...UNREFERENCED_LEGACY_ALIASES,
      ...SELECTOR_ONLY_LEGACY_ALIASES,
      ...LEGACY_ACTIVITY_ALIASES,
      ...UNCONSUMED_COMPONENT_TOKENS,
    ];
    const references = AUTHORING_AND_STORE_FILES.flatMap((path) =>
      retained
        .filter((token) => referencesIn(path, token) > 0)
        .map((token) => `${path}:${token}`),
    );

    expect(references).toEqual([]);
  });
});
