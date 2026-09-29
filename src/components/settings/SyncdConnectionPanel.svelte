<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { operationFailure, presentOperationFailure, type OperationFailure } from "../../lib/i18n/operationPresentation";
  import { _ } from "../../lib/i18n/runtime";
  import { onMount } from "svelte";
  import { firstRunSyncReadinessKey, refreshFirstRunSyncLibrary } from "../../lib/setup/firstRunSyncReadiness";
  import { CircleNotch, X } from "phosphor-svelte";
  import { addToast, store } from "../../store/state.svelte";
  import { buildSyncdQrDataUrl, decodeSyncdQrDataUrl, decodeSyncdQrFile } from "../../lib/syncdQr";
  import NocturneState from "../shared/NocturneState.svelte";
  import {
    listenSyncdDesktopState,
    listenSyncdPairingStatus,
    listenSyncdReconnectStatus,
    listenSyncdReplicationState,
    syncdConnectWithBootstrap,
    syncdDisconnectPersistedSession,
    syncdForceReplicationReconnect,
    syncdGetActiveHostPairing,
    syncdGetReplicationState,
    syncdGetRuntimeIdentity,
    syncdGetSessionCatalog,
    syncdHostDecidePairing,
    syncdListPairedDevices,
    syncdForgetPersistedSession,
    syncdListDiscoveryCandidates,
    syncdPauseReplication,
    syncdResumeReplication,
    syncdRevalidateSession,
    syncdRevalidatePersistedSyncSessions,
    syncdSetActiveReplicationSession,
    syncdStartHostPairing,
    syncdUpdatePairedDeviceGrantedScopes,
    type PairingHostDecision,
    type PersistedSyncSessionView,
    type SyncdConnectState,
    type SyncdDesktopConnectionStatus,
    type SyncdDesktopDiscoveryCandidate,
    type SyncdDesktopSnapshot,
    type SyncdHostPairingState,
    type SyncdPairedDeviceView,
    type SyncdReplicationSnapshot,
    type SyncdReconnectStatus,
    type SyncdRuntimeIdentity,
  } from "../../lib/syncdDesktop";
  import { pairingVerificationCode } from "../../lib/syncPairingVerification";

  interface Props {
    profileId?: string | null;
    scopeLabel: string;
    onClose?: () => void;
    presentation?: "modal" | "embedded";
    onReadyChange?: (ready: boolean) => void;
  }

  let {
    profileId = null,
    scopeLabel,
    onClose = () => {},
    presentation = "modal",
    onReadyChange = () => {},
  }: Props = $props();

  type SyncdModalView = "pairing" | "details" | "options";
  type SyncdPairingMode = "create" | "use";

  let host = $state<SyncdHostPairingState | null>(null);
  let connect = $state<SyncdConnectState | null>(null);
  let candidates = $state<SyncdDesktopDiscoveryCandidate[]>([]);
  let persistedSessions = $state<PersistedSyncSessionView[]>([]);
  let pairedDevices = $state<SyncdPairedDeviceView[]>([]);
  let replicationSnapshot = $state<SyncdReplicationSnapshot | null>(null);
  let lastReconnectStatuses = $state<Record<string, SyncdReconnectStatus>>({});
  let loadingCandidates = $state(false);
  let loadingHost = $state(false);
  let loadingPersisted = $state(false);
  let loadingPairedDevices = $state(false);
  let pairedDeviceScopeBusy = $state<string | null>(null);
  let connectBusy = $state(false);
  let hostDecisionBusy = $state<PairingHostDecision | null>(null);
  let revalidateBusy = $state(false);
  let disconnectBusyKey = $state<string | null>(null);
  let forgetBusyKey = $state<string | null>(null);
  let activeSessionBusyKey = $state<string | null>(null);
  let singleRevalidateBusyKey = $state<string | null>(null);
  let replicationActionBusy = $state<"pause" | "resume" | "reconnect" | null>(null);
  let persistedSessionsRefreshInFlight = false;
  let persistedSessionsRefreshQueued = false;
  let manualOrigin = $state("");
  let bootstrapBundleInput = $state("");
  let panelError = $state<OperationFailure | null>(null);
  const panelErrorText = $derived(presentOperationFailure(panelError, $_));
  let copiedBundle = $state(false);
  let qrCodeDataUrl = $state<string | null>(null);
  let qrBusy = $state(false);
  let qrDecodeBusy = $state(false);
  let hostStartStage = $state<"idle" | "requesting" | "bootstrap_ready" | "complete" | "error">("idle");
  let qrFileInput = $state<HTMLInputElement | null>(null);
  let manualOriginInput = $state<HTMLInputElement | null>(null);
  let bootstrapBundleTextarea = $state<HTMLTextAreaElement | null>(null);
  let panelSubscriptionsReady = $state(false);
  let modalView = $state<SyncdModalView>("pairing");
  let pairingMode = $state<SyncdPairingMode>("create");
  let advancedConnectOpen = $state(false);
  let modalElement = $state<HTMLElement | null>(null);
  let modalBodyElement = $state<HTMLElement | null>(null);
  let runtimeIdentity = $state<SyncdRuntimeIdentity | null>(null);
  let panelMounted = $state(false);
  let subscriptionGeneration = 0;
  let replicationReadGeneration = 0;
  let initialSyncReady = $state(false);
  let initialSyncError = $state<OperationFailure | null>(null);
  let initialSyncPhase = $state<"idle" | "loading" | "ready" | "error">("idle");
  let initialSyncRetry = $state(0);
  let initialSyncAttemptKey: string | null = null;
  let initialSyncRunId = 0;
  const initialSyncKey = $derived.by(() => {
    const key = firstRunSyncReadinessKey(activeProfileId, replicationSnapshot);
    const targetProfile = store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId;
    return key && activeProfileId === targetProfile ? JSON.stringify([key, store.runtimeServerUrl]) : null;
  });
  let panelUnlisteners: Array<() => void> = [];

  const HOST_DECISION_TIMEOUT_MS = 10_000;
  const HOST_REFRESH_TIMEOUT_MS = 4_000;

  const activeProfileId = $derived.by(
    () => (typeof profileId === "string" && profileId.trim().length > 0 ? profileId : null),
  );

  const operationBusy = $derived(
    loadingHost
      || connectBusy
      || hostDecisionBusy !== null
      || replicationActionBusy !== null
      || host?.status === "pending"
      || host?.status === "claimed"
      || connect?.status === "pending"
      || connect?.status === "claimed"
      || replicationSnapshot?.replicationStatus === "connecting"
      || replicationSnapshot?.replicationStatus === "replaying",
  );

  const overviewStatus = $derived.by(() => {
    if (panelError) return { tone: "danger", label: translate("syncd_status_actionRequired"), title: translate("syncd_modal_syncNeedsAttention"), body: panelErrorText };
    if (connect?.status === "connected") {
      return { tone: "success", label: statusLabel("connected"), title: translate("syncd_modal_desktopSyncActive"), body: translate("syncd_modal_pairedChangesReplicate") };
    }
    if (connect?.status === "approved") {
      return { tone: "info", label: statusLabel("approved"), title: translate("syncd_modal_finishingSecureConnection"), body: translate("syncd_modal_hostApprovedEstablishing") };
    }
    if (connect?.status === "claimed" || connect?.status === "pending") {
      return { tone: "info", label: statusLabel(connect.status), title: translate("syncd_modal_waitingHostApproval"), body: translate("syncd_modal_keepWindowsOpen") };
    }
    if (host?.status === "claimed") {
      return { tone: "info", label: translate("syncd_status_approvalNeeded"), title: translate("syncd_modal_desktopWantsConnect"), body: translate("syncd_modal_reviewApprove") };
    }
    if (host?.status === "approved") {
      return { tone: "success", label: statusLabel("approved"), title: translate("syncd_modal_pairingApproved"), body: translate("syncd_modal_otherDesktopComplete") };
    }
    if (host?.status === "pending") {
      return { tone: "info", label: translate("syncd_status_waiting"), title: translate("syncd_modal_readyToPair"), body: translate("syncd_modal_scanQrOrCopy") };
    }
    if (replicationSnapshot?.activeSessionKey) {
      const paused = replicationSnapshot.paused;
      return {
        tone: paused ? "neutral" : replicationStatusTone(replicationSnapshot.replicationStatus),
        label: paused ? statusLabel("paused") : statusLabel(replicationSnapshot.replicationStatus),
        title: paused ? translate("syncd_modal_desktopSyncPaused") : translate("syncd_modal_desktopSyncConfigured"),
        body: paused ? translate("syncd_modal_resumeExchangeActivity") : translate("syncd_modal_trustedSessionReady"),
      };
    }
    if (loadingHost || connectBusy) {
      return { tone: "info", label: translate("syncd_status_working"), title: translate("syncd_modal_preparingSecurePairing"), body: translate("syncd_modal_creatingEncryptedSession") };
    }
    return { tone: "neutral", label: statusLabel("ready"), title: translate("syncd_modal_pairAnotherDesktop"), body: translate("syncd_modal_pairAnotherDesktopHint") };
  });

  const activeSession = $derived.by(() => {
    const activeKey = replicationSnapshot?.activeSessionKey;
    return activeKey ? persistedSessions.find((session) => session.sessionKey === activeKey) ?? null : null;
  });

  const localDeviceName = $derived(
    connect?.localDeviceName?.trim()
      || runtimeIdentity?.deviceName?.trim()
      || translate("syncd_modal_currentDevice"),
  );

  const remoteDeviceName = $derived.by(() => {
    const claimedDeviceId = host?.claimedDeviceId ?? connect?.claimedDeviceId ?? null;
    const pairedDevice = claimedDeviceId
      ? pairedDevices.find((device) => device.deviceId === claimedDeviceId)
      : null;
    return host?.claimedDeviceName?.trim()
      || connect?.remoteDeviceName?.trim()
      || activeSession?.remoteDeviceName?.trim()
      || pairedDevice?.deviceName?.trim()
      || activeSession?.remoteServerId?.trim()
      || claimedDeviceId?.trim()
      || translate("syncd_status_waiting");
  });

  const remotePlatformLabel = $derived.by(() => {
    const claimedDeviceId = host?.claimedDeviceId ?? connect?.claimedDeviceId ?? null;
    const pairedDevice = claimedDeviceId
      ? pairedDevices.find((device) => device.deviceId === claimedDeviceId)
      : null;
    return host?.claimedPlatform?.trim()
      || pairedDevice?.platform
      || translate("syncd_modal_pairDesktop");
  });

  /* Seconds left on the open host pairing. The PIN renews itself while this panel stays open. */
  let hostNowMs = $state(Date.now());
  let hostRenewing = false;
  const hostSecondsLeft = $derived(host ? Math.max(0, Math.ceil((host.expiresAtMs - hostNowMs) / 1000)) : 0);
  const hostPinDisplay = $derived(host?.pairingPin ? `${host.pairingPin.slice(0, 3)} ${host.pairingPin.slice(3)}` : null);
  const hostVerificationCode = $derived(host ? pairingVerificationCode(host.tlsCertSha256) : "");

  $effect(() => {
    if (pairingStage !== "waiting" || !host) return;
    const timer = window.setInterval(() => {
      hostNowMs = Date.now();
      if (host && host.status === "pending" && host.expiresAtMs <= hostNowMs && !hostRenewing && !loadingHost) {
        hostRenewing = true;
        void startHostPairing().finally(() => { hostRenewing = false; });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  });

  function formatCountdown(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  const pairingStage = $derived.by(() => {
    if (host?.status === "claimed") return "approval" as const;
    if (connect?.status === "connected" || replicationSnapshot?.activeSessionKey) return "connected" as const;
    if (host && ["pending", "approved"].includes(host.status)) return "waiting" as const;
    return "start" as const;
  });

  function portal(node: HTMLElement) {
    if (presentation === "embedded") return { destroy() {} };
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function showView(view: SyncdModalView) {
    modalView = view;
    if (modalBodyElement) modalBodyElement.scrollTop = 0;
  }

  function closeModal() {
    if (presentation === "embedded") return;
    panelMounted = false;
    hostDecisionBusy = null;
    stopPanelSubscriptions();
    onClose();
  }

  function handleModalKeydown(event: KeyboardEvent) {
    if (presentation === "embedded") return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab" || !modalElement) return;

    const focusable = Array.from(
      modalElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.closest("[hidden]"));
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function hasProfile(): boolean {
    return activeProfileId !== null;
  }

  function statusLabel(status: string): string {
    const messageId = `syncd_status_${status.replaceAll("-", "_")}`;
    const translated = translate(messageId);
    if (translated !== messageId) return translated;
    return status
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function formatWhen(value?: number | null): string {
    if (!value) return translate("common_never");
    return new Date(value).toLocaleString();
  }

  function sourceLabel(value: string): string {
    return value
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function effectiveSessionConnectionStatus(session: PersistedSyncSessionView): SyncdDesktopConnectionStatus {
    return lastReconnectStatuses[session.sessionKey]?.status ?? session.lastKnownStatus;
  }

  function sessionStatusSummary(session: PersistedSyncSessionView): string {
    const parts = [
      sourceLabel(session.lastDiscoverySource),
      statusLabel(effectiveSessionConnectionStatus(session)),
    ];
    if (session.replicationStatus) {
      parts.push(`${translate("ui_replication")} ${statusLabel(session.replicationStatus)}`);
    }
    return parts.join(" | ");
  }

  function connectStatusTone(
    status: SyncdDesktopConnectionStatus | SyncdHostPairingState["status"],
  ): "success" | "info" | "danger" | "neutral" {
    if (status === "approved" || status === "connected") return "success";
    if (status === "claimed" || status === "pending") return "info";
    if (
      status === "rejected"
      || status === "expired"
      || status === "unreachable"
      || status === "tls_mismatch"
      || status === "needs_reauth"
    ) {
      return "danger";
    }
    return "neutral";
  }

  function replicationStatusTone(status: SyncdReplicationSnapshot["replicationStatus"] | "idle"): string {
    if (status === "live") return "success";
    if (status === "connecting" || status === "replaying") return "info";
    if (status === "offline" || status === "degraded" || status === "needs_reauth") return "danger";
    return "neutral";
  }

  function hostStatusRank(status: SyncdHostPairingState["status"]): number {
    switch (status) {
      case "pending":
        return 1;
      case "claimed":
        return 2;
      case "approved":
      case "rejected":
      case "expired":
        return 3;
      default:
        return 0;
    }
  }

  function connectStatusRank(status: SyncdDesktopConnectionStatus): number {
    switch (status) {
      case "idle":
        return 0;
      case "pending":
        return 1;
      case "claimed":
        return 2;
      case "approved":
        return 3;
      case "connected":
      case "rejected":
      case "expired":
      case "unreachable":
      case "needs_reauth":
      case "tls_mismatch":
        return 4;
      default:
        return 0;
    }
  }

  function mergeHostState(current: SyncdHostPairingState | null, next: SyncdHostPairingState | null): SyncdHostPairingState | null {
    if (!next) return null;
    if (!current || current.sessionId !== next.sessionId) return next;
    if (hostStatusRank(next.status) >= hostStatusRank(current.status)) return next;
    return {
      ...next,
      status: current.status,
      claimedDeviceId: current.claimedDeviceId ?? next.claimedDeviceId,
      requestedScopes: next.requestedScopes.length > 0 ? next.requestedScopes : current.requestedScopes,
      error: current.error ?? next.error,
    };
  }

  function mergeConnectState(current: SyncdConnectState | null, next: SyncdConnectState | null): SyncdConnectState | null {
    if (!next) return null;
    if (!current || current.sessionId !== next.sessionId) return next;
    if (connectStatusRank(next.status) >= connectStatusRank(current.status)) return next;
    return {
      ...next,
      status: current.status,
      claimedDeviceId: current.claimedDeviceId ?? next.claimedDeviceId,
      sessionKey: current.sessionKey ?? next.sessionKey,
      error: current.error ?? next.error,
    };
  }

  function currentManualOriginValue(): string {
    return manualOriginInput?.value ?? manualOrigin;
  }

  function currentBootstrapBundleValue(): string {
    return bootstrapBundleTextarea?.value ?? bootstrapBundleInput;
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
      promise.then(
        (value) => {
          globalThis.clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          globalThis.clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  async function loadHostState() {
    try {
      const nextHost = await syncdGetActiveHostPairing();
      if (panelMounted) {
        host = mergeHostState(host, nextHost);
      }
    } catch (error) {
      if (panelMounted) {
        panelError = { cause: error, fallback: "ui_syncActionFailed" };
      }
    }
  }

  async function refreshHostAfterDecision() {
    try {
      const nextHost = await withTimeout(
        syncdGetActiveHostPairing(),
        HOST_REFRESH_TIMEOUT_MS,
        "SYNC_REFRESH_TIMEOUT",
      );
      if (!panelMounted || !nextHost) return;
      host = mergeHostState(host, nextHost);
      if (nextHost.status === "approved" || nextHost.status === "rejected") {
        panelError = null;
      }
    } catch (error) {
      if (panelMounted && !panelError) {
        panelError = { cause: error, fallback: "ui_syncActionFailed" };
      }
    }
  }

  async function loadPersistedSessions() {
    if (!activeProfileId) {
      persistedSessions = [];
      replicationSnapshot = null;
      return;
    }
    loadingPersisted = true;
    const requestedProfile = activeProfileId;
    const generation = ++replicationReadGeneration;
    try {
      const catalog = await syncdGetSessionCatalog(requestedProfile);
      if (!panelMounted || requestedProfile !== activeProfileId || catalog.localProfileId !== requestedProfile) return;
      persistedSessions = catalog.sessions ?? [];
      if (generation === replicationReadGeneration) replicationSnapshot = catalog.replication ?? null;
    } catch (error) {
      if (generation === replicationReadGeneration) replicationSnapshot = null;
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      loadingPersisted = false;
    }
  }

  async function loadPairedDevices() {
    loadingPairedDevices = true;
    try {
      pairedDevices = (await syncdListPairedDevices()) ?? [];
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      loadingPairedDevices = false;
    }
  }

  function allowedDeviceScopes(device: SyncdPairedDeviceView): string[] {
    return [
      `comics:profile:${device.profileId}`,
      `novels:profile:${device.profileId}`,
      "books:global",
    ];
  }

  function permissionScopeLabel(scope: string): string {
    if (scope === "books:global") return translate("common_books");
    if (scope.startsWith("novels:profile:")) return translate("ui_novels");
    if (scope.startsWith("comics:profile:")) return translate("common_comics");
    return scope;
  }

  async function togglePairedDeviceScope(device: SyncdPairedDeviceView, scope: string) {
    const key = `${device.deviceId}:${device.profileId}`;
    if (pairedDeviceScopeBusy) return;
    pairedDeviceScopeBusy = key;
    panelError = null;
    try {
      const grantedScopes = device.grantedScopes.includes(scope)
        ? device.grantedScopes.filter((candidate) => candidate !== scope)
        : [...device.grantedScopes, scope];
      const updated = await syncdUpdatePairedDeviceGrantedScopes(
        device.deviceId,
        device.profileId,
        grantedScopes,
      );
      pairedDevices = pairedDevices.map((candidate) =>
        candidate.deviceId === updated.deviceId && candidate.profileId === updated.profileId
          ? updated
          : candidate,
      );
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      pairedDeviceScopeBusy = null;
    }
  }

  async function refreshReplicationSnapshot() {
    if (!activeProfileId) {
      replicationSnapshot = null;
      return;
    }
    const requestedProfile = activeProfileId;
    const generation = ++replicationReadGeneration;
    try {
      const snapshot = await syncdGetReplicationState(requestedProfile);
      if (panelMounted && generation === replicationReadGeneration && requestedProfile === activeProfileId) {
        replicationSnapshot = snapshot.localProfileId === requestedProfile ? snapshot : null;
      }
    } catch {
      // An unavailable read cannot keep granting setup readiness from stale state.
      if (generation === replicationReadGeneration) replicationSnapshot = null;
    }
  }

  async function refreshPersistedSessions() {
    if (!activeProfileId) return;
    if (persistedSessionsRefreshInFlight) {
      persistedSessionsRefreshQueued = true;
      return;
    }

    persistedSessionsRefreshInFlight = true;
    try {
      do {
        persistedSessionsRefreshQueued = false;
        await loadPersistedSessions();
      } while (persistedSessionsRefreshQueued);
    } finally {
      persistedSessionsRefreshInFlight = false;
      persistedSessionsRefreshQueued = false;
    }
  }

  async function refreshDiscoveryCandidates() {
    loadingCandidates = true;
    panelError = null;
    try {
      candidates = (await syncdListDiscoveryCandidates()) ?? [];
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
      candidates = [];
    } finally {
      loadingCandidates = false;
    }
  }

  async function startHostPairing() {
    modalView = "pairing";
    if (!activeProfileId) {
      panelError = operationFailure(null, "syncd_error_hostProfileRequired");
      hostStartStage = "error";
      return;
    }
    loadingHost = true;
    hostStartStage = "requesting";
    panelError = null;
    try {
      const startedHost = await syncdStartHostPairing(activeProfileId);
      const nextHost = mergeHostState(host, startedHost) ?? startedHost;
      host = nextHost;
      hostStartStage = "bootstrap_ready";
      bootstrapBundleInput = nextHost.bootstrapBundle;
      qrCodeDataUrl = await buildSyncdQrDataUrl(nextHost.bootstrapBundle);
      hostStartStage = "complete";
      copiedBundle = false;
      addToast({
        kind: "success",
        title: translate("ui_syncHostIsReady"),
        body: translate("ui_theBootstrapBundleAndQrPayloadAreLive"),
      });
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
      hostStartStage = "error";
    } finally {
      loadingHost = false;
    }
  }

  async function connectToRemote() {
    modalView = "pairing";
    if (!activeProfileId) {
      panelError = operationFailure(null, "syncd_error_profileRequired");
      return;
    }
    const nextBootstrapBundle = currentBootstrapBundleValue().trim();
    const nextManualOrigin = currentManualOriginValue().trim();

    if (!nextBootstrapBundle) {
      panelError = operationFailure(null, "syncd_error_bundleRequired");
      return;
    }
    connectBusy = true;
    panelError = null;
    connect = null;
    try {
      connect = mergeConnectState(connect, await syncdConnectWithBootstrap({
        localProfileId: activeProfileId,
        bootstrapBundle: nextBootstrapBundle,
        manualOrigin: nextManualOrigin || null,
      }));
      addToast({
        kind: "info",
        title: translate("ui_syncPairingStarted"),
        body: translate("ui_waitingForTheHostDesktopToApproveOr"),
      });
      void refreshPersistedSessions();
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      connectBusy = false;
    }
  }

  async function decideHostPairing(decision: PairingHostDecision) {
    if (!host) return;
    hostDecisionBusy = decision;
    panelError = null;
    try {
      const nextHost = await withTimeout(
        syncdHostDecidePairing(host.sessionId, decision),
        HOST_DECISION_TIMEOUT_MS,
        "SYNC_DECISION_TIMEOUT",
      );
      if (!panelMounted) return;
      host = mergeHostState(host, nextHost);
      addToast({
        kind: decision === "approve" ? "success" : "info",
        title: decision === "approve" ? translate("ui_syncPairingApproved") : translate("ui_syncPairingRejected"),
        body: decision === "approve"
          ? translate("ui_theRemoteDesktopCanNowRetrieveItsProfile")
          : translate("ui_theRemoteDesktopWasToldToStopBefore"),
      });
    } catch (error) {
      if (panelMounted) {
        panelError = { cause: error, fallback: "ui_syncActionFailed" };
      }
    } finally {
      if (panelMounted) {
        hostDecisionBusy = null;
        void refreshHostAfterDecision();
        void loadPairedDevices();
      }
    }
  }

  async function copyBootstrapBundle() {
    if (!host?.bootstrapBundle) return;
    try {
      await navigator.clipboard.writeText(host.bootstrapBundle);
      copiedBundle = true;
      addToast({
        kind: "success",
        title: translate("ui_bootstrapBundleCopied"),
        body: translate("ui_pasteItIntoTheSecondDesktopToFinish"),
      });
      setTimeout(() => {
        copiedBundle = false;
      }, 2000);
    } catch (error) {
      panelError = { cause: error, fallback: "syncd_error_copyBundle" };
    }
  }

  function saveBootstrapQrCode() {
    if (!qrCodeDataUrl || !host) return;
    const link = document.createElement("a");
    link.href = qrCodeDataUrl;
    link.download = `epigraph-sync-bootstrap-${host.profileId}.png`;
    link.click();
  }

  async function refreshHostQrCode(nextHost: SyncdHostPairingState | null) {
    if (!nextHost?.bootstrapBundle) {
      qrCodeDataUrl = null;
      return;
    }

    qrBusy = true;
    try {
      qrCodeDataUrl = await buildSyncdQrDataUrl(nextHost.bootstrapBundle);
    } catch (error) {
      panelError = { cause: error, fallback: "syncd_error_renderQr" };
      qrCodeDataUrl = null;
    } finally {
      qrBusy = false;
    }
  }

  function openQrImagePicker() {
    qrFileInput?.click();
  }

  async function applyDecodedQrBundle(loadBundle: () => Promise<string>) {
    qrDecodeBusy = true;
    panelError = null;
    connect = null;
    try {
      bootstrapBundleInput = await loadBundle();
      addToast({
        kind: "success",
        title: translate("ui_syncQrLoaded"),
        body: translate("ui_theBootstrapBundleWasFilledFromTheQr"),
      });
    } catch (error) {
      panelError = { cause: error, fallback: "syncd_error_decodeQr" };
    } finally {
      qrDecodeBusy = false;
    }
  }

  async function importQrDataUrl(dataUrl: string) {
    await applyDecodedQrBundle(() => decodeSyncdQrDataUrl(dataUrl));
  }

  async function handleQrFilePicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    try {
      await applyDecodedQrBundle(() => decodeSyncdQrFile(file));
    } finally {
      if (input) {
        input.value = "";
      }
    }
  }

  async function revalidatePersisted() {
    if (!activeProfileId) return;
    revalidateBusy = true;
    panelError = null;
    try {
      const results = await syncdRevalidatePersistedSyncSessions(activeProfileId);
      lastReconnectStatuses = Object.fromEntries(results.map((entry) => [entry.sessionKey, entry]));
      void refreshPersistedSessions();
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      revalidateBusy = false;
    }
  }

  async function disconnectSession(sessionKey: string) {
    disconnectBusyKey = sessionKey;
    panelError = null;
    try {
      await syncdDisconnectPersistedSession(sessionKey);
      persistedSessions = persistedSessions.filter((session) => session.sessionKey !== sessionKey);
      addToast({
        kind: "success",
        title: translate("ui_syncSessionRemoved"),
        body: translate("ui_theLocalDesktopForgotTheApprovedSyncSession"),
      });
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      disconnectBusyKey = null;
    }
  }

  async function setActiveSession(sessionKey: string) {
    if (!activeProfileId) return;
    activeSessionBusyKey = sessionKey;
    panelError = null;
    try {
      replicationSnapshot = await syncdSetActiveReplicationSession(activeProfileId, sessionKey);
      void refreshPersistedSessions();
      addToast({
        kind: "success",
        title: translate("ui_activeSyncSessionUpdated"),
        body: translate("ui_replicationWillNowFollowTheSelectedDesktopSession"),
      });
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      activeSessionBusyKey = null;
    }
  }

  async function pauseReplication() {
    if (!activeProfileId) return;
    replicationActionBusy = "pause";
    panelError = null;
    try {
      replicationSnapshot = await syncdPauseReplication(activeProfileId);
      void refreshPersistedSessions();
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      replicationActionBusy = null;
    }
  }

  async function resumeReplication() {
    if (!activeProfileId) return;
    replicationActionBusy = "resume";
    panelError = null;
    try {
      replicationSnapshot = await syncdResumeReplication(activeProfileId);
      void refreshPersistedSessions();
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      replicationActionBusy = null;
    }
  }

  async function reconnectReplication() {
    if (!activeProfileId) return;
    replicationActionBusy = "reconnect";
    panelError = null;
    try {
      replicationSnapshot = await syncdForceReplicationReconnect(activeProfileId);
      void refreshPersistedSessions();
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      replicationActionBusy = null;
    }
  }

  async function revalidateSessionEntry(sessionKey: string) {
    if (!activeProfileId) return;
    singleRevalidateBusyKey = sessionKey;
    panelError = null;
    try {
      const result = await syncdRevalidateSession(activeProfileId, sessionKey);
      lastReconnectStatuses = {
        ...lastReconnectStatuses,
        [result.sessionKey]: result,
      };
      void refreshPersistedSessions();
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      singleRevalidateBusyKey = null;
    }
  }

  async function forgetSession(sessionKey: string) {
    if (!activeProfileId) return;
    forgetBusyKey = sessionKey;
    panelError = null;
    try {
      await syncdForgetPersistedSession(activeProfileId, sessionKey);
      void refreshPersistedSessions();
      addToast({
        kind: "success",
        title: translate("ui_syncSessionForgotten"),
        body: translate("ui_theLocalCatalogNoLongerKeepsThatInactive"),
      });
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      forgetBusyKey = null;
    }
  }

  function applyDesktopSnapshot(snapshot: SyncdDesktopSnapshot) {
    observeRuntimeIdentity(snapshot.runtimeIdentity ?? null);
    host = mergeHostState(host, snapshot.host ?? null);
    connect = mergeConnectState(connect, snapshot.connect ?? null);
    void refreshHostQrCode(host);
  }

  function runtimeIdentityKey(identity: SyncdRuntimeIdentity): string {
    return `${identity.pid}:${identity.serverId ?? ""}`;
  }

  function observeRuntimeIdentity(nextIdentity: SyncdRuntimeIdentity | null) {
    if (!nextIdentity) return;
    const previousIdentity = runtimeIdentity;
    runtimeIdentity = nextIdentity;
    if (
      panelMounted
      && previousIdentity
      && runtimeIdentityKey(previousIdentity) !== runtimeIdentityKey(nextIdentity)
    ) {
      replicationReadGeneration += 1;
      replicationSnapshot = null;
      void reconnectPanelSubscriptions().then(() => loadHostState());
    }
  }

  async function refreshRuntimeIdentity() {
    try {
      observeRuntimeIdentity(await syncdGetRuntimeIdentity());
    } catch {
      // Active pairing and replication calls own user-visible runtime errors.
    }
  }

  function stopPanelSubscriptions() {
    subscriptionGeneration += 1;
    panelSubscriptionsReady = false;
    const listeners = panelUnlisteners;
    panelUnlisteners = [];
    listeners.forEach((unlisten) => unlisten());
  }

  async function reconnectPanelSubscriptions() {
    if (!panelMounted) return;
    const generation = subscriptionGeneration + 1;
    stopPanelSubscriptions();
    subscriptionGeneration = generation;

    try {
      const listeners = await Promise.all([
        listenSyncdDesktopState((payload) => {
          if (panelMounted) applyDesktopSnapshot(payload);
        }),
        listenSyncdPairingStatus((payload) => {
          if (!panelMounted) return;
          if ("hostReady" in payload) {
            host = mergeHostState(host, payload);
          } else {
            connect = mergeConnectState(connect, payload);
          }
        }),
        listenSyncdReconnectStatus((payload) => {
          if (!panelMounted) return;
          lastReconnectStatuses = {
            ...lastReconnectStatuses,
            [payload.sessionKey]: payload,
          };
          void refreshPersistedSessions();
        }),
        listenSyncdReplicationState((payload) => {
          if (panelMounted && generation === subscriptionGeneration && activeProfileId && payload.localProfileId === activeProfileId) {
            replicationReadGeneration += 1;
            replicationSnapshot = payload;
            void refreshPersistedSessions();
          }
        }),
      ]);

      if (!panelMounted || generation !== subscriptionGeneration) {
        listeners.forEach((unlisten) => unlisten());
        return;
      }
      panelUnlisteners = listeners;
      panelSubscriptionsReady = true;
    } catch (error) {
      if (panelMounted && generation === subscriptionGeneration) {
        panelError = { cause: error, fallback: "ui_syncActionFailed" };
      }
    }
  }

  $effect(() => {
    if (!activeProfileId) {
      persistedSessions = [];
      lastReconnectStatuses = {};
      return;
    }
    void refreshPersistedSessions();
  });

  onMount(() => {
    panelMounted = true;
    queueMicrotask(() => {
      modalElement?.focus();
    });

    void loadHostState();
    void loadPairedDevices();
    void refreshRuntimeIdentity();
    void refreshDiscoveryCandidates();
    if (activeProfileId) {
      void refreshPersistedSessions();
      void refreshReplicationSnapshot();
    }

    const replicationPoll = window.setInterval(() => {
      if (activeProfileId) {
        void refreshReplicationSnapshot();
      }
      void refreshRuntimeIdentity();
    }, 2000);

    const handleAutomationQrImport = (event: Event) => {
      const dataUrl = (event as CustomEvent<string>).detail;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        void importQrDataUrl(dataUrl);
      }
    };
    window.addEventListener("epigraph:syncd-import-qr-data-url", handleAutomationQrImport as EventListener);

    void reconnectPanelSubscriptions();

    return () => {
      panelMounted = false;
      replicationReadGeneration += 1;
      initialSyncRunId += 1;
      window.removeEventListener("epigraph:syncd-import-qr-data-url", handleAutomationQrImport as EventListener);
      window.clearInterval(replicationPoll);
      stopPanelSubscriptions();
    };
  });

  $effect(() => {
    void refreshHostQrCode(host);
  });

  $effect(() => {
    if (connect?.status === "connected") {
      void refreshPersistedSessions();
      void refreshReplicationSnapshot();
    }
  });

  $effect(() => {
    const key = initialSyncKey;
    const profile = activeProfileId;
    const requiresMangaRefresh = Boolean(
      replicationSnapshot?.comicsScopeCheckpoint
      || replicationSnapshot?.lastAppliedScopes.some(scope => scope.startsWith("comics:")),
    );
    initialSyncRetry;
    if (presentation !== "embedded" || !key || !profile || !panelMounted) {
      initialSyncRunId += 1;
      initialSyncAttemptKey = null;
      initialSyncReady = false;
      initialSyncError = null;
      initialSyncPhase = "idle";
      return;
    }
    const attemptKey = `${key}:${initialSyncRetry}`;
    if (initialSyncAttemptKey === attemptKey) return;
    initialSyncAttemptKey = attemptKey;
    const runId = ++initialSyncRunId;
    initialSyncReady = false;
    initialSyncError = null;
    initialSyncPhase = "loading";
    const stillCurrent = () => runId === initialSyncRunId && panelMounted && key === initialSyncKey && profile === activeProfileId;
    void refreshFirstRunSyncLibrary(profile, stillCurrent, { requiresMangaRefresh }).then(() => {
      if (stillCurrent()) {
        initialSyncReady = true;
        initialSyncPhase = "ready";
      }
    }).catch(error => {
      if (stillCurrent()) {
        initialSyncError = operationFailure(error, "ui_syncActionFailed");
        initialSyncPhase = "error";
      }
    });
  });

  $effect(() => {
    onReadyChange(initialSyncReady && initialSyncKey !== null);
  });
</script>

<div class:syncd-modal-backdrop--embedded={presentation === "embedded"} class="syncd-modal-backdrop" role="presentation" use:portal>
  <div bind:this={modalElement} class:syncd-modal--embedded={presentation === "embedded"} class="syncd-modal" role="dialog" aria-modal={presentation === "modal" ? "true" : undefined} aria-labelledby="syncd-modal-title" tabindex="-1" onkeydown={handleModalKeydown}>
    <div class="syncd-panel-grid" data-testid="syncd-panel-grid" data-panel-ready={panelSubscriptionsReady ? "ready" : "loading"}>
      <header class="syncd-modal__header">
        <div class="syncd-modal__heading">
          <h2 id="syncd-modal-title">{$_("settings_inline_desktopSyncPairing")}</h2>
          <p>{scopeLabel}</p>
        </div>
        {#if presentation === "modal"}<button class="n-icon-btn syncd-modal__close" type="button" aria-label={$_("common_close")} onclick={closeModal}><X size={16} weight="bold" /></button>{/if}
      </header>

      <div bind:this={modalBodyElement} class="syncd-modal__body">
        <section class="syncd-view" hidden={modalView !== "pairing"} aria-hidden={modalView !== "pairing"} data-testid="syncd-pairing-view">
          <div class="syncd-status-line">
            <span class="syncd-status-copy"><span class:syncd-status-dot--live={pairingStage !== "start"} class="syncd-status-dot"></span>{pairingStage === "start" ? $_("syncd_modal_noActiveDesktop") : overviewStatus.title}</span>
            <button class="syncd-link" type="button" data-testid="syncd-modal-details" onclick={() => showView("details")}>{$_("syncd_modal_connectionDetails")}</button>
          </div>

          {#if pairingStage === "start"}
            <div class="syncd-mode-switch" aria-label={$_("syncd_modal_pairingOptions")}>
              <button class:is-active={pairingMode === "create"} type="button" aria-pressed={pairingMode === "create"} onclick={() => (pairingMode = "create")}>{$_("syncd_action_createPairingQr")}</button>
              <button class:is-active={pairingMode === "use"} type="button" aria-pressed={pairingMode === "use"} onclick={() => (pairingMode = "use")}>{$_("ui_loadQrImage")}</button>
            </div>

            {#if pairingMode === "create"}
              <div class="syncd-start-copy" data-testid="syncd-host-card">
                <h3>{$_("syncd_modal_pairDesktop")}</h3>
                <p>{$_("syncd_modal_createShortLivedQr")}</p>
                <div class="syncd-note">{$_("syncd_modal_approveOnlyIfStarted")}</div>
                <span class="syncd-hidden-value" data-testid="syncd-host-status">{statusLabel("idle")}</span>
                <span class="syncd-hidden-value" data-testid="syncd-host-start-stage">{hostStartStage}</span>
              </div>
            {:else}
              <div class="syncd-start-copy" data-testid="syncd-options-view">
                <h3>{$_("syncd_modal_connect")}</h3>
                <p>{$_("syncd_modal_useHostPairingPackage")}</p>
                <label class="syncd-field"><span>{$_("ui_bootstrapBundle")}</span><textarea bind:this={bootstrapBundleTextarea} class="syncd-textarea" data-testid="syncd-bootstrap-bundle-input" bind:value={bootstrapBundleInput} placeholder={$_("ui_pasteTheHostBundleJsonHere")}></textarea></label>
                <input bind:this={qrFileInput} class="syncd-hidden-input" data-testid="syncd-qr-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleQrFilePicked} />
                <div class="syncd-field-actions"><span>{$_("syncd_modal_pairing")}</span><button class="syncd-link" type="button" data-testid="syncd-connect-load-qr" onclick={openQrImagePicker} disabled={qrDecodeBusy}>{qrDecodeBusy ? $_("ui_readingQr") : $_("ui_loadQrImage")}</button></div>
                <div class:syncd-disclosure--open={advancedConnectOpen} class="syncd-disclosure">
                  <button type="button" data-testid="syncd-modal-options" aria-expanded={advancedConnectOpen} onclick={() => (advancedConnectOpen = !advancedConnectOpen)}>{$_("syncd_modal_pairingOptions")}</button>
                  {#if advancedConnectOpen}
                    <div class="syncd-disclosure__body">
                      <div class="syncd-row"><span>{$_("ui_discoveredPeers")}</span><button class="syncd-link" type="button" data-testid="syncd-connect-refresh-peers" onclick={refreshDiscoveryCandidates} disabled={loadingCandidates}>{loadingCandidates ? $_("common_refreshing") : $_("ui_refreshPeers")}</button></div>
                      {#if candidates.length > 0}<div class="syncd-list" data-testid="syncd-discovered-peers">{#each candidates as candidate}<div class="syncd-list__item" data-testid="syncd-peer-item"><div><strong>{candidate.instanceName}</strong><small>{candidate.effectiveOrigin}</small></div><button class="syncd-link" type="button" data-testid="syncd-peer-use-origin" onclick={() => (manualOrigin = candidate.discoveryOrigin)}>{$_("ui_useOrigin")}</button></div>{/each}</div>{/if}
                      <label class="syncd-field"><span>{$_("ui_manualOriginFallback")}</span><input bind:this={manualOriginInput} class="syncd-input" data-testid="syncd-manual-origin" bind:value={manualOrigin} placeholder={$_("ui_https1921681254777")} spellcheck="false" /></label>
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          {:else if pairingStage === "waiting" && host}
            <div class="syncd-pairing-live">
              <div class="syncd-qr-surface" data-testid="syncd-host-qr-surface">{#if qrCodeDataUrl}<img class="syncd-qr-image" data-testid="syncd-host-qr-image" data-session-id={host.sessionId} data-origin={host.advertisedBaseUrl} src={qrCodeDataUrl} alt={$_("ui_syncBootstrapQrCode")} />{:else}<CircleNotch size={24} weight="bold" class="syncd-status__spinner" />{/if}</div>
              <div class="syncd-pairing-live__copy">{#if hostPinDisplay}<span>{$_("syncd_modal_pinLabel")}</span><strong class="syncd-pairing-pin" data-testid="syncd-host-pin">{hostPinDisplay}</strong><small class="syncd-pin-hint">{$_("syncd_modal_pinHint", { name: localDeviceName })}</small><div class="syncd-pin-expiry" aria-live="off"><span class="syncd-pin-expiry__bar"><i style:transform={`scaleX(${Math.min(1, hostSecondsLeft / 300)})`}></i></span><small>{$_("syncd_modal_pinRenews", { time: formatCountdown(hostSecondsLeft) })}</small></div>{/if}<span>{$_("ui_pairingCode")}</span><strong class="syncd-pairing-code">{host.pairingCode}</strong><small>{$_("ui_expires")} {formatWhen(host.expiresAtMs)}</small><div class="syncd-actions"><button class="n-btn n-btn--sm" type="button" data-testid="syncd-host-copy-bundle" onclick={copyBootstrapBundle}>{copiedBundle ? $_("massMigration_statusCopied") : $_("ui_copyBundle")}</button><button class="syncd-link" type="button" data-testid="syncd-host-save-qr" onclick={saveBootstrapQrCode} disabled={!qrCodeDataUrl}>{$_("ui_saveQrImage")}</button></div></div>
              <span class="syncd-hidden-value" data-testid="syncd-host-status-live" data-status={host.status}>{statusLabel(host.status)}</span>
            </div>
            <div class="syncd-note">{$_("syncd_modal_keepWindowsOpen")}</div>
          {:else if pairingStage === "approval" && host}
            <div class="syncd-start-copy"><h3>{$_("syncd_modal_desktopWantsConnect")}</h3><p>{$_("syncd_modal_reviewApprove")}</p></div>
            <div class="syncd-request"><div><strong>{remoteDeviceName}</strong><small>{remotePlatformLabel}</small></div><span>{statusLabel("claimed")}</span></div>
            <div class="syncd-verification" data-testid="syncd-host-verification"><span>{$_("syncd_modal_verificationLabel")}</span><strong>{hostVerificationCode}</strong><small>{$_("syncd_modal_verificationHint")}</small></div>
            <div class="syncd-scope-list" data-testid="syncd-requested-scopes">{#each host.requestedScopes as scope}<span>{permissionScopeLabel(scope)}</span>{/each}</div>
            <span class="syncd-hidden-value" data-testid="syncd-host-status-live" data-status={host.status}>{statusLabel(host.status)}</span>
          {:else}
            <div class="syncd-device-pair">
              <div><small>{$_("syncd_modal_currentDevice")}</small><strong>{localDeviceName}</strong><span>{scopeLabel}</span></div>
              <em>{statusLabel("connected")}</em>
              <div><small>{$_("ui_claimedDevice")}</small><strong>{remoteDeviceName}</strong><span>{remotePlatformLabel}</span></div>
            </div>
            <div class="syncd-session-summary"><div><strong>{$_("ui_replication")}</strong><span>{overviewStatus.body}</span></div><span>{statusLabel(replicationSnapshot?.replicationStatus ?? "connected")}</span></div>
            <span class="syncd-hidden-value" data-testid="syncd-replication-active-session">{replicationSnapshot?.activeSessionKey ?? $_("ui_noneSelected")}</span>
            <span class="syncd-hidden-value" data-testid="syncd-replication-status" data-status={replicationSnapshot?.replicationStatus ?? "idle"}>{statusLabel(replicationSnapshot?.replicationStatus ?? "idle")}</span>
          {/if}

          {#if connect}<div class="syncd-hidden-value" data-testid="syncd-connect-state"><span data-testid="syncd-connect-status" data-status={connect.status}>{statusLabel(connect.status)}</span>{#if connect.error}<span data-testid="syncd-connect-error">{connect.error}</span>{/if}</div>{/if}
          {#if host?.error}<div data-testid="syncd-host-error"><NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("syncd_modal_host")} title={$_("ui_hostPairingFailed")} body={host.error} /></div>{/if}
          {#if presentation === "embedded" && initialSyncError}
            <div role="alert" data-testid="syncd-initial-sync-error">
              <p>{presentOperationFailure(initialSyncError, $_)}</p>
              <button type="button" class="n-btn n-btn--sm" onclick={() => initialSyncRetry += 1}>{$_("setup_retry")}</button>
            </div>
          {/if}
          {#if presentation === "embedded" && pairingStage === "connected" && !initialSyncReady && !initialSyncError}
            <p role="status" data-testid="syncd-initial-sync-status" data-phase={initialSyncPhase}>{initialSyncKey ? $_("ui_loading") : statusLabel(replicationSnapshot?.replicationStatus ?? "connecting")}</p>
          {/if}
          {#if panelError}<div data-testid="syncd-panel-error"><NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("syncd_modal_sync")} title={$_("ui_syncActionFailed")} body={panelErrorText} /></div>{/if}
        </section>

        <section class="syncd-view syncd-manage" hidden={modalView !== "details"} aria-hidden={modalView !== "details"} data-testid="syncd-details-view">
          <div class="syncd-status-line"><button class="syncd-link" type="button" data-testid="syncd-modal-pairing" onclick={() => showView("pairing")}>{$_("syncd_modal_pairing")}</button><span class="syncd-status-copy"><span class:syncd-status-dot--live={Boolean(replicationSnapshot?.activeSessionKey)} class="syncd-status-dot"></span>{replicationSnapshot?.activeSessionKey ? $_("ui_activeSession") : $_("syncd_modal_connectionDetails")}</span></div>
          <div class="syncd-start-copy"><h3>{remoteDeviceName}</h3><p>{$_("syncd_modal_connectionDetailsHint")}</p></div>
          <div class="syncd-meta-grid">
            <div><small>{$_("syncd_modal_currentDevice")}</small><strong>{localDeviceName}</strong></div>
            <div><small>{$_("ui_claimedDevice")}</small><strong>{remoteDeviceName}</strong></div>
            <div><small>{$_("ui_advertisedOrigin")}</small><strong class="is-mono">{activeSession?.canonicalOrigin ?? connect?.remoteOrigin ?? host?.advertisedBaseUrl ?? $_("syncd_status_waiting")}</strong></div>
            <div><small>{$_("ui_lastConnected")}</small><strong>{formatWhen(replicationSnapshot?.lastConnectedAtMs ?? activeSession?.lastValidatedAtMs)}</strong></div>
            <div><small>{$_("ui_replication")}</small><strong>{statusLabel(replicationSnapshot?.replicationStatus ?? "idle")}</strong></div>
            <div><small>{$_("syncd_action_revalidate")}</small><strong>{statusLabel(activeSession?.lastKnownStatus ?? "ready")}</strong></div>
          </div>
          <div class="syncd-permissions" data-testid="syncd-paired-device-permissions"><h3>{$_("ui_scope")}</h3>{#each pairedDevices as device}{#if device.deviceName === remoteDeviceName || device.deviceId === host?.claimedDeviceId || device.deviceId === connect?.claimedDeviceId}<div class="syncd-permission-device" data-testid="syncd-paired-device-permission">{#each allowedDeviceScopes(device) as scope}<label><span><strong>{permissionScopeLabel(scope)}</strong><small>{device.deviceName}</small></span><input type="checkbox" checked={device.grantedScopes.includes(scope)} disabled={pairedDeviceScopeBusy !== null} onchange={() => togglePairedDeviceScope(device, scope)} /></label>{/each}</div>{/if}{/each}</div>
          {#if persistedSessions.length > 0}<div class="syncd-hidden-value" data-testid="syncd-persisted-sessions">{#each persistedSessions as session}<span data-testid="syncd-persisted-session-item">{session.sessionKey}</span>{/each}</div>{/if}
        </section>
      </div>

      <footer class="syncd-modal__footer">
        {#if modalView === "details"}
          <div><button class="n-btn n-btn--sm n-btn-danger" type="button" disabled={!activeSession || forgetBusyKey !== null} onclick={() => activeSession && forgetSession(activeSession.sessionKey)}>{forgetBusyKey ? $_("syncd_action_forgetting") : $_("syncd_action_forget")}</button></div>
          <div class="syncd-actions"><button class="n-btn n-btn--sm" type="button" disabled={!activeSession || disconnectBusyKey !== null} onclick={() => activeSession && disconnectSession(activeSession.sessionKey)}>{$_("syncd_action_disconnect")}</button><button class="n-btn n-btn--sm" type="button" data-testid="syncd-revalidate-sessions" onclick={revalidatePersisted} disabled={!hasProfile() || revalidateBusy}>{revalidateBusy ? $_("syncd_action_revalidating") : $_("syncd_action_revalidate")}</button><button class="syncd-link" type="button" onclick={() => showView("pairing")}>{$_("sources_actions_done")}</button></div>
        {:else if pairingStage === "start"}
          <span></span><div class="syncd-actions">{#if presentation === "modal"}<button class="n-btn n-btn--sm" type="button" onclick={closeModal}>{$_("ui_cancel")}</button>{/if}{#if pairingMode === "create"}<button class="n-btn n-btn--sm n-btn-primary" type="button" data-testid="syncd-host-start" onclick={startHostPairing} disabled={!hasProfile() || loadingHost}>{loadingHost ? $_("syncd_action_preparing") : $_("syncd_action_createPairingQr")}</button>{:else}<button class="n-btn n-btn--sm n-btn-primary" type="button" data-testid="syncd-connect-submit" onclick={connectToRemote} disabled={!hasProfile() || connectBusy || !bootstrapBundleInput.trim()}>{connectBusy ? $_("settings_inline_connecting") : $_("ui_connectToHost")}</button>{/if}</div>
        {:else if pairingStage === "approval"}
          <span></span><div class="syncd-actions"><button class="n-btn n-btn--sm n-btn-danger" type="button" data-testid="syncd-host-reject" onclick={() => decideHostPairing("reject")} disabled={hostDecisionBusy !== null}>{hostDecisionBusy === "reject" ? $_("syncd_action_rejecting") : $_("syncd_action_reject")}</button><button class="n-btn n-btn--sm n-btn-primary" type="button" data-testid="syncd-host-approve" onclick={() => decideHostPairing("approve")} disabled={hostDecisionBusy !== null}>{hostDecisionBusy === "approve" ? $_("syncd_action_approving") : $_("syncd_action_approve")}</button></div>
        {:else if pairingStage === "connected"}
          <span></span><div class="syncd-actions"><button class="n-btn n-btn--sm" type="button" data-testid="syncd-replication-toggle" onclick={replicationSnapshot?.paused ? resumeReplication : pauseReplication} disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}>{replicationSnapshot?.paused ? $_("ui_resumeReplication") : $_("ui_pauseReplication")}</button><button class="n-btn n-btn--sm" type="button" data-testid="syncd-replication-reconnect" onclick={reconnectReplication} disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}>{replicationActionBusy === "reconnect" ? $_("syncd_action_reconnecting") : $_("ui_reconnectNow")}</button>{#if presentation === "modal"}<button class="syncd-link" type="button" onclick={closeModal}>{$_("common_close")}</button>{/if}</div>
        {:else}
          <button class="n-btn n-btn--sm" type="button" onclick={startHostPairing}>{$_("ui_refreshBundle")}</button>{#if presentation === "modal"}<button class="syncd-link" type="button" onclick={closeModal}>{$_("common_close")}</button>{/if}
        {/if}
      </footer>
    </div>
  </div>
</div>

<style>
  .syncd-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--component-syncd-modal-z-index);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--component-syncd-modal-backdrop-padding);
    background: var(--component-syncd-modal-backdrop-bg);
    backdrop-filter: var(--component-syncd-modal-backdrop-blur);
  }

  .syncd-modal-backdrop--embedded {
    position: relative;
    inset: auto;
    z-index: auto;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    align-items: stretch;
    background: transparent;
    backdrop-filter: none;
  }

  .syncd-modal {
    width: var(--component-syncd-modal-width);
    max-width: var(--component-syncd-modal-width);
    height: var(--component-syncd-modal-height);
    max-height: var(--component-syncd-modal-height);
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--component-syncd-modal-border);
    border-radius: var(--component-syncd-modal-radius);
    background: var(--component-syncd-modal-bg);
    color: var(--text-primary);
    box-shadow: var(--component-syncd-modal-shadow);
    animation: syncdModalIn var(--component-syncd-modal-animation) both;
  }

  .syncd-modal--embedded {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: inherit;
    box-shadow: none;
    animation: none;
  }

  .syncd-panel-grid {
    width: 100%;
    height: 100%;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 0;
  }

  .syncd-modal__header,
  .syncd-modal__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-syncd-control-gap);
    padding: var(--component-syncd-modal-chrome-padding);
    background: var(--component-syncd-modal-chrome-bg);
  }

  .syncd-modal__header {
    border-bottom: 1px solid var(--component-syncd-modal-divider);
  }

  .syncd-modal__footer {
    border-top: 1px solid var(--component-syncd-modal-divider);
  }

  .syncd-modal__heading,
  .syncd-modal__views,
  .syncd-view__intro,
  .syncd-status,
  .syncd-status__line,
  .syncd-pairing-live,
  .syncd-approval {
    display: flex;
    align-items: center;
    gap: var(--component-syncd-control-gap);
  }

  .syncd-modal__heading-icon,
  .syncd-status__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--component-syncd-status-icon-fg);
    background: var(--component-syncd-status-icon-bg);
    border: 1px solid var(--component-syncd-status-icon-border);
    border-radius: var(--component-syncd-status-icon-radius);
  }

  .syncd-modal__heading-icon {
    width: var(--component-syncd-heading-icon-size);
    height: var(--component-syncd-heading-icon-size);
  }

  .syncd-modal__heading h2,
  .syncd-status h3,
  .syncd-view__intro h3 {
    margin: 0;
    color: var(--text-primary);
    font-family: var(--component-settings-font);
    font-synthesis: none;
    font-weight: var(--weight-semibold);
    letter-spacing: 0;
    text-rendering: optimizeLegibility;
  }

  .syncd-modal__heading h2 {
    font-size: var(--text-lg);
    line-height: var(--leading-tight);
  }

  .syncd-modal__close {
    flex: 0 0 auto;
  }

  .syncd-modal__body {
    min-height: 0;
    overflow: auto;
    padding: var(--component-syncd-modal-body-padding);
  }

  .syncd-view {
    display: flex;
    flex-direction: column;
    gap: var(--component-syncd-grid-gap);
  }

  .syncd-view[hidden] {
    display: none;
  }

  .syncd-view__intro {
    align-items: flex-start;
    color: var(--component-syncd-status-icon-fg);
  }

  .syncd-view__intro h3 {
    font-size: var(--text-base);
  }

  .syncd-view__intro p,
  .syncd-status__copy > p {
    margin: var(--space-xs) 0 0;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
  }

  .syncd-status {
    align-items: flex-start;
    padding: var(--component-syncd-status-padding);
    border: 1px solid var(--component-syncd-status-border);
    border-radius: var(--component-syncd-status-radius);
    background: var(--component-syncd-status-bg);
  }

  .syncd-status__icon {
    width: var(--component-syncd-status-icon-size);
    height: var(--component-syncd-status-icon-size);
  }

  .syncd-status__copy {
    min-width: 0;
    flex: 1;
  }

  .syncd-status__line {
    justify-content: space-between;
  }

  .syncd-status h3 {
    margin-top: var(--space-xs);
    font-size: var(--text-xl);
  }

  .syncd-progress {
    height: var(--component-syncd-progress-height);
    margin-top: var(--component-syncd-stack-gap);
    overflow: hidden;
    border-radius: var(--component-syncd-pill-radius);
    background: var(--component-syncd-progress-track-bg);
  }

  .syncd-progress span {
    display: block;
    width: var(--component-syncd-progress-idle-width);
    height: 100%;
    border-radius: inherit;
    background: var(--component-syncd-progress-fill-bg);
    transition: width var(--component-syncd-progress-transition);
  }

  .syncd-progress .syncd-progress__fill--complete {
    width: 100%;
  }

  .syncd-progress .syncd-progress__fill--busy {
    width: var(--component-syncd-progress-busy-width);
    animation: syncdProgress var(--component-syncd-progress-animation) infinite;
  }

  :global(.syncd-status__spinner) {
    animation: syncdSpin var(--component-syncd-spinner-animation) infinite;
  }

  .syncd-card {
    border: 1px solid var(--component-syncd-card-border);
    border-radius: var(--component-syncd-card-radius);
    background: var(--component-syncd-card-bg);
    padding: var(--component-syncd-card-padding);
    display: flex;
    flex-direction: column;
    gap: var(--component-syncd-card-gap);
    min-width: 0;
  }

  .syncd-card__head,
  .syncd-row,
  .syncd-list__item,
  .syncd-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-syncd-control-gap);
  }

  .syncd-card__title,
  .syncd-row__label,
  .syncd-list__title,
  .syncd-meta__label {
    margin: 0;
    font-size: var(--component-syncd-pill-font-size);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--component-syncd-label-fg);
  }

  .syncd-card__intro,
  .syncd-row__hint,
  .syncd-list__hint,
  .syncd-list__meta,
  .syncd-meta__value {
    margin: 0;
    font-size: var(--component-syncd-input-font-size);
    line-height: var(--leading-normal);
    color: var(--component-syncd-muted-fg);
  }

  .syncd-stack,
  .syncd-field {
    display: flex;
    flex-direction: column;
    gap: var(--component-syncd-stack-gap);
  }

  .syncd-actions {
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .syncd-scope-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--component-syncd-pill-gap);
    margin-top: var(--component-syncd-stack-gap);
  }

  .syncd-device-permission {
    align-items: center;
  }

  .syncd-scope-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--component-syncd-pill-gap);
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-input-font-size);
    cursor: pointer;
  }

  .syncd-scope-toggle input {
    accent-color: var(--component-syncd-input-border-focus);
  }

  .syncd-scope-toggle:has(input:disabled) {
    opacity: var(--component-syncd-control-disabled-opacity);
    cursor: default;
  }

  .syncd-actions--stack {
    align-items: stretch;
    justify-content: flex-start;
  }

  .syncd-surface {
    border: 1px solid var(--component-syncd-surface-border);
    border-radius: var(--component-syncd-surface-radius);
    background: var(--component-syncd-surface-bg);
    padding: var(--component-syncd-surface-padding);
    display: flex;
    flex-direction: column;
    gap: var(--component-syncd-surface-gap);
    min-width: 0;
  }

  .syncd-meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--component-syncd-meta-gap);
  }

  .syncd-meta__label,
  .syncd-meta__value {
    display: block;
  }

  .syncd-meta__value--mono,
  .syncd-textarea,
  .syncd-input {
    font-family: var(--font-mono, "Cascadia Mono", monospace);
  }

  .syncd-input,
  .syncd-textarea {
    width: 100%;
    min-width: 0;
    border-radius: var(--component-syncd-input-radius);
    border: 1px solid var(--component-syncd-input-border);
    background: var(--component-syncd-input-bg);
    color: var(--component-syncd-input-fg);
    padding: var(--component-syncd-input-padding);
    font-size: var(--component-syncd-input-font-size);
    font-weight: 600;
  }

  .syncd-textarea {
    min-height: var(--component-syncd-textarea-min-height);
    resize: vertical;
  }

  .syncd-input:focus,
  .syncd-textarea:focus {
    outline: none;
    border-color: var(--component-syncd-input-border-focus);
    background: var(--component-syncd-input-bg-focus);
  }

  .syncd-list {
    display: flex;
    flex-direction: column;
    gap: var(--component-syncd-stack-gap);
  }

  .syncd-qr-surface {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--component-syncd-qr-min-height);
    border: 1px dashed var(--component-syncd-qr-border);
    border-radius: var(--component-syncd-qr-radius);
    background: var(--component-syncd-qr-bg);
    padding: var(--component-syncd-qr-padding);
  }

  .syncd-qr-image {
    width: min(100%, 220px);
    height: auto;
    display: block;
  }

  .syncd-list__item {
    align-items: flex-start;
    border: 1px solid var(--component-syncd-list-item-border);
    border-radius: var(--component-syncd-list-item-radius);
    background: var(--component-syncd-list-item-bg);
    padding: var(--component-syncd-list-item-padding);
  }

  .syncd-list__body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--component-syncd-pill-gap);
  }

  .syncd-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--component-syncd-pill-gap);
    border-radius: var(--component-syncd-pill-radius);
    padding: var(--component-syncd-pill-padding);
    border: 1px solid var(--component-syncd-pill-border);
    background: var(--component-syncd-pill-bg);
    color: var(--component-syncd-pill-fg);
    font-size: var(--component-syncd-pill-font-size);
    text-transform: none;
    white-space: nowrap;
  }

  .syncd-pill--success {
    border-color: var(--component-syncd-pill-success-border);
    color: var(--component-syncd-pill-success-fg);
  }

  .syncd-pill--info {
    border-color: var(--component-syncd-pill-info-border);
    color: var(--component-syncd-pill-info-fg);
  }

  .syncd-pill--danger {
    border-color: var(--component-syncd-pill-danger-border);
    color: var(--component-syncd-pill-danger-fg);
  }

  .syncd-hidden-input {
    display: none;
  }

  .syncd-hidden-value {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .syncd-pairing-live {
    align-items: stretch;
  }

  .syncd-pairing-pin {
    color: var(--text-primary);
    font-size: 34px;
    font-weight: 800;
    letter-spacing: .08em;
    font-variant-numeric: tabular-nums;
  }

  .syncd-pin-hint {
    margin-bottom: 6px;
  }

  .syncd-pin-expiry {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }

  .syncd-pin-expiry__bar {
    flex: 0 0 120px;
    height: 3px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--border-base);
  }

  .syncd-pin-expiry__bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 1s linear;
  }

  .syncd-verification {
    display: grid;
    gap: 4px;
    margin: 12px 0;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--accent-muted);
  }

  .syncd-verification span,
  .syncd-verification small {
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .syncd-verification strong {
    color: var(--accent-fg);
    font-size: 26px;
    font-weight: 800;
    letter-spacing: .18em;
    font-variant-numeric: tabular-nums;
  }

  .syncd-pairing-live .syncd-qr-surface {
    width: var(--component-syncd-qr-column-width);
    min-height: 0;
    flex: 0 0 auto;
  }

  .syncd-pairing-live__copy {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--component-syncd-stack-gap);
  }

  .syncd-pairing-code {
    margin: var(--space-xs) 0 0;
    color: var(--text-primary);
    font-family: var(--font-mono, "Cascadia Mono", monospace);
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-wide);
  }

  .syncd-approval {
    justify-content: space-between;
    padding: var(--component-syncd-surface-padding);
    border: 1px solid var(--component-syncd-pill-info-border);
    border-radius: var(--component-syncd-surface-radius);
    background: var(--component-syncd-status-bg);
  }

  .syncd-modal__views .is-active {
    color: var(--component-syncd-status-icon-fg);
    border-color: var(--component-syncd-input-border-focus);
    background: var(--component-syncd-status-icon-bg);
  }

  @keyframes syncdSpin {
    to { transform: rotate(360deg); }
  }

  @keyframes syncdProgress {
    0% { transform: translateX(-110%); }
    100% { transform: translateX(240%); }
  }

  @keyframes syncdModalIn {
    from { opacity: 0; transform: translateY(var(--component-syncd-modal-enter-offset)) scale(var(--component-syncd-modal-enter-scale)); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  @media (max-width: 880px) {
    .syncd-card__head,
    .syncd-row,
    .syncd-list__item,
    .syncd-approval {
      align-items: stretch;
      flex-direction: column;
    }

    .syncd-modal__header,
    .syncd-modal__footer {
      padding: var(--component-syncd-modal-chrome-padding-compact);
    }

    .syncd-modal__body {
      padding: var(--component-syncd-modal-body-padding-compact);
    }

    .syncd-modal__views {
      min-width: 0;
      overflow-x: auto;
    }

    .syncd-pairing-live {
      flex-direction: column;
    }

    .syncd-pairing-live .syncd-qr-surface {
      width: 100%;
    }
  }

  /* Compact state-driven pairing flow approved for the Nocturne desktop shell. */
  .syncd-modal {
    height: auto;
    min-height: min(500px, calc(100vh - 64px));
  }

  .syncd-modal__header {
    align-items: flex-start;
  }

  .syncd-modal__heading {
    display: block;
  }

  .syncd-modal__heading h2 {
    font-size: var(--text-base);
    letter-spacing: var(--tracking-normal);
    line-height: var(--leading-snug);
  }

  .syncd-modal__heading p {
    margin: var(--space-xs) 0 0;
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-input-font-size);
  }

  .syncd-modal__body {
    min-height: 350px;
  }

  .syncd-status-line,
  .syncd-field-actions,
  .syncd-request,
  .syncd-session-summary,
  .syncd-device-pair {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-syncd-control-gap);
  }

  .syncd-status-copy {
    display: inline-flex;
    align-items: center;
    gap: var(--component-syncd-pill-gap);
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-status-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--component-syncd-pill-radius);
    background: var(--component-syncd-pill-fg);
  }

  .syncd-status-dot--live {
    background: var(--component-syncd-status-icon-fg);
  }

  .syncd-link {
    min-height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-link:hover {
    color: var(--component-syncd-status-icon-fg);
  }

  .syncd-mode-switch {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--component-syncd-pill-gap);
    margin-top: var(--component-syncd-grid-gap);
    padding: var(--component-syncd-pill-gap);
    border: 1px solid var(--component-syncd-input-border);
    border-radius: var(--component-syncd-input-radius);
    background: var(--component-syncd-input-bg);
  }

  .syncd-mode-switch button {
    min-height: 34px;
    border: 1px solid transparent;
    border-radius: calc(var(--component-syncd-input-radius) - 3px);
    background: transparent;
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-input-font-size);
    font-weight: var(--weight-semibold);
  }

  .syncd-mode-switch button.is-active {
    border-color: var(--component-syncd-surface-border);
    background: var(--component-syncd-status-icon-bg);
    color: var(--text-primary);
  }

  .syncd-start-copy {
    padding-top: var(--component-syncd-grid-gap);
  }

  .syncd-start-copy h3,
  .syncd-permissions h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--text-sm);
    letter-spacing: var(--tracking-tight);
  }

  .syncd-start-copy > p {
    max-width: 52ch;
    margin: var(--space-xs) 0 0;
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-input-font-size);
    line-height: var(--leading-normal);
  }

  .syncd-note {
    margin-top: var(--component-syncd-grid-gap);
    padding: var(--component-syncd-stack-gap) var(--component-syncd-surface-padding);
    border-left: 2px solid var(--component-syncd-status-icon-border);
    background: var(--component-syncd-status-bg);
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-pill-font-size);
    line-height: var(--leading-normal);
  }

  .syncd-field {
    margin-top: var(--component-syncd-grid-gap);
  }

  .syncd-field > span,
  .syncd-field-actions > span {
    color: var(--component-syncd-label-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-textarea {
    min-height: 72px;
    resize: none;
  }

  .syncd-field-actions {
    margin-top: var(--component-syncd-pill-gap);
  }

  .syncd-disclosure {
    margin-top: var(--component-syncd-grid-gap);
    border-top: 1px solid var(--component-syncd-modal-divider);
  }

  .syncd-disclosure > button {
    width: 100%;
    min-height: 38px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--component-syncd-muted-fg);
    text-align: left;
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-disclosure__body {
    display: flex;
    flex-direction: column;
    gap: var(--component-syncd-stack-gap);
    padding-bottom: var(--component-syncd-stack-gap);
  }

  .syncd-list__item strong,
  .syncd-list__item small {
    display: block;
  }

  .syncd-list__item strong {
    color: var(--text-secondary);
    font-size: var(--component-syncd-input-font-size);
  }

  .syncd-list__item small {
    margin-top: var(--component-syncd-pill-gap);
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-pairing-live {
    display: grid;
    grid-template-columns: var(--component-syncd-qr-column-width) 1fr;
    margin-top: var(--component-syncd-grid-gap);
  }

  .syncd-pairing-live .syncd-qr-surface {
    width: var(--component-syncd-qr-column-width);
    background: var(--component-syncd-status-icon-fg);
    border-style: solid;
  }

  .syncd-qr-image {
    width: 100%;
    border-radius: calc(var(--component-syncd-qr-radius) - 4px);
  }

  .syncd-pairing-live__copy > span,
  .syncd-pairing-live__copy > small {
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-request,
  .syncd-session-summary {
    margin-top: var(--component-syncd-grid-gap);
    padding: var(--component-syncd-surface-padding) 0;
    border-top: 1px solid var(--component-syncd-modal-divider);
    border-bottom: 1px solid var(--component-syncd-modal-divider);
  }

  .syncd-request strong,
  .syncd-request small,
  .syncd-session-summary strong,
  .syncd-session-summary span {
    display: block;
  }

  .syncd-request strong,
  .syncd-session-summary strong {
    color: var(--text-primary);
    font-size: var(--component-syncd-input-font-size);
  }

  .syncd-request small,
  .syncd-session-summary span {
    margin-top: var(--component-syncd-pill-gap);
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-request > span,
  .syncd-session-summary > span {
    color: var(--component-syncd-status-icon-fg);
  }

  .syncd-scope-list > span {
    padding: var(--component-syncd-pill-padding);
    border: 1px solid var(--component-syncd-pill-border);
    border-radius: var(--component-syncd-input-radius);
    background: var(--component-syncd-pill-bg);
    color: var(--component-syncd-pill-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-device-pair {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    margin-top: var(--component-syncd-grid-gap);
  }

  .syncd-device-pair > div:last-child {
    text-align: right;
  }

  .syncd-device-pair small,
  .syncd-device-pair strong,
  .syncd-device-pair span {
    display: block;
  }

  .syncd-device-pair small,
  .syncd-device-pair span {
    color: var(--component-syncd-muted-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-device-pair strong {
    margin: var(--component-syncd-pill-gap) 0;
    color: var(--text-primary);
    font-size: var(--component-syncd-input-font-size);
  }

  .syncd-device-pair em {
    padding: var(--component-syncd-pill-padding);
    border-top: 1px solid var(--component-syncd-status-icon-border);
    border-bottom: 1px solid var(--component-syncd-status-icon-border);
    color: var(--component-syncd-status-icon-fg);
    font-size: var(--component-syncd-pill-font-size);
    font-style: normal;
  }

  .syncd-manage .syncd-meta-grid {
    margin-top: var(--component-syncd-grid-gap);
    padding-bottom: var(--component-syncd-grid-gap);
    border-bottom: 1px solid var(--component-syncd-modal-divider);
  }

  .syncd-manage .syncd-meta-grid small,
  .syncd-manage .syncd-meta-grid strong {
    display: block;
  }

  .syncd-manage .syncd-meta-grid small {
    color: var(--component-syncd-label-fg);
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-manage .syncd-meta-grid strong {
    margin-top: var(--component-syncd-pill-gap);
    color: var(--text-secondary);
    font-size: var(--component-syncd-input-font-size);
    font-weight: var(--weight-medium);
  }

  .syncd-manage .syncd-meta-grid .is-mono {
    font-family: var(--font-mono, "Cascadia Mono", monospace);
    overflow-wrap: anywhere;
  }

  .syncd-permissions {
    margin-top: var(--component-syncd-grid-gap);
  }

  .syncd-permission-device label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 38px;
    color: var(--text-secondary);
  }

  .syncd-permission-device label strong,
  .syncd-permission-device label small {
    display: block;
    font-size: var(--component-syncd-pill-font-size);
  }

  .syncd-permission-device label small {
    margin-top: var(--component-syncd-pill-gap);
    color: var(--component-syncd-muted-fg);
  }

  .syncd-permission-device input {
    accent-color: var(--component-syncd-input-border-focus);
  }

  @media (max-width: 620px) {
    .syncd-modal {
      width: calc(100vw - 24px);
      max-width: calc(100vw - 24px);
    }

    .syncd-device-pair {
      grid-template-columns: 1fr;
    }

    .syncd-device-pair > div:last-child {
      text-align: left;
    }

    .syncd-device-pair em {
      width: max-content;
      padding-inline: 0;
    }

    .syncd-modal__footer,
    .syncd-modal__footer .syncd-actions {
      flex-wrap: wrap;
    }
  }
</style>
