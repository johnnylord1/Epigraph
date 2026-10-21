import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined),
  open: vi.fn(async () => undefined),
  listeners: new Map<string, (event: { payload: any }) => unknown>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: any }) => unknown) => {
  native.listeners.set(name, handler);
  return () => { native.listeners.delete(name); };
}) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: native.open }));

import { createFirstRunTrackerWorkflow } from "../../lib/tracking/firstRunTrackerWorkflow";
import FirstRunTrackersStep from "./FirstRunTrackersStep.svelte";

afterEach(cleanup);
beforeEach(() => { native.listeners.clear(); native.invoke.mockClear(); native.open.mockClear(); });

it("renders compact tracker rows, only connects after user input, and permits skipping", async () => {
  let connected = false;
  const loginCredentials = vi.fn(async () => { connected = true; return true; });
  const workflow = createFirstRunTrackerWorkflow({
    loadTrackers: async () => [
      { id: "1", name: "AniList", iconUrl: null, authMode: "oauth" as const, authUrl: "https://oauth.test", connected: false },
      { id: "4", name: "MangaUpdates", iconUrl: null, authMode: "credentials" as const, authUrl: null, connected },
    ],
    loginOAuth: vi.fn(),
    loginCredentials,
    logoutTracker: vi.fn(),
    loadHardcover: () => ({ connected: false, username: null }),
    connectHardcover: vi.fn(),
    disconnectHardcover: vi.fn(),
  });
  const onContinue = vi.fn();
  const { container } = render(FirstRunTrackersStep, { props: { workflow, onContinue } });

  expect(await screen.findByRole("heading", { name: "Would you like to connect a tracker?" })).toBeTruthy();
  expect(container.querySelector(".settings-page, .settings-workbench, .rail")).toBeNull();
  expect(await screen.findByText("AniList")).toBeTruthy();
  expect(screen.getByText("MangaUpdates")).toBeTruthy();
  expect(screen.getByText("Hardcover")).toBeTruthy();
  expect(loginCredentials).not.toHaveBeenCalled();

  await fireEvent.click(screen.getByRole("button", { name: "Connect MangaUpdates" }));
  await fireEvent.input(screen.getByRole("textbox", { name: "Username or email" }), { target: { value: "reader" } });
  await fireEvent.input(screen.getByLabelText("Password"), { target: { value: "secret" } });
  await fireEvent.click(screen.getByRole("button", { name: "Connect account" }));
  await waitFor(() => expect(loginCredentials).toHaveBeenCalledWith(4, "reader", "secret"));

  await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect MangaUpdates" })).toBeTruthy());
  await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledOnce();
});

it("shows a login that arrives from a paired device while the step is open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let connected = false;
    const workflow = createFirstRunTrackerWorkflow({
      loadTrackers: async () => [{ id: "2", name: "AniList", iconUrl: null, authMode: "oauth" as const, authUrl: "https://oauth.test", connected }],
      loginOAuth: vi.fn(),
      loginCredentials: vi.fn(),
      logoutTracker: vi.fn(),
      loadHardcover: () => ({ connected: false, username: null }),
      connectHardcover: vi.fn(),
      disconnectHardcover: vi.fn(),
    });
    render(FirstRunTrackersStep, { props: { workflow } });
    expect(await screen.findByRole("button", { name: "Connect AniList" })).toBeTruthy();

    connected = true;
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect AniList" })).toBeTruthy());
  } finally {
    vi.useRealTimers();
  }
});

it("captures native OAuth automatically once and releases its listeners on success", async () => {
  let connected = false;
  const loginOAuth = vi.fn(async () => { connected = true; return true; });
  const workflow = createFirstRunTrackerWorkflow({
    loadTrackers: async () => [{ id: "1", name: "AniList", iconUrl: null, authMode: "oauth", authUrl: "https://anilist.test/oauth?response_type=token", connected }],
    loginOAuth, loginCredentials: vi.fn(), logoutTracker: vi.fn(),
    loadHardcover: () => ({ connected: false, username: null }), connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
  });
  render(FirstRunTrackersStep, { props: { workflow } });
  await fireEvent.click(await screen.findByRole("button", { name: "Connect AniList" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("open_tracker_oauth_window", { url: "https://anilist.test/oauth?response_type=token", sessionId: expect.any(String) }));
  expect(native.open).not.toHaveBeenCalled();
  const sessionId = native.invoke.mock.calls.find(([command]) => command === "open_tracker_oauth_window")![1]!.sessionId;
  const callback = native.listeners.get("tracker-oauth-callback")!;
  callback({ payload: { url: "https://suwayomi.org/tracker-oauth#access_token=test-token", sessionId } });
  callback({ payload: { url: "https://suwayomi.org/tracker-oauth#access_token=test-token", sessionId } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect AniList" })).toBeTruthy());
  expect(loginOAuth).toHaveBeenCalledOnce();
  expect(loginOAuth).toHaveBeenCalledWith(1, "access_token=test-token");
  expect(native.listeners.size).toBe(0);
});

it("ignores an old window's callback delivered to the new session listener", async () => {
  const loginOAuth = vi.fn().mockResolvedValue(true);
  const workflow = createFirstRunTrackerWorkflow({
    loadTrackers: async () => [{ id: "1", name: "AniList", iconUrl: null, authMode: "oauth", authUrl: "https://anilist.test/oauth", connected: false }],
    loginOAuth, loginCredentials: vi.fn(), logoutTracker: vi.fn(),
    loadHardcover: () => ({ connected: false, username: null }), connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
  });
  render(FirstRunTrackersStep, { props: { workflow } });
  await fireEvent.click(await screen.findByRole("button", { name: "Connect AniList" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("open_tracker_oauth_window", expect.anything()));
  const oldSessionId = native.invoke.mock.calls[0][1]?.sessionId;
  await fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await fireEvent.click(screen.getByRole("button", { name: "Connect AniList" }));
  await waitFor(() => expect(native.invoke.mock.calls.filter(([command]) => command === "open_tracker_oauth_window")).toHaveLength(2));
  const callback = native.listeners.get("tracker-oauth-callback")!;
  callback({ payload: { url: "https://suwayomi.org/tracker-oauth?code=old", sessionId: oldSessionId } });
  expect(loginOAuth).not.toHaveBeenCalled();
  const currentSessionId = native.invoke.mock.calls.filter(([command]) => command === "open_tracker_oauth_window")[1][1]?.sessionId;
  expect(currentSessionId).not.toBe(oldSessionId);
  callback({ payload: { url: "https://suwayomi.org/tracker-oauth?code=current", sessionId: currentSessionId } });
  await waitFor(() => expect(loginOAuth).toHaveBeenCalledOnce());
  expect(loginOAuth).toHaveBeenCalledWith(1, "code=current");
});

it("cancels native capture on close and ignores a late callback", async () => {
  const loginOAuth = vi.fn();
  const workflow = createFirstRunTrackerWorkflow({
    loadTrackers: async () => [{ id: "1", name: "AniList", iconUrl: null, authMode: "oauth", authUrl: "https://anilist.test/oauth", connected: false }],
    loginOAuth, loginCredentials: vi.fn(), logoutTracker: vi.fn(),
    loadHardcover: () => ({ connected: false, username: null }), connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
  });
  const { unmount } = render(FirstRunTrackersStep, { props: { workflow } });
  await fireEvent.click(await screen.findByRole("button", { name: "Connect AniList" }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledOnce());
  const callback = native.listeners.get("tracker-oauth-callback")!;
  await fireEvent.click(screen.getByRole("button", { name: "Close" }));
  callback({ payload: { url: "https://suwayomi.org/tracker-oauth?code=expired" } });
  expect(loginOAuth).not.toHaveBeenCalled();
  expect(native.listeners.size).toBe(0);
  await fireEvent.click(screen.getByRole("button", { name: "Connect AniList" }));
  await waitFor(() => expect(native.listeners.size).toBeGreaterThan(0));
  unmount();
  expect(native.listeners.size).toBe(0);
});

it("closes the connection sheet with Escape and returns focus to the tracker row", async () => {
  const workflow = createFirstRunTrackerWorkflow({
    loadTrackers: async () => [{ id: "4", name: "MangaUpdates", iconUrl: null, authMode: "credentials", authUrl: null, connected: false }],
    loginOAuth: vi.fn(), loginCredentials: vi.fn(), logoutTracker: vi.fn(),
    loadHardcover: () => ({ connected: false, username: null }), connectHardcover: vi.fn(), disconnectHardcover: vi.fn(),
  });
  render(FirstRunTrackersStep, { props: { workflow } });
  const row = await screen.findByRole("button", { name: "Connect MangaUpdates" });
  row.focus();
  await fireEvent.click(row);
  const sheet = await screen.findByRole("dialog");
  await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
  await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(row);
});
