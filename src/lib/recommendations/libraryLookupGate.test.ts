import { beforeEach, describe, expect, it } from "vitest";
import type { SyncdSyncProgress } from "../syncdDesktop";
import { firstRunBackgroundSync } from "../setup/firstRunBackgroundSync.svelte";
import {
  createLibraryArrivalTracker,
  libraryLookupGate,
  libraryLookupsWaitForSync,
  libraryWorksStillArriving,
  requestLibraryAnalysis,
  setLibraryWorksArriving,
} from "./libraryLookupGate.svelte";

function progress(fields: Partial<SyncdSyncProgress>): SyncdSyncProgress {
  return { pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 0, ...fields } as SyncdSyncProgress;
}

describe("libraryLookupGate", () => {
  beforeEach(() => {
    firstRunBackgroundSync.running = false;
    libraryLookupGate.syncing = false;
    libraryLookupGate.forced = false;
    libraryLookupGate.requested = 0;
  });

  it("counts library uploads and catalog projections, not details or tracker logins", () => {
    expect(libraryWorksStillArriving(null)).toBe(false);
    expect(libraryWorksStillArriving(progress({ pendingDetails: 40, pendingTrackerLogins: 2 }))).toBe(false);
    expect(libraryWorksStillArriving(progress({ pendingLibraryUploads: 3 }))).toBe(true);
    expect(libraryWorksStillArriving(progress({ pendingProjections: 9, pendingCatalogProjections: 0 }))).toBe(false);
    expect(libraryWorksStillArriving(progress({ pendingProjections: 9 }))).toBe(true);
  });

  it("stops waiting for a sync that has not moved for the stall time", () => {
    let clock = 0;
    const arriving = createLibraryArrivalTracker(() => clock, 1_000);
    expect(arriving(progress({ pendingProjections: 10, appliedProjections: 0 }))).toBe(true);
    clock = 900;
    expect(arriving(progress({ pendingProjections: 10, appliedProjections: 0 }))).toBe(true);
    clock = 1_000;
    expect(arriving(progress({ pendingProjections: 10, appliedProjections: 0 }))).toBe(false);
    clock = 1_100;
    expect(arriving(progress({ pendingProjections: 8, appliedProjections: 2 }))).toBe(true);
    expect(arriving(progress({}))).toBe(false);
  });

  it("waits while works arrive, and a manual analysis lasts only until that sync ends", () => {
    expect(libraryLookupsWaitForSync()).toBe(false);
    setLibraryWorksArriving(true);
    expect(libraryLookupsWaitForSync()).toBe(true);

    requestLibraryAnalysis();
    expect(libraryLookupGate.requested).toBe(1);
    expect(libraryLookupsWaitForSync()).toBe(false);
    setLibraryWorksArriving(true);
    expect(libraryLookupsWaitForSync()).toBe(false);

    setLibraryWorksArriving(false);
    setLibraryWorksArriving(true);
    expect(libraryLookupsWaitForSync()).toBe(true);
  });

  it("waits for a sync setup left running", () => {
    firstRunBackgroundSync.running = true;
    expect(libraryLookupsWaitForSync()).toBe(true);
    requestLibraryAnalysis();
    expect(libraryLookupsWaitForSync()).toBe(false);
  });
});
