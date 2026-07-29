import {
  appendMigrationOperation,
  getMigrationOperation,
  loadMigrationJournalState,
  updateMigrationOperation,
} from "./journalState";
import type {
  MigrationContentKind,
  MigrationMode,
  MigrationOperationStatus,
  MigrationOperationV2,
  MigrationPayload,
  MigrationStepKind,
  MigrationStepRecord,
  MigrationTransferSummary,
} from "./types";

const DEFAULT_UNDO_WINDOW_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = new Set<MigrationOperationStatus>([
  "committed",
  "compensated",
  "rolled_back",
  "cancelled",
  "needs_manual_recovery",
  "corrupt",
]);
const BLOCKING_RECOVERY_STATUSES = new Set<MigrationOperationStatus>([
  "recovery_pending",
  "recovering",
  "needs_manual_recovery",
  "corrupt",
]);
const profileQueues = new Map<string, Promise<void>>();

export interface MigrationStepDefinition {
  stepId: string;
  kind: MigrationStepKind;
}

export interface BeginMigrationOperationInput {
  profileId: string;
  expectedRevision?: string | null;
  contentKind: MigrationContentKind;
  mode?: MigrationMode;
  sourceFrom: string;
  sourceTo: string;
  transferSummary: MigrationTransferSummary;
  payload: MigrationPayload;
  steps: MigrationStepDefinition[];
}

function normalizeProfileId(value: string): string {
  return value.trim() || "main";
}

function createOperationId(): string {
  return `migration-${Date.now()}-${crypto.randomUUID()}`;
}

async function sha256Json(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function snapshotSides(payload: MigrationPayload): { oldState: unknown; newState: unknown } {
  if ("items" in payload) {
    return {
      oldState: payload.items.map((item) => item.oldState),
      newState: payload.items.map((item) => item.newState),
    };
  }
  return {
    oldState: payload.oldState,
    newState: payload.newState,
  };
}

function createStepRecord(step: MigrationStepDefinition): MigrationStepRecord {
  return {
    stepId: step.stepId,
    kind: step.kind,
    status: "pending",
    attempt: 0,
    startedAt: null,
    completedAt: null,
    failureCode: null,
  };
}

export async function withMigrationProfileLock<T>(
  profileId: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = normalizeProfileId(profileId);
  const previous = profileQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  profileQueues.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (profileQueues.get(key) === queued) profileQueues.delete(key);
  }
}

export async function beginMigrationOperation(
  input: BeginMigrationOperationInput,
): Promise<MigrationOperationV2> {
  const now = Date.now();
  const profileId = normalizeProfileId(input.profileId);
  const journal = await loadMigrationJournalState();
  const unresolved = journal.operations.find((operation) => (
    operation.profileId === profileId
    && BLOCKING_RECOVERY_STATUSES.has(operation.status)
  ));
  if (unresolved) {
    throw new Error(
      `Migration ${unresolved.operationId} requires recovery before another migration can start for this profile.`,
    );
  }
  const sides = snapshotSides(input.payload);
  const operation: MigrationOperationV2 = {
    schemaVersion: 2,
    operationId: createOperationId(),
    profileId,
    expectedRevision: input.expectedRevision ?? null,
    revision: 1,
    contentKind: input.contentKind,
    mode: input.mode ?? "single",
    sourceFrom: input.sourceFrom,
    sourceTo: input.sourceTo,
    createdAt: now,
    updatedAt: now,
    committedAt: null,
    undoUntil: null,
    status: "planned",
    transferSummary: structuredClone(input.transferSummary),
    failureReason: null,
    steps: input.steps.map(createStepRecord),
    snapshots: {
      oldStateSha256: await sha256Json(sides.oldState),
      newStateSha256: await sha256Json(sides.newState),
      payload: structuredClone(input.payload),
    },
  };
  await appendMigrationOperation(operation);
  return operation;
}

async function requireOperation(operationId: string): Promise<MigrationOperationV2> {
  const operation = await getMigrationOperation(operationId);
  if (!operation) throw new Error(`Migration operation ${operationId} was not found.`);
  return operation;
}

export async function transitionMigrationOperation(
  operationId: string,
  status: MigrationOperationStatus,
  patch: Partial<Omit<MigrationOperationV2, "schemaVersion" | "operationId" | "status">> = {},
): Promise<MigrationOperationV2> {
  const operation = await requireOperation(operationId);
  await updateMigrationOperation(operationId, { ...patch, status }, operation.revision);
  return requireOperation(operationId);
}

export async function checkpointMigrationStep(
  operationId: string,
  stepId: string,
  patch: Partial<Omit<MigrationStepRecord, "stepId" | "kind">>,
): Promise<MigrationOperationV2> {
  const operation = await requireOperation(operationId);
  const index = operation.steps.findIndex((step) => step.stepId === stepId);
  if (index < 0) throw new Error(`Migration step ${stepId} was not found.`);
  const steps = operation.steps.map((step, stepIndex) => (
    stepIndex === index ? { ...step, ...patch } : step
  ));
  await updateMigrationOperation(operationId, { steps }, operation.revision);
  return requireOperation(operationId);
}

export async function runMigrationStep(input: {
  operationId: string;
  stepId: string;
  apply: () => Promise<void>;
  verify?: () => Promise<void>;
}): Promise<void> {
  const startedAt = Date.now();
  const operation = await requireOperation(input.operationId);
  const step = operation.steps.find((candidate) => candidate.stepId === input.stepId);
  if (!step) throw new Error(`Migration step ${input.stepId} was not found.`);
  if (step.status === "verified") return;
  await checkpointMigrationStep(input.operationId, input.stepId, {
    status: "applying",
    attempt: step.attempt + 1,
    startedAt,
    completedAt: null,
    failureCode: null,
  });
  try {
    await input.apply();
    await checkpointMigrationStep(input.operationId, input.stepId, {
      status: input.verify ? "verifying" : "verified",
      completedAt: input.verify ? null : Date.now(),
    });
    if (input.verify) {
      await input.verify();
      await checkpointMigrationStep(input.operationId, input.stepId, {
        status: "verified",
        completedAt: Date.now(),
      });
    }
  } catch (error) {
    await checkpointMigrationStep(input.operationId, input.stepId, {
      status: "failed",
      completedAt: Date.now(),
      failureCode: error instanceof Error ? error.name : "MIGRATION_STEP_FAILED",
    });
    throw error;
  }
}

export async function checkpointMigrationPayload(
  operationId: string,
  payload: MigrationPayload,
): Promise<MigrationOperationV2> {
  const operation = await requireOperation(operationId);
  const sides = snapshotSides(payload);
  await updateMigrationOperation(operationId, {
    snapshots: {
      oldStateSha256: await sha256Json(sides.oldState),
      newStateSha256: await sha256Json(sides.newState),
      payload: structuredClone(payload),
    },
  }, operation.revision);
  return requireOperation(operationId);
}

export async function commitMigrationOperation(
  operationId: string,
  patch: {
    transferSummary?: MigrationTransferSummary;
    payload?: MigrationPayload;
  } = {},
): Promise<MigrationOperationV2> {
  await transitionMigrationOperation(operationId, "verifying");
  const operation = await requireOperation(operationId);
  if (operation.steps.some((step) => step.status !== "verified" && step.status !== "skipped")) {
    throw new Error("Migration cannot commit before every step is verified or skipped.");
  }
  let snapshots = operation.snapshots;
  if (patch.payload) {
    const sides = snapshotSides(patch.payload);
    snapshots = {
      oldStateSha256: await sha256Json(sides.oldState),
      newStateSha256: await sha256Json(sides.newState),
      payload: structuredClone(patch.payload),
    };
  }
  await transitionMigrationOperation(operationId, "committing", {
    transferSummary: patch.transferSummary ?? operation.transferSummary,
    snapshots,
  });
  return transitionMigrationOperation(operationId, "committed", {
    committedAt: Date.now(),
    undoUntil: Date.now() + DEFAULT_UNDO_WINDOW_MS,
  });
}

export async function markMigrationCompensated(operationId: string): Promise<MigrationOperationV2> {
  return transitionMigrationOperation(operationId, "compensated", {
    undoUntil: null,
  });
}

export async function markMigrationNeedsManualRecovery(
  operationId: string,
  reason: string,
): Promise<MigrationOperationV2> {
  return transitionMigrationOperation(operationId, "needs_manual_recovery", {
    failureReason: reason,
    undoUntil: null,
  });
}

export async function recoverInterruptedMigrationOperations(): Promise<MigrationOperationV2[]> {
  const state = await loadMigrationJournalState();
  const recovered: MigrationOperationV2[] = [];
  for (const operation of state.operations) {
    if (TERMINAL_STATUSES.has(operation.status)) continue;
    const effectsMayHaveStarted = operation.status === "recovery_pending"
      || operation.status === "recovering"
      || operation.steps.some((step) => step.status !== "pending");
    if (!effectsMayHaveStarted) {
      const next = await transitionMigrationOperation(operation.operationId, "cancelled", {
        failureReason: "Migration was interrupted before any effect started.",
        undoUntil: null,
      });
      recovered.push(next);
      continue;
    }

    const snapshotsAvailable = operation.snapshots.oldStateSha256 != null
      && operation.snapshots.newStateSha256 != null;
    const next = await transitionMigrationOperation(
      operation.operationId,
      snapshotsAvailable ? "needs_manual_recovery" : "corrupt",
      {
        failureReason: snapshotsAvailable
          ? "Migration was interrupted after effects may have started. Its preserved snapshots require contextual recovery before this profile can migrate again."
          : "Migration was interrupted after effects may have started, but its recovery snapshots are incomplete.",
        undoUntil: null,
      },
    );
    recovered.push(next);
  }
  return recovered;
}

export async function acknowledgeMigrationManualRecovery(
  operationId: string,
  verification: () => Promise<void>,
): Promise<MigrationOperationV2> {
  const operation = await requireOperation(operationId);
  if (operation.status !== "needs_manual_recovery") {
    throw new Error("Only a migration awaiting manual recovery can be acknowledged.");
  }
  await verification();
  return transitionMigrationOperation(operationId, "compensated", {
    failureReason: "Recovery was verified explicitly.",
      undoUntil: null,
  });
}

export function resetMigrationCoordinatorForTests() {
  profileQueues.clear();
}
