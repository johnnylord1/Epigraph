import { describe, expect, it } from "vitest";
import type { Tracker } from "../types";
import {
  buildTrackingProviderInventory,
  loadTrackingProviderInventory,
  TRACKING_PROVIDER_STATE_EVENTS,
  type TrackingProviderInventoryEntry,
} from "./providerInventory";

function tracker(id: number, name: string, isLoggedIn = false): Tracker {
  return {
    id,
    name,
    isLoggedIn,
    icon: "",
    authUrl: null,
    supportsPrivateTracking: false,
    scores: [],
    statuses: [],
  };
}

function nativeProvider(name: string, isLoggedIn: boolean): TrackingProviderInventoryEntry {
  return {
    id: `native:${name.toLowerCase()}`,
    name,
    isLoggedIn,
    origin: "native",
    serverTrackerId: null,
  };
}

describe("tracking provider inventory", () => {
  it("keeps every tracker returned by Suwayomi and appends native providers", () => {
    const inventory = buildTrackingProviderInventory(
      [
        tracker(1, "MyAnimeList", true),
        tracker(2, "AniList", true),
        tracker(3, "Kitsu"),
        tracker(4, "MangaUpdates"),
        tracker(5, "Bangumi"),
      ],
      [nativeProvider("Hardcover", true)],
    );

    expect(inventory.map((provider) => provider.name)).toEqual([
      "MyAnimeList",
      "AniList",
      "Kitsu",
      "MangaUpdates",
      "Bangumi",
      "Hardcover",
    ]);
    expect(inventory.find((provider) => provider.name === "Hardcover")?.isLoggedIn).toBe(true);
  });

  it("merges equivalent server and native providers instead of duplicating them", () => {
    const inventory = buildTrackingProviderInventory(
      [tracker(9, "Hardcover")],
      [nativeProvider("Hardcover", true)],
    );

    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      name: "Hardcover",
      isLoggedIn: true,
      origin: "combined",
      serverTrackerId: 9,
    });
  });

  it("loads the registered native inventory without exposing provider state details", () => {
    const inventory = loadTrackingProviderInventory([tracker(1, "MyAnimeList")]);

    expect(inventory.map((provider) => provider.name)).toContain("Hardcover");
    expect(TRACKING_PROVIDER_STATE_EVENTS).toContain("epigraph-hardcover-state-changed");
    expect(Object.keys(inventory.find((provider) => provider.name === "Hardcover") ?? {})).toEqual([
      "id",
      "name",
      "isLoggedIn",
      "origin",
      "serverTrackerId",
    ]);
  });
});
