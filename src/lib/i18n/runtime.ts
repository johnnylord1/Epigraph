import { getLocale, locales, setLocale } from "../../paraglide/runtime.js";
import { m } from "../../paraglide/messages.js";
import { resolveAppLocale } from "./languages";

const FALLBACK_LOCALE = "en";
const MESSAGE_LOCALES = new Set<string>(locales as readonly string[]);
const MESSAGE_LOCALE_BY_LANGUAGE = new Map<string, string>();
for (const locale of MESSAGE_LOCALES) {
  const language = locale.split("-")[0]?.toLowerCase();
  if (language && !MESSAGE_LOCALE_BY_LANGUAGE.has(language)) {
    MESSAGE_LOCALE_BY_LANGUAGE.set(language, locale);
  }
}

type TranslateValues = Record<string, unknown>;
type TranslateOptions = { values?: TranslateValues };
type TranslateFn = (id: string, options?: TranslateOptions | TranslateValues) => string;
type Subscriber = (translate: TranslateFn) => void;

const subscribers = new Set<Subscriber>();

function messageKey(id: string) {
  return id.replace(/\./g, "_");
}

export function resolveMessageLocale(appLocale: string): string {
  const canonicalLocale = appLocale.trim().replaceAll("_", "-");
  if (MESSAGE_LOCALES.has(canonicalLocale)) return canonicalLocale;
  const baseLocale = canonicalLocale.split("-")[0]?.toLowerCase() ?? "";
  return MESSAGE_LOCALE_BY_LANGUAGE.get(baseLocale) ?? FALLBACK_LOCALE;
}

export const translate: TranslateFn = (id, options = {}) => {
  const key = messageKey(id);
  const message: unknown = Reflect.get(m, key);
  if (typeof message !== "function") return id;
  const nestedValues = "values" in options ? options.values : undefined;
  const values = nestedValues && typeof nestedValues === "object"
    ? nestedValues
    : ("values" in options ? {} : options);
  const translated: unknown = Reflect.apply(message, undefined, [values]);
  return typeof translated === "string" ? translated : String(translated);
};

export const _ = {
  subscribe(run: Subscriber) {
    subscribers.add(run);
    run(translate);
    return () => subscribers.delete(run);
  },
};

function notifySubscribers() {
  subscribers.forEach((run) => run(translate));
}

export function applyAppLanguage(language: unknown): string {
  const nextLocale = resolveAppLocale(language);
  const nextMessageLocale = resolveMessageLocale(nextLocale);
  setLocale(nextMessageLocale as never, { reload: false });

  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLocale;
    document.documentElement.dir = /^(ar|fa|he|ur)(-|$)/i.test(nextLocale) ? "rtl" : "ltr";
    document.documentElement.dataset.appLocale = nextLocale;
    document.documentElement.dataset.appMessageLocale = getLocale();
  }

  notifySubscribers();
  return nextLocale;
}

applyAppLanguage("system");
