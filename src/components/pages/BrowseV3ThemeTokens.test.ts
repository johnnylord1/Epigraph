import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../..");

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function styleBlock(source: string) {
  return source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
}

describe("BrowseV3 theme token contract", () => {
  test("keeps BrowseV3 visual styles on component tokens", () => {
    const source = readRepoFile("src/components/pages/BrowseV3.svelte");
    const style = styleBlock(source);
    const lines = style.split(/\r?\n/);

    const offenders = lines
      .map((text, index) => ({ line: index + 1, text }))
      .filter(({ text }) => {
        const trimmed = text.trim();
        if (!trimmed || trimmed.startsWith("/*")) return false;
        if (trimmed.includes("--" + "n-")) return true;
        if (/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(/.test(trimmed)) return true;
        const declaration = trimmed.match(/^([-\w]+)\s*:\s*([^;]+);?$/);
        if (!declaration) return false;
        const [, prop, rawValue] = declaration;
        const value = rawValue.trim();
        if ((prop === "box-shadow" || prop.endsWith("backdrop-filter")) && !value.startsWith("var(") && value !== "none") return true;
        if (prop === "z-index" && /^-?\d/.test(value)) return true;
        if (prop === "opacity" && /^0\.\d/.test(value)) return true;
        if (prop === "border-radius" && /^(?:\d|50%)/.test(value)) return true;
        return false;
      });

    expect(offenders, "BrowseV3 style should consume tokens instead of direct visual values").toEqual([]);
  });

  test("defines and consumes every BrowseV3 component token", () => {
    const component = readRepoFile("src/components/pages/BrowseV3.svelte");
    const tokenSources = [
      readRepoFile("src/styles/tokens.css"),
      readRepoFile("src/styles/nocturne-theme.css"),
    ].join("\n");

    const definitions = new Set([...tokenSources.matchAll(/(--component-browse-[\w-]+)\s*:/g)].map((match) => match[1]));
    const consumed = new Set([...component.matchAll(/var\((--component-browse-[\w-]+)/g)].map((match) => match[1]));

    const unused = [...definitions].filter((token) => !consumed.has(token));
    const undefinedTokens = [...consumed].filter((token) => !definitions.has(token));

    expect(definitions.size).toBeGreaterThan(0);
    expect(unused, "all --component-browse-* tokens should be consumed").toEqual([]);
    expect(undefinedTokens, "all consumed --component-browse-* tokens should be defined").toEqual([]);
  });
});
