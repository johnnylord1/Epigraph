import {
  BUILTIN_LOCAL_PROFILES,
  getLocalProfileMeta,
  normalizeLocalProfileId,
  normalizeServerUrl,
  type LocalProfileId,
} from "../localProfiles";
import type { AethonPayloadRestorePlan, AethonRestorePlan } from "./aethonRestorePlanner";

export type BackupExportMode = "unified" | "manga" | "novels" | "books" | "app";
export type RestoreTargetMode = "other-local-profile" | "current-profile";
export type BackupImportKind = "aethon" | "manga";
export type BackupExecutionSelection = Record<string, boolean>;

export interface BackupLaunchIntent {
  kind: BackupImportKind;
  path: string;
  handoff: boolean;
  sourceProfileId?: LocalProfileId | null;
}

export function isBuiltInRestoreExecutionProfile(
  profileId: LocalProfileId | null | undefined,
): profileId is LocalProfileId {
  return normalizeLocalProfileId(profileId) != null;
}

export function resolveOtherLocalProfileId(
  profileId: LocalProfileId | null | undefined,
): LocalProfileId | null {
  const normalized = normalizeLocalProfileId(profileId);
  if (!normalized) return null;
  return normalized === "test" ? "main" : "test";
}

export function otherLocalProfileLabel(profileId: LocalProfileId | null | undefined): string | null {
  return getLocalProfileMeta(resolveOtherLocalProfileId(profileId))?.label ?? null;
}

export function executionBlockedReasonForProfile(
  profileId: LocalProfileId | null | undefined,
): string | null {
  return isBuiltInRestoreExecutionProfile(profileId)
    ? null
    : "Restore execution is available only when this session is running on the built-in TEST or MAIN local profiles.";
}

export function isPayloadExecutable(payload: Pick<AethonPayloadRestorePlan, "canExecuteRestore" | "canRestoreNow">): boolean {
  return payload.canExecuteRestore && payload.canRestoreNow;
}

export function defaultExecutionSelection(plan: AethonRestorePlan): BackupExecutionSelection {
  return Object.fromEntries(
    plan.payloads.map((payload) => [
      payload.kind,
      Boolean(payload.selectedByDefault && isPayloadExecutable(payload)),
    ]),
  );
}

export function selectedExecutablePayloadKinds(
  plan: AethonRestorePlan,
  selection: BackupExecutionSelection,
): string[] {
  return plan.payloads
    .filter((payload) => Boolean(selection[payload.kind]) && isPayloadExecutable(payload))
    .map((payload) => payload.kind);
}

export function describeRestoreTarget(
  currentProfileId: LocalProfileId | null | undefined,
  mode: RestoreTargetMode,
  handoff = false,
): string {
  const current = getLocalProfileMeta(normalizeLocalProfileId(currentProfileId));
  if (mode === "current-profile") {
    if (handoff && current) {
      return `Current profile (${current.label})`;
    }
    return current ? `Current profile (${current.label})` : "Current profile";
  }
  const other = getLocalProfileMeta(resolveOtherLocalProfileId(currentProfileId));
  return other ? `Other local profile (${other.label})` : "Other local profile";
}

export function buildRestoreRelaunchArgs(input: {
  targetProfileId: LocalProfileId;
  intent: BackupLaunchIntent;
}): string[] {
  const args = [`--${input.targetProfileId}`];
  if (input.intent.kind === "aethon") {
    args.push(`--restore-aethon-backup=${input.intent.path}`);
  } else {
    args.push(`--restore-manga-backup=${input.intent.path}`);
  }
  args.push("--restore-handoff");
  if (input.intent.sourceProfileId) {
    args.push(`--restore-source-profile=${input.intent.sourceProfileId}`);
  }
  return args;
}

export function detectBackupImportKind(path: string | null | undefined): BackupImportKind | null {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized.endsWith(".aethonbk")) return "aethon";
  if (normalized.endsWith(".tachibk") || normalized.endsWith(".proto.gz") || normalized.endsWith(".proto")) {
    return "manga";
  }
  return null;
}

export function normalizeBackupSavePath(path: string, extension: ".aethonbk" | ".tachibk"): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return trimmed.toLowerCase().endsWith(extension) ? trimmed : `${trimmed}${extension}`;
}

export function canExecuteUnifiedRestoreOnCurrentSession(
  currentProfileId: LocalProfileId | null | undefined,
): boolean {
  return isBuiltInRestoreExecutionProfile(currentProfileId);
}

export function hasAnyExecutableSelection(
  plan: AethonRestorePlan,
  selection: BackupExecutionSelection,
): boolean {
  return selectedExecutablePayloadKinds(plan, selection).length > 0;
}

export function currentProfileSupportsOtherLocalTarget(
  currentProfileId: LocalProfileId | null | undefined,
): boolean {
  return resolveOtherLocalProfileId(currentProfileId) != null;
}

export function availableUnifiedExportKinds(): string[] {
  return BUILTIN_LOCAL_PROFILES.map((profile) => profile.id);
}

export function normalizeNovelScopeServerUrl(serverUrl: string | null | undefined): string | null {
  return normalizeServerUrl(serverUrl);
}
