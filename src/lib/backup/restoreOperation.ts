/** Production restore history is separate from verification receipts. */
export type RestorePhase = "inspected" | "waiting_for_dependencies" | "ready" | "running"
  | "partially_completed" | "interrupted" | "retryable_failure" | "nonretryable_failure"
  | "completed" | "cancelled";
export type RestoreOutcome = "NOT_TESTED" | "PASS" | "PARTIAL" | "FAIL";
export type RestoreUnitStatus = "pending" | "running" | "succeeded" | "failed" | "unknown" | "skipped" | "cancelled";
export type RestoreDomain = "manga" | "books" | "novels" | "app";
export interface RestoreTarget {
  profileId: string;
  storageScope: string;
  connectionGeneration: string;
  backendGeneration: string | null;
  runtimeIdentityDigest: string | null;
}
export interface RestoreInput { digest: string; size: number }
export interface RestoreRequirement {
  id: string;
  domain: RestoreDomain;
  kind: "repository" | "package" | "source" | "capability";
  provenanceDigest: string | null;
  packageId: string | null;
  sourceId: string | null;
  capability: string | null;
  state: "unresolved" | "approved" | "satisfied" | "rejected";
  approvalReference: string | null;
  affectedUnits: string[];
}
export interface RestoreExternalReference {
  restoreId: string;
  clientMutationId: string | null;
  backendGeneration: string;
  submittedAt: string;
  lastStatus: string | null;
  lastObservedAt: string | null;
  totalManga: number | null;
  mangaProgress: number | null;
}
export interface RestoreAttempt {
  attemptId: string;
  startedAt: string;
  completedAt: string | null;
  resultCode: string | null;
  errorCode: string | null;
}
export interface RestoreUnit {
  unitId: string;
  parentUnitId: string | null;
  kind: string;
  domain: RestoreDomain;
  inputDigest: string;
  identity: string;
  dependsOn: string[];
  status: RestoreUnitStatus;
  attempts: RestoreAttempt[];
  startedAt: string | null;
  completedAt: string | null;
  resultCode: string | null;
  errorCode: string | null;
  warnings: string[];
  retryPolicy: "never" | "proven_not_accepted" | "reconcile";
  idempotencyPolicy: "not_proven" | "content_verified" | "revision_checked";
  externalOperationReference: RestoreExternalReference | null;
  beforeDigest: string | null;
  expectedAfterDigest: string | null;
  observedAfterDigest: string | null;
  submissionIntent?: {
    operationId: string; unitId: string; attemptId: string; inputDigest: string;
    target: RestoreTarget; flags: Record<string, boolean>; clientMutationId: string;
  };
}
export interface RestoreRecord {
  schemaVersion: 1;
  operationId: string;
  revision: number;
  previousRevision: number | null;
  createdAt: string;
  updatedAt: string;
  phase: RestorePhase;
  outcome: RestoreOutcome;
  target: RestoreTarget;
  inputs: RestoreInput[];
  planDigest: string;
  selections: string[];
  requirements: RestoreRequirement[];
  units: RestoreUnit[];
  cancellationRequestedAt: string | null;
  recoveryCodes: string[];
}

export class RestoreError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "RestoreError"; }
}

export function canonicalRestoreJson(value: unknown): string {
  if (typeof value === "string") {
    // Rust strings are Unicode scalar values; lone UTF-16 surrogates cannot cross
    // the durable boundary without changing bytes or being rejected natively.
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new RestoreError("INVALID_DURABLE_VALUE");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRestoreJson).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new RestoreError("INVALID_DURABLE_VALUE");
  }
  return `{${Object.keys(value).sort().map((key) => `${canonicalRestoreJson(key)}:${canonicalRestoreJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export async function restoreDigest(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface RestoreUnitResult {
  status: "succeeded" | "failed" | "unknown";
  code: string;
  provenNotAccepted?: boolean;
  observedAfterDigest?: string;
  warnings?: string[];
}
export interface RestoreExecutionContext {
  record: RestoreRecord;
  unit: RestoreUnit;
  checkpointExternal(reference: RestoreExternalReference): Promise<void>;
  checkpointIntent(intent: NonNullable<RestoreUnit["submissionIntent"]>): Promise<void>;
}
export interface RestoreOperationRuntime {
  admit(target: RestoreTarget, operationId: string): Promise<() => Promise<void>>;
  validate(record: RestoreRecord): Promise<void>;
  execute(context: RestoreExecutionContext): Promise<RestoreUnitResult>;
  reconcile(context: RestoreExecutionContext): Promise<RestoreUnitResult>;
}
export interface RestoreJournal {
  read(operationId: string): Promise<RestoreRecord | null>;
  write(record: RestoreRecord, expectedRevision: number | null): Promise<void>;
}
export interface RestoreUnitDefinition {
  kind: string;
  domain: RestoreDomain;
  inputDigest: string;
  identity: string;
  dependsOn: string[];
}
export interface RestoreConfiguration {
  selections: string[];
  requirements: RestoreRequirement[];
  units: RestoreUnitDefinition[];
}
export function createRestoreOperation(journal: RestoreJournal, runtime: RestoreOperationRuntime) {
  const listeners = new Map<string, Set<(record: RestoreRecord) => void>>();
  const now = () => new Date().toISOString();
  const copy = <T>(value: T): T => JSON.parse(canonicalRestoreJson(value));
  async function load(id: string) {
    const record = await journal.read(id);
    if (!record) throw new RestoreError("RESTORE_NOT_FOUND");
    return record;
  }
  async function update(id: string, apply: (record: RestoreRecord) => void) {
    const record = await load(id);
    const revision = record.revision;
    apply(record);
    record.previousRevision = revision;
    record.revision = revision + 1;
    record.updatedAt = now();
    await journal.write(record, revision);
    for (const listener of listeners.get(id) ?? []) {
      // A failed observer must never change execution or durable outcome.
      try { listener(copy(record)); } catch { /* presentation failure */ }
    }
    return record;
  }
  function aggregate(record: RestoreRecord) {
    const changed = record.units.some((unit) => unit.status === "succeeded");
    const uncertain = record.units.some((unit) => unit.status === "unknown" || unit.status === "running");
    const failed = record.units.some((unit) => unit.status === "failed");
    const done = record.units.length > 0 && record.units.every((unit) => unit.status === "succeeded" || unit.status === "skipped");
    if (done) {
      record.phase = "completed";
      record.outcome = record.units.some((unit) => unit.warnings.length > 0) ? "PARTIAL" : "PASS";
    } else if (uncertain) {
      record.phase = "interrupted";
      record.outcome = "PARTIAL";
    } else if (record.cancellationRequestedAt) {
      record.phase = "cancelled";
      record.outcome = changed ? "PARTIAL" : "NOT_TESTED";
    } else if (changed) {
      record.phase = "partially_completed";
      record.outcome = "PARTIAL";
    } else if (failed) {
      record.phase = record.units.some((unit) => unit.status === "failed" && unit.retryPolicy === "proven_not_accepted")
        ? "retryable_failure" : "nonretryable_failure";
      record.outcome = "FAIL";
    } else {
      record.phase = "waiting_for_dependencies";
      record.outcome = "NOT_TESTED";
    }
  }
  async function run(id: string, recovery: boolean): Promise<RestoreRecord> {
    const initial = await load(id);
    const release = await runtime.admit(copy(initial.target), id);
    try {
      let current = await load(id);
      if (canonicalRestoreJson(current.target) !== canonicalRestoreJson(initial.target)
        || current.planDigest !== initial.planDigest) throw new RestoreError("RESTORE_TARGET_CHANGED");
      await runtime.validate(copy(current));
      if (current.phase === "completed" || current.phase === "cancelled") return current;
      if (!["ready", "running", "partially_completed", "interrupted", "retryable_failure", "nonretryable_failure"].includes(current.phase)) {
        throw new RestoreError("RESTORE_NOT_READY");
      }
      if (!recovery && current.units.some((unit) => unit.status !== "pending" && unit.status !== "skipped")) {
        throw new RestoreError("RESTORE_REQUIRES_RESUME");
      }
      current = await update(id, (record) => {
        for (const unit of record.units) {
          if (unit.status === "running") {
            unit.status = "unknown";
            unit.errorCode = "EXECUTOR_INTERRUPTED";
          }
        }
        record.phase = "running";
        record.outcome = "PARTIAL";
      });
      for (const plannedUnit of current.units) {
        current = await load(id);
        const unit = current.units.find((candidate) => candidate.unitId === plannedUnit.unitId)!;
        if (["succeeded", "skipped", "cancelled"].includes(unit.status)) continue;
        const reconcile = unit.status === "unknown";
        if (current.cancellationRequestedAt && !reconcile) {
          if (unit.status === "pending") await update(id, (record) => {
            record.units.find((candidate) => candidate.unitId === unit.unitId)!.status = "cancelled";
          });
          continue;
        }
        if (unit.status === "failed" && unit.retryPolicy !== "proven_not_accepted") continue;
        if (unit.dependsOn.some((dependency) => !current.units.some((candidate) => candidate.unitId === dependency && candidate.status === "succeeded"))) continue;
        await runtime.validate(copy(current));
        if (!reconcile) {
          current = await update(id, (record) => {
            const next = record.units.find((candidate) => candidate.unitId === unit.unitId)!;
            next.status = "running";
            next.retryPolicy = "never";
            next.startedAt ??= now();
            next.completedAt = null;
            next.attempts.push({ attemptId: crypto.randomUUID(), startedAt: now(), completedAt: null, resultCode: null, errorCode: null });
          });
        }
        const context: RestoreExecutionContext = {
          record: copy(current),
          unit: copy(current.units.find((candidate) => candidate.unitId === unit.unitId)!),
          async checkpointIntent(intent) {
            await update(id, (record) => {
              const next = record.units.find((candidate) => candidate.unitId === unit.unitId)!;
              if (next.status !== "running" || intent.operationId !== id || intent.unitId !== next.unitId
                || intent.attemptId !== next.attempts.at(-1)?.attemptId || intent.clientMutationId !== intent.attemptId
                || intent.inputDigest !== next.inputDigest || canonicalRestoreJson(intent.target) !== canonicalRestoreJson(record.target)) {
                throw new RestoreError("INVALID_SUBMISSION_INTENT");
              }
              next.submissionIntent = copy(intent);
            });
          },
          async checkpointExternal(reference) {
            await update(id, (record) => {
              const next = record.units.find((candidate) => candidate.unitId === unit.unitId)!;
              if (next.status !== "running" && next.status !== "unknown") throw new RestoreError("UNIT_NOT_ACTIVE");
              if (reference.backendGeneration !== record.target.backendGeneration) throw new RestoreError("BACKEND_GENERATION_CHANGED");
              next.externalOperationReference = copy(reference);
            });
          },
        };
        let result: RestoreUnitResult;
        try {
          result = await (reconcile ? runtime.reconcile(context) : runtime.execute(context));
          await runtime.validate(copy(await load(id)));
        }
        catch { result = { status: "unknown", code: "MUTATION_OUTCOME_UNKNOWN" }; }
        // Publication failure leaves the last durable running/unknown record intact.
        // It must not fall through to another side effect or a synthetic success.
        await update(id, (record) => {
          const next = record.units.find((candidate) => candidate.unitId === unit.unitId)!;
          next.status = result.status;
          next.resultCode = result.code;
          next.errorCode = result.status === "succeeded" ? null : result.code;
          next.retryPolicy = result.status === "failed" && result.provenNotAccepted === true ? "proven_not_accepted" : "never";
          next.observedAfterDigest = result.observedAfterDigest ?? null;
          next.warnings = result.warnings ?? [];
          next.completedAt = result.status === "unknown" ? null : now();
          const attempt = next.attempts.at(-1);
          if (attempt) {
            attempt.completedAt = next.completedAt;
            attempt.resultCode = result.code;
            attempt.errorCode = next.errorCode;
          }
        });
        // Unknown acceptance is a barrier for the entire operation.
        if (result.status === "unknown") break;
      }
      return await update(id, aggregate);
    } finally {
      // Native release must retain unresolved durable markers. Releasing a live
      // handle is not evidence that remote work has completed.
      await release();
    }
  }
  async function requestCancel(id: string) {
    return update(id, (record) => {
      if (record.phase === "completed") return;
      record.cancellationRequestedAt ??= now();
      if (record.units.every((unit) => unit.status === "pending" || unit.status === "skipped")) {
        for (const unit of record.units) if (unit.status === "pending") unit.status = "cancelled";
        aggregate(record);
      }
    });
  }
  function observe(id: string, listener: (record: RestoreRecord) => void) {
    const set = listeners.get(id) ?? new Set();
    set.add(listener);
    listeners.set(id, set);
    return () => { set.delete(listener); };
  }
  return {
    async inspect(inputs: RestoreInput[], target: RestoreTarget): Promise<RestoreRecord> {
      const frozen = copy({ inputs, target });
      const record: RestoreRecord = {
        schemaVersion: 1, operationId: crypto.randomUUID(), revision: 0, previousRevision: null,
        createdAt: now(), updatedAt: now(), phase: "inspected", outcome: "NOT_TESTED",
        ...frozen, planDigest: await restoreDigest(canonicalRestoreJson(frozen)),
        selections: [], requirements: [], units: [], cancellationRequestedAt: null, recoveryCodes: [],
      };
      await journal.write(record, null);
      return copy(record);
    },
    async configure(id: string, configuration: RestoreConfiguration, expectedRevision: number): Promise<RestoreRecord> {
      const frozen = copy(configuration);
      const record = await load(id);
      if (record.revision !== expectedRevision) throw new RestoreError("JOURNAL_CONFLICT");
      if (!["inspected", "ready", "waiting_for_dependencies"].includes(record.phase)
        || record.cancellationRequestedAt || record.units.some((unit) => unit.attempts.length > 0)) {
        throw new RestoreError("RESTORE_PLAN_FROZEN");
      }
      const identities = new Map<string, string>();
      for (const definition of frozen.units) {
        if (identities.has(definition.identity) || !record.inputs.some((input) => input.digest === definition.inputDigest)) {
          throw new RestoreError("INVALID_UNIT_IDENTITY");
        }
        const hash = await restoreDigest(canonicalRestoreJson({ operationId: id, ...definition }));
        identities.set(definition.identity, `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`);
      }
      const preceding = new Set<string>();
      const units: RestoreUnit[] = frozen.units.map((definition) => {
        if (definition.dependsOn.some((identity) => !preceding.has(identity))) throw new RestoreError("INVALID_UNIT_DEPENDENCY_ORDER");
        preceding.add(definition.identity);
        return {
          ...definition, unitId: identities.get(definition.identity)!, parentUnitId: null,
          dependsOn: definition.dependsOn.map((identity) => identities.get(identity)!),
          status: "pending", attempts: [], startedAt: null, completedAt: null, resultCode: null, errorCode: null,
          warnings: [], retryPolicy: "never", idempotencyPolicy: "not_proven", externalOperationReference: null,
          beforeDigest: null, expectedAfterDigest: null, observedAfterDigest: null,
        };
      });
      const planDigest = await restoreDigest(canonicalRestoreJson({ target: record.target, inputs: record.inputs, ...frozen }));
      return update(id, (current) => {
        if (current.revision !== expectedRevision) throw new RestoreError("JOURNAL_CONFLICT");
        current.selections = frozen.selections;
        current.requirements = frozen.requirements;
        current.units = units;
        current.planDigest = planDigest;
        current.phase = units.length > 0 && frozen.requirements.every((requirement) => requirement.state === "satisfied")
          ? "ready" : "waiting_for_dependencies";
      });
    },
    start: (id: string) => run(id, false), resume: (id: string) => run(id, true),
    retryEligible: (id: string) => run(id, true), requestCancel, observe,
    detach(id: string) { listeners.delete(id); } };
}
