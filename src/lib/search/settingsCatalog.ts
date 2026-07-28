import type { SearchSettingsEntry } from "./types";

type SettingsCatalogEntry = Omit<SearchSettingsEntry, "groupLabel" | "title" | "description"> & {
  groupKey: string;
  titleKey: string;
  descriptionKey: string;
};

export const SETTINGS_SEARCH_KEYWORDS: Record<SearchSettingsEntry["tab"], string[]> = {
  general: ["interface scale", "profile", "server", "autostart", "idle", "discord", "language", "startup", "zoom"],
  appearance: ["theme", "oled", "amoled", "accent", "visual", "surface", "custom themes", "editor"],
  keybinds: ["keyboard", "shortcuts", "bindings", "keys", "reset"],
  reader: ["reading", "direction", "fit", "zoom", "page style", "bookmarks", "epub", "pdf", "manga", "novel"],
  library: ["density", "layout", "cards", "library", "books", "browse"],
  folders: ["categories", "folders", "hidden", "books categories", "assignments", "collections"],
  content: ["blocked tags", "nsfw", "sources", "allowed", "blocked", "repositories", "extensions"],
  tracking: ["tracker", "oauth", "credentials", "sync", "anilist", "mal", "myanimelist", "hardcover", "provider"],
  storage: ["downloads", "paths", "backup", "restore", "reconciliation", "scan", "disk", "offline", "cache"],
  performance: ["gpu", "render", "prefetch", "cache", "performance", "webview", "memory", "cpu"],
  security: ["pin", "proxy", "auth", "socks", "flaresolverr", "security", "syncd", "pairing", "tls", "mdns"],
  about: ["version", "release", "update", "github", "discord", "about"],
  devtools: ["debug", "splash", "dev", "build info", "tools", "diagnostics"],
};

export const SETTINGS_SEARCH_CATALOG: SettingsCatalogEntry[] = [
  { id: "settings-general", tab: "general", group: "app", groupKey: "settings.nav.app", titleKey: "settings.nav.general", descriptionKey: "settings.desc.general", keywords: SETTINGS_SEARCH_KEYWORDS.general },
  { id: "settings-appearance", tab: "appearance", group: "app", groupKey: "settings.nav.app", titleKey: "settings.nav.appearance", descriptionKey: "settings.desc.appearance", keywords: SETTINGS_SEARCH_KEYWORDS.appearance },
  { id: "settings-keybinds", tab: "keybinds", group: "app", groupKey: "settings.nav.app", titleKey: "settings.nav.keybinds", descriptionKey: "settings.desc.keybinds", keywords: SETTINGS_SEARCH_KEYWORDS.keybinds },
  { id: "settings-reader", tab: "reader", group: "reader-library", groupKey: "settings.nav.readerLibrary", titleKey: "settings.nav.reader", descriptionKey: "settings.desc.reader", keywords: SETTINGS_SEARCH_KEYWORDS.reader },
  { id: "settings-library", tab: "library", group: "reader-library", groupKey: "settings.nav.readerLibrary", titleKey: "settings.nav.library", descriptionKey: "settings.desc.library", keywords: SETTINGS_SEARCH_KEYWORDS.library },
  { id: "settings-categories", tab: "folders", group: "reader-library", groupKey: "settings.nav.readerLibrary", titleKey: "settings.nav.categories", descriptionKey: "settings.desc.categories", keywords: SETTINGS_SEARCH_KEYWORDS.folders },
  { id: "settings-content", tab: "content", group: "content", groupKey: "settings.nav.contentIntegrations", titleKey: "settings.nav.content", descriptionKey: "settings.desc.content", keywords: SETTINGS_SEARCH_KEYWORDS.content },
  { id: "settings-tracking", tab: "tracking", group: "content", groupKey: "settings.nav.contentIntegrations", titleKey: "settings.nav.tracking", descriptionKey: "settings.desc.tracking", keywords: SETTINGS_SEARCH_KEYWORDS.tracking },
  { id: "settings-storage", tab: "storage", group: "system", groupKey: "settings.nav.system", titleKey: "settings.nav.storage", descriptionKey: "settings.desc.storage", keywords: SETTINGS_SEARCH_KEYWORDS.storage },
  { id: "settings-performance", tab: "performance", group: "system", groupKey: "settings.nav.system", titleKey: "settings.nav.performance", descriptionKey: "settings.desc.performance", keywords: SETTINGS_SEARCH_KEYWORDS.performance },
  { id: "settings-security", tab: "security", group: "system", groupKey: "settings.nav.system", titleKey: "settings.nav.security", descriptionKey: "settings.desc.security", keywords: SETTINGS_SEARCH_KEYWORDS.security },
  { id: "settings-about", tab: "about", group: "advanced", groupKey: "settings.nav.advanced", titleKey: "settings.nav.about", descriptionKey: "settings.desc.about", keywords: SETTINGS_SEARCH_KEYWORDS.about },
  { id: "settings-devtools", tab: "devtools", group: "advanced", groupKey: "settings.nav.advanced", titleKey: "settings.nav.devtools", descriptionKey: "settings.desc.devtools", keywords: SETTINGS_SEARCH_KEYWORDS.devtools },
];
