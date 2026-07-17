import { describe, expect, test } from "vitest";
import {
  DEFAULT_PROSE_READER_BACKGROUND_COLOR,
  DEFAULT_PROSE_READER_TEXT_COLOR,
  PROSE_READER_PALETTES,
  proseReaderThemeSwatch,
  resolveProseReaderPalette,
} from "./prosePalette";

describe("prose reader palette", () => {
  test("keeps the nine existing reader palettes in one registry", () => {
    expect(Object.keys(PROSE_READER_PALETTES)).toEqual([
      "nocturne", "light", "sepia", "oled", "dark", "slate", "forest", "nord", "warm",
    ]);
    expect(DEFAULT_PROSE_READER_TEXT_COLOR).toBe(PROSE_READER_PALETTES.nocturne.text);
    expect(DEFAULT_PROSE_READER_BACKGROUND_COLOR).toBe(PROSE_READER_PALETTES.nocturne.bg);
  });

  test("resolves preset and user-editable Nocturne palettes without changing behavior", () => {
    expect(resolveProseReaderPalette("sepia")).toEqual(PROSE_READER_PALETTES.sepia);
    expect(resolveProseReaderPalette("nocturne", "custom-text", "custom-bg")).toEqual({
      text: "custom-text",
      bg: "custom-bg",
      surface: "custom-bg",
    });
    expect(resolveProseReaderPalette("unknown")).toEqual(PROSE_READER_PALETTES.nocturne);
  });

  test("uses each page background as its existing swatch", () => {
    for (const theme of Object.keys(PROSE_READER_PALETTES) as (keyof typeof PROSE_READER_PALETTES)[]) {
      expect(proseReaderThemeSwatch(theme)).toBe(PROSE_READER_PALETTES[theme].bg);
    }
  });
});
