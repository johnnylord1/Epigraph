import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  HUD_THEME_TOKEN_KEYS,
  THEME_MOTION_PROPERTY_KEYS,
  THEME_MOTION_VARS,
} from "./contract";
import {
  HUD_CONTRACT_ONLY_TOKEN_KEYS,
  HUD_LEGACY_TOKEN_KEYS,
  HUD_MASKED_FALLBACK_TOKEN_KEYS,
  HUD_PREVIEW_ONLY_TOKEN_KEYS,
  HUD_RUNTIME_ACTIVE_TOKEN_KEYS,
} from "./hudOwnership";

const ROOT = process.cwd();
const tokensCss = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
const nocturneCss = readFileSync(resolve(ROOT, "src/styles/nocturne-theme.css"), "utf8");
const libraryToolbar = readFileSync(
  resolve(ROOT, "src/components/library/LibraryToolbar.svelte"),
  "utf8",
);

describe("HUD and motion contract gate", () => {
  test("classifies every HUD authoring token by real runtime ownership", () => {
    expect([
      ...HUD_RUNTIME_ACTIVE_TOKEN_KEYS,
      ...HUD_MASKED_FALLBACK_TOKEN_KEYS,
      ...HUD_LEGACY_TOKEN_KEYS,
    ].sort()).toEqual(
      [...HUD_THEME_TOKEN_KEYS].sort(),
    );
    expect(HUD_RUNTIME_ACTIVE_TOKEN_KEYS).toHaveLength(3);
    expect(HUD_MASKED_FALLBACK_TOKEN_KEYS).toHaveLength(1);
    expect(HUD_PREVIEW_ONLY_TOKEN_KEYS).toHaveLength(9);
    expect(HUD_CONTRACT_ONLY_TOKEN_KEYS).toHaveLength(2);
    expect(HUD_LEGACY_TOKEN_KEYS).toHaveLength(11);
  });

  test("keeps every runtime-active HUD token connected to a production component alias", () => {
    expect(tokensCss).toContain("--component-reader-popover-radius: var(--hud-popover-radius);");
    expect(tokensCss).toContain("--component-reader-range-track-height: var(--hud-progress-height);");
    expect(nocturneCss).toContain("--component-toast-radius: var(--hud-toast-radius);");
  });

  test("keeps the icon size as a masked fallback without claiming direct ownership", () => {
    expect(libraryToolbar).toContain("var(--library-icon-btn-size, var(--hud-icon-button-size))");
    expect(readFileSync(resolve(ROOT, "src/components/library/LibraryShell.svelte"), "utf8")).toContain(
      "--library-icon-btn-size",
    );
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

  test("keeps the Reader animation shorthand valid after retiring Legacy motion aliases", () => {
    expect(`${tokensCss}\n${nocturneCss}`).not.toContain(
      "var(--t-slow) cubic-bezier(0.16, 1, 0.3, 1)",
    );
    expect(tokensCss).toContain(
      "--component-reader-core-resume-in-animation: var(--motion-duration-slow) cubic-bezier(0.16, 1, 0.3, 1) both;",
    );
    expect(nocturneCss).not.toMatch(/^\s*--n-(?:duration-fast|duration-normal|ease-spring)\s*:/m);
  });
});
