import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const THEME_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
] as const;
const LEGACY_CONSUMER_FILES = new Set([
  "src/routes.ts",
  "src/components/pages/Discover.svelte",
  "src/components/pages/Extensions.svelte",
  "src/components/shared/SourceBrowse.svelte",
  "src/components/shared/SourceList.svelte",
  "src/components/pages/NovelSources.svelte",
  "src/components/novels/NovelSourceCheckModal.svelte",
  "src/components/novels/NovelSourceStatusDetails.svelte",
  "src/components/settings/NovelRepositoriesPanel.svelte",
  "src/components/library/NovelsLibraryBody.svelte",
  "src/components/pages/Tracking.svelte",
  "src/components/pages/GenreDrillPage.svelte",
]);
const SYNCD_CONSUMER_FILES = new Set([
  "src/components/settings/SyncdConnectionPanel.svelte",
  "src/components/settings/SyncdSessionDetails.svelte",
  "src/lib/syncdQr.ts",
]);

const EXPECTED_FAMILY_COUNTS = {
  activity: 74,
  app: 16,
  browse: 443,
  button: 4,
  card: 4,
  chip: 1,
  detail: 275,
  downloads: 137,
  focus: 1,
  home: 74,
  input: 4,
  layout: 1,
  library: 98,
  manga: 191,
  menu: 14,
  migrate: 19,
  migration: 88,
  modal: 4,
  nav: 15,
  "nocturne-state": 126,
  novel: 98,
  overlay: 1,
  popover: 4,
  reader: 168,
  search: 10,
  settings: 106,
  sidebar: 8,
  soft: 1,
  sources: 138,
  splash: 21,
  tab: 2,
  taste: 51,
  "theme-editor": 221,
  toast: 33,
  toolbar: 11,
  topbar: 12,
  tracking: 117,
  updater: 49,
  window: 22,
} as const;

const EXPECTED_UNCONSUMED_LEGACY = [
  "--component-button-fg",
  "--component-card-radius",
  "--component-popover-bg",
  "--component-popover-border",
  "--component-popover-radius",
  "--component-popover-shadow",
  "--component-tab-bg-active",
  "--component-tab-fg-active",
] as const;

type DefinitionLayer = "fallback" | "nocturne";
type InventoryStatus = "Active" | "Legacy" | "Excluded";
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

function directReferences(paths: readonly string[]) {
  const staticReferences = new Map<string, Set<string>>();
  const dynamicReferences = new Map<string, Set<string>>();

  function add(target: Map<string, Set<string>>, token: string, path: string) {
    const files = target.get(token) ?? new Set<string>();
    files.add(path);
    target.set(token, files);
  }

  for (const path of paths) {
    const source = readFileSync(resolve(ROOT, path), "utf8");
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
  const activeFiles = files.filter(
    (path) => !LEGACY_CONSUMER_FILES.has(path) && !SYNCD_CONSUMER_FILES.has(path),
  );
  const legacyFiles = files.filter((path) => LEGACY_CONSUMER_FILES.has(path));
  const activeDirect = directReferences(activeFiles);
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
    const excluded = token.startsWith("--component-syncd-");
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
      status: excluded ? "Excluded" : active ? "Active" : "Legacy",
      consumption,
    };
  });

  return { entries, activeDirect, legacyReachable };
}

describe("exhaustive component theme inventory", () => {
  const inventory = buildInventory();
  const scoped = inventory.entries.filter(({ status }) => status !== "Excluded");

  test("classifies every definition without inferring dead tokens", () => {
    expect(inventory.entries).toHaveLength(2722);
    expect(inventory.entries.filter(({ status }) => status === "Excluded")).toHaveLength(60);
    expect(scoped).toHaveLength(2662);
    expect(scoped.filter(({ status }) => status === "Active")).toHaveLength(2565);
    expect(scoped.filter(({ status }) => status === "Legacy")).toHaveLength(97);
    expect(inventory.entries.every(({ status }) => ["Active", "Legacy", "Excluded"].includes(status))).toBe(true);
    expect(inventory.entries.some(({ status }) => (status as string) === "Dead")).toBe(false);
  });

  test("fixes the complete non-Syncd family and definition-layer inventories", () => {
    const families = Object.fromEntries(
      [...Map.groupBy(scoped, ({ family }) => family).entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([family, entries]) => [family, entries.length]),
    );
    expect(families).toEqual(EXPECTED_FAMILY_COUNTS);
    expect(scoped.filter(({ layers }) => layers.join("+") === "fallback+nocturne")).toHaveLength(2433);
    expect(scoped.filter(({ layers }) => layers.join("+") === "fallback")).toHaveLength(229);
    expect(scoped.filter(({ layers }) => layers.join("+") === "nocturne")).toHaveLength(0);
  });

  test("separates active, Legacy-only, unconsumed Legacy, and known dynamic access", () => {
    const active = scoped.filter(({ status }) => status === "Active");
    const legacy = scoped.filter(({ status }) => status === "Legacy");
    const legacyOnly = legacy.filter(({ token }) => inventory.legacyReachable.has(token));
    const unconsumed = legacy.filter(({ consumption }) => consumption === "none");
    const dynamic = scoped.filter(({ consumption }) => consumption === "dynamic");

    expect(active.filter(({ consumption }) => consumption === "static")).toHaveLength(2551);
    expect(active.filter(({ consumption }) => consumption === "dynamic")).toHaveLength(1);
    expect(active.filter(({ consumption }) => consumption === "transitive")).toHaveLength(13);
    expect(legacyOnly).toHaveLength(89);
    expect(legacyOnly.every(({ consumption }) => consumption === "static")).toBe(true);
    expect(legacyOnly.every(({ token }) => token.startsWith("--component-novel-repositories-"))).toBe(true);
    expect(unconsumed.map(({ token }) => token).sort()).toEqual([...EXPECTED_UNCONSUMED_LEGACY]);
    expect(dynamic.map(({ token }) => token)).toEqual(["--component-reader-core-epub-link-fg"]);
    expect(inventory.activeDirect.dynamicReferences.get("--component-reader-core-epub-link-fg")).toEqual(
      new Set(["src/components/reader/BookReader.svelte"]),
    );
  });
});
