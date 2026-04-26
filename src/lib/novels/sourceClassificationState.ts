import { invoke } from "@tauri-apps/api/core";

import { normalizeLocalProfileId, normalizeServerUrl } from "../localProfiles";
import type { NovelRepositoryScopeInput } from "./repositoryState";
import type { NovelSourceClassificationStatus } from "./classificationModel";

const NOVEL_SOURCE_CLASSIFICATION_STATE_KEY = "aethon-novels-source-classification-state";
const NOVEL_SOURCE_CLASSIFICATION_STATE_VERSION = 1 as const;
const classificationStateCache = new Map<string, PersistedNovelSourceClassificationState>();

export type NovelSourceClassificationIssueCode =
  | "automatic-smoke-queued"
  | "no-bounded-smoke-recipe"
  | "anti-bot-redirect"
  | "charset-suspect"
  | "weak-metadata"
  | "unsupported-plugin-shape"
  | "runtime-helper-mismatch"
  | "search-returned-no-results"
  | "details-missing-title"
  | "chapter-empty"
  | "plugin-load-failed"
  | "search-failed"
  | "details-failed"
  | "chapter-failed";

export interface NovelSourceClassificationIssue {
  code: NovelSourceClassificationIssueCode;
  message: string;
  severity: "info" | "warning" | "error";
}

export interface PersistedNovelSourceClassificationSmoke {
  pluginLoadConfirmed: boolean;
  searchConfirmed: boolean;
  detailsConfirmed: boolean;
  chapterConfirmed: boolean;
}

export interface PersistedNovelSourceClassificationRecord {
  pluginId: string;
  repositoryId: string | null;
  repositoryUrl: string | null;
  lang: string | null;
  version: string | null;
  status: NovelSourceClassificationStatus;
  notes: string;
  baselineStatus: NovelSourceClassificationStatus | null;
  baselineNotes: string | null;
  issues: NovelSourceClassificationIssue[];
  smoke: PersistedNovelSourceClassificationSmoke;
  filterKeys: string[];
  pluginSettingsKeys: string[];
  classifiedAtMs: number;
}

export interface PersistedNovelSourceClassificationState {
  version: typeof NOVEL_SOURCE_CLASSIFICATION_STATE_VERSION;
  scopeKey: string;
  records: PersistedNovelSourceClassificationRecord[];
  updatedAtMs: number | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function storageOrNull(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function canUseDesktopStorage(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => Boolean(entry)))];
}

function normalizeScopeInput(input: NovelRepositoryScopeInput = {}): { profileId: string | null; serverUrl: string | null } {
  return {
    profileId: normalizeLocalProfileId(input.profileId),
    serverUrl: normalizeServerUrl(input.serverUrl),
  };
}

function resolveScopeKey(scopeInput: NovelRepositoryScopeInput = {}): string {
  const normalized = normalizeScopeInput(scopeInput);
  if (normalized.profileId) return `profile:${normalized.profileId}`;
  if (normalized.serverUrl) return `server:${encodeURIComponent(normalized.serverUrl)}`;
  return "profile:main";
}

function createEmptyState(scopeInput: NovelRepositoryScopeInput = {}): PersistedNovelSourceClassificationState {
  return {
    version: NOVEL_SOURCE_CLASSIFICATION_STATE_VERSION,
    scopeKey: resolveScopeKey(scopeInput),
    records: [],
    updatedAtMs: null,
  };
}

function normalizeIssue(value: unknown): NovelSourceClassificationIssue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const code = normalizeText(record.code) as NovelSourceClassificationIssueCode | null;
  const message = normalizeText(record.message);
  if (!code || !message) return null;
  return {
    code,
    message,
    severity: record.severity === "info" || record.severity === "error" ? record.severity : "warning",
  };
}

function normalizeRecord(value: unknown): PersistedNovelSourceClassificationRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const pluginId = normalizeText(record.pluginId);
  const status = normalizeText(record.status) as NovelSourceClassificationStatus | null;
  if (!pluginId || !status) return null;

  const smokeRecord = record.smoke && typeof record.smoke === "object"
    ? record.smoke as Record<string, unknown>
    : {};

  return {
    pluginId,
    repositoryId: normalizeText(record.repositoryId),
    repositoryUrl: normalizeText(record.repositoryUrl),
    lang: normalizeText(record.lang),
    version: normalizeText(record.version),
    status,
    notes: normalizeText(record.notes) ?? "Automatic classification has not completed yet.",
    baselineStatus: normalizeText(record.baselineStatus) as NovelSourceClassificationStatus | null,
    baselineNotes: normalizeText(record.baselineNotes),
    issues: Array.isArray(record.issues)
      ? record.issues.map((entry) => normalizeIssue(entry)).filter((entry): entry is NovelSourceClassificationIssue => Boolean(entry))
      : [],
    smoke: {
      pluginLoadConfirmed: smokeRecord.pluginLoadConfirmed === true,
      searchConfirmed: smokeRecord.searchConfirmed === true,
      detailsConfirmed: smokeRecord.detailsConfirmed === true,
      chapterConfirmed: smokeRecord.chapterConfirmed === true,
    },
    filterKeys: normalizeStringArray(record.filterKeys),
    pluginSettingsKeys: normalizeStringArray(record.pluginSettingsKeys),
    classifiedAtMs: typeof record.classifiedAtMs === "number" ? record.classifiedAtMs : Date.now(),
  };
}

export function normalizeNovelSourceClassificationState(
  value: unknown,
  scopeInput: NovelRepositoryScopeInput = {},
): PersistedNovelSourceClassificationState {
  if (!value || typeof value !== "object") {
    return createEmptyState(scopeInput);
  }

  const record = value as Record<string, unknown>;
  return {
    version: NOVEL_SOURCE_CLASSIFICATION_STATE_VERSION,
    scopeKey: normalizeText(record.scopeKey) ?? resolveScopeKey(scopeInput),
    records: Array.isArray(record.records)
      ? record.records.map((entry) => normalizeRecord(entry)).filter((entry): entry is PersistedNovelSourceClassificationRecord => Boolean(entry))
      : [],
    updatedAtMs: typeof record.updatedAtMs === "number" ? record.updatedAtMs : null,
  };
}

function readLegacyStateMap(storage = storageOrNull()): Record<string, PersistedNovelSourceClassificationState> {
  if (!storage) return {};
  const raw = storage.getItem(NOVEL_SOURCE_CLASSIFICATION_STATE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([scopeKey, state]) => [
        scopeKey,
        normalizeNovelSourceClassificationState(state, { profileId: null, serverUrl: null }),
      ]),
    );
  } catch {
    return {};
  }
}

function writeLegacyStateMap(next: Record<string, PersistedNovelSourceClassificationState>, storage = storageOrNull()) {
  if (!storage) return;
  storage.setItem(NOVEL_SOURCE_CLASSIFICATION_STATE_KEY, JSON.stringify(next));
}

function deleteLegacyScope(scopeKey: string, storage = storageOrNull()) {
  if (!storage) return;
  const next = readLegacyStateMap(storage);
  if (!(scopeKey in next)) return;
  delete next[scopeKey];
  if (Object.keys(next).length === 0) {
    storage.removeItem?.(NOVEL_SOURCE_CLASSIFICATION_STATE_KEY);
    return;
  }
  writeLegacyStateMap(next, storage);
}

function readLegacyState(scopeInput: NovelRepositoryScopeInput = {}): PersistedNovelSourceClassificationState | null {
  const scopeKey = resolveScopeKey(scopeInput);
  return readLegacyStateMap()[scopeKey] ?? null;
}

function persistCache(state: PersistedNovelSourceClassificationState): PersistedNovelSourceClassificationState {
  classificationStateCache.set(state.scopeKey, state);
  return state;
}

export function peekNovelSourceClassificationState(
  scopeInput: NovelRepositoryScopeInput = {},
): PersistedNovelSourceClassificationState {
  const scopeKey = resolveScopeKey(scopeInput);
  return classificationStateCache.get(scopeKey)
    ?? readLegacyState(scopeInput)
    ?? createEmptyState(scopeInput);
}

export function resetNovelSourceClassificationStateCacheForTests() {
  classificationStateCache.clear();
}

async function persistToDesktop(
  state: PersistedNovelSourceClassificationState,
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelSourceClassificationState> {
  const normalized = normalizeNovelSourceClassificationState({
    ...state,
    updatedAtMs: Date.now(),
  }, scopeInput);
  const scope = normalizeScopeInput(scopeInput);

  await invoke("write_novel_source_classification_state", {
    contents: JSON.stringify(normalized, null, 2),
    profileId: scope.profileId,
    serverUrl: scope.serverUrl,
  });

  deleteLegacyScope(normalized.scopeKey);
  return persistCache(normalized);
}

export async function loadNovelSourceClassificationState(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelSourceClassificationState> {
  const scopeKey = resolveScopeKey(scopeInput);
  const cached = classificationStateCache.get(scopeKey);
  if (cached) return cached;

  if (!canUseDesktopStorage()) {
    return persistCache(readLegacyState(scopeInput) ?? createEmptyState(scopeInput));
  }

  const scope = normalizeScopeInput(scopeInput);
  const raw = await invoke<string | null>("read_novel_source_classification_state", {
    profileId: scope.profileId,
    serverUrl: scope.serverUrl,
  });

  if (raw) {
    try {
      return persistCache(normalizeNovelSourceClassificationState(JSON.parse(raw), scopeInput));
    } catch {
      return persistCache(createEmptyState(scopeInput));
    }
  }

  const legacy = readLegacyState(scopeInput);
  if (legacy) {
    return persistToDesktop(legacy, scopeInput);
  }

  return persistCache(createEmptyState(scopeInput));
}

export async function reloadNovelSourceClassificationState(
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelSourceClassificationState> {
  const scopeKey = resolveScopeKey(scopeInput);
  classificationStateCache.delete(scopeKey);
  return loadNovelSourceClassificationState(scopeInput);
}

export async function saveNovelSourceClassificationState(
  state: PersistedNovelSourceClassificationState,
  scopeInput: NovelRepositoryScopeInput = {},
): Promise<PersistedNovelSourceClassificationState> {
  const normalized = normalizeNovelSourceClassificationState({
    ...state,
    updatedAtMs: Date.now(),
  }, scopeInput);

  if (!canUseDesktopStorage()) {
    const scopeKey = resolveScopeKey(scopeInput);
    const next = readLegacyStateMap();
    next[scopeKey] = normalized;
    writeLegacyStateMap(next);
    return persistCache(normalized);
  }

  return persistToDesktop(normalized, scopeInput);
}

export function getNovelSourceClassificationRecord(
  state: PersistedNovelSourceClassificationState,
  pluginId: string,
): PersistedNovelSourceClassificationRecord | null {
  return state.records.find((entry) => entry.pluginId === pluginId) ?? null;
}

export function upsertNovelSourceClassificationRecord(
  state: PersistedNovelSourceClassificationState,
  record: PersistedNovelSourceClassificationRecord,
): PersistedNovelSourceClassificationState {
  const withoutExisting = state.records.filter((entry) => entry.pluginId !== record.pluginId);
  return {
    ...state,
    records: [...withoutExisting, record].sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
    updatedAtMs: Date.now(),
  };
}

export function removeNovelSourceClassificationRecord(
  state: PersistedNovelSourceClassificationState,
  pluginId: string,
): PersistedNovelSourceClassificationState {
  return {
    ...state,
    records: state.records.filter((entry) => entry.pluginId !== pluginId),
    updatedAtMs: Date.now(),
  };
}

export function getNovelSourceClassificationBadge(
  record: PersistedNovelSourceClassificationRecord | null,
): {
  shortLabel: string;
  longLabel: string;
  tone: "success" | "info" | "warning" | "danger" | "muted";
} {
  switch (record?.status) {
    case "migration-safe":
      return {
        shortLabel: "Safe",
        longLabel: "Migration-safe",
        tone: "success",
      };
    case "working":
      return {
        shortLabel: "Working",
        longLabel: "Working",
        tone: "info",
      };
    case "working-with-known-limitations":
      return {
        shortLabel: "Partial",
        longLabel: "Working with limits",
        tone: "warning",
      };
    case "blocked-by-site":
      return {
        shortLabel: "Blocked",
        longLabel: "Blocked by site",
        tone: "danger",
      };
    case "runtime-gap":
      return {
        shortLabel: "Gap",
        longLabel: "Runtime gap",
        tone: "danger",
      };
    case "pending":
      return {
        shortLabel: "Pending",
        longLabel: "Pending smoke",
        tone: "muted",
      };
    default:
      return {
        shortLabel: "Pending",
        longLabel: "Pending smoke",
        tone: "muted",
      };
  }
}

export function getNovelSourceClassificationSummary(
  record: PersistedNovelSourceClassificationRecord | null,
): string | null {
  if (!record) return "Automatic source check is still pending.";
  const primaryIssue = record.issues[0]?.message ?? null;
  return primaryIssue ?? record.notes ?? null;
}

export function getNovelSourceClassificationDetailPresentation(
  record: PersistedNovelSourceClassificationRecord | null,
): {
  longLabel: string;
  summary: string;
  primaryReason: string | null;
  isTransient: boolean;
  canRetryCheck: boolean;
} {
  const badge = getNovelSourceClassificationBadge(record);
  const pendingSummary = "Automatic source check is still pending.";

  if (!record) {
    return {
      longLabel: badge.longLabel,
      summary: pendingSummary,
      primaryReason: null,
      isTransient: true,
      canRetryCheck: false,
    };
  }

  if (record.status === "pending") {
    return {
      longLabel: badge.longLabel,
      summary: pendingSummary,
      primaryReason: null,
      isTransient: true,
      canRetryCheck: true,
    };
  }

  const summary = record.notes?.trim() || getNovelSourceClassificationSummary(record) || pendingSummary;
  const primaryReason = record.issues[0]?.message ?? null;

  return {
    longLabel: badge.longLabel,
    summary,
    primaryReason: primaryReason === summary ? null : primaryReason,
    isTransient: false,
    canRetryCheck: record.status === "working-with-known-limitations"
      || record.status === "blocked-by-site"
      || record.status === "runtime-gap",
  };
}
