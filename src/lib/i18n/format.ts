import { translate } from "./runtime";

/** The locale applied by `applyAppLanguage`, so dates follow the selected app language. */
export function currentAppLocale(): string {
  if (typeof document !== "undefined" && document.documentElement.lang) return document.documentElement.lang;
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en";
}

export function formatAppDate(value: number | Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(currentAppLocale(), options).format(value);
}

/** "just now", "5 minutes ago", "yesterday"… in the app language; older dates fall back to a short date. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return translate("time.justNow");
  const relative = new Intl.RelativeTimeFormat(currentAppLocale(), { numeric: "auto", style: "short" });
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return relative.format(-days, "day");
  return formatAppDate(timestamp, { month: "short", day: "numeric" });
}

/** "Today", "Yesterday" or a long weekday date in the app language. */
export function formatDayLabel(timestamp: number, now = new Date()): string {
  const day = new Date(timestamp);
  if (day.toDateString() === now.toDateString()) return translate("time.today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day.toDateString() === yesterday.toDateString()) return translate("time.yesterday");
  return formatAppDate(day, { weekday: "long", month: "long", day: "numeric" });
}

/** Localized label for a raw work status such as `ONGOING` or `on_hiatus`. */
export function formatWorkStatus(status: string | null | undefined): string {
  const normalized = status?.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return translate("library.status.unknown");
  const statusKey = normalized.toLowerCase().replace(/\s+/g, "_");
  const translatedStatus = {
    ongoing: "library.status.ongoing",
    completed: "library.status.completed",
    finished: "library.collections.finished",
    publishing_finished: "library.status.completed",
    cancelled: "library.status.cancelled",
    hiatus: "library.status.hiatus",
    on_hiatus: "library.status.hiatus",
    unknown: "library.status.unknown",
  }[statusKey];
  if (translatedStatus) return translate(translatedStatus);
  return normalized
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
