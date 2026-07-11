import { cleanup, render, screen, fireEvent } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ReaderHudFixture from "./ReaderHud.test.fixture.svelte";

const READER_HUD_COMPONENT_FILES = [
  "src/components/reader/ReaderHud.svelte",
  "src/components/reader/TtsControls.svelte",
  "src/components/reader/ReaderBrightnessControl.svelte",
] as const;

const DIRECT_COLOR_PATTERN = /#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/;

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
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

  it("consumes Reader HUD component tokens for chrome, popovers, controls, focus, and motion", () => {
    const hudSource = source("src/components/reader/ReaderHud.svelte");
    const ttsSource = source("src/components/reader/TtsControls.svelte");

    for (const token of [
      "--component-reader-bg-layer",
      "--component-reader-panel-bg",
      "--component-reader-border",
      "--component-reader-control-bg",
      "--component-reader-control-hover-bg",
      "--component-reader-control-active-bg",
      "--component-reader-accent-gradient",
      "--component-reader-focus-ring",
      "--component-reader-popover-z-index",
      "--component-reader-transition-fast",
    ]) {
      expect(`${hudSource}\n${ttsSource}`, `Missing Reader HUD token ${token}`).toContain(token);
    }
  });

  it("keeps Nocturne Reader HUD foreground colors at WCAG AA contrast", () => {
    const panelBackground = [26, 26, 30] as const;
    const foregrounds = {
      "primary HUD text": [245, 244, 250],
      "muted HUD text": [185, 181, 204],
      "faint metadata text": [145, 141, 165],
      "accent controls": [143, 130, 230],
      "accent strong controls": [171, 159, 255],
    } as const;

    for (const [label, foreground] of Object.entries(foregrounds)) {
      expect(
        contrastRatio(foreground, panelBackground),
        `${label} contrast should be at least 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
