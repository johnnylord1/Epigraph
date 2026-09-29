import { invoke } from "./tauri/invoke";

export const SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE =
  "Suwayomi is updating. Please try again after the update finishes.";

export interface SuwayomiUpdateLockStatus {
  inProgress: boolean;
  owner: string | null;
  startedAtMs: number | null;
}

export type SuwayomiOperationScope =
  | "mutation"
  | "migration"
  | "library-update"
  | "backup-restore";

export const suwayomiUpdateLockState = $state<SuwayomiUpdateLockStatus>({
  inProgress: false,
  owner: null,
  startedAtMs: null,
});

const localMaintenanceOperations = new Set<symbol>();

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
  if (localMaintenanceOperations.size > 0) return true;
  try {
    return (await refreshSuwayomiUpdateLockStatus()).inProgress;
  } catch {
    return suwayomiUpdateLockState.inProgress;
  }
}

export function beginSuwayomiUpdateMaintenance(owner: string): symbol {
  const token = Symbol(owner);
  localMaintenanceOperations.add(token);
  applyLockStatus({
    inProgress: true,
    owner,
    startedAtMs: Date.now(),
  });
  return token;
}

export async function endSuwayomiUpdateMaintenance(token: symbol): Promise<void> {
  localMaintenanceOperations.delete(token);
  if (localMaintenanceOperations.size > 0) return;
  try {
    await refreshSuwayomiUpdateLockStatus();
  } catch {
    // The native command already returned, so its lock guard has been released.
    applyLockStatus({ inProgress: false, owner: null, startedAtMs: null });
  }
}

export async function assertSuwayomiWritesAllowed(): Promise<void> {
  if (await suwayomiUpdateInProgress()) {
    throw new Error(SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE);
  }
}

function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function acquireSuwayomiOperationLease(
  scope: SuwayomiOperationScope,
): Promise<() => Promise<void>> {
  if (localMaintenanceOperations.size > 0) {
    throw new Error(SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE);
  }
  if (!hasTauriRuntime()) {
    await assertSuwayomiWritesAllowed();
    return async () => {};
  }

  let token: string;
  try {
    token = await invoke<string>("begin_suwayomi_runtime_operation", { scope });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE, { cause: error });
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await invoke<boolean>("end_suwayomi_runtime_operation", { token }).catch(() => false);
  };
}

export async function withSuwayomiOperationLease<T>(
  scope: SuwayomiOperationScope,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireSuwayomiOperationLease(scope);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function setSuwayomiUpdateInProgressForTests(value: boolean): void {
  localMaintenanceOperations.clear();
  applyLockStatus({
    inProgress: value,
    owner: value ? "test" : null,
    startedAtMs: value ? Date.now() : null,
  });
}
