import { describe, expect, it, vi } from "vitest";
import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";
import {
  provisionEpigraphNovelDependencies,
  planNovelRestoreDependencies,
  novelRestoreRuntimeState,
  type NovelRestoreProvisioningOperations,
} from "./novelsRestoreProvisioning";
import type { PersistedNovelRepositoryState } from "../novels/repositoryState";

function emptyState(): PersistedNovelRepositoryState {
  return {
    version: 1,
    scopeKey: "profile:test",
    repositories: [],
    catalogEntries: [],
    installedPlugins: [],
    languageFilter: [],
    updatedAtMs: null,
  };
}

const restored = {
  exportMode: "repository-aware",
  entries: [{
    id: "novel-1",
    title: "The Example",
    path: "/novel-1",
    source: {
      repositoryUrl: "https://plugins.example/index.json",
      pluginId: "example-source",
      sourceId: "example-source",
    },
    addedAt: 1,
    updatedAt: 1,
  }],
  chapters: [],
  progress: [],
  bookmarks: [],
  history: [],
  repositories: [{ url: "https://plugins.example/index.json", name: "Example" }],
  plugins: [{ id: "example-source", repositoryUrl: "https://plugins.example/index.json" }],
  classifications: [],
  issues: [],
  summary: {
    totalEntries: 1,
    restoredUsableCount: 0,
    restoredNeedsRepositoryCount: 1,
    restoredNeedsPluginCount: 0,
    restoredMetadataOnlyCount: 0,
  },
} satisfies RestoredEpigraphNovelsSnapshot;

describe("novel restore dependency provisioning", () => {
  it.each(["refresh-failed", "disabled-installed"])("does not install over %s state", async scenario => {
    const state = emptyState();
    const url = "https://plugins.example/index.json";
    state.repositories = [{ id: "repo", profileId: "test", url, normalizedUrl: url, enabled: true,
      trustState: "trusted", recommendedSeed: false, lastFetchedAtMs: null, lastSuccessAtMs: 1, etag: null, lastModified: null, lastError: null }];
    state.catalogEntries = [{ repositoryId: "repo", pluginId: "example-source", name: "Example", site: "test", lang: "en", version: "1",
      artifactUrl: "https://plugins.example/plugin.js", iconUrl: null, customJsUrl: null, customCssUrl: null, manifestHash: null, fetchedAtMs: 1 }];
    if (scenario === "disabled-installed") state.installedPlugins = [{ profileId: "test", repositoryId: "repo", pluginId: "example-source", version: "1",
      enabled: false, disabledReason: "user-disabled", artifactPath: "example.js", customJsPath: null, customCssPath: null, hasSettings: true, installedAtMs: 1, updatedAtMs: 1 }];
    const installPlugin = vi.fn(async ({ state }) => state);
    const result = await provisionEpigraphNovelDependencies({ restored, state, scopeInput: { profileId: "test" },
      approvals: { repositoryUrls: [url], plugins: { "example-source": url } },
      operations: { addRepository: vi.fn(), trustRepository: vi.fn(), saveState: async current => current, installPlugin,
        refreshRepository: async current => ({ state: current, repository: current.repositories[0], status: scenario === "refresh-failed" ? "error" : "not-modified", httpStatus: 500, catalogCount: 1, fetchedAtMs: 2 }) },
    });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(result.installedPlugins).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.state.installedPlugins).toEqual(state.installedPlugins);
  });
  it("counts only enabled plugins with a trusted enabled owning repository", () => {
    const state = emptyState();
    state.repositories = [{ id: "repo", profileId: "test", url: "https://repo.test", normalizedUrl: "https://repo.test", enabled: true,
      trustState: "trusted", recommendedSeed: false, lastFetchedAtMs: null, lastSuccessAtMs: null, etag: null, lastModified: null, lastError: null }];
    state.installedPlugins = [{ profileId: "test", repositoryId: "repo", pluginId: "one", version: "1", enabled: true, disabledReason: null,
      artifactPath: "one.js", customJsPath: null, customCssPath: null, hasSettings: false, installedAtMs: 1, updatedAtMs: 1 }];
    expect(novelRestoreRuntimeState(state).availableSourceIds).toEqual(["one"]);
    state.repositories[0].trustState = "unknown";
    expect(novelRestoreRuntimeState(state).availableSourceIds).toEqual([]);
    state.repositories[0].trustState = "trusted"; state.repositories[0].enabled = false;
    expect(novelRestoreRuntimeState(state).availableSourceIds).toEqual([]);
    state.repositories[0].enabled = true; state.installedPlugins[0].disabledReason = "user-disabled";
    expect(novelRestoreRuntimeState(state).availableSourceIds).toEqual([]);
    state.installedPlugins[0].disabledReason = null; state.installedPlugins[0].repositoryId = "foreign";
    expect(novelRestoreRuntimeState(state).availableSourceIds).toEqual([]);
  });
  it("uses an explicitly selected repository when the backup knows only the plugin ID", async () => {
    const repositoryUrl = "https://chosen.test/index.json";
    const state = emptyState();
    state.repositories = [{ id: "chosen", profileId: "test", url: repositoryUrl, normalizedUrl: repositoryUrl, enabled: true,
      trustState: "unknown", recommendedSeed: false, lastFetchedAtMs: null, lastSuccessAtMs: null, etag: null, lastModified: null, lastError: null }];
    state.catalogEntries = [{ repositoryId: "chosen", pluginId: "example-source", name: "Example", site: "test", lang: "en", version: "1",
      artifactUrl: "https://chosen.test/plugin.js", iconUrl: null, customJsUrl: null, customCssUrl: null, manifestHash: null, fetchedAtMs: 1 }];
    const trustRepository = vi.fn(current => ({ ...current, repositories: current.repositories.map(repository => ({ ...repository, trustState: "trusted" })) }));
    const installPlugin = vi.fn(async ({ state: current }) => current);
    const result = await provisionEpigraphNovelDependencies({ state, scopeInput: { profileId: "test" },
      restored: { ...restored, entries: [{ ...restored.entries[0], source: { ...restored.entries[0].source, repositoryUrl: null } }], plugins: [{ id: "example-source" }], repositories: [] },
      approvals: { repositoryUrls: [repositoryUrl], plugins: { "example-source": repositoryUrl } },
      operations: { addRepository: vi.fn(), trustRepository, refreshRepository: async current => ({ state: current, repository: current.repositories[0], status: "not-modified", httpStatus: 304, catalogCount: 1, fetchedAtMs: 1 }), installPlugin, saveState: async current => current },
    });
    expect(trustRepository).toHaveBeenCalledOnce(); expect(installPlugin).toHaveBeenCalledOnce(); expect(result.warnings).toEqual([]);
  });
  it("lists candidate origins without selecting or trusting one when backup provenance is absent", () => {
    const state = emptyState();
    state.catalogEntries = ["a", "b"].map(repositoryId => ({ repositoryId, pluginId: "example-source", name: "Example", site: "test",
      lang: "en", version: "1", artifactUrl: `https://${repositoryId}.test/plugin.js`, iconUrl: null, customJsUrl: null, customCssUrl: null, manifestHash: null, fetchedAtMs: 1 }));
    state.repositories = ["a", "b"].map(id => ({ id, profileId: "test", url: `https://${id}.test/index.json`, normalizedUrl: `https://${id}.test/index.json`,
      enabled: true, trustState: "unknown", recommendedSeed: false, lastFetchedAtMs: null, lastSuccessAtMs: null, etag: null, lastModified: null, lastError: null }));
    const before = structuredClone(state);
    const plan = planNovelRestoreDependencies({ ...restored, entries: [{ ...restored.entries[0], source: { ...restored.entries[0].source, repositoryUrl: null } }], plugins: [{ id: "example-source" }], repositories: [] }, state);
    expect(plan.plugins[0]).toMatchObject({ pluginId: "example-source", status: "needs-selection", repositoryUrls: [], selectedRepositoryUrl: null });
    expect(plan.plugins[0].candidates.map(candidate => candidate.repositoryUrl)).toEqual(["https://a.test/index.json", "https://b.test/index.json"]);
    expect(state).toEqual(before);
  });
  it("preserves conflicting backup origins instead of letting registry order select one", async () => {
    const operations = { addRepository: vi.fn(current => current), trustRepository: vi.fn(current => current), refreshRepository: vi.fn(), installPlugin: vi.fn(), saveState: vi.fn() };
    const result = await provisionEpigraphNovelDependencies({
      restored: { ...restored, plugins: [{ id: "example-source", repositoryUrl: "https://other.example/index.json" }, ...restored.plugins] },
      state: emptyState(), scopeInput: { profileId: "test" }, operations,
      approvals: { repositoryUrls: [], plugins: { "example-source": "https://plugins.example/index.json" } },
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "plugin-origin-conflict", pluginId: "example-source" }));
    expect(operations.installPlugin).not.toHaveBeenCalled();
  });
  it("does not treat backup provenance as permission to add, trust or install", async () => {
    const state = emptyState();
    const operations = { addRepository: vi.fn(current => current), trustRepository: vi.fn(current => current), refreshRepository: vi.fn(), installPlugin: vi.fn(), saveState: vi.fn() };
    const result = await provisionEpigraphNovelDependencies({ restored, state, scopeInput: { profileId: "test" }, operations });
    for (const operation of Object.values(operations)) expect(operation).not.toHaveBeenCalled();
    expect(result.state).toBe(state);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "approval-required" }));
  });
  it("adds, trusts and refreshes referenced repositories before installing plugins", async () => {
    const calls: string[] = [];
    const operations: NovelRestoreProvisioningOperations = {
      addRepository(state, input) {
        calls.push("add-repository");
        return {
          ...state,
          repositories: [{
            id: "repo-1",
            profileId: input.profileId ?? "test",
            url: input.url,
            normalizedUrl: input.url,
            recommendedSeed: false,
            trustState: "unknown",
            enabled: true,
            lastFetchedAtMs: null,
            lastSuccessAtMs: null,
            etag: null,
            lastModified: null,
            lastError: null,
          }],
        };
      },
      trustRepository(state) {
        calls.push("trust-repository");
        return {
          ...state,
          repositories: state.repositories.map((entry) => ({ ...entry, trustState: "trusted" as const })),
        };
      },
      async refreshRepository(state) {
        calls.push("refresh-repository");
        return {
          state: {
            ...state,
            catalogEntries: [{
              repositoryId: "repo-1",
              pluginId: "example-source",
              name: "Example",
              site: "example.org",
              lang: "en",
              version: "1.0.0",
              artifactUrl: "https://plugins.example/example.js",
              iconUrl: "https://plugins.example/example.png",
              customJsUrl: null,
              customCssUrl: null,
              manifestHash: null,
              fetchedAtMs: 1,
            }],
          },
          status: "updated" as const,
          repository: state.repositories[0],
          httpStatus: 200,
          catalogCount: 1,
          fetchedAtMs: 1,
        };
      },
      async installPlugin({ state, entry }) {
        calls.push("install-plugin");
        return {
          ...state,
          installedPlugins: [{
            profileId: "test",
            repositoryId: entry.repositoryId,
            pluginId: entry.pluginId,
            version: entry.version,
            enabled: true,
            disabledReason: null,
            artifactPath: "C:/plugins/example.js",
            customJsPath: null,
            customCssPath: null,
            hasSettings: true,
            installedAtMs: 1,
            updatedAtMs: 1,
          }],
        };
      },
      async saveState(state) {
        calls.push("save-state");
        return state;
      },
    };

    const result = await provisionEpigraphNovelDependencies({
      restored,
      state: emptyState(),
      approvals: { repositoryUrls: ["https://plugins.example/index.json", "https://community.example/plugins.min.json"], plugins: { "example-source": "https://plugins.example/index.json", "shared-source": "https://community.example/plugins.min.json" } },
      scopeInput: { profileId: "test" },
      operations,
    });

    expect(result.addedRepositories).toBe(1);
    expect(result.installedPlugins).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.state.installedPlugins).toHaveLength(1);
    expect(calls).toEqual([
      "add-repository",
      "trust-repository",
      "save-state",
      "refresh-repository",
      "save-state",
      "install-plugin",
      "save-state",
    ]);
  });

  it("keeps the library restore usable when a referenced plugin is no longer in the feed", async () => {
    const state = emptyState();
    state.repositories = [{
      id: "repo-1",
      profileId: "test",
      url: "https://plugins.example/index.json",
      normalizedUrl: "https://plugins.example/index.json",
      recommendedSeed: false,
      trustState: "trusted",
      enabled: true,
      lastFetchedAtMs: null,
      lastSuccessAtMs: null,
      etag: null,
      lastModified: null,
      lastError: null,
    }];
    const operations: NovelRestoreProvisioningOperations = {
      addRepository: vi.fn(),
      trustRepository: vi.fn((current) => current),
      refreshRepository: vi.fn(async (current) => ({
        state: current,
        status: "updated" as const,
        repository: current.repositories[0],
        httpStatus: 200,
        catalogCount: 0,
        fetchedAtMs: 1,
      })),
      installPlugin: vi.fn(),
      saveState: vi.fn(async (current) => current),
    };

    const result = await provisionEpigraphNovelDependencies({
      restored,
      state,
      approvals: { repositoryUrls: ["https://plugins.example/index.json", "https://community.example/plugins.min.json"], plugins: { "example-source": "https://plugins.example/index.json", "shared-source": "https://community.example/plugins.min.json" } },
      scopeInput: { profileId: "test" },
      operations,
    });

    expect(result.installedPlugins).toBe(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "plugin-not-found",
      pluginId: "example-source",
    }));
  });

  it("keeps the repository and reports a warning when catalog refresh throws", async () => {
    const operations: NovelRestoreProvisioningOperations = {
      addRepository: (current, input) => ({
        ...current,
        repositories: [{
          id: "repo-1",
          profileId: input.profileId ?? "test",
          url: input.url,
          normalizedUrl: input.url,
          recommendedSeed: false,
          trustState: "unknown",
          enabled: true,
          lastFetchedAtMs: null,
          lastSuccessAtMs: null,
          etag: null,
          lastModified: null,
          lastError: null,
        }],
      }),
      trustRepository: (current) => ({
        ...current,
        repositories: current.repositories.map((repository) => ({ ...repository, trustState: "trusted" as const })),
      }),
      refreshRepository: vi.fn(async () => { throw new Error("Catalog is temporarily offline"); }),
      installPlugin: vi.fn(async ({ state: current }) => current),
      saveState: vi.fn(async (current) => current),
    };

    const result = await provisionEpigraphNovelDependencies({
      restored,
      state: emptyState(),
      approvals: { repositoryUrls: ["https://plugins.example/index.json", "https://community.example/plugins.min.json"], plugins: { "example-source": "https://plugins.example/index.json", "shared-source": "https://community.example/plugins.min.json" } },
      scopeInput: { profileId: "test" },
      operations,
    });

    expect(result.state.repositories).toHaveLength(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "repository-refresh-failed",
      message: "Catalog is temporarily offline",
    }));
  });

  it("preserves an installed plugin when the backup records another repository", async () => {
    const state = emptyState();
    state.repositories = [
      {
        id: "repo-official",
        profileId: "test",
        url: "https://official.example/plugins.min.json",
        normalizedUrl: "https://official.example/plugins.min.json",
        recommendedSeed: false,
        trustState: "trusted",
        enabled: true,
        lastFetchedAtMs: null,
        lastSuccessAtMs: null,
        etag: null,
        lastModified: null,
        lastError: null,
      },
      {
        id: "repo-community",
        profileId: "test",
        url: "https://community.example/plugins.min.json",
        normalizedUrl: "https://community.example/plugins.min.json",
        recommendedSeed: false,
        trustState: "trusted",
        enabled: true,
        lastFetchedAtMs: null,
        lastSuccessAtMs: null,
        etag: null,
        lastModified: null,
        lastError: null,
      },
    ];
    state.catalogEntries = state.repositories.map((repository) => ({
      repositoryId: repository.id,
      pluginId: "shared-source",
      name: repository.id,
      site: "example.test",
      lang: "en",
      version: "1.0.0",
      artifactUrl: `${repository.normalizedUrl}/shared.js`,
      iconUrl: null,
      customJsUrl: null,
      customCssUrl: null,
      manifestHash: null,
      fetchedAtMs: 1,
    }));
    state.installedPlugins = [{
      profileId: "test",
      repositoryId: "repo-official",
      pluginId: "shared-source",
      version: "1.0.0",
      enabled: true,
      disabledReason: null,
      artifactPath: "official.js",
      customJsPath: null,
      customCssPath: null,
      hasSettings: false,
      installedAtMs: 1,
      updatedAtMs: 1,
    }];
    const repositoryAwareRestore = {
      ...restored,
      entries: [{
        ...restored.entries[0],
        source: {
          ...restored.entries[0].source,
          repositoryUrl: "https://community.example/plugins.min.json",
          pluginId: "shared-source",
          sourceId: "shared-source",
        },
      }],
      repositories: [],
      plugins: [{ id: "shared-source", repositoryUrl: "https://community.example/plugins.min.json" }],
    } satisfies RestoredEpigraphNovelsSnapshot;

    const result = await provisionEpigraphNovelDependencies({
      restored: repositoryAwareRestore,
      state,
      approvals: { repositoryUrls: ["https://plugins.example/index.json", "https://community.example/plugins.min.json"], plugins: { "example-source": "https://plugins.example/index.json", "shared-source": "https://community.example/plugins.min.json" } },
      scopeInput: { profileId: "test" },
      operations: {
        addRepository: (current) => current,
        trustRepository: (current) => current,
        refreshRepository: async (current, repositoryId) => ({
          state: current,
          status: "not-modified",
          repository: current.repositories.find((entry) => entry.id === repositoryId)!,
          httpStatus: 304,
          catalogCount: current.catalogEntries.length,
          fetchedAtMs: 1,
        }),
        installPlugin: async ({ state: current, entry }) => ({
          ...current,
          installedPlugins: [{
            profileId: "test",
            repositoryId: entry.repositoryId,
            pluginId: entry.pluginId,
            version: entry.version,
            enabled: true,
            disabledReason: null,
            artifactPath: entry.artifactUrl,
            customJsPath: null,
            customCssPath: null,
            hasSettings: false,
            installedAtMs: 1,
            updatedAtMs: 1,
          }],
        }),
        saveState: async (current) => current,
      },
    });

    expect(result.state.installedPlugins[0]?.repositoryId).toBe("repo-official");
  });

  it("does not accept a homonymous plugin when the recorded repository could not be added", async () => {
    const state = emptyState();
    state.installedPlugins = [{
      profileId: "test",
      repositoryId: "repo-other",
      pluginId: "example-source",
      version: "1.0.0",
      enabled: true,
      disabledReason: null,
      artifactPath: "other.js",
      customJsPath: null,
      customCssPath: null,
      hasSettings: false,
      installedAtMs: 1,
      updatedAtMs: 1,
    }];
    const installPlugin = vi.fn(async ({ state: current }) => current);

    const result = await provisionEpigraphNovelDependencies({
      restored,
      state,
      approvals: { repositoryUrls: ["https://plugins.example/index.json", "https://community.example/plugins.min.json"], plugins: { "example-source": "https://plugins.example/index.json", "shared-source": "https://community.example/plugins.min.json" } },
      scopeInput: { profileId: "test" },
      operations: {
        addRepository: (current) => current,
        trustRepository: (current) => current,
        refreshRepository: vi.fn(),
        installPlugin,
        saveState: async (current) => current,
      },
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "plugin-not-found",
      pluginId: "example-source",
    }));
  });
});
