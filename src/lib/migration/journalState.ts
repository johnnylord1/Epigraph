import { invoke } from "@tauri-apps/api/core";

import type {
  MangaMassMigrationUndoPayload,
  MangaMigrationUndoPayload,
  MigrationContentKind,
  MigrationJournalEntry,
  MigrationJournalState,
  MigrationMode,
  MigrationTransferSummary,
  MigrationJournalStatus,
  NovelMassMigrationUndoPayload,
  NovelMigrationUndoPayload,
} from "./types";

const MIGRATION_JOURNAL_STORAGE_KEY = "aethon-migration-journal-state";
const MIGRATION_JOURNAL_STATE_VERSION = 1 as const;
const DEFAULT_UNDO_WINDOW_MS = 5 * 60 * 1000;
const MAX_JOURNAL_ENTRIES = 200;

let migrationJournalCache: MigrationJournalState | null = null;

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

function normalizeStatus(value: unknown): MigrationJournalStatus {
  if (value === "planned" || value === "applied" || value === "undone" || value === "failed" || value === "expired") {
    return value;
  }
  return "failed";
}

function normalizeMode(value: unknown): MigrationMode {
  return value === "mass" ? "mass" : "single";
}

function normalizeContentKind(value: unknown): MigrationContentKind {
  return value === "novel" ? "novel" : "manga";
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

function normalizePayload(
  contentKind: MigrationContentKind,
  value: unknown,
): MangaMigrationUndoPayload | MangaMassMigrationUndoPayload | NovelMigrationUndoPayload | NovelMassMigrationUndoPayload {
  const payload = value && typeof value === "object" ? value : {};
  if (contentKind === "novel") {
    return clonePayload(payload as NovelMigrationUndoPayload | NovelMassMigrationUndoPayload);
  }
  return clonePayload(payload as MangaMigrationUndoPayload);
}

function normalizeEntry(value: unknown): MigrationJournalEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = normalizeText(record.id);
  if (!id) return null;

  const contentKind = normalizeContentKind(record.contentKind);
  const status = normalizeStatus(record.status);
  const undoUntil = typeof record.undoUntil === "number" ? record.undoUntil : null;
  const resolvedStatus = status === "applied" && undoUntil !== null && Date.now() > undoUntil
    ? "expired"
    : status;

  return {
    id,
    contentKind,
    mode: normalizeMode(record.mode),
    sourceFrom: normalizeText(record.sourceFrom) ?? "unknown",
    sourceTo: normalizeText(record.sourceTo) ?? "unknown",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    appliedAt: typeof record.appliedAt === "number" ? record.appliedAt : null,
    undoUntil,
    status: resolvedStatus,
    transferSummary: normalizeTransferSummary(record.transferSummary),
    failureReason: normalizeText(record.failureReason),
    payload: normalizePayload(contentKind, record.payload),
  };
}

function createEmptyState(): MigrationJournalState {
  return {
    version: MIGRATION_JOURNAL_STATE_VERSION,
    entries: [],
    updatedAtMs: null,
  };
}

function normalizeMigrationJournalState(value: unknown): MigrationJournalState {
  if (!value || typeof value !== "object") {
    return createEmptyState();
  }

  const record = value as Record<string, unknown>;
  const entries = Array.isArray(record.entries)
    ? record.entries
      .map((entry) => normalizeEntry(entry))
      .filter((entry): entry is MigrationJournalEntry => Boolean(entry))
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_JOURNAL_ENTRIES)
    : [];

  return {
    version: MIGRATION_JOURNAL_STATE_VERSION,
    entries,
    updatedAtMs: typeof record.updatedAtMs === "number" ? record.updatedAtMs : null,
  };
}

function persistCache(state: MigrationJournalState): MigrationJournalState {
  migrationJournalCache = state;
  return state;
}

export function resetMigrationJournalStateCacheForTests() {
  migrationJournalCache = null;
}

export function buildMigrationJournalEntry(input: {
  contentKind: MigrationContentKind;
  mode?: MigrationMode;
  sourceFrom: string;
  sourceTo: string;
  transferSummary: MigrationTransferSummary;
  payload: MangaMigrationUndoPayload | NovelMigrationUndoPayload | MangaMassMigrationUndoPayload | NovelMassMigrationUndoPayload;
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

async function persistJournalStateToDesktop(state: MigrationJournalState): Promise<MigrationJournalState> {
  const normalized = normalizeMigrationJournalState({
    ...state,
    updatedAtMs: Date.now(),
  });
  await invoke("write_migration_journal_state", {
    contents: JSON.stringify(normalized, null, 2),
  });
  return persistCache(normalized);
}

export async function loadMigrationJournalState(): Promise<MigrationJournalState> {
  if (migrationJournalCache) return migrationJournalCache;

  if (!canUseDesktopMigrationStorage()) {
    const storage = storageOrNull();
    const raw = storage?.getItem(MIGRATION_JOURNAL_STORAGE_KEY);
    if (!raw) return persistCache(createEmptyState());
    try {
      return persistCache(normalizeMigrationJournalState(JSON.parse(raw)));
    } catch {
      return persistCache(createEmptyState());
    }
  }

  const raw = await invoke<string | null>("read_migration_journal_state").catch(() => null);
  if (!raw) {
    return persistCache(createEmptyState());
  }

  try {
    return persistCache(normalizeMigrationJournalState(JSON.parse(raw)));
  } catch {
    return persistCache(createEmptyState());
  }
}

export async function saveMigrationJournalState(state: MigrationJournalState): Promise<MigrationJournalState> {
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

export async function appendMigrationJournalEntry(entry: MigrationJournalEntry): Promise<MigrationJournalState> {
  const current = await loadMigrationJournalState();
  return saveMigrationJournalState({
    ...current,
    entries: [entry, ...current.entries.filter((currentEntry) => currentEntry.id !== entry.id)]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_JOURNAL_ENTRIES),
  });
}

export async function updateMigrationJournalEntry(
  entryId: string,
  patch: Partial<MigrationJournalEntry>,
): Promise<MigrationJournalState> {
  const current = await loadMigrationJournalState();
  return saveMigrationJournalState({
    ...current,
    entries: current.entries.map((entry) => (
      entry.id === entryId
        ? normalizeEntry({ ...entry, ...patch }) ?? entry
        : entry
    )),
  });
}

export async function markMigrationJournalEntryUndone(entryId: string): Promise<MigrationJournalState> {
  return updateMigrationJournalEntry(entryId, {
    status: "undone",
    undoUntil: null,
  });
}

export async function markMigrationJournalEntryFailed(entryId: string, reason: string): Promise<MigrationJournalState> {
  return updateMigrationJournalEntry(entryId, {
    status: "failed",
    failureReason: reason,
    undoUntil: null,
  });
}

export async function getMigrationJournalEntry(entryId: string): Promise<MigrationJournalEntry | null> {
  const current = await loadMigrationJournalState();
  return current.entries.find((entry) => entry.id === entryId) ?? null;
}
