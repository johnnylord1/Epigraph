import { describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_VERSION,
  FIRST_RUN_STORAGE_KEY,
  canAdvanceFirstRun,
  completeFirstRunState,
  createFirstRunState,
  isFirstRunSourceSetupReady,
  isFirstRunBackupRestoreComplete,
  normalizeFirstRunState,
  writeCompletedFirstRunMarker,
  shouldStartFirstRun,
  readFirstRunPending,
  updateFirstRunState,
} from "./firstRun";

const EMPTY_READINESS = {
  syncConnected: false,
  backupRestored: false,
  sourcesConfigured: false,
  hasLibraryContent: false,
};

describe("first-run launch gate", () => {
  it("starts on a clean install", () => {
    expect(shouldStartFirstRun(null, false)).toBe(true);
  });

  it("does not interrupt a legacy installation", () => {
    expect(shouldStartFirstRun(null, true)).toBe(false);
  });

  it("does not start again after completion", () => {
    expect(shouldStartFirstRun(JSON.stringify({ status: "complete" }), true)).toBe(false);
  });

  it("recovers a corrupt marker through setup", () => {
    expect(shouldStartFirstRun("not-json", false)).toBe(true);
  });

  it("reads the stored marker while setup is open", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null });
    try {
      stored.set(FIRST_RUN_STORAGE_KEY, JSON.stringify({ status: "pending", step: "entry" }));
      expect(readFirstRunPending(true)).toBe(true);
      stored.set(FIRST_RUN_STORAGE_KEY, JSON.stringify({ status: "complete" }));
      expect(readFirstRunPending(false)).toBe(false);
      stored.clear();
      expect(readFirstRunPending(false)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("provides an automation-safe completion marker for existing release journeys", () => {
    const values = new Map<string, string>();
    writeCompletedFirstRunMarker({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    });
    expect(JSON.parse(values.get(FIRST_RUN_STORAGE_KEY) ?? "{}")).toMatchObject({
      status: "complete",
      step: "complete",
    });
  });
});

describe("first-run persistence", () => {
  it("opens the theme step for a clean install", () => {
    expect(normalizeFirstRunState(null)).toEqual(createFirstRunState());
  });

  it("does not interrupt an existing installation that predates first-run metadata", () => {
    expect(normalizeFirstRunState({ storeVersion: 7, settings: { theme: "nocturne" } })).toEqual({
      version: FIRST_RUN_VERSION,
      status: "complete",
      step: "complete",
      path: null,
    });
  });

  it("restores a valid unfinished task", () => {
    expect(normalizeFirstRunState({
      firstRun: { version: FIRST_RUN_VERSION, status: "pending", step: "sources", path: "backup" },
    })).toEqual({
      version: FIRST_RUN_VERSION,
      status: "pending",
      step: "sources",
      path: "backup",
    });
  });

  it("recovers invalid pending metadata to the first safe step", () => {
    expect(normalizeFirstRunState({
      firstRun: { version: 999, status: "pending", step: "unknown", path: "broken" },
    })).toEqual(createFirstRunState());
  });

  it("cannot resume a task whose selected path does not own it", () => {
    expect(normalizeFirstRunState({
      firstRun: { version: FIRST_RUN_VERSION, status: "pending", step: "backup", path: "sync" },
    })).toEqual({ ...createFirstRunState(), step: "entry" });
  });

  it("keeps path and step updates immutable", () => {
    const initial = createFirstRunState();
    const next = updateFirstRunState(initial, { step: "sources", path: "fresh" });
    expect(next).toEqual({ ...initial, step: "sources", path: "fresh" });
    expect(initial).toEqual(createFirstRunState());
  });

  it("persists completion so a second launch stays complete", () => {
    const completed = completeFirstRunState(updateFirstRunState(createFirstRunState(), {
      step: "discover",
      path: "fresh",
    }));
    expect(normalizeFirstRunState({ firstRun: completed })).toEqual({
      version: FIRST_RUN_VERSION,
      status: "complete",
      step: "complete",
      path: "fresh",
    });
  });
});

describe("first-run completion gates", () => {
  it("never treats visiting a production surface as completing it", () => {
    expect(canAdvanceFirstRun({ ...createFirstRunState(), step: "sync", path: "sync" }, EMPTY_READINESS)).toBe(false);
    expect(canAdvanceFirstRun({ ...createFirstRunState(), step: "backup", path: "backup" }, EMPTY_READINESS)).toBe(false);
    expect(canAdvanceFirstRun({ ...createFirstRunState(), step: "sources", path: "fresh" }, EMPTY_READINESS)).toBe(false);
    expect(canAdvanceFirstRun({ ...createFirstRunState(), step: "discover", path: "fresh" }, EMPTY_READINESS)).toBe(false);
    expect(canAdvanceFirstRun({ ...createFirstRunState(), step: "complete", path: "fresh" }, EMPTY_READINESS)).toBe(false);
  });

  it("unlocks each guarded task only from its production readiness fact", () => {
    expect(canAdvanceFirstRun(
      { ...createFirstRunState(), step: "sync", path: "sync" },
      { ...EMPTY_READINESS, syncConnected: true },
    )).toBe(true);
    expect(canAdvanceFirstRun(
      { ...createFirstRunState(), step: "backup", path: "backup" },
      { ...EMPTY_READINESS, backupRestored: true },
    )).toBe(true);
    expect(canAdvanceFirstRun(
      { ...createFirstRunState(), step: "sources", path: "fresh" },
      { ...EMPTY_READINESS, sourcesConfigured: true },
    )).toBe(true);
    expect(canAdvanceFirstRun(
      { ...createFirstRunState(), step: "discover", path: "fresh" },
      { ...EMPTY_READINESS, hasLibraryContent: true },
    )).toBe(true);
    expect(canAdvanceFirstRun(
      { ...createFirstRunState(), step: "complete", path: "fresh" },
      { ...EMPTY_READINESS, hasLibraryContent: true },
    )).toBe(true);
  });

  it("allows backup users to return from dependency setup without claiming restore success", () => {
    expect(canAdvanceFirstRun(
      { ...createFirstRunState(), step: "sources", path: "backup" },
      EMPTY_READINESS,
    )).toBe(true);
  });

  it("persists a completed restore but still requires sources before leaving its setup", () => {
    const state = { ...createFirstRunState(), step: "sources" as const, path: "backup" as const, backupRestored: true as const, sourceContentType: "novels" as const };
    expect(normalizeFirstRunState({ firstRun: state })).toEqual(state);
    expect(canAdvanceFirstRun(state, EMPTY_READINESS)).toBe(false);
    expect(canAdvanceFirstRun(state, { ...EMPTY_READINESS, sourcesConfigured: true })).toBe(true);
  });

  it("requires a loaded repository and an installed extension for source setup", () => {
    expect(isFirstRunSourceSetupReady({ repositoryCount: 1, installedCount: 0, loading: false, hasError: false })).toBe(false);
    expect(isFirstRunSourceSetupReady({ repositoryCount: 0, installedCount: 1, loading: false, hasError: false })).toBe(false);
    expect(isFirstRunSourceSetupReady({ repositoryCount: 1, installedCount: 1, loading: true, hasError: false })).toBe(false);
    expect(isFirstRunSourceSetupReady({ repositoryCount: 1, installedCount: 1, loading: false, hasError: true })).toBe(false);
    expect(isFirstRunSourceSetupReady({ repositoryCount: 1, installedCount: 1, loading: false, hasError: false })).toBe(true);
  });

  it("accepts a restore only when at least one payload applied and none failed", () => {
    expect(isFirstRunBackupRestoreComplete(null)).toBe(false);
    expect(isFirstRunBackupRestoreComplete([])).toBe(false);
    expect(isFirstRunBackupRestoreComplete([{ status: "skipped" }])).toBe(false);
    expect(isFirstRunBackupRestoreComplete([{ status: "success" }, { status: "warning" }])).toBe(true);
    expect(isFirstRunBackupRestoreComplete([{ status: "success" }, { status: "failed" }])).toBe(false);
  });
});
