import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gql } from "../client";
import { searchSourceManga } from "../manga/runtime";
import { GET_SOURCES, UPDATE_MANGA } from "../queries";
import { readInstalledNovelDetails } from "../novels/sources";
import { loadNovelLibraryState, resetNovelLibraryStateCacheForTests } from "../novels/libraryState";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import { createProductionFirstRunDiscoveryWorkflow } from "./firstRunDiscoveryWorkflow";

vi.mock("../client", async (importOriginal) => ({ ...await importOriginal<typeof import("../client")>(), gql: vi.fn() }));
vi.mock("../manga/runtime", () => ({ searchSourceManga: vi.fn() }));
vi.mock("../novels/sources", () => ({
  loadTrustedInstalledNovelSources: async () => [{ pluginId: "novel", name: "Novel source", lang: "en" }],
  browseInstalledNovelSource: async () => [{ sourceId: "novel", path: "/story", title: "Story", coverUrl: null }],
  searchInstalledNovelSource: async () => [],
  readInstalledNovelDetails: vi.fn(),
  acquireInstalledNovelSourcesRuntime: () => async () => {},
}));

const source = (id: string, isNsfw = false) => ({ id, name: id, displayName: id, lang: "en", isNsfw, iconUrl: "" });
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  resetNovelLibraryStateCacheForTests();
  store.settings = structuredClone(DEFAULT_SETTINGS);
  store.settings.showNsfw = false;
  store.settings.nsfwBlockedSourceIds = ["blocked"];
  store.runtimeResolvedLocalProfileId = "discovery-a";
  store.runtimeServerUrl = "http://127.0.0.1:34567";
  store.libraryMangaSnapshot = [];
  store.searchNovelLibraryEntries = [];
  vi.mocked(gql).mockImplementation(async (query) => {
    if (query === GET_SOURCES) return { sources: { nodes: [source("safe"), source("adult", true), source("blocked")] } };
    if (query === UPDATE_MANGA) return { updateManga: { manga: { id: 7, inLibrary: true } } };
    throw new Error("Unexpected query");
  });
  vi.mocked(searchSourceManga).mockImplementation(async (input) => ({ fetchSourceManga: { hasNextPage: false, mangas: [{ id: 7, title: input.source, thumbnailUrl: "/api/v1/manga/7/thumbnail", inLibrary: false }] } }));
});

it("respects the existing blocked/adult-source visibility policy", async () => {
  const workflow = createProductionFirstRunDiscoveryWorkflow();
  await workflow.loadPopular();
  expect(workflow.items.map((item) => item.title)).toEqual(["safe", "Story"]);
  expect(vi.mocked(searchSourceManga).mock.calls.map(([input]) => input.source)).toEqual(["safe"]);
});

it("publishes confirmed manga membership to the shared Library snapshot", async () => {
  const workflow = createProductionFirstRunDiscoveryWorkflow();
  await workflow.loadPopular();
  await workflow.addToLibrary(workflow.items.find((item) => item.title === "safe")!.id);
  expect(store.libraryMangaSnapshot).toEqual([expect.objectContaining({ id: 7, title: "safe", inLibrary: true, thumbnailUrl: "/api/v1/manga/7/thumbnail" })]);
});

it("does not insert a novel into a new profile when the runtime changes during details", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(readInstalledNovelDetails).mockImplementation(async () => {
    await pending;
    return { id: "novel:novel:story", sourceId: "novel", title: "Story", path: "/story", coverUrl: null, author: null, description: null, status: null, tags: [], chapterCount: 0, chapters: [], source: { sourceId: "novel", pluginId: "novel", repositoryUrl: null } };
  });
  const workflow = createProductionFirstRunDiscoveryWorkflow();
  await workflow.loadPopular();
  const add = workflow.addToLibrary(workflow.items.find((item) => item.kind === "novel")!.id);
  await vi.waitFor(() => expect(readInstalledNovelDetails).toHaveBeenCalledOnce());
  store.runtimeResolvedLocalProfileId = "discovery-b";
  release();
  await expect(add).rejects.toThrow();
  expect((await loadNovelLibraryState({ profileId: "discovery-b", serverUrl: store.runtimeServerUrl })).entries).toEqual([]);
  expect(store.searchNovelLibraryEntries).toEqual([]);
});

it("does not publish a manga acknowledgement into a different profile", async () => {
  vi.mocked(gql).mockImplementation(async (query) => {
    if (query === GET_SOURCES) return { sources: { nodes: [source("safe")] } };
    if (query === UPDATE_MANGA) {
      store.runtimeResolvedLocalProfileId = "discovery-b";
      return { updateManga: { manga: { id: 7, inLibrary: true } } };
    }
    throw new Error("Unexpected query");
  });
  const workflow = createProductionFirstRunDiscoveryWorkflow();
  await workflow.loadPopular();
  await expect(workflow.addToLibrary(workflow.items[0].id)).rejects.toThrow();
  expect(store.libraryMangaSnapshot).toEqual([]);
});
