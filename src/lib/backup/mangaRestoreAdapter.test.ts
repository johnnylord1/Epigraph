import { describe, expect, it, vi } from "vitest";
import { createMangaRestoreAdapter } from "./mangaRestoreAdapter";
import { createRestoreJournal } from "./restoreJournal";
import { createRestoreOperation, restoreDigest } from "./restoreOperation";

function fixture() {
  const raw = new Map<string, string>();
  const journal = createRestoreJournal({ read: async id => raw.get(id) ?? null, compareAndSwap: async (id, expected, next) => {
    if ((raw.has(id) ? await restoreDigest(raw.get(id)!) : null) !== expected) throw Error("conflict"); raw.set(id, next);
  } });
  const target = { profileId: "test", storageScope: "fixture", connectionGeneration: "one", backendGeneration: "one", runtimeIdentityDigest: "f".repeat(64) };
  const context = { target, journal, list: async () => Promise.all([...raw.keys()].map(id => journal.read(id))).then(records => records.filter(Boolean)),
    putInput: vi.fn(async () => {}), settleTerminal: vi.fn(async () => {}), admit: async () => async () => {}, validateTarget: async () => target };
  const send = vi.fn(async (intent: any) => {
    const records = await context.list();
    expect(records[0]!.units[0].submissionIntent?.clientMutationId).toBe(intent.clientMutationId);
    return { id: "restore-1", clientMutationId: intent.clientMutationId, status: { state: "SUCCESS", totalManga: 1, mangaProgress: 1 } };
  });
  const status = vi.fn(async () => ({ state: "SUCCESS", totalManga: 1, mangaProgress: 1 }));
  const adapter = () => createMangaRestoreAdapter({ open: async () => context as any, transport: () => ({ send, status, generation: async () => target.backendGeneration }) });
  return { raw, context, target, send, status, adapter };
}
describe("Manga adapter durable submission boundary", () => {
  it("reconciles a validated pristine journal without submitting during observation", async () => {
    const f = fixture(); const file = new File(["pristine"], "pristine.tachibk");
    await createRestoreOperation(f.context.journal, {} as any).inspect([{ digest: await restoreDigest(await file.arrayBuffer()), size: file.size }], f.target);
    expect(await f.adapter().restore(file, { observationOnly: true })).toMatchObject({ status: "failed", provenNotAccepted: true });
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("does not turn unreadable history into permission to submit", async () => {
    const f = fixture();
    f.context.list = async () => { throw Error("JOURNAL_CORRUPT"); };
    await expect(f.adapter().restore(new File(["backup"], "backup.tachibk"))).rejects.toThrow("JOURNAL_CORRUPT");
    expect(f.context.putInput).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("classifies failed input persistence as not submitted only after reading clean history", async () => {
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    f.context.putInput.mockRejectedValueOnce(Error("disk full"));
    await expect(f.adapter().restore(file)).rejects.toMatchObject({ provenNotAccepted: true });
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("checkpoints intent before its only send, and presents completed history without replay", async () => {
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.context.settleTerminal).toHaveBeenCalled();
  });
  it("continues a pristine inspected record after a crash before configuration", async () => {
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    const operation = createRestoreOperation(f.context.journal, {} as any);
    await operation.inspect([{ digest: await restoreDigest(await file.arrayBuffer()), size: file.size }], f.target);
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.raw.size).toBe(1);
  });
  it("an explicit observation-only retry never creates or submits a missing record", async () => {
    const f = fixture();
    expect((await f.adapter().restore(new File(["backup"], "backup.tachibk"), { observationOnly: true })).status).toBe("unknown");
    expect(f.send).not.toHaveBeenCalled(); expect(f.raw.size).toBe(0);
  });
  it("observation-only cannot retry even a proven-not-accepted submission", async () => {
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    const operation = createRestoreOperation(f.context.journal, {
      admit: f.context.admit, validate: async () => {}, reconcile: async () => ({ status: "unknown", code: "UNKNOWN" }),
      execute: async () => ({ status: "failed", code: "BACKEND_GENERATION_CHANGED", provenNotAccepted: true }),
    });
    let record = await operation.inspect([{ digest: await restoreDigest(await file.arrayBuffer()), size: file.size }], f.target);
    record = await operation.configure(record.operationId, { selections: ["manga"], requirements: [], units: [{ kind: "suwayomi-restore", domain: "manga", inputDigest: record.inputs[0].digest, identity: record.inputs[0].digest, dependsOn: [] }] }, record.revision);
    await operation.start(record.operationId);
    expect((await f.adapter().restore(file, { observationOnly: true })).status).toBe("unknown");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("retains lost-response ambiguity across a new adapter instance", async () => {
    const f = fixture(); f.send.mockRejectedValueOnce(Error("lost"));
    const file = new File(["backup"], "backup.tachibk");
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.status).not.toHaveBeenCalled();
  });
  it("does not reuse a stale external reference when the backend generation changes", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async intent => ({ id: "restore-1", clientMutationId: intent.clientMutationId, status: { state: "IDLE", totalManga: 1, mangaProgress: 0 } }));
    f.status.mockResolvedValueOnce(null as any);
    const file = new File(["backup"], "backup.tachibk");
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    f.target.backendGeneration = "two";
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.status).toHaveBeenCalledOnce();
  });
});
