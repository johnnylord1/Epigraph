import { invoke } from "@tauri-apps/api/core";

import type {
  MangaMassMigrationUndoPayload,
  MangaMigrationUndoPayload,
  MigrationContentKind,
  MigrationJournalEntry,
  MigrationJournalState,
  MigrationMode,
  MigrationOperationStatus,
  MigrationOperationV2,
  MigrationSnapshotManifest,
  MigrationStepRecord,
  MigrationTransferSummary,
  NovelMassMigrationUndoPayload,
  NovelMigrationUndoPayload,
  PersistedMigrationJournalState,
} from "./types";

const MIGRATION_JOURNAL_STORAGE_KEY = "aethon-migration-journal-state";
const MIGRATION_JOURNAL_STATE_VERSION = 2 as const;
const DEFAULT_UNDO_WINDOW_MS = 5 * 60 * 1000;
const MAX_JOURNAL_OPERATIONS = 200;

type MigrationPayload =
  | MangaMigrationUndoPayload
  | MangaMassMigrationUndoPayload
  | NovelMigrationUndoPayload
  | NovelMassMigrationUndoPayload;

let migrationJournalCache: MigrationJournalState | null = null;
let migrationJournalPersistedSha256: string | null = null;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storageOrNull(): StorageLike | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

function canUseDesktopMigrationStorage(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeMode(value: unknown): MigrationMode {
  return value === "mass" ? "mass" : "single";
}

function normalizeContentKind(value: unknown): MigrationContentKind {
  return value === "novel" ? "novel" : "manga";
}

function normalizeOperationStatus(value: unknown): MigrationOperationStatus {
  switch (value) {
    case "planned":
    case "preparing":
    case "applying":
    case "verifying":
    case "committing":
    case "committed":
    case "cancellation_requested":
    case "compensating":
    case "compensated":
    case "rolling_back":
    case "rolled_back":
    case "recovery_pending":
    case "recovering":
    case "cancelled":
    case "needs_manual_recovery":
    case "corrupt":
      return value;
    default:
      return "corrupt";
  }
}

function normalizeTransferSummary(value: unknown): MigrationTransferSummary {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    oldItemTitle: normalizeText(record.oldItemTitle) ?? "Unknown item",
    newItemTitle: normalizeText(record.newItemTitle) ?? "Unknown item",
    oldSourceId: normalizeText(record.oldSourceId) ?? "unknown",
    newSourceId: normalizeText(record.newSourceId) ?? "unknown",
    transferredChapterCount: typeof record.transferredChapterCount === "number" ? record.transferredChapterCount : 0,
    transferredReadCount: typeof record.transferredReadCount === "number" ? record.transferredReadCount : 0,
    transferredBookmarkCount: typeof record.transferredBookmarkCount === "number" ? record.transferredBookmarkCount : 0,
  };
}

function clonePayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePayload(value: unknown): MigrationPayload {
  const payload = value && typeof value === "object" ? value : {};
  return clonePayload(payload as MigrationPayload);
}

function normalizeSteps(value: unknown): { steps: MigrationStepRecord[]; invalid: boolean } {
  if (value === undefined) return { steps: [], invalid: false };
  if (!Array.isArray(value)) return { steps: [], invalid: true };
  let invalid = false;
  const steps = value.flatMap((item): MigrationStepRecord[] => {
    if (!item || typeof item !== "object") {
      invalid = true;
      return [];
    }
    const record = item as Record<string, unknown>;
    const stepId = normalizeText(record.stepId);
    const kind = record.kind;
    const status = record.status;
    if (
      !stepId
      || !["local", "suwayomi", "tracker", "link", "filesystem"].includes(String(kind))
      || !["pending", "applying", "applied", "verifying", "verified", "compensating", "compensated", "failed", "skipped"].includes(String(status))
    ) {
      invalid = true;
      return [];
    }
    return [{
      stepId,
      kind: kind as MigrationStepRecord["kind"],
      status: status as MigrationStepRecord["status"],
      attempt: typeof record.attempt === "number" ? Math.max(0, Math.trunc(record.attempt)) : 0,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
      completedAt: typeof record.completedAt === "number" ? record.completedAt : null,
      failureCode: normalizeText(record.failureCode),
    }];
  });
  return { steps, invalid };
}

function normalizeSnapshots(value: unknown): MigrationSnapshotManifest {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    oldStateSha256: normalizeText(record.oldStateSha256),
    newStateSha256: normalizeText(record.newStateSha256),
    payload: normalizePayload(record.payload),
  };
}

function normalizeOperation(value: unknown): MigrationOperationV2 | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const operationId = normalizeText(record.operationId);
  if (!operationId) return null;
  const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
  const normalizedSteps = normalizeSteps(record.steps);
  const status = normalizedSteps.invalid ? "corrupt" : normalizeOperationStatus(record.status);
  return {
    schemaVersion: 2,
    operationId,
    profileId: normalizeText(record.profileId) ?? "main",
    expectedRevision: normalizeText(record.expectedRevision),
    revision: typeof record.revision === "number" ? Math.max(1, Math.trunc(record.revision)) : 1,
    contentKind: normalizeContentKind(record.contentKind),
    mode: normalizeMode(record.mode),
    sourceFrom: normalizeText(record.sourceFrom) ?? "unknown",
    sourceTo: normalizeText(record.sourceTo) ?? "unknown",
    createdAt,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : createdAt,
    committedAt: typeof record.committedAt === "number" ? record.committedAt : null,
    undoUntil: typeof record.undoUntil === "number" ? record.undoUntil : null,
    status,
    transferSummary: normalizeTransferSummary(record.transferSummary),
    failureReason: normalizedSteps.invalid
      ? normalizeText(record.failureReason) ?? "Migration operation contains invalid step records."
      : normalizeText(record.failureReason),
    steps: normalizedSteps.steps,
    snapshots: normalizeSnapshots(record.snapshots),
  };
}

function legacyStatusToOperationStatus(status: MigrationJournalEntry["status"]): MigrationOperationStatus {
  switch (status) {
    case "planned":
      return "planned";
    case "applied":
    case "expired":
      return "committed";
    case "undone":
      return "compensated";
    case "failed":
      return "needs_manual_recovery";
  }
}

function operationStatusToLegacyStatus(operation: MigrationOperationV2): MigrationJournalEntry["status"] {
  if (operation.status === "committed") {
    return operation.undoUntil !== null && Date.now() > operation.undoUntil ? "expired" : "applied";
  }
  if (operation.status === "compensated" || operation.status === "rolled_back") return "undone";
  if (
    operation.status === "needs_manual_recovery"
    || operation.status === "corrupt"
  ) {
    return "failed";
  }
  return "planned";
}

function legacyEntryToOperation(entry: MigrationJournalEntry): MigrationOperationV2 {
  return {
    schemaVersion: 2,
    operationId: entry.id,
    profileId: "main",
    expectedRevision: null,
    revision: 1,
    contentKind: entry.contentKind,
    mode: entry.mode,
    sourceFrom: entry.sourceFrom,
    sourceTo: entry.sourceTo,
    createdAt: entry.createdAt,
    updatedAt: entry.appliedAt ?? entry.createdAt,
    committedAt: entry.appliedAt,
    undoUntil: entry.undoUntil,
    status: legacyStatusToOperationStatus(entry.status),
    transferSummary: clonePayload(entry.transferSummary),
    failureReason: entry.failureReason,
    steps: [],
    snapshots: {
      oldStateSha256: null,
      newStateSha256: null,
      payload: clonePayload(entry.payload),
    },
  };
}

function operationToLegacyEntry(operation: MigrationOperationV2): MigrationJournalEntry {
  return {
    id: operation.operationId,
    contentKind: operation.contentKind,
    mode: operation.mode,
    sourceFrom: operation.sourceFrom,
    sourceTo: operation.sourceTo,
    createdAt: operation.createdAt,
    appliedAt: operation.committedAt,
    undoUntil: operation.undoUntil,
    status: operationStatusToLegacyStatus(operation),
    transferSummary: clonePayload(operation.transferSummary),
    failureReason: operation.failureReason,
    payload: clonePayload(operation.snapshots.payload),
  };
}

function normalizeLegacyEntry(value: unknown): MigrationJournalEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = normalizeText(record.id);
  if (!id) return null;
  const rawStatus = record.status;
  const status = rawStatus === "planned"
    || rawStatus === "applied"
    || rawStatus === "undone"
    || rawStatus === "failed"
    || rawStatus === "expired"
    ? rawStatus
    : "failed";
  return {
    id,
    contentKind: normalizeContentKind(record.contentKind),
    mode: normalizeMode(record.mode),
    sourceFrom: normalizeText(record.sourceFrom) ?? "unknown",
    sourceTo: normalizeText(record.sourceTo) ?? "unknown",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    appliedAt: typeof record.appliedAt === "number" ? record.appliedAt : null,
    undoUntil: typeof record.undoUntil === "number" ? record.undoUntil : null,
    status,
    transferSummary: normalizeTransferSummary(record.transferSummary),
    failureReason: normalizeText(record.failureReason),
    payload: normalizePayload(record.payload),
  };
}

function createEmptyState(): MigrationJournalState {
  return {
    version: MIGRATION_JOURNAL_STATE_VERSION,
    operations: [],
    updatedAtMs: null,
  };
}

function normalizeMigrationJournalState(value: unknown): MigrationJournalState {
  if (!value || typeof value !== "object") {
    throw new Error("Migration journal is corrupt: expected an object.");
  }
  const record = value as Record<string, unknown>;
  let operations: MigrationOperationV2[];
  if (record.version === 1) {
    operations = Array.isArray(record.entries)
      ? record.entries
        .map(normalizeLegacyEntry)
        .filter((entry): entry is MigrationJournalEntry => Boolean(entry))
        .map(legacyEntryToOperation)
      : [];
  } else if (record.version === 2) {
    operations = Array.isArray(record.operations)
      ? record.operations
        .map(normalizeOperation)
        .filter((operation): operation is MigrationOperationV2 => Boolean(operation))
      : [];
  } else {
    throw new Error(`Migration journal schema version ${String(record.version)} is unsupported.`);
  }

  return {
    version: MIGRATION_JOURNAL_STATE_VERSION,
    operations: operations
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_JOURNAL_OPERATIONS),
    updatedAtMs: typeof record.updatedAtMs === "number" ? record.updatedAtMs : null,
  };
}

function persistCache(state: MigrationJournalState): MigrationJournalState {
  migrationJournalCache = state;
  return state;
}

export function resetMigrationJournalStateCacheForTests() {
  migrationJournalCache = null;
  migrationJournalPersistedSha256 = null;
}

export function buildMigrationJournalEntry(input: {
  contentKind: MigrationContentKind;
  mode?: MigrationMode;
  sourceFrom: string;
  sourceTo: string;
  transferSummary: MigrationTransferSummary;
  payload: MigrationPayload;
  undoWindowMs?: number;
}): MigrationJournalEntry {
  const createdAt = Date.now();
  const undoWindowMs = input.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS;
  return {
    id: `migration-${createdAt}-${Math.random().toString(36).slice(2, 9)}`,
    contentKind: input.contentKind,
    mode: input.mode ?? "single",
    sourceFrom: input.sourceFrom,
    sourceTo: input.sourceTo,
    createdAt,
    appliedAt: createdAt,
    undoUntil: createdAt + undoWindowMs,
    status: "applied",
    transferSummary: clonePayload(input.transferSummary),
    failureReason: null,
    payload: clonePayload(input.payload),
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function persistJournalStateToDesktop(state: MigrationJournalState): Promise<MigrationJournalState> {
  const normalized = normalizeMigrationJournalState({
    ...state,
    updatedAtMs: Date.now(),
  });
  const contents = JSON.stringify(normalized, null, 2);
  await invoke("write_migration_journal_state", {
    contents,
    expectedSha256: migrationJournalPersistedSha256,
  });
  migrationJournalPersistedSha256 = await sha256Text(contents);
  return persistCache(normalized);
}

export async function loadMigrationJournalState(): Promise<MigrationJournalState> {
  if (migrationJournalCache) return migrationJournalCache;

  if (!canUseDesktopMigrationStorage()) {
    const raw = storageOrNull()?.getItem(MIGRATION_JOURNAL_STORAGE_KEY);
    if (!raw) return persistCache(createEmptyState());
    return persistCache(normalizeMigrationJournalState(JSON.parse(raw)));
  }

  const raw = await invoke<string | null>("read_migration_journal_state");
  if (!raw) return persistCache(createEmptyState());
  migrationJournalPersistedSha256 = await sha256Text(raw);
  return persistCache(normalizeMigrationJournalState(JSON.parse(raw)));
}

export async function saveMigrationJournalState(
  state: PersistedMigrationJournalState,
): Promise<MigrationJournalState> {
  const normalized = normalizeMigrationJournalState({
    ...state,
    updatedAtMs: Date.now(),
  });

  if (!canUseDesktopMigrationStorage()) {
    storageOrNull()?.setItem(MIGRATION_JOURNAL_STORAGE_KEY, JSON.stringify(normalized));
    return persistCache(normalized);
  }

  return persistJournalStateToDesktop(normalized);
}

export async function appendMigrationOperation(
  operation: MigrationOperationV2,
): Promise<MigrationJournalState> {
  const current = await loadMigrationJournalState();
  return saveMigrationJournalState({
    ...current,
    operations: [
      operation,
      ...current.operations.filter((currentOperation) => currentOperation.operationId !== operation.operationId),
    ],
  });
}

export async function updateMigrationOperation(
  operationId: string,
  patch: Partial<Omit<MigrationOperationV2, "operationId" | "schemaVersion">>,
  expectedRevision?: number,
): Promise<MigrationJournalState> {
  const current = await loadMigrationJournalState();
  let found = false;
  const operations = current.operations.map((operation) => {
    if (operation.operationId !== operationId) return operation;
    found = true;
    if (expectedRevision !== undefined && operation.revision !== expectedRevision) {
      throw new Error(
        `Migration operation ${operationId} revision changed from ${expectedRevision} to ${operation.revision}.`,
      );
    }
    return normalizeOperation({
      ...operation,
      ...patch,
      schemaVersion: 2,
      operationId,
      revision: operation.revision + 1,
      updatedAt: Date.now(),
    }) ?? operation;
  });
  if (!found) throw new Error(`Migration operation ${operationId} was not found.`);
  return saveMigrationJournalState({ ...current, operations });
}

export async function getMigrationOperation(operationId: string): Promise<MigrationOperationV2 | null> {
  const current = await loadMigrationJournalState();
  return current.operations.find((operation) => operation.operationId === operationId) ?? null;
}

export async function appendMigrationJournalEntry(entry: MigrationJournalEntry): Promise<MigrationJournalState> {
  return appendMigrationOperation(legacyEntryToOperation(entry));
}

export async function updateMigrationJournalEntry(
  entryId: string,
  patch: Partial<MigrationJournalEntry>,
): Promise<MigrationJournalState> {
  const operation = await getMigrationOperation(entryId);
  if (!operation) throw new Error(`Migration operation ${entryId} was not found.`);
  const currentEntry = operationToLegacyEntry(operation);
  const nextEntry = normalizeLegacyEntry({ ...currentEntry, ...patch }) ?? currentEntry;
  return updateMigrationOperation(entryId, {
    contentKind: nextEntry.contentKind,
    mode: nextEntry.mode,
    sourceFrom: nextEntry.sourceFrom,
    sourceTo: nextEntry.sourceTo,
    committedAt: nextEntry.appliedAt,
    undoUntil: nextEntry.undoUntil,
    status: legacyStatusToOperationStatus(nextEntry.status),
    transferSummary: nextEntry.transferSummary,
    failureReason: nextEntry.failureReason,
    snapshots: {
      ...operation.snapshots,
      payload: nextEntry.payload,
    },
  });
}

export async function markMigrationJournalEntryUndone(entryId: string): Promise<MigrationJournalState> {
  return updateMigrationOperation(entryId, {
    status: "compensated",
    undoUntil: null,
  });
}

export async function markMigrationJournalEntryFailed(entryId: string, reason: string): Promise<MigrationJournalState> {
  return updateMigrationOperation(entryId, {
    status: "needs_manual_recovery",
    failureReason: reason,
    undoUntil: null,
  });
}

export async function getMigrationJournalEntry(entryId: string): Promise<MigrationJournalEntry | null> {
  const operation = await getMigrationOperation(entryId);
  return operation ? operationToLegacyEntry(operation) : null;
}
