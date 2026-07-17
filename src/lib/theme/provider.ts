import {
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_VARS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_TOKEN_KEYS,
  BUILTIN_THEME_IDS,
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

function nestedCssRules(rule: CSSRule): CSSRule[] {
  if (!("cssRules" in rule)) return [];
  try {
    return Array.from((rule as CSSGroupingRule).cssRules);
  } catch {
    return [];
  }
}

export function getBuiltinExactThemePropertyNames(element: HTMLElement): string[] {
  const document = element.ownerDocument;
  if (!document) return [];
  const selectors = new Set(
    BUILTIN_THEME_IDS.map((base) => `[data-theme="${base}"]:not([data-custom-theme])`),
  );
  const properties = new Set<string>();
  const pending = Array.from(document.styleSheets).flatMap((sheet) => {
    try {
      return Array.from(sheet.cssRules);
    } catch {
      return [];
    }
  });

  while (pending.length > 0) {
    const rule = pending.shift()!;
    if ("selectorText" in rule && "style" in rule) {
      const selectorsInRule = String((rule as CSSStyleRule).selectorText)
        .split(",")
        .map((selector) => selector.trim());
      if (selectorsInRule.some((selector) => selectors.has(selector))) {
        for (const property of Array.from((rule as CSSStyleRule).style)) {
          if (property.startsWith("--")) properties.add(property);
        }
      }
    }
    pending.push(...nestedCssRules(rule));
  }
  return [...properties].sort();
}

function readProperties(
  element: HTMLElement,
  properties: readonly string[],
  readStyle: (element: Element) => CSSStyleDeclaration,
): Map<string, string> {
  const style = readStyle(element);
  return new Map(properties.map((property) => [property, style.getPropertyValue(property).trim()]));
}

export function clearCustomThemeProperties(element: HTMLElement): void {
  for (const property of CUSTOM_THEME_STYLE_PROPERTIES) {
    element.style.removeProperty(property);
  }
  for (const property of getBuiltinExactThemePropertyNames(element)) {
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
  const contract = getBuiltinThemeFallbackContract(base);
  return { tokens: contract.tokens, hud: contract.hud };
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
  const exactProperties = getBuiltinExactThemePropertyNames(element);
  const builtinExactValues = readProperties(element, exactProperties, readStyle ?? getComputedStyle);
  const base = readComputedThemeContract(element, result.document.base, readStyle);
  const resolved = resolveThemeDocument(result.document, base.tokens, base.hud);

  element.setAttribute("data-custom-theme", result.document.id);
  if (exactProperties.length > 0) {
    applyThemeContract(
      element,
      base.tokens,
      base.hud,
      getBuiltinThemeFallbackContract(result.document.base).motion,
    );
    const baseFallbackValues = readProperties(element, exactProperties, readStyle ?? getComputedStyle);
    applyThemeContract(element, resolved.tokens, resolved.hud, result.document.motion);
    const customFallbackValues = readProperties(element, exactProperties, readStyle ?? getComputedStyle);

    for (const property of exactProperties) {
      const exact = builtinExactValues.get(property);
      if (
        exact
        && baseFallbackValues.get(property) === customFallbackValues.get(property)
      ) {
        element.style.setProperty(property, exact);
      }
    }
    return true;
  }

  applyThemeContract(element, resolved.tokens, resolved.hud, result.document.motion);
  return true;
}
