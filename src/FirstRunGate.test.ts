import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "./components/layout/Layout.svelte";
import { createFirstRunState, FIRST_RUN_STORAGE_KEY } from "./lib/firstRun";
import { DEFAULT_SETTINGS, store } from "./store/state.svelte";

vi.mock("./components/layout/Sidebar.svelte", () => import("./test/fixtures/FirstRunSurface.svelte"));
vi.mock("./components/pages/Home.svelte", () => import("./test/fixtures/FirstRunSurface.svelte"));
vi.mock("./components/pages/Library.svelte", () => import("./test/fixtures/FirstRunSurface.svelte"));
vi.mock("./components/pages/Search.svelte", () => import("./test/fixtures/FirstRunSurface.svelte"));
vi.mock("./components/pages/Downloads.svelte", () => import("./test/fixtures/FirstRunSurface.svelte"));
vi.mock("./components/pages/SourcesView.svelte", () => import("./test/fixtures/FirstRunSurface.svelte"));
vi.mock("./components/settings/Settings.svelte", () => import("./test/fixtures/FirstRunSurface.svelte"));
vi.mock("./components/pages/SeriesDetail.svelte", () => import("./test/fixtures/FirstRunDetail.svelte"));
vi.mock("./lib/setup/firstRunSourcesWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/setup/firstRunSourcesWorkflow")>();
  return {
    ...actual,
    createProductionFirstRunSourcesWorkflow: () => actual.createFirstRunSourcesWorkflow({
      loadRepositories: async () => [{
        id: "test-repo", kind: "manga", url: "https://extensions.test/index.min.json", name: "Test repository",
        extensions: [{ id: "test-extension", name: "Test extension", lang: "en", version: "1", iconUrl: null, installed: false, status: "idle" }],
      }],
      addRepository: vi.fn(),
      installExtension: vi.fn().mockResolvedValue(undefined),
    }),
  };
});
vi.mock("./lib/tracking/firstRunTrackerWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/tracking/firstRunTrackerWorkflow")>();
  return {
    ...actual,
    createProductionFirstRunTrackerWorkflow: () => actual.createFirstRunTrackerWorkflow({
      loadTrackers: async () => [],
      loadHardcover: () => ({ connected: false, username: null }),
      loginOAuth: vi.fn(), loginCredentials: vi.fn(), logoutTracker: vi.fn(),
      connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
    }),
  };
});
vi.mock("./lib/setup/firstRunDiscoveryWorkflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/setup/firstRunDiscoveryWorkflow")>();
  return {
    ...actual,
    createProductionFirstRunDiscoveryWorkflow: () => actual.createFirstRunDiscoveryWorkflow({
      loadMangaSources: async () => [], loadNovelSources: async () => [],
      findManga: async () => [], findNovels: async () => [],
      addManga: vi.fn(), addNovel: vi.fn(),
    }),
  };
});

describe("first-run startup gate", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    store.settings = structuredClone(DEFAULT_SETTINGS);
    store.navPage = "home";
    store.activeManga = null;
    store.activeBookId = null;
    store.libraryMangaSnapshot = [];
    store.books = [];
    store.searchNovelLibraryEntries = [];
  });
  afterEach(() => cleanup());

  it("opens the normal shell after completing setup and keeps it on the next mount", async () => {
    render(Layout);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await fireEvent.click(screen.getByRole("button", { name: "Set up from scratch" }));
    const install = await screen.findByRole("button", { name: "Install Test extension" });
    await waitFor(() => expect(install.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(install);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const skipTrackers = await screen.findByRole("button", { name: "Continue without a tracker" });
    await waitFor(() => expect(skipTrackers.hasAttribute("disabled")).toBe(false));
    await fireEvent.click(skipTrackers);
    store.books = [{ id: "book-1" } as (typeof store.books)[number]];
    await waitFor(() => expect(screen.getByRole("button", { name: "Finish setup" }).hasAttribute("disabled")).toBe(false));
    await fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    await waitFor(() => expect(document.querySelector(".epigraph-app-shell")).not.toBeNull());

    cleanup();
    render(Layout);
    expect(document.querySelector(".first-run-shell")).toBeNull();
    expect(document.querySelector(".epigraph-app-shell")).not.toBeNull();
  });

  it("keeps the existing manga detail reachable during first-run discovery", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), step: "discover", path: "fresh" }));
    store.navPage = "search";
    render(Layout);
    store.activeManga = { id: 1, title: "Test manga" } as NonNullable<typeof store.activeManga>;
    expect(await screen.findByRole("heading", { name: "Test series detail" })).toBeTruthy();
  });
});
