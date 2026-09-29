import type { RestoreExternalReference, RestoreTarget, RestoreUnitResult } from "./restoreOperation";

export interface RestoreSubmissionIntent {
  operationId: string; unitId: string; attemptId: string; inputDigest: string;
  target: RestoreTarget; flags: Record<string, boolean>; clientMutationId: string;
}
export interface SuwayomiRestoreStatus { state: string; totalManga: number; mangaProgress: number }
export interface RestoreTransport {
  send(intent: RestoreSubmissionIntent): Promise<{ id: string; clientMutationId: string | null; status: SuwayomiRestoreStatus | null }>;
  status(id: string): Promise<SuwayomiRestoreStatus | null>;
  generation(): Promise<string | null>;
}
export interface RestoreObservationOptions {
  transport: RestoreTransport;
  checkpointIntent(intent: RestoreSubmissionIntent): Promise<void>;
  checkpointExternal(reference: RestoreExternalReference): Promise<void>;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number; requestTimeoutMs?: number; initialDelayMs?: number; maxDelayMs?: number;
}
/** Transport must disable submission retries and bind every request to its captured target. */
export function createSuwayomiRestoreRuntime(options: RestoreObservationOptions) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadlineMs = options.deadlineMs ?? 15 * 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const initialDelay = options.initialDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 5_000;
  for (const value of [deadlineMs, requestTimeoutMs, initialDelay, maxDelay]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("INVALID_RESTORE_DEADLINE");
  }
  const unknown = (code: string): RestoreUnitResult => ({ status: "unknown", code });
  async function bounded<T>(action: () => Promise<T>, limit = requestTimeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("REQUEST_TIMEOUT")), limit);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function sameGeneration(expected: string, limit?: number): Promise<boolean> {
    try { return !!expected && await bounded(() => options.transport.generation(), limit) === expected; }
    catch { return false; }
  }
  async function consume(reference: RestoreExternalReference, status: SuwayomiRestoreStatus | null): Promise<RestoreUnitResult | null> {
    if (!status) return unknown("BACKEND_STATUS_MISSING");
    const known = ["IDLE", "SUCCESS", "FAILURE", "RESTORING_CATEGORIES", "RESTORING_MANGA", "RESTORING_META", "RESTORING_SETTINGS"];
    if (!known.includes(status.state)) return unknown("BACKEND_STATUS_UNRECOGNIZED");
    reference.lastStatus = status.state;
    reference.lastObservedAt = new Date(now()).toISOString();
    reference.totalManga = Number.isSafeInteger(status.totalManga) && status.totalManga >= 0 ? status.totalManga : null;
    reference.mangaProgress = Number.isSafeInteger(status.mangaProgress) && status.mangaProgress >= 0 ? status.mangaProgress : null;
    await options.checkpointExternal({ ...reference });
    if (status.state === "SUCCESS") return { status: "succeeded", code: "BACKEND_RESTORE_SUCCESS" };
    if (status.state === "FAILURE") return { status: "failed", code: "BACKEND_RESTORE_FAILURE" };
    return null;
  }
  async function observe(original: RestoreExternalReference): Promise<RestoreUnitResult> {
    const reference = { ...original };
    if (!reference.restoreId || !reference.clientMutationId || !reference.backendGeneration) return unknown("EXTERNAL_REFERENCE_INCOMPLETE");
    const deadline = now() + deadlineMs;
    let delay = initialDelay;
    while (now() < deadline) {
      if (!await sameGeneration(reference.backendGeneration, Math.min(requestTimeoutMs, deadline - now()))) return unknown("BACKEND_GENERATION_CHANGED");
      if (now() >= deadline) break;
      let status: SuwayomiRestoreStatus | null;
      try { status = await bounded(() => options.transport.status(reference.restoreId), Math.min(requestTimeoutMs, deadline - now())); }
      catch { return unknown("OBSERVATION_REQUEST_UNCERTAIN"); }
      if (now() >= deadline) break;
      if (!await sameGeneration(reference.backendGeneration, Math.min(requestTimeoutMs, deadline - now()))) return unknown("BACKEND_GENERATION_CHANGED");
      const result = await consume(reference, status);
      if (result) return result;
      await sleep(Math.min(delay, Math.max(0, deadline - now())));
      delay = Math.min(maxDelay, delay * 2);
    }
    return unknown("OBSERVATION_TIMEOUT");
  }
  return {
    async submit(input: RestoreSubmissionIntent): Promise<RestoreUnitResult> {
      const intent = structuredClone(input);
      if (!intent.operationId || !intent.unitId || !intent.attemptId || !intent.inputDigest || intent.clientMutationId !== intent.attemptId) {
        return { status: "failed", code: "INVALID_SUBMISSION_INTENT", provenNotAccepted: true };
      }
      const generation = intent.target.backendGeneration;
      if (!generation || !await sameGeneration(generation)) return { status: "failed", code: "BACKEND_GENERATION_CHANGED", provenNotAccepted: true };
      await options.checkpointIntent(structuredClone(intent));
      if (!await sameGeneration(generation)) return { status: "failed", code: "BACKEND_GENERATION_CHANGED", provenNotAccepted: true };
      const submittedAt = new Date(now()).toISOString();
      let response: Awaited<ReturnType<RestoreTransport["send"]>>;
      try { response = await bounded(() => options.transport.send(intent)); }
      catch { return unknown("SUBMISSION_UNCERTAIN"); }
      if (!response || typeof response.id !== "string" || !response.id || response.id.length > 256) return unknown("SUBMISSION_REFERENCE_MISSING");
      const reference: RestoreExternalReference = {
        restoreId: response.id, clientMutationId: typeof response.clientMutationId === "string" && response.clientMutationId ? response.clientMutationId.slice(0, 256) : null,
        backendGeneration: generation, submittedAt, lastStatus: null, lastObservedAt: null, totalManga: null, mangaProgress: null,
      };
      // Preserve returned evidence even when it cannot authorize further observation.
      await options.checkpointExternal({ ...reference });
      if (response.clientMutationId !== intent.clientMutationId) return unknown("SUBMISSION_ATTRIBUTION_FAILED");
      if (!await sameGeneration(generation)) return unknown("BACKEND_GENERATION_CHANGED");
      const result = await consume(reference, response.status);
      return result ?? observe(reference);
    },
    async resume(reference: RestoreExternalReference, expectedIntent: RestoreSubmissionIntent): Promise<RestoreUnitResult> {
      reference = structuredClone(reference);
      expectedIntent = structuredClone(expectedIntent);
      if (!expectedIntent?.attemptId || reference.clientMutationId !== expectedIntent.attemptId
        || expectedIntent.clientMutationId !== expectedIntent.attemptId
        || reference.backendGeneration !== expectedIntent.target.backendGeneration) {
        return unknown("SUBMISSION_ATTRIBUTION_FAILED");
      }
      // The adapter supplies this reference from the validated durable journal.
      // An acknowledged terminal observation survives the server's status TTL.
      if (reference.restoreId && reference.lastObservedAt
        && Number.isFinite(Date.parse(reference.submittedAt))
        && Date.parse(reference.lastObservedAt) >= Date.parse(reference.submittedAt)
        && ["SUCCESS", "FAILURE"].includes(reference.lastStatus ?? "")) {
        if (!await sameGeneration(reference.backendGeneration)) return unknown("BACKEND_GENERATION_CHANGED");
        return reference.lastStatus === "SUCCESS"
          ? { status: "succeeded", code: "BACKEND_RESTORE_SUCCESS" }
          : { status: "failed", code: "BACKEND_RESTORE_FAILURE" };
      }
      return observe(reference);
    },
  };
}
