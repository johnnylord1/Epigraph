import { afterEach, describe, expect, it, vi } from "vitest";
import { cache, CACHE_KEYS } from "../cache";
import { gql } from "../client";
import { GET_TRACKERS, LOGIN_TRACKER_OAUTH } from "../queries";
import type { Tracker } from "../types";
import { createProductionFirstRunTrackerWorkflow } from "./firstRunTrackerWorkflow";

vi.mock("../client", () => ({ gql: vi.fn() }));
vi.mock("../novels/hardcover", () => ({
  loadHardcoverState: () => ({ auth: { connected: false, username: null } }),
  connectHardcover: vi.fn(),
  disconnectHardcover: vi.fn(),
}));

const tracker = (isLoggedIn: boolean): Tracker => ({
  id: 1, name: "AniList", icon: "", isLoggedIn,
  authUrl: "https://anilist.test/oauth?response_type=token",
  supportsPrivateTracking: false, scores: [], statuses: [],
});

afterEach(() => { cache.clearAll(); vi.resetAllMocks(); });

describe("production first-run tracker cache", () => {
  it("does not let a discarded pre-login response overwrite the Home snapshot", async () => {
    let resolveOld!: (result: { trackers: { nodes: Tracker[] } }) => void;
    let reads = 0;
    let connected = false;
    vi.mocked(gql).mockImplementation(async (query) => {
      if (query === LOGIN_TRACKER_OAUTH) {
        connected = true;
        return { loginTrackerOAuth: { isLoggedIn: true } };
      }
      if (query === GET_TRACKERS) {
        if (++reads === 1) return new Promise((resolve) => { resolveOld = resolve; });
        return { trackers: { nodes: [tracker(connected)] } };
      }
      throw new Error("Unexpected query");
    });
    const workflow = createProductionFirstRunTrackerWorkflow();
    const oldLoad = workflow.load();
    await workflow.load();
    await workflow.submitOAuth("1", "test-token");
    // Home reloads its own snapshot after the login invalidates the shared cache.
    const fetchHomeTrackers = vi.fn(async () => [tracker(connected)]);
    await cache.get(CACHE_KEYS.TRACKERS, fetchHomeTrackers);
    resolveOld({ trackers: { nodes: [tracker(false)] } });
    await oldLoad;

    expect(workflow.providers.find((provider) => provider.id === "1")?.connected).toBe(true);
    const homeTrackers = await cache.get(CACHE_KEYS.TRACKERS, fetchHomeTrackers);
    expect(homeTrackers[0].isLoggedIn).toBe(true);
  });
});
