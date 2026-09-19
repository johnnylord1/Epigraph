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
    await fireEvent.click(await screen.findByRole("button", { name: "Install test extension" }));
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
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
