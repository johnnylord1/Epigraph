import { cleanup, render, screen, fireEvent } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCssColor } from "../../test/themeColor";
import ReaderHudFixture from "./ReaderHud.test.fixture.svelte";

const READER_HUD_COMPONENT_FILES = [
  "src/components/reader/ReaderHud.svelte",
  "src/components/reader/TtsControls.svelte",
  "src/components/reader/ReaderBrightnessControl.svelte",
] as const;

const DIRECT_COLOR_PATTERN = /#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/;
const READER_HUD_TOKEN_PATTERN = /--component-reader-(?!core-)[A-Za-z0-9_-]+/g;
const READER_HUD_TOKEN_DEFINITION_PATTERN = /--component-reader-(?!core-)[A-Za-z0-9_-]+(?=\s*:)/g;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function uniqueMatches(value: string, pattern: RegExp) {
  return Array.from(new Set(value.match(pattern) ?? [])).sort();
}

function relativeLuminance([red, green, blue]: readonly number[]) {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(left: readonly number[], right: readonly number[]) {
  const leftLum = relativeLuminance(left);
  const rightLum = relativeLuminance(right);
  const lighter = Math.max(leftLum, rightLum);
  const darker = Math.min(leftLum, rightLum);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("ReaderHud", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the same HUD chrome with comics adapter content", () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "comics",
      },
    });

    expect(container.querySelector(".series-title")?.textContent).toBe("comics title");
    expect(container.querySelector(".chapter-title")?.textContent).toBe("comics chapter");
    expect(screen.getByText("comics progress")).not.toBeNull();
    expect(container.querySelector(".reader-capsule-bar")).not.toBeNull();
  });

  it("renders the same HUD chrome with books adapter content", () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
      },
    });

    expect(container.querySelector(".series-title")?.textContent).toBe("books title");
    expect(container.querySelector(".chapter-title")?.textContent).toBe("books chapter");
    expect(screen.getByText("books progress")).not.toBeNull();
  });

  it("hides HUD chrome overlay without unmounting adapter content", () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: false,
      },
    });

    expect(container.querySelector(".reader-hud-overlay")?.classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("hud-content").textContent).toBe("books content");
  });

  it("toggles settings popover on cog click", async () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: true,
      },
    });

    // Popover is initially closed
    expect(screen.queryByTestId("hud-settings-popover")).toBeNull();

    // Click settings button (cog button is the one with title "Settings")
    const settingsBtn = container.querySelector('button[title="Settings"]');
    expect(settingsBtn).not.toBeNull();
    if (settingsBtn) {
      await fireEvent.click(settingsBtn);
      expect(screen.getByTestId("hud-settings-popover")).not.toBeNull();
    }
  });

  it("toggles HUD chrome when the reading viewport is clicked", async () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: false,
      },
    });

    const overlay = container.querySelector(".reader-hud-overlay");
    const content = screen.getByTestId("hud-content");
    expect(overlay?.classList.contains("hidden")).toBe(true);

    await fireEvent.click(content);
    expect(overlay?.classList.contains("hidden")).toBe(false);

    await fireEvent.click(content);
    expect(overlay?.classList.contains("hidden")).toBe(true);
  });

  it("does not toggle HUD chrome when an interactive control is clicked", async () => {
    const { container } = render(ReaderHudFixture, {
      props: {
        domain: "books",
        uiVisible: true,
      },
    });

    const overlay = container.querySelector(".reader-hud-overlay");
    const settingsBtn = container.querySelector('button[title="Settings"]');
    expect(settingsBtn).not.toBeNull();

    if (settingsBtn) {
      await fireEvent.click(settingsBtn);
      expect(overlay?.classList.contains("hidden")).toBe(false);
      expect(screen.getByTestId("hud-settings-popover")).not.toBeNull();
    }
  });

  it("keeps Reader HUD visual components free of direct color functions", () => {
    for (const file of READER_HUD_COMPONENT_FILES) {
      expect(source(file), `${file} should consume Reader HUD tokens instead of direct colors`).not.toMatch(DIRECT_COLOR_PATTERN);
    }
  });

  it("defines and consumes the complete Reader HUD token inventory", () => {
    const componentSource = READER_HUD_COMPONENT_FILES.map(source).join("\n");
    const defaultTokens = source("src/styles/tokens.css");
    const nocturneTokens = source("src/styles/nocturne-theme.css");
    const consumed = uniqueMatches(componentSource, READER_HUD_TOKEN_PATTERN);
    const defaultDefined = uniqueMatches(defaultTokens, READER_HUD_TOKEN_DEFINITION_PATTERN);
    const nocturneDefined = uniqueMatches(nocturneTokens, READER_HUD_TOKEN_DEFINITION_PATTERN);

    expect(consumed).toHaveLength(52);
    expect(defaultDefined).toEqual(consumed);
    expect(nocturneDefined).toHaveLength(29);
    expect(nocturneDefined.filter((token) => !consumed.includes(token))).toEqual([]);
  });

  it("keeps Nocturne Reader HUD foreground colors at WCAG AA contrast", () => {
    const themeSource = `${source("src/styles/tokens.css")}\n${source("src/styles/nocturne-theme.css")}`;
    const panelBackground = resolveCssColor(themeSource, "--component-reader-panel-bg");
    const foregrounds = {
      "primary HUD text": "--component-reader-fg",
      "muted HUD text": "--component-reader-muted-fg",
      "faint metadata text": "--component-reader-faint-fg",
      "accent controls": "--component-reader-accent-fg",
      "accent strong controls": "--component-reader-accent-strong-fg",
    } as const;

    for (const [label, token] of Object.entries(foregrounds)) {
      const foreground = resolveCssColor(themeSource, token);
      expect(
        contrastRatio(foreground, panelBackground),
        `${label} contrast should be at least 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
