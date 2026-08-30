import { describe, expect, test } from "vitest";

import { BUILTIN_THEME_CONTRACTS, BUILTIN_THEME_IDS } from "./contract";
import { contrastRatio, parseThemeColor, relativeLuminance } from "./paletteQuality";

describe("theme palette quality", () => {
  test.each([
    ["#abc", [170, 187, 204, 1]],
    ["#102030", [16, 32, 48, 1]],
    ["rgb(16, 32, 48)", [16, 32, 48, 1]],
    ["rgba(16, 32, 48, 0.25)", [16, 32, 48, 0.25]],
  ] as const)("parses %s", (value, expected) => {
    expect(parseThemeColor(value)).toEqual(expected);
  });

  test("rejects unsupported color syntax", () => {
    expect(() => parseThemeColor("hsl(0 0% 0%)")).toThrow(/Unsupported theme color/);
  });

  test("computes the WCAG black-to-white ratio", () => {
    expect(contrastRatio("#000", "#fff")).toBe(21);
  });

  test.each(["nocturne", "dark", "amoled", "high-contrast", "midnight", "warm"] as const)(
    "%s keeps dark surfaces ordered",
    (id) => {
      const tokens = BUILTIN_THEME_CONTRACTS[id].tokens;
      expect(relativeLuminance(tokens["bg-base"])).toBeLessThanOrEqual(relativeLuminance(tokens["bg-surface"]));
      expect(relativeLuminance(tokens["bg-surface"])).toBeLessThanOrEqual(relativeLuminance(tokens["bg-raised"]));
      expect(relativeLuminance(tokens["bg-raised"])).toBeLessThanOrEqual(relativeLuminance(tokens["bg-overlay"]));
    },
  );

  test("AMOLED uses subtle normal boundaries and visible focus", () => {
    const tokens = BUILTIN_THEME_CONTRACTS.amoled.tokens;
    expect(contrastRatio(tokens["border-base"], tokens["bg-base"])).toBeLessThan(2);
    expect(contrastRatio(tokens["border-focus"], tokens["bg-base"])).toBeGreaterThanOrEqual(3);
  });

  test("AMOLED keeps structural surfaces and normal boundaries neutral", () => {
    const tokens = BUILTIN_THEME_CONTRACTS.amoled.tokens;
    for (const token of ["bg-base", "bg-surface", "bg-raised", "bg-overlay", "bg-subtle", "border-dim", "border-base", "border-strong"] as const) {
      const [red, green, blue] = parseThemeColor(tokens[token]);
      expect(red, token).toBe(green);
      expect(green, token).toBe(blue);
    }
  });

  test("Dark remains visibly darker than Nocturne through elevated surfaces", () => {
    const dark = BUILTIN_THEME_CONTRACTS.dark.tokens;
    const nocturne = BUILTIN_THEME_CONTRACTS.nocturne.tokens;
    for (const token of ["bg-base", "bg-surface", "bg-raised", "bg-overlay"] as const) {
      expect(relativeLuminance(dark[token]), token).toBeLessThan(relativeLuminance(nocturne[token]));
    }
    expect(relativeLuminance(dark["bg-overlay"]) / relativeLuminance(nocturne["bg-overlay"])).toBeLessThanOrEqual(0.3);
  });

  test.each(BUILTIN_THEME_IDS)("%s keeps text readable on core surfaces", (id) => {
    const tokens = BUILTIN_THEME_CONTRACTS[id].tokens;
    for (const surface of ["color-background", "color-card", "color-modal", "color-popover"] as const) {
      expect(contrastRatio(tokens["text-primary"], tokens[surface])).toBeGreaterThanOrEqual(4.5);
    }
  });
});
