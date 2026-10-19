import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstRunSyncReadinessKey, refreshFirstRunSyncLibrary } from "./firstRunSyncReadiness";
import type { SyncdReplicationSnapshot } from "../syncdDesktop";

const live: SyncdReplicationSnapshot = { localProfileId: "main", activeSessionKey: "remote-a",
  replicationStatus: "live", remoteBootstrapGeneration: 3, paused: false, lastAppliedScopes: [] };

const { state, publish, books, novels, manga, wake } = vi.hoisted(() => ({
  state: { runtimeResolvedLocalProfileId: "main", runtimeServerUrl: "fixture", settings: { defaultLocalProfileId: "main" } },
  publish: vi.fn(), books: vi.fn(), novels: vi.fn(), manga: vi.fn(), wake: vi.fn(),
}));
vi.mock("../../store/state.svelte", () => ({ store: state, replaceBooksState: publish,
  setLibraryMangaSnapshot: publish, setSearchNovelLibrarySnapshot: publish, bumpContentSetupVersion: publish }));
vi.mock("../books/libraryState", () => ({ reloadBookLibraryState: books }));
vi.mock("../novels/libraryState", () => ({ reloadNovelLibraryState: novels }));
vi.mock("../client", () => ({ gql: manga }));
vi.mock("../serverLifecycle", () => ({ ensureServerAwakeFor: wake }));

describe("First Run sync readiness", () => {
  it("accepts a completed empty remote bootstrap, not a positive title count", () => {
    expect(firstRunSyncReadinessKey("main", live)).not.toBeNull();
  });
  it.each([null, { ...live, remoteBootstrapGeneration: undefined }, { ...live, remoteBootstrapGeneration: 0 },
    { ...live, remoteBootstrapGeneration: 0.5 }, { ...live, localProfileId: "other" },
    { ...live, activeSessionKey: null }, { ...live, paused: true }, { ...live, lastError: "apply failed" }])("refuses absent, stale, wrong-profile and failed readiness %#", snapshot => {
    expect(firstRunSyncReadinessKey("main", snapshot)).toBeNull();
  });
  it.each(["idle", "connecting", "replaying", "paused", "degraded", "offline", "needs_reauth"] as const)("refuses %s", replicationStatus => {
    expect(firstRunSyncReadinessKey("main", { ...live, replicationStatus })).toBeNull();
  });
  it("invalidates prior hydration after a worker or session replacement, not a progress checkpoint", () => {
    const key = firstRunSyncReadinessKey("main", live);
    for (const change of [{ remoteBootstrapGeneration: 4 }, { activeSessionKey: "remote-b" }]) {
      expect(firstRunSyncReadinessKey("main", { ...live, ...change })).not.toBe(key);
    }
    expect(firstRunSyncReadinessKey("main", {
      ...live,
      lastConnectedAtMs: 100,
      lastAppliedAtMs: 200,
      lastAppliedScopes: ["novels:profile:main"],
    })).toBe(key);
  });
});

describe("First Run production library refresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.runtimeResolvedLocalProfileId = "main";
    state.runtimeServerUrl = "fixture";
    books.mockResolvedValue({ books: [] });
    novels.mockResolvedValue({ entries: [], chapters: [] });
    manga.mockResolvedValue({ mangas: { nodes: [] } });
    wake.mockResolvedValue(true);
  });
  it("wakes the comics server before the Manga query on a fresh install", async () => {
    wake.mockImplementationOnce(async () => {
      expect(manga).not.toHaveBeenCalled();
      return true;
    });
    await refreshFirstRunSyncLibrary("main", () => true);
    expect(wake).toHaveBeenCalledWith("startup", expect.objectContaining({ serverUrl: "fixture", profileId: "main" }));
    expect(manga).toHaveBeenCalledTimes(1);
  });
  it("awaits strict local reads and the actual Manga query before publishing a replicated Manga scope", async () => {
    await refreshFirstRunSyncLibrary("main", () => true);
    expect(books).toHaveBeenCalledWith({ profileId: "main" }, { strict: true });
    expect(novels).toHaveBeenCalledWith({ profileId: "main" }, { strict: true });
    expect(manga).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(4);
  });
  it("does not require an unavailable Manga runtime when the remote bootstrap has no Manga scope", async () => {
    manga.mockRejectedValueOnce(Error("unavailable"));
    await refreshFirstRunSyncLibrary("main", () => true, { requiresMangaRefresh: false });
    expect(manga).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(books).toHaveBeenCalledWith({ profileId: "main" }, { strict: true });
    expect(novels).toHaveBeenCalledWith({ profileId: "main" }, { strict: true });
    expect(publish).toHaveBeenCalledTimes(3);
  });
  it.each([books, novels, manga])("does not publish success after a failed required domain read %#", async read => {
    read.mockRejectedValueOnce(Error("unavailable"));
    await expect(refreshFirstRunSyncLibrary("main", () => true)).rejects.toThrow("unavailable");
    expect(publish).not.toHaveBeenCalled();
  });
  it("rejects a changed profile before reading or publishing", async () => {
    state.runtimeResolvedLocalProfileId = "other";
    await expect(refreshFirstRunSyncLibrary("main", () => true)).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(books).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it("rejects a target change or detached observer during reads", async () => {
    manga.mockImplementationOnce(async () => {
      state.runtimeServerUrl = "other";
      return { mangas: { nodes: [] } };
    });
    await expect(refreshFirstRunSyncLibrary("main", () => true)).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(publish).not.toHaveBeenCalled();
    await expect(refreshFirstRunSyncLibrary("main", () => false)).rejects.toThrow("RESTORE_TARGET_CHANGED");
  });
});
