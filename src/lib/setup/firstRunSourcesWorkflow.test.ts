import { describe, expect, it, vi } from "vitest";
import { buildFirstRunNovelRepositories, createFirstRunSourcesWorkflow, type FirstRunRepository } from "./firstRunSourcesWorkflow";
import { createEmptyNovelRepositoryState } from "../novels/repositoryState";

describe("first-run sources workflow", () => {
  it("writes only after explicit submission and rejects duplicates", async () => {
    const add = vi.fn(async (kind: "manga" | "novels", url: string) => ({
      id: "repo-1", kind, url, name: "Repository", extensions: [],
    }));
    const workflow = createFirstRunSourcesWorkflow({ addRepository: add, installExtension: vi.fn() });

    expect(add).not.toHaveBeenCalled();
    await workflow.addRepository("manga", "https://example.test/index.min.json");
    await expect(workflow.addRepository("manga", "https://example.test/index.min.json/")).rejects.toThrow("already added");
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("installs one or all extensions and reports readiness", async () => {
    const install = vi.fn(async () => undefined);
    const workflow = createFirstRunSourcesWorkflow({
      addRepository: vi.fn(async (): Promise<FirstRunRepository> => ({
        id: "repo-1", kind: "manga", url: "https://repo", name: "Repo",
        extensions: [
          { id: "one", name: "One", lang: "en", version: "1", iconUrl: null, installed: false, status: "idle" },
          { id: "two", name: "Two", lang: "pt-BR", version: "1", iconUrl: null, installed: false, status: "idle" },
        ],
      })),
      installExtension: install,
    });
    const repo = await workflow.addRepository("manga", "https://repo");
    expect(workflow.isReady()).toBe(false);
    await workflow.installExtension(repo.id, "one");
    expect(workflow.isReady()).toBe(true);
    await workflow.installAll(repo.id);
    expect(install).toHaveBeenCalledTimes(2);
    expect(workflow.repositories[0].extensions.every((entry) => entry.installed)).toBe(true);
  });

  it("rehydrates existing repositories after an interrupted setup without writing again", async () => {
    const add = vi.fn();
    const workflow = createFirstRunSourcesWorkflow({
      addRepository: add,
      installExtension: vi.fn(),
      loadRepositories: vi.fn(async (): Promise<FirstRunRepository[]> => [{
        id: "persisted-repository",
        kind: "novels",
        url: "https://plugins.example.test/plugins.min.json",
        name: "Persisted novels",
        extensions: [{
          id: "persisted-plugin", name: "Persisted plugin", lang: "en", version: "2.0", iconUrl: null,
          installed: true, status: "installed",
        }],
      }]),
    });

    await workflow.hydrate();

    expect(workflow.repositories).toHaveLength(1);
    expect(workflow.isReady("novels")).toBe(true);
    await expect(workflow.addRepository("novels", "https://plugins.example.test/plugins.min.json/")).rejects.toThrow("already added");
    expect(add).not.toHaveBeenCalled();
  });

  it("publishes installation progress before completion and keeps the failure retryable", async () => {
    let rejectInstall!: (cause: Error) => void;
    const install = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rejectInstall = reject; })).mockResolvedValue(undefined);
    const workflow = createFirstRunSourcesWorkflow({
      addRepository: async (): Promise<FirstRunRepository> => ({ id: "repo", kind: "manga", name: "Repo", url: "https://repo.test", extensions: [
        { id: "extension", name: "Extension", lang: "en", version: "1", iconUrl: null, installed: false, status: "idle" },
      ] }),
      installExtension: install,
    });
    await workflow.addRepository("manga", "https://repo.test");
    const observed: string[] = [];
    const unsubscribe = workflow.subscribe(() => observed.push(workflow.repositories[0].extensions[0].status));
    const pending = workflow.installExtension("repo", "extension");
    expect(observed).toContain("installing");
    rejectInstall(new Error("Connection lost"));
    await expect(pending).rejects.toThrow("Connection lost");
    expect(workflow.isReady()).toBe(false);
    await workflow.installExtension("repo", "extension");
    expect(observed).toContain("error");
    expect(observed.at(-1)).toBe("installed");
    unsubscribe();
  });

  it("does not mistake a same-name novel plugin from another repository for an installed dependency", () => {
    const state = createEmptyNovelRepositoryState();
    state.repositories = [{ id: "repo-a", normalizedUrl: "https://a.test", enabled: true, trustState: "trusted" } as any];
    state.catalogEntries = [{ repositoryId: "repo-a", pluginId: "same-name", name: "Novel source", lang: "en", version: "1", iconUrl: null } as any];
    state.installedPlugins = [{ repositoryId: "repo-b", pluginId: "same-name", enabled: true } as any];
    expect(buildFirstRunNovelRepositories(state)[0].extensions[0].installed).toBe(false);
    state.installedPlugins[0].repositoryId = "repo-a";
    expect(buildFirstRunNovelRepositories(state)[0].extensions[0].installed).toBe(true);
    state.repositories[0].enabled = false;
    expect(buildFirstRunNovelRepositories(state)[0].extensions[0].installed).toBe(false);
  });

  it("keeps independent source catalogs usable and exposes partial loading errors", async () => {
    const workflow = createFirstRunSourcesWorkflow({
      addRepository: vi.fn(), installExtension: vi.fn(),
      loadRepositories: async () => ({ repositories: [{
        id: "novels", kind: "novels" as const, name: "Novels", url: "https://novels.test", extensions: [
          { id: "one", name: "One", lang: "en", version: "1", iconUrl: null, installed: true, status: "installed" as const },
        ],
      }], warnings: ["Comics repositories could not be loaded."] }),
    });
    await workflow.hydrate();
    expect(workflow.isReady("novels")).toBe(true);
    expect(workflow.isReady("manga")).toBe(false);
    expect(workflow.warnings).toEqual(["Comics repositories could not be loaded."]);
  });

  it("does not overwrite a submitted repository with an earlier hydration snapshot", async () => {
    let finishLoad!: (value: FirstRunRepository[]) => void;
    const addRepository = vi.fn(async (): Promise<FirstRunRepository> => ({ id: "added", kind: "manga", name: "Added", url: "https://repo.test", extensions: [] }));
    const workflow = createFirstRunSourcesWorkflow({
      addRepository, installExtension: vi.fn(),
      loadRepositories: () => new Promise((resolve) => { finishLoad = resolve; }),
    });
    const hydration = workflow.hydrate();
    const addition = workflow.addRepository("manga", "https://repo.test");
    expect(addRepository).not.toHaveBeenCalled();
    finishLoad([]);
    await Promise.all([hydration, addition]);
    expect(workflow.repositories.map((repository) => repository.id)).toEqual(["added"]);
  });
});
