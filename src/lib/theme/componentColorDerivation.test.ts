import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const tokensCss = readFileSync("src/styles/tokens.css", "utf8");
const nocturneCss = readFileSync("src/styles/nocturne-theme.css", "utf8");
const themeCss = `${tokensCss}\n${nocturneCss}`;

const MIGRATED_PREFIXES = [
  "card",
  "modal",
  "popover",
  "menu",
  "button",
  "input",
  "tab",
  "toast",
  "nocturne-state",
  "splash",
  "soft",
  "chip",
  "app",
  "search",
  "sidebar",
  "topbar",
  "nav",
  "toolbar",
  "window",
  "settings",
  "theme-editor",
  "detail",
  "tracking",
  "manga",
  "library",
  "home",
  "activity",
  "downloads",
  "browse",
  "sources",
  "taste",
  "reader",
  "migration",
  "migrate",
  "updater",
  "novel",
  "syncd",
] as const;

const directColorPattern =
  /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|(?<![\w-])(?:black|white)(?![\w-])/i;

interface CssDeclaration {
  name: string;
  value: string;
}

function readDeclarations(source: string): CssDeclaration[] {
  return [...source.matchAll(/^\s*(--[\w-]+)\s*:\s*([\s\S]*?);/gm)].map(
    ([, name, value]) => ({ name, value: value.trim() }),
  );
}

function componentFamily(name: string): string {
  const suffix = name.slice("--component-".length);
  if (suffix.startsWith("nocturne-state-")) return "nocturne-state";
  if (suffix.startsWith("theme-editor-")) return "theme-editor";
  return suffix.split("-")[0] ?? suffix;
}

function references(value: string): string[] {
  return [...value.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]);
}

describe("derived component color contract", () => {
  const declarations = readDeclarations(themeCss);
  const fallbackDeclarations = new Map(readDeclarations(tokensCss).map(({ name, value }) => [name, value]));
  const migrated = declarations.filter(
    ({ name }) =>
      name.startsWith("--component-") &&
      MIGRATED_PREFIXES.includes(componentFamily(name) as (typeof MIGRATED_PREFIXES)[number]),
  );

  test("keeps migrated component values free of direct colors and legacy Nocturne aliases", () => {
    const directColors = migrated
      .filter(({ value }) => directColorPattern.test(value))
      .map(({ name, value }) => `${name}: ${value}`);
    const legacyAliases = migrated
      .filter(({ value }) => /var\(--n-/.test(value))
      .map(({ name, value }) => `${name}: ${value}`);

    expect(directColors).toEqual([]);
    expect(legacyAliases).toEqual([]);
  });

  test("resolves every derived semantic source from a migrated component", () => {
    const markerStart = tokensCss.indexOf("/* Derived theme sources:");
    const markerEnd = tokensCss.indexOf("/* Status dots */", markerStart);
    const sourceNames = readDeclarations(tokensCss.slice(markerStart, markerEnd)).map(
      ({ name }) => name,
    );
    const definitions = new Map<string, string[]>();

    for (const { name, value } of declarations) {
      const current = definitions.get(name) ?? [];
      current.push(value);
      definitions.set(name, current);
    }

    const reachable = new Set<string>();
    const pending = migrated.flatMap(({ value }) => references(value));
    while (pending.length > 0) {
      const name = pending.pop()!;
      if (reachable.has(name)) continue;
      reachable.add(name);
      for (const value of definitions.get(name) ?? []) {
        pending.push(...references(value));
      }
    }

    const unused = sourceNames.filter((name) => !reachable.has(name));
    expect(sourceNames.length).toBeGreaterThan(0);
    expect(unused).toEqual([
      "--color-state-panel-top",
      "--color-state-panel-bottom",
      "--color-state-compact-top",
      "--color-state-compact-bottom",
      "--color-state-icon-surface",
    ]);
  });

  test("keeps cards, buttons and fields borderless, overlays outlined, and reserves outline for focus", () => {
    // Cards and buttons are soft surfaces without boxes; overlays (modals, toasts) and fields keep
    // a restrained boundary so they stay distinct from what lies beneath them.
    expect(fallbackDeclarations.get("--component-card-border")).toBe("transparent");
    expect(fallbackDeclarations.get("--component-modal-border")).toBe(
      "color-mix(in srgb, var(--border-strong) 28%, transparent)",
    );
    expect(fallbackDeclarations.get("--component-button-border")).toBe("transparent");
    expect(fallbackDeclarations.get("--component-input-border")).toBe("transparent");
    expect(fallbackDeclarations.get("--component-toast-border")).toBe(
      "color-mix(in srgb, var(--border-strong) 26%, transparent)",
    );
    expect(fallbackDeclarations.get("--component-toast-border-hover")).toBe("var(--color-outline)");
  });

  test("derives interactive surfaces from the shared soft surfaces", () => {
    expect(fallbackDeclarations.get("--component-button-bg")).toBe("var(--ui-surface)");
    expect(fallbackDeclarations.get("--component-button-bg-hover")).toBe(
      "color-mix(in srgb, var(--accent-bright) 8%, var(--bg-overlay))",
    );
    expect(fallbackDeclarations.get("--component-input-bg")).toBe("var(--ui-surface-strong)");
    expect(fallbackDeclarations.get("--component-popover-radius")).toBe("var(--hud-popover-radius)");
    expect(fallbackDeclarations.get("--component-menu-radius")).toBe("var(--hud-popover-radius)");
  });

  test.each([
    ["black", true],
    ["1px solid white", true],
    ["var(--fallback, black)", true],
    ["var(--font-weight-black)", false],
    ["var(--black-level)", false],
  ])("classifies named color boundaries in %s", (value, expected) => {
    expect(directColorPattern.test(value)).toBe(expected);
  });
});
