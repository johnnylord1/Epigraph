import { APP_LANGUAGE_OPTIONS, APP_LANGUAGE_SYSTEM } from "../lib/i18n/languages";
import { loadMessageLocale } from "../lib/i18n/runtime";

// The app loads a language's messages when it is chosen; tests switch languages synchronously, so all are loaded first.
await Promise.all(
  APP_LANGUAGE_OPTIONS
    .filter((option) => option.code !== APP_LANGUAGE_SYSTEM)
    .map((option) => loadMessageLocale(option.code)),
);
