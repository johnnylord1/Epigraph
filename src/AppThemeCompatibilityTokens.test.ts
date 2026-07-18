import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const APP_LOADING_TOKEN = "--component-app-loading-fg";
const APP_FULLSCREEN_TOKENS = [
  "--component-app-fullscreen-exit-z-index",
  "--component-app-fullscreen-exit-min-height",
  "--component-app-fullscreen-exit-padding",
  "--component-app-fullscreen-exit-radius",
  "--component-app-fullscreen-exit-border",
  "--component-app-fullscreen-exit-bg",
  "--component-app-fullscreen-exit-fg",
  "--component-app-fullscreen-exit-shadow",
  "--component-app-fullscreen-exit-hover-border",
  "--component-app-fullscreen-exit-hover-bg",
  "--component-app-fullscreen-exit-hover-fg",
] as const;
const LEGACY_NOCTURNE_TOKENS = [
  "--n-bg",
  "--n-bg-top",
  "--n-gradient-bg",
  "--n-line",
  "--n-line-strong",
  "--n-on-primary-container",
  "--n-outline-variant",
  "--n-popover-control-bg",
  "--n-popover-control-border",
  "--n-surface-container",
  "--n-surface-container-low",
];
const REMOVED_ACTIVITY_TOKENS = [
  "--activity-panel",
  "--activity-panel-soft",
  "--activity-line",
  "--activity-line-soft",
  "--activity-text",
  "--activity-title",
  "--activity-muted",
  "--activity-subtle",
  "--activity-faint",
  "--activity-accent",
  "--activity-accent-soft",
  "--activity-accent-line",
  "--activity-danger",
];
const REMOVED_LEGACY_SURFACES = [
  "src/components/pages/Discover.svelte",
  "src/components/pages/Extensions.svelte",
  "src/components/shared/SourceBrowse.svelte",
  "src/components/shared/SourceList.svelte",
  "src/components/pages/NovelSources.svelte",
  "src/components/novels/NovelSourceCheckModal.svelte",
  "src/components/novels/NovelSourceStatusDetails.svelte",
  "src/components/settings/NovelRepositoriesPanel.svelte",
  "src/components/library/NovelsLibraryBody.svelte",
  "src/components/pages/Tracking.svelte",
  "src/components/pages/GenreDrillPage.svelte",
  "src/routes.ts",
] as const;

function readProjectFile(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function sourceCorpus(path: string): string {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return sourceCorpus(child);
      if (!/\.(?:css|svelte|ts)$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
      return readProjectFile(child);
    })
    .join("\n");
}

function rustCorpus(path: string): string {
  return readdirSync(resolve(ROOT, path), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return rustCorpus(child);
      return entry.name.endsWith(".rs") ? [readProjectFile(child)] : [];
    })
    .join("\n");
}

function withoutDefinitions(source: string, token: string): string {
  return source.replace(new RegExp(`${token}\\s*:[^;]+;`, "g"), "");
}

describe("App theme compatibility contract", () => {
  it("defines and consumes the active loading token", () => {
    const app = readProjectFile("src/App.svelte");
    const tokens = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");

    expect(app).toContain(`color: var(${APP_LOADING_TOKEN})`);
    expect(tokens).toMatch(new RegExp(`${APP_LOADING_TOKEN}\\s*:`));
    expect(nocturne).toMatch(new RegExp(`${APP_LOADING_TOKEN}\\s*:`));
    expect(app).not.toContain("--n-text-muted");
  });

  it("defines and consumes the fullscreen exit visual contract", () => {
    const app = readProjectFile("src/App.svelte");
    const tokens = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");

    for (const token of APP_FULLSCREEN_TOKENS) {
      expect(app, token).toContain(`var(${token})`);
      expect(tokens, token).toMatch(new RegExp(`${token}\\s*:`));
      expect(nocturne, token).toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it("publishes HUD scale only through the canonical runtime token", () => {
    const app = readProjectFile("src/App.svelte");

    expect(app).toContain('style.setProperty("--hud-scale", hudScale)');
    expect(app).not.toContain('style.setProperty("--n-hud-scale", hudScale)');
  });

  it("normalizes app theme application through the canonical registry", () => {
    const app = readProjectFile("src/App.svelte");

    expect(app).toContain('import { DEFAULT_BUILTIN_THEME_ID, normalizeThemeSelection } from "./lib/theme/contract"');
    expect(app).toContain("normalizeThemeSelection(store.settings.theme, store.settings.customThemes ?? [])");
    expect(app).toContain('root.setAttribute("data-theme", DEFAULT_BUILTIN_THEME_ID)');
    expect(app).not.toContain('store.settings.theme ?? "dark"');
    expect(app).not.toContain('root.setAttribute("data-theme", "dark")');
  });

  it("keeps removed Legacy surfaces absent from the active source tree", () => {
    const activeShell = [
      "src/main.ts",
      "src/App.svelte",
      "src/components/layout/Layout.svelte",
      "src/components/pages/Search.svelte",
      "src/components/settings/Settings.svelte",
      "src/components/pages/Library.svelte",
    ].map(readProjectFile).join("\n");

    for (const path of REMOVED_LEGACY_SURFACES) {
      expect(existsSync(resolve(ROOT, path)), path).toBe(false);
      expect(activeShell, path.split("/").at(-1)).not.toContain(path.split("/").at(-1));
    }
    expect(readProjectFile("src/main.ts")).not.toContain("./routes");
  });

  it("keeps legacy navigation aliases quarantined to the active Search surface", () => {
    const state = readProjectFile("src/store/state.svelte.ts");
    const layout = readProjectFile("src/components/layout/Layout.svelte");
    const search = readProjectFile("src/components/pages/Search.svelte");

    expect(state).toContain('savedNavPage === "explore"');
    expect(state).toContain('savedNavPage === "extensions"');
    expect(state).toContain('savedNavPage === "sources"');
    expect(state).toContain('return "search"');
    expect(layout).toContain('search: () => import("../pages/Search.svelte")');
    expect(search).toContain('import BrowseV3 from "./BrowseV3.svelte"');
    expect(search).not.toContain("Discover.svelte");
    expect(search).not.toContain("Extensions.svelte");
  });

  it("keeps modern repository and tracking hosts explicit", () => {
    expect(readProjectFile("src/components/pages/SourcesView.svelte")).toContain("novelRepositoryState");
    expect(readProjectFile("src/components/settings/Settings.svelte")).not.toContain("NovelRepositoriesPanel");
    expect(readProjectFile("src/components/pages/SeriesDetail.svelte")).toContain("TrackingPanel");
    expect(readProjectFile("src/components/pages/NovelDetail.svelte")).toContain("NovelTrackingPanel");
    expect(readProjectFile("src/components/pages/BookDetail.svelte")).toContain("NovelTrackingPanel");
  });

  it("keeps the obsolete route map outside every application entrypoint", () => {
    expect(existsSync(resolve(ROOT, "src/routes.ts"))).toBe(false);
    const webEntrypoints = [
      "index.html",
      "src/main.ts",
      "vite.config.ts",
      "package.json",
    ].map(readProjectFile).join("\n");
    const tauriEntrypoints = [
      "src-tauri/Cargo.toml",
      "src-tauri/tauri.conf.json",
      "src-tauri/tauri.dev.conf.json",
      "src-tauri/tauri.automation.conf.json",
      "src-tauri/tauri.macos.conf.json",
      "src-tauri/tauri.windows.conf.json",
    ].map(readProjectFile).join("\n");
    const frontend = sourceCorpus("src");
    const tauriRuntime = rustCorpus("src-tauri/src");

    expect(webEntrypoints).not.toContain("src/routes.ts");
    expect(webEntrypoints).not.toMatch(/(?:from|import\()\s*["'][^"']*\/routes["']/);
    expect(tauriEntrypoints).not.toMatch(/deep[-_]link|single[-_]instance/i);
    expect(frontend).not.toMatch(/onOpenUrl|open-url|deep[-_]link/i);
    expect(tauriRuntime).not.toMatch(/RunEvent::Opened|deep[-_]link/i);
  });

  it("keeps startup audit targets on active surfaces only", () => {
    const rust = readProjectFile("src-tauri/src/lib.rs");
    const parserStart = rust.indexOf('arg.strip_prefix("--audit-open=")');
    const parserEnd = rust.indexOf('arg.strip_prefix("--audit-manga-id=")', parserStart);
    const parser = rust.slice(parserStart, parserEnd);
    const app = readProjectFile("src/App.svelte");
    const handlerStart = app.indexOf("if (pendingAuditOpen)");
    const handlerEnd = app.indexOf("function clearStartupFailsafe", handlerStart);
    const handler = app.slice(handlerStart, handlerEnd);

    expect(parserStart).toBeGreaterThan(-1);
    expect(parserEnd).toBeGreaterThan(parserStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    for (const target of [
      "library",
      "manga",
      "reader",
      "books",
      "book",
      "book-reader",
      "settings",
      "settings-security",
    ]) {
      expect(parser, target).toContain(`"${target}"`);
      expect(handler, target).toContain(`"${target}"`);
    }

    for (const legacyTarget of ["history", "explore", "extensions", "sources", "discover"]) {
      expect(parser, legacyTarget).not.toContain(`"${legacyTarget}"`);
      expect(handler, legacyTarget).not.toContain(`"${legacyTarget}"`);
    }
  });

  it("keeps retained Nocturne aliases Legacy and removed activity aliases absent", () => {
    const source = sourceCorpus("src");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");

    for (const token of LEGACY_NOCTURNE_TOKENS) {
      expect(nocturne, `${token} must remain defined`).toMatch(new RegExp(`${token}\\s*:`));
      expect(withoutDefinitions(source, token), `${token} gained an active reference`).not.toMatch(
        new RegExp(`${token}(?![A-Za-z0-9_-])`),
      );
    }
    for (const token of REMOVED_ACTIVITY_TOKENS) {
      expect(nocturne, `${token} must be removed`).not.toMatch(new RegExp(`${token}\\s*:`));
      expect(withoutDefinitions(source, token), `${token} gained an active reference`).not.toMatch(
        new RegExp(`${token}(?![A-Za-z0-9_-])`),
      );
    }
  });
});
