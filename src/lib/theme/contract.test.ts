import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEMES,
  DEFAULT_HUD_THEME_TOKENS,
  DEFAULT_THEME_TOKENS,
  HUD_THEME_TOKEN_KEYS,
  NOCTURNE_HUD_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS,
  THEME_PRIMITIVE_TOKEN_KEYS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_MOTION_VARS,
  THEME_SEMANTIC_TOKEN_KEYS,
  THEME_TOKEN_KEYS,
  getBuiltinThemeMetadata,
  isBuiltinTheme,
} from "./contract";
import {
  DEFAULT_THEME_TOKENS as STORE_DEFAULT_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS as STORE_NOCTURNE_THEME_TOKENS,
} from "../../store/state.svelte";

describe("canonical theme contract", () => {
  test("keeps one unique registry entry for every built-in theme", () => {
    expect(BUILTIN_THEMES.map((theme) => theme.id)).toEqual([...BUILTIN_THEME_IDS]);
    expect(new Set(BUILTIN_THEME_IDS).size).toBe(BUILTIN_THEME_IDS.length);
    expect(getBuiltinThemeMetadata("nocturne")?.label).toBe("Nocturne");
    expect(isBuiltinTheme("light")).toBe(true);
    expect(isBuiltinTheme("custom:test")).toBe(false);
  });

  test("keeps token key inventories complete and synchronized", () => {
    expect([...THEME_TOKEN_KEYS].sort()).toEqual(Object.keys(DEFAULT_THEME_TOKENS).sort());
    expect(Object.keys(NOCTURNE_THEME_TOKENS).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
    expect([...HUD_THEME_TOKEN_KEYS].sort()).toEqual(Object.keys(DEFAULT_HUD_THEME_TOKENS).sort());
    expect(Object.keys(NOCTURNE_HUD_THEME_TOKENS).sort()).toEqual([...HUD_THEME_TOKEN_KEYS].sort());
    expect([...THEME_PRIMITIVE_TOKEN_KEYS, ...THEME_SEMANTIC_TOKEN_KEYS].sort()).toEqual([...THEME_TOKEN_KEYS].sort());
    expect(new Set([...THEME_PRIMITIVE_TOKEN_KEYS, ...THEME_SEMANTIC_TOKEN_KEYS]).size).toBe(THEME_TOKEN_KEYS.length);
    for (const preset of Object.values(THEME_MOTION_VARS)) {
      expect(Object.keys(preset)).toEqual([...THEME_MOTION_PROPERTY_KEYS]);
    }
  });

  test("preserves the store exports while consumers migrate to the contract", () => {
    expect(STORE_DEFAULT_THEME_TOKENS).toBe(DEFAULT_THEME_TOKENS);
    expect(STORE_NOCTURNE_THEME_TOKENS).toBe(NOCTURNE_THEME_TOKENS);
  });

  test("keeps Settings on the shared registry", () => {
    const settings = readFileSync(resolve("src/components/settings/Settings.svelte"), "utf8");
    expect(settings).toContain('import { BUILTIN_THEMES } from "../../lib/theme/contract"');
    expect(settings).not.toContain("const THEMES:");
  });
});
