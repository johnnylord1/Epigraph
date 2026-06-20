export const APP_LANGUAGE_SYSTEM = "system";

export type AppLanguageCode = typeof APP_LANGUAGE_SYSTEM | string;

export interface AppLanguageOption {
  code: AppLanguageCode;
  region?: string;
}

export const APP_LANGUAGE_OPTIONS: AppLanguageOption[] = [
  { code: APP_LANGUAGE_SYSTEM },
  { code: "en" },
  { code: "pt-BR" },
  { code: "pt-PT" },
  { code: "es" },
  { code: "es-419" },
  { code: "fr" },
  { code: "de" },
  { code: "it" },
  { code: "nl" },
  { code: "sv" },
  { code: "da" },
  { code: "no" },
  { code: "fi" },
  { code: "is" },
  { code: "pl" },
  { code: "cs" },
  { code: "sk" },
  { code: "sl" },
  { code: "hr" },
  { code: "sr" },
  { code: "bg" },
  { code: "ro" },
  { code: "hu" },
  { code: "el" },
  { code: "tr" },
  { code: "uk" },
  { code: "ru" },
  { code: "kk" },
  { code: "ar" },
  { code: "he" },
  { code: "fa" },
  { code: "ur" },
  { code: "hi" },
  { code: "bn" },
  { code: "ta" },
  { code: "te" },
  { code: "mr" },
  { code: "gu" },
  { code: "kn" },
  { code: "ml" },
  { code: "th" },
  { code: "vi" },
  { code: "id" },
  { code: "ms" },
  { code: "fil" },
  { code: "ja" },
  { code: "ko" },
  { code: "zh-CN" },
  { code: "zh-TW" },
  { code: "zh-HK" },
  { code: "sw" },
  { code: "af" },
  { code: "am" },
  { code: "az" },
  { code: "ca" },
  { code: "et" },
  { code: "eu" },
  { code: "gl" },
  { code: "ka" },
  { code: "lt" },
  { code: "lv" },
  { code: "mk" },
  { code: "mn" },
  { code: "sq" },
  { code: "cy" },
  { code: "ga" },
  { code: "mt" },
];

const APP_LANGUAGE_CODES = new Set(APP_LANGUAGE_OPTIONS.map((option) => option.code));

export function normalizeAppLanguage(value: unknown): AppLanguageCode {
  if (typeof value !== "string") return APP_LANGUAGE_SYSTEM;
  const trimmed = value.trim();
  return APP_LANGUAGE_CODES.has(trimmed) ? trimmed : APP_LANGUAGE_SYSTEM;
}

export function resolveAppLocale(value: unknown): string {
  const normalized = normalizeAppLanguage(value);
  if (normalized !== APP_LANGUAGE_SYSTEM) return normalized;
  const browserLocale =
    typeof navigator !== "undefined" && Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages[0]
      : typeof navigator !== "undefined"
        ? navigator.language
        : "";
  return browserLocale || "en";
}

export function appLanguageLabel(code: AppLanguageCode, currentLocale: string, systemLabel: string): string {
  if (code === APP_LANGUAGE_SYSTEM) return systemLabel;
  try {
    const locale = new Intl.Locale(code);
    const displayNames = new Intl.DisplayNames([currentLocale || "en"], { type: "language" });
    const regionNames = new Intl.DisplayNames([currentLocale || "en"], { type: "region" });
    const language = displayNames.of(locale.language) ?? code;
    const region = locale.region ? regionNames.of(locale.region) : "";
    return region ? `${language} (${region})` : language;
  } catch {
    return code;
  }
}
