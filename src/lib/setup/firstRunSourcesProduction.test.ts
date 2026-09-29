import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyNovelRepositoryState, addNovelRepositoryToState, setNovelRepositoryTrustState, withBuiltinNovelRepository } from "../novels/repositoryState";

const adapters = vi.hoisted(() => ({
  runtime: vi.fn(), loadNovels: vi.fn(), saveNovels: vi.fn(), refreshNovels: vi.fn(), installNovel: vi.fn(), ready: vi.fn(),
}));
vi.mock("../suwayomiReadiness", () => ({ waitForSuwayomiGraphqlReady: adapters.ready }));
vi.mock("../manga/runtime", () => ({ getManagedSourceRuntime: adapters.runtime, resolveExtensionStoreInputUrl: (url: string) => url }));
vi.mock("../novels/repositoryState", async (importOriginal) => ({
  ...await importOriginal<typeof import("../novels/repositoryState")>(),
  loadNovelRepositoryState: adapters.loadNovels, saveNovelRepositoryState: adapters.saveNovels, refreshNovelRepositoryCatalog: adapters.refreshNovels,
}));
vi.mock("../novels/packages", async (importOriginal) => ({
  ...await importOriginal<typeof import("../novels/packages")>(), installNovelCatalogPlugin: adapters.installNovel,
}));
import { createProductionFirstRunSourcesWorkflow, visibleFirstRunExtensions } from "./firstRunSourcesWorkflow";
import { translate } from "../i18n/runtime";

function novels() {
  let state = addNovelRepositoryToState(createEmptyNovelRepositoryState(), { profileId: "test", url: "https://plugins.test/plugins.min.json" });
  const repository = state.repositories[0];
  state = setNovelRepositoryTrustState(state, repository.id, "trusted");
  state.catalogEntries = [{ repositoryId: repository.id, pluginId: "one", name: "One", site: "https://source.test", lang: "en", version: "1", artifactUrl: "https://plugins.test/one.js", iconUrl: null, customJsUrl: null, customCssUrl: null, manifestHash: null, fetchedAtMs: 1 }];
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  adapters.runtime.mockResolvedValue({ listStores: async () => [], listExtensions: async () => [] });
  adapters.ready.mockResolvedValue(true);
  adapters.loadNovels.mockResolvedValue(novels());
  adapters.saveNovels.mockImplementation(async (state) => state);
});

describe("first-run production source adapters", () => {
  it("waits for the local server before listing manga repositories", async () => {
    let serverReady = false;
    adapters.ready.mockImplementation(async () => { serverReady = true; return true; });
    const listStores = vi.fn(async () => {
      if (!serverReady) throw new Error("Failed to fetch");
      return [{ id: "store", name: "Store", indexUrl: "https://store.test/index.min.json" }];
    });
    adapters.runtime.mockResolvedValue({ listStores, listExtensions: async () => [], refreshExtensions: async () => [] });
    const workflow = createProductionFirstRunSourcesWorkflow();
    await workflow.hydrate();
    expect(adapters.ready).toHaveBeenCalledWith("extensions", expect.objectContaining({ attempts: expect.any(Number) }));
    expect(workflow.repositories.map((repository) => repository.kind)).toEqual(["manga", "novels"]);
    expect(workflow.warnings).toEqual([]);
  });

  it("loads novels even if the manga runtime is unavailable", async () => {
    adapters.runtime.mockRejectedValue(new Error("Offline"));
    const workflow = createProductionFirstRunSourcesWorkflow();
    await workflow.hydrate();
    expect(workflow.repositories.map((repository) => repository.kind)).toEqual(["novels"]);
    expect(workflow.warnings).toHaveLength(1);
    expect(adapters.saveNovels).not.toHaveBeenCalled();
  });

  it("does not save a failed novel catalog refresh as a successful repository addition", async () => {
    adapters.refreshNovels.mockImplementation(async (state, id) => ({ state, status: "error", repository: { ...state.repositories.find((entry: { id: string }) => entry.id === id), lastError: "Repository unavailable" } }));
    const workflow = createProductionFirstRunSourcesWorkflow();
    await expect(workflow.addRepository("novels", "https://other.test/plugins.min.json")).rejects.toThrow("Repository unavailable");
    expect(adapters.saveNovels).not.toHaveBeenCalled();
    expect(workflow.repositories).toHaveLength(0);
  });

  it("re-enables an existing novel plugin without rewriting its files or settings", async () => {
    const state = novels();
    state.installedPlugins = [{ repositoryId: state.repositories[0].id, profileId: "test", pluginId: "one", version: "1", enabled: false, disabledReason: "user-disabled", artifactPath: "existing/index.js", customJsPath: null, customCssPath: null, hasSettings: true, installedAtMs: 1, updatedAtMs: 1 }];
    adapters.loadNovels.mockResolvedValue(state);
    const workflow = createProductionFirstRunSourcesWorkflow();
    await workflow.hydrate();
    expect(workflow.isReady("novels")).toBe(false);
    await workflow.installExtension(state.repositories[0].id, "one");
    expect(adapters.installNovel).not.toHaveBeenCalled();
    expect(adapters.saveNovels.mock.calls[0][0].installedPlugins[0]).toMatchObject({ enabled: true, disabledReason: null, artifactPath: "existing/index.js", hasSettings: true });
    expect(workflow.isReady("novels")).toBe(true);
  });

  it("rejects a manga package whose resolved origin changed after rendering", async () => {
    const extension = { packageName: "one", name: "One", language: "en", versionName: "1", iconUrl: null, storeId: "a", isInstalled: false };
    const installExtension = vi.fn();
    const listExtensions = vi.fn().mockResolvedValueOnce([extension]).mockResolvedValue([{ ...extension, storeId: "b" }]);
    adapters.runtime.mockResolvedValue({ listStores: async () => [{ id: "a", name: "A", indexUrl: "https://a.test" }], listExtensions, installExtension });
    const workflow = createProductionFirstRunSourcesWorkflow();
    await workflow.hydrate();
    await expect(workflow.installExtension("a", "one")).rejects.toThrow("repository");
    expect(installExtension).not.toHaveBeenCalled();
  });

  it("lists manga extensions by name and hides adult-only ones until the user opts in", async () => {
    const make = (packageName: string, name: string, isNsfw: boolean) => ({ packageName, name, language: "all", versionName: "1", iconUrl: null, storeId: "a", isInstalled: false, isNsfw });
    adapters.runtime.mockResolvedValue({
      listStores: async () => [{ id: "a", name: "A", indexUrl: "https://a.test" }],
      listExtensions: async () => [make("all.ahottie", "AHottie", true), make("all.comicfury", "Comic Fury", false), make("all.akuma", "Akuma", true), make("en.batcave", "BatCave", false)],
    });
    const workflow = createProductionFirstRunSourcesWorkflow();
    await workflow.hydrate();
    const manga = workflow.repositories.find((repository) => repository.kind === "manga")!;
    expect(manga.extensions.map((extension) => extension.name)).toEqual(["AHottie", "Akuma", "BatCave", "Comic Fury"]);
    expect(visibleFirstRunExtensions(manga.extensions, false).map((extension) => extension.name)).toEqual(["BatCave", "Comic Fury"]);
    expect(visibleFirstRunExtensions(manga.extensions, true)).toHaveLength(4);
  });

  it("fetches the catalog of a store that has not listed any extension yet", async () => {
    const refreshExtensions = vi.fn().mockResolvedValue([{ packageName: "one", name: "One", language: "en", versionName: "1", iconUrl: null, storeId: "a", isInstalled: false }]);
    adapters.runtime.mockResolvedValue({ listStores: async () => [{ id: "a", name: "A", indexUrl: "https://a.test" }], listExtensions: async () => [], refreshExtensions });
    const workflow = createProductionFirstRunSourcesWorkflow();
    await workflow.hydrate();
    expect(refreshExtensions).toHaveBeenCalledTimes(1);
    expect(workflow.repositories.find((repository) => repository.kind === "manga")!.extensions).toHaveLength(1);
  });

  it("loads the built-in LNReader catalog without asking the user to refresh it", async () => {
    const state = withBuiltinNovelRepository(createEmptyNovelRepositoryState({ profileId: "test" }));
    const builtin = state.repositories[0];
    adapters.loadNovels.mockResolvedValue(state);
    adapters.refreshNovels.mockImplementation(async (current, id) => ({
      status: "updated",
      repository: builtin,
      state: { ...current, catalogEntries: [{ repositoryId: id, pluginId: "royalroad", name: "Royal Road", site: "https://royalroad.test", lang: "en", version: "1", artifactUrl: "https://plugins.test/rr.js", iconUrl: null, customJsUrl: null, customCssUrl: null, manifestHash: null, fetchedAtMs: 1 }] },
    }));
    const workflow = createProductionFirstRunSourcesWorkflow();
    await workflow.hydrate();
    expect(adapters.refreshNovels).toHaveBeenCalledWith(state, builtin.id);
    expect(adapters.saveNovels).toHaveBeenCalledTimes(1);
    const novels = workflow.repositories.find((repository) => repository.kind === "novels")!;
    expect(novels.name).toBe(translate("firstRun.sources.builtinNovelRepository"));
    expect(novels.name).not.toBe("firstRun.sources.builtinNovelRepository");
    expect(novels.extensions.map((extension) => extension.id)).toEqual(["royalroad"]);
  });
});
