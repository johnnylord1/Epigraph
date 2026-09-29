import { afterEach, describe, expect, it, vi } from "vitest";
import { store } from "../../store/state.svelte";
import { createProductionRestoreTransport } from "./restoreTransport";
import { createSuwayomiRestoreRuntime, type RestoreSubmissionIntent } from "./restoreRuntime";

const target = { profileId: "main", storageScope: "fixture", connectionGeneration: "connection-1", backendGeneration: "backend-1", runtimeIdentityDigest: "a".repeat(64) };
const intent: RestoreSubmissionIntent = { operationId: "061c7df3-3534-4131-807c-13a997335a27", unitId: "4974ef2c-5283-4dcb-83d0-ff7c20fc3bf9", attemptId: "4cc7b99c-c83c-400d-ad10-f4f097c2dd03", inputDigest: "b".repeat(64), target, flags: {}, clientMutationId: "4cc7b99c-c83c-400d-ad10-f4f097c2dd03" };
function setup() {
  store.runtimeServerUrl = "http://127.0.0.1:51001";
  store.runtimeResolvedLocalProfileId = "main";
  const events: string[] = [];
  let generation: string | null = target.backendGeneration;
  const transport = createProductionRestoreTransport({
    file: new File(["fixture"], "fixture.tachibk"), target,
    validateAdmission: async () => ({ ...target, backendGeneration: generation }),
  });
  const runtime = createSuwayomiRestoreRuntime({ transport,
    checkpointIntent: async () => { events.push("intent"); },
    checkpointExternal: async (reference) => { events.push(`reference:${reference.restoreId}:${reference.lastStatus}`); },
    initialDelayMs: 1, maxDelayMs: 1, requestTimeoutMs: 50, deadlineMs: 100,
  });
  return { events, transport, runtime, changeGeneration: () => { generation = "backend-2"; } };
}
afterEach(() => {
  store.runtimeServerUrl = null; store.runtimeResolvedLocalProfileId = null;
  vi.unstubAllGlobals();
});
describe("production restore transport", () => {
  it("persists intent before one multipart send and persists the attributed ID before observation", async () => {
    const f = setup();
    vi.stubGlobal("fetch", async (_url: string, request: RequestInit) => {
      if (request.body instanceof FormData) {
        f.events.push("send");
        const operation = JSON.parse(request.body.get("operations") as string);
        expect(operation.variables.clientMutationId).toBe(intent.attemptId);
        expect(operation.query).toContain("clientMutationId");
        expect(JSON.parse(request.body.get("map") as string)).toEqual({ "0": ["variables.backup"] });
        return new Response(JSON.stringify({ data: { restoreBackup: { id: "123", clientMutationId: intent.attemptId, status: { state: "RESTORING_MANGA", mangaProgress: 0, totalManga: 1 } } } }));
      }
      f.events.push("observe");
      return new Response(JSON.stringify({ data: { restoreStatus: { state: "SUCCESS", mangaProgress: 1, totalManga: 1 } } }));
    });
    expect((await f.runtime.submit(intent)).status).toBe("succeeded");
    expect(f.events.slice(0, 3)).toEqual(["intent", "send", "reference:123:null"]);
    expect(f.events.filter((event) => event === "send")).toHaveLength(1);
    expect(f.events.indexOf("observe")).toBeGreaterThan(f.events.indexOf("reference:123:null"));
  });
  it("does not transparently retry a lost multipart response", async () => {
    const f = setup(); let sends = 0;
    vi.stubGlobal("fetch", async () => { sends++; throw new TypeError("response lost"); });
    expect(await f.runtime.submit(intent)).toMatchObject({ status: "unknown", code: "SUBMISSION_UNCERTAIN" });
    expect(sends).toBe(1);
  });
  it("refuses a captured request after a profile/server change without a send", async () => {
    const f = setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    store.runtimeServerUrl = "http://127.0.0.1:51002";
    await expect(f.transport.send(intent)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not query an old restore ID after native backend generation changes", async () => {
    const f = setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); f.changeGeneration();
    expect(await f.runtime.resume({ restoreId: "123", clientMutationId: intent.attemptId, backendGeneration: "backend-1", submittedAt: "2026-09-06T00:00:00.000Z", lastStatus: "IDLE", lastObservedAt: null, totalManga: null, mangaProgress: null }, intent)).toMatchObject({ status: "unknown", code: "BACKEND_GENERATION_CHANGED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
