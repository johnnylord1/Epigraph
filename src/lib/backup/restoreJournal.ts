import contract from "./restoreJournalContract.json";
import { RestoreError, canonicalRestoreJson, restoreDigest, type RestoreRecord } from "./restoreOperation";

/** CAS must be atomic across processes in the native implementation. */
export interface RestoreJournalStorage {
  read(operationId: string): Promise<string | null>;
  compareAndSwap(operationId: string, expectedDigest: string | null, next: string): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const definitions: Record<string, Record<string, string>> = contract.definitions;

/** The same small descriptor is interpreted by native code; no unknown fields. */
function matches(value: unknown, type: string): boolean {
  if (type.startsWith("?")) return value === null || matches(value, type.slice(1));
  if (type.startsWith("[]")) return Array.isArray(value) && value.every((item) => matches(item, type.slice(2)));
  if (type.includes("|")) return typeof value === "string" && type.split("|").includes(value);
  if (type === "one") return value === 1;
  if (type === "uint") return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (type === "domain") return typeof value === "string" && ["manga", "books", "novels", "app"].includes(value);
  if (type === "text") return typeof value === "string" && value.length > 0;
  if (type === "uuid" || type === "digest") return typeof value === "string" && (type === "uuid" ? uuid : digest).test(value);
  if (type === "timestamp") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (type === "booleanMap") return Object.values(object).every((entry) => typeof entry === "boolean");
  const fields = definitions[type];
  if (!fields) return false;
  return Object.keys(object).every((key) => (Object.hasOwn(fields, key) && !key.endsWith("?")) || Object.hasOwn(fields, key + "?"))
    && Object.entries(fields).every(([key, descriptor]) => key.endsWith("?")
      ? !Object.hasOwn(object, key.slice(0, -1)) || matches(object[key.slice(0, -1)], descriptor)
      : Object.hasOwn(object, key) && matches(object[key], descriptor));
}

function validate(record: RestoreRecord, operationId: string): void {
  if (!matches(record, "record") || record.operationId !== operationId
    || record.previousRevision !== (record.revision === 0 ? null : record.revision - 1)) throw new RestoreError("JOURNAL_INVALID");
  const inputs = new Set(record.inputs.map((input) => input.digest));
  const unitIds = new Set<string>();
  for (const unit of record.units) {
    if (unitIds.has(unit.unitId) || !inputs.has(unit.inputDigest) || unit.dependsOn.some((id) => !unitIds.has(id))) throw new RestoreError("JOURNAL_INVALID");
    unitIds.add(unit.unitId);
    if (new Set(unit.attempts.map((attempt) => attempt.attemptId)).size !== unit.attempts.length) throw new RestoreError("JOURNAL_INVALID");
    const intent = unit.submissionIntent;
    if (intent && (intent.operationId !== record.operationId || intent.unitId !== unit.unitId || intent.inputDigest !== unit.inputDigest
      || intent.clientMutationId !== intent.attemptId || !unit.attempts.some((attempt) => attempt.attemptId === intent.attemptId)
      || canonicalRestoreJson(intent.target) !== canonicalRestoreJson(record.target))) throw new RestoreError("JOURNAL_INVALID");
  }
  if ((record.phase === "completed" && (record.units.length === 0 || record.units.some((unit) => !["succeeded", "skipped"].includes(unit.status))))
    || (record.outcome === "PASS" && record.phase !== "completed")) throw new RestoreError("JOURNAL_INVALID");
}

export function createRestoreJournal(storage: RestoreJournalStorage) {
  async function decode(raw: string, operationId: string): Promise<RestoreRecord> {
    try {
      const envelope = JSON.parse(raw);
      if (new TextEncoder().encode(raw).length > 16 * 1024 * 1024 || !matches(envelope, "envelope")
        || raw !== canonicalRestoreJson(envelope) || envelope.checksum !== await restoreDigest(canonicalRestoreJson(envelope.payload))) {
        throw new RestoreError("JOURNAL_CORRUPT");
      }
      validate(envelope.payload, operationId);
      return envelope.payload;
    } catch {
      throw new RestoreError("JOURNAL_CORRUPT");
    }
  }
  async function read(operationId: string): Promise<RestoreRecord | null> {
    if (!uuid.test(operationId)) throw new RestoreError("INVALID_OPERATION_ID");
    const raw = await storage.read(operationId);
    return raw === null ? null : decode(raw, operationId);
  }
  async function write(record: RestoreRecord, expectedRevision: number | null): Promise<void> {
    // Freeze the caller's object before the first await; mutable UI references cannot
    // change a payload between validation, digesting and publication.
    const snapshot: RestoreRecord = JSON.parse(canonicalRestoreJson(record));
    validate(snapshot, snapshot.operationId);
    if (snapshot.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) {
      throw new RestoreError("JOURNAL_CONFLICT");
    }
    const previous = await storage.read(snapshot.operationId);
    const current = previous === null ? null : await decode(previous, snapshot.operationId);
    if ((current?.revision ?? null) !== expectedRevision) throw new RestoreError("JOURNAL_CONFLICT");
    const checksum = await restoreDigest(canonicalRestoreJson(snapshot));
    await storage.compareAndSwap(snapshot.operationId, previous === null ? null : await restoreDigest(previous),
      canonicalRestoreJson({ checksum, payload: snapshot }));
  }
  return { read, write };
}
