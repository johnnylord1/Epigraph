import {
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_VARS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_TOKEN_KEYS,
  getBuiltinThemeFallbackContract,
  type BuiltinTheme,
  type HudThemeTokens,
  type ThemeMotionPreset,
  type ThemeTokens,
} from "./contract";
import { migrateThemeDocument, resolveThemeDocument } from "./document";

const LEGACY_MOTION_PROPERTIES = ["--t-fast", "--t-base", "--t-slow"] as const;

export const CUSTOM_THEME_STYLE_PROPERTIES = [
  ...THEME_TOKEN_KEYS.map((key) => `--${key}` as const),
  ...HUD_THEME_TOKEN_KEYS.map((key) => `--${key}` as const),
  ...THEME_MOTION_PROPERTY_KEYS,
  ...LEGACY_MOTION_PROPERTIES,
  "--sidebar-width",
] as const;

export function clearCustomThemeProperties(element: HTMLElement): void {
  for (const property of CUSTOM_THEME_STYLE_PROPERTIES) {
    element.style.removeProperty(property);
  }
  element.removeAttribute("data-custom-theme");
}

export function readComputedThemeContract(
  element: HTMLElement,
  base: BuiltinTheme,
  readStyle: (element: Element) => CSSStyleDeclaration = getComputedStyle,
): { tokens: ThemeTokens; hud: HudThemeTokens } {
  const computed = readStyle(element);
  const fallback = getBuiltinThemeFallbackContract(base);
  const tokens = Object.fromEntries(
    THEME_TOKEN_KEYS.map((key) => [key, computed.getPropertyValue(`--${key}`).trim() || fallback.tokens[key]]),
  ) as unknown as ThemeTokens;
  const hud = Object.fromEntries(
    HUD_THEME_TOKEN_KEYS.map((key) => [key, computed.getPropertyValue(`--${key}`).trim() || fallback.hud[key]]),
  ) as unknown as HudThemeTokens;
  return { tokens, hud };
}

export function readBuiltinThemeContract(base: BuiltinTheme): { tokens: ThemeTokens; hud: HudThemeTokens } {
  if (typeof document === "undefined" || !document.body) {
    const fallback = getBuiltinThemeFallbackContract(base);
    return { tokens: fallback.tokens, hud: fallback.hud };
  }
  const probe = document.createElement("div");
  probe.setAttribute("data-theme", base);
  probe.hidden = true;
  document.body.appendChild(probe);
  try {
    return readComputedThemeContract(probe, base);
  } finally {
    probe.remove();
  }
}

export function applyThemeContract(
  element: HTMLElement,
  tokens: ThemeTokens,
  hud: HudThemeTokens,
  motion: ThemeMotionPreset,
): void {
  for (const key of THEME_TOKEN_KEYS) {
    element.style.setProperty(`--${key}`, tokens[key]);
  }
  for (const key of HUD_THEME_TOKEN_KEYS) {
    element.style.setProperty(`--${key}`, hud[key]);
  }
  for (const [property, value] of Object.entries(THEME_MOTION_VARS[motion])) {
    element.style.setProperty(property, value);
  }
  element.style.setProperty("--sidebar-width", "var(--hud-sidebar-width)");
}

export function applyCustomTheme(
  element: HTMLElement,
  storedTheme: unknown,
  readStyle?: (element: Element) => CSSStyleDeclaration,
): boolean {
  const result = migrateThemeDocument(storedTheme);
  if (!result.ok) return false;

  clearCustomThemeProperties(element);
  element.setAttribute("data-theme", result.document.base);
  const base = readComputedThemeContract(element, result.document.base, readStyle);
  const resolved = resolveThemeDocument(result.document, base.tokens, base.hud);
  applyThemeContract(element, resolved.tokens, resolved.hud, result.document.motion);
  element.setAttribute("data-custom-theme", result.document.id);
  return true;
}
