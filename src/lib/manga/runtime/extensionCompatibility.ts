import { invoke } from "@tauri-apps/api/core";
import { redactDiagnosticText } from "./diagnostics";

export const EXTENSION_COMPATIBILITY_SCHEMA_VERSION = 2 as const;
export const OBSERVED_COMPATIBILITY_REPORT_SCHEMA_VERSION = 1 as const;
export const MAX_OBSERVED_COMPATIBILITY_REPORTS = 64 as const;

export type ExtensionCertificationScope =
  | "STRUCTURAL"
  | "SMOKE"
  | "FULL_CANARY"
  | "OBSERVATIONAL";

export type ExtensionCompatibilityStatus =
  | "HEALTHY"
  | "INCOMPATIBLE"
  | "OBSOLETE"
  | "EXTERNAL_FAILURE"
  | "UNKNOWN";

export type ExtensionFailureOwner =
  | "runtime"
  | "extension"
  | "website"
  | "antibot"
  | "authentication"
  | "network"
  | "aethon"
  | "unknown";

export type CompatibilityStageStatus =
  | "PASS"
  | "FAIL"
  | "SKIPPED"
  | "UNSUPPORTED"
  | "NOT_OBSERVED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "INCONCLUSIVE";

export type CompatibilityAggregateStatus =
  | "PASS"
  | "FAIL"
  | "DEGRADED"
  | "INCONCLUSIVE"
  | "CANCELLED";

export type CompatibilityStageKind = "DETERMINISTIC" | "OBSERVATIONAL";
export type CompatibilityReportTrigger = "AUTOMATIC_STRUCTURAL" | "EXPLICIT_LIVE";
export type CompatibilityRuntimeScope = "LOCAL_OWNED" | "REMOTE_SHARED";

export interface ObservedCompatibilityStage {
  id: string;
  label: string;
  kind: CompatibilityStageKind;
  status: CompatibilityStageStatus;
  durationMs: number | null;
  failureCode: string | null;
}

export interface ObservedCompatibilityReport {
  schemaVersion: typeof OBSERVED_COMPATIBILITY_REPORT_SCHEMA_VERSION;
  reportId: string;
  profileId: string;
  packageName: string;
  versionCode: string;
  artifactSha256: string | null;
  runtimeVersion: string;
  runtimeArtifactSha256: string | null;
  adapterProfile: string;
  endpointIdentity: string;
  runtimeScope: CompatibilityRuntimeScope;
  trigger: CompatibilityReportTrigger;
  sourceId: string | null;
  startedAt: number;
  completedAt: number;
  aggregateStatus: CompatibilityAggregateStatus;
  stages: ObservedCompatibilityStage[];
}

export interface ExtensionCompatibilityRecord {
  schemaVersion: number;
  profileId: string;
  packageName: string;
  versionCode: string;
  versionName: string;
  artifactSha256: string;
  storeId: string;
  storeUrlCanonical: string;
  runtimeVersion: string;
  runtimeArtifactSha256: string;
  sourceIds: string[];
  testedSourceIds: string[];
  certificationScope: ExtensionCertificationScope;
  status: ExtensionCompatibilityStatus;
  failureOwner: ExtensionFailureOwner;
  failureCode: string | null;
  checkedAt: number;
  lastHealthyAt: number | null;
}

export interface ExtensionCompatibilityState {
  schemaVersion: typeof EXTENSION_COMPATIBILITY_SCHEMA_VERSION;
  profileId: string;
  records: ExtensionCompatibilityRecord[];
  reports: ObservedCompatibilityReport[];
  updatedAt: number | null;
}

export interface ExtensionCompatibilityScope {
  profileId: string;
  serverUrl?: string | null;
}

const memoryState = new Map<string, ExtensionCompatibilityState>();

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function boundedDiagnosticText(value: unknown, maxLength = 160): string {
  return redactDiagnosticText(text(value), maxLength);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))].sort();
}

function canonicalUrl(value: unknown): string {
  const normalized = text(value);
  if (!normalized) return "manual";
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return normalized;
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function sha256(value: unknown): string {
  const normalized = text(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function nullableSha256(value: unknown): string | null {
  return sha256(value) || null;
}

function certificationScope(value: unknown): ExtensionCertificationScope {
  return value === "SMOKE" || value === "FULL_CANARY" || value === "OBSERVATIONAL"
    ? value
    : "STRUCTURAL";
}

function compatibilityStatus(value: unknown): ExtensionCompatibilityStatus {
  return value === "HEALTHY" || value === "INCOMPATIBLE" || value === "OBSOLETE"
    || value === "EXTERNAL_FAILURE"
    ? value
    : "UNKNOWN";
}

function failureOwner(value: unknown): ExtensionFailureOwner {
  return value === "runtime" || value === "extension" || value === "website"
    || value === "antibot" || value === "authentication" || value === "network"
    || value === "aethon"
    ? value
    : "unknown";
}

function stageStatus(value: unknown): CompatibilityStageStatus {
  return value === "PASS" || value === "FAIL" || value === "SKIPPED"
    || value === "UNSUPPORTED" || value === "NOT_OBSERVED"
    || value === "TIMED_OUT" || value === "CANCELLED"
    ? value
    : "INCONCLUSIVE";
}

function aggregateStatus(value: unknown): CompatibilityAggregateStatus {
  return value === "PASS" || value === "FAIL" || value === "DEGRADED"
    || value === "CANCELLED"
    ? value
    : "INCONCLUSIVE";
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function duration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

export function aggregateObservedCompatibilityStages(
  stages: readonly ObservedCompatibilityStage[],
): CompatibilityAggregateStatus {
  if (stages.length === 0) return "INCONCLUSIVE";
  const deterministic = stages.filter((stage) => stage.kind === "DETERMINISTIC");
  if (deterministic.some((stage) => stage.status === "FAIL")) return "FAIL";
  if (deterministic.some((stage) => stage.status === "CANCELLED")) return "CANCELLED";
  if (deterministic.some((stage) => (
    stage.status === "TIMED_OUT"
    || stage.status === "INCONCLUSIVE"
    || stage.status === "NOT_OBSERVED"
    || stage.status === "UNSUPPORTED"
  ))) return "INCONCLUSIVE";
  const observed = stages.filter((stage) => stage.kind === "OBSERVATIONAL");
  if (observed.some((stage) => stage.status === "CANCELLED") && deterministic.length === 0) {
    return "CANCELLED";
  }
  if (observed.some((stage) => stage.status !== "PASS" && stage.status !== "SKIPPED")) {
    return stages.some((stage) => stage.status === "PASS") ? "DEGRADED" : "INCONCLUSIVE";
  }
  return stages.some((stage) => stage.status === "PASS") ? "PASS" : "INCONCLUSIVE";
}

function normalizeObservedCompatibilityStage(value: unknown): ObservedCompatibilityStage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedDiagnosticText(raw.id, 80);
  if (!id) return null;
  return {
    id,
    label: boundedDiagnosticText(raw.label, 120) || id,
    kind: raw.kind === "OBSERVATIONAL" ? "OBSERVATIONAL" : "DETERMINISTIC",
    status: stageStatus(raw.status),
    durationMs: duration(raw.durationMs),
    failureCode: nullableText(boundedDiagnosticText(raw.failureCode, 100)),
  };
}

export function normalizeObservedCompatibilityReport(
  value: unknown,
  fallbackProfileId: string,
): ObservedCompatibilityReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reportId = boundedDiagnosticText(raw.reportId, 120);
  const profileId = boundedDiagnosticText(raw.profileId, 120) || fallbackProfileId;
  const packageName = boundedDiagnosticText(raw.packageName, 180);
  const versionCode = boundedDiagnosticText(raw.versionCode, 80);
  const runtimeVersion = boundedDiagnosticText(raw.runtimeVersion, 80);
  const adapterProfile = boundedDiagnosticText(raw.adapterProfile, 80);
  const endpointIdentity = boundedDiagnosticText(raw.endpointIdentity, 240);
  if (!reportId || !profileId || !packageName || !versionCode || !runtimeVersion
    || !adapterProfile || !endpointIdentity) return null;
  const startedAt = timestamp(raw.startedAt, Date.now());
  const completedAt = Math.max(startedAt, timestamp(raw.completedAt, startedAt));
  const stages = Array.isArray(raw.stages)
    ? raw.stages
      .slice(0, 32)
      .map(normalizeObservedCompatibilityStage)
      .filter((stage): stage is ObservedCompatibilityStage => Boolean(stage))
    : [];
  const computedAggregate = aggregateObservedCompatibilityStages(stages);
  const requestedAggregate = aggregateStatus(raw.aggregateStatus);
  return {
    schemaVersion: OBSERVED_COMPATIBILITY_REPORT_SCHEMA_VERSION,
    reportId,
    profileId,
    packageName,
    versionCode,
    artifactSha256: nullableSha256(raw.artifactSha256),
    runtimeVersion,
    runtimeArtifactSha256: nullableSha256(raw.runtimeArtifactSha256),
    adapterProfile,
    endpointIdentity,
    runtimeScope: raw.runtimeScope === "LOCAL_OWNED" ? "LOCAL_OWNED" : "REMOTE_SHARED",
    trigger: raw.trigger === "EXPLICIT_LIVE" ? "EXPLICIT_LIVE" : "AUTOMATIC_STRUCTURAL",
    sourceId: nullableText(boundedDiagnosticText(raw.sourceId, 120)),
    startedAt,
    completedAt,
    aggregateStatus: requestedAggregate === computedAggregate ? requestedAggregate : computedAggregate,
    stages,
  };
}

function retainObservedCompatibilityReports(
  reports: readonly ObservedCompatibilityReport[],
): ObservedCompatibilityReport[] {
  const deduplicated = new Map<string, ObservedCompatibilityReport>();
  for (const report of reports.slice().sort((left, right) => right.completedAt - left.completedAt)) {
    if (!deduplicated.has(report.reportId)) deduplicated.set(report.reportId, report);
  }
  return [...deduplicated.values()]
    .sort((left, right) => right.completedAt - left.completedAt)
    .slice(0, MAX_OBSERVED_COMPATIBILITY_REPORTS);
}

export function upsertObservedCompatibilityReport(
  state: ExtensionCompatibilityState,
  report: ObservedCompatibilityReport,
): ExtensionCompatibilityState {
  const normalized = normalizeObservedCompatibilityReport(report, state.profileId);
  if (!normalized) throw new Error("Observed compatibility evidence is incomplete.");
  return {
    ...state,
    reports: retainObservedCompatibilityReports([
      normalized,
      ...state.reports.filter((entry) => entry.reportId !== normalized.reportId),
    ]),
    updatedAt: Date.now(),
  };
}

export function latestObservedCompatibilityReport(
  state: ExtensionCompatibilityState,
  packageName: string,
): ObservedCompatibilityReport | null {
  return state.reports.find((report) => report.packageName === packageName) ?? null;
}

export function extensionCompatibilityIdentity(record: ExtensionCompatibilityRecord): string {
  return [
    record.profileId,
    record.packageName,
    record.versionCode,
    record.artifactSha256,
    record.storeId,
    record.runtimeVersion,
    record.runtimeArtifactSha256,
  ].join("\u0000");
}

export function normalizeExtensionCompatibilityRecord(
  value: unknown,
  fallbackProfileId: string,
): ExtensionCompatibilityRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const profileId = text(raw.profileId) || fallbackProfileId;
  const packageName = text(raw.packageName);
  const versionCode = text(raw.versionCode);
  const artifactSha256 = sha256(raw.artifactSha256);
  const runtimeVersion = text(raw.runtimeVersion);
  const runtimeArtifactSha256 = sha256(raw.runtimeArtifactSha256);
  if (!profileId || !packageName || !versionCode || !artifactSha256
    || !runtimeVersion || !runtimeArtifactSha256) return null;
  const status = compatibilityStatus(raw.status);
  const checkedAt = typeof raw.checkedAt === "number" && Number.isFinite(raw.checkedAt)
    ? raw.checkedAt
    : Date.now();
  return {
    schemaVersion: EXTENSION_COMPATIBILITY_SCHEMA_VERSION,
    profileId,
    packageName,
    versionCode,
    versionName: text(raw.versionName),
    artifactSha256,
    storeId: text(raw.storeId) || "manual",
    storeUrlCanonical: canonicalUrl(raw.storeUrlCanonical),
    runtimeVersion,
    runtimeArtifactSha256,
    sourceIds: stringArray(raw.sourceIds),
    testedSourceIds: stringArray(raw.testedSourceIds),
    certificationScope: certificationScope(raw.certificationScope),
    status,
    failureOwner: failureOwner(raw.failureOwner),
    failureCode: nullableText(raw.failureCode),
    checkedAt,
    lastHealthyAt: typeof raw.lastHealthyAt === "number" && Number.isFinite(raw.lastHealthyAt)
      ? raw.lastHealthyAt
      : status === "HEALTHY" ? checkedAt : null,
  };
}

export function normalizeExtensionCompatibilityState(
  value: unknown,
  profileId: string,
): ExtensionCompatibilityState {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const records = Array.isArray(raw.records)
    ? raw.records
      .map((entry) => normalizeExtensionCompatibilityRecord(entry, profileId))
      .filter((entry): entry is ExtensionCompatibilityRecord => Boolean(entry))
    : [];
  const deduplicated = new Map(records.map((record) => [extensionCompatibilityIdentity(record), record]));
  const reports = Array.isArray(raw.reports)
    ? retainObservedCompatibilityReports(
      raw.reports
        .map((entry) => normalizeObservedCompatibilityReport(entry, profileId))
        .filter((entry): entry is ObservedCompatibilityReport => Boolean(entry)),
    )
    : [];
  return {
    schemaVersion: EXTENSION_COMPATIBILITY_SCHEMA_VERSION,
    profileId,
    records: [...deduplicated.values()].sort((left, right) => (
      left.packageName.localeCompare(right.packageName) || right.checkedAt - left.checkedAt
    )),
    reports,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
  };
}

export function upsertExtensionCompatibilityRecord(
  state: ExtensionCompatibilityState,
  record: ExtensionCompatibilityRecord,
): ExtensionCompatibilityState {
  const normalized = normalizeExtensionCompatibilityRecord(record, state.profileId);
  if (!normalized) throw new Error("Extension compatibility evidence is incomplete.");
  const identity = extensionCompatibilityIdentity(normalized);
  return {
    ...state,
    records: [
      ...state.records.filter((entry) => extensionCompatibilityIdentity(entry) !== identity),
      normalized,
    ].sort((left, right) => left.packageName.localeCompare(right.packageName) || right.checkedAt - left.checkedAt),
    updatedAt: Date.now(),
  };
}

function canUseTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadExtensionCompatibilityState(
  scope: ExtensionCompatibilityScope,
): Promise<ExtensionCompatibilityState> {
  const cached = memoryState.get(scope.profileId);
  if (cached) return cached;
  let parsed: unknown = null;
  if (canUseTauri()) {
    const contents = await invoke<string | null>("read_extension_compatibility_state", {
      profileId: scope.profileId,
      serverUrl: scope.serverUrl ?? null,
    });
    if (contents) {
      try { parsed = JSON.parse(contents); } catch { parsed = null; }
    }
  }
  const normalized = normalizeExtensionCompatibilityState(parsed, scope.profileId);
  memoryState.set(scope.profileId, normalized);
  return normalized;
}

export async function saveExtensionCompatibilityState(
  state: ExtensionCompatibilityState,
  scope: ExtensionCompatibilityScope,
): Promise<ExtensionCompatibilityState> {
  const normalized = normalizeExtensionCompatibilityState({ ...state, updatedAt: Date.now() }, scope.profileId);
  if (canUseTauri()) {
    await invoke("write_extension_compatibility_state", {
      contents: JSON.stringify(normalized, null, 2),
      profileId: scope.profileId,
      serverUrl: scope.serverUrl ?? null,
    });
  }
  memoryState.set(scope.profileId, normalized);
  return normalized;
}

export function resetExtensionCompatibilityStateCacheForTests(): void {
  memoryState.clear();
}
