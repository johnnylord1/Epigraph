/**
 * Suwayomi's restore clears the categories of a library title when the backup brings it without any;
 * Mihon (MangaRestorer.restoreCategories) keeps them. The library is read before the restore and those
 * categories are added back afterwards. Suwayomi also gives an existing category the backup's order, where
 * Mihon (CategoriesRestorer) leaves it alone and appends new ones, so the order is put back the same way.
 * What was read is kept in a ledger until it is applied, so an interruption between the restore and the
 * re-add is repaired when the same backup is restored again.
 *
 * lastPageRead is not aligned: Suwayomi keeps the larger position, Mihon the backup's. Writing it back
 * through updateChapters would stamp lastReadAt with the current time and clamp it to a page count the
 * chapter may not have yet, which would damage history and progress.
 */
export type MangaParityTitle = { sourceId: string; url: string; hasCategories: boolean };

type Request = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const PAGE_SIZE = 500;

const LIBRARY_TITLES = `
  query EpigraphRestoreParityTitles($sourceIds: [LongString!]!, $first: Int!, $offset: Int!) {
    mangas(filter: { sourceId: { in: $sourceIds } }, orderBy: ID, orderByType: ASC, first: $first, offset: $offset) {
      pageInfo { hasNextPage }
      nodes { id sourceId url categories { nodes { id } } }
    }
  }
`;

const ADD_CATEGORIES = `
  mutation EpigraphRestoreParityCategories($mangaId: Int!, $addTo: [Int!]!) {
    updateMangaCategories(input: { id: $mangaId, patch: { addToCategories: $addTo, removeFromCategories: [] } }) {
      manga { id }
    }
  }
`;

const CATEGORY_ORDER = `
  query EpigraphRestoreParityCategoryOrder {
    categories { nodes { id order } }
  }
`;

const MOVE_CATEGORY = `
  mutation EpigraphRestoreParityCategoryPosition($id: Int!, $position: Int!) {
    updateCategoryOrder(input: { id: $id, position: $position }) {
      categories { id order }
    }
  }
`;

type CategoryOrder = { id: number; order: number };

/** Category 0 is Suwayomi's implicit Default, which never moves. Ties keep creation order. */
const sortedCategoryIds = (categories: readonly CategoryOrder[]) => categories.filter(category => category.id > 0)
  .sort((left, right) => left.order - right.order || left.id - right.id).map(category => category.id);

const key = (sourceId: string, url: string) => `${sourceId}|${url}`;

type Existing = { id: number; sourceId: string; url: string; categories?: { nodes?: { id: number }[] } };

export type KeptCategories = { mangaId: number; categoryIds: number[] };

/** The library's category ids in their order before the restore, and the memberships to add back. */
export type MangaParityCapture = { kept: KeptCategories[]; categoryOrder?: number[] };

/** Holds the capture of one backup on one target until it has been applied. */
export type MangaParityLedger = {
  load(): MangaParityCapture;
  save(capture: MangaParityCapture): void;
  clear(): void;
};

const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0) : [];

const LEDGER_KEY = "epigraph.restore.categoryParity.v1";

/** A single pending entry: a newer backup or another target replaces it, since replaying it there would be wrong. */
export function localMangaParityLedger(target: string, backupDigest: string): MangaParityLedger {
  const owns = (value: any) => value?.target === target && value?.backupDigest === backupDigest;
  return {
    load() {
      try {
        const value = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? "null");
        if (!owns(value)) return { kept: [] };
        const kept = Array.isArray(value.kept)
          ? value.kept.filter((entry: any) => Number.isSafeInteger(entry?.mangaId) && Array.isArray(entry.categoryIds))
            .map((entry: any) => ({ mangaId: entry.mangaId, categoryIds: ids(entry.categoryIds) }))
          : [];
        // Entries written before the order was captured have no categoryOrder.
        return Array.isArray(value.categoryOrder) ? { kept, categoryOrder: ids(value.categoryOrder) } : { kept };
      } catch { return { kept: [] }; }
    },
    save(capture) {
      try { localStorage.setItem(LEDGER_KEY, JSON.stringify({ target, backupDigest, ...capture })); } catch { /* the repair still runs in this session */ }
    },
    clear() {
      try { if (owns(JSON.parse(localStorage.getItem(LEDGER_KEY) ?? "null"))) localStorage.removeItem(LEDGER_KEY); } catch { /* nothing to clear */ }
    },
  };
}

const noLedger: MangaParityLedger = { load: () => ({ kept: [] }), save() {}, clear() {} };

/** Reads the categories the restore would clear. Call it before the restore submits anything. */
export async function captureMangaRestoreParity(titles: readonly MangaParityTitle[], request: Request, ledger: MangaParityLedger = noLedger) {
  const uncategorized = new Set(titles.filter(title => !title.hasCategories).map(title => key(title.sourceId, title.url)));
  const sourceIds = [...new Set(titles.filter(title => !title.hasCategories).map(title => title.sourceId))];
  // An earlier, interrupted restore of this backup already cleared and reordered what it captured; keep that capture.
  const pending = ledger.load();
  const byManga = new Map(pending.kept.map(entry => [entry.mangaId, new Set(entry.categoryIds)]));
  const categoryOrder = pending.categoryOrder
    ?? sortedCategoryIds((await request<{ categories: { nodes: CategoryOrder[] } }>(CATEGORY_ORDER)).categories?.nodes ?? []);
  for (let offset = 0; sourceIds.length; offset += PAGE_SIZE) {
    const result = await request<{ mangas: { pageInfo: { hasNextPage: boolean }; nodes: Existing[] } }>(LIBRARY_TITLES, { sourceIds, first: PAGE_SIZE, offset });
    for (const manga of result.mangas?.nodes ?? []) {
      // Category 0 is Suwayomi's implicit Default, not a membership.
      const categoryIds = (manga.categories?.nodes ?? []).map(category => category.id).filter(id => id > 0);
      if (!categoryIds.length || !uncategorized.has(key(String(manga.sourceId), manga.url))) continue;
      const ids = byManga.get(manga.id) ?? new Set<number>();
      for (const id of categoryIds) ids.add(id);
      byManga.set(manga.id, ids);
    }
    if (!result.mangas?.pageInfo?.hasNextPage) break;
  }
  const kept = [...byManga].map(([mangaId, ids]) => ({ mangaId, categoryIds: [...ids] })).filter(entry => entry.categoryIds.length);
  ledger.save({ kept, categoryOrder });

  /** Adds the captured categories back and restores their order; returns warning codes for what could not be applied. */
  return async function applyMangaRestoreParity(): Promise<string[]> {
    // One failure does not skip the rest; the capture stays for the next restore of this backup.
    let failed = false;
    for (const { mangaId, categoryIds } of kept) await request(ADD_CATEGORIES, { mangaId, addTo: categoryIds }).catch(() => { failed = true; });
    await restoreCategoryOrder(categoryOrder, request).catch(() => { failed = true; });
    if (failed) return ["MANGA_RESTORE_CATEGORIES_NOT_KEPT"];
    ledger.clear();
    return [];
  };
}

/** Existing categories keep their earlier order and new ones follow in the order the restore gave them. */
async function restoreCategoryOrder(earlier: readonly number[], request: Request) {
  let categories = (await request<{ categories: { nodes: CategoryOrder[] } }>(CATEGORY_ORDER)).categories?.nodes ?? [];
  let current = sortedCategoryIds(categories);
  const present = new Set(current);
  const wanted = [...earlier.filter(id => present.has(id)), ...current.filter(id => !earlier.includes(id))];
  // Suwayomi renumbers every category from 1 on each move, which also clears duplicate orders.
  let renumbered = categories.filter(category => category.id > 0).sort((left, right) => left.order - right.order)
    .every((category, index) => category.order === index + 1);
  for (const [index, id] of wanted.entries()) {
    if (renumbered && current[index] === id) continue;
    categories = (await request<{ updateCategoryOrder: { categories: CategoryOrder[] } }>(MOVE_CATEGORY, { id, position: index + 1 })).updateCategoryOrder?.categories ?? [];
    current = sortedCategoryIds(categories);
    renumbered = true;
  }
}
