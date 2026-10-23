import { syncdGetSyncProgressIfRunning, type SyncdSyncProgress } from "../syncdDesktop";

/** How often this window checks whether synced changes reached Suwayomi. */
const SYNC_LANDING_INTERVAL_MS = 5_000;

/**
 * Tells when changes synced from paired devices have landed in Suwayomi, so pages showing the
 * library reload them: Core applied projections since the last landing and has stopped applying
 * for now (nothing left, or the rest is waiting on a retry). Works whose details were still loading
 * count once the last one finishes. The first reading is only the baseline, since the library is
 * read live at startup.
 */
export function createSyncLandingDetector(): (progress: SyncdSyncProgress | null) => boolean {
  let lastApplied: number | null = null;
  let lastDetails = 0;
  let unseen = false;
  return (progress) => {
    if (!progress) return false;
    const applied = progress.appliedProjections ?? 0;
    const moved = lastApplied !== null && applied !== lastApplied;
    if (moved || (lastDetails > 0 && progress.pendingDetails === 0)) unseen = true;
    lastApplied = applied;
    lastDetails = progress.pendingDetails;
    if (!unseen || (moved && progress.pendingProjections > 0)) return false;
    unseen = false;
    return true;
  };
}

/**
 * Polls the running Core (never starts it) and calls `onLanded` once synced changes reach
 * Suwayomi, skipping checks while `isPaused` says the window is hidden.
 */
export function startSyncLandingWatch(
  onLanded: () => Promise<void> | void,
  isPaused: () => boolean,
): () => void {
  const landed = createSyncLandingDetector();
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running || isPaused()) return;
    running = true;
    try {
      const progress = await syncdGetSyncProgressIfRunning().catch(() => null);
      if (!stopped && landed(progress)) await onLanded();
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
