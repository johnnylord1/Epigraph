import {
  syncdDisconnectPersistedSession,
  syncdGetReplicationState,
  syncdGetSyncProgressIfRunning,
  syncdListPairedDevicesIfRunning,
  syncdRevokePairedDevice,
  type SyncdPairedDeviceView,
  type SyncdSyncProgress,
} from "../syncdDesktop";
import { firstRunSyncReadinessKey, refreshFirstRunSyncLibrary } from "./firstRunSyncReadiness";
import { notifyInBackground } from "../backgroundNotifications";
import { createSyncEta, syncEtaText } from "./syncEta";
import { translate } from "../i18n/runtime";
import { addSystemNotification, finishProgressToast, showProgressToast } from "../../store/state.svelte";

/**
 * A first-run sync the user left running: setup goes on while Core finishes importing the synced
 * works and progress, shown on one toast and in the notification list. Library lookups for Browse
 * wait while it runs, so they read the complete library instead of a partial one.
 */
export interface FirstRunBackgroundSyncOptions {
  profileId: string;
  /** A phone paired here: wait until it has sent everything it holds. */
  waitForUploads: boolean;
  /** Paired with another computer: wait until replication is live with its library. */
  waitForReplication: boolean;
  /** The phone or computer that paired with this computer's Core; the run ends if it forgets the pairing. */
  peerDeviceId?: string | null;
  /** The replication session with another computer, which Cancel disconnects. */
  sessionKey?: string | null;
}

interface Marker extends FirstRunBackgroundSyncOptions {
  startedAt: number;
}

const MARKER_KEY = "epigraph.firstRunBackgroundSync";
const TOAST_ID = "first-run-sync";
const NOTIFICATION_ID = "first-run-sync";
const POLL_INTERVAL_MS = 3000;
/* No change for this long means the other device went offline; Core goes on once it is back. */
const STALL_MS = 10 * 60_000;
/* Core gone for this long (closed, or replaced by an older one) leaves nothing to report. */
const CORE_ABSENT_MS = 3 * 60_000;
/* A marker this old belongs to a run that can no longer be followed. */
const MARKER_TTL_MS = 24 * 60 * 60_000;

function readMarker(): Marker | null {
  try {
    const raw = globalThis.localStorage?.getItem(MARKER_KEY);
    if (!raw) return null;
    const marker = JSON.parse(raw) as Partial<Marker>;
    if (typeof marker.profileId !== "string" || !marker.profileId || typeof marker.startedAt !== "number"
      || Date.now() - marker.startedAt > MARKER_TTL_MS) {
      globalThis.localStorage?.removeItem(MARKER_KEY);
      return null;
    }
    return {
      profileId: marker.profileId,
      waitForUploads: marker.waitForUploads === true,
      waitForReplication: marker.waitForReplication === true,
      peerDeviceId: typeof marker.peerDeviceId === "string" ? marker.peerDeviceId : null,
      sessionKey: typeof marker.sessionKey === "string" ? marker.sessionKey : null,
      startedAt: marker.startedAt,
    };
  } catch {
    return null;
  }
}

function writeMarker(marker: Marker | null) {
  try {
    if (marker) globalThis.localStorage?.setItem(MARKER_KEY, JSON.stringify(marker));
    else globalThis.localStorage?.removeItem(MARKER_KEY);
  } catch {}
}

export const firstRunBackgroundSync = $state<{ running: boolean }>({ running: readMarker() !== null });

let runId = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let followed: Marker | null = null;
/* Misses in a row before the peer counts as gone, so one read during a Core restart does not end the run. */
const PEER_MISSES_TO_LEAVE = 2;

/**
 * Whether the device that paired here is still paired: a phone that forgot this computer is revoked
 * and leaves the list.
 */
export function pairedPeerPresent(devices: SyncdPairedDeviceView[], profileId: string, deviceId?: string | null): boolean {
  return devices.some((device) => device.profileId === profileId && !device.inactive && (!deviceId || device.deviceId === deviceId));
}

/**
 * Stops syncing with the device this computer paired with: a phone is unpaired here, so it can no
 * longer send or receive; another computer's session is disconnected. What already arrived stays.
 */
export async function cancelPeerSync(target: { peerDeviceId?: string | null; sessionKey?: string | null }) {
  if (target.peerDeviceId) await syncdRevokePairedDevice(target.peerDeviceId);
  else if (target.sessionKey) await syncdDisconnectPersistedSession(target.sessionKey);
}

/** What is still to come, or null while a phone has not said what it holds yet. */
export function firstRunSyncRemaining(progress: SyncdSyncProgress, waitForUploads: boolean): number | null {
  const uploads = waitForUploads ? progress.pendingUploads : 0;
  // A Core that predates upload reports leaves the field out; it cannot hold the run.
  if (uploads === null) return null;
  return (uploads ?? 0) + progress.pendingProjections + progress.pendingDetails;
}

/** Starts following the sync, or carries on with the one already followed. */
export function startFirstRunBackgroundSync(options: FirstRunBackgroundSyncOptions) {
  const marker: Marker = { ...options, startedAt: Date.now() };
  writeMarker(marker);
  addSystemNotification({
    id: NOTIFICATION_ID,
    profileId: options.profileId,
    kind: "info",
    title: translate("firstRun.sync.toastRunning"),
    body: translate("firstRun.sync.notifyStartedBody"),
  });
  follow(marker);
}

/** After a restart, carries on with a run setup left in the background. */
export function resumeFirstRunBackgroundSync() {
  const marker = readMarker();
  if (!marker) {
    firstRunBackgroundSync.running = false;
    return;
  }
  follow(marker);
}

export function stopFirstRunBackgroundSync() {
  runId += 1;
  clearTimeout(timer);
  followed = null;
  writeMarker(null);
  firstRunBackgroundSync.running = false;
}

/** Cancel on the toast: stops syncing with the other device and ends the run. */
export async function cancelFirstRunBackgroundSync() {
  const marker = followed ?? readMarker();
  stopFirstRunBackgroundSync();
  if (!marker) return;
  const outcome = { title: translate("firstRun.sync.toastCancelled"), body: translate("firstRun.sync.toastCancelledBody") };
  try {
    await cancelPeerSync(marker);
  } catch (error) {
    console.warn("First-run background sync could not stop syncing with the other device.", error);
    finishProgressToast(TOAST_ID, { kind: "error", title: translate("firstRun.sync.cancelFailed"), body: translate("firstRun.sync.cancelFailedBody"), duration: 0 });
    return;
  }
  finishProgressToast(TOAST_ID, { kind: "info", ...outcome, duration: 6000 });
  addSystemNotification({ id: NOTIFICATION_ID, profileId: marker.profileId, kind: "info", ...outcome });
}

function follow(marker: Marker) {
  const id = ++runId;
  clearTimeout(timer);
  followed = marker;
  firstRunBackgroundSync.running = true;
  let peerMisses = 0;
  let total = 0;
  let previous: number | null | undefined;
  let lastAdvance = Date.now();
  let coreSeenAt = Date.now();
  const eta = createSyncEta();

  const release = () => {
    if (id !== runId) return;
    followed = null;
    writeMarker(null);
    firstRunBackgroundSync.running = false;
  };

  const finish = async () => {
    // Recommendations read the library store; it is read again so they see every imported work.
    try {
      await refreshFirstRunSyncLibrary(marker.profileId, () => id === runId);
    } catch (error) {
      console.warn("First-run background sync could not read the library back.", error);
    }
    if (id !== runId) return;
    const title = translate("firstRun.sync.toastDone");
    const body = translate("firstRun.sync.toastDoneBody");
    finishProgressToast(TOAST_ID, { kind: "success", title, body, duration: 6000 });
    addSystemNotification({ id: NOTIFICATION_ID, profileId: marker.profileId, kind: "success", title, body });
    void notifyInBackground("library", title, body);
    release();
  };

  const stall = () => {
    finishProgressToast(TOAST_ID, {
      kind: "info",
      title: translate("firstRun.sync.toastStalled"),
      body: translate("firstRun.sync.toastStalledBody"),
      duration: 0,
    });
    release();
  };

  /* The other device forgot this computer: nothing more will come, so the run ends here. */
  const peerLeft = () => {
    const title = translate("firstRun.sync.toastPeerLeft");
    const body = translate("firstRun.sync.toastPeerLeftBody");
    finishProgressToast(TOAST_ID, { kind: "info", title, body, duration: 0 });
    addSystemNotification({ id: NOTIFICATION_ID, profileId: marker.profileId, kind: "info", title, body });
    release();
  };

  /* A phone pairs with this Core; another computer's pairing is followed through replication. */
  const watchesPeer = Boolean(marker.peerDeviceId);

  const poll = async () => {
    if (id !== runId) return;
    let progress: SyncdSyncProgress | null = null;
    let replicating = !marker.waitForReplication;
    try {
      progress = await syncdGetSyncProgressIfRunning();
      if (!replicating) replicating = firstRunSyncReadinessKey(marker.profileId, await syncdGetReplicationState(marker.profileId)) !== null;
    } catch (error) {
      console.warn("First-run background sync could not read sync progress.", error);
    }
    if (id !== runId) return;
    if (progress && watchesPeer) {
      try {
        const devices = (await syncdListPairedDevicesIfRunning()) ?? [];
        if (id !== runId) return;
        peerMisses = pairedPeerPresent(devices, marker.profileId, marker.peerDeviceId) ? 0 : peerMisses + 1;
      } catch (error) {
        console.warn("First-run background sync could not read the paired devices.", error);
      }
      if (peerMisses >= PEER_MISSES_TO_LEAVE) {
        peerLeft();
        return;
      }
    }
    const now = Date.now();
    if (!progress) {
      if (now - coreSeenAt > CORE_ABSENT_MS) {
        release();
        return;
      }
    } else {
      coreSeenAt = now;
      const remaining = firstRunSyncRemaining(progress, marker.waitForUploads);
      if (replicating && remaining === 0) {
        void finish();
        return;
      }
      // Any change, up while a phone uploads or down while Core applies, is the sync moving.
      if (remaining !== previous) {
        previous = remaining;
        lastAdvance = now;
      }
      total = Math.max(total, remaining ?? 0);
      const done = remaining === null ? 0 : total - remaining;
      const etaSeconds = replicating ? eta.sample(now, remaining) : null;
      showProgressToast(TOAST_ID, {
        kind: "info",
        title: translate("firstRun.sync.toastRunning"),
        body: remaining === null || !replicating
          ? undefined
          : etaSeconds === null
            ? translate("firstRun.sync.toastRunningBody", { remaining })
            : translate("firstRun.sync.toastRunningBodyEta", { remaining, eta: syncEtaText(etaSeconds) }),
        progress: remaining !== null && total > 0
          ? { current: done, total, percent: Math.floor((done / total) * 100) }
          : undefined,
        actions: marker.peerDeviceId || marker.sessionKey
          ? [{ label: translate("firstRun.sync.cancelSync"), run: () => void cancelFirstRunBackgroundSync() }]
          : undefined,
      });
    }
    if (now - lastAdvance > STALL_MS) {
      stall();
      return;
    }
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };
  void poll();
}
