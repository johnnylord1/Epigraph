import { describe, expect, it, vi } from "vitest";
import type { RestoredEpigraphNovelsSnapshot } from "./novelsBackup";
import {
  provisionEpigraphNovelDependencies,
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
      scopeInput: { profileId: "test" },
      operations,
    });

    expect(result.state.repositories).toHaveLength(1);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "repository-refresh-failed",
      message: "Catalog is temporarily offline",
    }));
  });

  it("switches an installed plugin to the repository recorded for that plugin", async () => {
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

    expect(result.state.installedPlugins[0]?.repositoryId).toBe("repo-community");
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
