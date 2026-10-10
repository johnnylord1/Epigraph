import en from "../../../messages/en.json";
import { resolveAppLocale } from "./languages";

type Catalog = Record<string, string>;

const FALLBACK_LOCALE = "en";
// English ships with the app shell; every other catalog is its own chunk, loaded when that language is chosen.
const CATALOG_LOADERS: Record<string, () => Promise<{ default: Catalog }>> = {
  "pt-BR": () => import("../../../messages/pt-BR.json"),
  es: () => import("../../../messages/es.json"),
  ja: () => import("../../../messages/ja.json"),
  "zh-CN": () => import("../../../messages/zh-CN.json"),
};
const MESSAGE_LOCALES = new Set<string>([FALLBACK_LOCALE, ...Object.keys(CATALOG_LOADERS)]);
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
const catalogs = new Map<string, Catalog>([[FALLBACK_LOCALE, en]]);
const pendingCatalogs = new Map<string, Promise<void>>();
let activeCatalog: Catalog = en;
let activeMessageLocale = FALLBACK_LOCALE;
let requestedMessageLocale = FALLBACK_LOCALE;
let appliedAppLocale: string | null = null;
let messagesReadyPromise: Promise<void> = Promise.resolve();

function messageKey(id: string) {
  return id.replace(/\./g, "_");
}

function catalogMessage(catalog: Catalog, key: string): string | undefined {
  return Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

export function resolveMessageLocale(appLocale: string): string {
  const canonicalLocale = appLocale.trim().replaceAll("_", "-");
  if (MESSAGE_LOCALES.has(canonicalLocale)) return canonicalLocale;
  const baseLocale = canonicalLocale.split("-")[0]?.toLowerCase() ?? "";
  return MESSAGE_LOCALE_BY_LANGUAGE.get(baseLocale) ?? FALLBACK_LOCALE;
}

export const translate: TranslateFn = (id, options = {}) => {
  const key = messageKey(id);
  const message = catalogMessage(activeCatalog, key) ?? catalogMessage(en, key);
  if (message === undefined) return id;
  const nestedValues = "values" in options ? options.values : undefined;
  const values = (nestedValues && typeof nestedValues === "object"
    ? nestedValues
    : ("values" in options ? {} : options)) as TranslateValues;
  return message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => `${values[name]}`);
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

/** Loads a message catalog without switching to it. */
export function loadMessageLocale(locale: string): Promise<void> {
  if (catalogs.has(locale)) return Promise.resolve();
  const pending = pendingCatalogs.get(locale);
  if (pending) return pending;
  const loader = CATALOG_LOADERS[locale];
  if (!loader) return Promise.resolve();
  const loading = loader()
    .then((module) => { catalogs.set(locale, module.default); })
    .finally(() => pendingCatalogs.delete(locale));
  pendingCatalogs.set(locale, loading);
  return loading;
}

function activateMessageLocale(locale: string) {
  activeMessageLocale = locale;
  activeCatalog = catalogs.get(locale) ?? en;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.appMessageLocale = activeMessageLocale;
  }
  notifySubscribers();
}

/** Settles once the catalog for the last requested language is in use (or failed and English stayed). */
export function messagesReady(): Promise<void> {
  return messagesReadyPromise;
}

/** index.html reads this before any script loads, so the boot screen speaks the app language. */
export const BOOT_MESSAGE_LOCALE_KEY = "epigraph.bootMessageLocale";

function rememberBootMessageLocale(locale: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(BOOT_MESSAGE_LOCALE_KEY, locale);
  } catch {
    // Storage can be unavailable; the boot screen then stays in English.
  }
}

/** The locale last passed through `applyAppLanguage`, or null before the app picks one. */
export function appliedAppLanguage(): string | null {
  return appliedAppLocale;
}

export function applyAppLanguage(language: unknown): string {
  const nextLocale = resolveAppLocale(language);
  const nextMessageLocale = resolveMessageLocale(nextLocale);
  requestedMessageLocale = nextMessageLocale;
  appliedAppLocale = nextLocale;

  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLocale;
    document.documentElement.dir = /^(ar|fa|he|ur)(-|$)/i.test(nextLocale) ? "rtl" : "ltr";
    document.documentElement.dataset.appLocale = nextLocale;
  }
  rememberBootMessageLocale(nextMessageLocale);

  if (catalogs.has(nextMessageLocale)) {
    activateMessageLocale(nextMessageLocale);
    messagesReadyPromise = Promise.resolve();
  } else {
    // Until the catalog arrives the current text stays on screen; a later language choice wins.
    messagesReadyPromise = loadMessageLocale(nextMessageLocale).then(
      () => {
        if (requestedMessageLocale === nextMessageLocale) activateMessageLocale(nextMessageLocale);
      },
      (error: unknown) => {
        console.warn(`Could not load the ${nextMessageLocale} messages; English stays in use.`, error);
        if (requestedMessageLocale === nextMessageLocale && activeMessageLocale !== FALLBACK_LOCALE) {
          activateMessageLocale(FALLBACK_LOCALE);
        }
      },
    );
  }
  return nextLocale;
}

applyAppLanguage("system");
