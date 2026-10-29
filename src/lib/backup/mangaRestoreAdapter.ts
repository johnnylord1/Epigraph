import { canonicalRestoreJson, createRestoreOperation, restoreDigest, type RestoreExecutionContext, type RestoreRecord, type RestoreTarget, type RestoreUnitResult } from "./restoreOperation";
import { createSuwayomiRestoreRuntime, type RestoreTransport, type SuwayomiRestoreStatus } from "./restoreRuntime";
import type { openNativeRestoreContext } from "./restoreNative";

type NativeContext = Awaited<ReturnType<typeof openNativeRestoreContext>>;

/** The durable v1 envelope is retained only at the external Suwayomi boundary.
 * Local adapters do not create attempts, compensation or per-object journals.
 */
export function createMangaRestoreAdapter(options: {
  open(): Promise<NativeContext>;
  transport(file: File, context: NativeContext, operationId: string): RestoreTransport;
  /** Reads a restore's status from the server the context targets now, outside any admission. */
  status?(context: NativeContext, restoreId: string): Promise<SuwayomiRestoreStatus | null>;
}) {
  // The port and the server process change between launches; the profile's storage does not.
  const sameStorage = (a: RestoreTarget, b: RestoreTarget) => a.profileId === b.profileId && a.storageScope === b.storageScope;
  // Suwayomi keeps restore status only in memory. When the app closes during a restore, the server
  // process that ran it is gone, and a server that outlives it forgets the id after a while: the
  // restore ended without a result. Record that, so restoring again is possible, as in Mihon.
  // Nothing is submitted here.
  async function settleLost(context: NativeContext, record: RestoreRecord) {
    const unit = record.units[0], reference = unit?.externalOperationReference;
    if (record.units.length !== 1 || !["running", "unknown"].includes(unit.status) || !unit.submissionIntent
      || !reference?.restoreId || !reference.lastObservedAt || ["SUCCESS", "FAILURE"].includes(reference.lastStatus ?? "")
      || !sameStorage(record.target, context.target)) return false;
    // Native admits one live server per storage, so another generation means the old process is gone.
    const replaced = reference.backendGeneration !== context.target.backendGeneration;
    if (!replaced && await options.status?.(context, reference.restoreId).catch(() => undefined) !== null) return false;
    const next = await createRestoreOperation(context.journal, {
      admit: context.admit,
      async validate(current) {
        await context.validateTarget(current.operationId); // Refuses without admission.
        if (!sameStorage(current.target, context.target)) throw Error("RESTORE_TARGET_CHANGED");
      },
      execute: async () => ({ status: "unknown", code: "SUBMISSION_UNCERTAIN" }),
      reconcile: async () => ({ status: "failed", code: "BACKEND_RESTORE_LOST" }),
    }).resume(record.operationId);
    return next.phase === "nonretryable_failure";
  }
  return {
    async restore(file: File, mode: { observationOnly?: boolean } = {}): Promise<RestoreUnitResult> {
      const context = await options.open().catch((error: unknown) => {
        // Native commands reject with a bare code; keep it. Opening submits nothing, but an
        // observation must not clear earlier uncertainty.
        const failure = Error(typeof error === "string" && error ? error : error instanceof Error ? error.message : "RESTORE_CONTEXT_UNAVAILABLE");
        throw mode.observationOnly ? failure : Object.assign(failure, { provenNotAccepted: true });
      });
      const input = { digest: await restoreDigest(await file.arrayBuffer()), size: file.size };
      let records = await context.list(); // Malformed history refuses; never silently discard it.
      let settled = false;
      for (const record of records) settled = await settleLost(context, record) || settled;
      if (settled) records = await context.list();
      const matches = records.filter(r => r.inputs.length === 1 && r.inputs[0].digest === input.digest && r.inputs[0].size === input.size);
      const ended = (r: (typeof records)[number]) => r.phase === "completed" || (r.phase === "nonretryable_failure" && ["BACKEND_RESTORE_FAILURE", "BACKEND_RESTORE_LOST"].includes(r.units[0]?.resultCode ?? ""));
      const live = matches.filter(r => !ended(r));
      if (live.length > 1) throw Error("RESTORE_HISTORY_AMBIGUOUS");
      let record = live[0];
      const latestEnded = matches.filter(ended).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!record && latestEnded) {
        await context.settleTerminal(latestEnded.operationId);
        // An observation reports how the last restore of this file ended. Restoring the file
        // again applies it again, as Mihon does: the library may have changed since.
        if (mode.observationOnly) return { status: latestEnded.phase === "completed" ? "succeeded" : "failed", code: latestEnded.units[0]?.resultCode ?? "PREVIOUS_BACKEND_RESTORE_SUCCESS" };
      }
      if (record && canonicalRestoreJson(record.target) !== canonicalRestoreJson(context.target)) return { status: "unknown", code: "BACKEND_GENERATION_CHANGED" };
      if (records.some(r => r.operationId !== record?.operationId && r.units.some(u => ["running", "unknown"].includes(u.status)))) return { status: "unknown", code: "OTHER_EXTERNAL_RESTORE_UNRESOLVED" };
      if (mode.observationOnly && record && ["inspected", "ready", "waiting_for_dependencies"].includes(record.phase)
        && !record.cancellationRequestedAt && record.units.every(unit => unit.status === "pending"
          && unit.attempts.length === 0 && !unit.submissionIntent && !unit.externalOperationReference)) {
        // A validated existing pre-attempt record is positive evidence under
        // the intent-before-send contract. Missing history is not that evidence.
        return { status: "failed", code: "SUBMISSION_NOT_STARTED", provenNotAccepted: true };
      }
      if (mode.observationOnly && (!record || record.units.length !== 1 || !["running", "unknown"].includes(record.units[0].status))) return { status: "unknown", code: "SUBMISSION_EVIDENCE_MISSING" };
      const runtimeFor = (execution: RestoreExecutionContext) => createSuwayomiRestoreRuntime({
        transport: options.transport(file, context, execution.record.operationId),
        checkpointIntent: execution.checkpointIntent,
        checkpointExternal: execution.checkpointExternal,
      });
      const operation = createRestoreOperation(context.journal, {
        admit: context.admit,
        async validate(current) {
          const target = await context.validateTarget(current.operationId);
          if (!target || canonicalRestoreJson(target) !== canonicalRestoreJson(current.target)) throw Error("RESTORE_TARGET_CHANGED");
        },
        execute: execution => {
          const attemptId = execution.unit.attempts.at(-1)!.attemptId;
          return runtimeFor(execution).submit({ operationId: execution.record.operationId, unitId: execution.unit.unitId,
            attemptId, clientMutationId: attemptId, inputDigest: input.digest, target: execution.record.target, flags: {} });
        },
        reconcile: execution => execution.unit.externalOperationReference && execution.unit.submissionIntent
          ? runtimeFor(execution).resume(execution.unit.externalOperationReference, execution.unit.submissionIntent)
          : Promise.resolve({ status: "unknown", code: "SUBMISSION_UNCERTAIN" }),
      });
      if (!record) {
        // History was successfully validated above. No execution or submission
        // has started: input/initial-journal persistence cannot accept a restore.
        try {
          await context.putInput(file, input);
          record = await operation.inspect([input], context.target);
        } catch (error) {
          throw Object.assign(new Error(error instanceof Error ? error.message : "RESTORE_PREPARATION_FAILED"), { provenNotAccepted: true });
        }
      }
      if (record.phase === "inspected" && record.units.length === 0) {
        record = await operation.configure(record.operationId, { selections: ["manga"], requirements: [], units: [{
          kind: "suwayomi-restore", domain: "manga", inputDigest: input.digest, identity: input.digest, dependsOn: [],
        }] }, record.revision);
      }
      if (record.units.length !== 1 || record.units[0].domain !== "manga") throw Error("RESTORE_HISTORY_UNSUPPORTED");
      const next = record.units[0].attempts.length ? await operation.resume(record.operationId) : await operation.start(record.operationId);
      const unit = next.units[0];
      return { status: unit.status === "succeeded" ? "succeeded" : unit.status === "failed" ? "failed" : "unknown",
        code: unit.resultCode ?? "SUBMISSION_UNCERTAIN", provenNotAccepted: unit.retryPolicy === "proven_not_accepted", warnings: unit.warnings };
    },
  };
}

export async function restoreProductionManga(file: File, mode: { observationOnly?: boolean; assertTarget?: () => void } = {}) {
  const [{ store }, { getServerUrl }, { openNativeRestoreContext }, { createProductionRestoreTransport }] = await Promise.all([
    import("../../store/state.svelte"), import("../client"), import("./restoreNative"), import("./restoreTransport"),
  ]);
  mode.assertTarget?.();
  const profileId = store.runtimeResolvedLocalProfileId;
  if (!profileId) throw Error("RESTORE_PROFILE_UNAVAILABLE");
  return createMangaRestoreAdapter({
    open: () => { mode.assertTarget?.(); return openNativeRestoreContext(profileId, getServerUrl()); },
    transport: (file, context, operationId) => createProductionRestoreTransport({ file, target: context.target, validateAdmission: () => { mode.assertTarget?.(); return context.validateTarget(operationId); } }),
    status: (context, restoreId) => createProductionRestoreTransport({ file, target: context.target, validateAdmission: async () => { mode.assertTarget?.(); return context.target; } }).status(restoreId),
  }).restore(file, mode);
}
