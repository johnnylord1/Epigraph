import { invoke } from "@tauri-apps/api/core";

import { store } from "../store/state.svelte";

export type BackgroundNotificationKind = "library" | "extensions";

function hasDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function allowed(kind: BackgroundNotificationKind): boolean {
  return kind === "library" ? store.settings.notifyLibraryUpdates : store.settings.notifyExtensionUpdates;
}

/**
 * Shows a native notification for a background result. The desktop shows it only while the
 * main window is hidden, minimized or unfocused; otherwise the in-app toast covers it.
 */
export async function notifyInBackground(kind: BackgroundNotificationKind, title: string, body?: string): Promise<boolean> {
  if (!hasDesktopRuntime() || !allowed(kind) || !title.trim()) return false;
  try {
    return await invoke<boolean>("show_background_notification", { title, body: body ?? null });
  } catch (error) {
    console.warn("Background notification failed:", error);
    return false;
  }
}

/** Keeps the tray icon and the close behavior in line with the setting. */
export async function syncCloseToBackground(enabled: boolean, labels: { open: string; quit: string }): Promise<void> {
  if (!hasDesktopRuntime()) return;
  try {
    await invoke("set_close_to_background", { enabled, openLabel: labels.open, quitLabel: labels.quit });
  } catch (error) {
    console.warn("Close-to-background setup failed:", error);
  }
}
