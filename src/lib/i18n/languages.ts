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
  { code: "es" },
  { code: "ja" },
  { code: "zh-CN" },
];

const APP_LANGUAGE_CODES = new Set(APP_LANGUAGE_OPTIONS.map((option) => option.code));
const APP_LANGUAGE_BY_CANONICAL = new Map(
  APP_LANGUAGE_OPTIONS
    .filter((option) => option.code !== APP_LANGUAGE_SYSTEM)
    .map((option) => [option.code.toLowerCase(), option.code]),
);

function canonicalizeLocale(value: string): string {
  const candidate = value.trim().replaceAll("_", "-");
  if (!candidate) return "";
  try {
    return new Intl.Locale(candidate).toString();
  } catch {
    return candidate;
  }
}

export function normalizeAppLanguage(value: unknown): AppLanguageCode {
  if (typeof value !== "string") return APP_LANGUAGE_SYSTEM;
  const trimmed = value.trim();
  if (trimmed === APP_LANGUAGE_SYSTEM) return APP_LANGUAGE_SYSTEM;
  const canonical = canonicalizeLocale(trimmed);
  if (APP_LANGUAGE_CODES.has(canonical)) return canonical;
  return APP_LANGUAGE_BY_CANONICAL.get(canonical.toLowerCase()) ?? APP_LANGUAGE_SYSTEM;
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
  return canonicalizeLocale(browserLocale) || "en";
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
