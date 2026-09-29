import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  store: { runtimeResolvedLocalProfileId: "test", runtimeServerUrl: "http://test" },
  snapshot: { entries: [] as any[], plugins: [] as any[], repositories: [], chapters: [], progress: [], bookmarks: [], history: [] },
  repositories: { repositories: [] as any[], installedPlugins: [] as any[], catalogEntries: [] },
}));
vi.mock("../../store/state.svelte", () => ({ store: f.store }));
vi.mock("./storageRuntime", async () => {
  const { classifyEpigraphNovelsSnapshot } = await import("./novelsBackup");
  const restore = async (_bytes: unknown, runtime: Parameters<typeof classifyEpigraphNovelsSnapshot>[2]) => classifyEpigraphNovelsSnapshot(f.snapshot, "repository-aware", runtime);
  return { loadSettingsStorageRuntime: async () => ({ loadNovelRepositoryState: async () => f.repositories,
    restoreLnReaderNovelsBackup: restore, restoreEpigraphNovelsPayload: restore }) };
});
import { prepareProductionNovels } from "./restoreAdapters";
beforeEach(() => {
  f.snapshot = { entries: [{ id: "one", title: "Novel", path: "/one", source: null, addedAt: 1, updatedAt: 1 }],
    plugins: [{ id: "unused", repositoryUrl: "https://unused.test" }], repositories: [], chapters: [], progress: [], bookmarks: [], history: [] };
  f.repositories = { repositories: [], installedPlugins: [], catalogEntries: [] };
});
describe.each(["epigraph", "lnreader"] as const)("production %s Novel readiness", format => {
  it("does not block metadata-only content because an unused backup plugin is absent", async () => {
    const result = await prepareProductionNovels(new ArrayBuffer(0), format);
    expect(result.restored.summary.restoredMetadataOnlyCount).toBe(1);
  });
  it("refuses an actually referenced missing plugin", async () => {
    f.snapshot.entries[0].source = { pluginId: "used", sourceId: "used", repositoryUrl: null };
    await expect(prepareProductionNovels(new ArrayBuffer(0), format)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
  });
  it("refuses conflicting provenance for a plugin the selected Novel uses", async () => {
    f.snapshot.entries[0].source = { pluginId: "used", sourceId: "used", repositoryUrl: "https://owner.test" };
    f.snapshot.plugins = [{ id: "used", repositoryUrl: "https://other.test" }];
    f.repositories.repositories = [{ id: "owner", normalizedUrl: "https://owner.test", enabled: true, trustState: "trusted" }];
    f.repositories.installedPlugins = [{ pluginId: "used", repositoryId: "owner", enabled: true, disabledReason: null }];
    await expect(prepareProductionNovels(new ArrayBuffer(0), format)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
  });
});
