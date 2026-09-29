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

describe("ThemeEditor theme tokens", () => {
  test("is an active lazy-loaded Settings surface", () => {
    const app = readRepoFile("src/App.svelte");
    const settings = readRepoFile("src/components/settings/Settings.svelte");

    expect(app).toContain('themeEditor: () => import("./components/settings/ThemeEditor.svelte")');
    expect(settings).toContain("onOpenThemeEditor?.(null)");
    expect(app).toContain("applyCustomTheme(root, custom)");
    expect(app).not.toContain("epigraph-custom-theme");
    expect(app).not.toContain("themeStyleEl.textContent");
  });

  test("keeps ThemeEditor styles free of direct visual values and Nocturne internals", () => {
    const source = readRepoFile("src/components/settings/ThemeEditor.svelte");
    const style = styleBlock(source);
    const directVisualPattern =
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|--n-/;
    const visualDeclarationPattern =
      /^(box-shadow|filter|backdrop-filter|z-index|border-radius|opacity)\s*:\s*([^;]+);?$/;

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
        if (prop === "filter" || prop === "box-shadow" || prop === "backdrop-filter") {
          return !value.startsWith("var(") && value !== "none";
        }
        if (prop === "z-index") return /^-?\d/.test(value);
        if (prop === "border-radius") return /^(?:\d|50%)/.test(value);
        if (prop === "opacity") return /^0\.\d/.test(value);
        return false;
      });

    expect(offenders).toEqual([]);
  });

  test("defines and consumes every ThemeEditor component token", () => {
    const component = readRepoFile("src/components/settings/ThemeEditor.svelte");
    const tokenSources = [
      readRepoFile("src/styles/tokens.css"),
      readRepoFile("src/styles/nocturne-theme.css"),
    ].join("\n");

    const definitions = new Set(
      [...tokenSources.matchAll(/(--component-theme-editor-[\w-]+)\s*:/g)].map((match) => match[1]),
    );
    const consumed = new Set(
      [...component.matchAll(/var\((--component-theme-editor-[\w-]+)/g)].map((match) => match[1]),
    );

    const unused = [...definitions].filter((token) => !consumed.has(token)).sort();
    const undefinedTokens = [...consumed].filter((token) => !definitions.has(token)).sort();

    expect(definitions.size).toBeGreaterThan(0);
    expect(unused, "all --component-theme-editor-* tokens should be consumed").toEqual([]);
    expect(undefinedTokens, "all consumed --component-theme-editor-* tokens should be defined").toEqual([]);
  });

  test("keeps inline styles limited to editable preview values", () => {
    const source = readRepoFile("src/components/settings/ThemeEditor.svelte");
    const staticInlineOffenders = [...source.matchAll(/style="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((style) => /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|--n-/.test(style));

    expect(staticInlineOffenders).toEqual([]);
    expect(source).not.toContain("toCssVars");
    expect(source).toContain("use:themePreview={{ tokens, hud, motion }}");
    expect(source).toContain("applyThemeContract(node, draft.tokens, draft.hud, draft.motion)");
    expect(source).toContain("createThemeDocumentV5(");
    expect(source).toContain("resolveThemeTokenLayers(");
    expect(source).toContain("primitiveOverrides");
    expect(source).toContain("semanticOverrides");
    expect(source).toContain("isBuiltinTheme(store.settings.theme)");
    expect(source).toContain("readBuiltinThemeContract(selectedBase)");
    expect(source).toContain("getBuiltinThemeFallbackContract(base).motion");
    expect(source).toContain("getBuiltinThemeFallbackContract(base).hud[token]");
    expect(source).not.toContain('base = "nocturne"');
    expect(source).toContain("importThemeDocument(text)");
    expect(source).toContain("serializeThemeDocument(data)");
    expect(source).toContain('"color-shadow-source": "themeEditor_token_colorShadowSource"');
    expect(source).toContain('"color-highlight-source": "themeEditor_token_colorHighlightSource"');
    expect(source).toContain("{$_(TOKEN_LABELS[token])}");
    expect(source).toContain("box-shadow: var(--component-theme-editor-preview-popover-shadow)");
    expect(source).not.toContain("version: 3");
    expect(source).toContain("style=\"background: {tokens[token]};\"");
    expect(source).toContain("style=\"background: {hud[token as keyof HudThemeTokens]};\"");
  });
});
