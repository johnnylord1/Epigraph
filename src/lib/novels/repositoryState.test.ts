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

import {
  addNovelRepositoryToState,
  createEmptyNovelRepositoryState,
  deriveNovelRepositoryUiState,
  loadNovelRepositoryState,
  refreshNovelRepositoryCatalog,
  saveNovelRepositoryState,
  setNovelRepositoryLanguageFilter,
} from "./repositoryState";

describe("novel repository state", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    tauriFetchMock.mockReset();
  });

  it("loads an empty profile-scoped state when no persisted file exists", async () => {
    invokeMock.mockResolvedValueOnce(null);

    const state = await loadNovelRepositoryState({ profileId: "test" });

    expect(invokeMock).toHaveBeenCalledWith("read_novel_repository_state", {
      profileId: "test",
      serverUrl: null,
    });
    expect(state.scopeKey).toBe("profile:test");
    expect(state.repositories).toHaveLength(0);
  });

  it("persists repositories and language filters through the Tauri state file", async () => {
    invokeMock.mockResolvedValueOnce("C:/profiles/test/novels/repositories-state.json");

    let state = createEmptyNovelRepositoryState({ profileId: "test" });
    state = addNovelRepositoryToState(state, {
      profileId: "test",
      url: "https://example.com/plugins.min.json",
      recommendedSeed: true,
    });
    state = setNovelRepositoryLanguageFilter(state, ["en", "pt-br"]);

    const saved = await saveNovelRepositoryState(state, { profileId: "test" });

    expect(saved.repositories).toHaveLength(1);
    expect(saved.languageFilter).toEqual(["en", "pt-br"]);
    expect(invokeMock).toHaveBeenCalledWith(
      "write_novel_repository_state",
      expect.objectContaining({
        profileId: "test",
        serverUrl: null,
      }),
    );
  });

  it("refreshes a repository catalog and keeps refresh metadata profile-scoped", async () => {
    let state = createEmptyNovelRepositoryState({ profileId: "main" });
    state = addNovelRepositoryToState(state, {
      profileId: "main",
      url: "https://plugins.example.com/plugins.min.json",
    });

    tauriFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        ETag: "\"catalog-v1\"",
        "Last-Modified": "Wed, 08 Apr 2026 12:00:00 GMT",
      },
      json: async () => [{
        id: "plugin.alpha",
        name: "Plugin Alpha",
        site: "Example Alpha",
        lang: "en",
        version: "1.2.3",
        url: "https://plugins.example.com/plugin.alpha.js",
      }],
    });

    const result = await refreshNovelRepositoryCatalog(state, state.repositories[0].id);

    expect(result.status).toBe("updated");
    expect(result.catalogCount).toBe(1);
    expect(result.state.catalogEntries[0]).toMatchObject({
      pluginId: "plugin.alpha",
      repositoryId: state.repositories[0].id,
    });
    expect(result.repository.etag).toBe("\"catalog-v1\"");
    expect(result.repository.lastModified).toBe("Wed, 08 Apr 2026 12:00:00 GMT");
  });

  it("keeps cached state and marks the repository error when refresh fails", async () => {
    let state = createEmptyNovelRepositoryState({ profileId: "test" });
    state = addNovelRepositoryToState(state, {
      profileId: "test",
      url: "https://plugins.example.com/plugins.min.json",
    });

    tauriFetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await refreshNovelRepositoryCatalog(state, state.repositories[0].id);

    expect(result.status).toBe("error");
    expect(result.repository.lastError).toContain("network down");
    expect(deriveNovelRepositoryUiState(result.repository)).toBe("error");
  });
});
