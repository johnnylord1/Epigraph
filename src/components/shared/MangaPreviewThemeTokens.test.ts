import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

function readRepoFile(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function styleBlock(source: string) {
  return source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
}

function componentTokens(source: string) {
  return new Set(
    [...source.matchAll(/(--component-manga-preview-[\w-]+)\s*:/g)].map((match) => match[1]),
  );
}

describe("MangaPreview theme tokens", () => {
  test("is an active lazy-loaded preview surface", () => {
    const app = readRepoFile("src/App.svelte");
    const state = readRepoFile("src/store/state.svelte.ts");
    const browse = readRepoFile("src/components/pages/BrowseV3.svelte");
    const home = readRepoFile("src/components/pages/Home.svelte");

    expect(app).toContain('mangaPreview: () => import("./components/shared/MangaPreview.svelte")');
    expect(app).toContain("<MangaPreviewView />");
    expect(state).toContain("previewManga:");
    expect(state).toContain("setPreviewManga(next: Manga | null)");
    expect(browse).not.toContain("setPreviewManga(m");
    expect(home).toContain("setPreviewManga(");
  });

  test("keeps MangaPreview styles free of direct visual values and Nocturne internals", () => {
    const source = readRepoFile("src/components/shared/MangaPreview.svelte");
    const style = styleBlock(source);
    const directVisualPattern =
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|--n-/;
    const visualDeclarationPattern =
      /^(box-shadow|filter|backdrop-filter|-webkit-backdrop-filter|z-index|border-radius|opacity)\s*:\s*([^;]+);?$/;

    const offenders = style
      .split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text: text.trim() }))
      .filter(({ text }) => {
        if (!text || text.startsWith("/*")) return false;
        if (directVisualPattern.test(text)) return true;

        const declaration = text.match(visualDeclarationPattern);
        if (!declaration) return false;

        const [, prop, rawValue] = declaration;
        const value = rawValue.trim();
        if (prop === "filter" || prop === "box-shadow" || prop === "backdrop-filter" || prop === "-webkit-backdrop-filter") {
          return !value.startsWith("var(") && value !== "none";
        }
        if (prop === "z-index") return /^-?\d/.test(value);
        if (prop === "border-radius") return /^(?:\d|50%)/.test(value);
        if (prop === "opacity") return !value.startsWith("var(");
        return false;
      });

    expect(offenders).toEqual([]);
  });

  test("defines and consumes every MangaPreview component token", () => {
    const component = readRepoFile("src/components/shared/MangaPreview.svelte");
    const tokensCss = readRepoFile("src/styles/tokens.css");
    const nocturne = readRepoFile("src/styles/nocturne-theme.css");

    const baseDefinitions = componentTokens(tokensCss);
    const nocturneDefinitions = componentTokens(nocturne);
    const consumed = new Set(
      [...component.matchAll(/var\((--component-manga-preview-[\w-]+)/g)].map((match) => match[1]),
    );

    const unused = [...baseDefinitions].filter((token) => !consumed.has(token)).sort();
    const undefinedBase = [...consumed].filter((token) => !baseDefinitions.has(token)).sort();
    const missingNocturne = [...consumed].filter((token) => !nocturneDefinitions.has(token)).sort();

    expect(baseDefinitions.size).toBe(191);
    expect(consumed.size).toBe(191);
    expect(unused, "all --component-manga-preview-* tokens should be consumed").toEqual([]);
    expect(undefinedBase, "all consumed --component-manga-preview-* tokens should be defined in tokens.css").toEqual([]);
    expect(missingNocturne, "all consumed --component-manga-preview-* tokens should be implemented by Nocturne").toEqual([]);
  });

  test("keeps inline styles limited to dynamic progress width", () => {
    const source = readRepoFile("src/components/shared/MangaPreview.svelte");
    const inlineStyles = [...source.matchAll(/style="([^"]+)"/g)].map((match) => match[1]);
    const staticInlineOffenders = inlineStyles.filter((style) => style !== "width:{(readCount / totalCount) * 100}%");

    expect(staticInlineOffenders).toEqual([]);
  });
});
