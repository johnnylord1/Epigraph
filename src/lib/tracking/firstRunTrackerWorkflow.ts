import { gql } from "../client";
import {
  GET_TRACKERS,
  LOGIN_TRACKER_CREDENTIALS,
  LOGIN_TRACKER_OAUTH,
  LOGOUT_TRACKER,
} from "../queries";
import { normalizeTrackerOAuthInput } from "../trackerOAuth";
import { publishTrackerLogin, publishTrackerLogout } from "../syncdTrackerCredentials";
import type { Tracker } from "../types";
import {
  connectHardcover,
  disconnectHardcover,
  loadHardcoverState,
  type HardcoverTrackingState,
} from "../novels/hardcover";
import { store } from "../../store/state.svelte";
import { cache, CACHE_KEYS } from "../cache";
import hardcoverIcon from "../../assets/service-icons/hardcover.png";

export type FirstRunTrackerAuthMode = "oauth" | "credentials" | "token";

export interface FirstRunTracker {
  id: string;
  name: string;
  iconUrl: string | null;
  authMode: FirstRunTrackerAuthMode;
  authUrl: string | null;
  connected: boolean;
}

export interface FirstRunTrackerProvider extends FirstRunTracker {
  kind: "suwayomi" | "hardcover";
}

export interface FirstRunTrackerWorkflowDependencies {
  loadTrackers(): Promise<readonly FirstRunTracker[]>;
  loginOAuth(trackerId: number, callbackUrl: string): Promise<boolean>;
  loginCredentials(trackerId: number, username: string, password: string): Promise<boolean>;
  logoutTracker(trackerId: number): Promise<boolean>;
  loadHardcover(): { connected: boolean; username: string | null };
  connectHardcover(token: string): Promise<{ connected: boolean; username: string | null }>;
  disconnectHardcover(): { connected: boolean; username: string | null };
}

function toProvider(tracker: FirstRunTracker): FirstRunTrackerProvider {
  return { ...tracker, kind: "suwayomi" };
}

function hardcoverProvider(state: { connected: boolean; username: string | null }): FirstRunTrackerProvider {
  return {
    id: "hardcover",
    name: "Hardcover",
    iconUrl: hardcoverIcon,
    authMode: "token",
    authUrl: null,
    connected: state.connected,
    kind: "hardcover",
  };
}

export function createFirstRunTrackerWorkflow(dependencies: FirstRunTrackerWorkflowDependencies) {
  let providers: FirstRunTrackerProvider[] = [];
  let loadError: string | null = null;
  let loadGeneration = 0;

  async function load(): Promise<readonly FirstRunTrackerProvider[]> {
    const generation = ++loadGeneration;
    const [trackers, hardcover] = await Promise.allSettled([
      Promise.resolve().then(() => dependencies.loadTrackers()),
      Promise.resolve().then(() => dependencies.loadHardcover()),
    ]);
    if (generation !== loadGeneration) return providers;
    loadError = [trackers, hardcover].flatMap((result) => result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : "A tracking service could not be loaded."] : []).join(" ") || null;
    providers = [
      ...(trackers.status === "fulfilled" ? trackers.value.map(toProvider) : providers.filter((provider) => provider.kind === "suwayomi")),
      ...(hardcover.status === "fulfilled" ? [hardcoverProvider(hardcover.value)] : providers.filter((provider) => provider.kind === "hardcover")),
    ];
    return providers;
  }

  function findSuwayomiTracker(id: string): FirstRunTrackerProvider {
    const provider = providers.find((candidate) => candidate.id === id && candidate.kind === "suwayomi");
    if (!provider) throw new Error("This tracker is no longer available. Refresh and try again.");
    return provider;
  }

  async function submitOAuth(id: string, rawCallback: string) {
    const provider = findSuwayomiTracker(id);
    if (provider.connected) return;
    if (provider.authMode !== "oauth") throw new Error("This tracker uses a username and password instead.");
    const tracker = {
      id: Number(id),
      name: provider.name,
      icon: provider.iconUrl ?? "",
      isLoggedIn: provider.connected,
      authUrl: provider.authUrl,
      supportsPrivateTracking: false,
      scores: [],
      statuses: [],
    } satisfies Tracker;
    const callbackUrl = normalizeTrackerOAuthInput(tracker, rawCallback);
    if (!callbackUrl) throw new Error("Paste the redirected URL or the authorization value first.");
    loadGeneration += 1;
    if (!await dependencies.loginOAuth(Number(id), callbackUrl)) throw new Error("The tracker login was not confirmed. Check your authorization and try again.");
    providers = providers.map((candidate) => candidate.id === id ? { ...candidate, connected: true } : candidate);
    await load();
  }

  async function submitCredentials(id: string, username: string, password: string) {
    const provider = findSuwayomiTracker(id);
    if (provider.connected) return;
    if (provider.authMode !== "credentials") throw new Error("This tracker uses OAuth instead.");
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) throw new Error("A username and password are required.");
    loadGeneration += 1;
    if (!await dependencies.loginCredentials(Number(id), normalizedUsername, password)) throw new Error("The tracker login was not confirmed. Check your credentials and try again.");
    providers = providers.map((candidate) => candidate.id === id ? { ...candidate, connected: true } : candidate);
    await load();
  }

  async function logout(id: string) {
    const provider = findSuwayomiTracker(id);
    if (!provider.connected) return;
    loadGeneration += 1;
    if (!await dependencies.logoutTracker(Number(provider.id))) throw new Error("The tracker disconnect was not confirmed. Try again.");
    providers = providers.map((candidate) => candidate.id === id ? { ...candidate, connected: false } : candidate);
    await load();
  }

  async function submitHardcover(token: string) {
    const normalized = token.trim();
    if (!normalized) throw new Error("A Hardcover API token is required.");
    loadGeneration += 1;
    const state = await dependencies.connectHardcover(normalized);
    if (!state.connected) throw new Error("The Hardcover connection was not confirmed. Check your API token.");
    providers = providers.map((provider) => provider.id === "hardcover"
      ? hardcoverProvider(state)
      : provider);
  }

  function disconnectHardcoverProvider() {
    loadGeneration += 1;
    dependencies.disconnectHardcover();
    providers = providers.map((provider) => provider.id === "hardcover"
      ? hardcoverProvider(dependencies.loadHardcover())
      : provider);
  }

  return {
    get providers() { return providers; },
    get loadError() { return loadError; },
    load,
    submitOAuth,
    submitCredentials,
    logout,
    submitHardcover,
    disconnectHardcover: disconnectHardcoverProvider,
  };
}

export type FirstRunTrackerWorkflow = ReturnType<typeof createFirstRunTrackerWorkflow>;

function currentScope() {
  return {
    profileId: store.runtimeResolvedLocalProfileId,
    serverUrl: store.runtimeServerUrl,
  };
}

export function createProductionFirstRunTrackerWorkflow(): FirstRunTrackerWorkflow {
  return createFirstRunTrackerWorkflow({
    loadTrackers: async () => {
      const result = await gql<{ trackers: { nodes: Tracker[] } }>(GET_TRACKERS);
      return (result.trackers.nodes ?? []).map((tracker) => ({
        id: String(tracker.id),
        name: tracker.name,
        iconUrl: tracker.icon || null,
        authMode: tracker.authUrl ? "oauth" as const : "credentials" as const,
        authUrl: tracker.authUrl,
        connected: tracker.isLoggedIn,
      }));
    },
    loginOAuth: async (trackerId, callbackUrl) => {
      const result = await gql<{ loginTrackerOAuth: { isLoggedIn: boolean } }>(LOGIN_TRACKER_OAUTH, { trackerId, callbackUrl });
      cache.clear(CACHE_KEYS.TRACKERS);
      const loggedIn = result.loginTrackerOAuth?.isLoggedIn === true;
      if (loggedIn) publishTrackerLogin({ id: trackerId }, callbackUrl);
      return loggedIn;
    },
    loginCredentials: async (trackerId, username, password) => {
      const result = await gql<{ loginTrackerCredentials: { isLoggedIn: boolean } }>(LOGIN_TRACKER_CREDENTIALS, { trackerId, username, password });
      cache.clear(CACHE_KEYS.TRACKERS);
      return result.loginTrackerCredentials?.isLoggedIn === true;
    },
    logoutTracker: async (trackerId) => {
      const result = await gql<{ logoutTracker: { tracker: { isLoggedIn: boolean } } }>(LOGOUT_TRACKER, { trackerId });
      cache.clear(CACHE_KEYS.TRACKERS);
      const loggedOut = result.logoutTracker?.tracker?.isLoggedIn === false;
      if (loggedOut) publishTrackerLogout({ id: trackerId });
      return loggedOut;
    },
    loadHardcover: () => {
      const state = loadHardcoverState(currentScope());
      return { connected: state.auth.connected, username: state.auth.username };
    },
    connectHardcover: async (token) => {
      const state: HardcoverTrackingState = await connectHardcover(currentScope(), token);
      return { connected: state.auth.connected, username: state.auth.username };
    },
    disconnectHardcover: () => {
      const state = disconnectHardcover(currentScope());
      return { connected: state.auth.connected, username: state.auth.username };
    },
  });
}
