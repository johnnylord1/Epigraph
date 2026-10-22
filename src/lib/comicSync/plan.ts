/**
 * Decides how two desktops' Suwayomi libraries become the same. Each run compares both sides with
 * what they held together after the previous run (the baseline): something only one side has was
 * either added there or removed on the other, and the baseline tells which.
 */

/** A work is the same on both desktops when its source and its key in that source match. */
export type ComicKey = string;

export function comicKey(sourceId: string, url: string): ComicKey {
  return JSON.stringify([String(sourceId), url]);
}

export interface ComicWork {
  id: number;
  sourceId: string;
  url: string;
  title: string;
  /** Category names, without the default category. */
  categories: string[];
  /** Changes when the work's reading state may have changed, so its chapters are compared again. */
  digest: string;
}

export interface ComicChapterState {
  id: number;
  isRead: boolean;
  isBookmarked: boolean;
  lastPageRead: number;
  lastReadAt: number;
}

/** isRead, isBookmarked, lastPageRead. */
export type ChapterTriple = [boolean, boolean, number];

export interface ComicSyncBaseline {
  version: 1;
  library: ComicKey[];
  categories: string[];
  assignments: Record<ComicKey, string[]>;
  /** Per work both sides held, its chapters that are not unread, unbookmarked and unopened. */
  chapters: Record<ComicKey, Record<string, ChapterTriple>>;
  /** Per work, both sides' digests when its chapters were last compared. */
  digests: Record<ComicKey, string>;
  sweptAt: number;
}

export function emptyBaseline(): ComicSyncBaseline {
  return { version: 1, library: [], categories: [], assignments: {}, chapters: {}, digests: {}, sweptAt: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isTriple(value: unknown): value is ChapterTriple {
  return Array.isArray(value) && value.length === 3 && typeof value[0] === "boolean"
    && typeof value[1] === "boolean" && Number.isSafeInteger(value[2]);
}

/** A baseline written by another version, or damaged, counts as none: the next run only merges. */
export function parseBaseline(value: unknown): ComicSyncBaseline | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const assignments: Record<ComicKey, string[]> = {};
  if (isRecord(value.assignments)) {
    for (const [key, names] of Object.entries(value.assignments)) assignments[key] = stringList(names);
  }
  const chapters: Record<ComicKey, Record<string, ChapterTriple>> = {};
  if (isRecord(value.chapters)) {
    for (const [key, entries] of Object.entries(value.chapters)) {
      if (!isRecord(entries)) continue;
      chapters[key] = {};
      for (const [url, triple] of Object.entries(entries)) if (isTriple(triple)) chapters[key][url] = triple;
    }
  }
  const digests: Record<ComicKey, string> = {};
  if (isRecord(value.digests)) {
    for (const [key, digest] of Object.entries(value.digests)) if (typeof digest === "string") digests[key] = digest;
  }
  return {
    version: 1,
    library: stringList(value.library),
    categories: stringList(value.categories),
    assignments,
    chapters,
    digests,
    sweptAt: typeof value.sweptAt === "number" ? value.sweptAt : 0,
  };
}

/**
 * Removals on one side are applied to the other only while they look like someone's edits. A side
 * that suddenly lists nothing, or lost most of a large library, was more likely reset or failed to
 * load, so its missing works are added back instead.
 */
function removalsLookIntentional(removed: number, sideSize: number, baselineSize: number): boolean {
  if (removed === 0) return true;
  if (sideSize === 0 && baselineSize >= 3) return false;
  return !(removed > 10 && removed * 2 > removed + sideSize);
}

export interface LibraryPlan {
  /** Works the other desktop has that this one gets. */
  addLocal: ComicWork[];
  /** Works this desktop has that the other one gets. */
  addRemote: ComicWork[];
  removeLocal: ComicWork[];
  removeRemote: ComicWork[];
}

export function planLibrary(
  local: ReadonlyMap<ComicKey, ComicWork>,
  remote: ReadonlyMap<ComicKey, ComicWork>,
  baseline: ComicSyncBaseline | null,
): LibraryPlan {
  const known = new Set(baseline?.library ?? []);
  const onlyLocal = [...local.entries()].filter(([key]) => !remote.has(key));
  const onlyRemote = [...remote.entries()].filter(([key]) => !local.has(key));
  // Only here and known together before: the other desktop removed it.
  const removedRemotely = onlyLocal.filter(([key]) => known.has(key));
  const removedLocally = onlyRemote.filter(([key]) => known.has(key));
  const honorRemote = removalsLookIntentional(removedRemotely.length, remote.size, known.size);
  const honorLocal = removalsLookIntentional(removedLocally.length, local.size, known.size);
  return {
    addRemote: onlyLocal.filter(([key]) => !known.has(key) || !honorRemote).map(([, work]) => work),
    addLocal: onlyRemote.filter(([key]) => !known.has(key) || !honorLocal).map(([, work]) => work),
    removeLocal: honorRemote ? removedRemotely.map(([, work]) => work) : [],
    removeRemote: honorLocal ? removedLocally.map(([, work]) => work) : [],
  };
}

export interface CategoryPlan {
  createLocal: string[];
  createRemote: string[];
  deleteLocal: string[];
  deleteRemote: string[];
  /** The categories both sides hold once the plan is applied. */
  names: string[];
}

export function planCategories(
  local: ReadonlySet<string>,
  remote: ReadonlySet<string>,
  baseline: ComicSyncBaseline | null,
): CategoryPlan {
  const known = new Set(baseline?.categories ?? []);
  const onlyLocal = [...local].filter((name) => !remote.has(name));
  const onlyRemote = [...remote].filter((name) => !local.has(name));
  const honorRemote = removalsLookIntentional(onlyLocal.filter((name) => known.has(name)).length, remote.size, known.size);
  const honorLocal = removalsLookIntentional(onlyRemote.filter((name) => known.has(name)).length, local.size, known.size);
  const plan: CategoryPlan = { createLocal: [], createRemote: [], deleteLocal: [], deleteRemote: [], names: [] };
  for (const name of onlyLocal) {
    if (known.has(name) && honorRemote) plan.deleteLocal.push(name);
    else plan.createRemote.push(name);
  }
  for (const name of onlyRemote) {
    if (known.has(name) && honorLocal) plan.deleteRemote.push(name);
    else plan.createLocal.push(name);
  }
  const deleted = new Set([...plan.deleteLocal, ...plan.deleteRemote]);
  plan.names = [...new Set([...local, ...remote])].filter((name) => !deleted.has(name)).sort();
  return plan;
}

/** The categories a work both sides hold ends up in. */
export function mergeAssignments(
  localNames: readonly string[],
  remoteNames: readonly string[],
  baselineNames: readonly string[] | undefined,
  categories: ReadonlySet<string>,
): string[] {
  const local = new Set(localNames);
  const remote = new Set(remoteNames);
  const known = baselineNames ? new Set(baselineNames) : null;
  const merged: string[] = [];
  for (const name of new Set([...local, ...remote])) {
    if (!categories.has(name)) continue;
    // In both, or added on one side; one held before and missing on the other side was removed there.
    if ((local.has(name) && remote.has(name)) || !known?.has(name)) merged.push(name);
  }
  return merged.sort();
}

function tripleOf(chapter: ComicChapterState): ChapterTriple {
  return [chapter.isRead, chapter.isBookmarked, chapter.lastPageRead];
}

function isDefaultTriple(triple: ChapterTriple): boolean {
  return !triple[0] && !triple[1] && triple[2] === 0;
}

export interface ChapterUpdate {
  id: number;
  value: ChapterTriple;
}

export interface ChapterPlan {
  localUpdates: ChapterUpdate[];
  remoteUpdates: ChapterUpdate[];
  /** The new baseline for this work. */
  merged: Record<string, ChapterTriple>;
}

/**
 * Merges one work's chapters, matched by their key in the source. Each field takes the side that
 * changed it since the baseline; when both changed it, the side that read the chapter last wins.
 * Without a baseline, read and bookmarked marks are kept from either side.
 */
export function planChapters(
  local: ReadonlyMap<string, ComicChapterState>,
  remote: ReadonlyMap<string, ComicChapterState>,
  baseline: Readonly<Record<string, ChapterTriple>> | undefined,
): ChapterPlan {
  const plan: ChapterPlan = { localUpdates: [], remoteUpdates: [], merged: {} };
  for (const [url, mine] of local) {
    const theirs = remote.get(url);
    if (!theirs) continue;
    const l = tripleOf(mine);
    const r = tripleOf(theirs);
    const localNewer = mine.lastReadAt >= theirs.lastReadAt;
    const base = baseline ? (baseline[url] ?? [false, false, 0] as ChapterTriple) : null;
    const pick = <T extends boolean | number>(index: 0 | 1 | 2, lv: T, rv: T): T => {
      if (lv === rv) return lv;
      if (base) {
        if (lv === base[index]) return rv;
        if (rv === base[index]) return lv;
        return localNewer ? lv : rv;
      }
      if (typeof lv === "boolean") return (lv || rv) as T;
      return mine.lastReadAt === theirs.lastReadAt ? (Math.max(lv as number, rv as number) as T) : localNewer ? lv : rv;
    };
    const next: ChapterTriple = [pick(0, l[0], r[0]), pick(1, l[1], r[1]), pick(2, l[2], r[2])];
    if (next.some((value, index) => value !== l[index])) plan.localUpdates.push({ id: mine.id, value: next });
    if (next.some((value, index) => value !== r[index])) plan.remoteUpdates.push({ id: theirs.id, value: next });
    if (!isDefaultTriple(next)) plan.merged[url] = next;
  }
  return plan;
}

export interface ChapterProgressBatch {
  ids: number[];
  isRead: boolean;
  isBookmarked: boolean;
  lastPageRead: number;
}

/** Chapters getting the same state share a write, at most 250 at a time as the Core accepts. */
export function batchChapterUpdates(updates: readonly ChapterUpdate[], size = 250): ChapterProgressBatch[] {
  const groups = new Map<string, ChapterUpdate[]>();
  for (const update of updates) {
    const key = update.value.join(":");
    groups.set(key, [...(groups.get(key) ?? []), update]);
  }
  const batches: ChapterProgressBatch[] = [];
  for (const group of groups.values()) {
    const [isRead, isBookmarked, lastPageRead] = group[0].value;
    for (let start = 0; start < group.length; start += size) {
      batches.push({ ids: group.slice(start, start + size).map((update) => update.id), isRead, isBookmarked, lastPageRead });
    }
  }
  return batches;
}
