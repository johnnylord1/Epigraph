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
    expect(records.some(record => record!.units[0]?.submissionIntent?.clientMutationId === intent.clientMutationId)).toBe(true);
    return { id: "restore-1", clientMutationId: intent.clientMutationId, status: { state: "SUCCESS", totalManga: 1, mangaProgress: 1 } };
  });
  const status = vi.fn(async () => ({ state: "SUCCESS", totalManga: 1, mangaProgress: 1 }));
  const probe = vi.fn(async (_id: string): Promise<any> => ({ state: "RESTORING_MANGA", totalManga: 1, mangaProgress: 0 }));
  const adapter = () => createMangaRestoreAdapter({ open: async () => context as any, transport: () => ({ send, status, generation: async () => target.backendGeneration }),
    status: (_context, id) => probe(id) });
  return { raw, context, target, send, status, probe, adapter };
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
  it("keeps the native code when the desktop target is refused, as not submitted", async () => {
    const f = fixture();
    const refused = (observationOnly: boolean) => createMangaRestoreAdapter({
      open: () => Promise.reject("RESTORE_DESKTOP_TARGET_UNVERIFIED"), transport: () => { throw Error("unreachable"); },
    }).restore(new File(["backup"], "backup.tachibk"), { observationOnly });
    await expect(refused(false)).rejects.toMatchObject({ message: "RESTORE_DESKTOP_TARGET_UNVERIFIED", provenNotAccepted: true });
    await expect(refused(true)).rejects.not.toHaveProperty("provenNotAccepted");
    expect(f.send).not.toHaveBeenCalled();
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
  it("checkpoints intent before its only send, and an observation presents completed history without replay", async () => {
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect((await f.adapter().restore(file, { observationOnly: true })).status).toBe("succeeded");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.context.settleTerminal).toHaveBeenCalled();
  });
  it("applies a backup again when the user restores it again, as Mihon does", async () => {
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.raw.size).toBe(3);
    expect(f.context.settleTerminal).toHaveBeenCalledTimes(2);
    expect((await f.adapter().restore(file, { observationOnly: true })).status).toBe("succeeded");
    expect(f.send).toHaveBeenCalledTimes(3);
  });
  it("resumes an unfinished restore of the file instead of starting another", async () => {
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    f.send.mockRejectedValueOnce(Error("lost"));
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.raw.size).toBe(2);
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
  async function interrupted() {
    // The app closed while the server was restoring; it came back on another port.
    const f = fixture(); const file = new File(["backup"], "backup.tachibk");
    f.send.mockImplementationOnce(async intent => ({ id: "restore-1", clientMutationId: intent.clientMutationId, status: { state: "RESTORING_MANGA", totalManga: 9, mangaProgress: 2 } }));
    f.status.mockRejectedValueOnce(Error("closed"));
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    f.target.connectionGeneration = "two";
    return { ...f, file };
  }
  it("restores again after a restore the restarted server no longer knows, as Mihon does", async () => {
    const f = await interrupted(); f.probe.mockResolvedValueOnce(null);
    expect((await f.adapter().restore(f.file)).status).toBe("succeeded");
    expect(f.probe).toHaveBeenCalledWith("restore-1");
    expect(f.send).toHaveBeenCalledTimes(2);
    const records = await f.context.list();
    expect(records.map(r => [r!.phase, r!.units[0].resultCode]).sort()).toEqual([["completed", "BACKEND_RESTORE_SUCCESS"], ["nonretryable_failure", "BACKEND_RESTORE_LOST"]]);
    expect(f.context.settleTerminal).toHaveBeenCalled();
  });
  it("restores again after the server process that ran the restore was replaced, without asking the new one", async () => {
    const f = await interrupted(); f.target.backendGeneration = "two"; f.target.runtimeIdentityDigest = "e".repeat(64);
    expect((await f.adapter().restore(f.file)).status).toBe("succeeded");
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(2);
    const records = await f.context.list();
    expect(records.map(r => [r!.phase, r!.units[0].resultCode]).sort()).toEqual([["completed", "BACKEND_RESTORE_SUCCESS"], ["nonretryable_failure", "BACKEND_RESTORE_LOST"]]);
  });
  it("leaves a restore of another storage alone", async () => {
    const f = await interrupted(); f.target.storageScope = "other"; f.probe.mockResolvedValue(null);
    expect((await f.adapter().restore(f.file)).status).toBe("unknown");
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("an observation records a lost restore without submitting", async () => {
    const f = await interrupted(); f.probe.mockResolvedValueOnce(null);
    expect(await f.adapter().restore(f.file, { observationOnly: true })).toMatchObject({ status: "failed", code: "BACKEND_RESTORE_LOST" });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("keeps waiting on a restore the server still reports or cannot be asked about", async () => {
    const f = await interrupted();
    expect((await f.adapter().restore(f.file)).status).toBe("unknown");
    f.probe.mockRejectedValueOnce(Error("offline"));
    expect((await f.adapter().restore(f.file)).status).toBe("unknown");
    expect(f.send).toHaveBeenCalledOnce();
    expect((await f.context.list())[0]!.units[0].status).toBe("unknown");
  });
  it("does not reuse a stale external reference when the backend generation changes", async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async intent => ({ id: "restore-1", clientMutationId: intent.clientMutationId, status: { state: "IDLE", totalManga: 1, mangaProgress: 0 } }));
    f.status.mockResolvedValueOnce(null as any);
    const file = new File(["backup"], "backup.tachibk");
    expect((await f.adapter().restore(file)).status).toBe("unknown");
    f.target.backendGeneration = "two";
    // The old id is never asked of the new server; the backup is applied again instead.
    expect((await f.adapter().restore(file)).status).toBe("succeeded");
    expect(f.status).toHaveBeenCalledOnce();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
});
