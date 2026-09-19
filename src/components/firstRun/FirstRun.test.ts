import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFirstRunState } from "../../lib/firstRun";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import FirstRun from "./FirstRun.svelte";

vi.mock("../settings/SyncdConnectionPanel.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));
vi.mock("../settings/Settings.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));
vi.mock("../pages/SourcesView.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));
vi.mock("../pages/Search.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));

describe("FirstRun", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
    store.settings = structuredClone(DEFAULT_SETTINGS);
    store.libraryMangaSnapshot = [];
    store.books = [];
    store.searchNovelLibraryEntries = [];
    store.runtimeResolvedLocalProfileId = "main";
  });

  afterEach(() => cleanup());

  it("applies a selected built-in theme and advances with accessible progress", async () => {
    render(FirstRun);

    expect(store.settings.theme).toBe("light");
    await fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(store.settings.theme).toBe("light");
    expect(screen.getByText("Appearance").closest("li")?.getAttribute("aria-current")).toBe("step");

    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "How do you want to begin?" })).toBeTruthy();
  });

  it("keeps an appearance choice when the app closes before Continue", async () => {
    render(FirstRun);
    await fireEvent.click(screen.getByRole("button", { name: "Nocturne" }));
    cleanup();
    render(FirstRun);
    expect(store.settings.theme).toBe("nocturne");
  });

  it("routes each entry choice into the real setup task", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "entry" } } });

    await fireEvent.click(screen.getByRole("button", { name: "Set up from scratch" }));
    expect(screen.getByRole("heading", { name: "Add repositories and extensions" })).toBeTruthy();
  });

  it("resumes the exact persisted task", () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "trackers", path: "backup" } } });

    expect(screen.getByRole("heading", { name: "Connect trackers" })).toBeTruthy();
    expect(screen.getByText("Trackers").closest("li")?.getAttribute("aria-current")).toBe("step");
  });

  it("returns backup users to restore after repository setup", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "sources", path: "backup" } } });

    await fireEvent.click(screen.getByRole("button", { name: "Return to restore" }));
    expect(screen.getByRole("heading", { name: "Restore your backups" })).toBeTruthy();
  });

  it("does not equate visiting repositories with completing a backup restore", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup" } } });

    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton.hasAttribute("disabled")).toBe(true);
    await fireEvent.click(continueButton);
    expect(screen.getByRole("heading", { name: "Restore your backups" })).toBeTruthy();
  });

  it("does not complete without a library title", async () => {
    const onComplete = vi.fn();
    render(FirstRun, { props: { onComplete, initialState: { ...createFirstRunState(), step: "complete", path: "sync" } } });

    const openLibrary = screen.getByRole("button", { name: "Open library" });
    expect(openLibrary.hasAttribute("disabled")).toBe(true);
    await fireEvent.click(openLibrary);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("persists completion after a title exists", async () => {
    const onComplete = vi.fn();
    store.books = [{ id: "book-1" } as (typeof store.books)[number]];
    render(FirstRun, { props: { onComplete, initialState: { ...createFirstRunState(), step: "complete", path: "fresh" } } });

    await fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem("epigraph-first-run") ?? "{}").status).toBe("complete");
    expect(store.navPage).toBe("library");
  });

  it("passes the active profile to sync and waits for the connection callback", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "sync", path: "sync" } } });
    const connect = await screen.findByRole("button", { name: "Connect test device" });
    expect(screen.getByTestId("first-run-surface").getAttribute("data-profile-id")).toBe("main");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(connect);
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps the selected backup while repositories are configured", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup" } } });
    await fireEvent.click(await screen.findByRole("button", { name: "Choose test backup" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open test repositories" }));
    await fireEvent.click(screen.getByRole("button", { name: "Return to restore" }));
    expect(screen.getByText("Test backup selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Complete test restore" }));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Add repositories and extensions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    await fireEvent.click(await screen.findByRole("button", { name: "Install test extension" }));
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
  });

  it("does not require extensions after restoring only local books", async () => {
    localStorage.setItem("epigraph-first-run", JSON.stringify({
      ...createFirstRunState(), step: "backup", path: "backup",
      backupRestored: true, backupNeedsSources: false,
    }));
    render(FirstRun);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Connect trackers" })).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Restore your backups" })).toBeTruthy();
  });
});
