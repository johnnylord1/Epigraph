import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let pairingStatusListener: ((payload: unknown) => void) | null = null;
let desktopStateListener: ((payload: unknown) => void) | null = null;
let replicationStateListener: ((payload: unknown) => void) | null = null;
vi.mock("../../lib/setup/firstRunSyncReadiness", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/setup/firstRunSyncReadiness")>(),
  refreshFirstRunSyncLibrary: vi.fn(async () => {}),
}));

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

vi.mock("../../store/state.svelte", async () => {
  const { SvelteMap } = await import("svelte/reactivity");
  const target = new SvelteMap([["server", "fixture"]]);
  return { addToast: vi.fn(), store: {
    get runtimeServerUrl() { return target.get("server") ?? ""; },
    set runtimeServerUrl(value: string) { target.set("server", value); },
    runtimeResolvedLocalProfileId: "main", settings: { defaultLocalProfileId: "main" },
  } };
});

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
  listenSyncdReplicationState: vi.fn(async (listener: (payload: unknown) => void) => {
    replicationStateListener = listener;
    return () => {};
  }),
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
  syncdRevokePairedDevice: vi.fn(),
  syncdStartHostPairing: vi.fn(async () => hostState),
  syncdUpdatePairedDeviceGrantedScopes: vi.fn(),
}));

import SyncdConnectionPanel from "./SyncdConnectionPanel.svelte";
import { store } from "../../store/state.svelte";
import { refreshFirstRunSyncLibrary } from "../../lib/setup/firstRunSyncReadiness";
import {
  listenSyncdDesktopState,
  listenSyncdPairingStatus,
  syncdGetActiveHostPairing,
  syncdGetRuntimeIdentity,
  syncdGetReplicationState,
  syncdGetSessionCatalog,
  syncdHostDecidePairing,
  syncdListPairedDevices,
  syncdRevokePairedDevice,
  syncdUpdatePairedDeviceGrantedScopes,
} from "../../lib/syncdDesktop";
import type { SyncdReplicationSnapshot } from "../../lib/syncdDesktop";

describe("SyncdConnectionPanel", () => {
  beforeEach(() => {
    pairingStatusListener = null;
    desktopStateListener = null;
    vi.clearAllMocks();
    store.runtimeServerUrl = "fixture";
    replicationStateListener = null;
    vi.mocked(refreshFirstRunSyncLibrary).mockReset().mockResolvedValue(undefined);
    vi.mocked(syncdGetReplicationState).mockResolvedValue({ localProfileId: "main", activeSessionKey: null, replicationStatus: "idle", paused: false, lastAppliedScopes: [] });
    vi.mocked(syncdGetSessionCatalog).mockResolvedValue({ localProfileId: "main", activeSessionKey: null, replication: { localProfileId: "main", activeSessionKey: null, replicationStatus: "idle", paused: false, lastAppliedScopes: [] }, sessions: [] });
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
        claimedPlatform: "desktop",
      });
    });

    expect(within(dialog).getAllByText("A desktop wants to connect").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Approve only if the other computer shows the same code.")).toBeTruthy();
    expect(within(dialog).getByTestId("syncd-host-status-live").getAttribute("data-status")).toBe("claimed");
    expect(within(dialog).getByTestId("syncd-host-approve")).toBeTruthy();
    expect(within(dialog).getByTestId("syncd-host-reject")).toBeTruthy();
  });

  test.each([
    ["android", "A phone wants to connect", "Approve only if the phone shows the same code."],
    [null, "A device wants to connect", "Approve only if the other device shows the same code."],
  ])("names a %s claimant without calling it a desktop", async (claimedPlatform, title, hint) => {
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
        claimedDeviceName: "Google sdk_gphone64_x86_64",
        claimedPlatform,
      });
    });

    expect(within(dialog).getAllByText(title).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(hint)).toBeTruthy();
    expect(within(dialog).queryByText("A desktop wants to connect")).toBeNull();
    expect(within(dialog).queryByText("Approve only if the other computer shows the same code.")).toBeNull();
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

  test("embeds in its host but pairing alone does not complete initial synchronization", async () => {
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
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(false));
  });

  test.each(["idle", "connecting", "replaying", "paused", "offline", "degraded", "needs_reauth"] as const)("does not finish setup with an active session that is %s", async (replicationStatus) => {
    const replication = { localProfileId: "main", activeSessionKey: "paired-session", replicationStatus, paused: replicationStatus === "paused", lastAppliedScopes: [] };
    vi.mocked(syncdGetReplicationState).mockResolvedValue(replication);
    vi.mocked(syncdGetSessionCatalog).mockResolvedValue({ localProfileId: "main", activeSessionKey: "paired-session", replication, sessions: [] });
    const onReadyChange = vi.fn();
    render(SyncdConnectionPanel, { profileId: "main", scopeLabel: "First run", presentation: "embedded", onReadyChange });
    await waitFor(() => expect(syncdGetSessionCatalog).toHaveBeenCalled());
    await act(async () => {});
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
  });

  test("waits for library hydration and ignores detached results", async () => {
    const onReadyChange = vi.fn();
    const live: SyncdReplicationSnapshot = { localProfileId: "main", activeSessionKey: "remote", replicationStatus: "live", remoteBootstrapGeneration: 1, paused: false, lastAppliedScopes: [] };
    let resolveRefresh!: () => void;
    vi.mocked(refreshFirstRunSyncLibrary).mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    // Keep follow-up reads consistent with the newest event.
    let snapshot: SyncdReplicationSnapshot = { ...live, replicationStatus: "replaying" };
    vi.mocked(syncdGetReplicationState).mockImplementation(async () => snapshot);
    vi.mocked(syncdGetSessionCatalog).mockImplementation(async () => ({ localProfileId: "main", activeSessionKey: "remote", replication: snapshot, sessions: [] }));
    render(SyncdConnectionPanel, { profileId: "main", scopeLabel: "First run", presentation: "embedded", onReadyChange });
    await waitFor(() => expect(replicationStateListener).not.toBeNull());
    await act(async () => { snapshot = live; replicationStateListener?.(snapshot); });
    await waitFor(() => expect(refreshFirstRunSyncLibrary).toHaveBeenCalledTimes(1));
    expect(within(screen.getByRole("dialog")).getByTestId("syncd-initial-sync-status").dataset.phase).toBe("loading");
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    // Loss of readiness fences completion from an earlier refresh.
    await act(async () => { snapshot = { ...live, paused: true }; replicationStateListener?.(snapshot); });
    await act(async () => resolveRefresh());
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
    expect(refreshFirstRunSyncLibrary).toHaveBeenCalledTimes(1);
  });

  test("publishes ready after the mounted hydration attempt resolves", async () => {
    const onReadyChange = vi.fn();
    const live = { localProfileId: "main", activeSessionKey: "remote", replicationStatus: "live" as const, remoteBootstrapGeneration: 1, paused: false, lastAppliedScopes: [] };
    let resolveRefresh!: () => void;
    vi.mocked(refreshFirstRunSyncLibrary).mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    vi.mocked(syncdGetReplicationState).mockResolvedValue(live);
    vi.mocked(syncdGetSessionCatalog).mockResolvedValue({ localProfileId: "main", activeSessionKey: "remote", replication: live, sessions: [] });
    render(SyncdConnectionPanel, { profileId: "main", scopeLabel: "First run", presentation: "embedded", onReadyChange });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    await waitFor(() => expect(refreshFirstRunSyncLibrary).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByTestId("syncd-initial-sync-status").dataset.phase).toBe("loading");

    await act(async () => resolveRefresh());

    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
    expect(within(dialog).queryByTestId("syncd-initial-sync-status")).toBeNull();
  });

  test("keeps the active hydration attempt attached across an unrelated replication update", async () => {
    const onReadyChange = vi.fn();
    const live = { localProfileId: "main", activeSessionKey: "remote", replicationStatus: "live" as const, remoteBootstrapGeneration: 1, paused: false, lastAppliedScopes: [] };
    let resolveRefresh!: () => void;
    vi.mocked(refreshFirstRunSyncLibrary).mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    vi.mocked(syncdGetReplicationState).mockResolvedValue(live);
    vi.mocked(syncdGetSessionCatalog).mockResolvedValue({ localProfileId: "main", activeSessionKey: "remote", replication: live, sessions: [] });
    render(SyncdConnectionPanel, { profileId: "main", scopeLabel: "First run", presentation: "embedded", onReadyChange });
    await waitFor(() => expect(refreshFirstRunSyncLibrary).toHaveBeenCalledTimes(1));

    await act(async () => {
      replicationStateListener?.({ ...live, novelsScopeCheckpoint: { scopeId: "novels:main", lastAppliedServerVersion: 2 } });
    });
    expect(refreshFirstRunSyncLibrary).toHaveBeenCalledTimes(1);

    await act(async () => resolveRefresh());
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  test("keeps a failed initial hydration visible until the user retries", async () => {
    const onReadyChange = vi.fn();
    const live = { localProfileId: "main", activeSessionKey: "remote", replicationStatus: "live" as const, remoteBootstrapGeneration: 1, paused: false, lastAppliedScopes: [] };
    vi.mocked(syncdGetReplicationState).mockResolvedValue(live);
    vi.mocked(syncdGetSessionCatalog).mockResolvedValue({ localProfileId: "main", activeSessionKey: "remote", replication: live, sessions: [] });
    vi.mocked(refreshFirstRunSyncLibrary).mockRejectedValue(Error("private diagnostic"));
    render(SyncdConnectionPanel, { profileId: "main", scopeLabel: "First run", presentation: "embedded", onReadyChange });
    const error = await screen.findByTestId("syncd-initial-sync-error");
    expect(error.textContent).not.toContain("private diagnostic");
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    vi.mocked(refreshFirstRunSyncLibrary).mockResolvedValue(undefined);
    await fireEvent.click(within(error).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  test.each([undefined, 0])("does not adopt persisted Live without a current bootstrap generation (%s)", async remoteBootstrapGeneration => {
    const replication = { localProfileId: "main", activeSessionKey: "remote", replicationStatus: "live" as const, remoteBootstrapGeneration, paused: false, lastAppliedScopes: [] };
    vi.mocked(syncdGetReplicationState).mockResolvedValue(replication);
    vi.mocked(syncdGetSessionCatalog).mockResolvedValue({ localProfileId: "main", activeSessionKey: "remote", replication, sessions: [] });
    const onReadyChange = vi.fn();
    render(SyncdConnectionPanel, { profileId: "main", scopeLabel: "First run", presentation: "embedded", onReadyChange });
    await waitFor(() => expect(syncdGetSessionCatalog).toHaveBeenCalled());
    await act(async () => {});
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
    expect(refreshFirstRunSyncLibrary).not.toHaveBeenCalled();
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

  test("revokes a paired device only after the second click", async () => {
    vi.mocked(syncdListPairedDevices).mockResolvedValue([{
      deviceId: "android-1",
      deviceName: "Pixel",
      platform: "android" as const,
      profileId: "main",
      grantedScopes: ["comics:profile:main"],
      lastSeenAtMs: Date.now(),
    }]);
    vi.mocked(syncdRevokePairedDevice).mockResolvedValue(undefined);

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
    await fireEvent.click(within(dialog).getByTestId("syncd-modal-details"));
    const revoke = await within(dialog).findByTestId("syncd-revoke-paired-device");

    await fireEvent.click(revoke);
    expect(syncdRevokePairedDevice).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByTestId("syncd-revoke-paired-device"));

    await waitFor(() => expect(syncdRevokePairedDevice).toHaveBeenCalledWith("android-1"));
    await waitFor(() => {
      expect(within(dialog).queryByTestId("syncd-revoke-paired-device")).toBeNull();
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
