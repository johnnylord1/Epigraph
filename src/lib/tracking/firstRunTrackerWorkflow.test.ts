import { describe, expect, it, vi } from "vitest";

import {
  createFirstRunTrackerWorkflow,
  type FirstRunTracker,
} from "./firstRunTrackerWorkflow";

const trackers: FirstRunTracker[] = [
  { id: "1", name: "AniList", iconUrl: null, authMode: "oauth", authUrl: "https://anilist.test/oauth?response_type=token", connected: false },
  { id: "2", name: "MyAnimeList", iconUrl: null, authMode: "oauth", authUrl: "https://mal.test/oauth", connected: false },
  { id: "3", name: "Kitsu", iconUrl: null, authMode: "oauth", authUrl: "https://kitsu.test/oauth", connected: false },
  { id: "4", name: "MangaUpdates", iconUrl: null, authMode: "credentials", authUrl: null, connected: false },
  { id: "5", name: "Shikimori", iconUrl: null, authMode: "oauth", authUrl: "https://shikimori.test/oauth", connected: false },
  { id: "6", name: "Komga", iconUrl: null, authMode: "credentials", authUrl: null, connected: false },
];

describe("first-run tracker workflow", () => {
  it("keeps every server tracker visible and refreshes state after a successful login", async () => {
    const loadTrackers = vi.fn()
      .mockResolvedValueOnce(trackers)
      .mockResolvedValueOnce(trackers.map((tracker) => tracker.id === "1" ? { ...tracker, connected: true } : tracker));
    const loginOAuth = vi.fn(async () => true);
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers,
      loginOAuth,
      loginCredentials: vi.fn(),
      logoutTracker: vi.fn(),
      loadHardcover: () => ({ connected: false, username: null }),
      connectHardcover: vi.fn(),
      disconnectHardcover: vi.fn(),
    });

    await workflow.load();
    expect(workflow.providers.filter((provider) => provider.kind === "suwayomi")).toHaveLength(6);
    await workflow.submitOAuth("1", "https://callback.test/#access_token=abc");

    expect(loginOAuth).toHaveBeenCalledWith(1, "access_token=abc");
    expect(workflow.providers.find((provider) => provider.id === "1")?.connected).toBe(true);
  });

  it("rejects incomplete credentials or an invalid OAuth callback before any login write", async () => {
    const loginOAuth = vi.fn();
    const loginCredentials = vi.fn();
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers: async () => trackers,
      loginOAuth,
      loginCredentials,
      logoutTracker: vi.fn(),
      loadHardcover: () => ({ connected: false, username: null }),
      connectHardcover: vi.fn(),
      disconnectHardcover: vi.fn(),
    });
    await workflow.load();

    await expect(workflow.submitOAuth("1", "https://callback.test/?wrong=value")).rejects.toThrow("Paste");
    await expect(workflow.submitCredentials("4", "reader", "")).rejects.toThrow("username and password");

    expect(loginOAuth).not.toHaveBeenCalled();
    expect(loginCredentials).not.toHaveBeenCalled();
  });

  it("uses the same explicit Hardcover token connection and never stores an empty token", async () => {
    const connectHardcover = vi.fn(async () => ({ connected: true, username: "reader" }));
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers: async () => [],
      loginOAuth: vi.fn(),
      loginCredentials: vi.fn(),
      logoutTracker: vi.fn(),
      loadHardcover: () => ({ connected: false, username: null }),
      connectHardcover,
      disconnectHardcover: vi.fn(),
    });
    await workflow.load();

    await expect(workflow.submitHardcover(" ")).rejects.toThrow("required");
    await workflow.submitHardcover("token-from-user");

    expect(connectHardcover).toHaveBeenCalledWith("token-from-user");
    expect(workflow.providers.find((provider) => provider.id === "hardcover")?.connected).toBe(true);
  });

  it("keeps Hardcover available when the manga server cannot load its trackers", async () => {
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers: vi.fn().mockRejectedValue(new Error("Server unavailable")),
      loginOAuth: vi.fn(), loginCredentials: vi.fn(), logoutTracker: vi.fn(),
      loadHardcover: () => ({ connected: true, username: "reader" }),
      connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
    });
    await workflow.load();
    expect(workflow.providers.find((provider) => provider.id === "hardcover")?.connected).toBe(true);
    expect(workflow.loadError).toContain("Server unavailable");
  });

  it("rejects an unconfirmed login and does not report it as connected", async () => {
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers: async () => trackers,
      loginOAuth: vi.fn().mockResolvedValue(false), loginCredentials: vi.fn().mockResolvedValue(false), logoutTracker: vi.fn(),
      loadHardcover: () => ({ connected: false, username: null }),
      connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
    });
    await workflow.load();
    await expect(workflow.submitOAuth("1", "token")).rejects.toThrow("not confirmed");
    await expect(workflow.submitCredentials("4", "reader", "bad password")).rejects.toThrow("not confirmed");
    expect(workflow.providers.some((provider) => provider.connected)).toBe(false);
  });

  it("retains confirmed authentication when the follow-up refresh fails, without consuming the callback twice", async () => {
    const loginOAuth = vi.fn().mockResolvedValue(true);
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers: vi.fn().mockResolvedValueOnce(trackers).mockRejectedValue(new Error("Refresh unavailable")),
      loginOAuth, loginCredentials: vi.fn(), logoutTracker: vi.fn(),
      loadHardcover: () => ({ connected: false, username: null }),
      connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
    });
    await workflow.load();
    await workflow.submitOAuth("1", "single-use-token");
    expect(workflow.providers.find((provider) => provider.id === "1")?.connected).toBe(true);
    await workflow.submitOAuth("1", "single-use-token");
    expect(loginOAuth).toHaveBeenCalledOnce();
    expect(workflow.loadError).toContain("Refresh unavailable");
  });

  it("ignores a late pre-login snapshot and can still disconnect the confirmed account", async () => {
    let resolveOldLoad!: (value: FirstRunTracker[]) => void;
    const disconnected = trackers.map((tracker) => ({ ...tracker }));
    let connected = false;
    const logoutTracker = vi.fn(async () => { connected = false; return true; });
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOldLoad = resolve; }))
        .mockImplementation(async () => trackers.map((tracker) => tracker.id === "1" ? { ...tracker, connected } : tracker)),
      loginOAuth: vi.fn(async () => { connected = true; return true; }), loginCredentials: vi.fn(), logoutTracker,
      loadHardcover: () => ({ connected: false, username: null }), connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
    });
    const oldLoad = workflow.load();
    await workflow.load();
    await workflow.submitOAuth("1", "single-use-token");
    resolveOldLoad(disconnected);
    await oldLoad;
    expect(workflow.providers.find((provider) => provider.id === "1")?.connected).toBe(true);
    await workflow.logout("1");
    expect(logoutTracker).toHaveBeenCalledOnce();
    expect(connected).toBe(false);
  });
});
