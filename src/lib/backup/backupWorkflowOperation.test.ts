import { describe, expect, it } from "vitest";
import { createBackupWorkflow, type BackupInspection } from "./backupWorkflow";

const inspection: BackupInspection = { plan: null, workCount: 1, chapterCount: 0, repositoryCount: 0, extensionCount: 0, conflictCount: 0, libraryKinds: ["manga"], needsSourceKinds: [] };
const backup = (text = "a") => new File([text], `${text}.tachibk`);

// Local completion belongs to the active coordinator. Durable external restart
// evidence is exercised through the real adapter in mangaRestoreAdapter.test.ts.
describe("shared workflow coordinator contract", () => {
  it("applies equivalent readiness to both presentation callers before execution", async () => {
    let ready = false;
    const calls: string[] = [];
    const screen = () => createBackupWorkflow({ inspect: async () => inspection, ready: async () => ready,
      restore: async entry => { calls.push(entry.key); } });
    const settings = screen(), firstRun = screen();
    const a = await settings.inspectFiles([backup()]), b = await firstRun.inspectFiles([backup()]);
    expect(settings.summarize(a)).toEqual(firstRun.summarize(b));
    expect(a[0].key).toBe(b[0].key);
    await expect(settings.restoreFiles(a)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
    await expect(firstRun.restoreFiles(b)).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
    expect(calls).toEqual([]);
    ready = true;
    await settings.restoreFiles(a); await firstRun.restoreFiles(b);
    expect(settings.snapshot().units).toEqual(firstRun.snapshot().units);
    expect(calls).toEqual([a[0].key, b[0].key]);
  });

  it("skips completed A and uses only reconciliation for unknown B on retry", async () => {
    const calls: string[] = [];
    const workflow = createBackupWorkflow({ inspect: async () => inspection,
      restore: async () => { throw Error("Legacy executor invoked"); },
      invocations: entry => [{ id: entry.key, domain: "manga", execute: async () => {
        calls.push(`send:${entry.name}`); if (entry.name === "b.tachibk") throw Error("response lost");
      }, reconcile: async () => { calls.push(`observe:${entry.name}`); throw Error("still unknown"); } }],
    });
    const files = await workflow.inspectFiles([backup(), backup("b")]);
    await expect(workflow.restoreFiles(files)).rejects.toThrow("response lost");
    await expect(workflow.restoreFiles(files)).rejects.toThrow("still unknown");
    expect(calls).toEqual(["send:a.tachibk", "send:b.tachibk", "observe:b.tachibk"]);
    expect(Object.values(workflow.snapshot().units)).toEqual(["succeeded", "unknown"]);
  });

  it("retains completed state when the same content is reselected under another name", async () => {
    let calls = 0;
    const workflow = createBackupWorkflow({ inspect: async () => inspection, restore: async () => { calls++; } });
    await workflow.restoreFiles(await workflow.inspectFiles([backup()]));
    const first = workflow.snapshot();
    await workflow.restoreFiles(await workflow.inspectFiles([new File(["a"], "renamed.tachibk")]));
    expect(calls).toBe(1);
    expect(workflow.snapshot()).toEqual(first);
  });

  it("detach cannot release a running target or erase an ambiguous result", async () => {
    let finish!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const target = crypto.randomUUID();
    const screen = () => createBackupWorkflow({ target: () => target, inspect: async () => inspection,
      restore: async () => { entered(); await pending; throw Error("lost result"); } });
    const a = screen(), b = screen();
    const files = await a.inspectFiles([backup()]);
    let observations = 0;
    a.observe(() => { observations++; });
    const run = a.restoreFiles(files); const rejected = expect(run).rejects.toThrow("lost result");
    await started; a.detach(); const before = observations;
    await expect(b.restoreFiles(await b.inspectFiles([backup()]))).rejects.toThrow("RESTORE_CONFLICT");
    finish(); await rejected;
    expect(observations).toBe(before);
    expect(Object.values(a.snapshot().units)).toEqual(["unknown"]);
    await expect(b.restoreFiles(await b.inspectFiles([backup()]))).rejects.toThrow("RESTORE_EXTERNAL_UNRESOLVED");
  });

  it("cancellation before mutation never invokes a domain and remains explicit", async () => {
    let calls = 0;
    const workflow = createBackupWorkflow({ inspect: async () => inspection, restore: async () => { calls++; } });
    const files = await workflow.inspectFiles([backup()]);
    workflow.requestCancel();
    await expect(workflow.restoreFiles(files)).rejects.toThrow("RESTORE_CANCELLED");
    await expect(workflow.restoreFiles(files)).rejects.toThrow("RESTORE_CANCELLED");
    expect(calls).toBe(0);
    expect(workflow.snapshot().cancelled).toBe(true);
    expect(Object.values(workflow.snapshot().units)).toEqual(["cancelled"]);
  });
});
