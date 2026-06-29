import { invoke } from "@tauri-apps/api/core";

export const SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE =
  "Suwayomi is updating. Please try again after the update finishes.";

export interface SuwayomiUpdateLockStatus {
  inProgress: boolean;
  owner: string | null;
  startedAtMs: number | null;
}

export const suwayomiUpdateLockState = $state<SuwayomiUpdateLockStatus>({
  inProgress: false,
  owner: null,
  startedAtMs: null,
});

function applyLockStatus(status: SuwayomiUpdateLockStatus): SuwayomiUpdateLockStatus {
  suwayomiUpdateLockState.inProgress = status.inProgress;
  suwayomiUpdateLockState.owner = status.owner;
  suwayomiUpdateLockState.startedAtMs = status.startedAtMs;
  return status;
}

export async function refreshSuwayomiUpdateLockStatus(): Promise<SuwayomiUpdateLockStatus> {
  const status = await invoke<SuwayomiUpdateLockStatus>("get_suwayomi_update_lock_status");
  return applyLockStatus(status);
}

export async function suwayomiUpdateInProgress(): Promise<boolean> {
  if (suwayomiUpdateLockState.inProgress) return true;
  try {
    return (await refreshSuwayomiUpdateLockStatus()).inProgress;
  } catch {
    return suwayomiUpdateLockState.inProgress;
  }
}

export async function assertSuwayomiWritesAllowed(): Promise<void> {
  if (await suwayomiUpdateInProgress()) {
    throw new Error(SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE);
  }
}

export function setSuwayomiUpdateInProgressForTests(value: boolean): void {
  applyLockStatus({
    inProgress: value,
    owner: value ? "test" : null,
    startedAtMs: value ? Date.now() : null,
  });
}
