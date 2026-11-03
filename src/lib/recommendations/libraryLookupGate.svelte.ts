import type { SyncdSyncProgress } from "../syncdDesktop";
import { firstRunBackgroundSync } from "../setup/firstRunBackgroundSync.svelte";

/* No change for this long means a device went offline mid-sync; the lookups stop waiting for it. */
const LIBRARY_ARRIVAL_STALL_MS = 10 * 60_000;

/**
 * The library lookups for Browse read the whole library, so they wait while paired devices are still
 * bringing works here. `forced` is the user asking for them anyway, until that sync ends; each
 * request bumps `requested`.
 */
export const libraryLookupGate = $state<{ syncing: boolean; forced: boolean; requested: number }>({
  syncing: false,
  forced: false,
  requested: 0,
});

/** Library works still to come: what devices have to upload, and what Core has to apply here. */
export function libraryWorksStillArriving(progress: SyncdSyncProgress | null): boolean {
  if (!progress) return false;
  const uploads = progress.pendingLibraryUploads ?? progress.pendingUploads ?? 0;
  const projections = progress.pendingCatalogProjections ?? progress.pendingProjections;
  return uploads > 0 || projections > 0;
}

/** Whether library works are arriving, false once nothing has moved for `stallMs`. */
export function createLibraryArrivalTracker(
  now: () => number = Date.now,
  stallMs = LIBRARY_ARRIVAL_STALL_MS,
): (progress: SyncdSyncProgress | null) => boolean {
  let signature: string | null = null;
  let changedAt = 0;
  return (progress) => {
    if (!progress || !libraryWorksStillArriving(progress)) {
      signature = null;
      return false;
    }
    const next = [
      progress.appliedProjections ?? 0,
      progress.pendingLibraryUploads ?? progress.pendingUploads ?? 0,
      progress.pendingCatalogProjections ?? progress.pendingProjections,
    ].join(":");
    if (next !== signature) {
      signature = next;
      changedAt = now();
    }
    return now() - changedAt < stallMs;
  };
}

/** A request made before a sync starts or ends does not carry over to the next one. */
export function setLibraryWorksArriving(arriving: boolean) {
  if (libraryLookupGate.syncing === arriving) return;
  libraryLookupGate.syncing = arriving;
  libraryLookupGate.forced = false;
}

/** Whether the lookups wait for a sync: one setup left running, or works still arriving from devices. */
export function libraryLookupsWaitForSync(): boolean {
  return (firstRunBackgroundSync.running || libraryLookupGate.syncing) && !libraryLookupGate.forced;
}

/** Looks the library up again now, without waiting for a sync; works already answered are skipped. */
export function requestLibraryAnalysis() {
  libraryLookupGate.forced = true;
  libraryLookupGate.requested += 1;
}
