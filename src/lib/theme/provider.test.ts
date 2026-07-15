import { describe, expect, test, vi } from "vitest";
import {
  NOCTURNE_HUD_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS,
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_MOTION_VARS,
  THEME_TOKEN_KEYS,
} from "./contract";
import {
  CUSTOM_THEME_STYLE_PROPERTIES,
  applyCustomTheme,
  clearCustomThemeProperties,
} from "./provider";

function computedStyle(values: Record<string, string>): CSSStyleDeclaration {
  return { getPropertyValue: (property: string) => values[property] ?? "" } as CSSStyleDeclaration;
}

describe("custom theme provider", () => {
  test("applies only allowlisted properties through setProperty", () => {
    const style = {
      setProperty: vi.fn(),
      removeProperty: vi.fn(),
    } as unknown as CSSStyleDeclaration;
    const attributes = new Map<string, string>();
    const element = {
      style,
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
    } as unknown as HTMLElement;
    const raw = {
      version: 3,
      id: "custom:test",
      name: "Test",
      tokens: { ...NOCTURNE_THEME_TOKENS, accent: "#abcdef" },
      hud: NOCTURNE_HUD_THEME_TOKENS,
      motion: "minimal",
    };
    const baseValues = Object.fromEntries([
      ...Object.entries(NOCTURNE_THEME_TOKENS).map(([key, value]) => [`--${key}`, value]),
      ...Object.entries(NOCTURNE_HUD_THEME_TOKENS).map(([key, value]) => [`--${key}`, value]),
    ]);

    expect(applyCustomTheme(element, raw, () => computedStyle(baseValues))).toBe(true);
    expect(attributes.get("data-theme")).toBe("nocturne");
    expect(attributes.get("data-custom-theme")).toBe("custom:test");
    expect(style.setProperty).toHaveBeenCalledWith("--accent", "#abcdef");
    expect(style.setProperty).toHaveBeenCalledWith(
      "--motion-duration-fast",
      THEME_MOTION_VARS.minimal["--motion-duration-fast"],
    );
    expect(style.setProperty).toHaveBeenCalledWith(
      "--motion-easing-standard",
      THEME_MOTION_VARS.minimal["--motion-easing-standard"],
    );
    expect(style.setProperty).toHaveBeenCalledWith("--sidebar-width", "var(--hud-sidebar-width)");
    expect(style.setProperty).toHaveBeenCalledTimes(
      THEME_TOKEN_KEYS.length + HUD_THEME_TOKEN_KEYS.length + THEME_MOTION_PROPERTY_KEYS.length + 1,
    );
    expect(style.setProperty).not.toHaveBeenCalledWith("--t-fast", expect.anything());
  });

  test("clears every custom property when returning to a builtin", () => {
    const style = { removeProperty: vi.fn() } as unknown as CSSStyleDeclaration;
    const element = { style, removeAttribute: vi.fn() } as unknown as HTMLElement;

    clearCustomThemeProperties(element);

    expect(style.removeProperty).toHaveBeenCalledTimes(CUSTOM_THEME_STYLE_PROPERTIES.length);
    expect(element.removeAttribute).toHaveBeenCalledWith("data-custom-theme");
  });

  test("rejects invalid stored documents before touching the element", () => {
    const element = {
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    } as unknown as HTMLElement;

    expect(applyCustomTheme(element, { id: "custom:bad", tokens: { accent: "red; } body { color: red" } })).toBe(false);
    expect(element.style.setProperty).not.toHaveBeenCalled();
  });
});
