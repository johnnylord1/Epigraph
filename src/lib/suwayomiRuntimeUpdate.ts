import { invoke } from "@tauri-apps/api/core";
import { getServerAuthHeader } from "./client";
import { resetManagedSourceRuntime } from "./manga/runtime";
import {
  beginSuwayomiUpdateMaintenance,
  endSuwayomiUpdateMaintenance,
} from "./suwayomiUpdateLock.svelte";
import { store } from "../store/state.svelte";

export type SuwayomiRuntimeMode =
  | "managed-bundled"
  | "managed-runtime"
  | "managed-user-binary"
  | "external"
  | "unknown";

export interface SuwayomiJarVersion {
  version: string | null;
  revision: string | null;
  buildType: string | null;
  webuiTag: string | null;
}

export interface SuwayomiRuntimeStatus {
  mode: SuwayomiRuntimeMode;
  version: string | null;
  jarVersion: SuwayomiJarVersion | null;
  jarPath: string | null;
  profileId: string | null;
  rootDir: string | null;
  serverUrl: string;
  updateAllowed: boolean;
  blockReason: string | null;
}

export interface SuwayomiRuntimeStatusInput {
  serverUrl?: string | null;
  binary?: string | null;
  profileId?: string | null;
  profileLabel?: string | null;
}

export type UpdateCheckStatus =
  | "upToDate"
  | "updateAvailable"
  | "blocked"
  | "checkFailed";

export interface SuwayomiUpdateCheckResult {
  status: UpdateCheckStatus;
  currentVersion: string | null;
  latestCompatibleVersion: string | null;
  releaseTag: string | null;
  releaseUrl: string | null;
  updateAllowed: boolean;
  blockReason: string | null;
  notes: string | null;
  releaseNotes: string | null;
}

export interface SuwayomiUpdateStageResult {
  stagingPath: string;
  jarPath: string;
  version: string;
  sha256: string;
  assetName: string;
  checksumAsset: string;
  releaseTag: string;
  releaseUrl: string;
}

export interface SuwayomiUpdateSnapshotResult {
  snapshotPath: string;
  manifestPath: string;
  copiedFiles: string[];
  stoppedRuntime: boolean;
  restartedRuntime: boolean;
}

export interface SuwayomiUpdatePromotionResult {
  currentPath: string;
  previousPath: string | null;
  version: string;
  rolledBack: boolean;
  restartedRuntime: boolean;
}

async function withSuwayomiUpdateMaintenance<T>(
  owner: string,
  operation: () => Promise<T>,
): Promise<T> {
  const token = beginSuwayomiUpdateMaintenance(owner);
  try {
    return await operation();
  } finally {
    resetManagedSourceRuntime();
    await endSuwayomiUpdateMaintenance(token);
  }
}

export function currentSuwayomiRuntimeStatusInput(): Required<SuwayomiRuntimeStatusInput> {
  return {
    serverUrl: store.runtimeServerUrl ?? store.runtimeResolvedLocalProfileMeta?.serverUrl ?? store.settings.serverUrl,
    binary: store.settings.serverBinary ?? "",
    profileId: store.runtimeResolvedLocalProfileId,
    profileLabel: store.runtimeResolvedLocalProfileMeta?.label ?? store.runtimeServerLabel,
  };
}

export function getSuwayomiRuntimeStatus(
  input: SuwayomiRuntimeStatusInput = currentSuwayomiRuntimeStatusInput(),
) {
  const fallback = currentSuwayomiRuntimeStatusInput();
  return invoke<SuwayomiRuntimeStatus>("get_suwayomi_runtime_status", {
    serverUrl: input.serverUrl ?? fallback.serverUrl,
    binary: input.binary ?? fallback.binary,
    profileId: input.profileId ?? fallback.profileId,
    profileLabel: input.profileLabel ?? fallback.profileLabel,
  });
}

export function checkSuwayomiRuntimeUpdate(
  input: SuwayomiRuntimeStatusInput = currentSuwayomiRuntimeStatusInput(),
) {
  const fallback = currentSuwayomiRuntimeStatusInput();
  return invoke<SuwayomiUpdateCheckResult>("check_suwayomi_runtime_update", {
    serverUrl: input.serverUrl ?? fallback.serverUrl,
    binary: input.binary ?? fallback.binary,
    profileId: input.profileId ?? fallback.profileId,
    profileLabel: input.profileLabel ?? fallback.profileLabel,
  });
}

export function stageSuwayomiRuntimeUpdate(
  input: SuwayomiRuntimeStatusInput & { targetVersion?: string | null } = currentSuwayomiRuntimeStatusInput(),
) {
  const fallback = currentSuwayomiRuntimeStatusInput();
  return invoke<SuwayomiUpdateStageResult>("stage_suwayomi_runtime_update", {
    serverUrl: input.serverUrl ?? fallback.serverUrl,
    binary: input.binary ?? fallback.binary,
    profileId: input.profileId ?? fallback.profileId,
    profileLabel: input.profileLabel ?? fallback.profileLabel,
    targetVersion: input.targetVersion ?? null,
  });
}

export function createSuwayomiUpdateSnapshot(
  input: SuwayomiRuntimeStatusInput = currentSuwayomiRuntimeStatusInput(),
) {
  const fallback = currentSuwayomiRuntimeStatusInput();
  return withSuwayomiUpdateMaintenance("snapshot", () =>
    invoke<SuwayomiUpdateSnapshotResult>("create_suwayomi_update_snapshot", {
      serverUrl: input.serverUrl ?? fallback.serverUrl,
      binary: input.binary ?? fallback.binary,
      profileId: input.profileId ?? fallback.profileId,
      profileLabel: input.profileLabel ?? fallback.profileLabel,
    }));
}

export function promoteSuwayomiRuntimeUpdate(
  input: SuwayomiRuntimeStatusInput & { stagedVersion: string; snapshotPath: string },
) {
  const fallback = currentSuwayomiRuntimeStatusInput();
  return withSuwayomiUpdateMaintenance("promotion", () =>
    invoke<SuwayomiUpdatePromotionResult>("promote_suwayomi_runtime_update", {
      serverUrl: input.serverUrl ?? fallback.serverUrl,
      binary: input.binary ?? fallback.binary,
      profileId: input.profileId ?? fallback.profileId,
      profileLabel: input.profileLabel ?? fallback.profileLabel,
      stagedVersion: input.stagedVersion,
      snapshotPath: input.snapshotPath,
      authHeader: getServerAuthHeader(),
    }));
}

export function installSuwayomiRuntimeUpdate(
  input: SuwayomiRuntimeStatusInput & { stagedVersion: string },
) {
  const fallback = currentSuwayomiRuntimeStatusInput();
  return withSuwayomiUpdateMaintenance("install", () =>
    invoke<SuwayomiUpdatePromotionResult>("install_suwayomi_runtime_update", {
      serverUrl: input.serverUrl ?? fallback.serverUrl,
      binary: input.binary ?? fallback.binary,
      profileId: input.profileId ?? fallback.profileId,
      profileLabel: input.profileLabel ?? fallback.profileLabel,
      stagedVersion: input.stagedVersion,
      authHeader: getServerAuthHeader(),
    }));
}
