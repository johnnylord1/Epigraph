export interface SnapshotBootPolicyInput {
  standbyEnabled: boolean;
  hasSnapshot: boolean;
  attachOnly: boolean;
  updateDue: boolean;
}

export interface ServerAutoStartPolicyInput extends SnapshotBootPolicyInput {
  autoStartServer: boolean;
  isLoopback: boolean;
}

export function shouldBootFromLibrarySnapshot(input: SnapshotBootPolicyInput) {
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
