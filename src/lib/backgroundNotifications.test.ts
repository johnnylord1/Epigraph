import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { notifyInBackground, syncCloseToBackground } from "./backgroundNotifications";
import { store } from "../store/state.svelte";

describe("background notifications", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(true);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    store.settings.notifyLibraryUpdates = true;
    store.settings.notifyExtensionUpdates = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the desktop to show the result", async () => {
    await expect(notifyInBackground("library", "New chapters", "3 chapters")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("show_background_notification", { title: "New chapters", body: "3 chapters" });
  });

  it("respects each notification setting", async () => {
    store.settings.notifyExtensionUpdates = false;
    await expect(notifyInBackground("extensions", "Extensions updated")).resolves.toBe(false);
    await notifyInBackground("library", "Library updated");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("show_background_notification", { title: "Library updated", body: null });
  });

  it("does nothing outside the desktop runtime or without a title", async () => {
    await expect(notifyInBackground("library", "   ")).resolves.toBe(false);
    vi.stubGlobal("window", {});
    await expect(notifyInBackground("library", "Library updated")).resolves.toBe(false);
    await syncCloseToBackground(true, { open: "Open", quit: "Quit" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never throws when the desktop rejects the call", async () => {
    invoke.mockRejectedValue(new Error("not allowed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notifyInBackground("library", "Library updated")).resolves.toBe(false);
    await expect(syncCloseToBackground(true, { open: "Open", quit: "Quit" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("passes the tray labels with the close setting", async () => {
    await syncCloseToBackground(false, { open: "Abrir", quit: "Sair" });
    expect(invoke).toHaveBeenCalledWith("set_close_to_background", { enabled: false, openLabel: "Abrir", quitLabel: "Sair" });
  });
});
