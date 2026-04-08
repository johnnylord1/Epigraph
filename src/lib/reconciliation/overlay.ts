import { invoke } from "@tauri-apps/api/core";
import { getEffectiveServerUrl } from "../serverTarget";
import type { OverlayEntry, OverlayFile } from "./types";

const EMPTY_OVERLAY: OverlayFile = {
  version: 1,
  entries: {},
};

export async function readOverlayFile(): Promise<OverlayFile> {
  const raw = await invoke<string | null>("read_reconciliation_overlay", {
    serverUrl: getEffectiveServerUrl(),
  });
  if (!raw) return EMPTY_OVERLAY;
  try {
    const parsed = JSON.parse(raw) as OverlayFile;
    if (parsed.version !== 1 || !parsed.entries) return EMPTY_OVERLAY;
    return parsed;
  } catch {
    return EMPTY_OVERLAY;
  }
}

export async function writeOverlayFile(overlay: OverlayFile): Promise<void> {
  await invoke("write_reconciliation_overlay", {
    contents: JSON.stringify(overlay, null, 2),
    serverUrl: getEffectiveServerUrl(),
  });
}

export async function upsertOverlayEntry(entry: OverlayEntry): Promise<OverlayFile> {
  const overlay = await readOverlayFile();
  overlay.entries[entry.backupFingerprint] = entry;
  await writeOverlayFile(overlay);
  return overlay;
}
