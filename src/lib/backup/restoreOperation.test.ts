import { describe, expect, it } from "vitest";
import { createRestoreJournal, type RestoreJournalStorage } from "./restoreJournal";
import { RestoreError, restoreDigest, createRestoreOperation, type RestoreRecord, type RestoreUnit, type RestoreOperationRuntime } from "./restoreOperation";

function storage() {
  const files = new Map<string, string>();
  const adapter: RestoreJournalStorage = {
    async read(id) { return files.get(id) ?? null; },
    async compareAndSwap(id, expected, next) {
      const current = files.get(id);
      const digest = current === undefined ? null : await restoreDigest(current);
      // Recheck after the await, as a native locked CAS must do.
      if (digest !== expected || files.get(id) !== current) throw new RestoreError("JOURNAL_CONFLICT");
      files.set(id, next);
    },
  };
  return { files, adapter };
}

function record(): RestoreRecord {
  return {
    schemaVersion: 1, operationId: "d62e6076-d6e4-4771-b6fa-bfc55b0a91f1",
    revision: 0, previousRevision: null,
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
    phase: "inspected", outcome: "NOT_TESTED",
    target: { profileId: "test", storageScope: "test-fixture", connectionGeneration: "connection-1", backendGeneration: "backend-1", runtimeIdentityDigest: "a".repeat(64) },
    inputs: [{ digest: "b".repeat(64), size: 1 }], planDigest: "c".repeat(64),
    selections: [], requirements: [], units: [], cancellationRequestedAt: null, recoveryCodes: [],
  };
}

describe("durable restore journal", () => {
  it("round trips operation identity and rejects a stale revision without changing the winner", async () => {
    const { adapter } = storage();
    const journal = createRestoreJournal(adapter);
    const first = record();
    await journal.write(first, null);
    const winner = { ...first, revision: 1, previousRevision: 0, phase: "ready" as const };
    await journal.write(winner, 0);
    await expect(journal.write({ ...winner, phase: "cancelled" }, 0)).rejects.toMatchObject({ code: "JOURNAL_CONFLICT" });
    expect(await journal.read(first.operationId)).toEqual(winner);
  });

  it("allows only one of two concurrent writers to publish the next revision", async () => {
    const { adapter } = storage();
    const a = createRestoreJournal(adapter), b = createRestoreJournal(adapter);
    const first = record();
    await a.write(first, null);
    const next = { ...first, revision: 1, previousRevision: 0 };
    const results = await Promise.allSettled([a.write(next, 0), b.write(next, 0)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it.each(["{", '{"schemaVersion":1}', "null"])("preserves malformed journal %s and refuses fresh creation", async (corrupt) => {
    const { adapter, files } = storage();
    const first = record();
    files.set(first.operationId, corrupt);
    const journal = createRestoreJournal(adapter);
    await expect(journal.read(first.operationId)).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
    await expect(journal.write(first, null)).rejects.toThrow();
    expect(files.get(first.operationId)).toBe(corrupt);
  });

  it("rejects a changed payload under an unchanged checksum", async () => {
    const { adapter, files } = storage();
    const journal = createRestoreJournal(adapter), first = record();
    await journal.write(first, null);
    const raw = files.get(first.operationId)!;
    files.set(first.operationId, raw.replace('"inspected"', '"completed"'));
    await expect(journal.read(first.operationId)).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
  });

  it("does not accept PASS while an operation is still running", async () => {
    const { adapter, files } = storage();
    const journal = createRestoreJournal(adapter), first = record();
    await expect(journal.write({ ...first, phase: "running", outcome: "PASS" }, null)).rejects.toMatchObject({ code: "JOURNAL_INVALID" });
    expect(files.size).toBe(0);
  });
});

function unit(id: string, domain: "manga" | "books"): RestoreUnit {
  return {
    unitId: id === "manga" ? "d62e6076-d6e4-4771-b6fa-bfc55b0a91f2" : "d62e6076-d6e4-4771-b6fa-bfc55b0a91f3", parentUnitId: null, kind: `${domain}-commit`, domain, inputDigest: "b".repeat(64),
    identity: id, dependsOn: [], status: "pending", attempts: [], startedAt: null, completedAt: null,
    resultCode: null, errorCode: null, warnings: [], retryPolicy: "never", idempotencyPolicy: "not_proven",
    externalOperationReference: null, beforeDigest: null, expectedAfterDigest: null, observedAfterDigest: null,
  };
}

async function fixture(execute: RestoreOperationRuntime["execute"]) {
  const { adapter } = storage(), journal = createRestoreJournal(adapter);
  const first = { ...record(), phase: "ready" as const, units: [unit("manga", "manga"), unit("books", "books")] };
  await journal.write(first, null);
  const held = new Set<string>();
  const runtime: RestoreOperationRuntime = {
    async admit(target) {
      if (held.has(target.storageScope)) throw new RestoreError("RESTORE_CONFLICT");
      held.add(target.storageScope);
      return async () => { held.delete(target.storageScope); };
    },
    async validate() {}, execute,
    async reconcile() { return { status: "unknown", code: "REMOTE_STATE_UNKNOWN" }; },
  };
  return { journal, first, runtime, operation: createRestoreOperation(journal, runtime) };
}

describe("restore coordinator recovery", () => {
  it("freezes input and plan decisions and refuses stale configuration", async () => {
    const f = await fixture(async () => ({ status: "succeeded", code: "COMMIT_CONFIRMED" }));
    const inspected = await f.operation.inspect(f.first.inputs, f.first.target);
    expect(inspected.phase).toBe("inspected");
    const choices = { selections: ["manga"], requirements: [], units: [{ kind: "manga-commit", domain: "manga" as const, inputDigest: "b".repeat(64), identity: "payload:manga", dependsOn: [] }] };
    const configured = await f.operation.configure(inspected.operationId, choices, 0);
    expect(configured.phase).toBe("ready");
    expect(configured.units).toHaveLength(1);
    await expect(f.operation.configure(inspected.operationId, choices, 0)).rejects.toMatchObject({ code: "JOURNAL_CONFLICT" });
    await f.operation.start(inspected.operationId);
    await expect(f.operation.configure(inspected.operationId, choices, 4)).rejects.toThrow();
  });

  it("does not publish success after the target changed while a mutation was in flight", async () => {
    let changed = false;
    const f = await fixture(async () => { changed = true; return { status: "succeeded", code: "COMMIT_CONFIRMED" }; });
    f.runtime.validate = async () => { if (changed) throw new RestoreError("RESTORE_TARGET_CHANGED"); };
    const result = await f.operation.start(f.first.operationId);
    expect(result.units[0].status).toBe("unknown");
    expect(result.outcome).toBe("PARTIAL");
    expect(result.units[1].status).toBe("pending");
  });

  it("retries only a proven rejected Books commit after Manga succeeded", async () => {
    const calls: string[] = [];
    const f = await fixture(async ({ unit }) => {
      calls.push(unit.domain);
      if (unit.domain === "books" && calls.length === 2) return { status: "failed", code: "REQUEST_REJECTED", provenNotAccepted: true };
      return { status: "succeeded", code: "COMMIT_CONFIRMED" };
    });
    const partial = await f.operation.start(f.first.operationId);
    expect(partial).toMatchObject({ phase: "partially_completed", outcome: "PARTIAL" });
    expect((await f.operation.retryEligible(f.first.operationId)).outcome).toBe("PASS");
    expect(calls).toEqual(["manga", "books", "books"]);
    expect((await f.journal.read(f.first.operationId))!.units.map((u) => u.attempts.length)).toEqual([1, 2]);
  });

  it("does not replay a submission whose response was lost, including after coordinator restart", async () => {
    const calls: string[] = [];
    const f = await fixture(async ({ unit }) => { calls.push(unit.domain); throw new Error("response lost"); });
    await f.operation.start(f.first.operationId);
    const resumed = createRestoreOperation(f.journal, f.runtime);
    await resumed.resume(f.first.operationId);
    await resumed.retryEligible(f.first.operationId);
    expect(calls).toEqual(["manga"]);
    expect((await f.journal.read(f.first.operationId))!.units[0].status).toBe("unknown");
  });

  it("refuses another executor while an admitted unit is active", async () => {
    let entered!: () => void, finish!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const f = await fixture(async () => { entered(); await pending; return { status: "succeeded", code: "COMMIT_CONFIRMED" }; });
    const first = f.operation.start(f.first.operationId);
    await enteredPromise;
    await expect(createRestoreOperation(f.journal, f.runtime).start(f.first.operationId)).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
    finish();
    await first;
  });

  it("cancels before submission without issuing mutations", async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return { status: "succeeded", code: "COMMIT_CONFIRMED" }; });
    await f.operation.requestCancel(f.first.operationId);
    expect((await f.operation.start(f.first.operationId)).phase).toBe("cancelled");
    expect(calls).toBe(0);
  });

  it("stops future units after cancellation without inventing cancellation of accepted work", async () => {
    let entered!: () => void, finish!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const calls: string[] = [];
    const f = await fixture(async ({ unit }) => { calls.push(unit.domain); entered(); await pending; return { status: "succeeded", code: "BACKEND_CONFIRMED_SUCCESS" }; });
    const run = f.operation.start(f.first.operationId);
    await enteredPromise;
    await f.operation.requestCancel(f.first.operationId);
    finish();
    const result = await run;
    expect(calls).toEqual(["manga"]);
    expect(result.units[0].status).toBe("succeeded");
    expect(result.units[1].status).toBe("cancelled");
    expect(result.outcome).toBe("PARTIAL");
  });
});
