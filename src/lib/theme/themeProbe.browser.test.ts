import { describe, expect, test } from "vitest";
import { THEME_PROBE_HUD_TOKENS, THEME_PROBE_TOKENS } from "../../test/themeProbe";
import {
  THEME_PRIMITIVE_TOKEN_KEYS,
  THEME_SEMANTIC_TOKEN_KEYS,
} from "./contract";
import {
  CUSTOM_THEME_STYLE_PROPERTIES,
  applyCustomTheme,
  clearCustomThemeProperties,
  getBuiltinExactThemePropertyNames,
} from "./provider";

const surfaceTokens = [
  "--component-menu-bg",
  "--component-sidebar-bg",
  "--component-settings-card-bg",
  "--component-syncd-card-bg",
  "--component-detail-layer-bg",
  "--component-home-card-bg",
  "--component-activity-center-bg",
  "--component-downloads-summary-bg",
  "--component-library-card-list-bg",
  "--component-browse-searchbar-background",
  "--component-sources-root-bg",
  "--component-reader-bg",
  "--component-migration-modal-bg",
  "--component-updater-status-bg",
] as const;

const nocturnePortTokens = [
  "--component-splash-ink-source",
  "--component-splash-danger-source",
  "--component-splash-background-base-source",
  "--component-splash-action-accent-source",
  "--component-soft-control-fg-source",
  "--component-chip-surface-source",
  "--component-settings-density-track-start-source",
  "--component-settings-density-step-source",
  "--component-settings-selection-start-source",
  "--component-settings-selection-ink-source",
  "--component-settings-preview-surface-top-source",
  "--component-settings-danger-soft-source",
  "--component-sources-metric-rating-star-source",
  "--component-sources-metric-recommendation-light-source",
  "--component-sources-metric-recommendation-ink-source",
  "--component-sources-metric-recommendation-dark-source",
] as const;

const probeProperties = Object.keys({
  ...THEME_PROBE_TOKENS,
  ...THEME_PROBE_HUD_TOKENS,
}).map((name) => `--${name}`);
const stateProperties = [...new Set([...probeProperties, ...CUSTOM_THEME_STYLE_PROPERTIES])];

function computedBackground(token: string) {
  const probe = document.createElement("div");
  probe.style.background = `var(${token})`;
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const value = `${style.backgroundColor}|${style.backgroundImage}`;
  probe.remove();
  return value;
}

function computedShadow(token: string) {
  const probe = document.createElement("div");
  probe.style.boxShadow = `var(${token})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).boxShadow;
  probe.remove();
  return value;
}

const transparentBackground = "rgba(0, 0, 0, 0)|none";

function computedToken(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function rememberRootState() {
  const root = document.documentElement;
  return {
    theme: root.getAttribute("data-theme"),
    customTheme: root.getAttribute("data-custom-theme"),
    inline: new Map(stateProperties.map((property) => [property, root.style.getPropertyValue(property)])),
  };
}

function restoreRootState(state: ReturnType<typeof rememberRootState>) {
  const root = document.documentElement;
  clearCustomThemeProperties(root);
  if (state.theme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", state.theme);
  if (state.customTheme === null) root.removeAttribute("data-custom-theme");
  else root.setAttribute("data-custom-theme", state.customTheme);
  for (const [property, value] of state.inline) {
    if (value) root.style.setProperty(property, value);
    else root.style.removeProperty(property);
  }
}

function applyProbeContract(customTheme = false) {
  const root = document.documentElement;
  root.dataset.theme = customTheme ? "nocturne" : "probe";
  if (customTheme) root.dataset.customTheme = "custom:probe";
  else root.removeAttribute("data-custom-theme");
  for (const [name, value] of Object.entries({
    ...THEME_PROBE_TOKENS,
    ...THEME_PROBE_HUD_TOKENS,
  })) {
    root.style.setProperty(`--${name}`, value);
  }
}

function builtinExactProperties(predicate: (property: string) => boolean): string[] {
  const selector = '[data-theme="nocturne"]:not([data-custom-theme])';
  const pending: CSSRule[] = Array.from(document.styleSheets).flatMap((sheet) => {
    try {
      return Array.from(sheet.cssRules);
    } catch {
      return [];
    }
  });

  while (pending.length > 0) {
    const rule = pending.shift()!;
    if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
      return Array.from(rule.style).filter(predicate);
    }
    if (hasNestedCssRules(rule)) pending.push(...Array.from(rule.cssRules));
  }
  return [];
}

function hasNestedCssRules(rule: CSSRule): rule is CSSRule & { readonly cssRules: CSSRuleList } {
  return "cssRules" in rule;
}

function builtinExactSourceNames(): string[] {
  return builtinExactProperties(
    (property) => property.startsWith("--color-") && property.endsWith("-source"),
  );
}

function builtinExactDerivedColorNames(): string[] {
  return builtinExactProperties(
    (property) => property.startsWith("--color-") && !property.endsWith("-source"),
  );
}

describe("test-only theme probe", () => {
  test("keeps an empty custom V5 computed-equivalent to its Nocturne base", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      clearCustomThemeProperties(root);
      root.dataset.theme = "nocturne";
      await new Promise(requestAnimationFrame);
      const exactProperties = getBuiltinExactThemePropertyNames(root);
      const builtinExact = new Map(exactProperties.map((token) => [token, computedToken(token)]));
      const builtinSurfaces = new Map(surfaceTokens.map((token) => [token, computedBackground(token)]));
      const builtinShadow = computedShadow("--component-card-shadow");
      const builtinRadius = computedToken("--component-toast-radius");

      expect(exactProperties).toHaveLength(256);
      expect(applyCustomTheme(root, {
        version: 5,
        id: "custom:empty-nocturne-browser",
        name: "Empty Nocturne browser",
        base: "nocturne",
        primitives: {},
        motion: "soft",
      })).toBe(true);
      await new Promise(requestAnimationFrame);

      expect(root.dataset.customTheme).toBe("custom:empty-nocturne-browser");
      for (const [token, value] of builtinExact) {
        expect(computedToken(token), token).toBe(value);
      }
      for (const [token, value] of builtinSurfaces) {
        expect(computedBackground(token), token).toBe(value);
      }
      expect(computedShadow("--component-card-shadow")).toBe(builtinShadow);
      expect(computedToken("--component-toast-radius")).toBe(builtinRadius);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("changes every representative surface through primitive and semantic tokens", async () => {
    const original = rememberRootState();
    const nocturne = new Map(surfaceTokens.map((token) => [token, computedBackground(token)]));

    try {
      applyProbeContract();
      await new Promise(requestAnimationFrame);

      for (const token of surfaceTokens) {
        const value = computedBackground(token);
        expect(value, `${token} must resolve in the theme probe`).not.toBe("");
        expect(value, `${token} must not become transparent`).not.toBe(transparentBackground);
        expect(value, `${token} must respond to the theme probe`).not.toBe(nocturne.get(token));
      }
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("changes every representative surface through the custom Nocturne V5 provider", async () => {
    const original = rememberRootState();

    try {
      const root = document.documentElement;
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const builtin = new Map(surfaceTokens.map((token) => [token, computedBackground(token)]));
      const builtinFocusShadow = computedShadow("--shadow-focus");
      const builtinToastRadius = computedToken("--component-toast-radius");
      const builtinMotion = new Map(
        ["--duration-fast", "--duration-normal", "--duration-slow", "--t-base"].map((token) => [
          token,
          computedToken(token),
        ]),
      );

      const themeDocument = {
        version: 5,
        id: "custom:probe-browser",
        name: "Browser probe",
        base: "nocturne",
        primitives: Object.fromEntries(
          THEME_PRIMITIVE_TOKEN_KEYS.map((name) => [name, THEME_PROBE_TOKENS[name]]),
        ),
        semanticOverrides: Object.fromEntries(
          THEME_SEMANTIC_TOKEN_KEYS.map((name) => [name, THEME_PROBE_TOKENS[name]]),
        ),
        hud: THEME_PROBE_HUD_TOKENS,
        motion: "minimal",
      } as const;
      expect(applyCustomTheme(root, themeDocument)).toBe(true);
      await new Promise(requestAnimationFrame);

      for (const token of surfaceTokens) {
        const value = computedBackground(token);
        expect(value, `${token} must resolve in a custom Nocturne-based theme`).not.toBe("");
        expect(value, `${token} must not become transparent`).not.toBe(transparentBackground);
        expect(value, `${token} must respond to the custom V5 contract`).not.toBe(builtin.get(token));
      }
      expect(computedToken("--component-toast-radius")).toBe(THEME_PROBE_HUD_TOKENS["hud-toast-radius"]);
      expect(computedToken("--component-toast-radius")).not.toBe(builtinToastRadius);
      expect(computedToken("--duration-fast")).toBe("40ms");
      expect(computedToken("--duration-normal")).toBe("80ms");
      expect(computedToken("--duration-slow")).toBe("140ms");
      expect(computedToken("--t-base")).toContain("80ms");
      for (const [token, value] of builtinMotion) expect(computedToken(token)).not.toBe(value);
      expect(computedShadow("--shadow-focus")).not.toBe(builtinFocusShadow);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("propagates primitive-only V5 overrides into semantic and component surfaces", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const builtinBackground = computedBackground("--component-card-bg");

      expect(applyCustomTheme(root, {
        version: 5,
        id: "custom:primitive-ownership",
        name: "Primitive ownership",
        base: "nocturne",
        primitives: {
          "bg-raised": THEME_PROBE_TOKENS["bg-raised"],
          accent: THEME_PROBE_TOKENS.accent,
        },
        motion: "soft",
      })).toBe(true);
      await new Promise(requestAnimationFrame);

      expect(computedToken("--color-card")).toBe(THEME_PROBE_TOKENS["bg-raised"]);
      expect(computedToken("--color-accent")).toBe(THEME_PROBE_TOKENS.accent);
      expect(computedBackground("--component-card-bg")).not.toBe(builtinBackground);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("derives shared elevation from source-only semantic overrides", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const builtin = new Map(
        ["--shadow-sm", "--shadow-md", "--shadow-lg", "--component-theme-editor-preview-popover-shadow"]
          .map((token) => [token, computedShadow(token)]),
      );
      const document = {
        version: 5,
        id: "custom:effect-source-probe",
        name: "Effect source probe",
        base: "nocturne",
        primitives: {},
        semanticOverrides: {
          "color-shadow-source": THEME_PROBE_TOKENS["color-shadow-source"],
          "color-highlight-source": THEME_PROBE_TOKENS["color-highlight-source"],
        },
        motion: "soft",
      } as const;

      expect(applyCustomTheme(root, document)).toBe(true);
      await new Promise(requestAnimationFrame);

      for (const [token, value] of builtin) {
        expect(computedShadow(token), `${token} should respond to source-only overrides`).not.toBe(value);
      }
      expect(computedToken("--color-shadow-source")).toBe(THEME_PROBE_TOKENS["color-shadow-source"]);
      expect(computedToken("--color-highlight-source")).toBe(THEME_PROBE_TOKENS["color-highlight-source"]);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("derives Nocturne port roles from a custom V5 contract", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const builtin = new Map(nocturnePortTokens.map((token) => [token, computedToken(token)]));

      applyProbeContract(true);
      await new Promise(requestAnimationFrame);

      for (const token of nocturnePortTokens) {
        const value = computedToken(token);
        expect(value, `${token} must resolve for a custom Nocturne-based theme`).not.toBe("");
        expect(value, `${token} must respond to the custom V5 contract`).not.toBe(builtin.get(token));
      }
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("derives every exact Nocturne source for custom V5 documents", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const sourceNames = builtinExactSourceNames();
      const builtin = new Map(sourceNames.map((token) => [token, computedToken(token)]));

      expect(sourceNames).toHaveLength(202);
      applyProbeContract(true);
      await new Promise(requestAnimationFrame);
      const custom = new Map(sourceNames.map((token) => [token, computedToken(token)]));

      root.dataset.theme = "probe";
      root.removeAttribute("data-custom-theme");
      await new Promise(requestAnimationFrame);

      const fallbackMismatches: string[] = [];
      for (const token of sourceNames) {
        const value = custom.get(token);
        expect(value, `${token} must resolve for a custom Nocturne-based theme`).not.toBe("");
        const fallback = computedToken(token);
        if (value !== fallback) fallbackMismatches.push(`${token}: ${value} != ${fallback}`);
      }
      expect(fallbackMismatches).toEqual([]);
      expect(
        sourceNames.filter((token) => custom.get(token) !== builtin.get(token)).length,
        "the custom V5 contract must materially change the exact Nocturne source palette",
      ).toBeGreaterThanOrEqual(201);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("derives every exact Nocturne semantic color for custom V5 documents", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const roleNames = builtinExactDerivedColorNames();
      const builtin = new Map(roleNames.map((token) => [token, computedToken(token)]));

      expect(roleNames).toHaveLength(54);
      applyProbeContract(true);
      await new Promise(requestAnimationFrame);
      const custom = new Map(roleNames.map((token) => [token, computedToken(token)]));

      root.dataset.theme = "probe";
      root.removeAttribute("data-custom-theme");
      await new Promise(requestAnimationFrame);
      const fallbackMismatches = roleNames
        .filter((token) => custom.get(token) !== computedToken(token))
        .map((token) => `${token}: ${custom.get(token)} != ${computedToken(token)}`);

      expect(fallbackMismatches).toEqual([]);
      expect(
        roleNames.filter((token) => custom.get(token) !== builtin.get(token)).length,
        "the custom V5 contract must materially change the exact Nocturne semantic palette",
      ).toBeGreaterThanOrEqual(50);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });
});
