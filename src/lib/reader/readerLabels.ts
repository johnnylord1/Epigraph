/** Message keys for reader setting values shown in HUD summaries; values without a key are proper names. */
export const PROSE_THEME_LABEL_KEYS: Readonly<Record<string, string>> = {
  nocturne: "ui_nocturne",
  dark: "ui_dark",
  sepia: "ui_sepia",
  light: "ui_light",
  oled: "ui_oled",
  slate: "settings_reader_themeSlate",
  forest: "settings_reader_themeForest",
  warm: "settings_reader_themeWarm",
};

export const PDF_FIT_LABEL_KEYS: Readonly<Record<string, string>> = {
  width: "ui_width",
  page: "settings_reader_pdfFitPage",
  actual: "settings_reader_pdfFitActual",
};

/** Localized label for a reader setting value, falling back to the value itself (e.g. "Nord"). */
export function readerValueLabel(
  keys: Readonly<Record<string, string>>,
  value: string,
  translate: (key: string) => string,
): string {
  const key = keys[value];
  return key ? translate(key) : value.charAt(0).toUpperCase() + value.slice(1);
}
