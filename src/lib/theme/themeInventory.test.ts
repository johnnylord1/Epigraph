import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const THEME_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
] as const;
const EXPECTED_FAMILY_COUNTS = {
  activity: 74,
  app: 17,
  browse: 444,
  button: 3,
  card: 3,
  chip: 2,
  detail: 255,
  downloads: 134,
  focus: 1,
  home: 69,
  input: 4,
  layout: 1,
  library: 83,
  manga: 191,
  menu: 14,
  migrate: 2,
  migration: 60,
  modal: 4,
  nav: 15,
  "nocturne-state": 126,
  novel: 1,
  overlay: 1,
  popover: 11,
  reader: 168,
  search: 17,
  segmented: 1,
  settings: 112,
  sidebar: 8,
  soft: 1,
  sources: 152,
  splash: 21,
  syncd: 65,
  taste: 51,
  "theme-editor": 220,
  toast: 74,
  toolbar: 9,
  topbar: 12,
  tracking: 117,
  updater: 49,
  window: 22,
} as const;

type DefinitionLayer = "fallback" | "nocturne";
type InventoryStatus = "Active" | "Legacy";
type ConsumptionMode = "static" | "dynamic" | "transitive" | "none";

interface TokenDefinition {
  layers: Set<DefinitionLayer>;
  values: string[];
}

interface TokenInventoryEntry {
  token: string;
  family: string;
  layers: DefinitionLayer[];
  status: InventoryStatus;
  consumption: ConsumptionMode;
}

function projectFiles(path: string): string[] {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) {
      if (child === "src/test" || child.includes("/__screenshots__")) return [];
      return projectFiles(child);
    }
    if (!/\.(?:css|svelte|ts)$/.test(entry.name) || child.includes(".test.")) return [];
    return [child];
  });
}

function tokenFamily(token: string): string {
  const suffix = token.slice("--component-".length);
  if (suffix.startsWith("nocturne-state-")) return "nocturne-state";
  if (suffix.startsWith("theme-editor-")) return "theme-editor";
  return suffix.split("-")[0] ?? suffix;
}

function readDefinitions(): Map<string, TokenDefinition> {
  const result = new Map<string, TokenDefinition>();
  for (const path of THEME_FILES) {
    const layer: DefinitionLayer = path.endsWith("tokens.css") ? "fallback" : "nocturne";
    const source = readFileSync(resolve(ROOT, path), "utf8");
    for (const match of source.matchAll(/^\s*(--component-[\w-]+)\s*:\s*([\s\S]*?);/gm)) {
      const current = result.get(match[1]) ?? { layers: new Set<DefinitionLayer>(), values: [] };
      current.layers.add(layer);
      current.values.push(match[2].trim());
      result.set(match[1], current);
    }
  }
  return result;
}

function directReferences(paths: readonly string[], stripTokenDefinitions = false) {
  const staticReferences = new Map<string, Set<string>>();
  const dynamicReferences = new Map<string, Set<string>>();

  function add(target: Map<string, Set<string>>, token: string, path: string) {
    const files = target.get(token) ?? new Set<string>();
    files.add(path);
    target.set(token, files);
  }

  for (const path of paths) {
    const rawSource = readFileSync(resolve(ROOT, path), "utf8");
    const source = stripTokenDefinitions
      ? rawSource.replace(/^\s*--[\w-]+\s*:\s*[\s\S]*?;/gm, "")
      : rawSource;
    for (const match of source.matchAll(/var\((--component-[\w-]+)/g)) {
      add(staticReferences, match[1], path);
    }
    for (const match of source.matchAll(
      /(?:getPropertyValue|setProperty|removeProperty)\(\s*["'](--component-[\w-]+)["']/g,
    )) {
      add(dynamicReferences, match[1], path);
    }
  }
  return { staticReferences, dynamicReferences };
}

function mergeReferences(
  ...sources: ReturnType<typeof directReferences>[]
): ReturnType<typeof directReferences> {
  const result = {
    staticReferences: new Map<string, Set<string>>(),
    dynamicReferences: new Map<string, Set<string>>(),
  };
  for (const source of sources) {
    for (const key of ["staticReferences", "dynamicReferences"] as const) {
      for (const [token, paths] of source[key]) {
        const merged = result[key].get(token) ?? new Set<string>();
        for (const path of paths) merged.add(path);
        result[key].set(token, merged);
      }
    }
  }
  return result;
}

function reachableTokens(
  roots: Iterable<string>,
  definitions: ReadonlyMap<string, TokenDefinition>,
): Set<string> {
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const token = pending.pop()!;
    if (reachable.has(token)) continue;
    reachable.add(token);
    for (const value of definitions.get(token)?.values ?? []) {
      for (const match of value.matchAll(/var\((--component-[\w-]+)/g)) pending.push(match[1]);
    }
  }
  return reachable;
}

function buildInventory() {
  const definitions = readDefinitions();
  const files = projectFiles("src").filter((path) => !THEME_FILES.includes(path as never));
  const activeFiles = files;
  const legacyFiles: string[] = [];
  const activeDirect = mergeReferences(
    directReferences(activeFiles),
    directReferences(THEME_FILES, true),
  );
  const legacyDirect = directReferences(legacyFiles);
  const activeRoots = new Set([
    ...activeDirect.staticReferences.keys(),
    ...activeDirect.dynamicReferences.keys(),
  ]);
  const legacyRoots = new Set([
    ...legacyDirect.staticReferences.keys(),
    ...legacyDirect.dynamicReferences.keys(),
  ]);
  const activeReachable = reachableTokens(activeRoots, definitions);
  const legacyReachable = reachableTokens(legacyRoots, definitions);

  const entries: TokenInventoryEntry[] = [...definitions.entries()].map(([token, definition]) => {
    const active = activeReachable.has(token);
    const consumption: ConsumptionMode = activeDirect.dynamicReferences.has(token)
      ? "dynamic"
      : activeDirect.staticReferences.has(token)
        ? "static"
        : active
          ? "transitive"
          : legacyReachable.has(token)
            ? "static"
            : "none";
    return {
      token,
      family: tokenFamily(token),
      layers: [...definition.layers].sort(),
      status: active ? "Active" : "Legacy",
      consumption,
    };
  });

  return { entries, activeDirect, legacyReachable };
}

describe("exhaustive component theme inventory", () => {
  const inventory = buildInventory();
  const scoped = inventory.entries;

  test("classifies every definition without inferring dead tokens", () => {
    expect(inventory.entries).toHaveLength(2614);
    expect(scoped).toHaveLength(2614);
    expect(scoped.filter(({ status }) => status === "Active")).toHaveLength(2580);
    expect(scoped.filter(({ status }) => status === "Legacy")).toHaveLength(34);
    expect(inventory.entries.every(({ status }) => ["Active", "Legacy"].includes(status))).toBe(true);
    expect(inventory.entries.some(({ status }) => (status as string) === "Dead")).toBe(false);
  });

  test("fixes the complete family and definition-layer inventories", () => {
    const families = Object.fromEntries(
      [...Map.groupBy(scoped, ({ family }) => family).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([family, entries]) => [family, entries.length]),
    );
    expect(families).toEqual(EXPECTED_FAMILY_COUNTS);
    expect(scoped.filter(({ layers }) => layers.join("+") === "fallback+nocturne")).toHaveLength(2351);
    expect(scoped.filter(({ layers }) => layers.join("+") === "fallback")).toHaveLength(263);
    expect(scoped.filter(({ layers }) => layers.join("+") === "nocturne")).toHaveLength(0);
  });

  test("separates active, Legacy-only, unconsumed Legacy, and known dynamic access", () => {
    const active = scoped.filter(({ status }) => status === "Active");
    const legacy = scoped.filter(({ status }) => status === "Legacy");
    const legacyOnly = legacy.filter(({ token }) => inventory.legacyReachable.has(token));
    const unconsumed = legacy.filter(({ consumption }) => consumption === "none");
    const dynamic = scoped.filter(({ consumption }) => consumption === "dynamic");

    expect(active.filter(({ consumption }) => consumption === "static")).toHaveLength(2563);
    expect(active.filter(({ consumption }) => consumption === "dynamic")).toHaveLength(1);
    expect(active.filter(({ consumption }) => consumption === "transitive")).toHaveLength(16);
    expect(legacyOnly).toHaveLength(0);
    expect(unconsumed.map(({ token }) => token).sort()).toEqual([
      "--component-settings-overlay-blur",
      "--component-toast-accent-inset",
      "--component-toast-accent-width",
      "--component-toast-action-padding",
      "--component-toast-blur",
      "--component-toast-body-fg",
      "--component-toast-body-font-size",
      "--component-toast-body-line-height",
      "--component-toast-border-hover",
      "--component-toast-close-bg",
      "--component-toast-close-border",
      "--component-toast-close-border-hover",
      "--component-toast-close-icon-stroke-width",
      "--component-toast-download-bg",
      "--component-toast-error-bg",
      "--component-toast-icon-bg",
      "--component-toast-icon-border",
      "--component-toast-icon-size",
      "--component-toast-icon-state-fg",
      "--component-toast-icon-stroke-width",
      "--component-toast-info-bg",
      "--component-toast-padding",
      "--component-toast-radius",
      "--component-toast-success-bg",
      "--component-toast-texture",
      "--component-toast-title-fg",
      "--component-toast-title-font-size",
      "--component-toast-title-font-weight",
      "--component-toast-title-line-height",
      "--component-topbar-idle-blur",
      "--component-topbar-idle-shadow",
      "--component-tracking-record-tracker-icon-text-background",
      "--component-tracking-record-tracker-icon-text-border",
      "--component-tracking-record-tracker-icon-text-color",
    ]);
    expect(dynamic.map(({ token }) => token)).toEqual(["--component-reader-core-epub-link-fg"]);
    expect(inventory.activeDirect.dynamicReferences.get("--component-reader-core-epub-link-fg")).toEqual(
      new Set(["src/components/reader/BookReader.svelte"]),
    );
  });
});
