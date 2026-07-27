import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  acquireSuwayomiOperationLease,
  assertSuwayomiWritesAllowed,
  beginSuwayomiUpdateMaintenance,
  endSuwayomiUpdateMaintenance,
  setSuwayomiUpdateInProgressForTests,
  SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE,
  suwayomiUpdateInProgress,
} from "./suwayomiUpdateLock.svelte";

describe("Suwayomi update maintenance lock", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setSuwayomiUpdateInProgressForTests(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("holds and releases a native operation lease in Tauri", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invokeMock
      .mockResolvedValueOnce("lease-token")
      .mockResolvedValueOnce(true);

    const release = await acquireSuwayomiOperationLease("mutation");

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "begin_suwayomi_runtime_operation",
      { scope: "mutation" },
    );
    await release();
    await release();
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "end_suwayomi_runtime_operation",
      { token: "lease-token" },
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  test("blocks writes immediately while a local update command is entering native code", async () => {
    const token = beginSuwayomiUpdateMaintenance("install");

    await expect(assertSuwayomiWritesAllowed()).rejects.toThrow(
      SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE,
    );
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValueOnce({ inProgress: false, owner: null, startedAtMs: null });
    await endSuwayomiUpdateMaintenance(token);
    await expect(suwayomiUpdateInProgress()).resolves.toBe(false);
  });

  test("refreshes a previously active native lock instead of remaining blocked forever", async () => {
    setSuwayomiUpdateInProgressForTests(true);
    invokeMock.mockResolvedValueOnce({ inProgress: false, owner: null, startedAtMs: null });

    await expect(suwayomiUpdateInProgress()).resolves.toBe(false);
  });

  test("releases the local lock when native status refresh is temporarily unavailable", async () => {
    const token = beginSuwayomiUpdateMaintenance("snapshot");
    invokeMock.mockRejectedValueOnce(new Error("IPC unavailable"));

    await endSuwayomiUpdateMaintenance(token);
    invokeMock.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(suwayomiUpdateInProgress()).resolves.toBe(false);
  });
});
