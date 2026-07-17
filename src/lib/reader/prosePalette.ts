export const PROSE_READER_PALETTES = {
  nocturne: { text: "#ffffff", bg: "#131316", surface: "#131316" },
  light: { text: "#19151d", bg: "#f5f1ea", surface: "#f8f4ec" },
  sepia: { text: "#2b2118", bg: "#efe1c9", surface: "#f6ead4" },
  oled: { text: "#e8e2f4", bg: "#000000", surface: "#050507" },
  dark: { text: "#ece7f5", bg: "#09080d", surface: "#111019" },
  slate: { text: "#f8fafc", bg: "#1e293b", surface: "#151d2a" },
  forest: { text: "#e2ebd9", bg: "#142217", surface: "#0f1a12" },
  nord: { text: "#e5e9f0", bg: "#2e3440", surface: "#242933" },
  warm: { text: "#433422", bg: "#fbf5e6", surface: "#f3ebd8" },
} as const;

export type ProseReaderThemeId = keyof typeof PROSE_READER_PALETTES;
export type ProseReaderPalette = { text: string; bg: string; surface: string };

export const DEFAULT_PROSE_READER_TEXT_COLOR = PROSE_READER_PALETTES.nocturne.text;
export const DEFAULT_PROSE_READER_BACKGROUND_COLOR = PROSE_READER_PALETTES.nocturne.bg;

export function resolveProseReaderPalette(
  theme: string,
  customText = DEFAULT_PROSE_READER_TEXT_COLOR,
  customBackground = DEFAULT_PROSE_READER_BACKGROUND_COLOR,
): ProseReaderPalette {
  if (theme !== "nocturne" && theme in PROSE_READER_PALETTES) {
    return PROSE_READER_PALETTES[theme as ProseReaderThemeId];
  }
  return { text: customText, bg: customBackground, surface: customBackground };
}

export function proseReaderThemeSwatch(theme: ProseReaderThemeId): string {
  return PROSE_READER_PALETTES[theme].bg;
}
