import { translate } from "./runtime";

type Translate = typeof translate;
// Presentation only: preserve domain codes and raw diagnostics in the original
// outcome. Unknown/native text must never become the primary translated message.
const messages: Record<string, string> = {};
function register(key: string, codes: string[]) { for (const code of codes) messages[code] = key; }
register("outcomes.targetChanged", ["RESTORE_TARGET_CHANGED", "RESTORE_SOURCE_CHANGED", "PROFILE_CHANGED"]);
register("outcomes.uncertain", ["SUBMISSION_UNCERTAIN", "BACKEND_STATUS_UNKNOWN", "STATUS_EXPIRED", "OBSERVATION_TIMEOUT", "BACKEND_GENERATION_MISMATCH", "RESTORE_REQUIRES_RESUME", "RESTORE_EXTERNAL_UNRESOLVED", "RESTORE_REQUIRES_RECONCILIATION", "unknown"]);
register("outcomes.dependencies", ["RESTORE_WAITING_FOR_DEPENDENCIES", "RESTORE_NOT_READY", "missing-required-repository", "missing-required-plugin", "missing-required-source", "manga-requires-install"]);
register("outcomes.conflict", ["RESTORE_CONFLICT", "RESTORE_SESSION_UNAVAILABLE", "RESTORE_CHOICES_FROZEN", "RESTORE_PLAN_FROZEN"]);
register("outcomes.invalidBackup", ["RESTORE_INPUT_INVALID", "RESTORE_INPUT_CHANGED", "INVALID_INPUT", "payload-integrity-error", "missing-required-file", "invalid-novels-payload", "missing-novels-payload", "invalid-novel-identity", "invalid-chapter-identity", "missing-manifest", "invalid-manifest", "missing-checksums", "invalid-checksums", "invalid-payload-manifest", "missing-payload-manifest", "missing-payload-file", "checksum-missing", "checksum-mismatch"]);
register("outcomes.corruptState", ["JOURNAL_CONFLICT", "JOURNAL_CHECKSUM_MISMATCH", "INVALID_JOURNAL", "RESTORE_HISTORY_UNAVAILABLE", "RESTORE_HISTORY_CONFLICT", "RESTORE_JOURNAL_INVALID", "RESTORE_DESTINATION_CORRUPT", "RESTORE_BOOKS_DESTINATION_CORRUPT", "JOURNAL_CORRUPT"]);
register("outcomes.unsupported", ["unsupported-payload-version", "unsupported-container-version", "unsupported-payload-kind", "RESTORE_DOMAIN_UNSUPPORTED", "RUNTIME_INCOMPATIBLE"]);
register("outcomes.runtimeUnavailable", ["RUNTIME_UNAVAILABLE", "missing-runtime-support", "NotConfigured"]);
register("outcomes.network", ["NETWORK_FAILURE", "SOURCE_OFFLINE", "RATE_LIMITED"]);
register("outcomes.authentication", ["AUTHENTICATION_REQUIRED", "ANTIBOT_CHALLENGE"]);
register("outcomes.readerBusy", ["RESTORE_BOOK_READER_ACTIVE", "RESTORE_READER_ACTIVE", "RESTORE_REFUSED_READER_NOT_FLUSHED", "READER_PREPARATION_TIMEOUT", "READER_PREPARATION_FAILED"]);
register("outcomes.failed", ["BACKEND_RESTORE_FAILURE", "RESTORE_PREPARATION_FAILED", "RESTORE_FAILED", "failed"]);
register("restoreDeps.conflict", ["plugin-origin-conflict", "plugin-ambiguous", "RESTORE_EXTENSION_ORIGIN_CHANGED"]);
register("restoreDeps.missing", ["plugin-not-found"]);
register("outcomes.approval", ["approval-required", "RESTORE_REPOSITORY_NOT_REQUESTED"]);
register("firstRun.sources.refreshError", ["repository-refresh-failed", "repo_lookup_failed"]);
register("firstRun.sources.installError", ["plugin-install-failed"]);
register("outcomes.preservedSources", ["inference_timeout", "cluster_inference_failed", "manga-needs-review", "manga-unavailable-source", "manga-unresolved-source"]);
register("outcomes.metadataOnly", ["NOVEL_METADATA_ONLY", "metadata-only-novel", "metadata-only-limitation", "portable-metadata-only"]);
register("outcomes.readingStateAbsent", ["APP_BACKUP_HAS_NO_READING_STATE"]);
register("outcomes.refreshFailed", ["MANGA_RESTORED_LOCAL_REFRESH_FAILED"]);
register("outcomes.categories", ["invalid-category", "unresolved-category-novel", "RESTORE_NOVEL_CATEGORIES_UNRESOLVED"]);
register("outcomes.skipped", ["optional-payload-omitted", "payload-not-selected", "skipped"]);
register("outcomes.statePreserved", ["CURRENT_STATE_PRESERVED"]);
register("outcomes.warning", ["NOVEL_IDENTITY_AMBIGUOUS", "DESTINATION_ID_COLLISION", "CHAPTER_IDENTITY_AMBIGUOUS", "CHAPTER_REFERENCE_UNRESOLVED", "LOCATOR_REMAP_UNSUPPORTED"]);
register("outcomes.cancelled", ["cancelled", "RESTORE_CANCELLED"]);
register("outcomes.succeeded", ["succeeded", "success"]);

register("outcomes.uncertain", ["RESTORE_UNRESOLVED", "BACKEND_GENERATION_CHANGED", "BACKEND_STATUS_MISSING", "BACKEND_STATUS_UNRECOGNIZED", "RESTORE_DEADLINE", "RESTORE_GRAPHQL_RESPONSE_UNCERTAIN", "RESTORE_HTTP_RESPONSE_UNCERTAIN", "SUBMISSION_ATTRIBUTION_FAILED", "SUBMISSION_EVIDENCE_MISSING", "SUBMISSION_REFERENCE_MISSING"]);
register("outcomes.corruptState", ["JOURNAL_INVALID", "RESTORE_HISTORY_AMBIGUOUS", "RESTORE_UNIT_IDENTITY_CONFLICT"]);
register("outcomes.invalidBackup", ["RESTORE_NO_VALID_INPUT"]);
register("outcomes.conflict", ["RESTORE_NOT_ADMITTED", "RESTORE_PLAN_CHANGED"]);
register("outcomes.unsupported", ["RESTORE_FLAGS_UNSUPPORTED", "RESTORE_HISTORY_UNSUPPORTED"]);
register("outcomes.runtimeUnavailable", ["RESTORE_CONTEXT_UNAVAILABLE", "RESTORE_PROFILE_UNAVAILABLE"]);
register("outcomes.targetChanged", ["RESTORE_CONNECTION_CHANGED"]);
register("outcomes.failed", ["RESTORE_DOMAIN_FAILED"]);
register("outcomes.syncDecisionTimeout", ["SYNC_DECISION_TIMEOUT"]);
register("outcomes.syncRefreshTimeout", ["SYNC_REFRESH_TIMEOUT"]);

function messageKey(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof value === "string") return Object.hasOwn(messages, value) ? messages[value] : undefined;
  if (!value || typeof value !== "object" || seen.has(value) || seen.size >= 8) return undefined;
  seen.add(value);
  const outcome = value as { code?: unknown; kind?: unknown; message?: unknown; cause?: unknown };
  return messageKey(outcome.code, seen) ?? messageKey(outcome.kind, seen)
    ?? messageKey(outcome.message, seen) ?? messageKey(outcome.cause, seen);
}

export function operationError(error: unknown, fallback = "outcomes.failed", t: Translate = translate): string {
  return t(messageKey(error) ?? fallback);
}

export function restoreNote(note: unknown, t: Translate = translate): string {
  return t(messageKey(note) ?? "outcomes.warning");
}

export function restorePayloadSummary(payload: { status: string; kind?: string; reasons: readonly unknown[]; warnings: readonly unknown[] }, t: Translate = translate): string {
  const notes = [...payload.reasons, ...payload.warnings].map(note => restoreNote(note, t));
  if (notes.length) return [...new Set(notes)].join(" ");
  return t(payload.status === "restorable" ? "outcomes.ready" : payload.status === "blocked" ? "outcomes.dependencies"
    : payload.status === "unsupported" ? "outcomes.unsupported" : payload.status === "skipped" ? "outcomes.skipped" : "outcomes.warning");
}

// UI state retains the cause and catalog key, never a translation captured in a
// previous locale. Raw causes remain available to the existing diagnostic path.
export interface OperationFailure {
  cause: unknown;
  fallback: string;
  values?: Record<string, string | number>;
}
export function operationFailure(cause: unknown, fallback = "outcomes.failed", values?: OperationFailure["values"]): OperationFailure {
  return { cause, fallback, values };
}
export function presentOperationFailure(failure: OperationFailure | null | undefined, t: Translate = translate): string {
  return failure ? t(messageKey(failure.cause) ?? failure.fallback, failure.values ?? {}) : "";
}
