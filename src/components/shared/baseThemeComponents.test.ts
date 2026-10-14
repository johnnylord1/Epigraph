import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Toaster from "../layout/Toaster.svelte";
import ContextMenu from "./ContextMenu.svelte";
import { addToast, dismissToast, LIBRARY_UPDATE_TOAST_ID, showProgressToast, store } from "../../store/state.svelte";

const MIGRATED_COMPONENT_FILES = [
  "src/components/layout/Toaster.svelte",
  "src/components/shared/ContextMenu.svelte",
] as const;

const DIRECT_COLOR_PATTERN = /#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/;
const NOCTURNE_TOAST_BG = [21, 20, 25] as const;

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

function blend(foreground: readonly number[], background: readonly number[], alpha: number) {
  return foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha));
}

function resetToastState() {
  for (const toast of store.toasts) {
    dismissToast(toast.id);
  }
  store.toasts = [];
  store.libraryUpdateInFlight = false;
}

describe("base themed components", () => {
  afterEach(() => {
    cleanup();
    resetToastState();
  });

  test("renders the tokenized toast shell", async () => {
    resetToastState();

    render(Toaster);
    addToast({
      id: "theme-contract-toast",
      kind: "success",
      title: "Saved",
      body: "Theme token contract",
      duration: 0,
    });

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByText("Theme token contract")).toBeTruthy();
    expect(document.querySelector(".toast-success")).toBeTruthy();
  });

  test("restarts the toast life bar when an existing toast is renewed", async () => {
    render(Toaster);
    addToast({
      id: "renewed-toast",
      kind: "info",
      title: "First state",
      duration: 3500,
    });

    expect(await screen.findByText("First state")).toBeTruthy();
    const firstLifeBar = document.querySelector(".toast-life");
    expect(firstLifeBar).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 2));
    addToast({
      id: "renewed-toast",
      kind: "info",
      title: "Renewed state",
      duration: 3500,
    });

    expect(await screen.findByText("Renewed state")).toBeTruthy();
    expect(document.querySelector(".toast-life")).not.toBe(firstLifeBar);
  });

  test("keeps toast actions and announcement roles explicit", async () => {
    const action = vi.fn();
    render(Toaster);
    addToast({
      id: "action-toast",
      kind: "info",
      title: "Update ready",
      body: "A restart is required.",
      action: { label: "Review", run: action },
      duration: 0,
    });
    addToast({
      id: "error-toast",
      kind: "error",
      title: "Update failed",
      duration: 0,
    });

    expect((await screen.findByRole("status")).textContent).toContain("Update ready");
    expect((await screen.findByRole("alert")).textContent).toContain("Update failed");
    expect(document.querySelector(".toast-with-actions .toast-actions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" }).getAttribute("type")).toBe("button");
  });

  test("keeps toast typography and color hierarchy on component tokens", () => {
    const source = readFileSync(join(process.cwd(), "src/components/layout/Toaster.svelte"), "utf8");

    expect(source).toContain("--component-toast-font");
    expect(source).toContain("--component-nocturne-state-compact-title-font-size");
    expect(source).toContain("--component-nocturne-state-body-fg");
    expect(source).toContain("--component-nocturne-state-action-bg");
    expect(source).toContain("--component-toast-success-fg");
    expect(source).toContain("--component-toast-error-fg");
    expect(source).toContain("--component-toast-info-fg");
    expect(source).toContain("--component-toast-download-fg");
    expect(source).toContain("state-border");
    expect(source).toContain("--component-nocturne-state-action-radius");
    expect(source).toContain("padding: 0 var(--space-sm)");
    expect(source).toContain("backdrop-filter: none");
  });

  test("matches the approved standardized toast frame contract", () => {
    const source = readFileSync(join(process.cwd(), "src/components/layout/Toaster.svelte"), "utf8");
    const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
    const nocturne = readFileSync(join(process.cwd(), "src/styles/nocturne-theme.css"), "utf8");

    expect(tokens).toMatch(/--component-toast-height:\s*88px;/);
    expect(nocturne).toMatch(/--component-toast-height:\s*88px;/);
    expect(source).toContain("height: var(--component-toast-height)");
    expect(source).toContain("padding: var(--component-nocturne-state-compact-padding)");
    expect(source).toContain(".toast::before");
    expect(source).toContain(".toast::after");
    expect(source).toContain("epigraph-glow-rotate");
    expect(source).toContain("toast-glow-pulse");
  });

  test("uses the approved regular semantic glyphs and keeps library progress inline", async () => {
    render(Toaster);
    addToast({
      id: "semantic-error-toast",
      kind: "error",
      title: "Error state",
      duration: 0,
    });
    addToast({
      id: "semantic-success-toast",
      kind: "success",
      title: "Success state",
      duration: 0,
    });
    store.libraryUpdateInFlight = true;
    showProgressToast(LIBRARY_UPDATE_TOAST_ID, {
      kind: "download",
      title: "Library update",
      body: "Checking titles 37/61 - 61% complete.",
      progress: { current: 37, total: 61, percent: 61 },
      actions: [{ label: "Stop", run: () => {} }],
    });

    expect(await screen.findByText("Error state")).toBeTruthy();
    expect(screen.getByText("Success state")).toBeTruthy();
    expect(screen.getByText("Checking titles 37/61 - 61% complete.")).toBeTruthy();

    const iconPaths = [...document.querySelectorAll(".toast-icon path")].map((path) => path.getAttribute("d"));
    expect(iconPaths).toContain("M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z");
    expect(iconPaths).toContain("M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,1,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z");
    expect(document.querySelector(".toast-progress-track")).toBeTruthy();
    expect(document.querySelector(".toast-progress-fill")?.getAttribute("style")).toContain("61%");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  test("keeps the toast lifetime indicator functional with reduced motion", () => {
    const source = readFileSync(join(process.cwd(), "src/components/layout/Toaster.svelte"), "utf8");
    const reducedMotionBlock = source.slice(source.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(reducedMotionBlock).not.toMatch(/\.toast-life[\s\S]*animation:\s*none/);
  });

  test("renders the tokenized context menu shell", () => {
    const onClose = vi.fn();
    const onOpen = vi.fn();
    const onDelete = vi.fn();

    render(ContextMenu, {
      props: {
        x: 20,
        y: 20,
        onClose,
        items: [
          { label: "Open", onClick: onOpen },
          { separator: true },
          { label: "Delete", onClick: onDelete, danger: true },
        ],
      },
    });

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  test("keeps migrated base components free of direct color functions", () => {
    for (const file of MIGRATED_COMPONENT_FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} should consume theme tokens instead of direct colors`).not.toMatch(DIRECT_COLOR_PATTERN);
    }
  });

  test("keeps Nocturne base component text colors at WCAG AA contrast", () => {
    const textPairs = {
      "toast title": [232, 228, 235],
      "toast body": blend([202, 196, 208], NOCTURNE_TOAST_BG, 0.62),
      "menu item": blend([202, 196, 208], NOCTURNE_TOAST_BG, 0.76),
      "menu hover": [232, 228, 235],
      "danger action": [255, 159, 159],
      "success toast": [201, 240, 207],
      "error toast": [240, 143, 155],
      "download toast": [216, 203, 255],
    };

    for (const [label, foreground] of Object.entries(textPairs)) {
      expect(
        contrastRatio(foreground, NOCTURNE_TOAST_BG),
        `${label} contrast should be at least 4.5:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
