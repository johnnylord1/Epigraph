import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, tauriFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  tauriFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

import { createEmptyNovelRepositoryState } from "./repositoryState";
import { addNovelRepositoryToState } from "./repositoryState";
import {
  getInstalledNovelSources,
  getNovelCatalogEntryInstallState,
  installNovelCatalogPlugin,
  removeInstalledNovelPlugin,
  setInstalledNovelPluginEnabled,
} from "./packages";

describe("novel plugin packages", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    tauriFetchMock.mockReset();
  });

  it("installs a trusted plugin artifact into profile-scoped storage and records it in state", async () => {
    let state = createEmptyNovelRepositoryState({ profileId: "test" });
    state = addNovelRepositoryToState(state, {
      profileId: "test",
      url: "https://plugins.example.com/plugins.min.json",
    });
    state = {
      ...state,
      repositories: state.repositories.map((repository) => ({
        ...repository,
        trustState: "trusted",
      })),
    };

    invokeMock
      .mockResolvedValueOnce("C:\\Profiles\\test\\novels")
      .mockResolvedValue("ok");
    tauriFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("plugin-bytes").buffer,
    });

    const entry = {
      repositoryId: state.repositories[0].id,
      pluginId: "plugin.alpha",
      name: "Plugin Alpha",
      site: "Example",
      lang: "en",
      version: "1.2.3",
      artifactUrl: "https://plugins.example.com/plugin.alpha.js",
      iconUrl: "https://plugins.example.com/plugin.alpha.png",
      customJsUrl: "https://plugins.example.com/plugin.alpha.custom.js",
      customCssUrl: "https://plugins.example.com/plugin.alpha.css",
      manifestHash: null,
      fetchedAtMs: 1,
    } as const;

    const nextState = await installNovelCatalogPlugin({
      state,
      entry,
      scopeInput: { profileId: "test" },
    });

    expect(nextState.installedPlugins).toHaveLength(1);
    expect(nextState.installedPlugins[0]).toMatchObject({
      pluginId: "plugin.alpha",
      version: "1.2.3",
      enabled: true,
      hasSettings: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("resolve_novel_storage_root", {
      profileId: "test",
      serverUrl: null,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "write_file_base64",
      expect.objectContaining({
        path: expect.stringContaining("plugin.alpha\\1.2.3\\index.js"),
      }),
    );
    expect(getInstalledNovelSources(nextState)).toEqual(["plugin.alpha"]);
    expect(getNovelCatalogEntryInstallState(nextState, entry).status).toBe("installed");
    await expect(installNovelCatalogPlugin({ state: nextState, entry, scopeInput: { profileId: "test" } }))
      .resolves.toMatchObject({ installedPlugins: [expect.objectContaining({ repositoryId: entry.repositoryId, pluginId: entry.pluginId })] });
  });

  it.each([true, false])("preserves a plugin from another repository even when enabled=%s", async (enabled) => {
    let state = addNovelRepositoryToState(createEmptyNovelRepositoryState({ profileId: "test" }), {
      profileId: "test", url: "https://plugins.example.com/plugins.min.json",
    });
    state.repositories[0].trustState = "trusted";
    const entry = { repositoryId: state.repositories[0].id, pluginId: "plugin.alpha", name: "Alpha", site: "Example",
      lang: "en", version: "2", artifactUrl: "https://plugins.example.com/alpha.js", iconUrl: null,
      customJsUrl: null, customCssUrl: null, manifestHash: null, fetchedAtMs: 1 };
    state.installedPlugins = [{ profileId: "test", repositoryId: "other-repository", pluginId: entry.pluginId,
      version: "1", enabled, disabledReason: enabled ? null : "user-disabled", artifactPath: "existing.js",
      customJsPath: null, customCssPath: null, hasSettings: true, installedAtMs: 1, updatedAtMs: 1 }];
    const before = structuredClone(state);
    invokeMock.mockResolvedValue("C:\\Profiles\\test\\novels");
    tauriFetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
    await expect(installNovelCatalogPlugin({ state, entry, scopeInput: { profileId: "test" } })).rejects.toThrow(/another repository/i);
    expect(tauriFetchMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it("refuses to install plugins from untrusted repositories", async () => {
    let state = createEmptyNovelRepositoryState({ profileId: "test" });
    state = addNovelRepositoryToState(state, {
      profileId: "test",
      url: "https://plugins.example.com/plugins.min.json",
    });

    await expect(installNovelCatalogPlugin({
      state,
      entry: {
        repositoryId: state.repositories[0].id,
        pluginId: "plugin.alpha",
        name: "Plugin Alpha",
        site: "Example",
        lang: "en",
        version: "1.2.3",
        artifactUrl: "https://plugins.example.com/plugin.alpha.js",
        iconUrl: null,
        customJsUrl: null,
        customCssUrl: null,
        manifestHash: null,
        fetchedAtMs: 1,
      },
      scopeInput: { profileId: "test" },
    })).rejects.toThrow(/trusted repositories/i);
  });

  it("can disable and remove installed plugins without touching repository semantics", async () => {
    const state = {
      ...createEmptyNovelRepositoryState({ profileId: "test" }),
      installedPlugins: [{
        profileId: "test",
        repositoryId: "repo-1",
        pluginId: "plugin.alpha",
        version: "1.2.3",
        enabled: true,
        disabledReason: null,
        artifactPath: "C:\\Profiles\\test\\novels\\plugins\\plugin.alpha\\1.2.3\\index.js",
        customJsPath: null,
        customCssPath: null,
        hasSettings: true,
        installedAtMs: 1,
        updatedAtMs: 1,
      }],
    };

    const disabled = setInstalledNovelPluginEnabled(state, "plugin.alpha", false);
    expect(disabled.installedPlugins[0]).toMatchObject({
      enabled: false,
      disabledReason: "user-disabled",
    });

    invokeMock.mockResolvedValueOnce(null);
    const removed = await removeInstalledNovelPlugin(disabled, "plugin.alpha", { profileId: "test" });
    expect(removed.installedPlugins).toHaveLength(0);
    expect(invokeMock).toHaveBeenCalledWith("remove_novel_plugin_installation", {
      pluginId: "plugin.alpha",
      profileId: "test",
      serverUrl: null,
    });
  });
});
