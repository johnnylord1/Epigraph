import { getLocale, locales, setLocale } from "../../paraglide/runtime.js";
import { m } from "../../paraglide/messages.js";
import { resolveAppLocale } from "./languages";

const FALLBACK_LOCALE = "en";
const MESSAGE_LOCALES = new Set<string>(locales as readonly string[]);

type TranslateValues = Record<string, unknown>;
type TranslateOptions = { values?: TranslateValues };
type TranslateFn = (id: string, options?: TranslateOptions | TranslateValues) => string;
type Subscriber = (translate: TranslateFn) => void;

const subscribers = new Set<Subscriber>();

function messageKey(id: string) {
  return id.replace(/\./g, "_");
}

export function resolveMessageLocale(appLocale: string): string {
  if (MESSAGE_LOCALES.has(appLocale)) return appLocale;
  const baseLocale = appLocale.split("-")[0] ?? "";
  return MESSAGE_LOCALES.has(baseLocale) ? baseLocale : FALLBACK_LOCALE;
}

export const translate: TranslateFn = (id, options = {}) => {
  const key = messageKey(id);
  const fn = (m as Record<string, ((inputs?: TranslateValues) => string) | undefined>)[key];
  if (!fn) return id;
  const values = "values" in options ? options.values ?? {} : options;
  return fn(values);
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
