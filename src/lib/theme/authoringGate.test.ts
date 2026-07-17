import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { THEME_PROBE_HUD_TOKENS, THEME_PROBE_TOKENS } from "../../test/themeProbe";
import {
  HUD_THEME_TOKEN_KEYS,
  NOCTURNE_THEME_TOKENS,
  THEME_TOKEN_KEYS,
} from "./contract";
import {
  createThemeDocumentV5,
  migrateThemeDocument,
  resolveThemeDocument,
  roundTripThemeDocument,
  serializeThemeDocument,
  validateThemeDocument,
} from "./document";

const ROOT = process.cwd();

describe("theme authoring gate", () => {
  test("authors the test probe as V5 without component tokens and resolves the complete contract", () => {
    const document = createThemeDocumentV5({
      id: "custom:authoring-probe",
      name: "Authoring Probe",
      base: "nocturne",
      tokens: THEME_PROBE_TOKENS,
      hud: THEME_PROBE_HUD_TOKENS,
      motion: "expressive",
    });
    const serialized = serializeThemeDocument(document);
    const resolved = resolveThemeDocument(document);

    expect(validateThemeDocument(document)).toMatchObject({ valid: true });
    expect(roundTripThemeDocument(document)).toEqual(document);
    expect(serialized).not.toContain("--component-");
    expect(serialized).not.toContain("component-");
    expect(Object.keys(resolved.tokens).sort()).toEqual([...THEME_TOKEN_KEYS].sort());
    expect(Object.keys(resolved.hud).sort()).toEqual([...HUD_THEME_TOKEN_KEYS].sort());
    expect(resolved.tokens).toEqual(THEME_PROBE_TOKENS);
    expect(resolved.hud).toEqual(THEME_PROBE_HUD_TOKENS);
  });

  test.each([1, 2, 3] as const)("keeps a legacy v%s document unchanged while migrating it in memory", (version) => {
    const legacy = {
      version,
      id: `custom:gate-v${version}`,
      name: `Gate v${version}`,
      tokens: { ...NOCTURNE_THEME_TOKENS, accent: "#abcdef" },
      motion: "soft",
    };
    const before = structuredClone(legacy);

    expect(migrateThemeDocument(legacy)).toMatchObject({
      ok: true,
      document: { version: 5, primitives: { accent: "#abcdef" } },
    });
    expect(legacy).toEqual(before);
  });

  test("keeps runtime and preview application on CSSOM allowlists", () => {
    const app = readFileSync(resolve(ROOT, "src/App.svelte"), "utf8");
    const editor = readFileSync(resolve(ROOT, "src/components/settings/ThemeEditor.svelte"), "utf8");
    const provider = readFileSync(resolve(ROOT, "src/lib/theme/provider.ts"), "utf8");

    expect(app).toContain("applyCustomTheme(root, custom)");
    expect(app).not.toContain("aethon-custom-theme");
    expect(app).not.toContain("document.createElement(\"style\")");
    expect(editor).toContain("use:themePreview={{ tokens, hud, motion }}");
    expect(editor).not.toContain("toCssVars");
    expect(provider).toContain("element.style.setProperty");
    expect(provider).toContain("element.style.removeProperty");
  });

  test("documents the no-component-CSS promotion contract", () => {
    const guide = readFileSync(resolve(ROOT, "docs/theme-authoring.md"), "utf8");
    const promotion = readFileSync(resolve(ROOT, "docs/theme-promotion.md"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

    expect(guide).toContain("ThemeDocumentV5");
    expect(guide).toContain("ThemeEditor -> export -> validation -> promotion");
    expect(guide).toContain("Component tokens are never authored");
    expect(guide).toContain("No component CSS");
    expect(promotion).toContain("The command never edits");
    expect(promotion).toContain("All seven evidence paths");
    expect(packageJson.scripts["theme:validate-promotion"]).toBe("node scripts/validate-theme-promotion.mjs");
  });
});
