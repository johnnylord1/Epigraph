import { describe, expect, it, vi } from "vitest";
import { createNovelRestoreDependencySession } from "./restoreDependencies";
import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";
import type { PersistedNovelRepositoryState } from "../novels/repositoryState";

const snapshot = { entries: [], plugins: [], repositories: [] } as unknown as RestoredEpigraphNovelsSnapshot;
const state = { repositories: [], installedPlugins: [], catalogEntries: [] } as unknown as PersistedNovelRepositoryState;
describe("restore dependency session", () => {
  it("freezes approval and refuses a second preparation while the first holds admission", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const release = vi.fn(async () => {}), load = vi.fn(async () => state);
    const provision = vi.fn(async (_state, approval) => {
      await pending;
      expect(approval.plugins).toEqual({ one: "https://approved.test" });
      return { state, warnings: [], installedPlugins: 0, addedRepositories: 0 };
    });
    const session = createNovelRestoreDependencySession({ target: () => "a", snapshot, load, provision, admit: async () => release });
    const approval = { repositoryUrls: ["https://approved.test"], plugins: { one: "https://approved.test" } };
    const active = session.apply(approval);
    approval.plugins.one = "https://other.test";
    await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce());
    await expect(session.apply(approval)).rejects.toThrow("RESTORE_CONFLICT");
    expect(release).not.toHaveBeenCalled();
    finish(); await active;
    expect(load).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledOnce();
  });
  it("inspects without admission or provisioning and binds later actions to the original target", async () => {
    let target = "a";
    const provision = vi.fn(), admit = vi.fn();
    const session = createNovelRestoreDependencySession({ target: () => target, load: async () => state, snapshot, provision, admit });
    expect(await session.inspect()).toEqual({ plugins: [] });
    expect(provision).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
    target = "b";
    await expect(session.apply({ repositoryUrls: [], plugins: {} })).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(provision).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
  });
  it("holds admission through provisioning and fresh inspection, then releases on failure", async () => {
    const calls: string[] = [];
    const session = createNovelRestoreDependencySession({ target: () => "a", snapshot,
      admit: async () => { calls.push("admit"); return async () => { calls.push("release"); }; },
      load: async () => { calls.push("load"); return state; },
      provision: async () => { calls.push("provision"); throw Error("failed"); },
    });
    await expect(session.apply({ repositoryUrls: [], plugins: {} })).rejects.toThrow("failed");
    expect(calls).toEqual(["admit", "load", "provision", "release"]);
  });
});
