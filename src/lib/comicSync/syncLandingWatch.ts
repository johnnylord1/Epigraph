import { syncdGetSyncProgressIfRunning, type SyncdLandedWorks, type SyncdSyncProgress } from "../syncdDesktop";

/** How often this window checks whether synced changes reached Suwayomi. */
const SYNC_LANDING_INTERVAL_MS = 5_000;

/** While changes keep landing, how often they are shown; each reload reads the whole library. */
export const SYNC_LIVE_RELOAD_INTERVAL_MS = 20_000;

/** The same once only reading progress is left: it can last hours and changes little on screen. */
export const SYNC_PROGRESS_RELOAD_INTERVAL_MS = 60_000;

/** The wait after a reload, in reload durations, so a large library is not read back to back. */
const SYNC_RELOAD_GAP_PER_RELOAD = 4;

/**
 * Tells when changes synced from paired devices have landed in Suwayomi, so pages showing the
 * library reload them: Core applied projections since the last landing, or the last work's details
 * finished loading. An isolated change lands at once; changes that keep coming land at most once
 * per interval (`progressIntervalMs` while only reading progress is pending, `liveIntervalMs`
 * otherwise, or `minGapMs` if longer), and what is left lands when the interval ends. The first
 * reading is only the baseline, since the library is read live at startup.
 */
export function createSyncLandingDetector(
  now: () => number = Date.now,
  liveIntervalMs = SYNC_LIVE_RELOAD_INTERVAL_MS,
  progressIntervalMs = SYNC_PROGRESS_RELOAD_INTERVAL_MS,
): (progress: SyncdSyncProgress | null, minGapMs?: number) => boolean {
  let lastApplied: number | null = null;
  let lastDetails = 0;
  let unseen = false;
  let lastLandedAt: number | null = null;
  return (progress, minGapMs = 0) => {
    if (!progress) return false;
    const applied = progress.appliedProjections ?? 0;
    const moved = lastApplied !== null && applied !== lastApplied;
    if (moved || (lastDetails > 0 && progress.pendingDetails === 0)) unseen = true;
    lastApplied = applied;
    lastDetails = progress.pendingDetails;
    if (!unseen) return false;
    const progressOnly = progress.pendingProjections > 0 && progress.pendingCatalogProjections === 0;
    const intervalMs = Math.max(progressOnly ? progressIntervalMs : liveIntervalMs, minGapMs);
    if (lastLandedAt !== null && now() - lastLandedAt < intervalMs) return false;
    unseen = false;
    lastLandedAt = now();
    return true;
  };
}

/** Past this many works in one read, reading the whole library costs about the same. */
export const MAX_WORKS_PER_READ = 150;
/** An arrival larger than this ends with one full read, as a check on everything it brought. */
export const ARRIVAL_RECONCILE_WORKS = 25;
const FAILED_READ_RETRY_MS = 20_000;

/** What the window still has to read, from what Core says landed after the window's last reading. */
export function createLandedWorksTracker() {
  let cursor: number | undefined;
  let catalogSequence: number | undefined;
  const pending = new Set<number>();
  let needsLibrary = false;
  let catalogChanged = false;
  let landedCount = 0;
  return {
    cursor: () => cursor,
    /** The first reading only says where to start from. */
    note(landed: SyncdLandedWorks, profileId: string | null) {
      if (cursor !== undefined) {
        if (landed.sequence < cursor || landed.floor > cursor) needsLibrary = true;
        for (const work of landed.works) {
          if (profileId !== null && work.profileId !== profileId) continue;
          pending.add(work.mangaId);
          landedCount += 1;
        }
        if (landed.catalogSequence !== catalogSequence) catalogChanged = true;
        if (pending.size > MAX_WORKS_PER_READ) needsLibrary = true;
      }
      cursor = landed.sequence;
      catalogSequence = landed.catalogSequence;
    },
    pendingIds: () => [...pending],
    needsLibrary: () => needsLibrary,
    catalogChanged: () => catalogChanged,
    landedCount: () => landedCount,
    settled: () => !needsLibrary && pending.size === 0,
    requestLibrary: () => { needsLibrary = true; },
    worksRead: (ids: number[]) => { for (const id of ids) pending.delete(id); },
    /** The full read dispatches what the category listeners need, too. */
    libraryRead: () => { needsLibrary = false; catalogChanged = false; pending.clear(); },
    catalogSeen: () => { catalogChanged = false; },
    startCounting: () => { landedCount = 0; },
  };
}

export interface SyncLandingHandlers {
  isPaused: () => boolean;
  profileId: () => string | null;
  /** Reads only these works. Throws when they were not read. */
  readWorks: (ids: number[]) => Promise<void> | void;
  /** Reads the whole library. Throws when it was not read. */
  readLibrary: () => Promise<void> | void;
  /** Library membership or categories changed; the works themselves are read apart. */
  catalogChanged: () => void;
  arriving: (progress: SyncdSyncProgress | null) => boolean;
  /** Told when that changes; once they stop, only after everything that landed was read. */
  onArriving: (arriving: boolean) => void;
}

export function startSyncLandingWatch(handlers: SyncLandingHandlers): () => void {
  const works = createLandedWorksTracker();
  // Only for a Core too old to say which works landed.
  const landedWithoutWorks = createSyncLandingDetector();
  let stopped = false, running = false, wasArriving = false, reconcile = false, startedReading = false;
  let lastLibraryAt: number | null = null, lastWorksAt: number | null = null, lastCatalogAt: number | null = null;
  let libraryGapMs = 0, worksGapMs = 0, retryAt = 0;
  const elapsed = (since: number | null, intervalMs: number, gapMs: number) =>
    since === null || Date.now() - since >= Math.max(intervalMs, gapMs);

  const read = async (progress: SyncdSyncProgress | null, urgent: boolean, forced: boolean) => {
    const progressOnly = !!progress && progress.pendingProjections > 0
      && progress.pendingCatalogProjections === 0 && !works.catalogChanged();
    const startedAt = Date.now();
    if (works.needsLibrary()) {
      const intervalMs = progressOnly ? SYNC_PROGRESS_RELOAD_INTERVAL_MS : SYNC_LIVE_RELOAD_INTERVAL_MS;
      if (!forced && !urgent && !elapsed(lastLibraryAt, intervalMs, libraryGapMs)) return;
      lastLibraryAt = startedAt;
      await handlers.readLibrary();
      if (stopped) return;
      libraryGapMs = (Date.now() - startedAt) * SYNC_RELOAD_GAP_PER_RELOAD;
      works.libraryRead();
      return;
    }
    const ids = works.pendingIds();
    if (ids.length > 0 && (urgent || elapsed(lastWorksAt, progressOnly ? SYNC_PROGRESS_RELOAD_INTERVAL_MS : 0, worksGapMs))) {
      lastWorksAt = startedAt;
      try {
        await handlers.readWorks(ids);
      } catch (error) {
        works.requestLibrary();
        throw error;
      }
      if (stopped) return;
      worksGapMs = (Date.now() - startedAt) * SYNC_RELOAD_GAP_PER_RELOAD;
      works.worksRead(ids);
    }
    if (works.catalogChanged() && elapsed(lastCatalogAt, SYNC_LIVE_RELOAD_INTERVAL_MS, 0)) {
      lastCatalogAt = Date.now();
      works.catalogSeen();
      handlers.catalogChanged();
    }
  };

  const tick = async () => {
    if (stopped || running) return;
    // The first reading says where changes count from, so it does not wait for the window: what
    // lands while it stays hidden is read once it is shown.
    if (startedReading && handlers.isPaused()) return;
    running = true;
    try {
      const progress = await syncdGetSyncProgressIfRunning(works.cursor()).catch(() => null);
      if (stopped) return;
      if (progress) startedReading = true;
      const arriving = handlers.arriving(progress);
      if (arriving && !wasArriving) {
        wasArriving = true;
        works.startCounting();
        handlers.onArriving(true);
      }
      const landed = progress?.landed;
      // What landed before the first reading is not listed, so that arrival ends with a full read.
      if (landed && works.cursor() === undefined && arriving) reconcile = true;
      if (landed) works.note(landed, handlers.profileId());
      const forced = !landed && landedWithoutWorks(progress, libraryGapMs);
      if (forced) works.requestLibrary();
      const arrivalEnded = wasArriving && !arriving;
      if (arrivalEnded && (!landed || reconcile || works.landedCount() > ARRIVAL_RECONCILE_WORKS)) works.requestLibrary();
      if (Date.now() >= retryAt) {
        try {
          await read(progress, arrivalEnded, forced);
        } catch (error) {
          retryAt = Date.now() + FAILED_READ_RETRY_MS;
          throw error;
        }
      }
      if (stopped) return;
      // The Browse analysis reads the library, so it waits until everything that landed is in it.
      if (arrivalEnded && works.settled()) {
        wasArriving = false;
        reconcile = false;
        handlers.onArriving(false);
      }
    } catch (error) {
      console.warn("Could not read the library after synced changes:", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), SYNC_LANDING_INTERVAL_MS);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
