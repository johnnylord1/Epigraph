<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import { _ } from "../../lib/i18n/runtime";
  import { onMount } from "svelte";
  import { ArrowsClockwise, CheckCircle, CircleNotch, Gear, Info, ShieldCheck, X } from "phosphor-svelte";
  import { addToast } from "../../store/state.svelte";
  import { buildSyncdQrDataUrl, decodeSyncdQrDataUrl, decodeSyncdQrFile } from "../../lib/syncdQr";
  import NocturneState from "../shared/NocturneState.svelte";
  import SyncdSessionDetails from "./SyncdSessionDetails.svelte";
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
    syncdGetSessionCatalog,
    syncdHostDecidePairing,
    syncdForgetPersistedSession,
    syncdListDiscoveryCandidates,
    syncdPauseReplication,
    syncdResumeReplication,
    syncdRevalidateSession,
    syncdRevalidatePersistedSyncSessions,
    syncdSetActiveReplicationSession,
    syncdStartHostPairing,
    type PairingHostDecision,
    type PersistedSyncSessionView,
    type SyncdConnectState,
    type SyncdDesktopConnectionStatus,
    type SyncdDesktopDiscoveryCandidate,
    type SyncdDesktopSnapshot,
    type SyncdHostPairingState,
    type SyncdReplicationSnapshot,
    type SyncdReconnectStatus,
  } from "../../lib/syncdDesktop";

  interface Props {
    profileId?: string | null;
    scopeLabel: string;
    onClose?: () => void;
  }

  let { profileId = null, scopeLabel, onClose = () => {} }: Props = $props();

  type SyncdModalView = "pairing" | "details" | "options";

  let host = $state<SyncdHostPairingState | null>(null);
  let connect = $state<SyncdConnectState | null>(null);
  let candidates = $state<SyncdDesktopDiscoveryCandidate[]>([]);
  let persistedSessions = $state<PersistedSyncSessionView[]>([]);
  let replicationSnapshot = $state<SyncdReplicationSnapshot | null>(null);
  let lastReconnectStatuses = $state<Record<string, SyncdReconnectStatus>>({});
  let loadingCandidates = $state(false);
  let loadingHost = $state(false);
  let loadingPersisted = $state(false);
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
  let panelError = $state<string | null>(null);
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
  let modalElement = $state<HTMLElement | null>(null);

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
    if (panelError) return { tone: "danger", label: translate("syncd_status_actionRequired"), title: translate("syncd_modal_syncNeedsAttention"), body: panelError };
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

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function showView(view: SyncdModalView) {
    modalView = view;
  }

  function closeModal() {
    onClose();
  }

  function handleModalKeydown(event: KeyboardEvent) {
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

  async function loadHostState() {
    try {
      host = mergeHostState(host, await syncdGetActiveHostPairing());
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    }
  }

  async function loadPersistedSessions() {
    if (!activeProfileId) {
      persistedSessions = [];
      replicationSnapshot = null;
      return;
    }
    loadingPersisted = true;
    try {
      const catalog = await syncdGetSessionCatalog(activeProfileId);
      persistedSessions = catalog.sessions ?? [];
      replicationSnapshot = catalog.replication ?? null;
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    } finally {
      loadingPersisted = false;
    }
  }

  async function refreshReplicationSnapshot() {
    if (!activeProfileId) {
      replicationSnapshot = null;
      return;
    }
    try {
      replicationSnapshot = await syncdGetReplicationState(activeProfileId);
    } catch {
      // The session catalog refresh owns user-visible errors. This lightweight
      // poll only keeps the compact replication badge from missing early events.
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
      panelError = error instanceof Error ? error.message : String(error);
      candidates = [];
    } finally {
      loadingCandidates = false;
    }
  }

  async function startHostPairing() {
    modalView = "pairing";
    if (!activeProfileId) {
      panelError = translate("syncd_error_hostProfileRequired");
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
      panelError = error instanceof Error ? error.message : String(error);
      hostStartStage = "error";
    } finally {
      loadingHost = false;
    }
  }

  async function connectToRemote() {
    modalView = "pairing";
    if (!activeProfileId) {
      panelError = translate("syncd_error_profileRequired");
      return;
    }
    const nextBootstrapBundle = currentBootstrapBundleValue().trim();
    const nextManualOrigin = currentManualOriginValue().trim();

    if (!nextBootstrapBundle) {
      panelError = translate("syncd_error_bundleRequired");
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
      panelError = error instanceof Error ? error.message : String(error);
    } finally {
      connectBusy = false;
    }
  }

  async function decideHostPairing(decision: PairingHostDecision) {
    if (!host) return;
    hostDecisionBusy = decision;
    panelError = null;
    try {
      host = mergeHostState(host, await syncdHostDecidePairing(host.sessionId, decision));
      addToast({
        kind: decision === "approve" ? "success" : "info",
        title: decision === "approve" ? translate("ui_syncPairingApproved") : translate("ui_syncPairingRejected"),
        body: decision === "approve"
          ? translate("ui_theRemoteDesktopCanNowRetrieveItsProfile")
          : translate("ui_theRemoteDesktopWasToldToStopBefore"),
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
    } finally {
      hostDecisionBusy = null;
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
      panelError = error instanceof Error ? error.message : translate("syncd_error_copyBundle");
    }
  }

  function saveBootstrapQrCode() {
    if (!qrCodeDataUrl || !host) return;
    const link = document.createElement("a");
    link.href = qrCodeDataUrl;
    link.download = `aethon-sync-bootstrap-${host.profileId}.png`;
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
      panelError = error instanceof Error ? error.message : translate("syncd_error_renderQr");
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
      panelError = error instanceof Error ? error.message : translate("syncd_error_decodeQr");
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
      panelError = error instanceof Error ? error.message : String(error);
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
      panelError = error instanceof Error ? error.message : String(error);
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
      panelError = error instanceof Error ? error.message : String(error);
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
      panelError = error instanceof Error ? error.message : String(error);
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
      panelError = error instanceof Error ? error.message : String(error);
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
      panelError = error instanceof Error ? error.message : String(error);
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
      panelError = error instanceof Error ? error.message : String(error);
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
      panelError = error instanceof Error ? error.message : String(error);
    } finally {
      forgetBusyKey = null;
    }
  }

  function applyDesktopSnapshot(snapshot: SyncdDesktopSnapshot) {
    host = mergeHostState(host, snapshot.host ?? null);
    connect = mergeConnectState(connect, snapshot.connect ?? null);
    void refreshHostQrCode(host);
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
    queueMicrotask(() => {
      modalElement?.focus();
    });

    void loadHostState();
    void refreshDiscoveryCandidates();
    if (activeProfileId) {
      void refreshPersistedSessions();
      void refreshReplicationSnapshot();
    }

    const replicationPoll = window.setInterval(() => {
      if (activeProfileId) {
        void refreshReplicationSnapshot();
      }
    }, 2000);

    const handleAutomationQrImport = (event: Event) => {
      const dataUrl = (event as CustomEvent<string>).detail;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
        void importQrDataUrl(dataUrl);
      }
    };
    window.addEventListener("aethon:syncd-import-qr-data-url", handleAutomationQrImport as EventListener);

    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listenSyncdDesktopState((payload) => {
        applyDesktopSnapshot(payload);
      }),
      listenSyncdPairingStatus((payload) => {
        if ("hostReady" in payload) {
          host = mergeHostState(host, payload);
        } else {
          connect = mergeConnectState(connect, payload);
        }
      }),
      listenSyncdReconnectStatus((payload) => {
        lastReconnectStatuses = {
          ...lastReconnectStatuses,
          [payload.sessionKey]: payload,
        };
        void refreshPersistedSessions();
      }),
      listenSyncdReplicationState((payload) => {
        if (activeProfileId && payload.localProfileId === activeProfileId) {
          replicationSnapshot = payload;
          void refreshPersistedSessions();
        }
      }),
    ])
      .then((listeners) => {
        unlisteners.push(...listeners);
        panelSubscriptionsReady = true;
      })
      .catch((error) => {
        panelError = error instanceof Error ? error.message : String(error);
      });

    return () => {
      window.removeEventListener("aethon:syncd-import-qr-data-url", handleAutomationQrImport as EventListener);
      window.clearInterval(replicationPoll);
      panelSubscriptionsReady = false;
      unlisteners.forEach((unlisten) => unlisten());
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
</script>

<div class="syncd-modal-backdrop" role="presentation" use:portal>
<div
  bind:this={modalElement}
  class="syncd-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="syncd-modal-title"
  tabindex="-1"
  onkeydown={handleModalKeydown}
>
  <div
    class="syncd-panel-grid"
    data-testid="syncd-panel-grid"
    data-panel-ready={panelSubscriptionsReady ? "ready" : "loading"}
  >
    <header class="syncd-modal__header">
      <div class="syncd-modal__heading">
        <span class="syncd-modal__heading-icon" aria-hidden="true"><ShieldCheck size={18} weight="duotone" /></span>
        <div>
          <p class="syncd-card__title">{$_("syncd_modal_secureSync")}</p>
          <h2 id="syncd-modal-title">{$_("settings_inline_desktopSyncPairing")}</h2>
          <p class="syncd-card__intro">{scopeLabel}</p>
        </div>
      </div>
      <button class="n-icon-btn syncd-modal__close" type="button" aria-label={$_("common_close")} onclick={closeModal}>
        <X size={16} weight="bold" />
      </button>
    </header>

    <div class="syncd-modal__body">
      <section class="syncd-view" hidden={modalView !== "pairing"} aria-hidden={modalView !== "pairing"} data-testid="syncd-pairing-view">
        <div class={`syncd-status syncd-status--${overviewStatus.tone}`} aria-live="polite">
          <div class="syncd-status__icon" aria-hidden="true">
            {#if operationBusy}
              <CircleNotch size={26} weight="bold" class="syncd-status__spinner" />
            {:else if overviewStatus.tone === "success"}
              <CheckCircle size={26} weight="duotone" />
            {:else}
              <ShieldCheck size={26} weight="duotone" />
            {/if}
          </div>
          <div class="syncd-status__copy">
            <div class="syncd-status__line">
              <p class="syncd-card__title">{$_("syncd_modal_liveStatus")}</p>
              <span class={`syncd-pill syncd-pill--${overviewStatus.tone}`}>{overviewStatus.label}</span>
            </div>
            <h3>{overviewStatus.title}</h3>
            <p>{overviewStatus.body}</p>
            <div class="syncd-progress" aria-hidden="true">
              <span class:syncd-progress__fill--busy={operationBusy} class:syncd-progress__fill--complete={overviewStatus.tone === "success"}></span>
            </div>
          </div>
        </div>

        <div class="syncd-card" data-testid="syncd-host-card">
          <div class="syncd-card__head">
            <div>
              <p class="syncd-card__title">{$_("syncd_modal_pairDesktop")}</p>
              <p class="syncd-card__intro">{$_("syncd_modal_createShortLivedQr")}</p>
            </div>
            <span class={"syncd-pill syncd-pill--" + connectStatusTone(host?.status ?? "pending")} data-testid="syncd-host-status">
              {host ? statusLabel(host.status) : statusLabel("idle")}
            </span>
          </div>

          <div class="syncd-row">
            <div>
              <p class="syncd-row__label">{$_("syncd_modal_currentDevice")}</p>
              <p class="syncd-row__hint">{scopeLabel}</p>
            </div>
            <button class="n-btn n-btn--sm n-btn-primary" type="button" data-testid="syncd-host-start" onclick={startHostPairing} disabled={!hasProfile() || loadingHost}>
              {loadingHost ? $_("syncd_action_preparing") : host ? $_("ui_refreshBundle") : $_("syncd_action_createPairingQr")}
            </button>
          </div>
          <p class="syncd-row__hint" data-testid="syncd-host-start-stage">{$_("ui_hostStartStage")} {hostStartStage}</p>

          {#if host}
            <div class="syncd-pairing-live">
              <div class="syncd-qr-surface" data-testid="syncd-host-qr-surface">
                {#if qrCodeDataUrl}
                  <img
                    class="syncd-qr-image"
                    data-testid="syncd-host-qr-image"
                    data-session-id={host.sessionId}
                    data-origin={host.advertisedBaseUrl}
                    src={qrCodeDataUrl}
                    alt={$_("ui_syncBootstrapQrCode")}
                  />
                {:else if qrBusy}
                  <CircleNotch size={28} weight="bold" class="syncd-status__spinner" />
                {:else}
                  <NocturneState layout="compact" tone="info" icon="info" eyebrow={$_("syncd_modal_pairing")} title={$_("ui_qrWaiting")} />
                {/if}
              </div>
              <div class="syncd-pairing-live__copy">
                <span class={"syncd-pill syncd-pill--" + connectStatusTone(host.status)} data-testid="syncd-host-status-live" data-status={host.status}>{statusLabel(host.status)}</span>
                <div>
                  <p class="syncd-row__label">{$_("ui_pairingCode")}</p>
                  <p class="syncd-pairing-code">{host.pairingCode}</p>
                </div>
                <p class="syncd-row__hint">{$_("ui_expires")} {formatWhen(host.expiresAtMs)}</p>
                <div class="syncd-actions">
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-host-copy-bundle" onclick={copyBootstrapBundle}>
                    {copiedBundle ? $_("massMigration_statusCopied") : $_("ui_copyBundle")}
                  </button>
                  <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-host-save-qr" onclick={saveBootstrapQrCode} disabled={!qrCodeDataUrl}>
                    {$_("ui_saveQrImage")}
                  </button>
                </div>
              </div>
            </div>
            {#if host.status === "claimed"}
              <div class="syncd-approval">
                <div>
                  <p class="syncd-row__label">{$_("syncd_modal_connectionRequest")}</p>
                  <p class="syncd-row__hint">{$_("syncd_modal_approveOnlyIfStarted")}</p>
                </div>
                <div class="syncd-actions">
                  <button class="n-btn n-btn--sm n-btn-primary" type="button" data-testid="syncd-host-approve" onclick={() => decideHostPairing("approve")} disabled={hostDecisionBusy !== null}>
                    {hostDecisionBusy === "approve" ? $_("syncd_action_approving") : $_("syncd_action_approve")}
                  </button>
                  <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" data-testid="syncd-host-reject" onclick={() => decideHostPairing("reject")} disabled={hostDecisionBusy !== null}>
                    {hostDecisionBusy === "reject" ? $_("syncd_action_rejecting") : $_("syncd_action_reject")}
                  </button>
                </div>
              </div>
            {/if}
            {#if host.error}
              <div data-testid="syncd-host-error">
                <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("syncd_modal_host")} title={$_("ui_hostPairingFailed")} body={host.error} />
              </div>
            {/if}
          {/if}
        </div>

        {#if connect}
          <div class="syncd-surface" data-testid="syncd-connect-state">
            <div class="syncd-row">
              <div>
                <p class="syncd-row__label">{$_("ui_currentConnection")}</p>
                <p class="syncd-row__hint">{connect.remoteOrigin}</p>
              </div>
              <span class={"syncd-pill syncd-pill--" + connectStatusTone(connect.status)} data-testid="syncd-connect-status" data-status={connect.status}>{statusLabel(connect.status)}</span>
            </div>
            {#if connect.error}
              <div data-testid="syncd-connect-error">
                <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("syncd_modal_connect")} title={$_("ui_pairingFailed")} body={connect.error} />
              </div>
            {/if}
          </div>
        {/if}

        <div class="syncd-surface syncd-replication-summary">
          <div class="syncd-row">
            <div>
              <p class="syncd-row__label">{$_("ui_replication")}</p>
              <p class="syncd-row__hint">{replicationSnapshot?.activeSessionKey ? $_("syncd_modal_trustedDesktopUpdates") : $_("syncd_modal_noActiveDesktop")}</p>
            </div>
            <span class={"syncd-pill syncd-pill--" + replicationStatusTone(replicationSnapshot?.replicationStatus ?? "idle")} data-testid="syncd-replication-status" data-status={replicationSnapshot?.replicationStatus ?? "idle"}>
              {statusLabel(replicationSnapshot?.replicationStatus ?? "idle")}
            </span>
          </div>
          <span class="syncd-hidden-value" data-testid="syncd-replication-active-session">{replicationSnapshot?.activeSessionKey ?? $_("ui_noneSelected")}</span>
          <div class="syncd-actions">
            <button
              class="n-btn n-btn--sm n-btn-ghost"
              type="button"
              data-testid="syncd-replication-toggle"
              onclick={replicationSnapshot?.paused ? resumeReplication : pauseReplication}
              disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}
            >
              {#if replicationActionBusy === "pause"}{$_("ui_pausing")}{:else if replicationActionBusy === "resume"}{$_("ui_resuming")}{:else}{replicationSnapshot?.paused ? $_("ui_resumeReplication") : $_("ui_pauseReplication")}{/if}
            </button>
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-replication-reconnect" onclick={reconnectReplication} disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}>
              {replicationActionBusy === "reconnect" ? $_("syncd_action_reconnecting") : $_("ui_reconnectNow")}
            </button>
          </div>
        </div>

        {#if panelError}
          <div data-testid="syncd-panel-error">
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("syncd_modal_sync")} title={$_("ui_syncActionFailed")} body={panelError} />
          </div>
        {/if}
      </section>

      <section class="syncd-view" hidden={modalView !== "details"} aria-hidden={modalView !== "details"} data-testid="syncd-details-view">
        <div class="syncd-view__intro">
          <Info size={18} weight="duotone" />
          <div>
            <h3>{$_("syncd_modal_connectionDetails")}</h3>
            <p>{$_("syncd_modal_connectionDetailsHint")}</p>
          </div>
        </div>

        {#if host}
          <div class="syncd-surface">
            <div class="syncd-row">
              <p class="syncd-row__label">{$_("syncd_modal_hostSession")}</p>
              <span class={"syncd-pill syncd-pill--" + connectStatusTone(host.status)}>{statusLabel(host.status)}</span>
            </div>
            <div class="syncd-meta-grid">
              <div><span class="syncd-meta__label">{$_("ui_advertisedOrigin")}</span><span class="syncd-meta__value">{host.advertisedBaseUrl}</span></div>
              <div><span class="syncd-meta__label">{$_("ui_claimedDevice")}</span><span class="syncd-meta__value">{host.claimedDeviceId ?? $_("syncd_status_waiting")}</span></div>
              <div><span class="syncd-meta__label">{$_("ui_expires")}</span><span class="syncd-meta__value">{formatWhen(host.expiresAtMs)}</span></div>
              <div><span class="syncd-meta__label">{$_("ui_tlsFingerprint")}</span><span class="syncd-meta__value syncd-meta__value--mono">{host.tlsCertSha256}</span></div>
            </div>
            <label class="syncd-field">
              <span class="syncd-row__label">{$_("ui_bootstrapBundle")}</span>
              <textarea class="syncd-textarea" data-testid="syncd-bootstrap-bundle-host" readonly value={host.bootstrapBundle}></textarea>
            </label>
          </div>
        {/if}

        {#if connect}
          <div class="syncd-surface">
            <div class="syncd-row"><p class="syncd-row__label">{$_("syncd_modal_connectionAttempt")}</p><span class={"syncd-pill syncd-pill--" + connectStatusTone(connect.status)}>{statusLabel(connect.status)}</span></div>
            <div class="syncd-meta-grid">
              <div><span class="syncd-meta__label">{$_("ui_attemptedOrigin")}</span><span class="syncd-meta__value">{connect.attemptedOrigin}</span></div>
              <div><span class="syncd-meta__label">{$_("ui_remoteProfile")}</span><span class="syncd-meta__value">{connect.remoteProfileId || $_("syncd_status_waiting")}</span></div>
              <div><span class="syncd-meta__label">{$_("ui_fallbacks")}</span><span class="syncd-meta__value">{connect.fallbackOrigins.length}</span></div>
              <div><span class="syncd-meta__label">{$_("ui_claimedDevice")}</span><span class="syncd-meta__value">{connect.claimedDeviceId ?? $_("syncd_status_waiting")}</span></div>
            </div>
          </div>
        {/if}

        <div class="syncd-surface">
          <div class="syncd-row"><p class="syncd-row__label">{$_("syncd_modal_replicationDiagnostics")}</p><span class={"syncd-pill syncd-pill--" + replicationStatusTone(replicationSnapshot?.replicationStatus ?? "idle")}>{statusLabel(replicationSnapshot?.replicationStatus ?? "idle")}</span></div>
          <div class="syncd-meta-grid">
            <div><span class="syncd-meta__label">{$_("ui_activeSession")}</span><span class="syncd-meta__value">{replicationSnapshot?.activeSessionKey ?? $_("ui_noneSelected")}</span></div>
            <div><span class="syncd-meta__label">{$_("ui_lastConnected")}</span><span class="syncd-meta__value">{formatWhen(replicationSnapshot?.lastConnectedAtMs)}</span></div>
            <div><span class="syncd-meta__label">{$_("ui_booksCheckpoint")}</span><span class="syncd-meta__value">{replicationSnapshot?.booksScopeCheckpoint?.lastAppliedServerVersion ?? 0}</span></div>
            <div><span class="syncd-meta__label">{$_("ui_novelsCheckpoint")}</span><span class="syncd-meta__value">{replicationSnapshot?.novelsScopeCheckpoint?.lastAppliedServerVersion ?? 0}</span></div>
          </div>
          {#if replicationSnapshot?.lastError}
            <NocturneState layout="compact" tone="danger" icon="warning" eyebrow={$_("ui_replication")} title={$_("ui_syncReplayFailed")} body={replicationSnapshot.lastError} />
          {/if}
        </div>

        <div class="syncd-surface">
          <div class="syncd-row">
            <div><p class="syncd-row__label">{$_("ui_sessions")}</p><p class="syncd-row__hint">{$_("syncd_modal_trustedDesktopsStored")}</p></div>
            <span class="syncd-pill syncd-pill--neutral">{loadingPersisted ? "..." : persistedSessions.length}</span>
          </div>
          {#if persistedSessions.length > 0}
            <div class="syncd-list" data-testid="syncd-persisted-sessions">
              {#each persistedSessions as session}
                <div
                  class="syncd-list__item"
                  data-testid="syncd-persisted-session-item"
                  data-session-key={session.sessionKey}
                  data-connection-status={effectiveSessionConnectionStatus(session)}
                >
                  <SyncdSessionDetails
                    session={session}
                    summary={sessionStatusSummary(session)}
                    statusLabel={statusLabel(effectiveSessionConnectionStatus(session))}
                    statusTone={connectStatusTone(effectiveSessionConnectionStatus(session))}
                    lastValidatedLabel={lastReconnectStatuses[session.sessionKey] ? $_("syncd_status_justRevalidated") : formatWhen(session.lastValidatedAtMs)}
                    replicationLabel={statusLabel((session.isActiveForSync ? replicationSnapshot?.replicationStatus : session.replicationStatus) ?? "idle")}
                    reconnectError={lastReconnectStatuses[session.sessionKey]?.error ?? null}
                    isReplicationPaused={replicationSnapshot?.paused ?? false}
                    setActiveBusy={activeSessionBusyKey === session.sessionKey}
                    revalidateBusy={singleRevalidateBusyKey === session.sessionKey}
                    pauseResumeBusy={replicationActionBusy !== null}
                    disconnectBusy={disconnectBusyKey === session.sessionKey}
                    forgetBusy={forgetBusyKey === session.sessionKey}
                    onSetActive={() => setActiveSession(session.sessionKey)}
                    onRevalidate={() => revalidateSessionEntry(session.sessionKey)}
                    onPauseResume={session.isActiveForSync ? (replicationSnapshot?.paused ? resumeReplication : pauseReplication) : undefined}
                    onDisconnect={() => disconnectSession(session.sessionKey)}
                    onForget={() => forgetSession(session.sessionKey)}
                  />
                </div>
              {/each}
            </div>
          {:else}
            <NocturneState layout="compact" tone="info" icon="info" eyebrow={$_("ui_sessions")} title={$_("ui_noApprovedSessions")} body={$_("syncd_modal_pairToStartContinuousSync")} />
          {/if}
        </div>
      </section>

      <section class="syncd-view" hidden={modalView !== "options"} aria-hidden={modalView !== "options"} data-testid="syncd-options-view">
        <div class="syncd-view__intro">
          <Gear size={18} weight="duotone" />
          <div><h3>{$_("syncd_modal_pairingOptions")}</h3><p>{$_("syncd_modal_pairingOptionsHint")}</p></div>
        </div>

        <div class="syncd-card" data-testid="syncd-connect-card">
          <div class="syncd-card__head">
            <div><p class="syncd-card__title">{$_("ui_syncConnect")}</p><p class="syncd-card__intro">{$_("syncd_modal_useHostPairingPackage")}</p></div>
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-connect-refresh-peers" onclick={refreshDiscoveryCandidates} disabled={loadingCandidates}>
              <ArrowsClockwise size={14} weight="bold" /> {loadingCandidates ? $_("common_refreshing") : $_("ui_refreshPeers")}
            </button>
          </div>

          <div class="syncd-stack">
            <div class="syncd-surface">
              <div class="syncd-row"><div><p class="syncd-row__label">{$_("ui_discoveredPeers")}</p><p class="syncd-row__hint">{$_("syncd_modal_nearbyDesktops")}</p></div><span class="syncd-pill syncd-pill--neutral">{candidates.length}</span></div>
              {#if candidates.length > 0}
                <div class="syncd-list" data-testid="syncd-discovered-peers">
                  {#each candidates as candidate}
                    <div class="syncd-list__item" data-testid="syncd-peer-item">
                      <div class="syncd-list__body"><p class="syncd-list__title">{candidate.instanceName}</p><p class="syncd-list__hint">{candidate.effectiveOrigin}</p><p class="syncd-list__meta">{sourceLabel(candidate.effectiveSource)}</p></div>
                      <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-peer-use-origin" onclick={() => (manualOrigin = candidate.discoveryOrigin)}>{$_("ui_useOrigin")}</button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <label class="syncd-field"><span class="syncd-row__label">{$_("ui_manualOriginFallback")}</span><input bind:this={manualOriginInput} class="syncd-input" data-testid="syncd-manual-origin" bind:value={manualOrigin} placeholder={$_("ui_https1921681254777")} spellcheck="false" /></label>
            <label class="syncd-field"><span class="syncd-row__label">{$_("ui_bootstrapBundle")}</span><textarea bind:this={bootstrapBundleTextarea} class="syncd-textarea" data-testid="syncd-bootstrap-bundle-input" bind:value={bootstrapBundleInput} placeholder={$_("ui_pasteTheHostBundleJsonHere")}></textarea></label>
            <input bind:this={qrFileInput} class="syncd-hidden-input" data-testid="syncd-qr-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleQrFilePicked} />
            <div class="syncd-actions">
              <button class="n-btn n-btn--sm n-btn-primary" type="button" data-testid="syncd-connect-submit" onclick={connectToRemote} disabled={!hasProfile() || connectBusy || !bootstrapBundleInput.trim()}>{connectBusy ? $_("settings_inline_connecting") : $_("ui_connectToHost")}</button>
              <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-connect-load-qr" onclick={openQrImagePicker} disabled={qrDecodeBusy}>{qrDecodeBusy ? $_("ui_readingQr") : $_("ui_loadQrImage")}</button>
              <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-revalidate-sessions" onclick={revalidatePersisted} disabled={!hasProfile() || revalidateBusy}>{revalidateBusy ? $_("syncd_action_revalidating") : $_("ui_revalidateSavedSessions")}</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <footer class="syncd-modal__footer">
      <div class="syncd-modal__views" aria-label={$_("syncd_modal_viewsLabel")}>
        <button class="n-btn n-btn--sm n-btn-ghost" class:is-active={modalView === "pairing"} type="button" data-testid="syncd-modal-pairing" aria-pressed={modalView === "pairing"} onclick={() => showView("pairing")}><ShieldCheck size={14} weight="duotone" /> {$_("syncd_modal_pairing")}</button>
        <button class="n-btn n-btn--sm n-btn-ghost" class:is-active={modalView === "details"} type="button" data-testid="syncd-modal-details" aria-pressed={modalView === "details"} onclick={() => showView("details")}><Info size={14} weight="duotone" /> {$_("syncd_modal_details")}</button>
        <button class="n-btn n-btn--sm n-btn-ghost" class:is-active={modalView === "options"} type="button" data-testid="syncd-modal-options" aria-pressed={modalView === "options"} onclick={() => showView("options")}><Gear size={14} weight="duotone" /> {$_("syncd_modal_options")}</button>
      </div>
      <button class="n-btn n-btn--sm" type="button" onclick={closeModal}>{$_("common_close")}</button>
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
    font-family: var(--font-ui);
    letter-spacing: 0;
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
    text-transform: uppercase;
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
</style>
