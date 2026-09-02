import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_VERSION,
  completeFirstRunState,
  createFirstRunState,
  normalizeFirstRunState,
  shouldStartFirstRun,
  updateFirstRunState,
} from "./firstRun";

describe("first-run launch gate", () => {
  it("starts on a clean install", () => {
    expect(shouldStartFirstRun(null, false)).toBe(true);
  });

  it("does not interrupt a legacy installation", () => {
    expect(shouldStartFirstRun(null, true)).toBe(false);
  });

  it("does not start again after completion", () => {
    expect(shouldStartFirstRun(JSON.stringify({ status: "complete" }), true)).toBe(false);
  });

  it("recovers a corrupt marker through setup", () => {
    expect(shouldStartFirstRun("not-json", false)).toBe(true);
  });
});

describe("first-run persistence", () => {
  it("opens the theme step for a clean install", () => {
    expect(normalizeFirstRunState(null)).toEqual(createFirstRunState());
  });

  it("does not interrupt an existing installation that predates first-run metadata", () => {
    expect(normalizeFirstRunState({ storeVersion: 7, settings: { theme: "nocturne" } })).toEqual({
      version: FIRST_RUN_VERSION,
      status: "complete",
      step: "complete",
      path: null,
    });
  });

  it("restores a valid unfinished task", () => {
    expect(normalizeFirstRunState({
      firstRun: { version: FIRST_RUN_VERSION, status: "pending", step: "sources", path: "backup" },
    })).toEqual({
      version: FIRST_RUN_VERSION,
      status: "pending",
      step: "sources",
      path: "backup",
    });
  });

  it("recovers invalid pending metadata to the first safe step", () => {
    expect(normalizeFirstRunState({
      firstRun: { version: 999, status: "pending", step: "unknown", path: "broken" },
    })).toEqual(createFirstRunState());
  });

  it("keeps path and step updates immutable", () => {
    const initial = createFirstRunState();
    const next = updateFirstRunState(initial, { step: "sources", path: "fresh" });
    expect(next).toEqual({ ...initial, step: "sources", path: "fresh" });
    expect(initial).toEqual(createFirstRunState());
  });

  it("persists completion so a second launch stays complete", () => {
    const completed = completeFirstRunState(updateFirstRunState(createFirstRunState(), {
      step: "discover",
      path: "fresh",
    }));
    expect(normalizeFirstRunState({ firstRun: completed })).toEqual({
      version: FIRST_RUN_VERSION,
      status: "complete",
      step: "complete",
      path: "fresh",
    });
  });
});
