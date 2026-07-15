import { describe, expect, test } from "vitest";
import { THEME_PROBE_HUD_TOKENS, THEME_PROBE_TOKENS } from "../../test/themeProbe";

const surfaceTokens = [
  "--component-card-bg",
  "--component-sidebar-bg",
  "--component-settings-card-bg",
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

function computedBackground(token: string) {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
}

function computedToken(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function rememberRootState() {
  const root = document.documentElement;
  return {
    theme: root.getAttribute("data-theme"),
    customTheme: root.getAttribute("data-custom-theme"),
    inline: new Map(probeProperties.map((property) => [property, root.style.getPropertyValue(property)])),
  };
}

function restoreRootState(state: ReturnType<typeof rememberRootState>) {
  const root = document.documentElement;
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
  const pending = Array.from(document.styleSheets).flatMap((sheet) => {
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
    if ("cssRules" in rule) pending.push(...Array.from(rule.cssRules));
  }
  return [];
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
  test("changes every representative surface through primitive and semantic tokens", async () => {
    const original = rememberRootState();
    const nocturne = new Map(surfaceTokens.map((token) => [token, computedBackground(token)]));

    try {
      applyProbeContract();
      await new Promise(requestAnimationFrame);

      for (const token of surfaceTokens) {
        const value = computedBackground(token);
        expect(value, `${token} must resolve in the theme probe`).not.toBe("");
        expect(value, `${token} must not become transparent`).not.toBe("rgba(0, 0, 0, 0)");
        expect(value, `${token} must respond to the theme probe`).not.toBe(nocturne.get(token));
      }
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("derives Nocturne port roles from a custom V4 contract", async () => {
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
        expect(value, `${token} must respond to the custom V4 contract`).not.toBe(builtin.get(token));
      }
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("derives every exact Nocturne source for custom V4 documents", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const sourceNames = builtinExactSourceNames();
      const builtin = new Map(sourceNames.map((token) => [token, computedToken(token)]));

      expect(sourceNames).toHaveLength(232);
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
        "the custom V4 contract must materially change the exact Nocturne source palette",
      ).toBeGreaterThanOrEqual(220);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });

  test("derives every exact Nocturne semantic color for custom V4 documents", async () => {
    const root = document.documentElement;
    const original = rememberRootState();

    try {
      root.dataset.theme = "nocturne";
      root.removeAttribute("data-custom-theme");
      for (const property of probeProperties) root.style.removeProperty(property);
      await new Promise(requestAnimationFrame);
      const roleNames = builtinExactDerivedColorNames();
      const builtin = new Map(roleNames.map((token) => [token, computedToken(token)]));

      expect(roleNames).toHaveLength(57);
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
        "the custom V4 contract must materially change the exact Nocturne semantic palette",
      ).toBeGreaterThanOrEqual(50);
    } finally {
      restoreRootState(original);
      await new Promise(requestAnimationFrame);
    }
  });
});
