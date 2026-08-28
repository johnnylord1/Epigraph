import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Sidebar from "./Sidebar.svelte";
import TitleBar from "./TitleBar.svelte";
import WindowControlsInline from "./WindowControlsInline.svelte";
import ActivityButton from "./ActivityButton.svelte";
import { store } from "../../store/state.svelte";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    startDragging: vi.fn(async () => {}),
  })),
}));

const DIRECT_COLOR_PATTERN = /#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(/;
const MIGRATED_LAYOUT_FILES = [
  "src/components/layout/Layout.svelte",
  "src/components/layout/ActivityButton.svelte",
  "src/components/layout/ActivityOverlay.svelte",
  "src/components/layout/TitleBar.svelte",
  "src/components/layout/WindowControlsInline.svelte",
] as const;

function readRepoFile(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function layoutCssShellBlock() {
  const source = readRepoFile("src/styles/nocturne-port.css");
  const start = source.indexOf(".epigraph-app-shell");
  const end = source.indexOf(".n-btn {", start);
  if (start < 0 || end < 0) throw new Error("Could not locate layout shell CSS block");
  return source.slice(start, end);
}

describe("layout theme components", () => {
  beforeEach(() => {
    store.navPage = "library";
    store.activeDownloads = [];
    store.libraryUpdateNotifications = [];
    store.libraryUpdateIssues = [];
    store.systemNotifications = [];
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the tokenized sidebar navigation", () => {
    render(Sidebar);

    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Library" })).toBeTruthy();
    expect(document.querySelector(".n-sidebar-btn.is-active")).toBeTruthy();
  });

  test("renders the tokenized window controls", () => {
    render(TitleBar);
    render(WindowControlsInline);

    expect(screen.getAllByRole("button", { name: "Minimize" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("button", { name: "Maximize" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThanOrEqual(2);
  });

  test("renders the tokenized activity toolbar badge", () => {
    store.history = [{
      mangaId: 1,
      mangaTitle: "Token Audit",
      chapterId: 1,
      chapterName: "Chapter 1",
      thumbnailUrl: "",
      readAt: Date.now(),
    }];

    render(ActivityButton);

    expect(screen.getByRole("button", { name: "Recent activity, 1 new" })).toBeTruthy();
    expect(document.querySelector(".activity-badge")).toBeTruthy();
  });

  test("keeps migrated layout components free of direct color functions", () => {
    for (const file of MIGRATED_LAYOUT_FILES) {
      expect(readRepoFile(file), `${file} should use layout tokens instead of direct colors`).not.toMatch(DIRECT_COLOR_PATTERN);
    }
  });

  test("keeps the global layout shell CSS block free of direct color functions", () => {
    expect(layoutCssShellBlock()).not.toMatch(DIRECT_COLOR_PATTERN);
  });

  test("keeps the global search dim below modal surfaces", () => {
    const shell = layoutCssShellBlock();
    const tokens = readRepoFile("src/styles/tokens.css");

    expect(shell).toMatch(/\.epigraph-search-dim-layer\s*\{[^}]*z-index:\s*var\(--z-popover\);/s);
    expect(tokens).toMatch(/--z-popover:\s*(\d+);/);
    expect(tokens).toMatch(/--z-modal:\s*(\d+);/);

    const popoverZ = Number(tokens.match(/--z-popover:\s*(\d+);/)?.[1]);
    const modalZ = Number(tokens.match(/--z-modal:\s*(\d+);/)?.[1]);
    expect(popoverZ).toBeLessThan(modalZ);
  });
});
