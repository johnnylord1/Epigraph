import type { BookEntry, BookSectionSummaryItem, BookSpineItem, BookTocItem } from "./types";

function normalizeHrefInput(href: string): string {
  return href.trim().replace(/\\/g, "/");
}

export function normalizeBookHrefKey(href: string): string {
  const input = normalizeHrefInput(href);
  if (!input) return "";

  let normalized = input;
  try {
    if (/^[a-z]+:/i.test(input)) {
      normalized = new URL(input).pathname;
    } else {
      normalized = new URL(input, "https://local.epub/").pathname;
    }
  } catch {
    normalized = input;
  }

  normalized = normalized.split("#")[0]?.split("?")[0] ?? normalized;
  normalized = normalized.replace(/^\/+/, "").replace(/\/+/g, "/");
  return normalized.toLowerCase();
}

function basenameKey(href: string): string {
  const normalized = normalizeBookHrefKey(href);
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export function prettifySectionLabel(label: string, href: string): string {
  const raw = (label && label !== "Untitled" ? label : href.split("/").pop() ?? "Untitled")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  try {
    return decodeURIComponent(raw) || "Untitled";
  } catch {
    return raw || "Untitled";
  }
}

function registerSeenKeys(seen: Set<string>, href: string, label: string) {
  const exactKey = normalizeBookHrefKey(href);
  const baseKey = basenameKey(href);
  const labelKey = normalizeLabel(label);

  if (exactKey) seen.add(`href:${exactKey}`);
  if (baseKey) seen.add(`base:${baseKey}`);
  if (labelKey) seen.add(`label:${labelKey}`);
}

type TocLookup = {
  exact: Map<string, BookTocItem[]>;
  base: Map<string, BookTocItem[]>;
};

const lookupCache = new WeakMap<BookTocItem[], TocLookup>();
const summaryCache = new WeakMap<BookTocItem[], WeakMap<BookSpineItem[], BookSectionSummaryItem[]>>();

function appendLookup(target: Map<string, BookTocItem[]>, key: string, item: BookTocItem) {
  if (!key) return;
  const bucket = target.get(key);
  if (bucket) {
    bucket.push(item);
  } else {
    target.set(key, [item]);
  }
}

function getTocLookup(tocItems: BookTocItem[]): TocLookup {
  const cached = lookupCache.get(tocItems);
  if (cached) return cached;

  const lookup: TocLookup = {
    exact: new Map(),
    base: new Map(),
  };

  for (const item of tocItems) {
    appendLookup(lookup.exact, normalizeBookHrefKey(item.href), item);
    appendLookup(lookup.base, basenameKey(item.href), item);
  }

  lookupCache.set(tocItems, lookup);
  return lookup;
}

function firstUnmatched(items: BookTocItem[] | undefined, matchedIds: Set<string>) {
  if (!items?.length) return null;
  for (const item of items) {
    if (!matchedIds.has(item.id)) return item;
  }
  return null;
}

function findMatchingTocItem(lookup: TocLookup, matchedIds: Set<string>, spineHref: string) {
  const exactMatch = firstUnmatched(lookup.exact.get(normalizeBookHrefKey(spineHref)), matchedIds);
  if (exactMatch) return exactMatch;
  return firstUnmatched(lookup.base.get(basenameKey(spineHref)), matchedIds);
}

export function buildBookSectionSummary(
  toc: BookTocItem[],
  spine: BookSpineItem[],
): BookSectionSummaryItem[] {
  if (!spine.length && !toc.length) return [];

  const cached = summaryCache.get(toc)?.get(spine);
  if (cached) return cached;

  const matchedTocIds = new Set<string>();
  const seenSectionKeys = new Set<string>();
  const sections: BookSectionSummaryItem[] = [];
  const tocLookup = getTocLookup(toc);

  for (const item of spine) {
    const matched = findMatchingTocItem(tocLookup, matchedTocIds, item.href);
    const label = prettifySectionLabel(matched?.label ?? item.label, item.href);
    const summaryItem: BookSectionSummaryItem = {
      id: `spine:${item.id}`,
      label,
      href: item.href,
      depth: matched?.depth ?? 0,
    };

    const exactKey = normalizeBookHrefKey(summaryItem.href);
    const baseKey = basenameKey(summaryItem.href);
    if ((exactKey && seenSectionKeys.has(`href:${exactKey}`)) || (baseKey && seenSectionKeys.has(`base:${baseKey}`))) {
      if (matched) matchedTocIds.add(matched.id);
      continue;
    }

    sections.push(summaryItem);
    registerSeenKeys(seenSectionKeys, summaryItem.href, summaryItem.label);
    if (matched) matchedTocIds.add(matched.id);
  }

  for (const item of toc) {
    if (matchedTocIds.has(item.id)) continue;

    const label = prettifySectionLabel(item.label, item.href);
    const exactKey = normalizeBookHrefKey(item.href);
    const baseKey = basenameKey(item.href);
    const labelKey = normalizeLabel(label);

    if ((exactKey && seenSectionKeys.has(`href:${exactKey}`)) ||
        (baseKey && seenSectionKeys.has(`base:${baseKey}`)) ||
        (!exactKey && !baseKey && labelKey && seenSectionKeys.has(`label:${labelKey}`))) {
      continue;
    }

    const summaryItem: BookSectionSummaryItem = {
      id: `toc:${item.id}`,
      label,
      href: item.href,
      depth: item.depth,
    };
    sections.push(summaryItem);
    registerSeenKeys(seenSectionKeys, summaryItem.href, summaryItem.label);
  }

  let nestedCache = summaryCache.get(toc);
  if (!nestedCache) {
    nestedCache = new WeakMap();
    summaryCache.set(toc, nestedCache);
  }
  nestedCache.set(spine, sections);

  return sections;
}

export function createBookSectionSnapshot(
  toc: BookTocItem[],
  spine: BookSpineItem[],
): Pick<BookEntry, "sectionsSummary" | "sectionCount" | "tocCount" | "spineCount"> {
  const sectionsSummary = buildBookSectionSummary(toc, spine);
  return {
    sectionsSummary,
    sectionCount: sectionsSummary.length,
    tocCount: toc.length,
    spineCount: spine.length,
  };
}

export function needsBookSectionBackfill(
  book: Pick<BookEntry, "toc" | "spine" | "sectionsSummary" | "sectionCount" | "tocCount" | "spineCount">,
): boolean {
  if (!Array.isArray(book.sectionsSummary)) return true;
  if (typeof book.sectionCount !== "number") return true;
  if (typeof book.tocCount !== "number") return true;
  if (typeof book.spineCount !== "number") return true;
  return book.sectionCount !== book.sectionsSummary.length;
}

export function getBookSectionsSummary(
  book: Pick<BookEntry, "toc" | "spine" | "sectionsSummary" | "sectionCount" | "tocCount" | "spineCount">,
): BookSectionSummaryItem[] {
  if (!needsBookSectionBackfill(book)) {
    return book.sectionsSummary ?? [];
  }
  return buildBookSectionSummary(book.toc ?? [], book.spine ?? []);
}

export function getBookSectionCount(
  book: Pick<BookEntry, "toc" | "spine" | "sectionsSummary" | "sectionCount" | "tocCount" | "spineCount">,
): number {
  if (!needsBookSectionBackfill(book)) {
    return book.sectionCount ?? 0;
  }
  return getBookSectionsSummary(book).length;
}

export function findBookSectionIndex(
  sections: BookSectionSummaryItem[],
  href: string | null | undefined,
): number {
  if (!href || !sections.length) return -1;
  const target = normalizeBookHrefKey(href);
  const targetBase = basenameKey(href);
  if (!target) return -1;
  return sections.findIndex((item) => {
    const sectionHref = normalizeBookHrefKey(item.href);
    if (sectionHref === target) return true;
    return !!targetBase && basenameKey(item.href) === targetBase;
  });
}

export function resolveBookSectionLabel(
  sections: BookSectionSummaryItem[],
  href: string | null | undefined,
): string | null {
  const index = findBookSectionIndex(sections, href);
  return index >= 0 ? sections[index]?.label ?? null : href ?? null;
}

export function resolveBookSectionProgress(
  sections: BookSectionSummaryItem[],
  href: string | null | undefined,
): number {
  const index = findBookSectionIndex(sections, href);
  if (index < 0 || sections.length <= 1) return 0;
  return index / (sections.length - 1);
}

export function resolveBookSectionHrefFromProgress(
  sections: BookSectionSummaryItem[],
  progressPercent: number,
): string | null {
  if (!sections.length) return null;
  const index = Math.max(
    0,
    Math.min(sections.length - 1, Math.round(progressPercent * (sections.length - 1))),
  );
  return sections[index]?.href ?? null;
}
