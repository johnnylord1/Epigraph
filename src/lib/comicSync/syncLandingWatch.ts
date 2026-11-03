import { syncdGetSyncProgressIfRunning, type SyncdSyncProgress } from "../syncdDesktop";

/** How often this window checks whether synced changes reached Suwayomi. */
const SYNC_LANDING_INTERVAL_MS = 5_000;

/** While Core keeps applying, how often what landed so far is shown; each reload reads the whole library. */
export const SYNC_LIVE_RELOAD_INTERVAL_MS = 20_000;

/**
 * Tells when changes synced from paired devices have landed in Suwayomi, so pages showing the
 * library reload them: Core applied projections since the last landing and has stopped applying
 * for now (nothing left, or the rest is waiting on a retry). A long sync also lands what it applied
 * so far, at most once per `liveIntervalMs`, so the library fills in while it runs. Works whose
 * details were still loading count once the last one finishes. The first reading is only the
 * baseline, since the library is read live at startup.
 */
export function createSyncLandingDetector(
  now: () => number = Date.now,
  liveIntervalMs = SYNC_LIVE_RELOAD_INTERVAL_MS,
): (progress: SyncdSyncProgress | null) => boolean {
  let lastApplied: number | null = null;
  let lastDetails = 0;
  let unseen = false;
  let lastLandedAt: number | null = null;
  return (progress) => {
    if (!progress) return false;
    const applied = progress.appliedProjections ?? 0;
    const moved = lastApplied !== null && applied !== lastApplied;
    if (moved || (lastDetails > 0 && progress.pendingDetails === 0)) unseen = true;
    lastApplied = applied;
    lastDetails = progress.pendingDetails;
    if (!unseen) return false;
    const applying = moved && progress.pendingProjections > 0;
    if (applying && lastLandedAt !== null && now() - lastLandedAt < liveIntervalMs) return false;
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
  const tick = async () => {
    if (stopped || running || isPaused()) return;
    running = true;
    try {
      const progress = await syncdGetSyncProgressIfRunning().catch(() => null);
      if (stopped) return;
      const arriving = arrival?.arriving(progress) ?? false;
      // A failed reload keeps the works "arriving", so the next check reads the library again.
      if (landed(progress) || (wasArriving && !arriving)) await onLanded();
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
