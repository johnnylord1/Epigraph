import { getServerUrl, gql } from "../client";
import { UPDATE_CHAPTERS_PROGRESS } from "../queries";
import { createMangaProgressJournal, createMangaProgressPersister, type MangaProgressPersister } from "./mangaProgress";

type ProgressStorage = Pick<Storage, "getItem" | "setItem">;
let scopes = new WeakMap<ProgressStorage, Map<string, MangaProgressPersister>>();

/** One queue per profile/connection, shared by the reader and backup exporter. */
export function getMangaProgressForScope(scope: string, storage: ProgressStorage = localStorage): MangaProgressPersister {
  const endpoint = getServerUrl();
  const key = `${scope}|${endpoint}`;
  const entries = scopes.get(storage) ?? new Map<string, MangaProgressPersister>();
  scopes.set(storage, entries);
  const existing = entries.get(key);
  if (existing) return existing;
  const persister = createMangaProgressPersister({
    journal: createMangaProgressJournal(scope, storage),
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
      return merged;
    },
  });
  entries.set(key, persister);
  return persister;
}

export function resetMangaProgressRuntimeForTests() { scopes = new WeakMap(); }
