import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import TasteInsightsModal from "./TasteInsightsModal.svelte";
import { resolveCssColor, type RgbaColor } from "../../test/themeColor";

const ROOT = process.cwd();
const NATIVE_ANIMATE = Element.prototype.animate;
const COMPONENT_PATH = "src/components/pages/TasteInsightsModal.svelte";
const TOKEN_PATTERN = /--component-taste-insights-[A-Za-z0-9_-]+/g;
const TOKEN_DEFINITION_PATTERN = /--component-taste-insights-[A-Za-z0-9_-]+(?=\s*:)/g;
const STYLE_BLOCK_PATTERN = /<style[^>]*>([\s\S]*?)<\/style>/g;
const DIRECT_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|(?:radial|linear|conic)-gradient\(|--n-|var\(--accent/;
const VISUAL_PROPERTY_PATTERN = /^\s*(box-shadow|backdrop-filter|border-radius|z-index|opacity|filter|transition|transform)\s*:\s*([^;]+);/gm;

function readProjectFile(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function uniqueMatches(source: string, pattern: RegExp) {
  return Array.from(new Set(source.match(pattern) ?? [])).sort();
}

function contrastOver(color: RgbaColor, background: [number, number, number]) {
  const foreground = background.map(
    (channel, index) => color[index] * color[3] + channel * (1 - color[3]),
  );
  const luminance = (channels: number[]) => {
    const values = channels.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  };
  return (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
}

describe("Taste Insights theme tokens", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: NATIVE_ANIMATE,
    });
  });

  it("defines and consumes the complete Taste Insights token contract", () => {
    const component = readProjectFile(COMPONENT_PATH);
    const defaults = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const consumed = uniqueMatches(component, TOKEN_PATTERN);

    expect(consumed).toHaveLength(51);
    expect(uniqueMatches(defaults, TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
    expect(uniqueMatches(nocturne, TOKEN_DEFINITION_PATTERN)).toEqual(consumed);
  });

  it("keeps component styles free of direct theme values and Nocturne internals", () => {
    const component = readProjectFile(COMPONENT_PATH);
    const styles = Array.from(component.matchAll(STYLE_BLOCK_PATTERN), (match) => match[1] ?? "");

    expect(styles).toHaveLength(1);
    expect(component.match(DIRECT_COLOR_PATTERN)).toBeNull();
    for (const match of styles[0].matchAll(VISUAL_PROPERTY_PATTERN)) {
      expect(match[2].trim().startsWith("var("), `${match[1]} uses ${match[2].trim()}`).toBe(true);
    }
  });

  it("keeps Nocturne supporting text at WCAG AA contrast", () => {
    const defaults = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const ratio = contrastOver(
      resolveCssColor(`${defaults}\n${nocturne}`, "--component-taste-insights-muted-fg"),
      [27, 25, 36],
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("remains an active Browse-owned modal with only dynamic metric widths inline", () => {
    const browse = readProjectFile("src/components/pages/BrowseV3.svelte");
    const component = readProjectFile(COMPONENT_PATH);

    expect(browse).toContain('import TasteInsightsModal from "./TasteInsightsModal.svelte"');
    expect(browse).toContain("<TasteInsightsModal");
    expect(component).toContain('style="width: {Math.min(100, Math.abs(tag.weight) * 60)}%"');
    expect(component).toContain('style="width: {Math.max(0, fmt.weight)}%"');
  });

  it("isolates the background, traps focus, closes with Escape, and restores focus", async () => {
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      value: () => {
        let finish: Animation["onfinish"] = null;
        return {
          cancel: vi.fn(),
          currentTime: 0,
          effect: null,
          playState: "finished",
          get onfinish() {
            return finish;
          },
          set onfinish(callback) {
            finish = callback;
            if (callback) queueMicrotask(() => callback.call(this, new Event("finish") as AnimationPlaybackEvent));
          },
        } as unknown as Animation;
      },
    });
    const outside = document.createElement("button");
    outside.textContent = "Open insights";
    document.body.append(outside);
    outside.focus();
    const onClose = vi.fn();
    const view = render(TasteInsightsModal, {
      props: {
        profile: {
          tagWeights: new Map([["Action", 1]]),
          contentTypeWeights: new Map([["manga", 1]]),
          sourceWeights: new Map(),
          topTags: ["Action"],
          positiveTags: ["Action"],
          negativeTags: [],
          seedCount: 1,
        },
        items: [],
        contentType: "manga",
        onClose,
      },
    });

    await new Promise((resolve) => window.setTimeout(resolve));
    const dialog = screen.getByRole("dialog", { name: "Taste Insights & Analytics" });
    const close = screen.getByRole("button", { name: "Close Insights" });
    const actions = screen.getAllByRole("button");
    const last = actions[actions.length - 1];

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(outside.inert).toBe(true);
    expect(document.activeElement).toBe(close);

    last.focus();
    await fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    close.focus();
    await fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    await fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(outside.inert).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
