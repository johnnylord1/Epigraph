<script lang="ts">
  import { onMount } from "svelte";
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
  }

  let { profileId = null, scopeLabel }: Props = $props();

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

  const activeProfileId = $derived.by(
    () => (typeof profileId === "string" && profileId.trim().length > 0 ? profileId : null),
  );

  function hasProfile(): boolean {
    return activeProfileId !== null;
  }

  function statusLabel(status: string): string {
    return status
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function formatWhen(value?: number | null): string {
    if (!value) return "Never";
    return new Date(value).toLocaleString();
  }

  function sourceLabel(value: string): string {
    return value
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  function effectiveSessionConnectionStatus(session: PersistedSyncSessionView): string {
    return lastReconnectStatuses[session.sessionKey]?.status ?? session.lastKnownStatus;
  }

  function sessionStatusSummary(session: PersistedSyncSessionView): string {
    const parts = [
      sourceLabel(session.lastDiscoverySource),
      statusLabel(effectiveSessionConnectionStatus(session)),
    ];
    if (session.replicationStatus) {
      parts.push(`Replication ${statusLabel(session.replicationStatus)}`);
    }
    return parts.join(" | ");
  }

  function connectStatusTone(status: SyncdDesktopConnectionStatus | SyncdHostPairingState["status"]): string {
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
    if (!activeProfileId) {
      panelError = "A local profile must be active before hosting sync pairing.";
      hostStartStage = "error";
      return;
    }
    loadingHost = true;
    hostStartStage = "requesting";
    panelError = null;
    try {
      host = mergeHostState(host, await syncdStartHostPairing(activeProfileId));
      hostStartStage = "bootstrap_ready";
      bootstrapBundleInput = host.bootstrapBundle;
      qrCodeDataUrl = await buildSyncdQrDataUrl(host.bootstrapBundle);
      hostStartStage = "complete";
      copiedBundle = false;
      addToast({
        kind: "success",
        title: "Sync host is ready",
        body: "The bootstrap bundle and QR payload are live and waiting for a second desktop to claim them.",
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : String(error);
      hostStartStage = "error";
    } finally {
      loadingHost = false;
    }
  }

  async function connectToRemote() {
    if (!activeProfileId) {
      panelError = "A local profile must be active before connecting to another desktop.";
      return;
    }
    const nextBootstrapBundle = currentBootstrapBundleValue().trim();
    const nextManualOrigin = currentManualOriginValue().trim();

    if (!nextBootstrapBundle) {
      panelError = "Paste a bootstrap bundle from the host desktop before connecting.";
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
        title: "Sync pairing started",
        body: "Waiting for the host desktop to approve or reject this connection.",
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
        title: decision === "approve" ? "Sync pairing approved" : "Sync pairing rejected",
        body: decision === "approve"
          ? "The remote desktop can now retrieve its profile-bound session."
          : "The remote desktop was told to stop before any token was issued.",
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
        title: "Bootstrap bundle copied",
        body: "Paste it into the second desktop to finish the pairing proof.",
      });
      setTimeout(() => {
        copiedBundle = false;
      }, 2000);
    } catch (error) {
      panelError = error instanceof Error ? error.message : "Could not copy the bootstrap bundle.";
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
      panelError = error instanceof Error ? error.message : "Could not render the sync QR code.";
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
        title: "Sync QR loaded",
        body: "The bootstrap bundle was filled from the QR image and is ready to connect.",
      });
    } catch (error) {
      panelError = error instanceof Error ? error.message : "Could not decode the selected sync QR image.";
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
        title: "Sync session removed",
        body: "The local desktop forgot the approved sync session.",
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
        title: "Active sync session updated",
        body: "Replication will now follow the selected desktop session.",
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
        title: "Sync session forgotten",
        body: "The local catalog no longer keeps that inactive desktop session.",
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

<div
  class="syncd-panel-grid"
  data-testid="syncd-panel-grid"
  data-panel-ready={panelSubscriptionsReady ? "ready" : "loading"}
>
  <div class="syncd-card" data-testid="syncd-host-card">
    <div class="syncd-card__head">
      <div>
        <p class="syncd-card__title">Sync host</p>
        <p class="syncd-card__intro">Create one short-lived bootstrap bundle for the current desktop profile and approve or reject the claim locally.</p>
      </div>
      <span class={"syncd-pill syncd-pill--" + connectStatusTone(host?.status ?? "pending")} data-testid="syncd-host-status">
        {host ? statusLabel(host.status) : "Idle"}
      </span>
    </div>

    <div class="syncd-stack">
      <div class="syncd-row">
        <div>
          <p class="syncd-row__label">Scope</p>
          <p class="syncd-row__hint">{scopeLabel}</p>
        </div>
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-host-start" onclick={startHostPairing} disabled={!hasProfile() || loadingHost}>
          {loadingHost ? "Starting..." : host ? "Refresh bundle" : "Start host pairing"}
        </button>
      </div>
      <p class="syncd-row__hint" data-testid="syncd-host-start-stage">Host start stage: {hostStartStage}</p>

      {#if host}
        <div class="syncd-surface">
          <div class="syncd-row">
            <div>
              <p class="syncd-row__label">Advertised origin</p>
              <p class="syncd-row__hint">{host.advertisedBaseUrl}</p>
            </div>
            <span class={"syncd-pill syncd-pill--" + connectStatusTone(host.status)} data-testid="syncd-host-status-live">{statusLabel(host.status)}</span>
          </div>
          <div class="syncd-meta-grid">
            <div>
              <span class="syncd-meta__label">Pairing code</span>
              <span class="syncd-meta__value">{host.pairingCode}</span>
            </div>
            <div>
              <span class="syncd-meta__label">Expires</span>
              <span class="syncd-meta__value">{formatWhen(host.expiresAtMs)}</span>
            </div>
            <div>
              <span class="syncd-meta__label">TLS fingerprint</span>
              <span class="syncd-meta__value syncd-meta__value--mono">{host.tlsCertSha256}</span>
            </div>
            <div>
              <span class="syncd-meta__label">Claimed device</span>
              <span class="syncd-meta__value">{host.claimedDeviceId ?? "Waiting"}</span>
            </div>
          </div>
          <label class="syncd-field">
            <span class="syncd-row__label">Bootstrap bundle</span>
            <textarea class="syncd-textarea" data-testid="syncd-bootstrap-bundle-host" readonly value={host.bootstrapBundle}></textarea>
          </label>
          <div class="syncd-field">
            <span class="syncd-row__label">Bootstrap QR</span>
            <div class="syncd-qr-surface" data-testid="syncd-host-qr-surface">
              {#if qrCodeDataUrl}
                <img
                  class="syncd-qr-image"
                  data-testid="syncd-host-qr-image"
                  data-session-id={host.sessionId}
                  data-origin={host.advertisedBaseUrl}
                  src={qrCodeDataUrl}
                  alt="Sync bootstrap QR code"
                />
              {:else if qrBusy}
                <NocturneState layout="compact" tone="info" icon="retry" eyebrow="Pairing" title="Rendering QR" />
              {:else}
                <NocturneState layout="compact" tone="info" icon="info" eyebrow="Pairing" title="QR waiting" body="The QR payload will appear here once the host bundle is ready." />
              {/if}
            </div>
          </div>
          <div class="syncd-actions">
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-host-copy-bundle" onclick={copyBootstrapBundle}>
              {copiedBundle ? "Copied" : "Copy bundle"}
            </button>
            <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-host-save-qr" onclick={saveBootstrapQrCode} disabled={!qrCodeDataUrl}>
              Save QR image
            </button>
            {#if host.status === "claimed"}
              <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-host-approve" onclick={() => decideHostPairing("approve")} disabled={hostDecisionBusy !== null}>
                {hostDecisionBusy === "approve" ? "Approving..." : "Approve"}
              </button>
              <button class="n-btn n-btn--sm n-btn-ghost n-btn-danger" type="button" data-testid="syncd-host-reject" onclick={() => decideHostPairing("reject")} disabled={hostDecisionBusy !== null}>
                {hostDecisionBusy === "reject" ? "Rejecting..." : "Reject"}
              </button>
            {/if}
          </div>
          {#if host.error}
            <div data-testid="syncd-host-error">
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Host" title="Host pairing failed" body={host.error} />
            </div>
          {/if}
        </div>
      {:else}
        <NocturneState layout="compact" tone="info" icon="info" eyebrow="Host" title="Host mode is idle" body="Start one pairing session to generate a bundle and wait for the second desktop to claim it." />
      {/if}
    </div>
  </div>

  <div class="syncd-card" data-testid="syncd-connect-card">
    <div class="syncd-card__head">
      <div>
        <p class="syncd-card__title">Sync connect</p>
        <p class="syncd-card__intro">Discover a remote desktop, paste its bootstrap bundle, and let the existing live pairing channel carry approval or rejection.</p>
      </div>
      <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-connect-refresh-peers" onclick={refreshDiscoveryCandidates} disabled={loadingCandidates}>
        {loadingCandidates ? "Refreshing..." : "Refresh peers"}
      </button>
    </div>

    <div class="syncd-stack">
      <div class="syncd-surface">
        <div class="syncd-row">
          <div>
            <p class="syncd-row__label">Discovered peers</p>
            <p class="syncd-row__hint">mDNS candidates already resolve through the syncd client-contract and guidance layers.</p>
          </div>
          <span class="syncd-pill syncd-pill--neutral">{candidates.length}</span>
        </div>
        {#if candidates.length > 0}
          <div class="syncd-list" data-testid="syncd-discovered-peers">
            {#each candidates as candidate}
              <div class="syncd-list__item" data-testid="syncd-peer-item">
                <div class="syncd-list__body">
                  <p class="syncd-list__title">{candidate.instanceName}</p>
                  <p class="syncd-list__hint">{candidate.effectiveOrigin}</p>
                  <p class="syncd-list__meta">{sourceLabel(candidate.effectiveSource)} | live pairing {candidate.supportsLivePairingStatus ? "on" : "off"}</p>
                </div>
                <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-peer-use-origin" onclick={() => (manualOrigin = candidate.discoveryOrigin)}>
                  Use origin
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <NocturneState layout="compact" tone="info" icon="search" eyebrow="Discovery" title="No LAN peers visible" body="Manual origin fallback is ready below." />
        {/if}
      </div>

      <label class="syncd-field">
        <span class="syncd-row__label">Manual origin fallback</span>
        <input
          bind:this={manualOriginInput}
          class="syncd-input"
          data-testid="syncd-manual-origin"
          bind:value={manualOrigin}
          placeholder="https://192.168.1.25:4777"
          spellcheck="false"
        />
      </label>

      <label class="syncd-field">
        <span class="syncd-row__label">Bootstrap bundle</span>
        <textarea
          bind:this={bootstrapBundleTextarea}
          class="syncd-textarea"
          data-testid="syncd-bootstrap-bundle-input"
          bind:value={bootstrapBundleInput}
          placeholder='Paste the host bundle JSON here.'
        ></textarea>
      </label>
      <input
        bind:this={qrFileInput}
        class="syncd-hidden-input"
        data-testid="syncd-qr-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onchange={handleQrFilePicked}
      />

      <div class="syncd-actions">
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-connect-submit" onclick={connectToRemote} disabled={!hasProfile() || connectBusy || !bootstrapBundleInput.trim()}>
          {connectBusy ? "Connecting..." : "Connect to host"}
        </button>
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-connect-load-qr" onclick={openQrImagePicker} disabled={qrDecodeBusy}>
          {qrDecodeBusy ? "Reading QR..." : "Load QR image"}
        </button>
        <button class="n-btn n-btn--sm n-btn-ghost" type="button" data-testid="syncd-revalidate-sessions" onclick={revalidatePersisted} disabled={!hasProfile() || revalidateBusy}>
          {revalidateBusy ? "Revalidating..." : "Revalidate saved sessions"}
        </button>
      </div>

      {#if connect}
        <div class="syncd-surface" data-testid="syncd-connect-state">
          <div class="syncd-row">
            <div>
              <p class="syncd-row__label">Current connection</p>
              <p class="syncd-row__hint">{connect.remoteOrigin}</p>
            </div>
            <span class={"syncd-pill syncd-pill--" + connectStatusTone(connect.status)} data-testid="syncd-connect-status">{statusLabel(connect.status)}</span>
          </div>
          <div class="syncd-meta-grid">
            <div>
              <span class="syncd-meta__label">Attempted origin</span>
              <span class="syncd-meta__value">{connect.attemptedOrigin}</span>
            </div>
            <div>
              <span class="syncd-meta__label">Remote profile</span>
              <span class="syncd-meta__value">{connect.remoteProfileId || "Waiting"}</span>
            </div>
            <div>
              <span class="syncd-meta__label">Fallbacks</span>
              <span class="syncd-meta__value">{connect.fallbackOrigins.length}</span>
            </div>
            <div>
              <span class="syncd-meta__label">Claimed device</span>
              <span class="syncd-meta__value">{connect.claimedDeviceId ?? "Waiting"}</span>
            </div>
          </div>
          {#if connect.error}
            <div data-testid="syncd-connect-error">
              <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Connect" title="Pairing failed" body={connect.error} />
            </div>
          {/if}
        </div>
      {/if}

      <div class="syncd-surface">
        <div class="syncd-row">
          <div>
            <p class="syncd-row__label">Replication</p>
            <p class="syncd-row__hint">One approved session can stay active for continuous replay, local mutation upload, and reconnect.</p>
          </div>
          <span class={"syncd-pill syncd-pill--" + replicationStatusTone(replicationSnapshot?.replicationStatus ?? "idle")} data-testid="syncd-replication-status">
            {statusLabel(replicationSnapshot?.replicationStatus ?? "idle")}
          </span>
        </div>
        <div class="syncd-meta-grid">
          <div>
            <span class="syncd-meta__label">Active session</span>
                <span class="syncd-meta__value" data-testid="syncd-replication-active-session">{replicationSnapshot?.activeSessionKey ?? "None selected"}</span>
          </div>
          <div>
            <span class="syncd-meta__label">Last connected</span>
            <span class="syncd-meta__value">{formatWhen(replicationSnapshot?.lastConnectedAtMs)}</span>
          </div>
          <div>
            <span class="syncd-meta__label">Books checkpoint</span>
            <span class="syncd-meta__value">{replicationSnapshot?.booksScopeCheckpoint?.lastAppliedServerVersion ?? 0}</span>
          </div>
          <div>
            <span class="syncd-meta__label">Novels checkpoint</span>
            <span class="syncd-meta__value">{replicationSnapshot?.novelsScopeCheckpoint?.lastAppliedServerVersion ?? 0}</span>
          </div>
        </div>
        {#if replicationSnapshot?.lastError}
          <NocturneState layout="compact" tone="danger" icon="warning" eyebrow="Replication" title="Sync replay failed" body={replicationSnapshot.lastError} />
        {/if}
        <div class="syncd-actions">
          <button
            class="n-btn n-btn--sm n-btn-ghost"
            type="button"
            data-testid="syncd-replication-toggle"
            onclick={replicationSnapshot?.paused ? resumeReplication : pauseReplication}
            disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}
          >
            {#if replicationActionBusy === "pause"}Pausing...{:else if replicationActionBusy === "resume"}Resuming...{:else}{replicationSnapshot?.paused ? "Resume replication" : "Pause replication"}{/if}
          </button>
          <button
            class="n-btn n-btn--sm n-btn-ghost"
            type="button"
            data-testid="syncd-replication-reconnect"
            onclick={reconnectReplication}
            disabled={!replicationSnapshot?.activeSessionKey || replicationActionBusy !== null}
          >
            {replicationActionBusy === "reconnect" ? "Reconnecting..." : "Reconnect now"}
          </button>
        </div>
      </div>

      <div class="syncd-surface">
        <div class="syncd-row">
          <div>
            <p class="syncd-row__label">Sessions</p>
            <p class="syncd-row__hint">Approved profile-bound tokens stay local and one session at a time can own continuous replication.</p>
          </div>
          <span class="syncd-pill syncd-pill--neutral">{loadingPersisted ? "..." : persistedSessions.length}</span>
        </div>
        {#if persistedSessions.length > 0}
          <div class="syncd-list" data-testid="syncd-persisted-sessions">
            {#each persistedSessions as session}
              <div class="syncd-list__item" data-testid="syncd-persisted-session-item" data-session-key={session.sessionKey}>
                <SyncdSessionDetails
                  session={session}
                  summary={sessionStatusSummary(session)}
                  statusLabel={statusLabel(effectiveSessionConnectionStatus(session))}
                  statusTone={connectStatusTone(effectiveSessionConnectionStatus(session))}
                  lastValidatedLabel={lastReconnectStatuses[session.sessionKey] ? "Just revalidated" : formatWhen(session.lastValidatedAtMs)}
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
          <NocturneState layout="compact" tone="info" icon="info" eyebrow="Sessions" title="No approved sessions" body="Pair another desktop to start continuous sync for this profile." />
        {/if}
      </div>
    </div>

    {#if panelError}
      <NocturneState
        layout="compact"
        tone="danger"
        icon="warning"
        eyebrow="Sync"
        title="Sync action failed"
        body={panelError}
      />
    {/if}
  </div>
</div>

<style>
  .syncd-panel-grid {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
  }

  .syncd-card {
    border: 1px solid rgba(72, 69, 79, 0.14);
    border-radius: 18px;
    background: rgba(28, 27, 27, 0.6);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .syncd-card__head,
  .syncd-row,
  .syncd-list__item,
  .syncd-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .syncd-card__title,
  .syncd-row__label,
  .syncd-list__title,
  .syncd-meta__label {
    margin: 0;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: rgba(202, 196, 208, 0.42);
  }

  .syncd-card__intro,
  .syncd-row__hint,
  .syncd-list__hint,
  .syncd-list__meta,
  .syncd-meta__value {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: rgba(202, 196, 208, 0.48);
  }

  .syncd-stack,
  .syncd-field {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .syncd-actions {
    flex-wrap: wrap;
  }

  .syncd-actions--stack {
    align-items: stretch;
    justify-content: flex-start;
  }

  .syncd-surface {
    border: 1px solid rgba(72, 69, 79, 0.12);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.02);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  .syncd-meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
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
    border-radius: 14px;
    border: 1px solid rgba(72, 69, 79, 0.16);
    background: rgba(21, 21, 25, 0.72);
    color: var(--n-on-surface);
    padding: 10px 12px;
    font-size: 12px;
    font-weight: 600;
  }

  .syncd-textarea {
    min-height: 110px;
    resize: vertical;
  }

  .syncd-input:focus,
  .syncd-textarea:focus {
    outline: none;
    border-color: rgba(184, 167, 234, 0.22);
    background: rgba(28, 27, 27, 0.82);
  }

  .syncd-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .syncd-qr-surface {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 164px;
    border: 1px dashed rgba(202, 196, 208, 0.16);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.02);
    padding: 12px;
  }

  .syncd-qr-image {
    width: min(100%, 220px);
    height: auto;
    display: block;
  }

  .syncd-list__item {
    align-items: flex-start;
    border: 1px solid rgba(72, 69, 79, 0.12);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.02);
    padding: 10px 12px;
  }

  .syncd-list__body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .syncd-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: 999px;
    padding: 4px 10px;
    border: 1px solid rgba(72, 69, 79, 0.16);
    background: rgba(255, 255, 255, 0.02);
    color: rgba(202, 196, 208, 0.56);
    font-size: 11px;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .syncd-pill--success {
    border-color: color-mix(in srgb, var(--color-success) 55%, var(--border-base));
    color: var(--color-success);
  }

  .syncd-pill--info {
    border-color: color-mix(in srgb, var(--color-info) 55%, var(--border-base));
    color: var(--color-info);
  }

  .syncd-pill--danger {
    border-color: color-mix(in srgb, var(--color-error) 55%, var(--border-base));
    color: var(--color-error);
  }

  .syncd-hidden-input {
    display: none;
  }

  @media (max-width: 880px) {
    .syncd-panel-grid {
      grid-template-columns: 1fr;
    }

    .syncd-card__head,
    .syncd-row,
    .syncd-list__item,
    .syncd-actions {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
