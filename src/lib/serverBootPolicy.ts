export interface SnapshotBootPolicyInput {
  standbyEnabled: boolean;
  hasSnapshot: boolean;
  attachOnly: boolean;
  updateDue: boolean;
  /** How long this start has waited for Suwayomi so far. */
  waitedMs?: number;
}

/** A start that waits this long for Suwayomi opens the saved library, and Suwayomi joins once it is ready. */
export const SNAPSHOT_BOOT_FALLBACK_MS = 30_000;

export interface ServerAutoStartPolicyInput extends SnapshotBootPolicyInput {
  autoStartServer: boolean;
  isLoopback: boolean;
}

export function shouldBootFromLibrarySnapshot(input: SnapshotBootPolicyInput) {
  if (input.hasSnapshot && !input.attachOnly && (input.waitedMs ?? 0) >= SNAPSHOT_BOOT_FALLBACK_MS) return true;
  return input.standbyEnabled
    && input.hasSnapshot
    && !input.attachOnly
    && !input.updateDue;
}

export function shouldAutoStartManagedServer(input: ServerAutoStartPolicyInput) {
  if (input.attachOnly) return false;
  if (!input.isLoopback) return false;
  if (!input.autoStartServer) return false;
  return true;
}
