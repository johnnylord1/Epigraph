import { describe, expect, it, vi } from "vitest";
import { createSuwayomiRestoreRuntime, type RestoreSubmissionIntent, type SuwayomiRestoreStatus } from "./restoreRuntime";
import type { RestoreExternalReference } from "./restoreOperation";

const intent: RestoreSubmissionIntent = {
  operationId: "op", unitId: "unit", attemptId: "attempt", inputDigest: "digest",
  target: { profileId: "p", storageScope: "s", connectionGeneration: "c", backendGeneration: "g", runtimeIdentityDigest: "r" },
  flags: { manga: true }, clientMutationId: "attempt",
};
const success: SuwayomiRestoreStatus = { state: "SUCCESS", totalManga: 0, mangaProgress: 0 };
function fixture() {
  let time = 0;
  const events: string[] = [];
  const refs: RestoreExternalReference[] = [];
  const transport = {
    send: vi.fn(async () => { events.push("send"); return { id: "123", clientMutationId: "attempt", status: success }; }),
    status: vi.fn(async (): Promise<SuwayomiRestoreStatus | null> => success),
    generation: vi.fn(async (): Promise<string | null> => "g"),
  };
  const checkpointIntent = vi.fn(async () => { events.push("intent"); });
  const checkpointExternal = vi.fn(async (ref: RestoreExternalReference) => { refs.push(structuredClone(ref)); events.push("reference"); });
  const runtime = createSuwayomiRestoreRuntime({ transport, checkpointIntent, checkpointExternal,
    now: () => time, sleep: async (ms) => { time += ms; }, deadlineMs: 10, initialDelayMs: 2, maxDelayMs: 4 });
  return { runtime, transport, events, refs, checkpointIntent, checkpointExternal };
}
describe("Suwayomi restore submission and observation", () => {
  it("does not accept a terminal checkpoint from a different backend generation", async () => {
    const f = fixture(); f.transport.generation.mockResolvedValue("other");
    expect(await f.runtime.resume({ restoreId: "123", clientMutationId: "attempt", backendGeneration: "g",
      submittedAt: "2026-09-08T00:00:00.000Z", lastStatus: "SUCCESS", lastObservedAt: "2026-09-08T00:00:01.000Z",
      totalManga: 1, mangaProgress: 1 }, intent)).toMatchObject({ status: "unknown", code: "BACKEND_GENERATION_CHANGED" });
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.transport.status).not.toHaveBeenCalled();
  });
  it.each(["SUCCESS", "FAILURE"])("preserves a durably observed terminal %s across status expiry", async state => {
    const f = fixture(); f.transport.status.mockResolvedValue(null);
    const result = await f.runtime.resume({ restoreId: "123", clientMutationId: "attempt", backendGeneration: "g",
      submittedAt: "2026-09-08T00:00:00.000Z", lastStatus: state, lastObservedAt: "2026-09-08T00:00:01.000Z",
      totalManga: 1, mangaProgress: 1 }, intent);
    expect(result.status).toBe(state === "SUCCESS" ? "succeeded" : "failed");
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.transport.status).not.toHaveBeenCalled();
  });
  it("persists complete intent before one submission and reference before terminal evidence", async () => {
    const f = fixture();
    expect(await f.runtime.submit(intent)).toMatchObject({ status: "succeeded" });
    expect(f.checkpointIntent).toHaveBeenCalledWith(intent);
    expect(f.events.slice(0, 3)).toEqual(["intent", "send", "reference"]);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(f.transport.status).not.toHaveBeenCalled();
    expect(f.refs[0].lastStatus).toBeNull();
    expect(f.refs.at(-1)?.lastStatus).toBe("SUCCESS");
  });
  it("does not submit when intent persistence fails", async () => {
    const f = fixture(); f.checkpointIntent.mockRejectedValue(new Error("disk"));
    await expect(f.runtime.submit(intent)).rejects.toThrow();
    expect(f.transport.send).not.toHaveBeenCalled();
  });
  it("does not replay a lost response", async () => {
    const f = fixture(); f.transport.send.mockRejectedValue(new Error("token=secret"));
    expect(await f.runtime.submit(intent)).toEqual({ status: "unknown", code: "SUBMISSION_UNCERTAIN" });
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it("persists returned ID but refuses a wrong echoed nonce", async () => {
    const f = fixture(); f.transport.send.mockResolvedValue({ id: "123", clientMutationId: "wrong", status: success });
    expect(await f.runtime.submit(intent)).toMatchObject({ status: "unknown", code: "SUBMISSION_ATTRIBUTION_FAILED" });
    expect(f.refs[0].restoreId).toBe("123");
    expect(f.refs[0].clientMutationId).toBe("wrong");
  });
  it("consumes FAILURE in initial response", async () => {
    const f = fixture(); f.transport.send.mockResolvedValue({ id: "123", clientMutationId: "attempt", status: { ...success, state: "FAILURE" } });
    expect(await f.runtime.submit(intent)).toMatchObject({ status: "failed", code: "BACKEND_RESTORE_FAILURE" });
  });
  it("does not accept success if the backend generation changed during send", async () => {
    const f = fixture(); f.transport.generation.mockResolvedValueOnce("g").mockResolvedValueOnce("g").mockResolvedValue("other");
    expect(await f.runtime.submit(intent)).toMatchObject({ status: "unknown", code: "BACKEND_GENERATION_CHANGED" });
  });
  it("rechecks backend identity after durable intent persistence before sending", async () => {
    const f = fixture();
    f.checkpointIntent.mockImplementation(async () => { f.transport.generation.mockResolvedValue("other"); });
    expect(await f.runtime.submit(intent)).toMatchObject({ status: "failed", code: "BACKEND_GENERATION_CHANGED", provenNotAccepted: true });
    expect(f.transport.send).not.toHaveBeenCalled();
  });
  it("resumes only the known ID without sending", async () => {
    const f = fixture();
    expect(await f.runtime.resume({ restoreId: "123", clientMutationId: "attempt", backendGeneration: "g", submittedAt: "then", lastStatus: null, lastObservedAt: null, totalManga: null, mangaProgress: null }, intent)).toMatchObject({ status: "succeeded" });
    expect(f.transport.send).not.toHaveBeenCalled(); expect(f.transport.status).toHaveBeenCalledWith("123");
  });
  it("treats expired or missing status as unknown", async () => {
    const f = fixture(); f.transport.status.mockResolvedValue(null);
    expect(await f.runtime.resume({ restoreId: "123", clientMutationId: "attempt", backendGeneration: "g", submittedAt: "then", lastStatus: null, lastObservedAt: null, totalManga: null, mangaProgress: null }, intent)).toMatchObject({ status: "unknown", code: "BACKEND_STATUS_MISSING" });
  });
  it("bounds observation and retains the last pending status without remote cancellation", async () => {
    const f = fixture(); f.transport.status.mockResolvedValue({ ...success, state: "RESTORING_MANGA" });
    expect(await f.runtime.resume({ restoreId: "123", clientMutationId: "attempt", backendGeneration: "g", submittedAt: "then", lastStatus: null, lastObservedAt: null, totalManga: null, mangaProgress: null }, intent)).toMatchObject({ status: "unknown", code: "OBSERVATION_TIMEOUT" });
    expect(f.refs.at(-1)?.lastStatus).toBe("RESTORING_MANGA"); expect(f.transport.send).not.toHaveBeenCalled();
  });
  it("cannot upgrade a mismatched returned nonce on resume", async () => {
    const f = fixture();
    expect(await f.runtime.resume({ restoreId: "123", clientMutationId: "wrong", backendGeneration: "g", submittedAt: "then", lastStatus: null, lastObservedAt: null, totalManga: null, mangaProgress: null }, intent)).toMatchObject({ status: "unknown", code: "SUBMISSION_ATTRIBUTION_FAILED" });
    expect(f.transport.status).not.toHaveBeenCalled();
  });
  it("refuses missing backend identity before submission", async () => {
    const f = fixture();
    expect(await f.runtime.submit({ ...intent, target: { ...intent.target, backendGeneration: null } })).toMatchObject({ status: "failed", provenNotAccepted: true });
    expect(f.transport.send).not.toHaveBeenCalled();
  });
  it("never reports success if external evidence cannot be persisted", async () => {
    const f = fixture(); f.checkpointExternal.mockRejectedValue(new Error("disk"));
    await expect(f.runtime.submit(intent)).rejects.toThrow("disk");
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });
  it("refuses generation drift while querying status", async () => {
    const f = fixture(); f.transport.generation.mockResolvedValueOnce("g").mockResolvedValue("other");
    expect(await f.runtime.resume({ restoreId: "123", clientMutationId: "attempt", backendGeneration: "g", submittedAt: "then", lastStatus: null, lastObservedAt: null, totalManga: null, mangaProgress: null }, intent)).toMatchObject({ status: "unknown", code: "BACKEND_GENERATION_CHANGED" });
    expect(f.refs).toHaveLength(0);
  });
  it("bounds a hung submission without replaying or late evidence writes", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (response: { id: string; clientMutationId: string; status: SuwayomiRestoreStatus }) => void;
      const send = vi.fn(() => new Promise<{ id: string; clientMutationId: string; status: SuwayomiRestoreStatus }>((done) => { resolve = done; }));
      const checkpointExternal = vi.fn(async () => {});
      const runtime = createSuwayomiRestoreRuntime({ transport: { send, status: async () => success, generation: async () => "g" }, checkpointIntent: async () => {}, checkpointExternal, requestTimeoutMs: 5 });
      const pending = runtime.submit(intent);
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ status: "unknown", code: "SUBMISSION_UNCERTAIN" });
      resolve({ id: "123", clientMutationId: "attempt", status: success });
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(1); expect(checkpointExternal).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
