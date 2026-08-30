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
      "bg-base": "#f3f2f5",
      "text-primary": "#242127",
      "color-background": "#f3f2f5",
      "color-danger": "#9f3447",
    });
  });

  test("keeps Epigraph accents violet and AMOLED surfaces truly black", () => {
    expect(BUILTIN_THEME_CONTRACTS.dark.tokens).toMatchObject({
      "bg-base": "#080809",
      "bg-surface": "#0b0b0d",
      "accent": "#9f8ed9",
      "border-focus": "#8373c2",
    });
    expect(BUILTIN_THEME_CONTRACTS["high-contrast"].tokens["accent"]).toBe("#b49cf0");
    expect(BUILTIN_THEME_CONTRACTS.light.tokens["accent"]).toBe("#6750a4");
    expect(BUILTIN_THEME_CONTRACTS["light-contrast"].tokens["accent"]).toBe("#4f378b");

    const amoled = BUILTIN_THEME_CONTRACTS.amoled.tokens;
    for (const token of ["bg-void", "bg-base", "bg-surface", "bg-raised"] as const) {
      expect(amoled[token], `AMOLED ${token}`).toBe("#000000");
    }
    expect(amoled).toMatchObject({
      "color-background": "#000000",
      "color-surface": "#000000",
      "color-card": "#000000",
      "accent": "#a88bd8",
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

  test.each(BUILTIN_THEME_IDS)("%s uses the shared modern HUD geometry", (id) => {
    expect(BUILTIN_THEME_CONTRACTS[id].hud).toMatchObject({
      "hud-control-height": "28px",
      "hud-icon-button-size": "28px",
      "hud-control-radius": "8px",
      "hud-popover-radius": "12px",
      "hud-status-radius": "9999px",
      "hud-toast-radius": "12px",
      "hud-chapter-row-radius": "9px",
      "hud-progress-height": "2px",
    });
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
