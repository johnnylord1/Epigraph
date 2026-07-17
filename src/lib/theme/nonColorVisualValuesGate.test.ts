import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const TOKEN_CONSUMERS: Record<string, string> = {
  "--component-app-keepalive-hidden-z-index": "src/components/layout/Layout.svelte",
  "--component-window-control-radius": "src/components/layout/TitleBar.svelte",
  "--component-toast-accent-radius": "src/components/layout/Toaster.svelte",
  "--component-toast-progress-radius": "src/components/layout/Toaster.svelte",
  "--component-toast-action-radius": "src/components/layout/Toaster.svelte",
  "--component-toast-close-radius": "src/components/layout/Toaster.svelte",
  "--component-library-card-shell-radius": "src/components/library/LibraryCard.svelte",
  "--component-library-card-progress-fill-radius": "src/components/library/LibraryCard.svelte",
  "--component-sources-novel-repo-action-radius": "src/components/pages/SourcesView.svelte",
  "--component-reader-slider-input-z-index": "src/components/reader/ReaderHud.svelte",
  "--component-reader-slider-checkpoint-z-index": "src/components/reader/ReaderHud.svelte",
  "--component-settings-step-button-radius": "src/components/settings/Settings.svelte",
  "--component-settings-select-button-radius": "src/components/settings/Settings.svelte",
  "--component-settings-select-menu-z-index": "src/components/settings/Settings.svelte",
  "--component-settings-mini-action-radius": "src/components/settings/Settings.svelte",
  "--component-settings-storage-overlay-z-index": "src/components/settings/Settings.svelte",
  "--component-settings-scrollbar-radius": "src/components/settings/Settings.svelte",
  "--component-menu-item-radius": "src/components/shared/ContextMenu.svelte",
  "--component-menu-icon-radius": "src/components/shared/ContextMenu.svelte",
};

function read(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("active non-color visual value gate", () => {
  test("defines and consumes every migrated radius and z-index token", () => {
    const defaults = read("src/styles/tokens.css");
    for (const [token, consumer] of Object.entries(TOKEN_CONSUMERS)) {
      expect(defaults, `${token} definition`).toMatch(new RegExp(`${token}\\s*:`));
      expect(read(consumer), `${token} consumer`).toContain(token);
    }
  });

  test("keeps the migrated active surfaces free of numeric radius, blur and z-index literals", () => {
    for (const path of new Set(Object.values(TOKEN_CONSUMERS))) {
      const source = read(path)
        .replaceAll("border-radius: inherit;", "")
        .replaceAll("border-radius: 0 0 inherit inherit;", "");
      expect(source, path).not.toMatch(/border-radius\s*:\s*-?\d|backdrop-filter\s*:\s*blur\(|\bz-index\s*:\s*-?\d/);
    }
  });
});
