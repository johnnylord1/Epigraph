import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let pairingStatusListener: ((payload: unknown) => void) | null = null;

const hostState = {
  profileId: "main",
  sessionId: "pairing-1",
  pairingCode: "AETHON42",
  syncdBaseUrl: "https://127.0.0.1:4877",
  localControlUrl: "http://127.0.0.1:4878",
  advertisedBaseUrl: "https://192.168.1.20:4877",
  tlsCertSha256: "sha256-test",
  expiresAtMs: Date.now() + 60_000,
  status: "pending" as const,
  claimedDeviceId: null,
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
  listenSyncdDesktopState: vi.fn(async () => () => {}),
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
  syncdPauseReplication: vi.fn(),
  syncdResumeReplication: vi.fn(),
  syncdRevalidateSession: vi.fn(),
  syncdRevalidatePersistedSyncSessions: vi.fn(async () => []),
  syncdSetActiveReplicationSession: vi.fn(),
  syncdStartHostPairing: vi.fn(async () => hostState),
}));

import SyncdConnectionPanel from "./SyncdConnectionPanel.svelte";

describe("SyncdConnectionPanel", () => {
  beforeEach(() => {
    pairingStatusListener = null;
  });

  afterEach(() => cleanup());

  test("opens as a focused pairing flow and keeps technical content behind Details and Options", async () => {
    const onClose = vi.fn();
    render(SyncdConnectionPanel, {
      props: { profileId: "main", scopeLabel: "Main profile", onClose },
    });

    const dialog = await screen.findByRole("dialog", { name: "Desktop sync pairing" });
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(within(dialog).getByTestId("syncd-pairing-view").hidden).toBe(false);
    expect(within(dialog).getByTestId("syncd-details-view").hidden).toBe(true);
    expect(within(dialog).getByTestId("syncd-options-view").hidden).toBe(true);
    expect(within(dialog).getByText("Pair another desktop")).toBeTruthy();

    await fireEvent.click(within(dialog).getByTestId("syncd-modal-details"));
    expect(within(dialog).getByTestId("syncd-details-view").hidden).toBe(false);
    expect(within(dialog).getByText("Connection details")).toBeTruthy();

    await fireEvent.click(within(dialog).getByTestId("syncd-modal-options"));
    expect(within(dialog).getByTestId("syncd-options-view").hidden).toBe(false);
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

    expect(within(dialog).getByText("A desktop wants to connect")).toBeTruthy();
    expect(within(dialog).getByTestId("syncd-host-status-live").getAttribute("data-status")).toBe("claimed");
    expect(within(dialog).getByTestId("syncd-host-approve")).toBeTruthy();
    expect(within(dialog).getByTestId("syncd-host-reject")).toBeTruthy();
  });
});
