import JSZip from "jszip";
import {
  EPIGRAPH_BACKUP_PAYLOAD_REGISTRY,
  inspectEpigraphBackupContainer,
  type EpigraphBackupIssue,
  type EpigraphBackupManifest,
  type EpigraphBackupManifestPayloadEntry,
  type EpigraphBackupPayloadManifest,
} from "./epigraphBackup";
import { EPIGRAPH_MANGA_PAYLOAD_FILE_PATH } from "./mangaBackup";
import { EPIGRAPH_APP_PAYLOAD_FILE_PATH } from "./appBackup";
import {
  EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH,
  classifyEpigraphNovelsSnapshot,
  normalizeEpigraphNovelsSnapshot,
  type EpigraphNovelRuntimeState,
  type EpigraphNovelsExportMode,
  type EpigraphNovelsSnapshot,
} from "./novelsBackup";
import { analyzeBackupReconciliation } from "../reconciliation/analyze";
import { buildRestoreReadiness } from "../reconciliation/readiness";
import { normalizeLocalProfileId, type LocalProfileId } from "../localProfiles";
import type {
  AvailableExtensionEntry,
  OverlayFile,
  ParsedBackup,
  ReconciliationAnalysis,
  RestoreReadinessSummary,
  SourceInventoryEntry,
} from "../reconciliation/types";
import type { Tracker } from "../types";

const BOOKS_LIBRARY_FILE_PATH = "library.json";
const BOOKS_PROGRESS_FILE_PATH = "progress.json";
const BOOKS_BOOKMARKS_FILE_PATH = "bookmarks.json";
const BOOKS_CATEGORIES_FILE_PATH = "categories.json";

type EpigraphRestoreDefaultTarget = "sandbox-profile";

export type EpigraphRestorePayloadStatus = "restorable" | "blocked" | "unsupported" | "warning-only" | "skipped";
export type EpigraphRestoreReasonCode =
  | "unsupported-container-version"
  | "unsupported-payload-kind"
  | "unsupported-payload-version"
  | "missing-runtime-support"
  | "missing-required-repository"
  | "missing-required-plugin"
  | "missing-required-source"
  | "metadata-only-limitation"
  | "manga-needs-review"
  | "manga-requires-install"
  | "manga-unavailable-source"
  | "manga-unresolved-source"
  | "optional-payload-omitted"
  | "payload-not-selected"
  | "missing-required-file"
  | "payload-integrity-error"
  | "portable-metadata-only"
  | "non-blocking-warning";

export interface EpigraphRestoreReason {
  code: EpigraphRestoreReasonCode;
  message: string;
}

export interface EpigraphPayloadRestorePlan {
  kind: string;
  present: boolean;
  selectedByDefault: boolean;
  status: EpigraphRestorePayloadStatus;
  canRestoreNow: boolean;
  needsUserAction: boolean;
  canExecuteRestore: boolean;
  defaultRestoreMode: string | null;
  availableRestoreModes: string[];
  summaryLabel: string;
  reasons: EpigraphRestoreReason[];
  warnings: EpigraphRestoreReason[];
  metadata: Record<string, unknown>;
}

export interface EpigraphTopLevelSkippedRestorePlan {
  kind: string;
  status: "skipped";
  reason: EpigraphRestoreReasonCode;
  summaryLabel: string;
  canRestoreNow: false;
  needsUserAction: false;
}

export interface EpigraphRestorePlanSummary {
  restorableKinds: string[];
  blockedKinds: string[];
  unsupportedKinds: string[];
  warningOnlyKinds: string[];
  skippedKinds: string[];
  recommendedSelection: string[];
  summaryLabel: string;
  summaryBody: string;
}

export interface EpigraphRestorePlan {
  defaultTarget: EpigraphRestoreDefaultTarget;
  canProceedWithRecommendedSelection: boolean;
  hasBlockedPayloads: boolean;
  hasUnsupportedPayloads: boolean;
  executionBlockedReason: string | null;
  payloads: EpigraphPayloadRestorePlan[];
  topLevelSkipped: EpigraphTopLevelSkippedRestorePlan[];
  recommendedSelection: string[];
  summary: EpigraphRestorePlanSummary;
  containerIssues: EpigraphRestoreReason[];
  manifest: EpigraphBackupManifest | null;
}

export interface EpigraphRestorePlannerRuntime {
  activeProfileId?: LocalProfileId | null;
  manga?: {
    supported?: boolean;
    repositoryUrls?: string[];
    inventory: SourceInventoryEntry[];
    availableExtensions: AvailableExtensionEntry[];
    trackers: Tracker[];
    overlay: OverlayFile;
  };
  books?: {
    supported?: boolean;
  };
  novels?: (EpigraphNovelRuntimeState & {
    supported?: boolean;
  });
  app?: {
    supported?: boolean;
  };
}

export interface EpigraphRestorePlannerDeps {
  analyzeManga?: (input: {
    payloadBytes: Uint8Array;
    runtime: NonNullable<EpigraphRestorePlannerRuntime["manga"]>;
  }) => Promise<{
    parsedBackup: ParsedBackup;
    analysis: ReconciliationAnalysis;
    readiness: RestoreReadinessSummary;
  }>;
}

interface PortableBookRecord {
  id: string;
  title?: string | null;
  assetArchivePath?: string | null;
  coverArchivePath?: string | null;
}

interface BooksLibraryFile {
  version: 1;
  books: PortableBookRecord[];
}

interface BooksProgressFile {
  version: 1;
  progress: unknown[];
}

interface BooksBookmarksFile {
  version: 1;
  bookmarks: unknown[];
}

interface BooksCategoriesFile {
  version: 1;
  categories: unknown[];
  assignments: Record<string, string[]>;
  ui?: unknown;
}

interface NovelsPayloadFile {
  version: 1;
  exportMode: EpigraphNovelsExportMode;
  entries: EpigraphNovelsSnapshot["entries"];
  chapters: EpigraphNovelsSnapshot["chapters"];
  progress: EpigraphNovelsSnapshot["progress"];
  bookmarks: EpigraphNovelsSnapshot["bookmarks"];
  history: EpigraphNovelsSnapshot["history"];
  repositories: EpigraphNovelsSnapshot["repositories"];
  plugins: EpigraphNovelsSnapshot["plugins"];
}

interface EpigraphAppProfilePayload {
  version: 1;
  defaultLocalProfileId: LocalProfileId;
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function normalizeArchiveRelativePath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("Backup payload file path cannot be empty.");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Backup payload file path is unsafe: ${raw}`);
  }
  return parts.join("/");
}

function isFatalContainerIssue(issue: EpigraphBackupIssue): boolean {
  return issue.code === "missing-manifest"
    || issue.code === "invalid-manifest"
    || issue.code === "missing-checksums"
    || issue.code === "invalid-checksums"
    || issue.code === "unsupported-container-version";
}

function toReason(code: EpigraphRestoreReasonCode, message: string): EpigraphRestoreReason {
  return { code, message };
}

function flagsForStatus(status: EpigraphRestorePayloadStatus): {
  selectedByDefault: boolean;
  canRestoreNow: boolean;
  needsUserAction: boolean;
} {
  switch (status) {
    case "restorable":
      return { selectedByDefault: true, canRestoreNow: true, needsUserAction: false };
    case "warning-only":
      return { selectedByDefault: true, canRestoreNow: true, needsUserAction: false };
    case "blocked":
      return { selectedByDefault: false, canRestoreNow: false, needsUserAction: true };
    case "unsupported":
      return { selectedByDefault: false, canRestoreNow: false, needsUserAction: false };
    default:
      return { selectedByDefault: false, canRestoreNow: false, needsUserAction: false };
  }
}

function canExecuteRestoreForPayloadKind(kind: string): boolean {
  return kind === "manga" || kind === "books" || kind === "novels" || kind === "app";
}

function defaultRestoreModeForPayload(
  payloadEntry: EpigraphBackupManifestPayloadEntry,
  payloadManifest: EpigraphBackupPayloadManifest | null,
): string | null {
  const available = payloadManifest?.restoreModesSupported ?? payloadEntry.restoreModesSupported ?? [];
  const exportMode = payloadManifest?.exportMode ?? payloadEntry.exportMode ?? null;
  if (exportMode && available.includes(exportMode)) {
    return exportMode;
  }
  return available[0] ?? exportMode ?? null;
}

function finalizePayloadPlan(
  input: Omit<
    EpigraphPayloadRestorePlan,
    "selectedByDefault" | "canRestoreNow" | "needsUserAction" | "canExecuteRestore"
  >,
): EpigraphPayloadRestorePlan {
  const flags = flagsForStatus(input.status);
  return {
    ...input,
    selectedByDefault: flags.selectedByDefault,
    canRestoreNow: flags.canRestoreNow,
    needsUserAction: flags.needsUserAction,
    canExecuteRestore: canExecuteRestoreForPayloadKind(input.kind),
  };
}

function topLevelSkippedAppPayload(): EpigraphTopLevelSkippedRestorePlan {
  return {
    kind: "app",
    status: "skipped",
    reason: "optional-payload-omitted",
    summaryLabel: "App payload omitted",
    canRestoreNow: false,
    needsUserAction: false,
  };
}

function reasonFromIssue(issue: EpigraphBackupIssue): EpigraphRestoreReason {
  switch (issue.code) {
    case "unsupported-payload-version":
      return toReason("unsupported-payload-version", issue.message);
    case "missing-payload-file":
      return toReason("missing-required-file", issue.message);
    case "checksum-missing":
    case "checksum-mismatch":
    case "invalid-payload-manifest":
    case "missing-payload-manifest":
    case "invalid-checksums":
      return toReason("payload-integrity-error", issue.message);
    case "unknown-payload-kind":
      return toReason("unsupported-payload-kind", issue.message);
    case "unsupported-container-version":
      return toReason("unsupported-container-version", issue.message);
    default:
      return toReason("payload-integrity-error", issue.message);
  }
}

function payloadIssuesForEntry(
  entry: EpigraphBackupManifestPayloadEntry,
  issues: EpigraphBackupIssue[],
): EpigraphBackupIssue[] {
  return issues.filter((issue) =>
    issue.payloadKind === entry.kind
      || issue.path === entry.manifestPath
      || (typeof issue.path === "string" && issue.path.startsWith(`${entry.payloadRoot}/`))
  );
}

async function readArchiveText(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async("text");
}

async function readArchiveBytes(zip: JSZip, path: string): Promise<Uint8Array | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  return entry.async("uint8array");
}

async function readArchiveJson<T>(zip: JSZip, path: string): Promise<T | null> {
  const text = await readArchiveText(zip, path);
  if (text == null) return null;
  return JSON.parse(text) as T;
}

async function defaultAnalyzeManga(input: {
  payloadBytes: Uint8Array;
  runtime: NonNullable<EpigraphRestorePlannerRuntime["manga"]>;
}): Promise<{
  parsedBackup: ParsedBackup;
  analysis: ReconciliationAnalysis;
  readiness: RestoreReadinessSummary;
}> {
  const parsed = await analyzeBackupReconciliation(
    input.payloadBytes,
    input.runtime.inventory,
    input.runtime.trackers,
    input.runtime.overlay,
  );
  const readiness = buildRestoreReadiness(
    parsed.analysis,
    {},
    input.runtime.inventory,
    input.runtime.availableExtensions,
  );
  return {
    parsedBackup: parsed.parsedBackup,
    analysis: parsed.analysis,
    readiness,
  };
}

export async function planEpigraphMangaRestore(
  bytes: Uint8Array | ArrayBuffer,
  zip: JSZip,
  payloadEntry: EpigraphBackupManifestPayloadEntry,
  payloadManifest: EpigraphBackupPayloadManifest,
  runtime: EpigraphRestorePlannerRuntime,
  deps: EpigraphRestorePlannerDeps = {},
): Promise<EpigraphPayloadRestorePlan> {
  void bytes;
  const availableRestoreModes = payloadManifest.restoreModesSupported ?? payloadEntry.restoreModesSupported ?? [];
  const defaultRestoreMode = defaultRestoreModeForPayload(payloadEntry, payloadManifest);
  const mangaRuntime = runtime.manga;

  if (!mangaRuntime || mangaRuntime.supported === false) {
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Manga runtime support is unavailable",
      reasons: [toReason("missing-runtime-support", "This backup needs the Suwayomi manga runtime to plan restore readiness.")],
      warnings: [],
      metadata: {},
    });
  }

  const archivePath = `${payloadEntry.payloadRoot}/${EPIGRAPH_MANGA_PAYLOAD_FILE_PATH}`;
  const payloadBytes = await readArchiveBytes(zip, archivePath);
  if (!payloadBytes) {
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Manga payload is missing its embedded backup file",
      reasons: [toReason("missing-required-file", `Manga payload is missing ${EPIGRAPH_MANGA_PAYLOAD_FILE_PATH}.`)],
      warnings: [],
      metadata: {},
    });
  }

  const analyze = deps.analyzeManga ?? defaultAnalyzeManga;
  const { parsedBackup, analysis, readiness } = await analyze({
    payloadBytes,
    runtime: mangaRuntime,
  });

  const baseMetadata = {
    mangaCount: parsedBackup.backupManga.length,
    sourceCount: parsedBackup.backupSources.length,
    trackerCount: parsedBackup.trackerIds.length,
    exactMatches: analysis.exactMatches.length,
    autoReconciled: analysis.autoReconciled.length,
    needsReview: analysis.needsReview.length,
    unresolved: analysis.unresolved.length,
    warningsCount: analysis.warnings.length,
  };

  const currentRepositories = new Set(
    (mangaRuntime.repositoryUrls ?? []).map((value) => value.trim().replace(/\/+$/, "")),
  );
  const missingRepositories = (payloadManifest.requiresRepositories ?? [])
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter((value) => value && !currentRepositories.has(value));
  if (missingRepositories.length > 0) {
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "warning-only",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Review missing extension repositories",
      reasons: [],
      warnings: [toReason("missing-required-repository", `${missingRepositories.length} extension repositor${missingRepositories.length === 1 ? "y is" : "ies are"} missing. Review and approve repositories in dependency setup.`)],
      metadata: { ...baseMetadata, missingRepositories },
    });
  }

  if (analysis.needsReview.length > 0) {
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "warning-only",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Original manga sources will be preserved",
      reasons: [],
      warnings: [toReason("manga-needs-review", `${analysis.needsReview.length} source cluster${analysis.needsReview.length === 1 ? "" : "s"} will keep their original source IDs unless you choose a replacement.`)],
      metadata: baseMetadata,
    });
  }

  if (readiness.requiresInstallCount > 0) {
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "warning-only",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Review required manga extensions",
      reasons: [],
      warnings: [toReason("manga-requires-install", `${readiness.requiresInstallCount} source extension${readiness.requiresInstallCount === 1 ? " needs" : "s need"} installation before the source can be used. Review and approve installation in dependency setup.`)],
      metadata: {
        ...baseMetadata,
        installableExtensions: readiness.installableExtensions.map((extension) => extension.pkgName),
      },
    });
  }

  if (readiness.unavailableCount > 0) {
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "warning-only",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Unavailable manga sources will be preserved",
      reasons: [],
      warnings: [toReason("manga-unavailable-source", `${readiness.unavailableCount} unavailable source${readiness.unavailableCount === 1 ? "" : "s"} will be preserved with their titles and reading data.`)],
      metadata: baseMetadata,
    });
  }

  if (analysis.unresolved.length > 0 || readiness.unresolvedCount > 0) {
    const unresolvedCount = Math.max(analysis.unresolved.length, readiness.unresolvedCount);
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "warning-only",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Manga restore can proceed with unresolved leftovers",
      reasons: [],
      warnings: [toReason("manga-unresolved-source", `${unresolvedCount} source cluster${unresolvedCount === 1 ? "" : "s"} remain unresolved and will be preserved as-is.`)],
      metadata: baseMetadata,
    });
  }

  if (analysis.warnings.length > 0) {
    return finalizePayloadPlan({
      kind: "manga",
      present: true,
      status: "warning-only",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Manga restore can proceed with non-blocking warnings",
      reasons: [],
      warnings: analysis.warnings.map((warning) => toReason("non-blocking-warning", warning.message)),
      metadata: baseMetadata,
    });
  }

  return finalizePayloadPlan({
    kind: "manga",
    present: true,
    status: "restorable",
    defaultRestoreMode,
    availableRestoreModes,
    summaryLabel: "Manga payload is ready for sandbox restore",
    reasons: [],
    warnings: [],
    metadata: baseMetadata,
  });
}

export async function planEpigraphBooksRestore(
  zip: JSZip,
  payloadEntry: EpigraphBackupManifestPayloadEntry,
  payloadManifest: EpigraphBackupPayloadManifest,
  runtime: EpigraphRestorePlannerRuntime,
  payloadIssues: EpigraphBackupIssue[],
): Promise<EpigraphPayloadRestorePlan> {
  const availableRestoreModes = payloadManifest.restoreModesSupported ?? payloadEntry.restoreModesSupported ?? [];
  const defaultRestoreMode = defaultRestoreModeForPayload(payloadEntry, payloadManifest);

  if (runtime.books?.supported === false) {
    return finalizePayloadPlan({
      kind: "books",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Books runtime support is unavailable",
      reasons: [toReason("missing-runtime-support", "This backup needs the Books runtime to inspect restore readiness.")],
      warnings: [],
      metadata: {},
    });
  }

  if (payloadIssues.some((issue) => issue.code === "unsupported-payload-version")) {
    return finalizePayloadPlan({
      kind: "books",
      present: true,
      status: "unsupported",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Books payload version is unsupported",
      reasons: payloadIssues.filter((issue) => issue.code === "unsupported-payload-version").map(reasonFromIssue),
      warnings: [],
      metadata: {},
    });
  }

  const root = payloadEntry.payloadRoot;
  let library: BooksLibraryFile | null = null;
  let progress: BooksProgressFile | null = null;
  let bookmarks: BooksBookmarksFile | null = null;
  let categories: BooksCategoriesFile | null = null;

  try {
    library = await readArchiveJson<BooksLibraryFile>(zip, `${root}/${BOOKS_LIBRARY_FILE_PATH}`);
    progress = await readArchiveJson<BooksProgressFile>(zip, `${root}/${BOOKS_PROGRESS_FILE_PATH}`);
    bookmarks = await readArchiveJson<BooksBookmarksFile>(zip, `${root}/${BOOKS_BOOKMARKS_FILE_PATH}`);
    categories = await readArchiveJson<BooksCategoriesFile>(zip, `${root}/${BOOKS_CATEGORIES_FILE_PATH}`);
  } catch (error) {
    return finalizePayloadPlan({
      kind: "books",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Books payload could not be parsed",
      reasons: [toReason("payload-integrity-error", error instanceof Error ? error.message : "Books payload JSON is invalid.")],
      warnings: [],
      metadata: {},
    });
  }

  if (!library) {
    return finalizePayloadPlan({
      kind: "books",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Books payload is missing library data",
      reasons: [toReason("missing-required-file", "Books payload is missing library.json.")],
      warnings: [],
      metadata: {},
    });
  }

  if (!progress) {
    return finalizePayloadPlan({
      kind: "books",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Books payload is missing progress data",
      reasons: [toReason("missing-required-file", "Books payload is missing progress.json.")],
      warnings: [],
      metadata: {},
    });
  }

  if (!bookmarks) {
    return finalizePayloadPlan({
      kind: "books",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Books payload is missing bookmark data",
      reasons: [toReason("missing-required-file", "Books payload is missing bookmarks.json.")],
      warnings: [],
      metadata: {},
    });
  }

  const exportMode = payloadManifest.exportMode === "metadata-only" ? "metadata-only" : "full";
  const missingCoverOnly = payloadIssues.length > 0 && payloadIssues.every((issue) =>
    issue.code === "missing-payload-file"
      && typeof issue.path === "string"
      && issue.path.startsWith(`${root}/covers/`)
  );
  const blockingIntegrityIssues = payloadIssues.filter((issue) =>
    issue.level === "error" && !(missingCoverOnly && issue.code === "missing-payload-file")
  );

  if (blockingIntegrityIssues.length > 0) {
    return finalizePayloadPlan({
      kind: "books",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Books payload is missing required packaged files",
      reasons: blockingIntegrityIssues.map(reasonFromIssue),
      warnings: [],
      metadata: {
        exportMode,
        bookCount: Array.isArray(library.books) ? library.books.length : 0,
        progressCount: Array.isArray(progress.progress) ? progress.progress.length : 0,
        bookmarkCount: Array.isArray(bookmarks.bookmarks) ? bookmarks.bookmarks.length : 0,
      },
    });
  }

  const warnings: EpigraphRestoreReason[] = [];
  if (missingCoverOnly) {
    warnings.push(...payloadIssues.map((issue) => toReason("non-blocking-warning", issue.message)));
  }
  if (exportMode === "metadata-only") {
    warnings.push(toReason("metadata-only-limitation", "Books metadata-only export preserves metadata and progress, but not packaged EPUB/PDF files."));
  }

  return finalizePayloadPlan({
    kind: "books",
    present: true,
    status: warnings.length > 0 ? "warning-only" : "restorable",
    defaultRestoreMode,
    availableRestoreModes,
    summaryLabel: warnings.length > 0
      ? "Books payload can restore with warnings"
      : "Books payload is ready for sandbox restore",
    reasons: [],
    warnings,
    metadata: {
      exportMode,
      bookCount: Array.isArray(library.books) ? library.books.length : 0,
      progressCount: Array.isArray(progress.progress) ? progress.progress.length : 0,
      bookmarkCount: Array.isArray(bookmarks.bookmarks) ? bookmarks.bookmarks.length : 0,
      categoryCount: Array.isArray(categories?.categories) ? categories.categories.length : 0,
    },
  });
}

export async function planEpigraphNovelsRestore(
  zip: JSZip,
  payloadEntry: EpigraphBackupManifestPayloadEntry,
  payloadManifest: EpigraphBackupPayloadManifest,
  runtime: EpigraphRestorePlannerRuntime,
  payloadIssues: EpigraphBackupIssue[],
): Promise<EpigraphPayloadRestorePlan> {
  const availableRestoreModes = payloadManifest.restoreModesSupported ?? payloadEntry.restoreModesSupported ?? [];
  const defaultRestoreMode = defaultRestoreModeForPayload(payloadEntry, payloadManifest);
  const novelsRuntime = runtime.novels;

  if (!novelsRuntime || novelsRuntime.supported === false) {
    return finalizePayloadPlan({
      kind: "novels",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Novels runtime support is unavailable",
      reasons: [toReason("missing-runtime-support", "This backup needs the novels runtime to inspect repository and plugin requirements.")],
      warnings: [],
      metadata: {},
    });
  }

  if (payloadIssues.some((issue) => issue.code === "unsupported-payload-version")) {
    return finalizePayloadPlan({
      kind: "novels",
      present: true,
      status: "unsupported",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Novels payload version is unsupported",
      reasons: payloadIssues.filter((issue) => issue.code === "unsupported-payload-version").map(reasonFromIssue),
      warnings: [],
      metadata: {},
    });
  }

  const rawPayload = await readArchiveJson<NovelsPayloadFile>(
    zip,
    `${payloadEntry.payloadRoot}/${EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH}`,
  ).catch(() => null);

  if (!rawPayload) {
    return finalizePayloadPlan({
      kind: "novels",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Novels payload is missing its library data",
      reasons: [toReason("missing-required-file", `Novels payload is missing ${EPIGRAPH_NOVELS_PAYLOAD_FILE_PATH}.`)],
      warnings: [],
      metadata: {},
    });
  }

  if (rawPayload.version !== 1 || !Array.isArray(rawPayload.entries)) {
    return finalizePayloadPlan({
      kind: "novels",
      present: true,
      status: "unsupported",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "Novels payload schema is unsupported",
      reasons: [toReason("unsupported-payload-version", "Novels payload schema version is unsupported.")],
      warnings: [],
      metadata: {},
    });
  }

  const exportMode = rawPayload.exportMode === "metadata-only" ? "metadata-only" : "repository-aware";
  const classified = classifyEpigraphNovelsSnapshot(
    normalizeEpigraphNovelsSnapshot({
      entries: rawPayload.entries,
      chapters: Array.isArray(rawPayload.chapters) ? rawPayload.chapters : [],
      progress: Array.isArray(rawPayload.progress) ? rawPayload.progress : [],
      bookmarks: Array.isArray(rawPayload.bookmarks) ? rawPayload.bookmarks : [],
      history: Array.isArray(rawPayload.history) ? rawPayload.history : [],
      repositories: Array.isArray(rawPayload.repositories) ? rawPayload.repositories : [],
      plugins: Array.isArray(rawPayload.plugins) ? rawPayload.plugins : [],
    }),
    exportMode,
    {
      repositoryUrls: novelsRuntime.repositoryUrls,
      installedPluginIds: novelsRuntime.installedPluginIds,
      availableSourceIds: novelsRuntime.availableSourceIds,
    },
  );

  const dependencyReasons: EpigraphRestoreReason[] = [];
  if (classified.summary.restoredNeedsRepositoryCount > 0) {
    dependencyReasons.push(toReason("missing-required-repository", `${classified.summary.restoredNeedsRepositoryCount} novel entr${classified.summary.restoredNeedsRepositoryCount === 1 ? "y needs" : "ies need"} a repository. Add and review it in Sources before restoring.`));
  }
  if (classified.issues.some((issue) => issue.code === "missing-required-plugin")) {
    const count = classified.issues.filter((issue) => issue.code === "missing-required-plugin").length;
    dependencyReasons.push(toReason("missing-required-plugin", `${count} novel entr${count === 1 ? "y needs" : "ies need"} a plugin. Install or enable it in Sources before restoring.`));
  }
  if (classified.issues.some((issue) => issue.code === "missing-required-source")) {
    const count = classified.issues.filter((issue) => issue.code === "missing-required-source").length;
    dependencyReasons.push(toReason("missing-required-source", `${count} novel entr${count === 1 ? "y needs" : "ies need"} an available provider plugin. Review it in Sources before restoring.`));
  }

  const warnings: EpigraphRestoreReason[] = [];
  if (classified.summary.restoredMetadataOnlyCount > 0) {
    warnings.push(toReason("metadata-only-limitation", `${classified.summary.restoredMetadataOnlyCount} novel entr${classified.summary.restoredMetadataOnlyCount === 1 ? "y" : "ies"} will restore as metadata-only.`));
  }

  const status: EpigraphRestorePayloadStatus = dependencyReasons.length > 0 ? "blocked" : warnings.length > 0
      ? "warning-only"
      : "restorable";

  return finalizePayloadPlan({
    kind: "novels",
    present: true,
    status,
    defaultRestoreMode,
    availableRestoreModes,
    summaryLabel: status === "blocked" ? "Resolve Novel dependencies in Sources before restoring"
        : status === "warning-only" ? "Novels payload can restore with metadata-only warnings"
        : "Novels payload is ready for sandbox restore",
    reasons: dependencyReasons,
    warnings,
    metadata: {
      exportMode,
      entryCount: classified.summary.totalEntries,
      chapterCount: Array.isArray(rawPayload.chapters) ? rawPayload.chapters.length : 0,
      restoredUsableCount: classified.summary.restoredUsableCount,
      restoredNeedsRepositoryCount: classified.summary.restoredNeedsRepositoryCount,
      restoredNeedsPluginCount: classified.summary.restoredNeedsPluginCount,
      restoredMetadataOnlyCount: classified.summary.restoredMetadataOnlyCount,
    },
  });
}

export async function planEpigraphAppRestore(
  zip: JSZip,
  payloadEntry: EpigraphBackupManifestPayloadEntry,
  payloadManifest: EpigraphBackupPayloadManifest,
  runtime: EpigraphRestorePlannerRuntime,
  payloadIssues: EpigraphBackupIssue[],
): Promise<EpigraphPayloadRestorePlan> {
  const availableRestoreModes = payloadManifest.restoreModesSupported ?? payloadEntry.restoreModesSupported ?? [];
  const defaultRestoreMode = defaultRestoreModeForPayload(payloadEntry, payloadManifest);

  if (runtime.app?.supported === false) {
    return finalizePayloadPlan({
      kind: "app",
      present: true,
      status: "blocked",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "App metadata support is unavailable",
      reasons: [toReason("missing-runtime-support", "This backup needs Epigraph app metadata support to inspect the app payload.")],
      warnings: [],
      metadata: {},
    });
  }

  if (payloadIssues.some((issue) => issue.code === "unsupported-payload-version")) {
    return finalizePayloadPlan({
      kind: "app",
      present: true,
      status: "unsupported",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "App payload version is unsupported",
      reasons: payloadIssues.filter((issue) => issue.code === "unsupported-payload-version").map(reasonFromIssue),
      warnings: [],
      metadata: {},
    });
  }

  const rawPayload = await readArchiveJson<EpigraphAppProfilePayload>(
    zip,
    `${payloadEntry.payloadRoot}/${EPIGRAPH_APP_PAYLOAD_FILE_PATH}`,
  ).catch(() => null);

  if (!rawPayload) {
    return finalizePayloadPlan({
      kind: "app",
      present: true,
      status: "unsupported",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "App payload is missing its profile metadata",
      reasons: [toReason("missing-required-file", `App payload is missing ${EPIGRAPH_APP_PAYLOAD_FILE_PATH}.`)],
      warnings: [],
      metadata: {},
    });
  }

  const defaultLocalProfileId = normalizeLocalProfileId(rawPayload.defaultLocalProfileId);
  if ((rawPayload.version !== 1 && rawPayload.version !== 2) || !defaultLocalProfileId) {
    return finalizePayloadPlan({
      kind: "app",
      present: true,
      status: "unsupported",
      defaultRestoreMode,
      availableRestoreModes,
      summaryLabel: "App payload schema is unsupported",
      reasons: [toReason("unsupported-payload-version", "App payload schema version is unsupported or invalid.")],
      warnings: [],
      metadata: {},
    });
  }

  return finalizePayloadPlan({
    kind: "app",
    present: true,
    status: "warning-only",
    defaultRestoreMode,
    availableRestoreModes,
    summaryLabel: rawPayload.version >= 2
      ? "App payload contains portable profile metadata and reading state"
      : "App payload contains portable profile metadata",
    reasons: [],
    warnings: [toReason(
      "portable-metadata-only",
      rawPayload.version >= 2
        ? "App payload restores portable profile metadata and reading state into the current session."
        : "App payload restores portable profile metadata into the current session.",
    )],
    metadata: {
      defaultLocalProfileId,
      version: rawPayload.version,
    },
  });
}

function makeUnsupportedPayloadPlan(
  payloadEntry: EpigraphBackupManifestPayloadEntry,
  issues: EpigraphBackupIssue[],
): EpigraphPayloadRestorePlan {
  return finalizePayloadPlan({
    kind: payloadEntry.kind,
    present: true,
    status: "unsupported",
    defaultRestoreMode: payloadEntry.exportMode ?? null,
    availableRestoreModes: payloadEntry.restoreModesSupported ?? [],
    summaryLabel: `Payload "${payloadEntry.kind}" is not supported by this planner`,
    reasons: issues.length > 0
      ? issues.map(reasonFromIssue)
      : [toReason("unsupported-payload-kind", `Payload kind "${payloadEntry.kind}" is not supported by this planner.`)],
    warnings: [],
    metadata: {},
  });
}

function summarizePlan(
  payloads: EpigraphPayloadRestorePlan[],
  topLevelSkipped: EpigraphTopLevelSkippedRestorePlan[],
  containerIssues: EpigraphRestoreReason[],
): EpigraphRestorePlanSummary {
  const restorableKinds = payloads.filter((payload) => payload.status === "restorable").map((payload) => payload.kind);
  const blockedKinds = payloads.filter((payload) => payload.status === "blocked").map((payload) => payload.kind);
  const unsupportedKinds = payloads.filter((payload) => payload.status === "unsupported").map((payload) => payload.kind);
  const warningOnlyKinds = payloads.filter((payload) => payload.status === "warning-only").map((payload) => payload.kind);
  const skippedKinds = topLevelSkipped.map((payload) => payload.kind);
  const recommendedSelection = payloads.filter((payload) => payload.selectedByDefault).map((payload) => payload.kind);

  if (containerIssues.length > 0 && payloads.length === 0) {
    return {
      restorableKinds,
      blockedKinds,
      unsupportedKinds,
      warningOnlyKinds,
      skippedKinds,
      recommendedSelection,
      summaryLabel: "Backup cannot be planned safely",
      summaryBody: containerIssues.map((issue) => issue.message).join(" "),
    };
  }

  const parts = [
    recommendedSelection.length > 0
      ? `${recommendedSelection.length} payload${recommendedSelection.length === 1 ? "" : "s"} selected for sandbox restore`
      : "No payloads are selected for restore",
  ];
  if (blockedKinds.length > 0) parts.push(`${blockedKinds.length} blocked`);
  if (unsupportedKinds.length > 0) parts.push(`${unsupportedKinds.length} unsupported`);
  if (warningOnlyKinds.length > 0) parts.push(`${warningOnlyKinds.length} with warnings`);
  if (skippedKinds.length > 0) parts.push(`${skippedKinds.length} skipped`);

  return {
    restorableKinds,
    blockedKinds,
    unsupportedKinds,
    warningOnlyKinds,
    skippedKinds,
    recommendedSelection,
    summaryLabel: parts.join(" • "),
    summaryBody: recommendedSelection.length > 0
      ? "Sandbox profile is the default target. Blocked and unsupported payloads are excluded from the recommended restore set."
      : "Sandbox profile remains the default target, but nothing can be restored safely from the recommended selection yet.",
  };
}

export async function buildEpigraphRestorePlan(
  bytes: Uint8Array | ArrayBuffer,
  runtime: EpigraphRestorePlannerRuntime,
  _options: Record<string, never> = {},
  deps: EpigraphRestorePlannerDeps = {},
): Promise<EpigraphRestorePlan> {
  let inspection;
  try {
    inspection = await inspectEpigraphBackupContainer(bytes);
  } catch (error) {
    const containerIssues = [
      toReason("payload-integrity-error", error instanceof Error ? error.message : "Epigraph backup container could not be inspected."),
    ];
    return {
      defaultTarget: "sandbox-profile",
      canProceedWithRecommendedSelection: false,
      hasBlockedPayloads: false,
      hasUnsupportedPayloads: false,
      executionBlockedReason: null,
      payloads: [],
      topLevelSkipped: [],
      recommendedSelection: [],
      summary: summarizePlan([], [], containerIssues),
      containerIssues,
      manifest: null,
    };
  }

  const containerIssues = inspection.issues.filter(isFatalContainerIssue).map(reasonFromIssue);
  if (!inspection.manifest || containerIssues.length > 0) {
    return {
      defaultTarget: "sandbox-profile",
      canProceedWithRecommendedSelection: false,
      hasBlockedPayloads: false,
      hasUnsupportedPayloads: false,
      executionBlockedReason: null,
      payloads: [],
      topLevelSkipped: [],
      recommendedSelection: [],
      summary: summarizePlan([], [], containerIssues),
      containerIssues,
      manifest: inspection.manifest,
    };
  }

  const zip = await JSZip.loadAsync(toUint8Array(bytes));
  const payloads: EpigraphPayloadRestorePlan[] = [];

  for (const payloadEntry of inspection.manifest.payloads) {
    const payloadManifest = inspection.payloadManifests[payloadEntry.kind] ?? null;
    const payloadIssues = payloadIssuesForEntry(payloadEntry, inspection.issues);
    const registry = (EPIGRAPH_BACKUP_PAYLOAD_REGISTRY as Record<string, typeof EPIGRAPH_BACKUP_PAYLOAD_REGISTRY.books | undefined>)[payloadEntry.kind];

    if (!registry) {
      payloads.push(makeUnsupportedPayloadPlan(payloadEntry, payloadIssues));
      continue;
    }

    if (!payloadManifest) {
      payloads.push(finalizePayloadPlan({
        kind: payloadEntry.kind,
        present: true,
        status: "blocked",
        defaultRestoreMode: payloadEntry.exportMode ?? null,
        availableRestoreModes: payloadEntry.restoreModesSupported ?? [],
        summaryLabel: `${registry.label} payload manifest is missing`,
        reasons: payloadIssues.length > 0
          ? payloadIssues.map(reasonFromIssue)
          : [toReason("missing-required-file", `Payload manifest is missing for "${payloadEntry.kind}".`)],
        warnings: [],
        metadata: {},
      }));
      continue;
    }

    const versionUnsupported = payloadIssues.some((issue) => issue.code === "unsupported-payload-version");
    const integrityIssues = payloadIssues.filter((issue) => issue.level === "error");

    if (payloadEntry.kind === "manga") {
      if (versionUnsupported) {
        payloads.push(finalizePayloadPlan({
          kind: "manga",
          present: true,
          status: "unsupported",
          defaultRestoreMode: defaultRestoreModeForPayload(payloadEntry, payloadManifest),
          availableRestoreModes: payloadManifest.restoreModesSupported ?? [],
          summaryLabel: "Manga payload version is unsupported",
          reasons: payloadIssues.filter((issue) => issue.code === "unsupported-payload-version").map(reasonFromIssue),
          warnings: [],
          metadata: {},
        }));
        continue;
      }
      if (integrityIssues.length > 0) {
        payloads.push(finalizePayloadPlan({
          kind: "manga",
          present: true,
          status: "blocked",
          defaultRestoreMode: defaultRestoreModeForPayload(payloadEntry, payloadManifest),
          availableRestoreModes: payloadManifest.restoreModesSupported ?? [],
          summaryLabel: "Manga payload is missing required files",
          reasons: integrityIssues.map(reasonFromIssue),
          warnings: [],
          metadata: {},
        }));
        continue;
      }
      payloads.push(await planEpigraphMangaRestore(bytes, zip, payloadEntry, payloadManifest, runtime, deps));
      continue;
    }

    if (payloadEntry.kind === "books") {
      payloads.push(await planEpigraphBooksRestore(zip, payloadEntry, payloadManifest, runtime, payloadIssues));
      continue;
    }

    if (payloadEntry.kind === "novels") {
      payloads.push(await planEpigraphNovelsRestore(zip, payloadEntry, payloadManifest, runtime, payloadIssues));
      continue;
    }

    if (payloadEntry.kind === "app") {
      payloads.push(await planEpigraphAppRestore(zip, payloadEntry, payloadManifest, runtime, payloadIssues));
      continue;
    }
  }

  const topLevelSkipped = inspection.manifest.payloads.some((payload) => payload.kind === "app")
    ? []
    : [topLevelSkippedAppPayload()];
  const recommendedSelection = payloads.filter((payload) => payload.selectedByDefault).map((payload) => payload.kind);
  const summary = summarizePlan(payloads, topLevelSkipped, []);
  const executionBlockedReason = runtime.activeProfileId == null
    ? "Restore execution is available only when the current session is running on the built-in TEST or MAIN local profiles."
    : null;

  return {
    defaultTarget: "sandbox-profile",
    canProceedWithRecommendedSelection: recommendedSelection.length > 0 && executionBlockedReason == null,
    hasBlockedPayloads: payloads.some((payload) => payload.status === "blocked"),
    hasUnsupportedPayloads: payloads.some((payload) => payload.status === "unsupported"),
    executionBlockedReason,
    payloads,
    topLevelSkipped,
    recommendedSelection,
    summary,
    containerIssues: [],
    manifest: inspection.manifest,
  };
}
