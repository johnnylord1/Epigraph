import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFirstRunState } from "../../lib/firstRun";
import { DEFAULT_SETTINGS, store } from "../../store/state.svelte";
import FirstRun from "./FirstRun.svelte";

describe("FirstRun", () => {
  beforeEach(() => {
    store.settings = structuredClone(DEFAULT_SETTINGS);
  });

  afterEach(() => cleanup());

  it("applies a selected built-in theme and advances with accessible progress", async () => {
    render(FirstRun);

    await fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(store.settings.theme).toBe("light");
    expect(screen.getByText("Appearance").closest("li")?.getAttribute("aria-current")).toBe("step");

    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "How do you want to begin?" })).toBeTruthy();
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

  it("requires repository setup before continuing a backup restore", async () => {
    render(FirstRun, { props: { initialState: { ...createFirstRunState(), step: "backup", path: "backup" } } });

    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Add repositories and extensions" })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Return to restore" }));
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Connect trackers" })).toBeTruthy();
  });

  it("marks completion before opening the library", async () => {
    const onComplete = vi.fn();
    render(FirstRun, { props: { onComplete, initialState: { ...createFirstRunState(), step: "complete", path: "sync" } } });

    await fireEvent.click(screen.getByRole("button", { name: "Open library" }));
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
