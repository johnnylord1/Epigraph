import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_MOTION_VARS,
} from "./contract";

const ROOT = process.cwd();
const tokensCss = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
const nocturneCss = readFileSync(resolve(ROOT, "src/styles/nocturne-theme.css"), "utf8");
const libraryToolbar = readFileSync(
  resolve(ROOT, "src/components/library/LibraryToolbar.svelte"),
  "utf8",
);

const activeHudTokens = [
  "hud-icon-button-size",
  "hud-popover-radius",
  "hud-toast-radius",
  "hud-progress-height",
] as const;

const authoringLegacyHudTokens = [
  "hud-control-height",
  "hud-control-radius",
  "hud-chip-radius",
  "hud-status-radius",
  "hud-chapter-row-radius",
  "hud-surface-opacity",
  "hud-sidebar-width",
  "hud-toolbar-gap",
  "hud-reader-chrome-opacity",
  "hud-selection-bg",
  "hud-selection-border",
] as const;

describe("HUD and motion contract gate", () => {
  test("classifies every HUD authoring token without removing Legacy fields", () => {
    expect([...activeHudTokens, ...authoringLegacyHudTokens].sort()).toEqual(
      [...HUD_THEME_TOKEN_KEYS].sort(),
    );
    expect(activeHudTokens).toHaveLength(4);
    expect(authoringLegacyHudTokens).toHaveLength(11);
  });

  test("keeps every active HUD token connected to a production component alias", () => {
    expect(tokensCss).toContain("--component-reader-popover-radius: var(--hud-popover-radius);");
    expect(tokensCss).toContain("--component-reader-range-track-height: var(--hud-progress-height);");
    expect(libraryToolbar).toContain("var(--library-icon-btn-size, var(--hud-icon-button-size))");
    expect(nocturneCss).toContain("--component-toast-radius: var(--hud-toast-radius);");
  });

  test("derives both transition families from the structured motion roots", () => {
    expect(tokensCss).toContain("--t-fast: var(--motion-duration-fast) var(--motion-easing-standard);");
    expect(tokensCss).toContain("--t-base: var(--motion-duration-normal) var(--motion-easing-standard);");
    expect(tokensCss).toContain("--t-slow: var(--motion-duration-slow) var(--motion-easing-standard);");
    expect(tokensCss).toContain("--duration-fast: var(--motion-duration-fast);");
    expect(tokensCss).toContain("--duration-normal: var(--motion-duration-normal);");
    expect(tokensCss).toContain("--duration-slow: var(--motion-duration-slow);");
    expect(tokensCss).toContain("--easing-standard: var(--motion-easing-standard);");
    expect(tokensCss).toContain("--easing-emphasized: var(--motion-easing-emphasized);");
  });

  test("keeps every motion preset synchronized with the provider allowlist", () => {
    for (const preset of Object.values(THEME_MOTION_VARS)) {
      expect(Object.keys(preset)).toEqual([...THEME_MOTION_PROPERTY_KEYS]);
    }
  });

  test("keeps the Reader animation shorthand valid and preserves Legacy port motion", () => {
    expect(`${tokensCss}\n${nocturneCss}`).not.toContain(
      "var(--t-slow) cubic-bezier(0.16, 1, 0.3, 1)",
    );
    expect(tokensCss).toContain(
      "--component-reader-core-resume-in-animation: var(--motion-duration-slow) cubic-bezier(0.16, 1, 0.3, 1) both;",
    );
    expect(nocturneCss).toContain("--n-duration-fast: 140ms;");
    expect(nocturneCss).toContain("--n-duration-normal: 200ms;");
    expect(nocturneCss).toContain("--n-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);");
  });
});
