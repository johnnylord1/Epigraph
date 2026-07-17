import { describe, expect, test } from "vitest";
import {
  BUILTIN_THEME_CONTRACTS,
  BUILTIN_THEME_IDS,
  DEFAULT_HUD_THEME_TOKENS,
  DEFAULT_THEME_TOKENS,
  NOCTURNE_HUD_THEME_TOKENS,
  NOCTURNE_THEME_TOKENS,
  type LegacyCustomTheme,
  type ThemeDocumentV4,
  type ThemeDocumentV5,
} from "./contract";
import {
  ThemeDocumentError,
  createThemeDocumentV5,
  customThemeToThemeDocument,
  importThemeDocument,
  migrateThemeDocument,
  parseThemeDocument,
  resolveThemeDocument,
  roundTripThemeDocument,
  serializeThemeDocument,
  themeDocumentToCustomTheme,
  validateThemeDocument,
} from "./document";

function validDocument(overrides: Partial<ThemeDocumentV5> = {}): ThemeDocumentV5 {
  return {
    version: 5,
    id: "custom:test",
    name: "Test theme",
    base: "nocturne",
    primitives: { accent: "#abcdef" },
    motion: "soft",
    ...overrides,
  };
}

function expectRejected(document: unknown, code: string): void {
  const result = validateThemeDocument(document);
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.errors.map((error) => error.code)).toContain(code);
}

describe("ThemeDocumentV5", () => {
  test.each([1, 2, 3] as const)("migrates v%s to a sparse V5 in memory", (version) => {
    const legacy = {
      version,
      id: `custom:legacy-${version}`,
      name: `Legacy ${version}`,
      tokens: {
        ...NOCTURNE_THEME_TOKENS,
        accent: "#abcdef",
        "color-warning": "#fedcba",
      },
      hud: {
        ...NOCTURNE_HUD_THEME_TOKENS,
        "hud-toolbar-gap": "10px",
      },
      motion: "minimal",
    };
    const before = structuredClone(legacy);

    const result = migrateThemeDocument(legacy);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual({
      version: 5,
      id: `custom:legacy-${version}`,
      name: `Legacy ${version}`,
      base: "nocturne",
      primitives: { accent: "#abcdef" },
      semanticOverrides: { "color-accent": NOCTURNE_THEME_TOKENS["color-accent"], "color-warning": "#fedcba" },
      hud: { "hud-toolbar-gap": "10px" },
      motion: "minimal",
    });
    expect(legacy).toEqual(before);
  });

  test("treats an omitted legacy version as v1 and defaults motion to soft", () => {
    const result = migrateThemeDocument({
      id: "custom:v1",
      name: "Version one",
      tokens: { ...NOCTURNE_THEME_TOKENS },
    });

    expect(result).toEqual({
      ok: true,
      document: {
        version: 5,
        id: "custom:v1",
        name: "Version one",
        base: "nocturne",
        primitives: {},
        motion: "soft",
      },
    });
  });

  test("migrates V4 without changing its previously resolved appearance", () => {
    const v4: ThemeDocumentV4 = {
      version: 4,
      id: "custom:v4-compatible",
      name: "V4 compatible",
      base: "nocturne",
      primitives: { accent: "#abcdef" },
      motion: "soft",
    };

    const result = migrateThemeDocument(v4);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toMatchObject({
      version: 5,
      primitives: { accent: "#abcdef" },
      semanticOverrides: { "color-accent": NOCTURNE_THEME_TOKENS["color-accent"] },
    });
    expect(resolveThemeDocument(result.document).tokens).toEqual({
      ...NOCTURNE_THEME_TOKENS,
      accent: "#abcdef",
    });
  });

  test("propagates V5 primitive changes unless a semantic override is explicit", () => {
    const derived = validDocument({ primitives: { accent: "#abcdef" } });
    const pinned = validDocument({
      primitives: { accent: "#abcdef" },
      semanticOverrides: { "color-accent": "#123456" },
    });

    expect(resolveThemeDocument(derived).tokens["color-accent"]).toBe("#abcdef");
    expect(resolveThemeDocument(pinned).tokens["color-accent"]).toBe("#123456");
  });

  test("validates, imports, and round-trips V5 without mutating it", () => {
    const document = validDocument({
      semanticOverrides: { "color-accent": "var(--accent-bright)" },
      hud: { "hud-sidebar-width": "60px", "hud-surface-opacity": "0.94" },
      motion: "expressive",
    });
    const before = structuredClone(document);

    expect(validateThemeDocument(document)).toMatchObject({ valid: true, ok: true });
    expect(migrateThemeDocument(document)).toEqual({ ok: true, document });
    expect(importThemeDocument(JSON.stringify(document))).toEqual({ ok: true, document });
    expect(roundTripThemeDocument(document)).toEqual(document);
    expect(document).toEqual(before);
  });

  test("round-trips and resolves semantic shadow and highlight sources", () => {
    const document = validDocument({
      primitives: {},
      semanticOverrides: {
        "color-shadow-source": "#003366",
        "color-highlight-source": "#fff700",
      },
    });

    expect(roundTripThemeDocument(document)).toEqual(document);
    expect(resolveThemeDocument(document).tokens).toMatchObject({
      "color-shadow-source": "#003366",
      "color-highlight-source": "#fff700",
    });
  });

  test("creates a validated sparse V5 and derives semantic aliases from primitives", () => {
    const tokens = {
      ...NOCTURNE_THEME_TOKENS,
      accent: "#abcdef",
      "color-accent": "#abcdef",
      "color-warning": "#fedcba",
    };
    const hud = {
      ...NOCTURNE_HUD_THEME_TOKENS,
      "hud-toolbar-gap": "10px",
    };

    const document = createThemeDocumentV5({
      id: "custom:created",
      name: "Created",
      tokens,
      hud,
      motion: "soft",
    });

    expect(document).toEqual({
      version: 5,
      id: "custom:created",
      name: "Created",
      base: "nocturne",
      primitives: { accent: "#abcdef" },
      semanticOverrides: { "color-warning": "#fedcba" },
      hud: { "hud-toolbar-gap": "10px" },
      motion: "soft",
    });
    expect(validateThemeDocument(document).valid).toBe(true);
  });

  test("creates against explicit computed tokens for a non-default base", () => {
    const lightBase = {
      ...NOCTURNE_THEME_TOKENS,
      "bg-base": "#eeece8",
      "color-background": "#eeece8",
    };
    const document = createThemeDocumentV5(
      {
        id: "custom:light-child",
        name: "Light child",
        base: "light",
        tokens: { ...lightBase, accent: "#123456", "color-accent": "#123456" },
        motion: "soft",
      },
      lightBase,
      NOCTURNE_HUD_THEME_TOKENS,
    );

    expect(document).toEqual({
      version: 5,
      id: "custom:light-child",
      name: "Light child",
      base: "light",
      primitives: { accent: "#123456" },
      motion: "soft",
    });
  });

  test("uses the builtin fallback contract when resolving a non-default base outside the DOM", () => {
    const document = createThemeDocumentV5({
      id: "custom:dark-child",
      name: "Dark child",
      base: "dark",
      tokens: { ...DEFAULT_THEME_TOKENS, accent: "#123456", "color-accent": "#123456" },
      hud: { ...DEFAULT_HUD_THEME_TOKENS, "hud-toolbar-gap": "10px" },
      motion: "soft",
    });

    expect(document).toEqual({
      version: 5,
      id: "custom:dark-child",
      name: "Dark child",
      base: "dark",
      primitives: { accent: "#123456" },
      hud: { "hud-toolbar-gap": "10px" },
      motion: "soft",
    });
    expect(resolveThemeDocument(document)).toEqual({
      tokens: { ...DEFAULT_THEME_TOKENS, accent: "#123456", "color-accent": "#123456" },
      hud: { ...DEFAULT_HUD_THEME_TOKENS, "hud-toolbar-gap": "10px" },
    });
  });

  test("creates sparse documents against every exact builtin contract outside the DOM", () => {
    for (const base of BUILTIN_THEME_IDS) {
      const contract = BUILTIN_THEME_CONTRACTS[base];
      const document = createThemeDocumentV5({
        id: `custom:${base}`,
        name: `${base} child`,
        base,
        tokens: { ...contract.tokens },
        hud: { ...contract.hud },
        motion: contract.motion,
      });

      expect(document.primitives, `${base} primitives`).toEqual({});
      expect(document.semanticOverrides, `${base} semantic overrides`).toBeUndefined();
      expect(document.hud, `${base} HUD overrides`).toBeUndefined();
      expect(resolveThemeDocument(document)).toEqual({
        tokens: contract.tokens,
        hud: contract.hud,
      });
    }
  });

  test("serializes, parses, and adapts the current legacy type explicitly", () => {
    const legacy: LegacyCustomTheme = {
      version: 3,
      id: "custom:compatibility",
      name: "Compatibility",
      tokens: { ...NOCTURNE_THEME_TOKENS, accent: "#abcdef" },
      motion: "minimal",
    };

    const document = customThemeToThemeDocument(legacy);
    expect(parseThemeDocument(serializeThemeDocument(document))).toEqual(document);

    const materialized = themeDocumentToCustomTheme(document);
    expect(materialized.version).toBe(3);
    expect(materialized.tokens).toEqual({ ...NOCTURNE_THEME_TOKENS, accent: "#abcdef" });
    expect(materialized.hud).toEqual(NOCTURNE_HUD_THEME_TOKENS);
  });

  test("resolves sparse V5 maps into complete token and HUD contracts", () => {
    const document = validDocument({
      semanticOverrides: { "color-warning": "#fedcba" },
      hud: { "hud-toolbar-gap": "10px" },
    });

    const resolved = resolveThemeDocument(document);

    expect(resolved.tokens).toEqual({
      ...NOCTURNE_THEME_TOKENS,
      accent: "#abcdef",
      "color-accent": "#abcdef",
      "color-warning": "#fedcba",
    });
    expect(resolved.hud).toEqual({
      ...NOCTURNE_HUD_THEME_TOKENS,
      "hud-toolbar-gap": "10px",
    });
  });

  test.each([
    [{ ...validDocument(), id: "builtin" }, "invalid-id"],
    [{ ...validDocument(), id: "custom:" }, "invalid-id"],
    [{ ...validDocument(), name: " <script>" }, "invalid-name"],
    [{ ...validDocument(), base: "solarized" }, "invalid-base"],
    [{ ...validDocument(), motion: "instant" }, "invalid-motion"],
    [{ ...validDocument(), stylesheet: "body {}" }, "unknown-key"],
    [{ ...validDocument(), primitives: { mystery: "#fff" } }, "unknown-key"],
    [{ ...validDocument(), primitives: { "--component-button": "#fff" } }, "component-token"],
  ])("rejects invalid identity, enums, and unknown keys", (document, code) => {
    expectRejected(document, code as string);
  });

  test.each([
    ["body { color: red }", "css-rule"],
    ["url(https://example.test/theme.png)", "unsafe-url"],
    ["#fff; --accent: red", "injection-character"],
    ["#fff\n--accent: red", "injection-character"],
    ["expression(alert(1))", "injection-character"],
    ["not-a-color", "invalid-value"],
  ])("rejects unsafe CSS token value %s", (value, code) => {
    expectRejected(validDocument({ primitives: { accent: value } }), code);
  });

  test("rejects component and unknown CSS variable references", () => {
    expectRejected(
      validDocument({ primitives: { accent: "var(--component-button-bg)" } }),
      "component-token",
    );
    expectRejected(
      validDocument({ primitives: { accent: "var(--not-a-theme-token)" } }),
      "unknown-variable",
    );
  });

  test("rejects direct, indirect, and cross-map CSS variable cycles", () => {
    expectRejected(validDocument({ primitives: { accent: "var(--accent)" } }), "variable-cycle");
    expectRejected(validDocument({
      primitives: {
        accent: "var(--accent-bright)",
        "accent-bright": "var(--accent)",
      },
    }), "variable-cycle");
    expectRejected(validDocument({
      primitives: { accent: "var(--color-accent)" },
      semanticOverrides: { "color-accent": "var(--accent)" },
    }), "variable-cycle");
  });

  test.each([
    ["hud-sidebar-width", "4rem"],
    ["hud-toolbar-gap", "8"],
    ["hud-surface-opacity", "80%"],
    ["hud-reader-chrome-opacity", "1.1"],
  ] as const)("rejects invalid HUD unit for %s", (key, value) => {
    expectRejected(validDocument({ hud: { [key]: value } }), "invalid-hud-unit");
  });

  test("returns import errors and makes create/resolve reject invalid input", () => {
    expect(importThemeDocument("{")).toMatchObject({ ok: false });
    expect(migrateThemeDocument({
      version: 3,
      id: "custom:bad",
      name: "Bad",
      tokens: { accent: "red; } body { color: red" },
    })).toMatchObject({ ok: false });
    expect(() => createThemeDocumentV5({
      id: "bad",
      name: "Bad",
      tokens: NOCTURNE_THEME_TOKENS,
      motion: "soft",
    })).toThrow(ThemeDocumentError);
    expect(() => resolveThemeDocument({
      ...validDocument(),
      hud: { "hud-sidebar-width": "4rem" },
    })).toThrow(ThemeDocumentError);
  });
});
