import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppLanguage } from "../../lib/i18n/runtime";

const sync = vi.hoisted(() => ({
  candidates: vi.fn(),
  resolve: vi.fn(),
  connect: vi.fn(),
  replication: vi.fn(),
  refresh: vi.fn(),
  paired: vi.fn(),
  progress: vi.fn(),
  pairingListener: null as null | ((payload: unknown) => void),
  replicationListener: null as null | ((payload: unknown) => void),
}));

vi.mock("../../lib/syncdDesktop", () => ({
  syncdListDiscoveryCandidates: sync.candidates,
  syncdResolvePairingPin: sync.resolve,
  syncdConnectWithBootstrap: sync.connect,
  syncdGetReplicationState: sync.replication,
  syncdListPairedDevicesIfRunning: sync.paired,
  syncdGetSyncProgressIfRunning: sync.progress,
  listenSyncdPairingStatus: vi.fn(async (handler: (payload: unknown) => void) => { sync.pairingListener = handler; return () => {}; }),
  listenSyncdReplicationState: vi.fn(async (handler: (payload: unknown) => void) => { sync.replicationListener = handler; return () => {}; }),
}));
vi.mock("../../lib/setup/firstRunSyncReadiness", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/setup/firstRunSyncReadiness")>(),
  refreshFirstRunSyncLibrary: sync.refresh,
}));
vi.mock("../settings/SyncdConnectionPanel.svelte", () => import("../../test/fixtures/FirstRunSurface.svelte"));

import FirstRunSyncStep from "./FirstRunSyncStep.svelte";
import { pairingVerificationCode } from "../../lib/syncPairingVerification";

const office = {
  instanceName: "epigraph-syncd-01a15e04._epigraph-sync._tcp.local.",
  deviceName: "OFFICE-PC",
  serverId: "server-1",
  effectiveOrigin: "https://192.168.1.20:4877",
  effectiveSource: "advertised-endpoint",
  discoveryOrigin: "https://192.168.1.20:4877",
  tlsCertSha256: "ab12cd34",
  supportsBootstrapSessionCreate: true,
  supportsBootstrapSessionFetch: true,
  supportsLivePairingStatus: true,
  fallbackOrigins: ["https://10.0.0.5:4877"],
};

function connectState(status: string) {
  return {
    localProfileId: "main",
    sessionId: "bootstrap-1",
    remoteProfileId: "main",
    remoteOrigin: office.effectiveOrigin,
    tlsCertSha256: office.tlsCertSha256,
    status,
    attemptedOrigin: office.effectiveOrigin,
    fallbackOrigins: [],
    localDeviceName: "NEW-PC",
    remoteDeviceName: "OFFICE-PC",
  };
}

async function choosePin(pin: string) {
  await fireEvent.click(await screen.findByRole("button", { name: "Choose OFFICE-PC" }));
  const first = await screen.findByLabelText("Digit 1");
  await fireEvent.input(first, { target: { value: pin } });
  await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}

beforeEach(() => {
  applyAppLanguage("en");
  vi.clearAllMocks();
  sync.pairingListener = null;
  sync.replicationListener = null;
  sync.candidates.mockResolvedValue([office]);
  sync.replication.mockResolvedValue({ localProfileId: "main", replicationStatus: "idle", paused: false, lastAppliedScopes: [] });
  sync.resolve.mockResolvedValue("{\"pairingSessionId\":\"bootstrap-1\"}");
  sync.connect.mockResolvedValue(connectState("pending"));
  sync.refresh.mockResolvedValue(undefined);
  sync.paired.mockResolvedValue([]);
  sync.progress.mockResolvedValue({ pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 0 });
});

afterEach(cleanup);

describe("FirstRunSyncStep", () => {
  it("pairs with a discovered computer by PIN and continues once the library is synced", async () => {
    const onReadyChange = vi.fn();
    const onContinue = vi.fn();
    render(FirstRunSyncStep, { props: { profileId: "main", onReadyChange, onContinue } });

    await choosePin("123456");

    expect(sync.resolve).toHaveBeenCalledWith({
      origin: office.effectiveOrigin,
      tlsCertSha256: office.tlsCertSha256,
      fallbackOrigins: office.fallbackOrigins,
      pin: "123456",
    });
    expect(sync.connect).toHaveBeenCalledWith({
      localProfileId: "main",
      bootstrapBundle: "{\"pairingSessionId\":\"bootstrap-1\"}",
      manualOrigin: office.effectiveOrigin,
    });
    expect(await screen.findByText("Approve on OFFICE-PC")).toBeTruthy();
    expect(screen.getByLabelText(`Verification code ${pairingVerificationCode(office.tlsCertSha256)}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

    sync.pairingListener?.(connectState("approved"));
    sync.replicationListener?.({
      localProfileId: "main",
      activeSessionKey: "session-1",
      replicationStatus: "live",
      remoteBootstrapGeneration: 1,
      paused: false,
      lastError: null,
      lastAppliedScopes: [],
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(sync.refresh).toHaveBeenCalledWith("main", expect.any(Function));
    expect(await screen.findByText("Library synced")).toBeTruthy();
    expect(onReadyChange).toHaveBeenLastCalledWith(true);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("continues once a phone pairs with this computer", async () => {
    const onReadyChange = vi.fn();
    render(FirstRunSyncStep, { props: { profileId: "main", onReadyChange } });
    await screen.findByText("OFFICE-PC");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

    sync.pairingListener?.({ profileId: "main", sessionId: "host-1", status: "approved", claimedDeviceName: "Galaxy S23", claimedPlatform: "android", bootstrapBundle: "{}" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(sync.refresh).toHaveBeenCalledWith("main", expect.any(Function));
    expect(screen.getByText("Galaxy S23")).toBeTruthy();
    expect(onReadyChange).toHaveBeenLastCalledWith(true);
  });

  it("ignores host pairings for another profile or still waiting for approval", async () => {
    render(FirstRunSyncStep, { props: { profileId: "main" } });
    await screen.findByText("OFFICE-PC");

    sync.pairingListener?.({ profileId: "other", sessionId: "host-1", status: "approved", claimedDeviceName: "Galaxy S23", claimedPlatform: "android", bootstrapBundle: "{}" });
    sync.pairingListener?.({ profileId: "main", sessionId: "host-2", status: "claimed", claimedDeviceName: "Galaxy S23", claimedPlatform: "android", bootstrapBundle: "{}" });

    await Promise.resolve();
    expect(sync.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  });

  it("recognises a phone that already paired here before the step opened", async () => {
    sync.paired.mockResolvedValue([{ deviceId: "phone-1", deviceName: "Galaxy S23", platform: "android", profileId: "main", grantedScopes: [], inactive: false }]);
    render(FirstRunSyncStep, { props: { profileId: "main" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByText("Library synced")).toBeTruthy();
  });

  it("notices a phone that pairs while the step is searching the network", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      sync.paired.mockResolvedValue([]);
      render(FirstRunSyncStep, { props: { profileId: "main" } });
      await screen.findByText("OFFICE-PC");

      sync.paired.mockResolvedValue([{ deviceId: "phone-1", deviceName: "Galaxy S23", platform: "android", profileId: "main", grantedScopes: [], inactive: false }]);
      await vi.advanceTimersByTimeAsync(4000);

      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
      expect(screen.getByText("Galaxy S23")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits until synced comics are imported, leaving tracker logins connecting in the background", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      sync.progress.mockResolvedValue({ pendingProjections: 12, pendingTrackerLogins: 2, pendingDetails: 0 });
      sync.paired.mockResolvedValue([{ deviceId: "phone-1", deviceName: "Galaxy S23", platform: "android", profileId: "main", grantedScopes: [], inactive: false }]);
      render(FirstRunSyncStep, { props: { profileId: "main" } });

      await waitFor(() => expect(screen.getByText("Importing")).toBeTruthy());
      expect(document.querySelector('[data-scope="trackers"]')?.getAttribute("data-state")).toBe("connecting");
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

      sync.progress.mockResolvedValue({ pendingProjections: 0, pendingTrackerLogins: 1, pendingDetails: 0 });
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
      expect(document.querySelector('[data-scope="trackers"]')?.getAttribute("data-state")).toBe("connecting");
      expect(screen.getByText("Connecting · continues in background")).toBeTruthy();

      // Polling goes on after the step is ready, so the row settles once the logins sign in.
      sync.progress.mockResolvedValue({ pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 0 });
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(document.querySelector('[data-scope="trackers"]')?.getAttribute("data-state")).toBe("ready"));
      expect(screen.getByText("Library synced")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits until a paired phone has uploaded what it still had to send", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      sync.progress.mockResolvedValue({ pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 0, pendingUploads: null });
      sync.paired.mockResolvedValue([{ deviceId: "phone-1", deviceName: "Galaxy S23", platform: "android", profileId: "main", grantedScopes: [], inactive: false }]);
      render(FirstRunSyncStep, { props: { profileId: "main" } });

      await waitFor(() => expect(screen.getByText("Galaxy S23")).toBeTruthy());
      await vi.advanceTimersByTimeAsync(2000);
      expect(document.querySelector('[data-scope="comics"]')?.getAttribute("data-state")).toBe("syncing");
      expect(document.querySelector('[data-scope="trackers"]')?.getAttribute("data-state")).toBe("syncing");
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

      sync.progress.mockResolvedValue({ pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 0, pendingUploads: 37 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);

      sync.progress.mockResolvedValue({ pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 0, pendingUploads: 0 });
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
      expect(document.querySelector('[data-scope="trackers"]')?.getAttribute("data-state")).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold the step for details and chapters still arriving from sources", async () => {
    sync.progress.mockResolvedValue({ pendingProjections: 0, pendingTrackerLogins: 0, pendingDetails: 40 });
    sync.paired.mockResolvedValue([{ deviceId: "phone-1", deviceName: "Galaxy S23", platform: "android", profileId: "main", grantedScopes: [], inactive: false }]);
    render(FirstRunSyncStep, { props: { profileId: "main" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
    expect(await screen.findByText("Finishing in background")).toBeTruthy();
  });

  it("does not wait on a Core that cannot report its progress", async () => {
    sync.progress.mockResolvedValue(null);
    sync.paired.mockResolvedValue([{ deviceId: "phone-1", deviceName: "Galaxy S23", platform: "android", profileId: "main", grantedScopes: [], inactive: false }]);
    render(FirstRunSyncStep, { props: { profileId: "main" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false));
  });

  it("keeps the user on the code with a clear message when the PIN does not match", async () => {
    sync.resolve.mockRejectedValue("SYNC_PIN_NOT_FOUND");
    render(FirstRunSyncStep, { props: { profileId: "main" } });

    await choosePin("000000");

    expect(await screen.findByText("That code doesn't match. Check it on the other device.")).toBeTruthy();
    expect(sync.connect).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the code from OFFICE-PC")).toBeTruthy();
  });

  it("explains a declined request and lets the user enter a new code", async () => {
    render(FirstRunSyncStep, { props: { profileId: "main" } });
    await choosePin("123456");
    await screen.findByText("Approve on OFFICE-PC");

    sync.pairingListener?.(connectState("rejected"));

    expect(await screen.findByText("OFFICE-PC declined the request")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Enter the code from OFFICE-PC")).toBeTruthy();
    const inputs = screen.queryAllByLabelText(/^Digit \d+$/);
    expect(inputs.length).toBe(6);
    expect(inputs.every((input) => (input as HTMLInputElement).value === "")).toBe(true);
  });
});
