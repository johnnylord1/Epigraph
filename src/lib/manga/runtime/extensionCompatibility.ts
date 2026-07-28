import { invoke } from "@tauri-apps/api/core";

export const EXTENSION_COMPATIBILITY_SCHEMA_VERSION = 1 as const;

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
  return {
    schemaVersion: EXTENSION_COMPATIBILITY_SCHEMA_VERSION,
    profileId,
    records: [...deduplicated.values()].sort((left, right) => (
      left.packageName.localeCompare(right.packageName) || right.checkedAt - left.checkedAt
    )),
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
