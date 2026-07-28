import { invoke } from "@tauri-apps/api/core";

import { getServerAuthHeader } from "../../client";
import {
  currentSuwayomiRuntimeStatusInput,
  type SuwayomiRuntimeStatusInput,
} from "../../suwayomiRuntimeUpdate";
import {
  loadExtensionCompatibilityState,
  saveExtensionCompatibilityState,
  upsertExtensionCompatibilityRecord,
  type ExtensionCompatibilityState,
  type ExtensionFailureOwner,
} from "./extensionCompatibility";
import type { ExtensionRef } from "./types";
import { resetManagedSourceRuntime } from "./managed";

export type ExtensionUpdatePhase = "IDLE" | "CERTIFYING" | "COMPLETED" | "FAILED";

export interface ExtensionUpdateCandidate {
  packageName: string;
  versionCode: string;
  versionName: string;
  storeId: string;
  storeUrlCanonical: string;
  artifactUrl: string;
  artifactType: "apk" | "jar";
}

export interface ExtensionBatchEvidence {
  packageName: string;
  versionCode: string;
  versionName: string;
  artifactSha256: string;
  storeId: string;
  storeUrlCanonical: string;
  sourceIds: string[];
  status: "HEALTHY" | "INCOMPATIBLE";
  failureOwner: ExtensionFailureOwner;
  failureCode: string | null;
}

export interface ExtensionNativeBatchResult {
  batchId: string;
  runtimeVersion: string;
  runtimeArtifactSha256: string;
  approved: ExtensionBatchEvidence[];
  rejected: ExtensionBatchEvidence[];
  restartedRuntime: boolean;
}

export interface ExtensionBatchResult extends ExtensionNativeBatchResult {
  state: ExtensionCompatibilityState;
}

export interface ExtensionBatchDriver {
  runBatch(candidates: readonly ExtensionUpdateCandidate[]): Promise<ExtensionNativeBatchResult>;
}

export interface ExtensionUpdateCoordinatorOptions {
  profileId: string;
  state: ExtensionCompatibilityState;
  driver: ExtensionBatchDriver;
  now?: () => number;
  onState?: (phase: ExtensionUpdatePhase) => void;
}

export interface NativeExtensionBatchInput extends SuwayomiRuntimeStatusInput {
  authorization?: string | null;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Automatic extension updates require HTTPS artifacts.");
  }
  if (url.username || url.password) {
    throw new Error("Extension update URLs cannot contain credentials.");
  }
  url.hash = "";
  return url.toString();
}

function canonicalStoreUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return normalizeUrl(value).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function extensionUpdateCandidate(extension: ExtensionRef): ExtensionUpdateCandidate | null {
  if (!extension.isInstalled || !extension.hasUpdate || extension.isObsolete) return null;
  const artifactType = extension.jarUrl ? "jar" : extension.apkUrl ? "apk" : null;
  const artifactUrl = extension.jarUrl ?? extension.apkUrl;
  const storeUrlCanonical = canonicalStoreUrl(extension.storeId);
  if (!artifactType || !artifactUrl || !storeUrlCanonical) return null;
  try {
    const normalizedArtifactUrl = normalizeUrl(artifactUrl);
    if (!new URL(normalizedArtifactUrl).pathname.toLowerCase().endsWith(`.${artifactType}`)) return null;
    return {
      packageName: extension.packageName,
      versionCode: extension.versionCode,
      versionName: extension.versionName,
      storeId: extension.storeId!,
      storeUrlCanonical,
      artifactUrl: normalizedArtifactUrl,
      artifactType,
    };
  } catch {
    return null;
  }
}

export function createNativeExtensionBatchDriver(
  input: NativeExtensionBatchInput = currentSuwayomiRuntimeStatusInput(),
): ExtensionBatchDriver {
  const fallback = currentSuwayomiRuntimeStatusInput();
  return {
    runBatch(candidates) {
      return invoke<ExtensionNativeBatchResult>("certify_suwayomi_extension_update_batch", {
        serverUrl: input.serverUrl ?? fallback.serverUrl,
        binary: input.binary ?? fallback.binary,
        profileId: input.profileId ?? fallback.profileId,
        profileLabel: input.profileLabel ?? fallback.profileLabel,
        authorization: input.authorization ?? getServerAuthHeader(),
        items: candidates,
      });
    },
  };
}

export class ExtensionUpdateCoordinator {
  private phase: ExtensionUpdatePhase = "IDLE";
  private state: ExtensionCompatibilityState;
  private readonly now: () => number;

  constructor(private readonly options: ExtensionUpdateCoordinatorOptions) {
    this.state = options.state;
    this.now = options.now ?? Date.now;
  }

  getPhase(): ExtensionUpdatePhase {
    return this.phase;
  }

  async run(extensions: readonly ExtensionRef[]): Promise<ExtensionBatchResult> {
    const candidates = extensions
      .map(extensionUpdateCandidate)
      .filter((candidate): candidate is ExtensionUpdateCandidate => Boolean(candidate));
    if (candidates.length === 0) {
      throw new Error("No extension update has eligible artifact provenance.");
    }

    this.setPhase("CERTIFYING");
    try {
      const result = await this.options.driver.runBatch(candidates);
      for (const evidence of [...result.approved, ...result.rejected]) {
        this.record(result, evidence);
      }
      this.setPhase("COMPLETED");
      return { ...result, state: this.state };
    } catch (error) {
      this.setPhase("FAILED");
      throw error;
    }
  }

  private record(result: ExtensionNativeBatchResult, evidence: ExtensionBatchEvidence): void {
    const checkedAt = this.now();
    this.state = upsertExtensionCompatibilityRecord(this.state, {
      schemaVersion: 1,
      profileId: this.options.profileId,
      packageName: evidence.packageName,
      versionCode: evidence.versionCode,
      versionName: evidence.versionName,
      artifactSha256: evidence.artifactSha256,
      storeId: evidence.storeId,
      storeUrlCanonical: evidence.storeUrlCanonical,
      runtimeVersion: result.runtimeVersion,
      runtimeArtifactSha256: result.runtimeArtifactSha256,
      sourceIds: [...evidence.sourceIds],
      testedSourceIds: [],
      certificationScope: "STRUCTURAL",
      status: evidence.status,
      failureOwner: evidence.failureOwner,
      failureCode: evidence.failureCode,
      checkedAt,
      lastHealthyAt: evidence.status === "HEALTHY" ? checkedAt : null,
    });
  }

  private setPhase(phase: ExtensionUpdatePhase): void {
    this.phase = phase;
    this.options.onState?.(phase);
  }
}

export async function runTransactionalExtensionUpdates(
  extensions: readonly ExtensionRef[],
  input: NativeExtensionBatchInput = currentSuwayomiRuntimeStatusInput(),
): Promise<ExtensionBatchResult> {
  const fallback = currentSuwayomiRuntimeStatusInput();
  const profileId = input.profileId ?? fallback.profileId ?? "main";
  const serverUrl = input.serverUrl ?? fallback.serverUrl;
  const state = await loadExtensionCompatibilityState({ profileId, serverUrl });
  const coordinator = new ExtensionUpdateCoordinator({
    profileId,
    state,
    driver: createNativeExtensionBatchDriver(input),
  });
  try {
    const result = await coordinator.run(extensions);
    const savedState = await saveExtensionCompatibilityState(result.state, { profileId, serverUrl });
    return { ...result, state: savedState };
  } finally {
    // The native transaction restarts Suwayomi on both success and rollback.
    resetManagedSourceRuntime();
  }
}
