import "../../styles/global.css";
import { commands, page } from "@vitest/browser/context";
import { afterEach, beforeEach, expect } from "vitest";
import { applyAppLanguage } from "../../lib/i18n/runtime";

const FREEZE_STYLE_ID = "aethon-browser-freeze-style";
const FONT_READY_TIMEOUT_MS = 1500;
declare const __AETHON_BROWSER_SCREENSHOT_DIR__: string;

const SCREENSHOT_BASE_DIR = __AETHON_BROWSER_SCREENSHOT_DIR__;

function normalizeScreenshotName(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

expect.extend({
  async toMatchScreenshot(received: Element, name?: string) {
    const target = received instanceof Element ? page.elementLocator(received) : received;
    const screenshotName = normalizeScreenshotName(name ?? "unnamed-screenshot");
    const baselinePath = `${SCREENSHOT_BASE_DIR}/${screenshotName}.png`;
    const actualPath = `${SCREENSHOT_BASE_DIR}/${screenshotName}.actual.png`;

    const actual = await target.screenshot({ base64: true });

    let baselineBase64: string | null = null;
    try {
      baselineBase64 = await commands.readFile(baselinePath, "base64");
    } catch {
      baselineBase64 = null;
    }

    if (!baselineBase64) {
      await commands.writeFile(baselinePath, actual.base64, "base64");
      return {
        pass: true,
        message: () => `Created screenshot baseline at ${baselinePath}`,
      };
    }

    if (baselineBase64 === actual.base64) {
      return {
        pass: true,
        message: () => `Expected screenshot not to match baseline ${baselinePath}`,
      };
    }

    await commands.writeFile(actualPath, actual.base64, "base64");
    return {
      pass: false,
      message: () => [
        `Screenshot mismatch for ${screenshotName}.`,
        `Baseline: ${baselinePath}`,
        `Actual: ${actualPath}`,
      ].join("\n"),
    };
  },
});

beforeEach(async () => {
  applyAppLanguage("en");
  await page.viewport(1280, 800);

  document.documentElement.style.margin = "0";
  document.documentElement.style.width = "100%";
  document.documentElement.style.height = "100%";
  document.documentElement.style.colorScheme = "dark";
  document.documentElement.dataset.testReducedMotion = "true";
  document.body.style.margin = "0";
  document.body.style.width = "100%";
  document.body.style.minWidth = "1280px";
  document.body.style.height = "100%";
  document.body.style.minHeight = "800px";
  document.body.style.background = "#0f0f11";
  document.body.style.overflow = "hidden";

  if (!document.getElementById(FREEZE_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = FREEZE_STYLE_ID;
    style.textContent = `
      *,
      *::before,
      *::after {
        caret-color: transparent !important;
      }
      html[data-test-reduced-motion="true"] *,
      html[data-test-reduced-motion="true"] *::before,
      html[data-test-reduced-motion="true"] *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
        scroll-behavior: auto !important;
      }
    `;
    document.head.appendChild(style);
  }

  if ("fonts" in document) {
    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, FONT_READY_TIMEOUT_MS)),
    ]);
  }
});

afterEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-test-reduced-motion");
});
