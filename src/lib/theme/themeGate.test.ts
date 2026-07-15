import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveCssColor, type RgbaColor } from "../../test/themeColor";
import { themeProbeCss } from "../../test/themeProbe";
import { THEME_TOKEN_KEYS } from "./contract";

const ROOT = process.cwd();
const tokensCss = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
const nocturneCss = readFileSync(resolve(ROOT, "src/styles/nocturne-theme.css"), "utf8");
const nocturnePortCss = readFileSync(resolve(ROOT, "src/styles/nocturne-port.css"), "utf8");
const directColorPattern =
  /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|(?<![\w-])(?:black|white)(?![\w-])/i;
const unreferencedLegacyNocturneTokens = [
  "--n-bg",
  "--n-bg-top",
  "--n-gradient-bg",
  "--n-line",
  "--n-line-strong",
  "--n-on-primary-container",
  "--n-outline-variant",
  "--n-popover-control-bg",
  "--n-popover-control-border",
  "--n-surface-container",
  "--n-surface-container-low",
] as const;
const selectorOnlyLegacyNocturneTokens = [
  "--n-surface-container-high",
  "--n-surface-container-highest",
  "--n-toolbar-cluster-padding",
  "--n-toolbar-cluster-radius",
  "--n-toolbar-divider-height",
  "--n-toolbar-icon-btn-size",
] as const;
const legacyNocturneTokens = [
  ...unreferencedLegacyNocturneTokens,
  ...selectorOnlyLegacyNocturneTokens,
] as const;
const legacyActivityTokens = [
  "--activity-panel",
  "--activity-panel-soft",
  "--activity-line",
  "--activity-line-soft",
  "--activity-text",
  "--activity-title",
  "--activity-muted",
  "--activity-subtle",
  "--activity-faint",
  "--activity-accent",
  "--activity-accent-soft",
  "--activity-accent-line",
  "--activity-danger",
] as const;

interface CssDeclaration {
  name: string;
  value: string;
}

function declarations(source: string): CssDeclaration[] {
  return [...source.matchAll(/^\s*(--[\w-]+)\s*:\s*([\s\S]*?);/gm)].map(
    ([, name, value]) => ({ name, value: value.trim() }),
  );
}

function componentDeclarations(source: string) {
  return declarations(source).filter(
    ({ name }) => name.startsWith("--component-") && !name.startsWith("--component-syncd-"),
  );
}

function references(value: string) {
  return [...value.matchAll(/var\((--[\w-]+)(\s*,)?/g)].map((match) => ({
    name: match[1],
    hasFallback: Boolean(match[2]),
  }));
}

function sourceCorpus(path: string): string {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return sourceCorpus(child);
      if (!/\.(?:css|svelte|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
      return readFileSync(resolve(ROOT, child), "utf8");
    })
    .join("\n");
}

function withoutDefinitions(source: string, token: string): string {
  return source.replace(new RegExp(`${token}\\s*:[^;]+;`, "g"), "");
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha,
  ];
}

function luminance(color: RgbaColor) {
  const [red, green, blue] = color.slice(0, 3).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(source: string, foregroundToken: string, backgroundToken: string) {
  const canvas = resolveCssColor(source, "--color-background");
  const background = composite(resolveCssColor(source, backgroundToken), canvas);
  const foreground = composite(resolveCssColor(source, foregroundToken), background);
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe("final derived theme gate", () => {
  test("limits exact semantic sources to the builtin Nocturne document", () => {
    const selector = '[data-theme="nocturne"]:not([data-custom-theme]) {';
    const selectorStart = nocturneCss.indexOf(selector);
    const selectorEnd = nocturneCss.indexOf("\n}", selectorStart);
    const builtinBlock = nocturneCss.slice(selectorStart, selectorEnd);
    const outsideBuiltin = `${nocturneCss.slice(0, selectorStart)}${nocturneCss.slice(selectorEnd + 2)}`;
    const exactSources = declarations(builtinBlock).filter(
      ({ name, value }) => name.startsWith("--color-") && name.endsWith("-source") && directColorPattern.test(value),
    );
    const fallbackDefinitions = new Set(declarations(tokensCss).map(({ name }) => name));
    const corpus = `${tokensCss}\n${nocturneCss}\n${nocturnePortCss}`;
    const missingFallback = exactSources
      .filter(({ name }) => !fallbackDefinitions.has(name))
      .map(({ name }) => name);
    const unreferenced = exactSources
      .filter(({ name }) => !withoutDefinitions(corpus, name).includes(`var(${name}`))
      .map(({ name }) => name);
    const leaked = declarations(outsideBuiltin)
      .filter(
        ({ name, value }) => name.startsWith("--color-") && name.endsWith("-source") && directColorPattern.test(value),
      )
      .map(({ name, value }) => `${name}: ${value}`);

    expect(selectorStart).toBeGreaterThan(-1);
    expect(selectorEnd).toBeGreaterThan(selectorStart);
    expect(exactSources).toHaveLength(232);
    expect(builtinBlock).toContain("--color-on-accent-strong: #352660;");
    expect(outsideBuiltin).not.toMatch(/--color-on-accent-strong\s*:/);
    expect(new Set(exactSources.map(({ name }) => name)).size).toBe(232);
    expect(missingFallback).toEqual([]);
    expect(unreferenced).toEqual([]);
    expect(leaked).toEqual([]);
  });

  test("limits exact derived semantic colors to the builtin Nocturne document", () => {
    const selector = '[data-theme="nocturne"]:not([data-custom-theme]) {';
    const selectorStart = nocturneCss.indexOf(selector);
    const selectorEnd = nocturneCss.indexOf("\n}", selectorStart);
    const builtinBlock = nocturneCss.slice(selectorStart, selectorEnd);
    const outsideBuiltin = `${nocturneCss.slice(0, selectorStart)}${nocturneCss.slice(selectorEnd + 2)}`;
    const editable = new Set(THEME_TOKEN_KEYS.map((name) => `--${name}`));
    const exactRoles = declarations(builtinBlock).filter(
      ({ name, value }) =>
        name.startsWith("--color-") && !name.endsWith("-source") && directColorPattern.test(value),
    );
    const fallbackDefinitions = new Set(declarations(tokensCss).map(({ name }) => name));
    const missingFallback = exactRoles
      .filter(({ name }) => !fallbackDefinitions.has(name))
      .map(({ name }) => name);
    const leaked = declarations(outsideBuiltin)
      .filter(
        ({ name, value }) =>
          name.startsWith("--color-") &&
          !name.endsWith("-source") &&
          !editable.has(name) &&
          directColorPattern.test(value),
      )
      .map(({ name, value }) => `${name}: ${value}`);

    expect(exactRoles).toHaveLength(57);
    expect(new Set(exactRoles.map(({ name }) => name)).size).toBe(57);
    expect(missingFallback).toEqual([]);
    expect(leaked).toEqual([]);
  });

  test("keeps every non-Syncd component token free of direct colors", () => {
    const offenders = componentDeclarations(`${tokensCss}\n${nocturneCss}`)
      .filter(({ value }) => directColorPattern.test(value))
      .map(({ name, value }) => `${name}: ${value}`);

    expect(offenders).toEqual([]);
  });

  test("resolves component aliases independently in fallback and Nocturne layers", () => {
    const fallbackDefinitions = new Set(declarations(tokensCss).map(({ name }) => name));
    const nocturneDefinitions = new Set(
      declarations(`${tokensCss}\n${nocturneCss}`).map(({ name }) => name),
    );
    const fallbackMissing = componentDeclarations(tokensCss).flatMap(({ name, value }) =>
      references(value)
        .filter((reference) => !reference.hasFallback && !fallbackDefinitions.has(reference.name))
        .map((reference) => `${name} -> ${reference.name}`),
    );
    const nocturneMissing = componentDeclarations(nocturneCss).flatMap(({ name, value }) =>
      references(value)
        .filter((reference) => !reference.hasFallback && !nocturneDefinitions.has(reference.name))
        .map((reference) => `${name} -> ${reference.name}`),
    );

    expect(fallbackMissing).toEqual([]);
    expect(nocturneMissing).toEqual([]);
  });

  test("preserves the audited active and Legacy compatibility inventories", () => {
    const source = sourceCorpus("src");
    const nocturneTokens = new Set(
      declarations(nocturneCss)
        .map(({ name }) => name)
        .filter((name) => name.startsWith("--n-")),
    );
    const activeTokens = [...nocturneTokens].filter(
      (token) => !legacyNocturneTokens.includes(token as (typeof legacyNocturneTokens)[number]),
    );

    expect(nocturneTokens.size).toBe(62);
    expect(activeTokens).toHaveLength(45);
    expect(legacyNocturneTokens).toHaveLength(17);
    expect(legacyActivityTokens).toHaveLength(13);

    for (const token of [...unreferencedLegacyNocturneTokens, ...legacyActivityTokens]) {
      expect(nocturneCss, `${token} must remain defined`).toMatch(new RegExp(`${token}\\s*:`));
      expect(withoutDefinitions(source, token), `${token} gained an active reference`).not.toMatch(
        new RegExp(`${token}(?![A-Za-z0-9_-])`),
      );
    }

    for (const token of selectorOnlyLegacyNocturneTokens) {
      expect(nocturneCss, `${token} must remain defined`).toMatch(new RegExp(`${token}\\s*:`));
      expect(nocturnePortCss, `${token} must remain attached to its Legacy selector`).toContain(`var(${token})`);
    }
  });

  test.each([
    ["primary text", "--text-primary", "--color-background"],
    ["secondary text", "--text-secondary", "--color-background"],
    ["tertiary text", "--text-tertiary", "--color-background"],
    ["button text", "--component-button-fg", "--component-button-bg"],
    ["input text", "--component-input-fg", "--component-input-bg"],
    ["Reader muted text", "--component-reader-muted-fg", "--component-reader-panel-bg"],
    ["Migration eyebrow", "--component-migration-eyebrow-fg", "--component-migration-modal-bg"],
    ["Migration muted text", "--component-migration-muted-fg", "--component-migration-modal-bg"],
    ["Novel field label", "--component-novel-repositories-field-color", "--component-novel-repositories-input-background"],
    ["Novel muted text", "--component-novel-repositories-muted-color", "--component-novel-repositories-surface-background"],
    ["Novel muted badge", "--component-novel-repositories-badge-muted-color", "--component-novel-repositories-badge-background"],
  ])("keeps %s at WCAG AA in Nocturne and the theme probe", (_label, foreground, background) => {
    const nocturneSource = `${tokensCss}\n${nocturneCss}`;
    const probeSource = `${tokensCss}\n:root {\n${themeProbeCss()}\n}`;

    expect(contrast(nocturneSource, foreground, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(probeSource, foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
