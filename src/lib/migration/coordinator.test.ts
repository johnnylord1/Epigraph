import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import {
  beginMigrationOperation,
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

  it("marks interrupted post-effect work as recovery pending", async () => {
    const operation = await begin();
    await transitionMigrationOperation(operation.operationId, "applying");

    const recovered = await recoverInterruptedMigrationOperations();
    const recoveredRevision = recovered[0]?.revision;
    const repeated = await recoverInterruptedMigrationOperations();

    expect(recovered[0]?.status).toBe("recovery_pending");
    expect(repeated).toEqual([]);
    expect(await getMigrationOperation(operation.operationId)).toMatchObject({
      status: "recovery_pending",
      revision: recoveredRevision,
    });
  });
});
