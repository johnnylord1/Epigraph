import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SyncdEffectiveDiscoverySource =
  | "advertised-endpoint"
  | "manual-endpoint";

export type PairingSessionStatus =
  | "pending"
  | "claimed"
  | "approved"
  | "rejected"
  | "expired";

export type SyncdDesktopConnectionStatus =
  | "idle"
  | "pending"
  | "claimed"
  | "approved"
  | "rejected"
  | "expired"
  | "connected"
  | "unreachable"
  | "needs_reauth"
  | "tls_mismatch";

export interface SyncdBootstrapBundle {
  pairingSessionId: string;
  pairingCode: string;
  deviceName?: string | null;
  syncdBaseUrl: string;
  profileId: string;
  expiresAtMs: number;
  tlsCertSha256: string;
}

export interface SyncdDesktopDiscoveryCandidate {
  instanceName: string;
  /** The computer name shown on the other side's pairing screen. */
  deviceName: string;
  serverId: string;
  effectiveOrigin: string;
  effectiveSource: SyncdEffectiveDiscoverySource;
  discoveryOrigin: string;
  tlsCertSha256: string;
  supportsBootstrapSessionCreate: boolean;
  supportsBootstrapSessionFetch: boolean;
  supportsLivePairingStatus: boolean;
  fallbackOrigins: string[];
}

export interface SyncdHostPairingState {
  profileId: string;
  sessionId: string;
  pairingCode: string;
  syncdBaseUrl: string;
  localControlUrl: string;
  advertisedBaseUrl: string;
  tlsCertSha256: string;
  expiresAtMs: number;
  status: PairingSessionStatus;
  claimedDeviceId?: string | null;
  claimedDeviceName?: string | null;
  claimedPlatform?: string | null;
  requestedScopes: string[];
  bootstrapBundle: string;
  /** Six digits another desktop on the network types to pair without carrying the QR payload. */
  pairingPin?: string;
  hostReady: boolean;
  error?: string | null;
}

export interface SyncdConnectState {
  localProfileId: string;
  sessionId: string;
  remoteProfileId: string;
  remoteOrigin: string;
  tlsCertSha256: string;
  status: SyncdDesktopConnectionStatus;
  attemptedOrigin: string;
  fallbackOrigins: string[];
  claimedDeviceId?: string | null;
  localDeviceName: string;
  remoteDeviceName?: string | null;
  sessionKey?: string | null;
  error?: string | null;
}

export interface PersistedSyncSession {
  sessionKey: string;
  localProfileId: string;
  remoteServerId: string;
  remoteProfileId: string;
  remoteDeviceName?: string | null;
  canonicalOrigin: string;
  fallbackOrigins: string[];
  tlsCertSha256: string;
  accessToken: string;
  lastDiscoverySource: SyncdEffectiveDiscoverySource;
  lastValidatedAtMs?: number | null;
  lastKnownStatus: SyncdDesktopConnectionStatus;
}

export interface SyncdReconnectStatus {
  sessionKey: string;
  localProfileId: string;
  remoteOrigin: string;
  status: SyncdDesktopConnectionStatus;
  error?: string | null;
}

export type SyncdReplicationStatus =
  | "idle"
  | "connecting"
  | "replaying"
  | "live"
  | "paused"
  | "degraded"
  | "offline"
  | "needs_reauth";

export type SyncdReplicationReplayMode =
  | "changes_bootstrap"
  | "sse_live"
  | "recovery_replay";

export interface SyncdReplicationScopeCheckpoint {
  scopeId: string;
  lastAppliedServerVersion: number;
  minReplayableSeen: number;
  lastReplayMode: SyncdReplicationReplayMode;
  lastAppliedAtMs: number;
}

export interface SyncdReplicationSnapshot {
  localProfileId: string;
  activeSessionKey?: string | null;
  replicationStatus: SyncdReplicationStatus;
  lastConnectedAtMs?: number | null;
  /** Current remote worker acknowledgement; absent for persisted/host-only state. */
  remoteBootstrapGeneration?: number | null;
  lastError?: string | null;
  booksScopeCheckpoint?: SyncdReplicationScopeCheckpoint | null;
  novelsScopeCheckpoint?: SyncdReplicationScopeCheckpoint | null;
  comicsScopeCheckpoint?: SyncdReplicationScopeCheckpoint | null;
  paused: boolean;
  lastAppliedScopes: string[];
  lastAppliedAtMs?: number | null;
}

export interface SyncdSessionActionAvailability {
  canSetActive: boolean;
  canPause: boolean;
  canResume: boolean;
  canRevalidate: boolean;
  canDisconnect: boolean;
  canForget: boolean;
}

export interface PersistedSyncSessionView extends PersistedSyncSession {
  isActiveForSync: boolean;
  replicationStatus?: SyncdReplicationStatus | null;
  actions: SyncdSessionActionAvailability;
}

export interface SyncdSessionCatalog {
  localProfileId: string;
  activeSessionKey?: string | null;
  replication: SyncdReplicationSnapshot;
  sessions: PersistedSyncSessionView[];
}

export interface SyncdReplicationErrorPayload {
  profileId: string;
  error: string;
}

export interface SyncdRuntimeIdentity {
  pid: number;
  serverId?: string | null;
  deviceName: string;
}

export interface SyncdPairedDeviceView {
  deviceId: string;
  deviceName: string;
  platform: "android" | "desktop" | "unknown";
  profileId: string;
  grantedScopes: string[];
  lastSeenAtMs?: number | null;
  /** Every token passed its inactivity window; the device must pair again to sync. */
  inactive?: boolean;
}

export interface SyncdDesktopSnapshot {
  host?: SyncdHostPairingState | null;
  connect?: SyncdConnectState | null;
  runtimeIdentity?: SyncdRuntimeIdentity | null;
}

export interface SyncdConnectBootstrapInput {
  localProfileId: string;
  bootstrapBundle: string;
  manualOrigin?: string | null;
}

export interface SyncdResolvePairingPinInput {
  origin: string;
  tlsCertSha256: string;
  fallbackOrigins?: string[];
  pin: string;
}

export type PairingHostDecision = "approve" | "reject";


export interface SyncdDisconnectSessionInput {
  sessionKey: string;
}

export type SyncdPairingStatusPayload = SyncdHostPairingState | SyncdConnectState;

export function syncdListDiscoveryCandidates(): Promise<SyncdDesktopDiscoveryCandidate[]> {
  return invoke("syncd_list_discovery_candidates");
}

export function syncdResolvePairingPin(input: SyncdResolvePairingPinInput): Promise<string> {
  return invoke("syncd_resolve_pairing_pin", { input });
}

export function syncdStartHostPairing(profileId: string): Promise<SyncdHostPairingState> {
  return invoke("syncd_start_host_pairing", { profileId });
}

export function syncdGetActiveHostPairing(): Promise<SyncdHostPairingState | null> {
  return invoke("syncd_get_active_host_pairing");
}

export function syncdGetRuntimeIdentity(): Promise<SyncdRuntimeIdentity> {
  return invoke("syncd_get_runtime_identity");
}

export function syncdConnectWithBootstrap(
  input: SyncdConnectBootstrapInput,
): Promise<SyncdConnectState> {
  return invoke("syncd_connect_with_bootstrap", { input });
}

export function syncdHostDecidePairing(
  sessionId: string,
  decision: PairingHostDecision,
): Promise<SyncdHostPairingState> {
  return invoke("syncd_host_decide_pairing", { sessionId, decision });
}

export function syncdListPairedDevices(): Promise<SyncdPairedDeviceView[]> {
  return invoke("syncd_list_paired_devices");
}

/** Devices paired here, read only when this computer's Core already runs; never starts it. */
export function syncdListPairedDevicesIfRunning(): Promise<SyncdPairedDeviceView[]> {
  return invoke("syncd_list_paired_devices_if_running");
}

/** Synced data this computer's Core has not applied to Suwayomi yet, as counts. */
export interface SyncdSyncProgress {
  pendingProjections: number;
  /** The pending projections other than chapter progress; absent from older Cores. */
  pendingCatalogProjections?: number | null;
  pendingTrackerLogins: number;
  /** Works already in the library still fetching their details and chapter list. */
  pendingDetails: number;
  /** What paired devices still have to upload; null until each has reported a finished run. */
  pendingUploads?: number | null;
  /** Projections Core applied since it started; absent from older Cores. */
  appliedProjections?: number;
}

/** Null when this computer's Core is not running (or is older); never starts it. */
export function syncdGetSyncProgressIfRunning(): Promise<SyncdSyncProgress | null> {
  return invoke("syncd_get_sync_progress_if_running");
}

export function syncdUpdatePairedDeviceGrantedScopes(
  deviceId: string,
  profileId: string,
  grantedScopes: string[],
): Promise<SyncdPairedDeviceView> {
  return invoke("syncd_update_paired_device_granted_scopes", {
    deviceId,
    profileId,
    grantedScopes,
  });
}

export function syncdRevokePairedDevice(deviceId: string): Promise<void> {
  return invoke("syncd_revoke_paired_device", { deviceId });
}

export function syncdListPersistedSyncSessions(
  profileId: string,
): Promise<PersistedSyncSession[]> {
  return invoke("syncd_list_persisted_sync_sessions", { profileId });
}

export function syncdRevalidatePersistedSyncSessions(
  profileId: string,
): Promise<SyncdReconnectStatus[]> {
  return invoke("syncd_revalidate_persisted_sync_sessions", { profileId });
}

export function syncdDisconnectPersistedSession(
  sessionKey: string,
): Promise<void> {
  return invoke("syncd_disconnect_persisted_session", { input: { sessionKey } });
}

export function syncdGetReplicationState(
  profileId: string,
): Promise<SyncdReplicationSnapshot> {
  return invoke("syncd_get_replication_state", { profileId });
}

/** LNReader repositories and plugins the paired devices declared through Syncd. */
export type SyncdNovelDependencyDeclaration =
  | { kind: "repository"; repositoryId: string; canonicalUrl: string; enabled: boolean }
  | { kind: "plugin"; repositoryId: string; pluginId: string; version: string; enabled: boolean };

export function syncdGetNovelDependencyDeclarations(
  profileId: string,
): Promise<SyncdNovelDependencyDeclaration[]> {
  return invoke("syncd_get_novel_dependency_declarations", { profileId });
}

/** A local entry another device deleted after both held it. */
export type SyncdNovelDependencyRemoval =
  | { kind: "repository"; localRepositoryId: string }
  | { kind: "plugin"; pluginId: string };

export interface SyncdNovelDependencySyncPlan {
  /** Declarations to install when missing here. */
  declarations: SyncdNovelDependencyDeclaration[];
  /** Local entries to remove, plugins first. */
  removals: SyncdNovelDependencyRemoval[];
}

/** What to install and remove here so this desktop and the paired devices keep one list. */
export function syncdPlanNovelDependencySync(
  profileId: string,
): Promise<SyncdNovelDependencySyncPlan> {
  return invoke("syncd_plan_novel_dependency_sync", { profileId });
}

export function syncdSetActiveReplicationSession(
  profileId: string,
  sessionKey: string,
): Promise<SyncdReplicationSnapshot> {
  return invoke("syncd_set_active_replication_session", {
    input: { profileId, sessionKey },
  });
}

export function syncdPauseReplication(
  profileId: string,
): Promise<SyncdReplicationSnapshot> {
  return invoke("syncd_pause_replication", { input: { profileId } });
}

export function syncdResumeReplication(
  profileId: string,
): Promise<SyncdReplicationSnapshot> {
  return invoke("syncd_resume_replication", { input: { profileId } });
}

export function syncdForceReplicationReconnect(
  profileId: string,
): Promise<SyncdReplicationSnapshot> {
  return invoke("syncd_force_replication_reconnect", { input: { profileId } });
}

export function syncdGetSessionCatalog(
  profileId: string,
): Promise<SyncdSessionCatalog> {
  return invoke("syncd_get_session_catalog", { profileId });
}

export function syncdRevalidateSession(
  profileId: string,
  sessionKey: string,
): Promise<SyncdReconnectStatus> {
  return invoke("syncd_revalidate_session", { input: { profileId, sessionKey } });
}

export function syncdForgetPersistedSession(
  profileId: string,
  sessionKey: string,
): Promise<void> {
  return invoke("syncd_forget_persisted_session", { input: { profileId, sessionKey } });
}

export function listenSyncdDesktopState(
  handler: (payload: SyncdDesktopSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<SyncdDesktopSnapshot>("syncd-desktop-state", ({ payload }) => handler(payload));
}

export function listenSyncdPairingStatus(
  handler: (payload: SyncdPairingStatusPayload) => void,
): Promise<UnlistenFn> {
  return listen<SyncdPairingStatusPayload>("syncd-pairing-status", ({ payload }) => handler(payload));
}

export function listenSyncdReconnectStatus(
  handler: (payload: SyncdReconnectStatus) => void,
): Promise<UnlistenFn> {
  return listen<SyncdReconnectStatus>("syncd-reconnect-status", ({ payload }) => handler(payload));
}

export function listenSyncdReplicationState(
  handler: (payload: SyncdReplicationSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<SyncdReplicationSnapshot>("syncd-replication-state", ({ payload }) => handler(payload));
}

/** Also fires when this window brought the other computer's comics in. */
export async function listenSyncdComicLibraryChanged(
  handler: (payload: { localProfileId: string }) => void,
): Promise<UnlistenFn> {
  const unlisten = await listen<{ localProfileId: string }>("syncd-comic-library-changed", ({ payload }) => handler(payload));
  const onReconciled = (event: Event) => {
    const detail = (event as CustomEvent<{ localProfileId?: string }>).detail;
    if (detail?.localProfileId) handler({ localProfileId: detail.localProfileId });
  };
  window.addEventListener("epigraph-comic-library-reconciled", onReconciled);
  return () => {
    unlisten();
    window.removeEventListener("epigraph-comic-library-reconciled", onReconciled);
  };
}

export function listenSyncdReplicationError(
  handler: (payload: SyncdReplicationErrorPayload) => void,
): Promise<UnlistenFn> {
  return listen<SyncdReplicationErrorPayload>("syncd-replication-error", ({ payload }) => handler(payload));
}
