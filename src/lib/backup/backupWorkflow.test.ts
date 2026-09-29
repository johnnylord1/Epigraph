import { describe, expect, it, vi } from "vitest";
import { createBackupWorkflow, type BackupInspection } from "./backupWorkflow";

const inspection = (overrides: Partial<BackupInspection> = {}): BackupInspection => ({
  plan: null,
  workCount: 0,
  chapterCount: 0,
  repositoryCount: 0,
  extensionCount: 0,
  conflictCount: 0,
  libraryKinds: [],
  needsSourceKinds: [],
  ...overrides,
});

describe("backup workflow", () => {
  it("a refused concurrent request cannot replace the active readiness input", async () => {
    let admit!: () => void;
    const pending = new Promise<void>(resolve => { admit = resolve; });
    const ready = vi.fn(async () => true);
    const restored: string[] = [];
    const workflow = createBackupWorkflow({ inspect: async () => inspection({ libraryKinds: ["books"] }), ready,
      admit: async () => { await pending; return async () => {}; }, restore: async file => { restored.push(file.name); } });
    const files = await workflow.inspectFiles([new File(["a"], "a.epigraphbk"), new File(["b"], "b.epigraphbk")]);
    const active = workflow.restoreFiles([files[0]]);
    await expect(workflow.restoreFiles([files[1]])).rejects.toThrow();
    admit(); await active;
    expect(ready).toHaveBeenCalledWith([files[0]]);
    expect(restored).toEqual(["a.epigraphbk"]);
  });
  it("refuses an empty or invalid-only selection instead of reporting successful restore", async () => {
    const restore = vi.fn();
    const workflow = createBackupWorkflow({ inspect: async () => inspection(), restore });
    await expect(workflow.restoreFiles([])).rejects.toThrow("RESTORE_NO_VALID_INPUT");
    const files = await workflow.inspectFiles([new File(["bad"], "bad.txt")]);
    await expect(workflow.restoreFiles(files)).rejects.toThrow("RESTORE_NO_VALID_INPUT");
    expect(restore).not.toHaveBeenCalled();
  });
  it("does not replay a completed file after a later file loses its result", async () => {
    const accepted: string[] = [];
    const workflow = createBackupWorkflow({
      inspect: async () => inspection({ libraryKinds: ["manga"] }),
      restore: async (entry) => {
        accepted.push(entry.name);
        if (entry.name === "b.tachibk") throw new Error("Response lost after acceptance");
      },
    });
    const files = await workflow.inspectFiles([
      new File(["a"], "a.tachibk"), new File(["b"], "b.tachibk"),
    ]);
    await expect(workflow.restoreFiles(files)).rejects.toThrow();
    await expect(workflow.restoreFiles(files)).rejects.toThrow();
    expect(accepted).toEqual(["a.tachibk", "b.tachibk"]);
  });

  it("identifies content rather than filename metadata", async () => {
    const workflow = createBackupWorkflow({
      inspect: async () => inspection(), restore: async () => {},
    });
    const files = await workflow.inspectFiles([
      new File(["a"], "one.tachibk", { lastModified: 1 }),
      new File(["a"], "renamed.tachibk", { lastModified: 2 }),
      new File(["b"], "one.tachibk", { lastModified: 1 }),
    ]);
    expect(files).toHaveLength(2);
    expect(await files[0].file.text()).toBe("a");
    expect(await files[1].file.text()).toBe("b");
  });

  it("inspects mixed files without writing and produces a deterministic summary", async () => {
    const write = vi.fn();
    const inspect = vi.fn(async (file: File) => {
      if (file.name.endsWith(".tachibk")) return inspection({ workCount: 4, chapterCount: 12, repositoryCount: 1, extensionCount: 2, conflictCount: 1, libraryKinds: ["manga"], needsSourceKinds: ["manga"] });
      return inspection({ workCount: 3, chapterCount: 8, repositoryCount: 2, extensionCount: 5, libraryKinds: ["novels"], needsSourceKinds: ["novels"] });
    });
    const workflow = createBackupWorkflow({ inspect, restore: write });

    const files = await workflow.inspectFiles([
      new File(["manga"], "library.tachibk", { lastModified: 1 }),
      new File(["novels"], "lnreader.zip", { lastModified: 2 }),
    ]);

    expect(write).not.toHaveBeenCalled();
    expect(files.map((file) => file.status)).toEqual(["ready", "ready"]);
    expect(workflow.summarize(files)).toEqual({
      workCount: 7,
      chapterCount: 20,
      repositoryCount: 3,
      extensionCount: 7,
      conflictCount: 1,
      libraryKinds: ["manga", "novels"],
      needsSourceKinds: ["manga", "novels"],
    });
  });

  it("isolates invalid files and keeps valid files ready", async () => {
    const workflow = createBackupWorkflow({
      inspect: vi.fn(async (file: File) => {
        if (file.name === "broken.zip") throw new Error("Unsupported archive");
        return inspection({ workCount: 9, libraryKinds: ["novels"] });
      }),
      restore: vi.fn(),
    });

    const files = await workflow.inspectFiles([
      new File(["bad"], "broken.zip"),
      new File(["good"], "epigraph.epigraphbk"),
    ]);

    expect(files[0]).toMatchObject({ name: "broken.zip", status: "invalid", error: "Unsupported archive" });
    expect(files[1]).toMatchObject({ name: "epigraph.epigraphbk", status: "ready", error: null });
  });

  it("deduplicates the same browser file and restores ready entries only", async () => {
    const inspect = vi.fn(async () => inspection({ workCount: 1, libraryKinds: ["manga"] }));
    const restore = vi.fn(async () => undefined);
    const workflow = createBackupWorkflow({ inspect, restore });
    const selected = new File(["same"], "same.tachibk", { lastModified: 42 });

    const first = await workflow.inspectFiles([selected]);
    const second = await workflow.inspectFiles([selected], first);
    await workflow.restoreFiles([
      ...second,
      { ...second[0], key: "invalid", name: "invalid.zip", status: "invalid", error: "bad" },
    ]);

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(second[0], expect.any(Function));
  });
});
