import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  progress: vi.fn(),
  replication: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  showToast: vi.fn(),
  finishToast: vi.fn(),
  addNotification: vi.fn(),
}));

// Node's own localStorage needs a backing file; the module only needs a Storage.
vi.hoisted(() => {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, String(value)),
      removeItem: (key: string) => void items.delete(key),
      clear: () => items.clear(),
    },
  });
});

vi.mock("../syncdDesktop", () => ({
  syncdGetSyncProgressIfRunning: mocks.progress,
  syncdGetReplicationState: mocks.replication,
}));
vi.mock("./firstRunSyncReadiness", async (importOriginal) => ({
  ...await importOriginal<typeof import("./firstRunSyncReadiness")>(),
  refreshFirstRunSyncLibrary: mocks.refresh,
}));
vi.mock("../backgroundNotifications", () => ({ notifyInBackground: mocks.notify }));
vi.mock("../../store/state.svelte", () => ({
  showProgressToast: mocks.showToast,
  finishProgressToast: mocks.finishToast,
  addSystemNotification: mocks.addNotification,
}));

import { applyAppLanguage } from "../i18n/runtime";
import {
  firstRunBackgroundSync,
  firstRunSyncRemaining,
  resumeFirstRunBackgroundSync,
  startFirstRunBackgroundSync,
  stopFirstRunBackgroundSync,
} from "./firstRunBackgroundSync.svelte";

const MARKER_KEY = "epigraph.firstRunBackgroundSync";
const idle = { pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 0 };
const live = { localProfileId: "main", activeSessionKey: "session-1", replicationStatus: "live", remoteBootstrapGeneration: 1, paused: false, lastError: null };

beforeEach(() => {
  applyAppLanguage("en");
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  mocks.refresh.mockResolvedValue(undefined);
  mocks.notify.mockResolvedValue(true);
  mocks.replication.mockResolvedValue({ localProfileId: "main", replicationStatus: "idle", paused: false });
});

afterEach(() => {
  stopFirstRunBackgroundSync();
  vi.useRealTimers();
});

describe("firstRunSyncRemaining", () => {
  it("counts uploads only from a phone, and not before it has reported", () => {
    const progress = { ...idle, pendingProjections: 30, pendingDetails: 4, pendingUploads: 6 };
    expect(firstRunSyncRemaining(progress, true)).toBe(40);
    expect(firstRunSyncRemaining(progress, false)).toBe(34);
    expect(firstRunSyncRemaining({ ...idle, pendingUploads: null }, true)).toBeNull();
    expect(firstRunSyncRemaining({ ...idle, pendingUploads: undefined }, true)).toBe(0);
  });
});

describe("first-run background sync", () => {
  it("shows progress until everything is imported, then reads the library back and reports it", async () => {
    mocks.progress
      .mockResolvedValueOnce({ ...idle, pendingProjections: 80, pendingUploads: 20 })
      .mockResolvedValueOnce({ ...idle, pendingProjections: 50, pendingUploads: 0 })
      .mockResolvedValue({ ...idle, pendingUploads: 0, pendingTrackerLogins: 2 });

    startFirstRunBackgroundSync({ profileId: "main", waitForUploads: true, waitForReplication: false });
    expect(firstRunBackgroundSync.running).toBe(true);
    expect(JSON.parse(localStorage.getItem(MARKER_KEY) ?? "null")).toMatchObject({ profileId: "main", waitForUploads: true });
    expect(mocks.addNotification).toHaveBeenCalledWith(expect.objectContaining({ id: "first-run-sync", kind: "info", title: "Syncing your library" }));

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showToast).toHaveBeenLastCalledWith("first-run-sync", expect.objectContaining({
      body: "100 items left: works, reading progress and details.",
      progress: { current: 0, total: 100, percent: 0 },
    }));

    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.showToast).toHaveBeenLastCalledWith("first-run-sync", expect.objectContaining({ progress: { current: 50, total: 100, percent: 50 } }));
    expect(firstRunBackgroundSync.running).toBe(true);

    // Tracker logins sign in on their own and do not hold the library lookups.
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.refresh).toHaveBeenCalledWith("main", expect.any(Function));
    expect(mocks.finishToast).toHaveBeenCalledWith("first-run-sync", expect.objectContaining({ kind: "success", title: "Library synced" }));
    expect(mocks.addNotification).toHaveBeenLastCalledWith(expect.objectContaining({ id: "first-run-sync", kind: "success" }));
    expect(mocks.notify).toHaveBeenCalledWith("library", "Library synced", expect.any(String));
    expect(firstRunBackgroundSync.running).toBe(false);
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("waits for a phone that has not said what it still holds", async () => {
    mocks.progress.mockResolvedValue({ ...idle, pendingUploads: null });
    startFirstRunBackgroundSync({ profileId: "main", waitForUploads: true, waitForReplication: false });

    await vi.advanceTimersByTimeAsync(9000);
    expect(mocks.finishToast).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenLastCalledWith("first-run-sync", expect.objectContaining({ body: undefined, progress: undefined }));
    expect(firstRunBackgroundSync.running).toBe(true);
  });

  it("waits until replication with another computer is live before it can be done", async () => {
    mocks.progress.mockResolvedValue(idle);
    startFirstRunBackgroundSync({ profileId: "main", waitForUploads: false, waitForReplication: true });

    await vi.advanceTimersByTimeAsync(6000);
    expect(mocks.finishToast).not.toHaveBeenCalled();

    mocks.replication.mockResolvedValue(live);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.finishToast).toHaveBeenCalledWith("first-run-sync", expect.objectContaining({ kind: "success" }));
    expect(firstRunBackgroundSync.running).toBe(false);
  });

  it("stops holding the lookups when the other device goes quiet", async () => {
    mocks.progress.mockResolvedValue({ ...idle, pendingProjections: 7 });
    startFirstRunBackgroundSync({ profileId: "main", waitForUploads: false, waitForReplication: false });

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(firstRunBackgroundSync.running).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(mocks.finishToast).toHaveBeenCalledWith("first-run-sync", expect.objectContaining({ kind: "info", title: "Sync continues when the other device is online" }));
    expect(firstRunBackgroundSync.running).toBe(false);
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("releases the lookups when Core stays away", async () => {
    mocks.progress.mockResolvedValue(null);
    startFirstRunBackgroundSync({ profileId: "main", waitForUploads: false, waitForReplication: false });

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(firstRunBackgroundSync.running).toBe(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(firstRunBackgroundSync.running).toBe(false);
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it("carries on after a restart, and forgets a run that is too old", async () => {
    localStorage.setItem(MARKER_KEY, JSON.stringify({ profileId: "main", waitForUploads: false, waitForReplication: false, startedAt: Date.now() }));
    mocks.progress.mockResolvedValue({ ...idle, pendingDetails: 3 });
    resumeFirstRunBackgroundSync();
    expect(firstRunBackgroundSync.running).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showToast).toHaveBeenCalledOnce();
    expect(mocks.addNotification).not.toHaveBeenCalled();

    stopFirstRunBackgroundSync();
    localStorage.setItem(MARKER_KEY, JSON.stringify({ profileId: "main", startedAt: Date.now() - 25 * 60 * 60_000 }));
    resumeFirstRunBackgroundSync();
    expect(firstRunBackgroundSync.running).toBe(false);
    expect(localStorage.getItem(MARKER_KEY)).toBeNull();
  });
});
