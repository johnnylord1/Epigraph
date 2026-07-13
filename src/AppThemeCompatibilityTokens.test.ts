import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const APP_LOADING_TOKEN = "--component-app-loading-fg";
const LEGACY_NOCTURNE_TOKENS = [
  "--n-bg",
  "--n-bg-top",
  "--n-line",
  "--n-line-strong",
  "--n-outline-variant",
  "--n-popover-control-bg",
  "--n-popover-control-border",
  "--n-surface-container",
  "--n-surface-container-low",
];
const LEGACY_ACTIVITY_TOKENS = [
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
const LEGACY_SURFACES = [
  "Discover.svelte",
  "Extensions.svelte",
  "NovelSources.svelte",
  "NovelsLibraryBody.svelte",
  "Tracking.svelte",
  "GenreDrillPage.svelte",
  "NovelRepositoriesPanel.svelte",
];

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

  it("preserves the active HUD scale compatibility publisher", () => {
    expect(readProjectFile("src/App.svelte")).toContain(
      'style.setProperty("--n-hud-scale", hudScale)',
    );
  });

  it("keeps audited Legacy surfaces outside the active shell", () => {
    const activeShell = [
      "src/main.ts",
      "src/App.svelte",
      "src/components/layout/Layout.svelte",
      "src/components/pages/Search.svelte",
      "src/components/settings/Settings.svelte",
      "src/components/pages/Library.svelte",
    ].map(readProjectFile).join("\n");

    for (const legacySurface of LEGACY_SURFACES) {
      expect(activeShell, legacySurface).not.toContain(legacySurface);
    }

    expect(readProjectFile("src/routes.ts")).toContain(
      'import Extensions from "./components/pages/Extensions.svelte"',
    );
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

  it("keeps legacy diagnostic hosts explicit until runtime evidence changes", () => {
    const discover = readProjectFile("src/components/pages/Discover.svelte");
    const routes = readProjectFile("src/routes.ts");
    const novelSources = readProjectFile("src/components/pages/NovelSources.svelte");
    const novelRepositories = readProjectFile("src/components/settings/NovelRepositoriesPanel.svelte");
    const settings = readProjectFile("src/components/settings/Settings.svelte");

    expect(discover).toContain('import SourceBrowse from "../shared/SourceBrowse.svelte"');
    expect(routes).toContain('import Extensions from "./components/pages/Extensions.svelte"');
    expect(novelSources).toContain('import NovelSourceStatusDetails from "../novels/NovelSourceStatusDetails.svelte"');
    expect(novelRepositories).toContain('import NovelSourceCheckModal');
    expect(novelRepositories).toContain('import NovelSourceStatusDetails');
    expect(settings).not.toContain("NovelRepositoriesPanel");
  });

  it("keeps unreferenced compatibility aliases classified as Legacy", () => {
    const source = sourceCorpus("src");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");

    for (const token of [...LEGACY_NOCTURNE_TOKENS, ...LEGACY_ACTIVITY_TOKENS]) {
      expect(nocturne, `${token} must remain defined`).toMatch(new RegExp(`${token}\\s*:`));
      expect(withoutDefinitions(source, token), `${token} gained an active reference`).not.toMatch(
        new RegExp(`${token}(?![A-Za-z0-9_-])`),
      );
    }
  });
});
