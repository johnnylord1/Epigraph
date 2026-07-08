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
    const tokenSource = TOKEN_FILES.map(readRepoFile).join("\n");
    const componentSource = SYNC_COMPONENT_FILES.map(readRepoFile).join("\n");

    const definitions = new Set(
      [...tokenSource.matchAll(/(--component-syncd-[\w-]+)\s*:/g)].map((match) => match[1]),
    );
    const consumed = new Set(
      [...componentSource.matchAll(/var\((--component-syncd-[\w-]+)/g)].map((match) => match[1]),
    );

    const unused = [...definitions].filter((token) => !consumed.has(token)).sort();
    const undefinedTokens = [...consumed].filter((token) => !definitions.has(token)).sort();

    expect(definitions.size).toBeGreaterThan(0);
    expect(unused, "all Syncd component tokens should be consumed").toEqual([]);
    expect(undefinedTokens, "all consumed Syncd component tokens should be defined").toEqual([]);
  });
});
