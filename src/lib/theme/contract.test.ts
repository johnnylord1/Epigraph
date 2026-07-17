import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_CONTRACTS,
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
  DEFAULT_BUILTIN_THEME_ID,
  getBuiltinThemeMetadata,
  getBuiltinThemeFallbackContract,
  isBuiltinTheme,
  normalizeThemeSelection,
} from "./contract";
import {
  DEFAULT_THEME_TOKENS as STORE_DEFAULT_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS as STORE_NOCTURNE_THEME_TOKENS,
} from "../../store/state.svelte";

describe("canonical theme contract", () => {
  test("keeps one unique registry entry for every built-in theme", () => {
    expect(BUILTIN_THEMES.map((theme) => theme.id)).toEqual([...BUILTIN_THEME_IDS]);
    expect(new Set(BUILTIN_THEME_IDS).size).toBe(BUILTIN_THEME_IDS.length);
    expect(DEFAULT_BUILTIN_THEME_ID).toBe("nocturne");
    expect(getBuiltinThemeMetadata("nocturne")?.label).toBe("Nocturne");
    expect(isBuiltinTheme("light")).toBe(true);
    expect(isBuiltinTheme("amoled")).toBe(true);
    expect(isBuiltinTheme("custom:test")).toBe(false);
  });

  test("normalizes active theme selection against builtins and saved custom themes", () => {
    expect(normalizeThemeSelection(undefined)).toBe(DEFAULT_BUILTIN_THEME_ID);
    expect(normalizeThemeSelection("dark")).toBe("dark");
    expect(normalizeThemeSelection(" custom:missing ")).toBe(DEFAULT_BUILTIN_THEME_ID);
    expect(normalizeThemeSelection("custom:local", [{ id: "custom:local" }])).toBe("custom:local");
    expect(normalizeThemeSelection("solarized")).toBe(DEFAULT_BUILTIN_THEME_ID);
  });

  test("exposes the fallback contract used when a builtin cannot be computed from the DOM", () => {
    expect(getBuiltinThemeFallbackContract("nocturne")).toMatchObject({
      tokens: NOCTURNE_THEME_TOKENS,
      hud: NOCTURNE_HUD_THEME_TOKENS,
      motion: "soft",
    });
    for (const id of BUILTIN_THEME_IDS) {
      expect(getBuiltinThemeFallbackContract(id)).toBe(BUILTIN_THEME_CONTRACTS[id]);
    }
    expect(getBuiltinThemeFallbackContract("dark")).toMatchObject({ tokens: DEFAULT_THEME_TOKENS });
    expect(getBuiltinThemeFallbackContract("light").tokens).toMatchObject({
      "bg-base": "#eeece8",
      "text-primary": "#1a1916",
      "color-background": "#eeece8",
      "color-danger": "#a03030",
    });
  });

  test("keeps Aethon accents violet and AMOLED surfaces truly black", () => {
    expect(BUILTIN_THEME_CONTRACTS.dark.tokens).toMatchObject({
      "bg-base": "#0a0a0b",
      "bg-surface": "#111113",
      "accent": "#9d7cff",
      "border-focus": "#9d7cff",
    });
    expect(BUILTIN_THEME_CONTRACTS["high-contrast"].tokens["accent"]).toBe("#b89cff");
    expect(BUILTIN_THEME_CONTRACTS.light.tokens["accent"]).toBe("#6d3bd1");
    expect(BUILTIN_THEME_CONTRACTS["light-contrast"].tokens["accent"]).toBe("#4d158f");

    const amoled = BUILTIN_THEME_CONTRACTS.amoled.tokens;
    for (const token of ["bg-void", "bg-base", "bg-surface", "bg-raised"] as const) {
      expect(amoled[token], `AMOLED ${token}`).toBe("#000000");
    }
    expect(amoled).toMatchObject({
      "color-background": "#000000",
      "color-surface": "#000000",
      "color-card": "#000000",
      "accent": "#b36dff",
    });
  });

  test("keeps token key inventories complete and synchronized", () => {
    expect([...THEME_TOKEN_KEYS].sort()).toEqual(Object.keys(DEFAULT_THEME_TOKENS).sort());
    expect(Object.keys(NOCTURNE_THEME_TOKENS).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
    expect([...HUD_THEME_TOKEN_KEYS].sort()).toEqual(Object.keys(DEFAULT_HUD_THEME_TOKENS).sort());
    expect(Object.keys(NOCTURNE_HUD_THEME_TOKENS).sort()).toEqual([...HUD_THEME_TOKEN_KEYS].sort());
    expect(Object.keys(BUILTIN_THEME_CONTRACTS)).toEqual([...BUILTIN_THEME_IDS]);
    for (const contract of Object.values(BUILTIN_THEME_CONTRACTS)) {
      expect(Object.keys(contract.tokens).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
      expect(Object.keys(contract.hud).sort()).toEqual([...HUD_THEME_TOKEN_KEYS].sort());
      expect(THEME_MOTION_VARS[contract.motion]).toBeDefined();
    }
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
