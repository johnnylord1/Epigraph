<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { operationFailure, presentOperationFailure, type OperationFailure } from "../../lib/i18n/operationPresentation";
  import { _ } from "../../lib/i18n/runtime";
  import { onMount } from "svelte";
  import { firstRunSyncReadinessKey, refreshFirstRunSyncLibrary } from "../../lib/setup/firstRunSyncReadiness";
  import { ArrowClockwise, CaretRight, Check, CircleNotch, Copy, Desktop, DeviceMobile, Devices, DownloadSimple, ImageSquare, Info, Plugs, QrCode, Trash, UploadSimple, Warning, X } from "phosphor-svelte";
  import { glideHeight } from "../../lib/motion/motion";
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
    syncdRevokePairedDevice,
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
  /** Device whose revoke button was pressed once; a second press revokes it. */
  let revokeArmedDeviceId = $state<string | null>(null);
  let removePreviousPairings = $state(false);
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
  let hostOptionsOpen = $state(false);
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
      return { tone: "info", label: translate("syncd_status_approvalNeeded"), title: approvalTitle, body: translate("syncd_modal_reviewApprove") };
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

  // Only the device behind this connection gets scope switches; hide the block when there is none.
  // A reinstalled phone pairs under a new id, so without a claimed id only the most recently seen
  // device with the remote name stands in; its older namesakes are listed under paired devices.
  const permissionDevices = $derived.by(() => {
    const claimedIds = [host?.claimedDeviceId, connect?.claimedDeviceId].filter(Boolean);
    const claimed = pairedDevices.filter((device) => claimedIds.includes(device.deviceId));
    if (claimed.length > 0) return claimed;
    const latest = pairedDevices
      .filter((device) => device.deviceName === remoteDeviceName)
      .reduce<SyncdPairedDeviceView | null>(
        (best, device) => ((device.lastSeenAtMs ?? 0) > (best?.lastSeenAtMs ?? -1) ? device : best),
        null,
      );
    return latest ? pairedDevices.filter((device) => device.deviceId === latest.deviceId) : [];
  });

  const pairedDevicesByLastSeen = $derived(
    [...pairedDevices].sort((a, b) => (b.lastSeenAtMs ?? 0) - (a.lastSeenAtMs ?? 0)),
  );

  const inactiveDeviceIds = $derived(
    [...new Set(pairedDevices.filter((device) => device.inactive).map((device) => device.deviceId))],
  );

  /* Earlier pairings with the claimant's name and platform are most likely the same phone before a
     reinstall. They are offered for removal on approval, never removed silently: two people can own
     the same model. */
  const previousPairingsOfClaimant = $derived.by(() => {
    const claimedId = host?.claimedDeviceId;
    const name = host?.claimedDeviceName?.trim();
    if (!claimedId || !name) return [];
    const platform = host?.claimedPlatform?.trim().toLowerCase();
    return [...new Set(pairedDevices
      .filter((device) => device.deviceId !== claimedId
        && device.deviceName === name
        && (!platform || device.platform === platform))
      .map((device) => device.deviceId))];
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

  /* Phones and desktops both claim this host, so approval copy follows the claimant's platform. */
  const remoteDeviceKind = $derived.by(() => {
    const claimedDeviceId = host?.claimedDeviceId ?? connect?.claimedDeviceId ?? null;
    const pairedDevice = claimedDeviceId
      ? pairedDevices.find((device) => device.deviceId === claimedDeviceId)
      : null;
    const platform = (host?.claimedPlatform?.trim() || pairedDevice?.platform || "").toLowerCase();
    if (["android", "ios", "mobile", "phone"].includes(platform)) return "phone" as const;
    if (["desktop", "windows", "macos", "linux"].includes(platform)) return "desktop" as const;
    return "device" as const;
  });
  const approvalTitle = $derived(
    remoteDeviceKind === "phone" ? $_("syncd_modal_phoneWantsConnect")
      : remoteDeviceKind === "desktop" ? $_("syncd_modal_desktopWantsConnect")
        : $_("syncd_modal_deviceWantsConnect"),
  );
  const approvalVerificationHint = $derived(
    remoteDeviceKind === "phone" ? $_("syncd_modal_verificationHintPhone")
      : remoteDeviceKind === "desktop" ? $_("syncd_modal_verificationHint")
        : $_("syncd_modal_verificationHintDevice"),
  );

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
    // An approved code is spent; showing it again would invite a second device to reuse it.
    if (host?.status === "pending") return "waiting" as const;
    return "start" as const;
  });

  /* Header status line: "no desktop yet" before pairing starts, the live overview after. */
  const headerIdle = $derived(pairingStage === "start" && !panelError && host?.status !== "approved");
  const headerTone = $derived(headerIdle ? "neutral" : overviewStatus.tone);
  const headerStatus = $derived(headerIdle ? translate("syncd_modal_noActiveDesktop") : overviewStatus.title);

  /* The floating dialog glides between step heights; the first-run embedding keeps its sheet's height. */
  function glideWhenModal(node: HTMLElement) {
    return presentation === "modal" ? glideHeight(node) : undefined;
  }

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

  async function revokePairedDevice(device: SyncdPairedDeviceView) {
    if (pairedDeviceScopeBusy) return;
    if (revokeArmedDeviceId !== device.deviceId) {
      revokeArmedDeviceId = device.deviceId;
      return;
    }
    pairedDeviceScopeBusy = `${device.deviceId}:${device.profileId}`;
    panelError = null;
    try {
      await syncdRevokePairedDevice(device.deviceId);
      pairedDevices = pairedDevices.filter((candidate) => candidate.deviceId !== device.deviceId);
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
    } finally {
      revokeArmedDeviceId = null;
      pairedDeviceScopeBusy = null;
    }
  }

  /* Inactive devices already lost access after the token inactivity window; removing them only
     clears the list, and pairing again brings a device back. */
  async function removeInactiveDevices() {
    if (pairedDeviceScopeBusy || inactiveDeviceIds.length === 0) return;
    const deviceIds = inactiveDeviceIds;
    pairedDeviceScopeBusy = "inactive";
    panelError = null;
    try {
      for (const deviceId of deviceIds) await syncdRevokePairedDevice(deviceId);
      pairedDevices = pairedDevices.filter((device) => !deviceIds.includes(device.deviceId));
    } catch (error) {
      panelError = { cause: error, fallback: "ui_syncActionFailed" };
      void loadPairedDevices();
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
    const replacedDeviceIds = decision === "approve" && removePreviousPairings
      ? previousPairingsOfClaimant
      : [];
    try {
      const nextHost = await withTimeout(
        syncdHostDecidePairing(host.sessionId, decision),
        HOST_DECISION_TIMEOUT_MS,
        "SYNC_DECISION_TIMEOUT",
      );
      if (!panelMounted) return;
      host = mergeHostState(host, nextHost);
      for (const deviceId of replacedDeviceIds) await syncdRevokePairedDevice(deviceId);
      removePreviousPairings = false;
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
      // A minimized window has no one to show the status to; the next visible tick refreshes it.
      if (document.hidden) return;
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
  <div bind:this={modalElement} class:syncd-modal--embedded={presentation === "embedded"} class="syncd-modal" role="dialog" aria-modal={presentation === "modal" ? "true" : undefined} aria-labelledby="syncd-modal-title" tabindex="-1" onkeydown={handleModalKeydown} use:glideWhenModal>
    <div class="syncd-panel-grid" data-testid="syncd-panel-grid" data-panel-ready={panelSubscriptionsReady ? "ready" : "loading"}>
      <header class="syncd-modal__header">
        <span class="syncd-modal__glyph" aria-hidden="true"><Devices size={24} weight="duotone" /></span>
        <div class="syncd-modal__heading">
          <h2 id="syncd-modal-title">{$_("settings_inline_desktopSyncPairing")}</h2>
          <p class="syncd-status-copy" data-tone={headerTone}><span class="syncd-status-dot"></span><span>{headerStatus}</span></p>
        </div>
        {#if presentation === "modal"}<button class="syncd-icon-btn" type="button" aria-label={$_("common_close")} onclick={closeModal}><X size={18} weight="bold" /></button>{/if}
      </header>

      <div bind:this={modalBodyElement} class="syncd-modal__body">
        <section class="syncd-view" hidden={modalView !== "pairing"} aria-hidden={modalView !== "pairing"} data-testid="syncd-pairing-view">
          {#if pairingStage === "start"}
            <div class="syncd-tabs" role="group" aria-label={$_("syncd_modal_pairingOptions")}>
              <button class:is-active={pairingMode === "create"} type="button" aria-pressed={pairingMode === "create"} onclick={() => (pairingMode = "create")}><QrCode size={16} />{$_("syncd_action_createPairingQr")}</button>
              <button class:is-active={pairingMode === "use"} type="button" aria-pressed={pairingMode === "use"} onclick={() => (pairingMode = "use")}><UploadSimple size={16} />{$_("ui_loadQrImage")}</button>
            </div>

            {#if pairingMode === "create"}
              <div class="syncd-start-copy syncd-pane" data-testid="syncd-host-card">
                <h3>{$_("syncd_modal_pairDesktop")}</h3>
                <p>{$_("syncd_modal_createShortLivedQr")}</p>
                <span class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-host-status">{statusLabel("idle")}</span>
                <span class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-host-start-stage">{hostStartStage}</span>
              </div>
            {:else}
              <div class="syncd-start-copy syncd-pane" data-testid="syncd-options-view">
                <p>{$_("syncd_modal_useHostPairingPackage")}</p>
                <input bind:this={qrFileInput} class="syncd-hidden-input" data-testid="syncd-qr-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleQrFilePicked} />
                <button class="syncd-link" type="button" data-testid="syncd-connect-load-qr" onclick={openQrImagePicker} disabled={qrDecodeBusy}>{#if qrDecodeBusy}<CircleNotch size={15} class="syncd-spinner" />{:else}<ImageSquare size={15} />{/if}{qrDecodeBusy ? $_("ui_readingQr") : $_("ui_loadQrImage")}</button>
                {#if bootstrapBundleInput.trim() && !advancedConnectOpen}<p class="syncd-note"><Check size={15} weight="bold" />{$_("ui_syncQrLoaded")}</p>{/if}
                <div class:syncd-disclosure--open={advancedConnectOpen} class="syncd-disclosure">
                  <button type="button" data-testid="syncd-modal-options" aria-expanded={advancedConnectOpen} onclick={() => (advancedConnectOpen = !advancedConnectOpen)}><CaretRight size={13} weight="bold" class="syncd-disclosure__caret" />{$_("syncd_modal_pairingOptions")}</button>
                  {#if advancedConnectOpen}
                    <div class="syncd-disclosure__body">
                      <label class="syncd-field"><span class="syncd-field__label">{$_("ui_bootstrapBundle")}</span><span class="syncd-field__control"><textarea bind:this={bootstrapBundleTextarea} class="syncd-textarea" data-testid="syncd-bootstrap-bundle-input" bind:value={bootstrapBundleInput} placeholder={$_("ui_pasteTheHostBundleJsonHere")}></textarea></span></label>
                      <div class="syncd-row"><span>{$_("ui_discoveredPeers")}</span><button class="syncd-link" type="button" data-testid="syncd-connect-refresh-peers" onclick={refreshDiscoveryCandidates} disabled={loadingCandidates}>{#if loadingCandidates}<CircleNotch size={14} class="syncd-spinner" />{:else}<ArrowClockwise size={14} />{/if}{loadingCandidates ? $_("common_refreshing") : $_("ui_refreshPeers")}</button></div>
                      {#if candidates.length > 0}<div class="syncd-list" data-testid="syncd-discovered-peers">{#each candidates as candidate}<div class="syncd-list__item" data-testid="syncd-peer-item"><span class="syncd-list__icon" aria-hidden="true"><Desktop size={18} /></span><div><strong>{candidate.deviceName || candidate.instanceName}</strong><small>{candidate.effectiveOrigin}</small></div><button class="syncd-link" type="button" data-testid="syncd-peer-use-origin" onclick={() => (manualOrigin = candidate.discoveryOrigin)}>{$_("ui_useOrigin")}</button></div>{/each}</div>{/if}
                      <label class="syncd-field"><span class="syncd-field__label">{$_("ui_manualOriginFallback")}</span><span class="syncd-field__control"><input bind:this={manualOriginInput} class="syncd-input" data-testid="syncd-manual-origin" bind:value={manualOrigin} placeholder={$_("ui_https1921681254777")} spellcheck="false" /></span></label>
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          {:else if pairingStage === "waiting" && host}
            <div class="syncd-pairing-live syncd-pane">
              <div class="syncd-qr-surface" data-testid="syncd-host-qr-surface">{#if qrCodeDataUrl}<img class="syncd-qr-image" data-testid="syncd-host-qr-image" data-session-id={host.sessionId} data-origin={host.advertisedBaseUrl} src={qrCodeDataUrl} alt={$_("ui_syncBootstrapQrCode")} />{:else}<CircleNotch size={24} weight="bold" class="syncd-spinner" />{/if}</div>
              <div class="syncd-pairing-live__copy">
                {#if hostPinDisplay}
                  <strong class="syncd-pairing-pin" data-testid="syncd-host-pin" aria-label={$_("syncd_modal_pinLabel")}>{hostPinDisplay}</strong>
                  <small class="syncd-pin-hint">{$_("syncd_modal_pinHint", { name: localDeviceName })}</small>
                {:else}
                  <strong class="syncd-pairing-pin" aria-label={$_("ui_pairingCode")}>{host.pairingCode}</strong>
                {/if}
                <div class="syncd-pin-expiry" aria-live="off"><span class="syncd-pin-expiry__bar"><i style:transform={`scaleX(${Math.min(1, hostSecondsLeft / 300)})`}></i></span><small>{$_("syncd_modal_pinRenews", { time: formatCountdown(hostSecondsLeft) })}</small></div>
              </div>
              <span class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-host-status-live" data-status={host.status}>{statusLabel(host.status)}</span>
            </div>
            <div class:syncd-disclosure--open={hostOptionsOpen} class="syncd-disclosure">
              <button type="button" aria-expanded={hostOptionsOpen} onclick={() => (hostOptionsOpen = !hostOptionsOpen)}><CaretRight size={13} weight="bold" class="syncd-disclosure__caret" />{$_("syncd_modal_pairingOptions")}</button>
              {#if hostOptionsOpen}
                <div class="syncd-disclosure__body">
                  {#if hostPinDisplay}<div class="syncd-row"><span>{$_("ui_pairingCode")}</span><strong class="syncd-pairing-code">{host.pairingCode}</strong></div>{/if}
                  <div class="syncd-actions"><button class="syncd-link" type="button" data-testid="syncd-host-copy-bundle" onclick={copyBootstrapBundle}>{#if copiedBundle}<Check size={15} weight="bold" />{:else}<Copy size={15} />{/if}{copiedBundle ? $_("massMigration_statusCopied") : $_("ui_copyBundle")}</button><button class="syncd-link" type="button" data-testid="syncd-host-save-qr" onclick={saveBootstrapQrCode} disabled={!qrCodeDataUrl}><DownloadSimple size={15} />{$_("ui_saveQrImage")}</button></div>
                </div>
              {/if}
            </div>
            <p class="syncd-note"><Info size={16} />{$_("syncd_modal_keepWindowsOpen")}</p>
          {:else if pairingStage === "approval" && host}
            <div class="syncd-start-copy syncd-pane"><h3>{approvalTitle}</h3></div>
            <div class="syncd-request syncd-pane"><span class="syncd-list__icon" aria-hidden="true">{#if remoteDeviceKind === "phone"}<DeviceMobile size={20} />{:else}<Desktop size={20} />{/if}</span><div><strong>{remoteDeviceName}</strong><small>{remotePlatformLabel}</small></div></div>
            <div class="syncd-verification syncd-pane" data-testid="syncd-host-verification"><strong aria-label={$_("syncd_modal_verificationLabel")}>{hostVerificationCode}</strong><small>{approvalVerificationHint}</small></div>
            <ul class="syncd-scope-list syncd-pane" data-testid="syncd-requested-scopes">{#each host.requestedScopes as scope}<li><Check size={14} weight="bold" />{permissionScopeLabel(scope)}</li>{/each}</ul>
            {#if previousPairingsOfClaimant.length > 0}<label class="syncd-replace-previous syncd-pane" data-testid="syncd-replace-previous-pairings"><span>{$_("syncd_modal_replacePreviousPairings", { count: previousPairingsOfClaimant.length })}</span><input class="syncd-switch" type="checkbox" bind:checked={removePreviousPairings} disabled={hostDecisionBusy !== null} /></label>{/if}
            <span class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-host-status-live" data-status={host.status}>{statusLabel(host.status)}</span>
          {:else}
            <div class="syncd-request syncd-pane"><span class="syncd-list__icon" aria-hidden="true"><Desktop size={20} /></span><div><strong>{remoteDeviceName}</strong><small>{overviewStatus.body}</small></div><span class="syncd-state" data-tone={overviewStatus.tone}>{statusLabel(replicationSnapshot?.replicationStatus ?? "connected")}</span></div>
            <span class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-replication-active-session">{replicationSnapshot?.activeSessionKey ?? $_("ui_noneSelected")}</span>
            <span class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-replication-status" data-status={replicationSnapshot?.replicationStatus ?? "idle"}>{statusLabel(replicationSnapshot?.replicationStatus ?? "idle")}</span>
          {/if}

          {#if connect}<div class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-connect-state"><span data-testid="syncd-connect-status" data-status={connect.status}>{statusLabel(connect.status)}</span>{#if connect.error}<span data-testid="syncd-connect-error">{connect.error}</span>{/if}</div>{/if}
          {#if host?.error}<div data-testid="syncd-host-error"><NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("syncd_modal_host")} title={$_("ui_hostPairingFailed")} body={host.error} /></div>{/if}
          {#if presentation === "embedded" && initialSyncError}
            <div class="syncd-inline-alert" role="alert" data-testid="syncd-initial-sync-error">
              <p><Warning size={16} />{presentOperationFailure(initialSyncError, $_)}</p>
              <button type="button" class="syncd-btn" onclick={() => initialSyncRetry += 1}>{$_("setup_retry")}</button>
            </div>
          {/if}
          {#if presentation === "embedded" && pairingStage === "connected" && !initialSyncReady && !initialSyncError}
            <p class="syncd-inline-status" role="status" data-testid="syncd-initial-sync-status" data-phase={initialSyncPhase}><CircleNotch size={15} class="syncd-spinner" />{initialSyncKey ? $_("ui_loading") : statusLabel(replicationSnapshot?.replicationStatus ?? "connecting")}</p>
          {/if}
          {#if panelError}<div data-testid="syncd-panel-error"><NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("syncd_modal_sync")} title={$_("ui_syncActionFailed")} body={panelErrorText} /></div>{/if}
        </section>

        <section class="syncd-view syncd-manage" hidden={modalView !== "details"} aria-hidden={modalView !== "details"} data-testid="syncd-details-view">
          <div class="syncd-start-copy syncd-pane"><h3>{$_("syncd_modal_connectionDetails")}</h3></div>
          <dl class="syncd-meta-list syncd-pane">
            <div><dt>{$_("syncd_modal_currentDevice")}</dt><dd>{localDeviceName}</dd></div>
            <div><dt>{$_("ui_claimedDevice")}</dt><dd>{remoteDeviceName}</dd></div>
            <div><dt>{$_("ui_advertisedOrigin")}</dt><dd class="is-mono">{activeSession?.canonicalOrigin ?? connect?.remoteOrigin ?? host?.advertisedBaseUrl ?? $_("syncd_status_waiting")}</dd></div>
            <div><dt>{$_("ui_lastConnected")}</dt><dd>{formatWhen(replicationSnapshot?.lastConnectedAtMs ?? activeSession?.lastValidatedAtMs)}</dd></div>
          </dl>
          {#if permissionDevices.length > 0}<div class="syncd-permissions syncd-pane" data-testid="syncd-paired-device-permissions"><h3>{$_("ui_scope")}</h3>{#each permissionDevices as device}<div class="syncd-permission-device" data-testid="syncd-paired-device-permission">{#each allowedDeviceScopes(device) as scope}<label><strong>{permissionScopeLabel(scope)}</strong><input class="syncd-switch" type="checkbox" checked={device.grantedScopes.includes(scope)} disabled={pairedDeviceScopeBusy !== null} onchange={() => togglePairedDeviceScope(device, scope)} /></label>{/each}<button class="syncd-btn" type="button" data-testid="syncd-revoke-paired-device" disabled={pairedDeviceScopeBusy !== null} onclick={() => revokePairedDevice(device)}>{revokeArmedDeviceId === device.deviceId ? $_("syncd_action_revokeDeviceConfirm") : $_("syncd_action_revokeDevice")}</button></div>{/each}</div>{/if}
          {#if pairedDevices.length > 0}
            <div class="syncd-permissions syncd-pane" data-testid="syncd-paired-devices">
              <h3>{$_("syncd_modal_pairedDevices")}</h3>
              <div class="syncd-list">
                {#each pairedDevicesByLastSeen as device (`${device.deviceId}:${device.profileId}`)}
                  {@const current = permissionDevices.some((candidate) => candidate.deviceId === device.deviceId)}
                  <div class="syncd-list__item" data-testid="syncd-paired-device-item" data-inactive={device.inactive ? "true" : "false"}>
                    <span class="syncd-list__icon" aria-hidden="true">{#if device.platform === "android"}<DeviceMobile size={18} />{:else}<Desktop size={18} />{/if}</span>
                    <div><strong>{device.deviceName}</strong><small>{current ? `${$_("syncd_modal_thisConnection")} · ` : ""}{$_("syncd_modal_pairedDeviceLastSeen", { when: formatWhen(device.lastSeenAtMs) })}</small></div>
                    {#if device.inactive}<span class="syncd-state" data-tone="danger">{$_("syncd_modal_pairedDeviceInactive")}</span>{/if}
                    {#if !current}<button class="syncd-link" type="button" data-testid="syncd-revoke-listed-device" disabled={pairedDeviceScopeBusy !== null} onclick={() => revokePairedDevice(device)}>{revokeArmedDeviceId === device.deviceId ? $_("syncd_action_revokeDeviceConfirm") : $_("syncd_action_revokeDevice")}</button>{/if}
                  </div>
                {/each}
              </div>
              {#if inactiveDeviceIds.length > 0}
                <p class="syncd-note"><Info size={16} />{$_("syncd_modal_pairedDeviceInactiveHint")}</p>
                <div><button class="syncd-btn" type="button" data-testid="syncd-remove-inactive-devices" disabled={pairedDeviceScopeBusy !== null} onclick={removeInactiveDevices}>{pairedDeviceScopeBusy === "inactive" ? $_("syncd_action_removing") : $_("syncd_action_removeInactiveDevices", { count: inactiveDeviceIds.length })}</button></div>
              {/if}
            </div>
          {/if}
          {#if persistedSessions.length > 0}<div class="syncd-hidden-value" aria-hidden="true" data-testid="syncd-persisted-sessions">{#each persistedSessions as session}<span data-testid="syncd-persisted-session-item">{session.sessionKey}</span>{/each}</div>{/if}
        </section>
      </div>

      <footer class="syncd-modal__footer">
        {#if modalView === "details"}
          <button class="syncd-btn syncd-btn--danger" type="button" disabled={!activeSession || forgetBusyKey !== null} onclick={() => activeSession && forgetSession(activeSession.sessionKey)}><Trash size={16} />{forgetBusyKey ? $_("syncd_action_forgetting") : $_("syncd_action_forget")}</button>
          <span class="syncd-spacer"></span>
          <button class="syncd-btn" type="button" disabled={!activeSession || disconnectBusyKey !== null} onclick={() => activeSession && disconnectSession(activeSession.sessionKey)}>{$_("syncd_action_disconnect")}</button>
          <button class="syncd-btn" type="button" data-testid="syncd-revalidate-sessions" onclick={revalidatePersisted} disabled={!hasProfile() || revalidateBusy}>{revalidateBusy ? $_("syncd_action_revalidating") : $_("syncd_action_revalidate")}</button>
          <button class="syncd-btn syncd-btn--primary" type="button" data-testid="syncd-modal-pairing" onclick={() => showView("pairing")}>{$_("sources_actions_done")}</button>
        {:else}
          <button class="syncd-btn syncd-btn--quiet" type="button" data-testid="syncd-modal-details" onclick={() => showView("details")}><Info size={16} />{$_("syncd_modal_connectionDetails")}</button>
          <span class="syncd-spacer"></span>
          {#if pairingStage === "start"}
            {#if presentation === "modal"}<button class="syncd-btn" type="button" onclick={closeModal}>{$_("ui_cancel")}</button>{/if}
            {#if pairingMode === "create"}<button class="syncd-btn syncd-btn--primary" type="button" data-testid="syncd-host-start" onclick={startHostPairing} disabled={!hasProfile() || loadingHost}>{#if loadingHost}<CircleNotch size={16} class="syncd-spinner" />{:else}<QrCode size={16} />{/if}{loadingHost ? $_("syncd_action_preparing") : $_("syncd_action_createPairingQr")}</button>{:else}<button class="syncd-btn syncd-btn--primary" type="button" data-testid="syncd-connect-submit" onclick={connectToRemote} disabled={!hasProfile() || connectBusy || !bootstrapBundleInput.trim()}>{#if connectBusy}<CircleNotch size={16} class="syncd-spinner" />{:else}<Plugs size={16} />{/if}{connectBusy ? $_("settings_inline_connecting") : $_("ui_connectToHost")}</button>{/if}
          {:else if pairingStage === "approval"}
            <button class="syncd-btn syncd-btn--danger" type="button" data-testid="syncd-host-reject" onclick={() => decideHostPairing("reject")} disabled={hostDecisionBusy !== null}>{hostDecisionBusy === "reject" ? $_("syncd_action_rejecting") : $_("syncd_action_reject")}</button>
            <button class="syncd-btn syncd-btn--primary" type="button" data-testid="syncd-host-approve" onclick={() => decideHostPairing("approve")} disabled={hostDecisionBusy !== null}>{hostDecisionBusy === "approve" ? $_("syncd_action_approving") : $_("syncd_action_approve")}</button>
          {:else if pairingStage === "connected"}
            <button class="syncd-btn" type="button" data-testid="syncd-replication-toggle" onclick={replicationSnapshot?.paused ? resumeReplication : pauseReplication} disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}>{replicationSnapshot?.paused ? $_("ui_resumeReplication") : $_("ui_pauseReplication")}</button>
            <button class="syncd-btn" type="button" data-testid="syncd-replication-reconnect" onclick={reconnectReplication} disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}>{replicationActionBusy === "reconnect" ? $_("syncd_action_reconnecting") : $_("ui_reconnectNow")}</button>
            {#if presentation === "modal"}<button class="syncd-btn syncd-btn--primary" type="button" onclick={closeModal}>{$_("common_close")}</button>{/if}
          {:else}
            <button class="syncd-btn" type="button" onclick={startHostPairing}><ArrowClockwise size={16} />{$_("ui_refreshBundle")}</button>
            {#if presentation === "modal"}<button class="syncd-btn syncd-btn--primary" type="button" onclick={closeModal}>{$_("common_close")}</button>{/if}
          {/if}
        {/if}
      </footer>
    </div>
  </div>
</div>

<style>
  /* Pairing dialog in the language of the app's other modals (migration, first run): a title and
     status line on the open surface, hairline dividers, text tabs with an accent underline,
     filled fields that grow the same underline on focus, statuses as coloured words, and one filled
     primary action in the footer. No cards, capsules or boxed notes. */
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
    animation: syncd-fade var(--component-syncd-transition-fast) both;
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
    animation: none;
  }

  .syncd-modal {
    width: var(--component-syncd-modal-width);
    max-width: 100%;
    max-height: var(--component-syncd-modal-height);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--component-syncd-modal-border);
    border-radius: var(--component-syncd-modal-radius);
    background: var(--component-syncd-modal-bg);
    box-shadow: var(--component-syncd-modal-shadow);
    color: var(--component-syncd-body-fg);
    font-family: var(--font-ui);
    animation: syncd-rise var(--component-syncd-modal-animation) both;
  }

  .syncd-modal:focus {
    outline: none;
  }

  .syncd-modal--embedded {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: inherit;
    background: transparent;
    box-shadow: none;
    animation: none;
  }

  .syncd-panel-grid {
    min-height: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
  }

  /* Header: accent glyph, eyebrow, title and the live status as a coloured line. */
  .syncd-modal__header {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--component-syncd-divider);
  }

  .syncd-modal__glyph {
    flex: none;
    display: grid;
    place-items: center;
    padding-top: 2px;
    color: var(--component-syncd-accent-fg);
  }

  .syncd-modal__heading {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 3px;
  }

  .syncd-modal__heading h2 {
    margin: 0;
    color: var(--component-syncd-title-fg);
    font-size: var(--text-xl);
    font-weight: 750;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }

  .syncd-status-copy {
    min-width: 0;
    margin: 2px 0 0;
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-xs);
  }

  .syncd-status-dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: var(--component-syncd-pill-radius);
    background: currentColor;
    transition: background var(--component-syncd-transition-normal);
  }

  .syncd-status-copy[data-tone="success"] .syncd-status-dot { background: var(--component-syncd-good-fg); animation: syncd-pulse 2.4s var(--component-syncd-easing) infinite; }
  .syncd-status-copy[data-tone="info"] .syncd-status-dot { background: var(--component-syncd-accent-fg); animation: syncd-pulse 2.4s var(--component-syncd-easing) infinite; }
  .syncd-status-copy[data-tone="danger"] .syncd-status-dot { background: var(--component-syncd-bad-fg); }

  .syncd-icon-btn {
    width: 34px;
    height: 34px;
    flex: none;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--component-syncd-button-radius);
    color: var(--component-syncd-icon-fg);
    background: transparent;
    cursor: pointer;
    transition: color var(--component-syncd-transition-fast), background var(--component-syncd-transition-fast), transform var(--component-syncd-transition-spring);
  }

  .syncd-icon-btn:hover { color: var(--component-syncd-strong-fg); background: var(--component-syncd-surface-strong); }
  .syncd-icon-btn:active { transform: scale(0.92); }

  /* Body scrolls once the dialog reaches its cap; header and footer stay put. */
  .syncd-modal__body {
    min-height: 0;
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 18px 20px 20px;
    scrollbar-gutter: stable;
  }

  /* is-gliding is set by the glideHeight action at runtime. */
  .syncd-modal:global(.is-gliding) .syncd-modal__body {
    overflow-y: hidden;
  }

  .syncd-view {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .syncd-view[hidden] {
    display: none;
  }

  /* Each block arrives with a short rise when its step or tab changes. */
  .syncd-pane {
    animation: syncd-pane-in var(--component-syncd-transition-spring) both;
  }

  /* Create / load switch: text tabs with the accent underline of the fields. */
  .syncd-tabs {
    display: flex;
    gap: 22px;
    border-bottom: 1px solid var(--component-syncd-divider);
  }

  .syncd-tabs button {
    position: relative;
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 2px;
    border: 0;
    color: var(--component-syncd-muted-fg);
    background: transparent;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 650;
    cursor: pointer;
    transition: color var(--component-syncd-transition-fast);
  }

  .syncd-tabs button::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    border-radius: var(--component-syncd-pill-radius);
    background: var(--component-syncd-field-underline);
    transform: scaleX(0);
    transition: transform var(--component-syncd-transition-slow);
  }

  .syncd-tabs button:hover { color: var(--component-syncd-body-fg); }
  .syncd-tabs button.is-active { color: var(--component-syncd-strong-fg); }
  .syncd-tabs button.is-active::after { transform: scaleX(1); }
  .syncd-tabs button.is-active :global(svg) { color: var(--component-syncd-accent-fg); }

  .syncd-start-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .syncd-start-copy h3,
  .syncd-permissions h3 {
    margin: 0;
    color: var(--component-syncd-strong-fg);
    font-size: var(--text-base);
    font-weight: 700;
  }

  .syncd-start-copy > p {
    max-width: 56ch;
    margin: 0;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-sm);
    line-height: 1.55;
  }

  /* A note is a muted line led by its icon, never a boxed callout. */
  .syncd-start-copy > .syncd-note,
  .syncd-note {
    margin: 6px 0 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .syncd-note :global(svg) {
    flex: none;
    margin-top: 1px;
    color: var(--component-syncd-accent-fg);
  }

  /* Filled field with the growing accent underline. */
  .syncd-field {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .syncd-field__label,
  .syncd-row > span {
    color: var(--component-syncd-label-fg);
    font-size: var(--text-2xs);
    font-weight: 750;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .syncd-field__control {
    position: relative;
    display: block;
    overflow: hidden;
    border-radius: var(--component-syncd-field-radius);
    background: var(--component-syncd-surface);
    transition: background var(--component-syncd-transition-normal);
  }

  .syncd-field__control:hover { background: var(--component-syncd-surface-strong); }
  .syncd-field__control:focus-within { background: var(--component-syncd-field-focus-bg); }

  .syncd-field__control::after {
    content: "";
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 0;
    height: 2px;
    background: var(--component-syncd-field-underline);
    transform: scaleX(0);
    transition: transform var(--component-syncd-transition-slow);
  }

  .syncd-field__control:focus-within::after { transform: scaleX(1); }

  .syncd-input,
  .syncd-textarea {
    width: 100%;
    min-width: 0;
    display: block;
    padding: 11px 12px;
    border: 0;
    outline: 0;
    color: var(--component-syncd-input-fg);
    background: transparent;
    font-family: var(--font-mono, "Cascadia Mono", monospace);
    font-size: var(--text-xs);
  }

  .syncd-input::placeholder,
  .syncd-textarea::placeholder {
    color: var(--component-syncd-muted-fg);
  }

  .syncd-textarea {
    min-height: 88px;
    resize: none;
  }

  /* Text actions: quiet until hovered, led by their icon. */
  .syncd-link {
    align-self: flex-start;
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: -8px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--component-syncd-button-radius);
    color: var(--component-syncd-accent-fg);
    background: transparent;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 650;
    cursor: pointer;
    transition: background var(--component-syncd-transition-fast), color var(--component-syncd-transition-fast);
  }

  .syncd-link:hover:not(:disabled) { background: var(--component-syncd-surface-strong); }
  .syncd-link:disabled { opacity: var(--component-syncd-disabled-opacity); cursor: not-allowed; }

  .syncd-disclosure {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--component-syncd-divider);
  }

  .syncd-disclosure > button {
    width: 100%;
    min-height: 38px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    border: 0;
    color: var(--component-syncd-body-fg);
    background: transparent;
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 650;
    text-align: left;
    cursor: pointer;
    transition: color var(--component-syncd-transition-fast);
  }

  .syncd-disclosure > button:hover { color: var(--component-syncd-strong-fg); }

  .syncd-disclosure > button :global(.syncd-disclosure__caret) {
    color: var(--component-syncd-muted-fg);
    transition: transform var(--component-syncd-transition-spring);
  }

  .syncd-disclosure--open > button :global(.syncd-disclosure__caret) { transform: rotate(90deg); }

  .syncd-disclosure__body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 0 2px 21px;
    animation: syncd-pane-in var(--component-syncd-transition-spring) both;
  }

  .syncd-row,
  .syncd-list__item,
  .syncd-request {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-syncd-control-gap);
  }

  .syncd-row .syncd-link,
  .syncd-list__item .syncd-link {
    align-self: center;
    margin-left: 0;
  }

  .syncd-list {
    display: grid;
    gap: 2px;
  }

  .syncd-list__item {
    padding: 8px;
    margin: 0 -8px;
    border-radius: var(--component-syncd-row-radius);
    transition: background var(--component-syncd-transition-fast);
  }

  .syncd-list__item:hover { background: var(--component-syncd-surface); }

  .syncd-list__item > div,
  .syncd-request > div {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 2px;
  }

  .syncd-list__icon {
    flex: none;
    display: grid;
    place-items: center;
    color: var(--component-syncd-accent-fg);
  }

  .syncd-list__item strong,
  .syncd-request strong {
    overflow: hidden;
    color: var(--component-syncd-strong-fg);
    font-size: var(--text-sm);
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .syncd-list__item small,
  .syncd-request small {
    overflow: hidden;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
  }

  .syncd-list__item small { white-space: nowrap; }

  /* Statuses read as a coloured word. */
  .syncd-state {
    flex: none;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-xs);
    font-weight: 650;
    white-space: nowrap;
  }

  .syncd-state[data-tone="success"] { color: var(--component-syncd-good-fg); }
  .syncd-state[data-tone="info"] { color: var(--component-syncd-accent-fg); }
  .syncd-state[data-tone="danger"] { color: var(--component-syncd-bad-fg); }

  /* Live pairing: the QR on a light plate (scanners need the contrast), the codes beside it. */
  .syncd-pairing-live {
    display: grid;
    grid-template-columns: var(--component-syncd-qr-size) minmax(0, 1fr);
    align-items: center;
    gap: 22px;
  }

  .syncd-qr-surface {
    width: var(--component-syncd-qr-size);
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    padding: 10px;
    border-radius: var(--component-syncd-qr-radius);
    color: var(--component-syncd-accent-fg);
    background: var(--component-syncd-qr-bg);
    box-shadow: var(--component-syncd-qr-shadow);
  }

  .syncd-qr-image {
    width: 100%;
    height: auto;
    display: block;
    image-rendering: pixelated;
    animation: syncd-qr-in var(--component-syncd-transition-spring) both;
  }

  .syncd-pairing-live__copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .syncd-pairing-pin {
    color: var(--component-syncd-strong-fg);
    font-size: 34px;
    font-weight: 800;
    letter-spacing: 0.08em;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
  }

  .syncd-pin-hint,
  .syncd-pin-expiry small {
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .syncd-pin-expiry {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }

  .syncd-pin-expiry__bar {
    flex: 0 0 120px;
    height: 3px;
    overflow: hidden;
    border-radius: var(--component-syncd-pill-radius);
    background: var(--component-syncd-progress-track-bg);
  }

  .syncd-pin-expiry__bar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--component-syncd-accent-fg);
    transform-origin: left;
    transition: transform 1s linear;
  }

  .syncd-pairing-code {
    color: var(--component-syncd-body-fg);
    font-family: var(--font-mono, "Cascadia Mono", monospace);
    font-size: var(--text-lg);
    font-weight: 700;
    letter-spacing: 0.06em;
  }

  .syncd-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-top: 8px;
  }

  .syncd-actions .syncd-link:first-child { margin-left: -8px; }
  .syncd-actions .syncd-link + .syncd-link { margin-left: 0; }

  /* Approval: who asks, the code to compare, and what it may sync — split by hairlines. */
  .syncd-request {
    padding: 12px 0;
    border-top: 1px solid var(--component-syncd-divider);
    border-bottom: 1px solid var(--component-syncd-divider);
  }

  .syncd-verification {
    display: grid;
    gap: 4px;
  }

  .syncd-verification strong {
    color: var(--component-syncd-accent-fg);
    font-size: 30px;
    font-weight: 800;
    letter-spacing: 0.18em;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }

  .syncd-verification small {
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .syncd-scope-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .syncd-scope-list li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--component-syncd-body-fg);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .syncd-scope-list li :global(svg) { color: var(--component-syncd-good-fg); }

  /* Details: label and value rows between hairlines, scopes as switch rows. */
  .syncd-meta-list {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 14px 0;
    border-top: 1px solid var(--component-syncd-divider);
    border-bottom: 1px solid var(--component-syncd-divider);
  }

  .syncd-meta-list > div {
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }

  .syncd-meta-list dt {
    flex: none;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-sm);
  }

  .syncd-meta-list dd {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--component-syncd-body-fg);
    font-size: var(--text-sm);
    font-weight: 600;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .syncd-meta-list .is-mono {
    font-family: var(--font-mono, "Cascadia Mono", monospace);
    font-size: var(--text-xs);
  }

  .syncd-permissions {
    display: grid;
    gap: 4px;
  }

  .syncd-permission-device {
    display: grid;
    gap: 2px;
  }

  .syncd-replace-previous {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-syncd-control-gap);
    color: var(--component-syncd-strong-fg);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .syncd-permission-device label {
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-syncd-control-gap);
    margin: 0 -8px;
    padding: 6px 8px;
    border-radius: var(--component-syncd-row-radius);
    cursor: pointer;
    transition: background var(--component-syncd-transition-fast);
  }

  .syncd-permission-device label:hover { background: var(--component-syncd-surface); }

  .syncd-permission-device label strong {
    color: var(--component-syncd-strong-fg);
    font-size: var(--text-sm);
    font-weight: 650;
  }

  .syncd-switch {
    position: relative;
    width: 34px;
    height: 20px;
    flex: none;
    margin: 0;
    appearance: none;
    border-radius: var(--component-syncd-pill-radius);
    background: var(--component-syncd-surface-strong);
    cursor: pointer;
    transition: background var(--component-syncd-transition-normal);
  }

  .syncd-switch::before {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: var(--component-syncd-pill-radius);
    background: var(--component-syncd-muted-fg);
    transition: transform var(--component-syncd-transition-spring), background var(--component-syncd-transition-normal);
  }

  .syncd-switch:checked { background: var(--component-syncd-primary-bg); }
  .syncd-switch:checked::before { background: var(--component-syncd-primary-ink); transform: translateX(14px); }
  .syncd-switch:focus-visible { outline: 2px solid var(--component-syncd-focus-ring); outline-offset: 2px; }
  .syncd-switch:disabled { opacity: var(--component-syncd-disabled-opacity); cursor: not-allowed; }

  /* First-run embedding: plain status and error lines. */
  .syncd-inline-status,
  .syncd-inline-alert p {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--component-syncd-muted-fg);
    font-size: var(--text-sm);
  }

  .syncd-inline-alert {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--component-syncd-control-gap);
  }

  .syncd-inline-alert p :global(svg) { flex: none; color: var(--component-syncd-bad-fg); }

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

  :global(.syncd-spinner) {
    flex: none;
    animation: syncd-spin var(--component-syncd-spinner-animation) infinite;
  }

  /* Footer: quiet text buttons and one filled primary action. */
  .syncd-modal__footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--component-syncd-divider);
  }

  .syncd-spacer {
    flex: 1;
  }

  .syncd-btn {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--component-syncd-button-radius);
    color: var(--component-syncd-body-fg);
    background: transparent;
    font: inherit;
    font-size: var(--text-base);
    font-weight: 650;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--component-syncd-transition-fast), background var(--component-syncd-transition-fast), transform var(--component-syncd-transition-spring), filter var(--component-syncd-transition-fast);
  }

  .syncd-btn:hover:not(:disabled) { color: var(--component-syncd-strong-fg); background: var(--component-syncd-surface-strong); }
  .syncd-btn:active:not(:disabled) { transform: scale(0.96); }
  .syncd-btn:disabled { opacity: var(--component-syncd-disabled-opacity); cursor: not-allowed; }
  .syncd-btn:focus-visible,
  .syncd-link:focus-visible,
  .syncd-icon-btn:focus-visible,
  .syncd-tabs button:focus-visible,
  .syncd-disclosure > button:focus-visible { outline: 2px solid var(--component-syncd-focus-ring); outline-offset: 2px; }
  .syncd-btn--quiet { margin-left: -10px; padding: 0 10px; color: var(--component-syncd-muted-fg); font-size: var(--text-sm); }
  .syncd-btn--danger { color: var(--component-syncd-bad-fg); }
  .syncd-btn--danger:hover:not(:disabled) { color: var(--component-syncd-bad-fg); }
  .syncd-btn--primary { padding: 0 18px; color: var(--component-syncd-primary-ink); background: var(--component-syncd-primary-bg); font-weight: 700; }
  .syncd-btn--primary:hover:not(:disabled) { color: var(--component-syncd-primary-ink); background: var(--component-syncd-primary-bg); filter: var(--component-syncd-primary-hover-filter); }

  @keyframes syncd-spin {
    to { transform: rotate(360deg); }
  }

  @keyframes syncd-fade {
    from { opacity: 0; }
  }

  @keyframes syncd-rise {
    from { opacity: 0; transform: translateY(var(--component-syncd-modal-enter-offset)) scale(var(--component-syncd-modal-enter-scale)); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  @keyframes syncd-pane-in {
    from { opacity: 0; transform: translateY(6px); }
  }

  @keyframes syncd-qr-in {
    from { opacity: 0; transform: scale(0.94); }
  }

  @keyframes syncd-pulse {
    0%, 100% { box-shadow: 0 0 0 0 transparent; }
    40% { box-shadow: var(--component-syncd-pulse-ring); }
  }

  /* Reduced motion follows the app setting, then the system (motion.ts). */
  :global(html[data-epigraph-reduced-motion="true"]) .syncd-modal,
  :global(html[data-epigraph-reduced-motion="true"]) .syncd-modal-backdrop,
  :global(html[data-epigraph-reduced-motion="true"]) .syncd-pane,
  :global(html[data-epigraph-reduced-motion="true"]) .syncd-disclosure__body,
  :global(html[data-epigraph-reduced-motion="true"]) .syncd-qr-image,
  :global(html[data-epigraph-reduced-motion="true"]) .syncd-status-dot {
    animation: none;
  }

  @media (max-width: 620px) {
    .syncd-modal__header,
    .syncd-modal__body,
    .syncd-modal__footer {
      padding-left: 16px;
      padding-right: 16px;
    }

    .syncd-pairing-live { grid-template-columns: 1fr; }
  }
</style>
