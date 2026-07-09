import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const TOKEN_PREFIX = "component-novel-repositories";

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function componentStyle(source: string) {
  return source.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
}

function tokenDefinitions(source: string) {
  const start = source.indexOf("Marco 18 - Novel repositories");
  expect(start).toBeGreaterThanOrEqual(0);
  return new Set(
    [...source.slice(start).matchAll(new RegExp(`(--${TOKEN_PREFIX}-[\\w-]+)\\s*:`, "g"))].map((match) => match[1]),
  );
}

function consumedTokens(source: string) {
  return new Set(
    [...source.matchAll(new RegExp(`var\\((--${TOKEN_PREFIX}-[\\w-]+)`, "g"))].map((match) => match[1]),
  );
}

describe("NovelRepositoriesPanel theme tokens", () => {
  test("documents the panel as a specialized settings surface outside the active app mount", () => {
    const settings = readRepoFile("src/components/settings/Settings.svelte");
    const sources = readRepoFile("src/components/pages/SourcesView.svelte");
    const panel = readRepoFile("src/components/settings/NovelRepositoriesPanel.svelte");

    expect(panel).toContain("interface Props");
    expect(panel).toContain("scopeLabel");
    expect(settings).not.toContain("NovelRepositoriesPanel");
    expect(sources).toContain('utilityPanel === "novelRepos"');
  });

  test("keeps NovelRepositoriesPanel styles free of direct visual values and Nocturne internals", () => {
    const style = componentStyle(readRepoFile("src/components/settings/NovelRepositoriesPanel.svelte"));
    const directVisualPattern =
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|--n-|box-shadow:\s*[^;]*rgba|z-index:\s*\d|opacity:\s*0\.|border-radius:\s*(?:\d|50%)/;

    const offenders = style
      .split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text: text.trim() }))
      .filter(({ text }) => text.length > 0 && directVisualPattern.test(text));

    expect(offenders).toEqual([]);
  });

  test("defines and consumes every Marco 18 NovelRepositoriesPanel token", () => {
    const tokensCss = readRepoFile("src/styles/tokens.css");
    const nocturne = readRepoFile("src/styles/nocturne-theme.css");
    const panel = readRepoFile("src/components/settings/NovelRepositoriesPanel.svelte");

    const definitions = tokenDefinitions(tokensCss);
    const nocturneDefinitions = tokenDefinitions(nocturne);
    const consumed = consumedTokens(panel);

    const unused = [...definitions].filter((token) => !consumed.has(token)).sort();
    const undefinedTokens = [...consumed].filter((token) => !definitions.has(token)).sort();
    const missingNocturne = [...consumed].filter((token) => !nocturneDefinitions.has(token)).sort();

    expect(definitions.size).toBe(89);
    expect(consumed.size).toBe(89);
    expect(unused).toEqual([]);
    expect(undefinedTokens).toEqual([]);
    expect(missingNocturne).toEqual([]);
  });
});
