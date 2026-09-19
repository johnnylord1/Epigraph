import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let pairingStatusListener: ((payload: unknown) => void) | null = null;
let desktopStateListener: ((payload: unknown) => void) | null = null;

const hostState = {
  profileId: "main",
  sessionId: "pairing-1",
  pairingCode: "EPIGRAPH42",
  syncdBaseUrl: "https://127.0.0.1:4877",
  localControlUrl: "http://127.0.0.1:4878",
  advertisedBaseUrl: "https://192.168.1.20:4877",
  tlsCertSha256: "sha256-test",
  expiresAtMs: Date.now() + 60_000,
  status: "pending" as const,
  claimedDeviceId: null,
  requestedScopes: ["comics:profile:main", "novels:profile:main", "books:global"],
  bootstrapBundle: JSON.stringify({ pairingSessionId: "pairing-1" }),
  hostReady: true,
  error: null,
};

vi.mock("../../store/state.svelte", () => ({ addToast: vi.fn() }));

vi.mock("../../lib/syncdQr", () => ({
  buildSyncdQrDataUrl: vi.fn(async () => "data:image/png;base64,qr"),
  decodeSyncdQrDataUrl: vi.fn(async () => hostState.bootstrapBundle),
  decodeSyncdQrFile: vi.fn(async () => hostState.bootstrapBundle),
}));

vi.mock("../../lib/syncdDesktop", () => ({
  listenSyncdDesktopState: vi.fn(async (listener: (payload: unknown) => void) => {
    desktopStateListener = listener;
    return () => {};
  }),
  listenSyncdPairingStatus: vi.fn(async (listener: (payload: unknown) => void) => {
    pairingStatusListener = listener;
    return () => {};
  }),
  listenSyncdReconnectStatus: vi.fn(async () => () => {}),
  listenSyncdReplicationState: vi.fn(async () => () => {}),
  syncdConnectWithBootstrap: vi.fn(),
  syncdDisconnectPersistedSession: vi.fn(),
  syncdForceReplicationReconnect: vi.fn(),
  syncdGetActiveHostPairing: vi.fn(async () => null),
  syncdGetRuntimeIdentity: vi.fn(async () => ({ pid: 100, serverId: "server-a", deviceName: "Jhow's desktop" })),
  syncdGetReplicationState: vi.fn(async () => ({
    localProfileId: "main",
    activeSessionKey: null,
    replicationStatus: "idle",
    paused: false,
    lastAppliedScopes: [],
  })),
  syncdGetSessionCatalog: vi.fn(async () => ({
    localProfileId: "main",
    activeSessionKey: null,
    replication: {
      localProfileId: "main",
      activeSessionKey: null,
      replicationStatus: "idle",
      paused: false,
      lastAppliedScopes: [],
    },
    sessions: [],
  })),
  syncdHostDecidePairing: vi.fn(async (_sessionId: string, decision: "approve" | "reject") => ({
    ...hostState,
    status: decision === "approve" ? "approved" : "rejected",
  })),
  syncdForgetPersistedSession: vi.fn(),
  syncdListDiscoveryCandidates: vi.fn(async () => []),
  syncdListPairedDevices: vi.fn(async () => []),
  syncdPauseReplication: vi.fn(),
  syncdResumeReplication: vi.fn(),
  syncdRevalidateSession: vi.fn(),
  syncdRevalidatePersistedSyncSessions: vi.fn(async () => []),
  syncdSetActiveReplicationSession: vi.fn(),
  syncdStartHostPairing: vi.fn(async () => hostState),
  syncdUpdatePairedDeviceGrantedScopes: vi.fn(),
}));

import SyncdConnectionPanel from "./SyncdConnectionPanel.svelte";
import {
  listenSyncdDesktopState,
  listenSyncdPairingStatus,
  syncdGetActiveHostPairing,
  syncdGetRuntimeIdentity,
  syncdHostDecidePairing,
  syncdListPairedDevices,
  syncdUpdatePairedDeviceGrantedScopes,
} from "../../lib/syncdDesktop";

describe("SyncdConnectionPanel", () => {
  beforeEach(() => {
    pairingStatusListener = null;
    desktopStateListener = null;
    vi.clearAllMocks();
    vi.mocked(syncdGetActiveHostPairing).mockResolvedValue(null);
    vi.mocked(syncdGetRuntimeIdentity).mockResolvedValue({ pid: 100, serverId: "server-a", deviceName: "Jhow's desktop" });
    vi.mocked(syncdHostDecidePairing).mockImplementation(async (_sessionId, decision) => ({
      ...hostState,
      status: decision === "approve" ? "approved" : "rejected",
    }));
    vi.mocked(syncdListPairedDevices).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  test("opens as a focused pairing flow and keeps technical content behind Details and advanced connection options", async () => {
    const onClose = vi.fn();
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile", onClose },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(within(dialog).getByTestId("syncd-pairing-view").hidden).toBe(false);
    expect(within(dialog).getByTestId("syncd-details-view").hidden).toBe(true);
    expect(within(dialog).queryByTestId("syncd-options-view")).toBeNull();
    expect(within(dialog).getByText("Pair a desktop")).toBeTruthy();

    await fireEvent.click(within(dialog).getByTestId("syncd-modal-details"));
    expect(within(dialog).getByTestId("syncd-details-view").hidden).toBe(false);
    expect(within(dialog).getAllByText("Connection details").length).toBeGreaterThan(0);

    const modalBody = dialog.querySelector<HTMLElement>(".syncd-modal__body");
    expect(modalBody).not.toBeNull();
    modalBody!.scrollTop = 240;
    await fireEvent.click(within(dialog).getByTestId("syncd-modal-pairing"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Load QR image" }));
    await fireEvent.click(within(dialog).getByTestId("syncd-modal-options"));
    expect(modalBody!.scrollTop).toBe(0);
    expect(within(dialog).getByTestId("syncd-options-view")).toBeTruthy();
    expect(within(dialog).getByTestId("syncd-bootstrap-bundle-input")).toBeTruthy();

    await fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("updates the live pairing view when the native listener reports a claim", async () => {
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile" },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await fireEvent.click(within(dialog).getByTestId("syncd-host-start"));
    await waitFor(() => expect(within(dialog).getByTestId("syncd-host-status-live").textContent).toContain("Pending"));
    expect(within(dialog).getByTestId("syncd-host-status-live").getAttribute("data-status")).toBe("pending");

    await waitFor(() => expect(pairingStatusListener).not.toBeNull());
    await act(async () => {
      pairingStatusListener?.({
        ...hostState,
        status: "claimed",
        claimedDeviceId: "desktop-2",
      });
    });

    expect(within(dialog).getAllByText("A desktop wants to connect").length).toBeGreaterThan(0);
    expect(within(dialog).getByTestId("syncd-host-status-live").getAttribute("data-status")).toBe("claimed");
    expect(within(dialog).getByTestId("syncd-host-approve")).toBeTruthy();
    expect(within(dialog).getByTestId("syncd-host-reject")).toBeTruthy();
  });

  test("refetches the active host after a pairing decision", async () => {
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile" },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await fireEvent.click(within(dialog).getByTestId("syncd-host-start"));
    await waitFor(() => expect(pairingStatusListener).not.toBeNull());
    await act(async () => {
      pairingStatusListener?.({
        ...hostState,
        status: "claimed",
        claimedDeviceId: "desktop-2",
      });
    });

    vi.mocked(syncdGetActiveHostPairing).mockResolvedValue({
      ...hostState,
      status: "approved",
      claimedDeviceId: "desktop-2",
    });
    await fireEvent.click(within(dialog).getByTestId("syncd-host-approve"));

    await waitFor(() => {
      expect(syncdHostDecidePairing).toHaveBeenCalledWith("pairing-1", "approve");
      expect(syncdGetActiveHostPairing).toHaveBeenCalledTimes(2);
      expect(within(dialog).getByTestId("syncd-host-status-live").getAttribute("data-status")).toBe("approved");
    });
  });

  test("reconnects native event listeners when the daemon identity changes", async () => {
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile" },
    });

    await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await waitFor(() => {
      expect(listenSyncdDesktopState).toHaveBeenCalledTimes(1);
      expect(listenSyncdPairingStatus).toHaveBeenCalledTimes(1);
      expect(desktopStateListener).not.toBeNull();
    });

    await act(async () => {
      desktopStateListener?.({
        host: null,
        connect: null,
        runtimeIdentity: { pid: 101, serverId: "server-b", deviceName: "Studio PC" },
      });
    });

    await waitFor(() => {
      expect(listenSyncdDesktopState).toHaveBeenCalledTimes(2);
      expect(listenSyncdPairingStatus).toHaveBeenCalledTimes(2);
      expect(syncdGetActiveHostPairing).toHaveBeenCalledTimes(2);
    });
  });

  test("identifies both desktops in the connected state", async () => {
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile" },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await waitFor(() => expect(desktopStateListener).not.toBeNull());
    await act(async () => {
      desktopStateListener?.({
        host: null,
        connect: {
          status: "connected",
          remoteOrigin: "https://192.168.1.20:4777",
          claimedDeviceId: "studio-pc",
          localDeviceName: "Jhow's Desktop",
          remoteDeviceName: "Studio PC",
        },
        runtimeIdentity: { pid: 101, serverId: "server-b", deviceName: "Jhow's Desktop" },
      });
    });

    expect(within(dialog).getAllByText("Jhow's Desktop").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Studio PC").length).toBeGreaterThan(0);
  });

  test("embeds in its host and reports real connection readiness", async () => {
    const onReadyChange = vi.fn();
    const onClose = vi.fn();
    const host = document.createElement("section");
    document.body.appendChild(host);
    render(SyncdConnectionPanel, {
      target: host,
      props: {
        profileId: "main",
        scopeLabel: "First run",
        presentation: "embedded",
        onReadyChange,
        onClose,
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    expect(host.contains(dialog)).toBe(true);
    expect(dialog.closest(".syncd-modal-backdrop")?.classList.contains("syncd-modal-backdrop--embedded")).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
    await fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(false));

    await waitFor(() => expect(desktopStateListener).not.toBeNull());
    await act(async () => {
      desktopStateListener?.({
        host: null,
        connect: { status: "connected", remoteOrigin: "https://192.168.1.20:4777" },
        runtimeIdentity: { pid: 101, serverId: "server-b", deviceName: "Studio PC" },
      });
    });
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  test("allows the modal to close while a host decision is pending", async () => {
    const onClose = vi.fn();
    vi.mocked(syncdHostDecidePairing).mockImplementation(() => new Promise(() => {}));
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile", onClose },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await fireEvent.click(within(dialog).getByTestId("syncd-host-start"));
    await waitFor(() => expect(pairingStatusListener).not.toBeNull());
    await act(async () => {
      pairingStatusListener?.({
        ...hostState,
        status: "claimed",
        claimedDeviceId: "desktop-2",
      });
    });

    await fireEvent.click(within(dialog).getByTestId("syncd-host-approve"));
    expect(within(dialog).getByTestId("syncd-host-approve").textContent).toContain("Approving");
    await fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("shows requested domains before approval and updates paired device permissions", async () => {
    const device = {
      deviceId: "android-1",
      deviceName: "Pixel",
      platform: "android" as const,
      profileId: "main",
      grantedScopes: ["comics:profile:main", "books:global"],
      lastSeenAtMs: Date.now(),
    };
    vi.mocked(syncdListPairedDevices).mockResolvedValue([device]);
    vi.mocked(syncdUpdatePairedDeviceGrantedScopes).mockImplementation(async (
      deviceId,
      profileId,
      grantedScopes,
    ) => ({ ...device, deviceId, profileId, grantedScopes }));

    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile" },
    });
    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await fireEvent.click(within(dialog).getByTestId("syncd-host-start"));
    await waitFor(() => expect(pairingStatusListener).not.toBeNull());
    await act(async () => {
      pairingStatusListener?.({
        ...hostState,
        status: "claimed",
        claimedDeviceId: "android-1",
      });
    });
    expect(within(dialog).getByTestId("syncd-requested-scopes").textContent).toContain("Comics");
    expect(within(dialog).getByTestId("syncd-requested-scopes").textContent).toContain("Books");

    await fireEvent.click(within(dialog).getByTestId("syncd-modal-details"));
    const permission = await within(dialog).findByTestId("syncd-paired-device-permission");
    const books = within(permission).getByRole("checkbox", { name: /Books/ });
    await fireEvent.click(books);

    await waitFor(() => {
      expect(syncdUpdatePairedDeviceGrantedScopes).toHaveBeenCalledWith(
        "android-1",
        "main",
        ["comics:profile:main"],
      );
    });
  });

  test("releases the decision controls when the native decision times out", async () => {
    vi.mocked(syncdHostDecidePairing).mockImplementation(() => new Promise(() => {}));
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile" },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await fireEvent.click(within(dialog).getByTestId("syncd-host-start"));
    await waitFor(() => expect(pairingStatusListener).not.toBeNull());
    await act(async () => {
      pairingStatusListener?.({
        ...hostState,
        status: "claimed",
        claimedDeviceId: "desktop-2",
      });
    });
    vi.mocked(syncdGetActiveHostPairing).mockResolvedValue({
      ...hostState,
      status: "claimed",
      claimedDeviceId: "desktop-2",
    });

    vi.useFakeTimers();
    await fireEvent.click(within(dialog).getByTestId("syncd-host-approve"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });

    expect(within(dialog).getByTestId("syncd-host-approve").hasAttribute("disabled")).toBe(false);
    expect(within(dialog).getAllByText(/decision timed out/i).length).toBeGreaterThan(0);
  });
});
