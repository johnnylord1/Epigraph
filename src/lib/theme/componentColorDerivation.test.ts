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
      .filter(
        ({ value }) =>
          /var\(--n-(?!(?:hud-scale|topbar-height|sidebar-width|search-width|search-width-focus)\b)/.test(
            value,
          ),
      )
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
    expect(unused).toEqual([]);
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
