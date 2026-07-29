import type { HardcoverBindingSlice } from "./hardcoverBinding";
import type { MigrationIdentitySlice } from "./identity";
import type { MangaTrackerBindingPlan } from "./trackerBindings";

export type MigrationContentKind = "manga" | "novel";
export type MigrationMode = "single" | "mass";
export type MigrationJournalStatus = "planned" | "applied" | "undone" | "failed" | "expired";
export type MigrationOperationStatus =
  | "planned"
  | "preparing"
  | "applying"
  | "verifying"
  | "committing"
  | "committed"
  | "cancellation_requested"
  | "compensating"
  | "compensated"
  | "rolling_back"
  | "rolled_back"
  | "recovery_pending"
  | "recovering"
  | "cancelled"
  | "needs_manual_recovery"
  | "corrupt";

export type MigrationStepKind =
  | "local"
  | "suwayomi"
  | "tracker"
  | "link"
  | "filesystem";

export type MigrationStepStatus =
  | "pending"
  | "applying"
  | "applied"
  | "verifying"
  | "verified"
  | "compensating"
  | "compensated"
  | "failed"
  | "skipped";

export interface MigratableLibraryItem {
  contentKind: MigrationContentKind;
  libraryItemId: string;
  sourceId: string;
  title: string;
  author: string | null;
  pathOrUrl: string;
  chapterCount: number | null;
  status: string | null;
}

export interface MigrationCandidate {
  contentKind: MigrationContentKind;
  sourceId: string;
  sourceName: string;
  score: number;
  reasonCode: string;
  requiresInstall: boolean;
}

export interface MigrationSession {
  contentKind: MigrationContentKind;
  mode: MigrationMode;
  sourceFrom: string;
  sourceTo: string;
  selectedItemIds: string[];
}

export interface NovelMigrationChapterSnapshot {
  id: string;
  novelId: string;
  path: string;
  title: string;
  order: number;
  releaseTime: number | null;
  unread: boolean;
  updatedAt?: number | null;
}

export interface NovelMigrationEntrySnapshot {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  coverUrl: string | null;
  path: string;
  status: string | null;
  tags: string[];
  chapterCount: number;
  addedAt: number;
  updatedAt: number;
  source: {
    repositoryUrl: string | null;
    repositoryName: string | null;
    pluginId: string | null;
    pluginName: string | null;
    pluginVersion: string | null;
    sourceId: string | null;
    sourceName: string | null;
    lang: string | null;
  } | null;
}

export interface NovelMigrationStateSlice {
  scopeKey: string;
  entry: NovelMigrationEntrySnapshot | null;
  chapters: NovelMigrationChapterSnapshot[];
  progress: Array<Record<string, unknown>>;
  bookmarks: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  localIdentity?: MigrationIdentitySlice;
  hardcoverBinding?: HardcoverBindingSlice;
}

export interface MangaMigrationChapterSnapshot {
  id: number;
  isRead: boolean;
  isBookmarked: boolean;
  lastPageRead: number | null;
}

export interface MangaMigrationStateSlice {
  mangaId: number;
  inLibrary: boolean;
  title: string;
  categoryIds: number[];
  chapters: MangaMigrationChapterSnapshot[];
  localIdentity?: MigrationIdentitySlice;
  trackerBindingPlan?: MangaTrackerBindingPlan;
}

export interface MigrationTransferSummary {
  oldItemTitle: string;
  newItemTitle: string;
  oldSourceId: string;
  newSourceId: string;
  transferredChapterCount: number;
  transferredReadCount: number;
  transferredBookmarkCount: number;
}

export interface MangaMigrationUndoPayload {
  oldState: MangaMigrationStateSlice;
  newState: MangaMigrationStateSlice;
}

export interface MangaMassMigrationUndoPayload {
  items: MangaMigrationUndoPayload[];
}

export interface NovelMigrationUndoPayload {
  oldState: NovelMigrationStateSlice;
  newState: NovelMigrationStateSlice;
}

export interface NovelMassMigrationUndoPayload {
  items: NovelMigrationUndoPayload[];
}

export interface MigrationJournalEntry {
  id: string;
  contentKind: MigrationContentKind;
  mode: MigrationMode;
  sourceFrom: string;
  sourceTo: string;
  createdAt: number;
  appliedAt: number | null;
  undoUntil: number | null;
  status: MigrationJournalStatus;
  transferSummary: MigrationTransferSummary;
  failureReason: string | null;
  payload: MangaMigrationUndoPayload | MangaMassMigrationUndoPayload | NovelMigrationUndoPayload | NovelMassMigrationUndoPayload;
}

export interface MigrationJournalStateV1 {
  version: 1;
  entries: MigrationJournalEntry[];
  updatedAtMs: number | null;
}

export interface MigrationStepRecord {
  stepId: string;
  kind: MigrationStepKind;
  status: MigrationStepStatus;
  attempt: number;
  startedAt: number | null;
  completedAt: number | null;
  failureCode: string | null;
}

export interface MigrationSnapshotManifest {
  oldStateSha256: string | null;
  newStateSha256: string | null;
  payload: MangaMigrationUndoPayload | MangaMassMigrationUndoPayload | NovelMigrationUndoPayload | NovelMassMigrationUndoPayload;
}

export type MigrationPayload =
  | MangaMigrationUndoPayload
  | MangaMassMigrationUndoPayload
  | NovelMigrationUndoPayload
  | NovelMassMigrationUndoPayload;

export interface MigrationOperationV2 {
  schemaVersion: 2;
  operationId: string;
  profileId: string;
  expectedRevision: string | null;
  revision: number;
  contentKind: MigrationContentKind;
  mode: MigrationMode;
  sourceFrom: string;
  sourceTo: string;
  createdAt: number;
  updatedAt: number;
  committedAt: number | null;
  undoUntil: number | null;
  status: MigrationOperationStatus;
  transferSummary: MigrationTransferSummary;
  failureReason: string | null;
  steps: MigrationStepRecord[];
  snapshots: MigrationSnapshotManifest;
}

export interface MigrationJournalState {
  version: 2;
  operations: MigrationOperationV2[];
  updatedAtMs: number | null;
}

export type PersistedMigrationJournalState = MigrationJournalStateV1 | MigrationJournalState;
