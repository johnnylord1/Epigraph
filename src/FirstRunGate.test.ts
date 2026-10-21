import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Layout from "./components/layout/Layout.svelte";
import { createFirstRunState, FIRST_RUN_REOPENED_EVENT, FIRST_RUN_STORAGE_KEY } from "./lib/firstRun";
import { FIRST_RUN_CONTENT_PROFILES_KEY, reopenFirstRun } from "./lib/firstRunCleanInstall";
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

const cleanInstall = vi.hoisted(() => ({ counts: [0, 0, 0, 0], fail: false }));
vi.mock("./lib/firstRunCleanInstall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/firstRunCleanInstall")>();
  return {
    ...actual,
    createProductionCleanInstallProbe: () => ({
      countComics: async () => {
        if (cleanInstall.fail) throw new Error("server not answering");
        return cleanInstall.counts[0];
      },
      countBooks: async () => cleanInstall.counts[1],
      countNovels: async () => cleanInstall.counts[2],
      countSourceSetup: async () => cleanInstall.counts[3],
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
    store.runtimeResolvedLocalProfileId = null;
    store.runtimeServerUrl = null;
    cleanInstall.counts = [0, 0, 0, 0];
    cleanInstall.fail = false;
  });
  afterEach(() => cleanup());

  function resolveRuntime() {
    store.runtimeResolvedLocalProfileId = "default" as NonNullable<typeof store.runtimeResolvedLocalProfileId>;
    store.runtimeServerUrl = "http://127.0.0.1:4567";
  }

  it("opens the normal shell after completing setup and keeps it on the next mount", async () => {
    resolveRuntime();
    render(Layout);
    await fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
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
    await fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    await waitFor(() => expect(document.querySelector(".epigraph-app-shell")).not.toBeNull());

    cleanup();
    render(Layout);
    expect(document.querySelector(".first-run-shell")).toBeNull();
    expect(document.querySelector(".epigraph-app-shell")).not.toBeNull();
  });

  it("keeps the existing manga detail reachable during first-run discovery", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), step: "discover", path: "fresh" }));
    store.navPage = "search";
    resolveRuntime();
    render(Layout);
    await waitFor(() => expect(document.querySelector(".first-run-shell")).not.toBeNull());
    store.activeManga = { id: 1, title: "Test manga" } as NonNullable<typeof store.activeManga>;
    expect(await screen.findByRole("heading", { name: "Test series detail" })).toBeTruthy();
  });

  it("opens setup again when the app was emptied after holding something since setup", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), status: "complete", step: "complete" }));
    localStorage.setItem(FIRST_RUN_CONTENT_PROFILES_KEY, JSON.stringify(["default"]));
    render(Layout);
    expect(document.querySelector(".epigraph-app-shell")).not.toBeNull();
    store.runtimeResolvedLocalProfileId = "default" as NonNullable<typeof store.runtimeResolvedLocalProfileId>;
    store.runtimeServerUrl = "http://127.0.0.1:4567";
    await waitFor(() => expect(document.querySelector(".first-run-shell")).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")?.status).toBe("pending");
    expect(localStorage.getItem(FIRST_RUN_CONTENT_PROFILES_KEY)).toBeNull();
  });

  it("keeps the app open when setup was completed on an app that never held anything", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), status: "complete", step: "complete" }));
    render(Layout);
    store.runtimeResolvedLocalProfileId = "default" as NonNullable<typeof store.runtimeResolvedLocalProfileId>;
    store.runtimeServerUrl = "http://127.0.0.1:4567";
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".first-run-shell")).toBeNull();
    expect(document.querySelector(".epigraph-app-shell")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")?.status).toBe("complete");
  });

  it("opens setup at once when it is started over from inside the app", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), status: "complete", step: "complete" }));
    cleanInstall.counts = [3, 0, 0, 1];
    render(Layout);
    expect(document.querySelector(".first-run-shell")).toBeNull();
    reopenFirstRun(localStorage);
    window.dispatchEvent(new Event(FIRST_RUN_REOPENED_EVENT));
    await waitFor(() => expect(document.querySelector(".first-run-shell")).not.toBeNull());
    expect(document.querySelector<HTMLElement>(".first-run-page")?.dataset.page).toBe("theme");
  });

  it("never shows setup at launch when the app already holds a work or a source", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
    cleanInstall.counts = [0, 0, 0, 2];
    render(Layout);
    expect(document.querySelector(".first-run-shell")).toBeNull();
    resolveRuntime();
    await waitFor(() => expect(document.querySelector(".epigraph-app-shell")).not.toBeNull());
    expect(document.querySelector(".first-run-shell")).toBeNull();
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")?.status).toBe("complete");
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_CONTENT_PROFILES_KEY) ?? "null")).toEqual(["default"]);
  });

  it("shows setup at launch once the app is known to be empty", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
    render(Layout);
    expect(document.querySelector(".first-run-shell")).toBeNull();
    resolveRuntime();
    await waitFor(() => expect(document.querySelector(".first-run-shell")).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")?.status).toBe("pending");
  });

  it("offers to skip setup when the server does not answer at launch", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
    cleanInstall.fail = true;
    resolveRuntime();
    render(Layout);
    await waitFor(() => expect(document.querySelector(".first-run-shell")).not.toBeNull());
    expect(document.querySelector(".first-run-notice")?.textContent).toContain("Server not responding");
    await fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    await waitFor(() => expect(document.querySelector(".epigraph-app-shell")).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")?.status).toBe("complete");
  });

  it("keeps checking while the server does not answer and leaves setup once it answers with data", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
    cleanInstall.fail = true;
    resolveRuntime();
    render(Layout);
    await waitFor(() => expect(document.querySelector(".first-run-notice")).not.toBeNull());
    cleanInstall.fail = false;
    cleanInstall.counts = [2, 0, 0, 0];
    await waitFor(() => expect(document.querySelector(".epigraph-app-shell")).not.toBeNull(), { timeout: 8000 });
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")?.status).toBe("complete");
  }, 12000);

  it("drops the notice once the server answers with an empty app", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
    cleanInstall.fail = true;
    resolveRuntime();
    render(Layout);
    await waitFor(() => expect(document.querySelector(".first-run-notice")).not.toBeNull());
    cleanInstall.fail = false;
    await waitFor(() => expect(document.querySelector(".first-run-notice")).toBeNull(), { timeout: 8000 });
    expect(screen.queryByRole("button", { name: "Skip setup" })).toBeNull();
    expect(document.querySelector(".first-run-shell")).not.toBeNull();
  }, 12000);

  it("keeps a setup path in progress when the server answers later with data, but lets it be skipped", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), step: "sources", path: "fresh" }));
    cleanInstall.fail = true;
    resolveRuntime();
    render(Layout);
    await waitFor(() => expect(document.querySelector(".first-run-notice")).not.toBeNull());
    cleanInstall.fail = false;
    cleanInstall.counts = [0, 0, 0, 3];
    await waitFor(() => expect(document.querySelector(".first-run-notice")).toBeNull(), { timeout: 8000 });
    expect(document.querySelector(".first-run-shell")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Skip setup" })).toBeTruthy();
  }, 12000);

  it("shows no skip action when the server answers with an empty app", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(createFirstRunState()));
    resolveRuntime();
    render(Layout);
    await waitFor(() => expect(document.querySelector(".first-run-shell")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Skip setup" })).toBeNull();
    expect(document.querySelector(".first-run-notice")).toBeNull();
  });

  it("keeps setup the user started over from Settings, even on an app with data", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), cancellable: true }));
    cleanInstall.counts = [3, 0, 0, 1];
    resolveRuntime();
    render(Layout);
    expect(document.querySelector(".first-run-shell")).not.toBeNull();
  });

  it("keeps the app open when it still holds a work or a source", async () => {
    localStorage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify({ ...createFirstRunState(), status: "complete", step: "complete" }));
    cleanInstall.counts = [0, 0, 0, 1];
    render(Layout);
    store.runtimeResolvedLocalProfileId = "default" as NonNullable<typeof store.runtimeResolvedLocalProfileId>;
    store.runtimeServerUrl = "http://127.0.0.1:4567";
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".first-run-shell")).toBeNull();
    expect(document.querySelector(".epigraph-app-shell")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_CONTENT_PROFILES_KEY) ?? "null")).toEqual(["default"]);
  });
});
