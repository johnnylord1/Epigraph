import { cleanup, fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import SyncdSessionDetails from "./SyncdSessionDetails.svelte";

const baseSession = {
  sessionKey: "session-key-1",
  localProfileId: "main",
  remoteServerId: "server-1",
  remoteProfileId: "remote-profile",
  canonicalOrigin: "https://192.168.1.25:4777",
  fallbackOrigins: ["https://192.168.1.25:4778"],
  tlsCertSha256: "abc123",
  accessToken: "token",
  lastDiscoverySource: "advertised-endpoint" as const,
  lastValidatedAtMs: Date.now(),
  lastKnownStatus: "connected" as const,
  isActiveForSync: false,
  replicationStatus: "live" as const,
  actions: {
    canSetActive: true,
    canPause: true,
    canResume: true,
    canRevalidate: true,
    canDisconnect: true,
    canForget: true,
  },
};

describe("SyncdSessionDetails", () => {
  afterEach(() => cleanup());

  test("opens details, keeps the surface compact, and fires the selected action", async () => {
    const onSetActive = vi.fn();
    const onRevalidate = vi.fn();
    const onDisconnect = vi.fn();
    const onForget = vi.fn();

    render(SyncdSessionDetails, {
      props: {
        session: baseSession,
        statusLabel: "Connected",
        statusTone: "success",
        summary: "Advertised endpoint | Connected | Replication Live",
        lastValidatedLabel: "Just revalidated",
        replicationLabel: "Live",
        onSetActive,
        onRevalidate,
        onDisconnect,
        onForget,
      },
    });

    expect(screen.getByRole("button", { name: "Open session details for remote-profile" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "Open session details for remote-profile" }));

    const dialog = screen.getByRole("dialog", { name: "remote-profile" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("Connection")).toBeTruthy();
    expect(within(dialog).getByText("Session key")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Set active" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Revalidate" })).toBeTruthy();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Set active" }));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Revalidate" }));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));

    expect(onSetActive).toHaveBeenCalledTimes(1);
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onForget).toHaveBeenCalledTimes(1);

    await fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("shows the pause/resume action for the active session", async () => {
    const onPauseResume = vi.fn();

    render(SyncdSessionDetails, {
      props: {
        session: {
          ...baseSession,
          isActiveForSync: true,
        },
        statusLabel: "Connected",
        statusTone: "success",
        summary: "Advertised endpoint | Connected | Replication Live",
        lastValidatedLabel: "Just revalidated",
        replicationLabel: "Live",
        isReplicationPaused: true,
        onPauseResume,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open session details for remote-profile" }));

    const dialog = screen.getByRole("dialog", { name: "remote-profile" });
    expect(within(dialog).queryByRole("button", { name: "Set active" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Resume replication" })).toBeTruthy();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Resume replication" }));
    expect(onPauseResume).toHaveBeenCalledTimes(1);
  });
});
