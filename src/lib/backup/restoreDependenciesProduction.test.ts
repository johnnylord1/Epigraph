import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  store: { runtimeResolvedLocalProfileId: "a", runtimeServerUrl: "http://a" },
  invoke: vi.fn(), install: vi.fn(), add: vi.fn(),
  extensions: [{ packageName: "pkg", storeId: "repo", isInstalled: false }],
}));
vi.mock("../../store/state.svelte", () => ({ store: f.store, bumpContentSetupVersion() {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: f.invoke }));
vi.mock("../client", () => ({ gql: async () => ({ trackers: { nodes: [] } }) }));
vi.mock("../manga/runtime", () => ({ getManagedSourceRuntime: async () => ({
  listStores: async () => [{ id: "repo", indexUrl: "https://repo.test" }],
  listExtensions: async () => f.extensions, installExtension: f.install, addStore: f.add, refreshExtensions: async () => [],
}) }));
vi.mock("./storageRuntime", () => ({ loadSettingsStorageRuntime: async () => ({
  restoreLnReaderNovelsBackup: async () => ({ entries: [], plugins: [], repositories: [] }),
  restoreEpigraphNovelsPayload: async () => ({ entries: [], plugins: [], repositories: [] }),
  loadNovelRepositoryState: async () => ({ repositories: [], installedPlugins: [], catalogEntries: [] }),
  loadSourceInventory: async () => ({ inventory: [], availableExtensions: [], warnings: [], repoUrls: [] }),
  readOverlayFile: async () => ({}), parseMihonBackup: async () => ({ extensionStores: [] }),
  analyzeBackupReconciliation: async () => ({ analysis: { exactMatches: [], autoReconciled: [], unresolved: [], warnings: [],
    needsReview: [{ orphanSourceId: "old", sourceName: "Old", candidates: [{ extensionPkgName: "pkg", sourceId: "new" }] }] } }),
}) }));
import { createProductionNovelDependencySession } from "./restoreDependencies";
import { createProductionMangaDependencySession } from "./mangaRestoreDependencies";
beforeEach(() => {
  vi.clearAllMocks(); f.store.runtimeResolvedLocalProfileId = "a";
  f.extensions = [{ packageName: "pkg", storeId: "repo", isInstalled: false }];
  f.invoke.mockImplementation(async command => command === "restore_session_admit" ? "token" : null);
  f.install.mockResolvedValue(undefined);
});
describe("production dependency factory boundaries", () => {
  it.each(["manga", "novels"])("%s refuses a profile change during file reading before admission", async domain => {
    const file = new File(["x"], "backup");
    vi.spyOn(file, "arrayBuffer").mockImplementation(async () => { f.store.runtimeResolvedLocalProfileId = "b"; return new ArrayBuffer(0); });
    await expect(domain === "manga" ? createProductionMangaDependencySession(file, "native") : createProductionNovelDependencySession(file, "lnreader")).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
  });
  it.each(["manga", "novels"])("%s releases admission after a target change without provisioning", async domain => {
    const file = new File(["x"], "backup");
    const session = domain === "manga" ? await createProductionMangaDependencySession(file, "native") : await createProductionNovelDependencySession(file, "lnreader");
    f.invoke.mockImplementation(async command => {
      if (command === "restore_session_admit") { f.store.runtimeResolvedLocalProfileId = "b"; return "token"; }
      return null;
    });
    const action = "install" in session ? session.install({ packageName: "pkg", storeId: "repo" }) : session.apply({ repositoryUrls: [], plugins: {} });
    await expect(action).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(f.install).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenLastCalledWith("restore_session_release", { token: "token" });
  });
  it("uses the managed installation once and reads fresh source state without inventing availability", async () => {
    const session = await createProductionMangaDependencySession(new File(["x"], "backup"), "native");
    const result = await session.install({ packageName: "pkg", storeId: "repo" });
    expect(f.install).toHaveBeenCalledOnce(); expect(f.install).toHaveBeenCalledWith({ packageName: "pkg", assertTarget: expect.any(Function) });
    expect(result.sources[0].orphanSourceId).toBe("old");
    expect(f.invoke).toHaveBeenLastCalledWith("restore_session_release", { token: "token" });
  });
  it("refuses an origin that changed after production inspection", async () => {
    const session = await createProductionMangaDependencySession(new File(["x"], "backup"), "native");
    await session.inspect(); f.extensions[0].storeId = "foreign";
    await expect(session.install({ packageName: "pkg", storeId: "repo" })).rejects.toThrow("RESTORE_EXTENSION_ORIGIN_CHANGED");
    expect(f.install).not.toHaveBeenCalled();
  });
  it("binds the final installation guard to the production session's original profile", async () => {
    const mutation = vi.fn();
    f.install.mockImplementation(async ({ assertTarget }) => {
      await Promise.resolve(); f.store.runtimeResolvedLocalProfileId = "b";
      assertTarget(); mutation();
    });
    const session = await createProductionMangaDependencySession(new File(["x"], "backup"), "native");
    await expect(session.install({ packageName: "pkg", storeId: "repo" })).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(mutation).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenLastCalledWith("restore_session_release", { token: "token" });
  });
});
