export type ReaderKind = "manga" | "novel" | "book";

/** Brightness is stored per reader so dimming one reader never dims another. */
export const READER_BRIGHTNESS_SETTING_KEY = {
  manga: "readerBrightness",
  novel: "novelReaderBrightness",
  book: "bookReaderBrightness",
} as const satisfies Record<ReaderKind, string>;

/** Zoom is only meaningful for image readers; manga and PDF clamp to different ranges. */
export const READER_ZOOM_SETTING_KEY = {
  manga: "readerZoom",
  book: "bookReaderZoom",
} as const;

/** Prose typography is kept separately for web novels and EPUB/PDF-reflow books. */
export const PROSE_READER_SETTING_KEYS = {
  novel: {
    fontSize: "proseReaderFontSize",
    fontFamily: "proseReaderFontFamily",
    lineHeight: "proseReaderLineHeight",
    paragraphSpacing: "proseReaderParagraphSpacing",
    contentWidth: "proseReaderContentWidth",
    textColor: "proseReaderTextColor",
    backgroundColor: "proseReaderBackgroundColor",
    theme: "proseReaderTheme",
    textAlign: "proseReaderTextAlign",
    fullWidth: "proseReaderFullWidth",
  },
  book: {
    fontSize: "bookProseReaderFontSize",
    fontFamily: "bookProseReaderFontFamily",
    lineHeight: "bookProseReaderLineHeight",
    paragraphSpacing: "bookProseReaderParagraphSpacing",
    contentWidth: "bookProseReaderContentWidth",
    textColor: "bookProseReaderTextColor",
    backgroundColor: "bookProseReaderBackgroundColor",
    theme: "bookProseReaderTheme",
    textAlign: "bookProseReaderTextAlign",
    fullWidth: "bookProseReaderFullWidth",
  },
} as const;

/**
 * Settings that used to be shared between readers, mapped to the legacy key they are
 * seeded from. Seeding keeps each reader looking exactly as before the split.
 */
export const SPLIT_READER_SETTING_SEEDS = {
  novelReaderBrightness: "readerBrightness",
  bookReaderBrightness: "readerBrightness",
  bookReaderZoom: "readerZoom",
  ...Object.fromEntries(
    Object.keys(PROSE_READER_SETTING_KEYS.book).map((name) => [
      PROSE_READER_SETTING_KEYS.book[name as keyof typeof PROSE_READER_SETTING_KEYS.book],
      PROSE_READER_SETTING_KEYS.novel[name as keyof typeof PROSE_READER_SETTING_KEYS.novel],
    ]),
  ),
} as Readonly<Record<string, string>>;

/** Fills missing per-reader keys from their legacy shared value; never overwrites. */
export function seedSplitReaderSettings<T extends object>(record: T): T {
  const source = record as Record<string, unknown>;
  let seeded: Record<string, unknown> | null = null;
  for (const [key, legacyKey] of Object.entries(SPLIT_READER_SETTING_SEEDS)) {
    if (key in source || !(legacyKey in source)) continue;
    seeded ??= { ...source };
    seeded[key] = source[legacyKey];
  }
  return (seeded ?? record) as T;
}
