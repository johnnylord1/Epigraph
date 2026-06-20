import { addMessages, init, locale } from "svelte-i18n";
import { APP_I18N_MESSAGES } from "./messages";
import { resolveAppLocale } from "./languages";

const FALLBACK_LOCALE = "en";
const MESSAGE_LOCALES = new Set(Object.keys(APP_I18N_MESSAGES));
let initialized = false;

for (const [messageLocale, messages] of Object.entries(APP_I18N_MESSAGES)) {
  addMessages(messageLocale, messages);
}

function resolveMessageLocale(appLocale: string): string {
  if (MESSAGE_LOCALES.has(appLocale)) return appLocale;
  const baseLocale = appLocale.split("-")[0] ?? "";
  return MESSAGE_LOCALES.has(baseLocale) ? baseLocale : FALLBACK_LOCALE;
}

export function applyAppLanguage(language: unknown): string {
  const nextLocale = resolveAppLocale(language);
  const nextMessageLocale = resolveMessageLocale(nextLocale);

  if (!initialized) {
    init({
      fallbackLocale: FALLBACK_LOCALE,
      initialLocale: nextMessageLocale,
    });
    initialized = true;
  } else {
    locale.set(nextMessageLocale);
  }

  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLocale;
    document.documentElement.dataset.appLocale = nextLocale;
    document.documentElement.dataset.appMessageLocale = nextMessageLocale;
  }

  return nextLocale;
}
applyAppLanguage("system");
