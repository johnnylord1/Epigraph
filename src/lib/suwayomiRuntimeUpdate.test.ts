import { beforeEach, describe, expect, test, vi } from "vitest";

const { invokeMock, resetManagedSourceRuntimeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  resetManagedSourceRuntimeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./manga/runtime", () => ({ resetManagedSourceRuntime: resetManagedSourceRuntimeMock }));

import { installSuwayomiRuntimeUpdate } from "./suwayomiRuntimeUpdate";
import { suwayomiUpdateLockState } from "./suwayomiUpdateLock.svelte";

describe("Suwayomi runtime update maintenance", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetManagedSourceRuntimeMock.mockReset();
  });

  test("holds maintenance across install and releases it after native completion", async () => {
    let resolveInstall!: (value: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "install_suwayomi_runtime_update") {
        return new Promise((resolve) => { resolveInstall = resolve; });
      }
      if (command === "get_suwayomi_update_lock_status") {
        return Promise.resolve({ inProgress: false, owner: null, startedAtMs: null });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const pending = installSuwayomiRuntimeUpdate({ stagedVersion: "v2.3.2243" });
    expect(suwayomiUpdateLockState).toMatchObject({ inProgress: true, owner: "install" });

    resolveInstall({ version: "v2.3.2243" });
    await expect(pending).resolves.toMatchObject({ version: "v2.3.2243" });
    expect(suwayomiUpdateLockState.inProgress).toBe(false);
    expect(resetManagedSourceRuntimeMock).toHaveBeenCalledOnce();
  });

  test("releases maintenance and invalidates the adapter after a failed install", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "install_suwayomi_runtime_update") {
        return Promise.reject(new Error("promotion failed"));
      }
      if (command === "get_suwayomi_update_lock_status") {
        return Promise.resolve({ inProgress: false, owner: null, startedAtMs: null });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(installSuwayomiRuntimeUpdate({ stagedVersion: "v2.3.2243" }))
      .rejects.toThrow("promotion failed");
    expect(suwayomiUpdateLockState.inProgress).toBe(false);
    expect(resetManagedSourceRuntimeMock).toHaveBeenCalledOnce();
  });
});
