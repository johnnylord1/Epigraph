import { invoke } from "./tauri/invoke";
import { FIRST_RUN_STORAGE_KEY, normalizeFirstRunState } from "./firstRun";

/*
 * WebView storage reaches the disk a while after it is written, so a computer that lost power
 * right after setup showed setup again. The marker is also kept in a file that is written through
 * at once, and a launch that finds setup done there trusts it.
 */

export interface FirstRunDurableScope {
  profileId: string | null | undefined;
  serverUrl: string | null | undefined;
}

type MarkerStorage = Pick<Storage, "getItem">;

/** Copies the current marker to its file; setup goes on whether or not the copy lands. */
export function mirrorFirstRunMarker(scope: FirstRunDurableScope, storage: MarkerStorage = localStorage): Promise<void> {
  const { profileId, serverUrl } = scope;
  if (!profileId || !serverUrl) return Promise.resolve();
  let contents: string | null;
  try { contents = storage.getItem(FIRST_RUN_STORAGE_KEY); } catch { return Promise.resolve(); }
  if (!contents) return Promise.resolve();
  return invoke<void>("write_first_run_state", { contents, profileId, serverUrl }).catch(() => {});
}

/**
 * Brings back a finished setup the file remembers but the WebView lost. A setup the user started
 * over from Settings stays open, since that is what they asked for.
 */
export async function restoreDurableFirstRunCompletion(
  scope: { profileId: string; serverUrl: string },
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): Promise<boolean> {
  try {
    const local = JSON.parse(storage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null");
    if (local?.status === "complete" || local?.cancellable === true) return false;
  } catch {
    // An unreadable marker is replaced like a missing one.
  }
  const contents = await invoke<string | null>("read_first_run_state", scope).catch(() => null);
  if (!contents) return false;
  let durable;
  try { durable = normalizeFirstRunState({ firstRun: JSON.parse(contents) }); } catch { return false; }
  if (durable.status !== "complete") return false;
  try { storage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(durable)); } catch { return false; }
  return true;
}
