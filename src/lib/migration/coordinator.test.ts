import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  acknowledgeMigrationManualRecovery,
  beginMigrationChildOperation,
  beginMigrationOperation,
  checkpointMigrationPayload,
  commitMigrationOperation,
  recoverInterruptedMigrationOperations,
  resetMigrationCoordinatorForTests,
  runMigrationStep,
  transitionMigrationOperation,
  withMigrationProfileLock,
} from "./coordinator";
import {
  getMigrationOperation,
  resetMigrationJournalStateCacheForTests,
} from "./journalState";
import type { MangaMigrationUndoPayload } from "./types";

function installMemoryStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  };
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

async function begin() {
  return beginMigrationOperation({
    profileId: "main",
    contentKind: "manga",
    sourceFrom: "1",
    sourceTo: "2",
    transferSummary: {
      oldItemTitle: "Old",
      newItemTitle: "New",
      oldSourceId: "1",
      newSourceId: "2",
      transferredChapterCount: 1,
      transferredReadCount: 1,
      transferredBookmarkCount: 0,
    },
    payload: {
      oldState: { mangaId: 1, inLibrary: true, title: "Old", categoryIds: [], chapters: [] },
      newState: { mangaId: 2, inLibrary: false, title: "New", categoryIds: [], chapters: [] },
    },
    steps: [{ stepId: "suwayomi-state", kind: "suwayomi" }],
  });
}

describe("migration coordinator", () => {
  beforeEach(() => {
    installMemoryStorage();
    resetMigrationJournalStateCacheForTests();
    resetMigrationCoordinatorForTests();
  });

  it("persists planned before applying and commits only after verification", async () => {
    const operation = await begin();
    const observed: string[] = [];
    await transitionMigrationOperation(operation.operationId, "preparing");
    await transitionMigrationOperation(operation.operationId, "applying");
    await runMigrationStep({
      operationId: operation.operationId,
      stepId: "suwayomi-state",
      apply: async () => {
        observed.push((await getMigrationOperation(operation.operationId))!.status);
      },
      verify: async () => {
        observed.push((await getMigrationOperation(operation.operationId))!.steps[0]!.status);
      },
    });
    const committed = await commitMigrationOperation(operation.operationId);

    expect(observed).toEqual(["applying", "verifying"]);
    expect(committed.status).toBe("committed");
    expect(committed.steps[0]?.status).toBe("verified");
    expect(committed.snapshots.oldStateSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("serializes operations for the same profile", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = withMigrationProfileLock("main", async () => {
      order.push("first-start");
      firstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = withMigrationProfileLock("main", async () => {
      order.push("second");
    });
    await started;
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("blocks the profile when interrupted work may have produced effects", async () => {
    const operation = await begin();
    await transitionMigrationOperation(operation.operationId, "applying");
    await runMigrationStep({
      operationId: operation.operationId,
      stepId: "suwayomi-state",
      apply: async () => {
        throw new Error("interrupted");
      },
    }).catch(() => undefined);

    const recovered = await recoverInterruptedMigrationOperations();
    const recoveredRevision = recovered[0]?.revision;
    const repeated = await recoverInterruptedMigrationOperations();

    expect(recovered[0]?.status).toBe("needs_manual_recovery");
    expect(repeated).toEqual([]);
    expect(await getMigrationOperation(operation.operationId)).toMatchObject({
      status: "needs_manual_recovery",
      revision: recoveredRevision,
    });
    await expect(begin()).rejects.toThrow("requires recovery");

    const acknowledged = await acknowledgeMigrationManualRecovery(
      operation.operationId,
      async () => undefined,
    );
    expect(acknowledged.status).toBe("compensated");
    await expect(begin()).resolves.toMatchObject({ status: "planned" });
  });

  it("cancels interrupted work when no effect started", async () => {
    const operation = await begin();

    const recovered = await recoverInterruptedMigrationOperations();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      operationId: operation.operationId,
      status: "cancelled",
    });
  });

  it("checkpoints updated recovery payload before later effects", async () => {
    const operation = await begin();
    const payload: MangaMigrationUndoPayload = {
      oldState: {
        mangaId: 1,
        inLibrary: true,
        title: "Old",
        categoryIds: [],
        chapters: [],
        localIdentity: {
          mangaLinks: {
            affectedKeys: ["1", "2"],
            values: { 1: [2], 2: [1] },
          },
        },
      },
      newState: {
        mangaId: 2,
        inLibrary: true,
        title: "New",
        categoryIds: [],
        chapters: [],
        localIdentity: {
          mangaLinks: {
            affectedKeys: ["1", "2"],
            values: { 2: [1] },
          },
        },
      },
    };

    const checkpointed = await checkpointMigrationPayload(
      operation.operationId,
      payload,
    );

    expect(checkpointed.snapshots.payload).toEqual(payload);
    expect(checkpointed.snapshots.oldStateSha256).not.toBe(operation.snapshots.oldStateSha256);
    expect(checkpointed.snapshots.newStateSha256).not.toBe(operation.snapshots.newStateSha256);
  });

  it("links explicit child operations to a mass parent", async () => {
    const parent = await beginMigrationOperation({
      profileId: "main",
      contentKind: "manga",
      mode: "mass",
      sourceFrom: "1",
      sourceTo: "2",
      transferSummary: {
        oldItemTitle: "Batch",
        newItemTitle: "Batch",
        oldSourceId: "1",
        newSourceId: "2",
        transferredChapterCount: 0,
        transferredReadCount: 0,
        transferredBookmarkCount: 0,
      },
      payload: {
        items: [{
          oldState: { mangaId: 1, inLibrary: true, title: "Old", categoryIds: [], chapters: [] },
          newState: { mangaId: 2, inLibrary: false, title: "New", categoryIds: [], chapters: [] },
        }],
      },
      steps: [{ stepId: "child-1", kind: "local" }],
    });

    const child = await beginMigrationChildOperation(parent.operationId, {
      contentKind: "manga",
      sourceFrom: "1",
      sourceTo: "2",
      transferSummary: parent.transferSummary,
      payload: {
        oldState: { mangaId: 1, inLibrary: true, title: "Old", categoryIds: [], chapters: [] },
        newState: { mangaId: 2, inLibrary: false, title: "New", categoryIds: [], chapters: [] },
      },
      steps: [{ stepId: "target", kind: "suwayomi" }],
    });
    const reloadedParent = await getMigrationOperation(parent.operationId);

    expect(child.parentOperationId).toBe(parent.operationId);
    expect(reloadedParent?.childOperationIds).toEqual([child.operationId]);
  });
});
