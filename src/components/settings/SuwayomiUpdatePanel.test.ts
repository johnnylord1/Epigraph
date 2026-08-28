import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { store } from "../../store/state.svelte";
import {
  recordSuwayomiUpdateCheck,
  suwayomiUpdateUx,
} from "../../lib/suwayomiUpdateUx.svelte";
import type { SuwayomiUpdateStageResult } from "../../lib/suwayomiRuntimeUpdate";
import Toaster from "../layout/Toaster.svelte";
import SuwayomiUpdatePanel from "./SuwayomiUpdatePanel.svelte";

const {
  checkSuwayomiRuntimeUpdateMock,
  getSuwayomiRuntimeStatusMock,
  installSuwayomiRuntimeUpdateMock,
  stageSuwayomiRuntimeUpdateMock,
} = vi.hoisted(() => ({
  checkSuwayomiRuntimeUpdateMock: vi.fn(),
  getSuwayomiRuntimeStatusMock: vi.fn(),
  installSuwayomiRuntimeUpdateMock: vi.fn(),
  stageSuwayomiRuntimeUpdateMock: vi.fn(),
}));

vi.mock("../../lib/suwayomiRuntimeUpdate", () => ({
  checkSuwayomiRuntimeUpdate: checkSuwayomiRuntimeUpdateMock,
  getSuwayomiRuntimeStatus: getSuwayomiRuntimeStatusMock,
  installSuwayomiRuntimeUpdate: installSuwayomiRuntimeUpdateMock,
  stageSuwayomiRuntimeUpdate: stageSuwayomiRuntimeUpdateMock,
}));

function runtime(overrides = {}) {
  return {
    mode: "managed-bundled",
    version: "v2.1.1867",
    jarVersion: null,
    jarPath: "C:/Epigraph/Suwayomi-Server.jar",
    profileId: "main",
    rootDir: "C:/Epigraph/epigraph-main",
    serverUrl: "http://127.0.0.1:4567",
    updateAllowed: true,
    blockReason: null,
    ...overrides,
  };
}

async function openDetails() {
  await fireEvent.click(screen.getByRole("button", { name: "Details" }));
  return await screen.findByRole("dialog", { name: "Suwayomi runtime details" });
}

describe("SuwayomiUpdatePanel", () => {
  beforeEach(() => {
    getSuwayomiRuntimeStatusMock.mockResolvedValue(runtime());
    checkSuwayomiRuntimeUpdateMock.mockResolvedValue({
      status: "updateAvailable",
      currentVersion: "v2.1.1867",
      latestCompatibleVersion: "v2.2.2100",
      releaseTag: "v2.2.2100",
      releaseUrl: "https://github.com/Suwayomi/Suwayomi-Server/releases/tag/v2.2.2100",
      updateAllowed: true,
      blockReason: null,
      notes: "Tested by Epigraph.",
      releaseNotes: "## Changes\n\n- Safer runtime update.",
    });
    stageSuwayomiRuntimeUpdateMock.mockResolvedValue({
      stagingPath: "C:/Epigraph/suwayomi-runtime/staging/v2.2.2100",
      jarPath: "C:/Epigraph/suwayomi-runtime/staging/v2.2.2100/Suwayomi-Server.jar",
      version: "v2.2.2100",
      sha256: "a".repeat(64),
      assetName: "Suwayomi-Server-v2.2.2100.jar",
      checksumAsset: "Checksums.sha256",
      releaseTag: "v2.2.2100",
      releaseUrl: "https://github.com/Suwayomi/Suwayomi-Server/releases/tag/v2.2.2100",
    });
    installSuwayomiRuntimeUpdateMock.mockResolvedValue({
      currentPath: "C:/Epigraph/suwayomi-runtime/current",
      previousPath: "C:/Epigraph/suwayomi-runtime/previous",
      version: "v2.2.2100",
      rolledBack: false,
      restartedRuntime: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
    store.toasts = [];
    suwayomiUpdateUx.lastCheck = null;
    suwayomiUpdateUx.lastCheckedAt = null;
    suwayomiUpdateUx.dismissedToastVersion = null;
    suwayomiUpdateUx.checking = false;
  });

  test("blocks update controls for external runtime", async () => {
    getSuwayomiRuntimeStatusMock.mockResolvedValue(runtime({
      mode: "external",
      updateAllowed: false,
      blockReason: "External Suwayomi servers are not updated by Epigraph.",
    }));

    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("External server")).toBeTruthy());
    await openDetails();
    expect(screen.getAllByText("External Suwayomi servers are not updated by Epigraph.").length).toBeGreaterThan(0);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check for updates" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Download update" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Install update" }).disabled).toBe(true);
    expect(checkSuwayomiRuntimeUpdateMock).not.toHaveBeenCalled();
  });

  test("blocks update controls for user-managed binary", async () => {
    getSuwayomiRuntimeStatusMock.mockResolvedValue(runtime({
      mode: "managed-user-binary",
      updateAllowed: false,
      blockReason: "User-managed Suwayomi binaries are not updated by Epigraph.",
    }));

    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("User-managed binary")).toBeTruthy());
    await openDetails();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check for updates" }).disabled).toBe(true);
  });

  test("checks, stages, snapshots and promotes a manual update", async () => {
    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));

    await fireEvent.click(screen.getByRole("button", { name: "Download update" }));
    await waitFor(() => expect(screen.getAllByText("Ready to install").length).toBeGreaterThan(0));

    await fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    await waitFor(() => expect(installSuwayomiRuntimeUpdateMock).toHaveBeenCalledWith({
      stagedVersion: "v2.2.2100",
    }));
    expect(stageSuwayomiRuntimeUpdateMock).toHaveBeenCalledWith({ targetVersion: "v2.2.2100" });
  });

  test("shows update toast only when a compatible update exists", async () => {
    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    expect(store.toasts.some((toast) => toast.id === "suwayomi-compatible-update")).toBe(false);

    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));
    const toast = store.toasts.find((entry) => entry.id === "suwayomi-compatible-update");
    expect(toast).toBeTruthy();
    expect(toast?.duration).toBe(8_000);
  });

  test("deduplicates the updater notification and dismisses it after the standard lifetime", async () => {
    vi.useFakeTimers();
    render(Toaster);
    const result = await checkSuwayomiRuntimeUpdateMock();

    recordSuwayomiUpdateCheck(result, { notify: true });
    await tick();
    expect(store.toasts.filter((toast) => toast.id === "suwayomi-compatible-update")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4_000);
    recordSuwayomiUpdateCheck(result, { notify: true });
    await tick();
    expect(store.toasts.filter((toast) => toast.id === "suwayomi-compatible-update")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(store.toasts.some((toast) => toast.id === "suwayomi-compatible-update")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(store.toasts.some((toast) => toast.id === "suwayomi-compatible-update")).toBe(false);
  });

  test("dismisses a visible updater notification when the update is no longer available", async () => {
    const result = await checkSuwayomiRuntimeUpdateMock();
    recordSuwayomiUpdateCheck(result, { notify: true });
    expect(store.toasts.some((toast) => toast.id === "suwayomi-compatible-update")).toBe(true);

    recordSuwayomiUpdateCheck({
      ...result,
      status: "upToDate",
      updateAllowed: false,
    });

    expect(store.toasts.some((toast) => toast.id === "suwayomi-compatible-update")).toBe(false);
  });

  test("remind later hides the toast for the session", async () => {
    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));

    const toast = store.toasts.find((entry) => entry.id === "suwayomi-compatible-update");
    expect(toast).toBeTruthy();
    toast?.actions?.find((action) => action.label === "Remind later" || action.label === "Lembrar depois")?.run();

    expect(store.toasts.some((entry) => entry.id === toast?.id)).toBe(false);
    expect(suwayomiUpdateUx.updateAvailable).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));
    expect(store.toasts.some((entry) => entry.id === "suwayomi-compatible-update")).toBe(false);
  });

  test("opens release notes in the changelog dialog", async () => {
    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));

    await fireEvent.click(screen.getByRole("button", { name: "View changelog" }));

    expect(screen.getByRole("dialog", { name: "Suwayomi changelog" })).toBeTruthy();
    expect(screen.getByText(/Safer runtime update/)).toBeTruthy();
  });

  test("shows a user-friendly failed state when automatic rollback also fails", async () => {
    installSuwayomiRuntimeUpdateMock.mockRejectedValue(new Error("RollbackError: Promotion failed. Automatic rollback also failed."));

    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByRole("button", { name: "Download update" }));
    await waitFor(() => expect(screen.getAllByText("Ready to install").length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByRole("button", { name: "Install update" }));

    await waitFor(() => expect(screen.getAllByText("Epigraph could not verify the downloaded Suwayomi update and could not restore the previous runtime automatically. Restart Epigraph before trying again.").length).toBeGreaterThan(0));
  });

  test("hides health-check internals after a safe rollback", async () => {
    installSuwayomiRuntimeUpdateMock.mockRejectedValue(new Error("HealthCheckError: Suwayomi GraphQL sources health check failed. The previous Suwayomi runtime was restored."));

    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByRole("button", { name: "Download update" }));
    await waitFor(() => expect(screen.getAllByText("Ready to install").length).toBeGreaterThan(0));
    await fireEvent.click(screen.getByRole("button", { name: "Install update" }));

    await waitFor(() => expect(screen.getAllByText("Epigraph could not verify the downloaded Suwayomi update, so it kept the current runtime.").length).toBeGreaterThan(0));
    expect(screen.queryByText(/GraphQL sources health check failed/)).toBeNull();
  });

  test("shows failed state for update check failures", async () => {
    checkSuwayomiRuntimeUpdateMock.mockResolvedValue({
      status: "checkFailed",
      currentVersion: "v2.1.1867",
      latestCompatibleVersion: null,
      releaseTag: null,
      releaseUrl: null,
      updateAllowed: false,
      blockReason: "GitHub rate limit reached.",
      notes: null,
      releaseNotes: null,
    });

    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => expect(screen.getAllByText("Failed").length).toBeGreaterThan(0));
    expect(screen.getAllByText("GitHub rate limit reached.").length).toBeGreaterThan(0);
  });

  test("avoids duplicate downloads while staging is in progress", async () => {
    let resolveStage!: (value: SuwayomiUpdateStageResult) => void;
    stageSuwayomiRuntimeUpdateMock.mockImplementationOnce(() => new Promise<SuwayomiUpdateStageResult>((resolve) => {
      resolveStage = resolve;
    }));

    render(SuwayomiUpdatePanel);

    await waitFor(() => expect(screen.getByText("Up to date")).toBeTruthy());
    await openDetails();
    await fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getAllByText("Update available").length).toBeGreaterThan(0));

    const downloadButton = screen.getByRole<HTMLButtonElement>("button", { name: "Download update" });
    await fireEvent.click(downloadButton);
    expect(downloadButton.disabled).toBe(true);
    await fireEvent.click(downloadButton);
    expect(stageSuwayomiRuntimeUpdateMock).toHaveBeenCalledTimes(1);

    resolveStage({
      stagingPath: "stale",
      jarPath: "stale/Suwayomi-Server.jar",
      version: "v2.2.2100",
      sha256: "b".repeat(64),
      assetName: "Suwayomi-Server-v2.2.2100.jar",
      checksumAsset: "Checksums.sha256",
      releaseTag: "v2.2.2100",
      releaseUrl: "https://github.com/Suwayomi/Suwayomi-Server/releases/tag/v2.2.2100",
    });

    await waitFor(() => expect(screen.getAllByText("Ready to install").length).toBeGreaterThan(0));
  });
});
