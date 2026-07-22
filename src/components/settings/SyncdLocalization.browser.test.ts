/// <reference types="@vitest/browser/matchers" />

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { applyAppLanguage } from "../../lib/i18n/runtime";

vi.mock("../../store/state.svelte", () => ({ addToast: vi.fn() }));

vi.mock("../../lib/syncdQr", () => ({
  buildSyncdQrDataUrl: vi.fn(async () => "data:image/png;base64,qr"),
  decodeSyncdQrDataUrl: vi.fn(async () => "{}"),
  decodeSyncdQrFile: vi.fn(async () => "{}"),
}));

vi.mock("../../lib/syncdDesktop", () => ({
  listenSyncdDesktopState: vi.fn(async () => () => {}),
  listenSyncdPairingStatus: vi.fn(async () => () => {}),
  listenSyncdReconnectStatus: vi.fn(async () => () => {}),
  listenSyncdReplicationState: vi.fn(async () => () => {}),
  syncdConnectWithBootstrap: vi.fn(),
  syncdDisconnectPersistedSession: vi.fn(),
  syncdForceReplicationReconnect: vi.fn(),
  syncdGetActiveHostPairing: vi.fn(async () => null),
  syncdGetRuntimeIdentity: vi.fn(async () => ({ pid: 100, serverId: "browser-audit" })),
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
  syncdHostDecidePairing: vi.fn(),
  syncdForgetPersistedSession: vi.fn(),
  syncdListDiscoveryCandidates: vi.fn(async () => []),
  syncdPauseReplication: vi.fn(),
  syncdResumeReplication: vi.fn(),
  syncdRevalidateSession: vi.fn(),
  syncdRevalidatePersistedSyncSessions: vi.fn(async () => []),
  syncdSetActiveReplicationSession: vi.fn(),
  syncdStartHostPairing: vi.fn(),
}));

import SyncdConnectionPanel from "./SyncdConnectionPanel.svelte";

async function expectDialogScreenshot(name: string) {
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(within(dialog).getByTestId("syncd-panel-grid").getAttribute("data-panel-ready")).toBe("ready");
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const rect = dialog.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  await (
    expect(dialog) as unknown as {
      toMatchAethonScreenshot: (screenshotName: string) => Promise<void>;
    }
  ).toMatchAethonScreenshot(name);
  return dialog;
}

describe("Syncd localization (browser)", () => {
  afterEach(() => {
    cleanup();
    applyAppLanguage("en");
  });

  test.each([
    ["es", "Emparejamiento de sincronización entre equipos"],
    ["ja", "デスクトップ同期のペアリング"],
    ["zh-CN", "桌面同步配对"],
  ] as const)("renders the main modal in %s without clipping", async (locale, heading) => {
    applyAppLanguage(locale);
    render(SyncdConnectionPanel, { props: { profileId: "main", scopeLabel: "MAIN" } });
    expect(await screen.findByText(heading)).toBeTruthy();
    await expectDialogScreenshot(`syncd-${locale}-pairing`);
  });

  test("keeps Details and Options within the viewport", async () => {
    applyAppLanguage("es");
    render(SyncdConnectionPanel, { props: { profileId: "main", scopeLabel: "MAIN" } });
    const dialog = await screen.findByRole("dialog");

    await fireEvent.click(within(dialog).getByTestId("syncd-modal-details"));
    expect(within(dialog).getByTestId("syncd-details-view").hidden).toBe(false);
    await expectDialogScreenshot("syncd-es-details");

    await fireEvent.click(within(dialog).getByTestId("syncd-modal-options"));
    expect(within(dialog).getByTestId("syncd-options-view").hidden).toBe(false);
    await expectDialogScreenshot("syncd-es-options");
  });
});
