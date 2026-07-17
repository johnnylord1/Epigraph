import { commands, page } from "@vitest/browser/context";
import { describe, expect, test } from "vitest";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_CONTRACTS,
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_VARS,
  THEME_TOKEN_KEYS,
  type HudThemeTokens,
} from "./contract";
import {
  applyCustomTheme,
  clearCustomThemeProperties,
  getBuiltinExactThemePropertyNames,
} from "./provider";

type Rgba = [number, number, number, number];

const surfaceTokens = [
  "--color-background",
  "--color-card",
  "--color-modal",
  "--component-card-bg",
  "--component-menu-bg",
  "--component-button-bg",
  "--component-input-bg",
  "--component-toast-bg",
  "--component-settings-card-bg",
] as const;

const textPairs = [
  ["--text-primary", "--color-background"],
  ["--text-secondary", "--color-background"],
  ["--text-primary", "--color-card"],
  ["--component-button-fg", "--component-button-bg"],
  ["--component-input-fg", "--component-input-bg"],
  ["--component-toast-title-fg", "--component-toast-bg"],
] as const;

function parseRgba(value: string): Rgba {
  const match = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) throw new Error(`Unsupported computed color: ${value}`);
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function luminance(color: Rgba): number {
  const [red, green, blue] = color.slice(0, 3).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(foreground: Rgba, background: Rgba): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function computedTokenColor(token: string, property: "color" | "backgroundColor"): Rgba {
  const probe = document.createElement("div");
  probe.style[property] = `var(${token})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return parseRgba(value);
}

function isPainted(token: string): boolean {
  const probe = document.createElement("div");
  probe.style.background = `var(${token})`;
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const painted = style.backgroundImage !== "none"
    || (style.backgroundColor !== "" && style.backgroundColor !== "rgba(0, 0, 0, 0)");
  probe.remove();
  return painted;
}

function computedPaint(token: string): string {
  const probe = document.createElement("div");
  probe.style.background = `var(${token})`;
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const value = `${style.backgroundColor}|${style.backgroundImage}`;
  probe.remove();
  return value;
}

function normalizedColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

const hudColorTokens = new Set<keyof HudThemeTokens>([
  "hud-selection-bg",
  "hud-selection-border",
]);
const hudOpacityTokens = new Set<keyof HudThemeTokens>([
  "hud-surface-opacity",
  "hud-reader-chrome-opacity",
]);

function normalizedHudValue(token: keyof HudThemeTokens, value: string): string {
  const probe = document.createElement("div");
  if (hudColorTokens.has(token)) probe.style.color = value;
  else if (hudOpacityTokens.has(token)) probe.style.opacity = value;
  else probe.style.width = value;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe);
  const result = hudColorTokens.has(token)
    ? computed.color
    : hudOpacityTokens.has(token)
      ? computed.opacity
      : computed.width;
  probe.remove();
  return result;
}

describe("builtin theme matrix", () => {
  test("keeps empty custom V5 documents computed-equivalent to every builtin base", async () => {
    const root = document.documentElement;

    try {
      for (const theme of BUILTIN_THEMES) {
        clearCustomThemeProperties(root);
        root.dataset.theme = theme.id;
        await new Promise(requestAnimationFrame);
        const exactProperties = getBuiltinExactThemePropertyNames(root);
        const builtinExact = new Map(exactProperties.map((token) => [token, getComputedStyle(root).getPropertyValue(token).trim()]));
        const builtinSurfaces = new Map(surfaceTokens.map((token) => [token, computedPaint(token)]));

        expect(applyCustomTheme(root, {
          version: 5,
          id: `custom:empty-${theme.id}`,
          name: `Empty ${theme.label}`,
          base: theme.id,
          primitives: {},
          motion: BUILTIN_THEME_CONTRACTS[theme.id].motion,
        })).toBe(true);
        await new Promise(requestAnimationFrame);

        for (const [token, value] of builtinExact) {
          expect(getComputedStyle(root).getPropertyValue(token).trim(), `${theme.id} ${token}`).toBe(value);
        }
        for (const [token, value] of builtinSurfaces) {
          expect(computedPaint(token), `${theme.id} ${token}`).toBe(value);
        }
      }
    } finally {
      clearCustomThemeProperties(root);
    }
  });

  test("matches every authored builtin contract to the computed CSS cascade", async () => {
    const root = document.documentElement;

    for (const theme of BUILTIN_THEMES) {
      root.dataset.theme = theme.id;
      root.removeAttribute("data-custom-theme");
      await new Promise(requestAnimationFrame);
      const contract = BUILTIN_THEME_CONTRACTS[theme.id];

      for (const token of THEME_TOKEN_KEYS) {
        expect(
          normalizedColor(`var(--${token})`),
          `${theme.id} --${token}`,
        ).toBe(normalizedColor(contract.tokens[token]));
      }
      for (const token of HUD_THEME_TOKEN_KEYS) {
        expect(
          normalizedHudValue(token, `var(--${token})`),
          `${theme.id} --${token}`,
        ).toBe(normalizedHudValue(token, contract.hud[token]));
      }
      const rootStyle = getComputedStyle(root);
      for (const [property, value] of Object.entries(THEME_MOTION_VARS[contract.motion])) {
        expect(rootStyle.getPropertyValue(property).trim(), `${theme.id} ${property}`).toBe(value);
      }
    }
  });

  test("resolves representative surfaces and AA text pairs for every registered builtin", async () => {
    const root = document.documentElement;

    for (const theme of BUILTIN_THEMES) {
      root.dataset.theme = theme.id;
      root.removeAttribute("data-custom-theme");
      await new Promise(requestAnimationFrame);

      for (const token of surfaceTokens) {
        expect(isPainted(token), `${theme.id} ${token} should paint`).toBe(true);
      }

      for (const [foregroundToken, backgroundToken] of textPairs) {
        const canvas = computedTokenColor("--color-background", "backgroundColor");
        const background = composite(computedTokenColor(backgroundToken, "backgroundColor"), canvas);
        const foreground = composite(computedTokenColor(foregroundToken, "color"), background);
        expect(
          contrast(foreground, background),
          `${theme.id} ${foregroundToken} on ${backgroundToken} should meet WCAG AA`,
        ).toBeGreaterThanOrEqual(4.5);
      }

      if (theme.id === "amoled") {
        const background = computedTokenColor("--color-background", "backgroundColor");
        const controlBorder = computedTokenColor("--color-border", "backgroundColor");
        const focusBorder = computedTokenColor("--color-outline", "backgroundColor");
        expect(contrast(controlBorder, background), "AMOLED control boundaries").toBeGreaterThanOrEqual(3);
        expect(contrast(focusBorder, background), "AMOLED visible focus").toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("captures browser evidence for every registered builtin surface palette", async () => {
    for (const theme of BUILTIN_THEMES) {
      document.body.innerHTML = "";
      document.documentElement.dataset.theme = theme.id;
      document.documentElement.removeAttribute("data-custom-theme");

      const frame = document.createElement("section");
      frame.setAttribute("aria-label", `${theme.label} builtin theme sample`);
      frame.style.cssText = `
        display: grid;
        gap: 16px;
        width: 960px;
        min-height: 520px;
        padding: 24px;
        color: var(--text-primary);
        background: var(--color-background);
        font: 13px/1.4 system-ui, sans-serif;
      `;

      const heading = document.createElement("strong");
      heading.textContent = `${theme.label} - ${theme.description}`;
      heading.style.cssText = "font-size: 20px; color: var(--text-primary);";
      frame.appendChild(heading);

      const grid = document.createElement("div");
      grid.style.cssText = "display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;";

      for (const token of [
        "--color-card",
        "--color-modal",
        "--component-menu-bg",
        "--component-button-bg",
        "--component-input-bg",
        "--component-toast-bg",
      ]) {
        const swatch = document.createElement("span");
        swatch.textContent = token.replace("--", "");
        swatch.style.cssText = `
          min-height: 86px;
          display: grid;
          place-items: center;
          padding: 6px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          color: var(--text-primary);
          background: var(${token});
        `;
        grid.appendChild(swatch);
      }

      frame.appendChild(grid);
      document.body.appendChild(frame);
      await new Promise(requestAnimationFrame);
      const screenshot = await page.screenshot({ base64: true });
      await commands.writeFile(
        `../../../docs/screenshots/marco44-builtin-matrix/${theme.id}.png`,
        screenshot.base64,
        "base64",
      );
    }
    expect(BUILTIN_THEMES).toHaveLength(8);
  });
});
