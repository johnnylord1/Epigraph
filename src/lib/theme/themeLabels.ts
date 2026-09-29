import type { BuiltinThemeMetadata } from "./contract";

/** Message keys for builtin theme names; Nocturne and AMOLED are proper names and stay as authored. */
const BUILTIN_THEME_LABEL_KEYS: Readonly<Record<string, string>> = {
  dark: "theme_name_dark",
  "high-contrast": "theme_name_highContrast",
  light: "theme_name_light",
  "light-contrast": "theme_name_lightContrast",
  midnight: "theme_name_midnight",
  warm: "theme_name_warm",
};

export function builtinThemeLabel(theme: Pick<BuiltinThemeMetadata, "id" | "label">, translate: (key: string) => string): string {
  const key = BUILTIN_THEME_LABEL_KEYS[theme.id];
  return key ? translate(key) : theme.label;
}
