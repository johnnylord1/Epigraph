import { syncdGetSyncProgressIfRunning, type SyncdSyncProgress } from "../syncdDesktop";

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

export interface SyncArrivalWatch {
  /** Whether library works are still arriving, from each reading. */
  arriving: (progress: SyncdSyncProgress | null) => boolean;
  /** Told when that changes; once they stop, only after `onLanded` read the library again. */
  onArriving: (arriving: boolean) => void;
}

/**
 * Polls the running Core (never starts it) and calls `onLanded` once synced changes reach
 * Suwayomi, skipping checks while `isPaused` says the window is hidden.
 */
export function startSyncLandingWatch(
  onLanded: () => Promise<void> | void,
  isPaused: () => boolean,
  arrival?: SyncArrivalWatch,
): () => void {
  const landed = createSyncLandingDetector();
  let stopped = false;
  let running = false;
  let wasArriving = false;
  let reloadGapMs = 0;
  const tick = async () => {
    if (stopped || running || isPaused()) return;
    running = true;
    try {
      const progress = await syncdGetSyncProgressIfRunning().catch(() => null);
      if (stopped) return;
      const arriving = arrival?.arriving(progress) ?? false;
      // A failed reload keeps the works "arriving", so the next check reads the library again.
      if (landed(progress, reloadGapMs) || (wasArriving && !arriving)) {
        const startedAt = Date.now();
        await onLanded();
        reloadGapMs = (Date.now() - startedAt) * SYNC_RELOAD_GAP_PER_RELOAD;
      }
      if (arriving !== wasArriving) {
        wasArriving = arriving;
        arrival?.onArriving(arriving);
      }
    } catch (error) {
      console.warn("Could not reload the library after synced changes:", error);
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
