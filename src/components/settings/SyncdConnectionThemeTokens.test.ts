import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

const SYNC_COMPONENT_FILES = [
  "src/components/settings/SyncdConnectionPanel.svelte",
  "src/components/settings/SyncdSessionDetails.svelte",
] as const;

const TOKEN_FILES = [
  "src/styles/tokens.css",
  "src/styles/nocturne-theme.css",
] as const;

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function styleBlock(source: string) {
  return source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
}

describe("syncd connection theme tokens", () => {
  test("keeps Syncd styles free of direct visual values and Nocturne internals", () => {
    const directVisualPattern =
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|backdrop-filter:\s*blur|box-shadow:\s*[^;]*rgba|--n-/;

    const offenders = SYNC_COMPONENT_FILES.flatMap((file) =>
      styleBlock(readRepoFile(file))
        .split(/\r?\n/)
        .map((text, index) => ({ file, line: index + 1, text: text.trim() }))
        .filter(({ text }) => text.length > 0 && directVisualPattern.test(text)),
    );

    expect(offenders).toEqual([]);
  });

  test("defines and consumes every Syncd component token", () => {
    const tokenSources = TOKEN_FILES.map(readRepoFile);
    const tokenSource = tokenSources.join("\n");
    const componentSource = SYNC_COMPONENT_FILES.map(readRepoFile).join("\n");

    const definitions = new Set(
      [...tokenSource.matchAll(/(--component-syncd-[\w-]+)\s*:/g)].map((match) => match[1]),
    );
    const consumed = new Set(
      [...componentSource.matchAll(/var\((--component-syncd-[\w-]+)/g)].map((match) => match[1]),
    );

    const unused = [...definitions].filter((token) => !consumed.has(token)).sort();
    const undefinedTokens = [...consumed].filter((token) => !definitions.has(token)).sort();

    expect(definitions.size).toBe(65);
    for (const source of tokenSources) {
      const layerDefinitions = new Set(
        [...source.matchAll(/(--component-syncd-[\w-]+)\s*:/g)].map((match) => match[1]),
      );
      expect(layerDefinitions).toEqual(definitions);
    }
    expect(consumed.size).toBe(65);
    expect(unused, "all Syncd component tokens should be consumed").toEqual([]);
    expect(undefinedTokens, "all consumed Syncd component tokens should be defined").toEqual([]);
    expect(readRepoFile("src/styles/nocturne-theme.css")).toContain(
      "--component-syncd-input-fg: var(--text-primary);",
    );
    expect(tokenSource.match(/--component-syncd-[\w-]+\s*:[^;]*var\(--n-/g) ?? []).toEqual([]);
  });

  test("keeps session details above the modal footer", () => {
    const sessionStyles = styleBlock(readRepoFile("src/components/settings/SyncdSessionDetails.svelte"));
    const popoverRule = sessionStyles.match(/\.syncd-session-popover\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(popoverRule).toContain("bottom: calc(100% + var(--component-syncd-session-popover-offset));");
    expect(popoverRule).not.toMatch(/\btop\s*:/);
  });

  test("derives the modal from the shared app modal surfaces and the theme accent", () => {
    for (const file of TOKEN_FILES) {
      const source = readRepoFile(file);
      expect(source).toContain("--component-syncd-modal-bg: var(--component-modal-bg);");
      expect(source).toContain("--component-syncd-modal-border: var(--component-modal-border);");
      expect(source).toContain("--component-syncd-modal-shadow: var(--component-modal-shadow);");
      expect(source).toContain("--component-syncd-field-underline: var(--component-syncd-accent-fg);");
      expect(source).toMatch(
        /--component-syncd-surface:\s*color-mix\(in srgb, var\(--text-primary\) 4%, transparent\);/,
      );
      expect(source).toMatch(
        /--component-syncd-field-focus-bg:\s*color-mix\(in srgb, var\(--(?:color-accent|accent-fg)\) 7%, var\(--component-syncd-surface\)\);/,
      );
    }
  });

  test("keeps the new pairing flow copy behind Paraglide messages", () => {
    const componentSource = SYNC_COMPONENT_FILES.map(readRepoFile).join("\n");
    const untranslatedCopy = [
      "Secure sync",
      "Live status",
      "Pair another desktop",
      "Connection details",
      "Pairing options",
      "Create pairing QR",
    ];

    for (const copy of untranslatedCopy) {
      expect(componentSource).not.toContain(`>${copy}<`);
      expect(componentSource).not.toContain(`\"${copy}\"`);
    }
  });
});
