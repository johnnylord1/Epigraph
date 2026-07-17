import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
const EXCLUDED_THEME_FILES = new Set([
  "src/styles/tokens.css",
  "src/styles/builtin-themes.generated.css",
  "src/styles/nocturne-theme.css",
  "src/styles/nocturne-port.css",
]);
const DIRECT_VISUAL_PATTERN =
  /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|%(?:25)*23[0-9a-f]{3,8}\b/gi;

type AllowlistEntry = {
  count: number;
  status: "Active exception" | "Legacy" | "Excluded";
  reason: string;
};

const ALLOWLIST: Record<string, AllowlistEntry> = {
  "src/assets/aethon-icon-splash.svg": { count: 1, status: "Active exception", reason: "Brand asset." },
  "src/assets/aethon-icon-wordmark.svg": { count: 1, status: "Active exception", reason: "Brand asset." },
  "src/assets/aethon-icon.svg": { count: 2, status: "Active exception", reason: "Brand asset." },
  "src/components/novels/NovelSourceCheckModal.svelte": { count: 5, status: "Legacy", reason: "Quarantined specialized novel source surface." },
  "src/components/novels/NovelSourceStatusDetails.svelte": { count: 6, status: "Legacy", reason: "Quarantined specialized novel source surface." },
  "src/components/pages/BrowseV3.svelte": { count: 17, status: "Active exception", reason: "External provider branding and inline provider SVG assets." },
  "src/components/pages/Discover.svelte": { count: 6, status: "Legacy", reason: "Inactive pre-BrowseV3 route." },
  "src/components/pages/Extensions.svelte": { count: 21, status: "Legacy", reason: "Inactive route retained for compatibility." },
  "src/components/pages/NovelDetail.svelte": { count: 5, status: "Active exception", reason: "Standalone exported HTML document palette." },
  "src/components/pages/Tracking.svelte": { count: 2, status: "Legacy", reason: "Inactive tracking page retained for compatibility." },
  "src/lib/reader/prosePalette.ts": { count: 27, status: "Active exception", reason: "Independent user-selectable prose palettes and swatches." },
  "src/components/settings/ThemeEditor.svelte": { count: 3, status: "Active exception", reason: "Color-input normalization fallback." },
  "src/lib/assets/serviceIconResolver.ts": { count: 3, status: "Active exception", reason: "Generated fallback service asset." },
  "src/lib/splashBackground.ts": { count: 11, status: "Active exception", reason: "Canvas-rendered splash asset." },
  "src/lib/syncdQr.ts": { count: 2, status: "Excluded", reason: "Syncd QR asset is outside the current theme consolidation scope." },
  "src/lib/theme/contract.ts": { count: 262, status: "Active exception", reason: "Exact builtin authoring contracts and registry swatches." },
};

const MIGRATED_TOKEN_CONSUMERS: Record<string, string> = {
  "--component-app-fullscreen-exit-z-index": "src/App.svelte",
  "--component-app-fullscreen-exit-min-height": "src/App.svelte",
  "--component-app-fullscreen-exit-padding": "src/App.svelte",
  "--component-app-fullscreen-exit-radius": "src/App.svelte",
  "--component-app-fullscreen-exit-border": "src/App.svelte",
  "--component-app-fullscreen-exit-bg": "src/App.svelte",
  "--component-app-fullscreen-exit-fg": "src/App.svelte",
  "--component-app-fullscreen-exit-shadow": "src/App.svelte",
  "--component-app-fullscreen-exit-hover-border": "src/App.svelte",
  "--component-app-fullscreen-exit-hover-bg": "src/App.svelte",
  "--component-app-fullscreen-exit-hover-fg": "src/App.svelte",
  "--component-settings-color-picker-group-gap": "src/components/settings/Settings.svelte",
  "--component-settings-color-picker-size": "src/components/settings/Settings.svelte",
  "--component-settings-color-picker-border": "src/components/settings/Settings.svelte",
  "--component-settings-color-picker-bg": "src/components/settings/Settings.svelte",
  "--component-settings-color-picker-radius": "src/components/settings/Settings.svelte",
  "--component-library-card-progress-liquid-wave-bg": "src/components/library/LibraryCard.svelte",
  "--component-library-card-progress-liquid-wave-mask": "src/components/library/LibraryCard.svelte",
  "--component-reader-core-epub-link-fg": "src/components/reader/BookReader.svelte",
  "--component-tracking-record-select-indicator-bg": "src/components/shared/TrackingPanel.svelte",
};

function productionFiles(path: string): string[] {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) return child === "src/test" ? [] : productionFiles(child);
    if (!/\.(?:css|svelte|svg|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return EXCLUDED_THEME_FILES.has(child) ? [] : [child];
  });
}

function directVisualCount(path: string) {
  return Array.from(readFileSync(resolve(ROOT, path), "utf8").matchAll(DIRECT_VISUAL_PATTERN)).length;
}

describe("production direct visual value gate", () => {
  test("keeps every direct visual value on a precise documented allowlist", () => {
    const actual = new Map(
      productionFiles("src")
        .map((path) => [path, directVisualCount(path)] as const)
        .filter(([, count]) => count > 0),
    );
    const unclassified = [...actual.keys()].filter((path) => !ALLOWLIST[path]).sort();
    const drift = Object.entries(ALLOWLIST)
      .filter(([path, entry]) => actual.get(path) !== entry.count)
      .map(([path, entry]) => `${path}: expected ${entry.count}, found ${actual.get(path) ?? 0}`);

    expect(unclassified).toEqual([]);
    expect(drift).toEqual([]);
  });

  test("keeps the allowlist classified and justified", () => {
    expect(Object.entries(ALLOWLIST).filter(([, entry]) => !entry.reason.trim())).toEqual([]);
    expect(Object.entries(ALLOWLIST).filter(([, entry]) => !entry.status)).toEqual([]);
  });

  test("keeps active shell and embedded controls free of direct visual values", () => {
    const migratedFiles = [
      "src/App.svelte",
      "src/components/library/LibraryCard.svelte",
      "src/components/shared/TrackingPanel.svelte",
      "src/components/shared/NovelTrackingPanel.svelte",
    ];

    expect(migratedFiles.map((path) => [path, directVisualCount(path)])).toEqual(
      migratedFiles.map((path) => [path, 0]),
    );
  });

  test("defines and consumes every migrated embedded visual token", () => {
    const defaults = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
    const nocturne = readFileSync(resolve(ROOT, "src/styles/nocturne-theme.css"), "utf8");

    for (const [token, consumer] of Object.entries(MIGRATED_TOKEN_CONSUMERS)) {
      expect(defaults, `${token} default`).toMatch(new RegExp(`${token}\\s*:`));
      expect(nocturne, `${token} Nocturne`).toMatch(new RegExp(`${token}\\s*:`));
      expect(readFileSync(resolve(ROOT, consumer), "utf8"), `${token} consumer`).toContain(token);
    }
  });
});
