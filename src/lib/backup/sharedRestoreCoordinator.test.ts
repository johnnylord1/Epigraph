import { describe, expect, it, vi } from "vitest";
import { createSharedRestoreCoordinator } from "./sharedRestoreCoordinator";

describe("shared flat restore coordinator", () => {
  it.each([null, undefined, 0, ""])("reports a local failed mutation even when the rejection is falsy: %s", async failure => {
    const target = crypto.randomUUID();
    const stable = createSharedRestoreCoordinator({ target: () => target, ready: async () => true });
    await expect(stable.run([{ id: "a", domain: "app", execute: async () => { throw failure; } }])).rejects.toThrow("RESTORE_DOMAIN_FAILED");
    expect(stable.snapshot().units.a).toBe("failed");
  });
  it("does not execute caller mutations to the plan while readiness is pending", async () => {
    let ready!: () => void;
    const wait = new Promise<void>(resolve => { ready = resolve; });
    const calls: string[] = [];
    const coordinator = createSharedRestoreCoordinator({ target: () => "frozen-plan", ready: async () => { await wait; return true; } });
    const units = [{ id: "a", domain: "app" as const, execute: async () => { calls.push("approved"); } }];
    const run = coordinator.run(units);
    units[0].execute = async () => { calls.push("changed"); };
    units.push({ id: "b", domain: "app", execute: async () => { calls.push("injected"); } });
    ready(); await run;
    expect(calls).toEqual(["approved"]);
  });
  it("reconciling a different Manga cannot release another input's ambiguity guard", async () => {
    const a = createSharedRestoreCoordinator({ target: () => "foreign-reconcile", ready: async () => true });
    await expect(a.run([{ id: "unknown-a", domain: "manga", execute: async () => { throw Error("lost"); } }])).rejects.toThrow();
    const b = createSharedRestoreCoordinator({ target: () => "foreign-reconcile", ready: async () => true });
    const send = vi.fn(async () => {});
    await b.run([{ id: "known-b", domain: "manga", execute: send, reconcile: async () => {} }]);
    const c = createSharedRestoreCoordinator({ target: () => "foreign-reconcile", ready: async () => true });
    await expect(c.run([{ id: "new-c", domain: "manga", execute: send }])).rejects.toThrow("RESTORE_EXTERNAL_UNRESOLVED");
    expect(send).not.toHaveBeenCalled();
  });
  it("uses observation-only reconciliation for unknown Manga and skips successful local work", async () => {
    const calls: string[] = [];
    const coordinator = createSharedRestoreCoordinator({ target: () => "reconcile-test", ready: async () => true });
    const units = [
      { id: "a", domain: "app" as const, execute: async () => { calls.push("app"); } },
      { id: "b", domain: "manga" as const, execute: async () => { calls.push("send"); throw Error("lost"); }, reconcile: async () => { calls.push("observe"); } },
    ];
    await expect(coordinator.run(units)).rejects.toThrow("lost");
    await coordinator.run(units);
    expect(calls).toEqual(["app", "send", "observe"]);
    expect(coordinator.snapshot().units.b).toBe("succeeded");
  });
  it("skips completed local work on retry and retries an ordinary local failure", async () => {
    const calls: string[] = [];
    let fail = true;
    const coordinator = createSharedRestoreCoordinator({ target: () => "local-test", ready: async () => true });
    const units = ["a", "b"].map(id => ({ id, domain: "novels" as const, execute: async () => { calls.push(id); if (id === "b" && fail) throw Error("disk"); } }));
    await expect(coordinator.run(units)).rejects.toThrow();
    fail = false;
    await coordinator.run(units);
    expect(calls).toEqual(["a", "b", "b"]);
  });
  it("retains uncertain external submission protection across retry and detach", async () => {
    const execute = vi.fn(async () => { throw Error("response lost"); });
    const coordinator = createSharedRestoreCoordinator({ target: () => "external-test", ready: async () => true });
    const units = [{ id: "manga", domain: "manga" as const, execute }];
    await expect(coordinator.run(units)).rejects.toThrow();
    coordinator.detach();
    await expect(coordinator.run(units)).rejects.toThrow("RESTORE_EXTERNAL_UNRESOLVED");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("cancellation cannot relabel an accepted unknown mutation as cancelled", async () => {
    const coordinator = createSharedRestoreCoordinator({ target: () => "cancel-unknown", ready: async () => true });
    const units = [{ id: "m", domain: "manga" as const, execute: async () => { throw Error("lost"); } }];
    await expect(coordinator.run(units)).rejects.toThrow();
    coordinator.cancel();
    await expect(coordinator.run(units)).rejects.toThrow("RESTORE_EXTERNAL_UNRESOLVED");
    expect(coordinator.snapshot().units.m).toBe("unknown");
  });
  it("refuses readiness and target drift before any mutation", async () => {
    let target = "a";
    const execute = vi.fn();
    const coordinator = createSharedRestoreCoordinator({ target: () => target, ready: async () => false });
    await expect(coordinator.run([{ id: "a", domain: "app", execute }])).rejects.toThrow("RESTORE_WAITING_FOR_DEPENDENCIES");
    target = "b";
    await expect(coordinator.run([{ id: "a", domain: "app", execute }])).rejects.toThrow("RESTORE_TARGET_CHANGED");
    expect(execute).not.toHaveBeenCalled();
  });
  it("refuses overlapping target execution and keeps exclusion after detach", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const a = createSharedRestoreCoordinator({ target: () => "shared", ready: async () => true });
    const b = createSharedRestoreCoordinator({ target: () => "shared", ready: async () => true });
    const run = a.run([{ id: "a", domain: "books", execute: () => wait }]);
    a.detach();
    await expect(b.run([{ id: "b", domain: "books", execute: async () => {} }])).rejects.toThrow("RESTORE_CONFLICT");
    release(); await run;
  });
  it("cancel stops future domains while preserving completed results", async () => {
    const coordinator = createSharedRestoreCoordinator({ target: () => "cancel", ready: async () => true });
    const second = vi.fn();
    await coordinator.run([{ id: "a", domain: "novels", execute: async () => { coordinator.cancel(); } }, { id: "b", domain: "app", execute: second }]);
    expect(coordinator.snapshot().units).toEqual({ a: "succeeded", b: "cancelled" });
    expect(second).not.toHaveBeenCalled();
  });
});
