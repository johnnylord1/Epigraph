import { getServerUrl, gql } from "../client";
import { UPDATE_CHAPTERS_PROGRESS } from "../queries";
import { createMangaProgressJournal, createMangaProgressPersister, type MangaChapterProgress, type MangaProgressPersister } from "./mangaProgress";

type ProgressStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "key" | "length" | "removeItem">>;
let scopes = new WeakMap<ProgressStorage, Map<string, MangaProgressPersister>>();
let created = new Set<MangaProgressPersister>();

const JOURNAL_PREFIX = "epigraph-manga-pending-progress:";
// Every detached reader window keeps its own pending journal, so two windows never overwrite each other's
// entries. The main window owns the unsuffixed journal and adopts any a closed window left behind.
const DETACHED_JOURNAL_SEPARATOR = "~";
let journalWindowSuffix: string | null = null;
let onProgressSaved: ((scope: string, progress: MangaChapterProgress) => void) | null = null;

export function configureDetachedMangaProgress(
  windowLabel: string,
  savedListener: ((scope: string, progress: MangaChapterProgress) => void) | null,
) {
  journalWindowSuffix = windowLabel;
  onProgressSaved = savedListener;
}

function mergeProgress(entries: MangaChapterProgress[]): MangaChapterProgress[] {
  const merged = new Map<number, MangaChapterProgress>();
  for (const entry of entries) {
    const current = merged.get(entry.chapterId);
    merged.set(entry.chapterId, current
      ? { chapterId: entry.chapterId, lastPageRead: Math.max(current.lastPageRead, entry.lastPageRead), isRead: current.isRead || entry.isRead }
      : { chapterId: entry.chapterId, lastPageRead: entry.lastPageRead, isRead: entry.isRead });
  }
  return [...merged.values()];
}

/** Moves journals that closed detached windows left for this scope into the main journal. */
function adoptDetachedJournals(scope: string, storage: ProgressStorage) {
  if (typeof storage.key !== "function" || typeof storage.removeItem !== "function") return;
  const orphanPrefix = `${JOURNAL_PREFIX}${encodeURIComponent(scope)}${DETACHED_JOURNAL_SEPARATOR}`;
  const orphanKeys: string[] = [];
  for (let index = 0; index < (storage.length ?? 0); index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(orphanPrefix)) orphanKeys.push(key);
  }
  if (!orphanKeys.length) return;
  const journal = createMangaProgressJournal(scope, storage);
  const adopted = [...journal.load()];
  const adoptedKeys: string[] = [];
  for (const key of orphanKeys) {
    try {
      adopted.push(...createMangaProgressJournal(decodeURIComponent(key.slice(JOURNAL_PREFIX.length)), storage).load());
      adoptedKeys.push(key);
    } catch {
      // An unreadable journal stays where it is rather than being dropped.
    }
  }
  journal.save(mergeProgress(adopted));
  for (const key of adoptedKeys) storage.removeItem(key);
}

/** One queue per profile/connection, shared by the reader and backup exporter. */
export function getMangaProgressForScope(scope: string, storage: ProgressStorage = localStorage): MangaProgressPersister {
  const endpoint = getServerUrl();
  const key = `${scope}|${endpoint}`;
  const entries = scopes.get(storage) ?? new Map<string, MangaProgressPersister>();
  scopes.set(storage, entries);
  const existing = entries.get(key);
  if (existing) return existing;
  const journalScope = journalWindowSuffix === null ? scope : `${scope}${DETACHED_JOURNAL_SEPARATOR}${journalWindowSuffix}`;
  if (journalWindowSuffix === null) adoptDetachedJournals(scope, storage);
  const savedListener = onProgressSaved;
  const persister = createMangaProgressPersister({
    journal: createMangaProgressJournal(journalScope, storage),
    write: async (pending) => {
      if (getServerUrl() !== endpoint) throw new Error("Reading progress is waiting for its original connection.");
      const result = await gql<{ chapter: { id: number; lastPageRead: number; isRead: boolean } }>(`
        query GetChapterProgress($id: Int!) { chapter(id: $id) { id lastPageRead isRead } }
      `, { id: pending.chapterId });
      const current = result.chapter;
      if (!current || current.id !== pending.chapterId || !Number.isInteger(current.lastPageRead) || typeof current.isRead !== "boolean") {
        throw new Error("The saved chapter could not be verified. Its pending progress has been kept.");
      }
      const merged = { ...pending, lastPageRead: Math.max(pending.lastPageRead, current.lastPageRead), isRead: pending.isRead || current.isRead };
      if (merged.lastPageRead !== current.lastPageRead || merged.isRead !== current.isRead) {
        if (getServerUrl() !== endpoint) throw new Error("The reading connection changed before progress was saved.");
        await gql(UPDATE_CHAPTERS_PROGRESS, { ids: [pending.chapterId], lastPageRead: merged.lastPageRead, isRead: merged.isRead });
      }
      savedListener?.(scope, merged);
      return merged;
    },
  });
  entries.set(key, persister);
  created.add(persister);
  return persister;
}

/** Opens the main window's queue for the connection it just attached to, so progress an earlier session could not
 * save (including what closed detached windows left) is retried without waiting for a reader to open. */
export function resumePendingMangaProgress(profileId: string | null | undefined, storage: ProgressStorage = localStorage) {
  if (journalWindowSuffix !== null) return;
  getMangaProgressForScope(profileId ? `profile:${profileId}` : `server:${getServerUrl()}`, storage);
}

/** Takes over the journal a detached window left when it closed while Suwayomi was away, so this window's queue
 * retries that progress at once instead of waiting for the next reader to open. */
export function adoptClosedWindowMangaProgress(windowLabel: string, storage: ProgressStorage = localStorage) {
  if (journalWindowSuffix !== null || typeof storage.key !== "function" || typeof storage.removeItem !== "function") return;
  const entries = scopes.get(storage);
  if (!entries) return;
  const suffix = `${DETACHED_JOURNAL_SEPARATOR}${encodeURIComponent(windowLabel)}`;
  const keys: string[] = [];
  for (let index = 0; index < (storage.length ?? 0); index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(JOURNAL_PREFIX) && key.endsWith(suffix)) keys.push(key);
  }
  for (const key of keys) {
    const scope = decodeURIComponent(key.slice(JOURNAL_PREFIX.length, key.length - suffix.length));
    // Without a queue for this scope yet, the journal is adopted when that queue is created.
    const persister = entries.get(`${scope}|${getServerUrl()}`);
    if (!persister) continue;
    let pending: MangaChapterProgress[];
    try {
      pending = createMangaProgressJournal(`${scope}${DETACHED_JOURNAL_SEPARATOR}${windowLabel}`, storage).load();
    } catch {
      continue;
    }
    for (const progress of pending) persister.record(progress.chapterId, progress.lastPageRead, progress.isRead);
    storage.removeItem(key);
  }
}

/** Saves every queued chapter this window recorded, for a detached reader that is about to close. */
export async function flushAllMangaProgress(): Promise<void> {
  await Promise.allSettled([...created].map((persister) => persister.flushAll()));
}

export function resetMangaProgressRuntimeForTests() {
  scopes = new WeakMap();
  created = new Set();
  journalWindowSuffix = null;
  onProgressSaved = null;
}
