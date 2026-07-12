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

function computedBackground(token: string) {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
}

describe("test-only theme probe", () => {
  test("changes every representative surface through primitive and semantic tokens", async () => {
    const root = document.documentElement;
    const nocturne = new Map(surfaceTokens.map((token) => [token, computedBackground(token)]));

    root.dataset.theme = "probe";
    for (const [name, value] of Object.entries({
      ...THEME_PROBE_TOKENS,
      ...THEME_PROBE_HUD_TOKENS,
    })) {
      root.style.setProperty(`--${name}`, value);
    }
    await new Promise(requestAnimationFrame);

    for (const token of surfaceTokens) {
      const value = computedBackground(token);
      expect(value, `${token} must resolve in the theme probe`).not.toBe("");
      expect(value, `${token} must not become transparent`).not.toBe("rgba(0, 0, 0, 0)");
      expect(value, `${token} must respond to the theme probe`).not.toBe(nocturne.get(token));
    }
  });
});
