import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ state: { repositories: [] as any[], catalogEntries: [] as any[], installedPlugins: [] as any[] } }));
vi.mock("./repositoryState", () => ({ loadNovelRepositoryState: async () => structuredClone(f.state) }));
import { loadInstalledNovelSources, loadTrustedInstalledNovelSources } from "./sources";
beforeEach(() => {
  f.state = { repositories: [{ id: "owner", normalizedUrl: "https://owner.test", enabled: true, trustState: "trusted" }],
    installedPlugins: [{ pluginId: "one", repositoryId: "owner", version: "1", enabled: true, disabledReason: null, artifactPath: "one.js" }],
    catalogEntries: [{ pluginId: "one", repositoryId: "foreign", version: "2", name: "Foreign", artifactUrl: "https://foreign.test/code.js" }] };
});
describe("installed Novel source provenance", () => {
  it("never borrows a homonymous plugin's metadata from a different repository", async () => {
    expect(await loadInstalledNovelSources()).toEqual([]);
  });
  it("permits owning-repository metadata fallback while reporting the installed version", async () => {
    f.state.catalogEntries[0].repositoryId = "owner";
    expect(await loadInstalledNovelSources()).toMatchObject([{ pluginId: "one", repositoryId: "owner", version: "1" }]);
  });
  it.each(["disabled-repository", "disabled-plugin"])("does not expose %s as trusted usable", async reason => {
    f.state.catalogEntries[0].repositoryId = "owner";
    if (reason === "disabled-repository") f.state.repositories[0].enabled = false;
    else f.state.installedPlugins[0].disabledReason = "runtime-error";
    expect(await loadTrustedInstalledNovelSources()).toEqual([]);
  });
});
