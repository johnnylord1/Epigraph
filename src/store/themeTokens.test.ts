import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS,
  type ThemeTokens,
} from "./state.svelte";

const ROOT = process.cwd();
const TOKEN_CSS_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
];
const COMPONENT_SCAN_FILES = [
  "src/App.svelte",
  "src/components",
  "src/styles/global.css",
  "src/styles/nocturne-port.css",
];
const LEGACY_ONLY_FILES = [
  "src/components/settings/ThemeEditor.svelte",
  "src/store",
];

function readRepoFile(path: string) {
  return readFileSync(join(ROOT, path), "utf8");
}

function readPathText(path: string): string {
  const fullPath = join(ROOT, path);
  const stat = statSync(fullPath);
  if (stat.isDirectory()) {
    return readdirSync(fullPath, { withFileTypes: true })
      .filter((entry) => !entry.name.includes("__screenshots__"))
      .map((entry) => {
        const child = `${path}/${entry.name}`;
        return entry.isDirectory() ? readPathText(child) : readRepoFile(child);
      })
      .join("\n");
  }
  return readRepoFile(path);
}

function readPathTextExcept(path: string, excluded: string[]): string {
  if (excluded.some((entry) => path.replaceAll("\\", "/").startsWith(entry))) return "";
  const fullPath = join(ROOT, path);
  const stat = statSync(fullPath);
  if (stat.isDirectory()) {
    return readdirSync(fullPath, { withFileTypes: true })
      .filter((entry) => !entry.name.includes("__screenshots__"))
      .map((entry) => {
        const child = `${path}/${entry.name}`;
        return entry.isDirectory() ? readPathTextExcept(child, excluded) : readPathTextExcept(child, excluded);
      })
      .join("\n");
  }
  return readRepoFile(path);
}

function cssTokenNames() {
  return new Set(
    Array.from(
      TOKEN_CSS_FILES
        .map(readRepoFile)
        .join("\n")
        .matchAll(/--([a-zA-Z0-9_-]+)\s*:/g),
      (match) => match[1],
    ),
  );
}

function classifyToken(token: keyof ThemeTokens) {
  const cssVar = `--${token}`;
  const activeText = COMPONENT_SCAN_FILES.map((file) => readPathTextExcept(file, LEGACY_ONLY_FILES)).join("\n");
  if (activeText.includes(`var(${cssVar}`)) {
    return "active-or-dynamic";
  }
  const legacyText = LEGACY_ONLY_FILES.map(readPathText).join("\n");
  if (legacyText.includes(`"${token}"`) || legacyText.includes(cssVar)) return "legacy";
  return "legacy";
}

describe("theme token contract", () => {
  test("keeps default and Nocturne token maps in sync", () => {
    expect(Object.keys(NOCTURNE_THEME_TOKENS).sort()).toEqual(Object.keys(DEFAULT_THEME_TOKENS).sort());
  });

  test("defines every ThemeTokens key in CSS token sources", () => {
    const definedTokens = cssTokenNames();
    for (const token of Object.keys(DEFAULT_THEME_TOKENS)) {
      expect(definedTokens.has(token), `Missing CSS variable --${token}`).toBe(true);
    }
  });

  test("classifies established tokens as active or dynamic and new semantic aliases as legacy until migration", () => {
    expect(classifyToken("bg-base")).toBe("active-or-dynamic");
    expect(classifyToken("text-primary")).toBe("active-or-dynamic");
    expect(classifyToken("color-card")).toBe("legacy");
    expect(classifyToken("color-popover")).toBe("legacy");
  });
});
