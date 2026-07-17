import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUILTIN_THEMES,
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_TOKEN_KEYS,
} from "./contract";
import { renderBuiltinThemesCss } from "./builtinCss";

const ROOT = process.cwd();
const GENERATED_PATH = resolve(ROOT, "src/styles/builtin-themes.generated.css");

describe("generated builtin theme CSS", () => {
  test("matches the canonical TypeScript contracts exactly", () => {
    expect(readFileSync(GENERATED_PATH, "utf8")).toBe(renderBuiltinThemesCss());
  });

  test("publishes every token, HUD value and motion property once per builtin", () => {
    const css = renderBuiltinThemesCss();
    const expectedDeclarations =
      BUILTIN_THEMES.length
      * (THEME_TOKEN_KEYS.length + HUD_THEME_TOKEN_KEYS.length + THEME_MOTION_PROPERTY_KEYS.length);

    expect(Array.from(css.matchAll(/^\s+--[\w-]+:/gm))).toHaveLength(expectedDeclarations);
    for (const { id } of BUILTIN_THEMES) {
      expect(css.match(new RegExp(`\\[data-theme="${id}"\\]`, "g"))).toHaveLength(1);
    }
  });

  test("keeps manual builtin contracts out of theme implementation CSS", () => {
    const fallback = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
    const nocturne = readFileSync(resolve(ROOT, "src/styles/nocturne-theme.css"), "utf8");

    for (const { id } of BUILTIN_THEMES.filter(({ id }) => id !== "nocturne")) {
      expect(fallback).not.toContain(`[data-theme="${id}"]`);
    }

    const nocturneRoot = nocturne.slice(
      nocturne.indexOf('[data-theme="nocturne"] {'),
      nocturne.indexOf('[data-theme="nocturne"] {') + 600,
    );
    for (const key of THEME_TOKEN_KEYS) expect(nocturneRoot).not.toContain(`--${key}:`);
  });
});
