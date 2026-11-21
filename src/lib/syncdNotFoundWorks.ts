import { gql } from "./client";
import { GET_SOURCES } from "./queries";
import { syncdGetSyncProgressIfRunning, type SyncdNotFoundWork } from "./syncdDesktop";

/** A work a paired device synced that this computer could not find, ready to list. */
export interface NotFoundWorkView {
  key: string;
  title: string;
  /** The installed source's name, or null when this computer has no such source. */
  sourceName: string | null;
  changes: number;
}

/**
 * A readable title from a source's work key, which is all the Core keeps for a work it could not
 * find: the last path segment with dashes as spaces. A leading or trailing id segment that mixes
 * letters and digits ("e13w8-shadow-slave") is dropped, as sources add those to make keys unique.
 */
export function notFoundWorkTitle(mangaKey: string): string {
  const path = mangaKey.split(/[?#]/, 1)[0];
  const segment = path.split("/").filter(Boolean).at(-1) ?? "";
  const words = segment.split(/[-_]+/).filter(Boolean);
  const isId = (word: string) => /\d/.test(word) && /[a-z]/i.test(word);
  if (words.length > 1 && isId(words[0])) words.shift();
  if (words.length > 1 && isId(words[words.length - 1])) words.pop();
  const title = words.join(" ");
  if (!title) return mangaKey;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function notFoundWorkViews(works: readonly SyncdNotFoundWork[], sourceNames: ReadonlyMap<string, string>): NotFoundWorkView[] {
  return works.map((work) => ({
    key: `${work.sourceId}:${work.mangaKey}`,
    title: notFoundWorkTitle(work.mangaKey),
    sourceName: sourceNames.get(work.sourceId) ?? null,
    changes: work.changes,
  }));
}

/**
 * The works waiting on this computer, named after the installed sources. Empty while the Core is
 * not running or an older Core does not report them; source names are left out when Suwayomi is
 * not answering, as the list still helps without them.
 */
export async function loadNotFoundWorks(): Promise<NotFoundWorkView[]> {
  const progress = await syncdGetSyncProgressIfRunning();
  const works = progress?.notFoundWorks ?? [];
  if (works.length === 0) return [];
  const sourceNames = new Map<string, string>();
  try {
    const response = await gql<{ sources: { nodes: { id: string; displayName: string }[] } }>(GET_SOURCES);
    for (const source of response.sources.nodes) sourceNames.set(String(source.id), source.displayName);
  } catch {
    // Listed without source names.
  }
  return notFoundWorkViews(works, sourceNames);
}
