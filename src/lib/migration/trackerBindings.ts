import {
  BIND_TRACK,
  GET_MANGA_TRACK_RECORDS,
  UNBIND_TRACK,
} from "../queries";
import type { TrackRecord } from "../types";

export type MangaTrackerMigrationMode = "copy" | "migrate";

export interface LogicalTrackerBinding {
  trackerId: number;
  remoteId: string;
}

export interface TrackerBindingRecord extends LogicalTrackerBinding {
  recordId: number;
}

export interface MangaTrackerBindingPort {
  list(mangaId: number): Promise<TrackerBindingRecord[]>;
  bind(mangaId: number, binding: LogicalTrackerBinding): Promise<TrackerBindingRecord>;
  unbind(recordId: number): Promise<void>;
}

export type TrackerBindingGql = <T>(
  document: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export interface PrepareMangaTrackerBindingPlanInput {
  sourceMangaId: number;
  targetMangaId: number;
  mode: MangaTrackerMigrationMode;
}

export interface MangaTrackerBindingPlan extends PrepareMangaTrackerBindingPlanInput {
  sourceBefore: LogicalTrackerBinding[];
  targetBefore: LogicalTrackerBinding[];
  sourceAfter: LogicalTrackerBinding[];
  targetAfter: LogicalTrackerBinding[];
  targetBindingsToCreate: LogicalTrackerBinding[];
  sourceBindingsToRemove: LogicalTrackerBinding[];
}

export type TrackerBindingErrorCode =
  | "SAME_MANGA"
  | "DUPLICATE_TRACKER_ID"
  | "TARGET_TRACKER_CONFLICT"
  | "STATE_DRIFT"
  | "VERIFICATION_FAILED"
  | "APPLY_FAILED"
  | "COMPENSATION_FAILED";

export class TrackerBindingError extends Error {
  readonly code: TrackerBindingErrorCode;
  readonly cause?: unknown;

  constructor(code: TrackerBindingErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "TrackerBindingError";
    this.code = code;
    this.cause = cause;
  }
}

interface GetMangaTrackRecordsResponse {
  manga: {
    trackRecords: {
      nodes: TrackRecord[];
    };
  } | null;
}

interface BindTrackResponse {
  bindTrack: {
    trackRecord: TrackRecord;
  };
}

function compareBindings(
  left: LogicalTrackerBinding,
  right: LogicalTrackerBinding,
): number {
  return left.trackerId - right.trackerId
    || left.remoteId.localeCompare(right.remoteId);
}

function logicalKey(binding: LogicalTrackerBinding): string {
  return `${binding.trackerId}\u0000${binding.remoteId}`;
}

function cloneLogical(binding: LogicalTrackerBinding): LogicalTrackerBinding {
  return {
    trackerId: binding.trackerId,
    remoteId: binding.remoteId,
  };
}

function normalizeLogicalBindings(
  bindings: readonly LogicalTrackerBinding[],
  owner: string,
): LogicalTrackerBinding[] {
  const byTracker = new Map<number, LogicalTrackerBinding>();

  for (const binding of bindings) {
    if (!Number.isSafeInteger(binding.trackerId)) {
      throw new TrackerBindingError(
        "STATE_DRIFT",
        `${owner} contains an invalid tracker id`,
      );
    }
    if (typeof binding.remoteId !== "string" || binding.remoteId.length === 0) {
      throw new TrackerBindingError(
        "STATE_DRIFT",
        `${owner} contains an invalid remote id`,
      );
    }

    if (byTracker.has(binding.trackerId)) {
      throw new TrackerBindingError(
        "DUPLICATE_TRACKER_ID",
        `${owner} contains more than one binding for tracker ${binding.trackerId}`,
      );
    }
    byTracker.set(binding.trackerId, cloneLogical(binding));
  }

  return [...byTracker.values()].sort(compareBindings);
}

function normalizeRecords(
  records: readonly TrackerBindingRecord[],
  owner: string,
): TrackerBindingRecord[] {
  const logical = normalizeLogicalBindings(records, owner);
  const recordByKey = new Map(
    records.map((record) => [logicalKey(record), record]),
  );

  return logical.map((binding) => {
    const record = recordByKey.get(logicalKey(binding));
    if (!record || !Number.isSafeInteger(record.recordId)) {
      throw new TrackerBindingError(
        "STATE_DRIFT",
        `${owner} contains an invalid record id`,
      );
    }
    return {
      recordId: record.recordId,
      ...binding,
    };
  });
}

function logicalFromRecords(
  records: readonly TrackerBindingRecord[],
  owner: string,
): LogicalTrackerBinding[] {
  return normalizeRecords(records, owner).map(cloneLogical);
}

function bindingsEqual(
  left: readonly LogicalTrackerBinding[],
  right: readonly LogicalTrackerBinding[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((binding, index) => (
    binding.trackerId === right[index]?.trackerId
    && binding.remoteId === right[index]?.remoteId
  ));
}

function isSubset(
  subset: readonly LogicalTrackerBinding[],
  superset: readonly LogicalTrackerBinding[],
): boolean {
  const keys = new Set(superset.map(logicalKey));
  return subset.every((binding) => keys.has(logicalKey(binding)));
}

function findByTracker(
  bindings: readonly LogicalTrackerBinding[],
  trackerId: number,
): LogicalTrackerBinding | undefined {
  return bindings.find((binding) => binding.trackerId === trackerId);
}

function mergeBindings(
  base: readonly LogicalTrackerBinding[],
  additions: readonly LogicalTrackerBinding[],
): LogicalTrackerBinding[] {
  const merged = new Map(base.map((binding) => [binding.trackerId, cloneLogical(binding)]));
  for (const binding of additions) {
    merged.set(binding.trackerId, cloneLogical(binding));
  }
  return [...merged.values()].sort(compareBindings);
}

function assertTargetHasNoConflicts(
  source: readonly LogicalTrackerBinding[],
  target: readonly LogicalTrackerBinding[],
): void {
  for (const sourceBinding of source) {
    const targetBinding = findByTracker(target, sourceBinding.trackerId);
    if (targetBinding && targetBinding.remoteId !== sourceBinding.remoteId) {
      throw new TrackerBindingError(
        "TARGET_TRACKER_CONFLICT",
        `Target tracker ${sourceBinding.trackerId} is bound to a different remote identity`,
      );
    }
  }
}

function assertApplyState(
  plan: MangaTrackerBindingPlan,
  sourceCurrent: readonly LogicalTrackerBinding[],
  targetCurrent: readonly LogicalTrackerBinding[],
): void {
  if (!isSubset(plan.targetBefore, targetCurrent)
    || !isSubset(targetCurrent, plan.targetAfter)) {
    throw new TrackerBindingError(
      "STATE_DRIFT",
      "Target tracker bindings changed after the migration plan was prepared",
    );
  }

  if (plan.mode === "copy") {
    if (!bindingsEqual(sourceCurrent, plan.sourceBefore)) {
      throw new TrackerBindingError(
        "STATE_DRIFT",
        "Source tracker bindings changed after the copy plan was prepared",
      );
    }
    return;
  }

  if (!isSubset(sourceCurrent, plan.sourceBefore)) {
    throw new TrackerBindingError(
      "STATE_DRIFT",
      "Source tracker bindings contain an unexpected identity",
    );
  }

  for (const missing of plan.sourceBefore.filter(
    (binding) => !findByTracker(sourceCurrent, binding.trackerId),
  )) {
    const targetBinding = findByTracker(targetCurrent, missing.trackerId);
    if (!targetBinding || targetBinding.remoteId !== missing.remoteId) {
      throw new TrackerBindingError(
        "STATE_DRIFT",
        "A source tracker binding disappeared before it was present on the target",
      );
    }
  }
}

function assertCompensationState(
  plan: MangaTrackerBindingPlan,
  sourceCurrent: readonly LogicalTrackerBinding[],
  targetCurrent: readonly LogicalTrackerBinding[],
): void {
  if (!isSubset(sourceCurrent, plan.sourceBefore)) {
    throw new TrackerBindingError(
      "STATE_DRIFT",
      "Source tracker bindings contain an identity outside the migration plan",
    );
  }
  if (!isSubset(plan.targetBefore, targetCurrent)
    || !isSubset(targetCurrent, plan.targetAfter)) {
    throw new TrackerBindingError(
      "STATE_DRIFT",
      "Target tracker bindings cannot be compensated without overwriting external changes",
    );
  }
}

async function readLogical(
  port: MangaTrackerBindingPort,
  mangaId: number,
  owner: string,
): Promise<LogicalTrackerBinding[]> {
  return logicalFromRecords(await port.list(mangaId), owner);
}

async function readRecords(
  port: MangaTrackerBindingPort,
  mangaId: number,
  owner: string,
): Promise<TrackerBindingRecord[]> {
  return normalizeRecords(await port.list(mangaId), owner);
}

async function bindMissing(
  port: MangaTrackerBindingPort,
  mangaId: number,
  expected: readonly LogicalTrackerBinding[],
  owner: string,
): Promise<void> {
  let current = await readLogical(port, mangaId, owner);
  for (const expectedBinding of expected) {
    const currentBinding = findByTracker(current, expectedBinding.trackerId);
    if (currentBinding) {
      if (currentBinding.remoteId !== expectedBinding.remoteId) {
        throw new TrackerBindingError(
          "STATE_DRIFT",
          `${owner} tracker ${expectedBinding.trackerId} changed identity`,
        );
      }
      continue;
    }
    await port.bind(mangaId, expectedBinding);
    current = mergeBindings(current, [expectedBinding]);
  }
}

async function unbindLogical(
  port: MangaTrackerBindingPort,
  mangaId: number,
  bindings: readonly LogicalTrackerBinding[],
  owner: string,
): Promise<void> {
  for (const binding of bindings) {
    const current = await readRecords(port, mangaId, owner);
    const record = current.find(
      (candidate) => candidate.trackerId === binding.trackerId,
    );
    if (!record) continue;
    if (record.remoteId !== binding.remoteId) {
      throw new TrackerBindingError(
        "STATE_DRIFT",
        `${owner} tracker ${binding.trackerId} changed identity`,
      );
    }
    await port.unbind(record.recordId);
  }
}

export function createGraphqlMangaTrackerBindingPort(
  gql: TrackerBindingGql,
): MangaTrackerBindingPort {
  return {
    async list(mangaId) {
      const response = await gql<GetMangaTrackRecordsResponse>(
        GET_MANGA_TRACK_RECORDS,
        { mangaId },
      );
      const nodes = response.manga?.trackRecords.nodes ?? [];
      return nodes.map((record) => ({
        recordId: record.id,
        trackerId: record.trackerId,
        remoteId: record.remoteId,
      }));
    },

    async bind(mangaId, binding) {
      const response = await gql<BindTrackResponse>(BIND_TRACK, {
        mangaId,
        trackerId: binding.trackerId,
        remoteId: binding.remoteId,
      });
      const record = response.bindTrack.trackRecord;
      return {
        recordId: record.id,
        trackerId: record.trackerId,
        remoteId: record.remoteId,
      };
    },

    async unbind(recordId) {
      await gql(UNBIND_TRACK, { recordId });
    },
  };
}

export async function prepareMangaTrackerBindingPlan(
  port: MangaTrackerBindingPort,
  input: PrepareMangaTrackerBindingPlanInput,
): Promise<MangaTrackerBindingPlan> {
  if (input.sourceMangaId === input.targetMangaId) {
    throw new TrackerBindingError(
      "SAME_MANGA",
      "Source and target manga must be different",
    );
  }

  const [sourceBefore, targetBefore] = await Promise.all([
    readLogical(port, input.sourceMangaId, "source manga"),
    readLogical(port, input.targetMangaId, "target manga"),
  ]);
  assertTargetHasNoConflicts(sourceBefore, targetBefore);

  const targetBindingsToCreate = sourceBefore.filter(
    (binding) => !findByTracker(targetBefore, binding.trackerId),
  );
  const targetAfter = mergeBindings(targetBefore, targetBindingsToCreate);
  const sourceBindingsToRemove = input.mode === "migrate"
    ? sourceBefore.map(cloneLogical)
    : [];
  const sourceAfter = input.mode === "migrate"
    ? []
    : sourceBefore.map(cloneLogical);

  return {
    ...input,
    sourceBefore,
    targetBefore,
    sourceAfter,
    targetAfter,
    targetBindingsToCreate,
    sourceBindingsToRemove,
  };
}

export async function verifyMangaTrackerBindingPlan(
  port: MangaTrackerBindingPort,
  plan: MangaTrackerBindingPlan,
  state: "applied" | "compensated" = "applied",
): Promise<void> {
  const [sourceCurrent, targetCurrent] = await Promise.all([
    readLogical(port, plan.sourceMangaId, "source manga"),
    readLogical(port, plan.targetMangaId, "target manga"),
  ]);
  const expectedSource = state === "applied" ? plan.sourceAfter : plan.sourceBefore;
  const expectedTarget = state === "applied" ? plan.targetAfter : plan.targetBefore;

  if (!bindingsEqual(sourceCurrent, expectedSource)
    || !bindingsEqual(targetCurrent, expectedTarget)) {
    throw new TrackerBindingError(
      "VERIFICATION_FAILED",
      `Tracker bindings do not match the ${state} migration state`,
    );
  }
}

export async function applyMangaTrackerBindingPlan(
  port: MangaTrackerBindingPort,
  plan: MangaTrackerBindingPlan,
): Promise<void> {
  try {
    const [sourceCurrent, targetCurrent] = await Promise.all([
      readLogical(port, plan.sourceMangaId, "source manga"),
      readLogical(port, plan.targetMangaId, "target manga"),
    ]);
    assertApplyState(plan, sourceCurrent, targetCurrent);

    await bindMissing(
      port,
      plan.targetMangaId,
      plan.targetAfter,
      "target manga",
    );

    const targetAfterBind = await readLogical(
      port,
      plan.targetMangaId,
      "target manga",
    );
    if (!bindingsEqual(targetAfterBind, plan.targetAfter)) {
      throw new TrackerBindingError(
        "VERIFICATION_FAILED",
        "Target tracker bindings were not verified before source cleanup",
      );
    }

    if (plan.mode === "migrate") {
      await unbindLogical(
        port,
        plan.sourceMangaId,
        plan.sourceBindingsToRemove,
        "source manga",
      );
    }

    await verifyMangaTrackerBindingPlan(port, plan, "applied");
  } catch (error) {
    if (error instanceof TrackerBindingError
      && (error.code === "STATE_DRIFT"
        || error.code === "VERIFICATION_FAILED")) {
      throw error;
    }
    throw new TrackerBindingError(
      "APPLY_FAILED",
      "Failed to apply manga tracker bindings",
      error,
    );
  }
}

export async function compensateMangaTrackerBindingPlan(
  port: MangaTrackerBindingPort,
  plan: MangaTrackerBindingPlan,
): Promise<void> {
  try {
    const [sourceCurrent, targetCurrent] = await Promise.all([
      readLogical(port, plan.sourceMangaId, "source manga"),
      readLogical(port, plan.targetMangaId, "target manga"),
    ]);
    assertCompensationState(plan, sourceCurrent, targetCurrent);

    // Restore the source first so compensation never leaves the identity unbound.
    await bindMissing(
      port,
      plan.sourceMangaId,
      plan.sourceBefore,
      "source manga",
    );
    const restoredSource = await readLogical(
      port,
      plan.sourceMangaId,
      "source manga",
    );
    if (!bindingsEqual(restoredSource, plan.sourceBefore)) {
      throw new TrackerBindingError(
        "VERIFICATION_FAILED",
        "Source tracker bindings were not restored before target cleanup",
      );
    }

    await bindMissing(
      port,
      plan.targetMangaId,
      plan.targetBefore,
      "target manga",
    );
    await unbindLogical(
      port,
      plan.targetMangaId,
      plan.targetBindingsToCreate,
      "target manga",
    );

    await verifyMangaTrackerBindingPlan(port, plan, "compensated");
  } catch (error) {
    if (error instanceof TrackerBindingError
      && (error.code === "STATE_DRIFT"
        || error.code === "VERIFICATION_FAILED")) {
      throw error;
    }
    throw new TrackerBindingError(
      "COMPENSATION_FAILED",
      "Failed to compensate manga tracker bindings",
      error,
    );
  }
}
