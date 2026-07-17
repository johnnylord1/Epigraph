import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Toaster from "../layout/Toaster.svelte";
import ContextMenu from "./ContextMenu.svelte";
import { addToast, dismissToast, store } from "../../store/state.svelte";

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
  store.libraryUpdateProgress = null;
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
