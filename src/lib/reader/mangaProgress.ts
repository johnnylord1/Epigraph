export interface MangaChapterProgress {
  chapterId: number;
  lastPageRead: number;
  isRead: boolean;
}

interface MangaProgressPersisterOptions {
  delayMs?: number;
  /** First wait before a failed save is tried again; it doubles up to a minute while the server stays away. */
  retryDelayMs?: number;
  write: (progress: MangaChapterProgress) => Promise<MangaChapterProgress | void>;
  journal?: MangaProgressJournal;
}

interface MangaProgressJournal {
  load(): MangaChapterProgress[];
  save(progress: MangaChapterProgress[]): void;
}

export function createMangaProgressJournal(
  scope: string,
  storage: Pick<Storage, "getItem" | "setItem">,
): MangaProgressJournal {
  const key = `epigraph-manga-pending-progress:${encodeURIComponent(scope)}`;
  return {
    load() {
      const value = storage.getItem(key);
      if (!value) return [];
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some((entry) => !entry
        || !Number.isSafeInteger(entry.chapterId) || entry.chapterId < 0
        || !Number.isSafeInteger(entry.lastPageRead) || entry.lastPageRead < 0
        || typeof entry.isRead !== "boolean")) throw new Error("Saved reading progress could not be loaded safely.");
      return parsed;
    },
    save(progress) { storage.setItem(key, JSON.stringify(progress)); },
  };
}

interface ChapterProgressState {
  lastPageRead: number;
  isRead: boolean;
  persistedPage: number;
  persistedRead: boolean;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  retryDelay: number;
  writeChain: Promise<void>;
}

export interface MangaProgressPersister {
  checkpoint(): void;
  peek(chapterId: number): MangaChapterProgress | null;
  seed(chapterId: number, lastPageRead: number, isRead: boolean): void;
  record(chapterId: number, lastPageRead: number, isRead: boolean): MangaChapterProgress;
  flush(chapterId: number): Promise<void>;
  flushAll(): Promise<void>;
}

export function createMangaProgressPersister(
  options: MangaProgressPersisterOptions,
): MangaProgressPersister {
  const delayMs = Math.max(0, options.delayMs ?? 450);
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 5000);
  // Nothing announces the server coming back, so the wait between tries stays short enough to catch it soon.
  const MAX_RETRY_DELAY_MS = 15_000;
  const chapters = new Map<number, ChapterProgressState>();

  function persistPending() {
    options.journal?.save([...chapters.entries()]
      .filter(([, state]) => state.lastPageRead > state.persistedPage || (state.isRead && !state.persistedRead))
      .map(([chapterId, state]) => ({ chapterId, lastPageRead: state.lastPageRead, isRead: state.isRead })));
  }

  function getState(chapterId: number): ChapterProgressState {
    const existing = chapters.get(chapterId);
    if (existing) return existing;
    const created: ChapterProgressState = {
      lastPageRead: 0,
      isRead: false,
      persistedPage: 0,
      persistedRead: false,
      dirty: false,
      timer: null,
      retryDelay: retryDelayMs,
      writeChain: Promise.resolve(),
    };
    chapters.set(chapterId, created);
    return created;
  }

  function seed(chapterId: number, lastPageRead: number, isRead: boolean) {
    const state = getState(chapterId);
    const page = Math.max(0, Math.trunc(lastPageRead || 0));
    state.lastPageRead = Math.max(state.lastPageRead, page);
    state.isRead ||= isRead;
    // A re-opened reader can supply an optimistically patched cached chapter.
    // Only the writer may acknowledge an outstanding update.
    if (!state.dirty) {
      state.persistedPage = Math.max(state.persistedPage, page);
      state.persistedRead ||= isRead;
    }
  }

  function schedule(chapterId: number, state: ChapterProgressState, wait = delayMs) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush(chapterId).catch(() => {});
    }, wait);
  }

  // Progress read while the server is away stays in the journal and is saved once the server answers again,
  // without waiting for another page turn or for the reader to close.
  function scheduleRetry(chapterId: number, state: ChapterProgressState) {
    if (!state.dirty || state.timer) return;
    const wait = state.retryDelay;
    state.retryDelay = Math.min(MAX_RETRY_DELAY_MS, state.retryDelay * 2);
    schedule(chapterId, state, wait);
  }

  function record(chapterId: number, lastPageRead: number, isRead: boolean): MangaChapterProgress {
    const state = getState(chapterId);
    const page = Math.max(0, Math.trunc(lastPageRead || 0));
    state.lastPageRead = Math.max(state.lastPageRead, page);
    state.isRead ||= isRead;
    state.dirty = state.lastPageRead > state.persistedPage || (state.isRead && !state.persistedRead);
    persistPending();
    if (state.dirty) schedule(chapterId, state);
    return { chapterId, lastPageRead: state.lastPageRead, isRead: state.isRead };
  }

  async function flush(chapterId: number): Promise<void> {
    const state = chapters.get(chapterId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const operation = state.writeChain.then(async () => {
      if (!state.dirty) return;
      const snapshot: MangaChapterProgress = {
        chapterId,
        lastPageRead: state.lastPageRead,
        isRead: state.isRead,
      };
      state.dirty = false;
      try {
        const saved = await options.write(snapshot) ?? snapshot;
        state.persistedPage = Math.max(state.persistedPage, saved.lastPageRead);
        state.persistedRead ||= saved.isRead;
        state.lastPageRead = Math.max(state.lastPageRead, state.persistedPage);
        state.isRead ||= state.persistedRead;
        state.dirty = state.lastPageRead > state.persistedPage || (state.isRead && !state.persistedRead);
        state.retryDelay = retryDelayMs;
        persistPending();
      } catch (error) {
        state.dirty = true;
        throw error;
      }
    });
    state.writeChain = operation.catch(() => {});
    try {
      await operation;
    } catch (error) {
      scheduleRetry(chapterId, state);
      throw error;
    }

    if (state.dirty && !state.timer) schedule(chapterId, state);
  }

  async function flushAll(): Promise<void> {
    await Promise.all([...chapters.keys()].map((chapterId) => flush(chapterId)));
  }

  for (const progress of options.journal?.load() ?? []) {
    const state = getState(progress.chapterId);
    state.lastPageRead = Math.max(state.lastPageRead, progress.lastPageRead);
    state.isRead ||= progress.isRead;
    state.dirty = true;
    // Left over from an earlier session that closed while the server was away.
    scheduleRetry(progress.chapterId, state);
  }

  function peek(chapterId: number): MangaChapterProgress | null {
    const state = chapters.get(chapterId);
    return state ? { chapterId, lastPageRead: state.lastPageRead, isRead: state.isRead } : null;
  }

  function checkpoint() {
    if (!options.journal) throw new Error("Durable reading storage is unavailable.");
    persistPending();
  }

  return { seed, record, flush, flushAll, peek, checkpoint };
}
