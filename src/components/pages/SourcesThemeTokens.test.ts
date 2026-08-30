import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ACTIVE_SOURCES_FILES = [
  "src/components/pages/SourcesView.svelte",
  "src/components/pages/ExtensionSettingsPanel.svelte",
] as const;

const SOURCES_TOKEN_CONSUMER_FILES = [
  ...ACTIVE_SOURCES_FILES,
  "src/styles/nocturne-port.css",
] as const;

const TOKEN_SOURCE_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
] as const;

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("Sources theme token contract", () => {
  it("keeps active Sources components free of direct visual values and Nocturne internals", () => {
    const directVisualPattern =
      /(?<!\{)#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba/i;
    const nocturneInternalPrefix = "--" + "n-";
    const violations = ACTIVE_SOURCES_FILES.flatMap((file) =>
      read(file)
        .split(/\r?\n/)
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => directVisualPattern.test(text) || text.includes(nocturneInternalPrefix)),
    );

    expect(violations).toEqual([]);
  });

  it("consumes every component Sources token defined for the milestone", () => {
    const definitions = new Set<string>();
    for (const file of TOKEN_SOURCE_FILES) {
      const contents = read(file);
      for (const match of contents.matchAll(/--component-sources-[A-Za-z0-9_-]+\s*:/g)) {
        definitions.add(match[0].slice(0, -1).trim());
      }
    }

    const componentContents = SOURCES_TOKEN_CONSUMER_FILES.map(read).join("\n");
    const unused = [...definitions].filter((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`var\\(${escaped}(?:[,)]|\\s)`).test(componentContents);
    });

    expect(unused).toEqual([]);
  });

  it("keeps repository setup inside the Sources empty state", () => {
    const source = read("src/components/pages/SourcesView.svelte");
    const emptyStateStart = source.indexOf('{:else if groups.length === 0}');
    const setupStatusStart = source.indexOf('<div class="setupWrap">');
    const setupStyles = source.match(/\.setupWrap\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(emptyStateStart).toBeGreaterThan(-1);
    expect(setupStatusStart).toBeGreaterThan(emptyStateStart);
    expect(setupStyles).not.toMatch(/position\s*:\s*(?:fixed|absolute)/);
  });

  it("closes every Sources utility panel with Escape", () => {
    const source = read("src/components/pages/SourcesView.svelte");

    expect(source).toMatch(/function handleUtilityPanelKeydown\(event: KeyboardEvent\)/);
    expect(source).toMatch(/<svelte:window onkeydown=\{handleUtilityPanelKeydown\}\s*\/>/);
  });

  it("uses a readable foreground token for the active source tab", () => {
    const source = read("src/components/pages/SourcesView.svelte");
    const activeTabRule = source.match(/\.tab\.active\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(activeTabRule).toContain("var(--component-sources-tab-active-fg)");
    expect(activeTabRule).not.toContain("var(--component-sources-primary-ink)");
  });

  it("keeps the footer refresh action readable as a secondary control", () => {
    const source = read("src/components/pages/SourcesView.svelte");
    const footerButtonRule = source.match(/\.sourcesFooter button\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(footerButtonRule).toContain("var(--component-sources-footer-action-fg)");
    expect(footerButtonRule).not.toContain("var(--component-sources-primary-ink)");
  });

  it("keeps the APK install action readable with dedicated modal tokens", () => {
    const source = read("src/components/pages/SourcesView.svelte");
    const installButtonRule = source.match(/\.apkInstallButton\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(installButtonRule).toContain("var(--component-sources-apk-install-bg)");
    expect(installButtonRule).toContain("var(--component-sources-apk-install-fg)");
    expect(installButtonRule).not.toContain("var(--component-sources-primary-ink)");
  });
});
