import "../../styles/global.css";
import { commands, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, expect } from "vitest";
import { applyAppLanguage } from "../../lib/i18n/runtime";

const FREEZE_STYLE_ID = "epigraph-browser-freeze-style";
const FONT_READY_TIMEOUT_MS = 1500;
declare const __EPIGRAPH_BROWSER_SCREENSHOT_DIR__: string;
declare const __EPIGRAPH_BROWSER_ACTUAL_SCREENSHOT_DIR__: string;
declare const __EPIGRAPH_BROWSER_UPDATE_SCREENSHOTS__: boolean;

const SCREENSHOT_BASE_DIR = __EPIGRAPH_BROWSER_SCREENSHOT_DIR__;
const SCREENSHOT_ACTUAL_DIR = __EPIGRAPH_BROWSER_ACTUAL_SCREENSHOT_DIR__;
const MAX_SCREENSHOT_CHANNEL_DELTA = 1;
const MAX_SCREENSHOT_CHANGED_PIXEL_RATIO = 0.002;

async function decodePng(base64: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Could not create screenshot comparison canvas");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}

async function compareScreenshots(expectedBase64: string, actualBase64: string) {
  const [expected, actual] = await Promise.all([
    decodePng(expectedBase64),
    decodePng(actualBase64),
  ]);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { pass: false, changedRatio: 1, maxChannelDelta: 255 };
  }

  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < expected.pixels.length; index += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      pixelDelta = Math.max(
        pixelDelta,
        Math.abs(expected.pixels[index + channel] - actual.pixels[index + channel]),
      );
    }
    if (pixelDelta > 0) changedPixels += 1;
    maxChannelDelta = Math.max(maxChannelDelta, pixelDelta);
  }

  const pixelCount = expected.width * expected.height;
  const changedRatio = changedPixels / pixelCount;
  return {
    pass:
      maxChannelDelta <= MAX_SCREENSHOT_CHANNEL_DELTA &&
      changedRatio <= MAX_SCREENSHOT_CHANGED_PIXEL_RATIO,
    changedRatio,
    maxChannelDelta,
  };
}

function normalizeScreenshotName(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

expect.extend({
  async toMatchEpigraphScreenshot(received: Element, name?: string) {
    if (!(received instanceof Element)) throw new Error("Screenshot target must be an Element");
    const screenshotName = normalizeScreenshotName(name ?? "unnamed-screenshot");
    const baselinePath = `${SCREENSHOT_BASE_DIR}/${screenshotName}.png`;
    const actualPath = `${SCREENSHOT_ACTUAL_DIR}/${screenshotName}.actual.png`;

    // Browser files run sequentially in one page, so a pointer left over by an earlier file
    // would paint hover states into this capture. Park it on the page corner first.
    await userEvent.unhover(document.body, { position: { x: 0, y: 0 }, force: true });
    const actual = await page.screenshot({ base64: true });

    let baselineBase64: string | null = null;
    try {
      baselineBase64 = await commands.readFile(baselinePath, "base64");
    } catch {
      baselineBase64 = null;
    }

    if (!baselineBase64) {
      if (__EPIGRAPH_BROWSER_UPDATE_SCREENSHOTS__) {
        await commands.writeFile(baselinePath, actual.base64, "base64");
        return {
          pass: true,
          message: () => `Created screenshot baseline at ${baselinePath}`,
        };
      }
      await commands.writeFile(actualPath, actual.base64, "base64");
      return {
        pass: false,
        message: () => `Missing reviewed screenshot baseline: ${baselinePath}. Actual: ${actualPath}`,
      };
    }

    const comparison = await compareScreenshots(baselineBase64, actual.base64);
    if (comparison.pass) {
      return {
        pass: true,
        message: () => `Expected screenshot not to match baseline ${baselinePath}`,
      };
    }

    if (__EPIGRAPH_BROWSER_UPDATE_SCREENSHOTS__) {
      await commands.writeFile(baselinePath, actual.base64, "base64");
      return {
        pass: true,
        message: () => `Updated screenshot baseline at ${baselinePath}`,
      };
    }

    await commands.writeFile(actualPath, actual.base64, "base64");
    return {
      pass: false,
      message: () => [
        `Screenshot mismatch for ${screenshotName}.`,
        `Changed pixels: ${(comparison.changedRatio * 100).toFixed(4)}%.`,
        `Maximum channel delta: ${comparison.maxChannelDelta}.`,
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
  document.documentElement.dataset.theme = "nocturne";
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
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("data-test-reduced-motion");
});
