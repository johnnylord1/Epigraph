<script lang="ts">
  import { onMount, tick, type Component } from "svelte";
  import { ArrowLeft, ArrowRight, ArrowsClockwise, BookOpenText, Books, CaretRight, Check, Desktop, DeviceMobile, Key, Laptop, WifiHigh, WarningCircle, X } from "phosphor-svelte";
  import { _ } from "../../lib/i18n/runtime";
  import { arrive, enterElements, findByData, motionFade, motionFly, pulse, prefersReducedMotion, spring } from "../../lib/motion/firstRunMotion";
  import { firstRunSyncReadinessKey, refreshFirstRunSyncLibrary } from "../../lib/setup/firstRunSyncReadiness";
  import {
    listenSyncdPairingStatus,
    listenSyncdReplicationState,
    syncdConnectWithBootstrap,
    syncdGetReplicationState,
    syncdGetSyncProgressIfRunning,
    syncdListDiscoveryCandidates,
    syncdListPairedDevicesIfRunning,
    syncdResolvePairingPin,
    type SyncdConnectState,
    type SyncdDesktopDiscoveryCandidate,
    type SyncdHostPairingState,
    type SyncdReplicationScopeCheckpoint,
    type SyncdReplicationSnapshot,
    type SyncdSyncProgress,
  } from "../../lib/syncdDesktop";
  import { pairingVerificationCode } from "../../lib/syncPairingVerification";
  import FirstRunTitle from "./FirstRunTitle.svelte";

  interface Props {
    profileId?: string | null;
    onReadyChange?: (ready: boolean) => void;
    onBack?: () => void;
    onContinue?: () => void;
    /** Leaves sync for later (Settings › System › Security › Device pairing) and carries on with a fresh setup. */
    onSkip?: () => void;
  }

  let { profileId = null, onReadyChange = () => {}, onBack = () => {}, onContinue = () => {}, onSkip }: Props = $props();

  type Stage = "scan" | "code" | "approval" | "syncing" | "done" | "rejected";
  const PIN_LENGTH = 6;
  const SCAN_INTERVAL_MS = 4000;
  const PROGRESS_INTERVAL_MS = 2000;

  let stage = $state<Stage>("scan");
  let candidates = $state<SyncdDesktopDiscoveryCandidate[]>([]);
  let scanned = $state(false);
  let target = $state<SyncdDesktopDiscoveryCandidate | null>(null);
  let digits = $state<string[]>(Array(PIN_LENGTH).fill(""));
  let pinError = $state<string | null>(null);
  let connecting = $state(false);
  let connectState = $state<SyncdConnectState | null>(null);
  let snapshot = $state<SyncdReplicationSnapshot | null>(null);
  let libraryError = $state(false);
  let libraryRetry = $state(0);
  let libraryRead = $state(false);
  /* What Core still has to put into Suwayomi; null when Core is not running or too old to say. */
  let progress = $state<SyncdSyncProgress | null>(null);
  let progressChecked = $state(false);
  let ready = $state(false);
  let slotsElement = $state<HTMLDivElement>();
  let bodyElement = $state<HTMLDivElement>();
  let otherWaysOpen = $state(false);
  let otherSheet = $state<HTMLDivElement>();
  let otherWaysReturnFocus: HTMLElement | null = null;
  type PanelComponent = Component<{ profileId?: string | null; scopeLabel: string; presentation?: "modal" | "embedded"; onReadyChange?: (ready: boolean) => void }>;
  let OtherWaysPanel = $state<PanelComponent | null>(null);
  let otherWaysReady = $state(false);
  /* A phone or computer that paired with this computer's Core. Both sides then publish their
     libraries and Core merges them, so nothing here waits for a remote bootstrap. */
  let hostPeer = $state<{ name: string; platform: string } | null>(null);

  const targetName = $derived(target?.deviceName ?? target?.instanceName ?? connectState?.remoteDeviceName ?? hostPeer?.name ?? $_("firstRun.sync.otherComputer"));
  const peerIsPhone = $derived(hostPeer?.platform === "android");
  const hostProgressKey = $derived(hostPeer && profileId
    ? JSON.stringify([profileId, snapshot?.comicsScopeCheckpoint ?? null, snapshot?.booksScopeCheckpoint ?? null, snapshot?.novelsScopeCheckpoint ?? null])
    : null);
  const pin = $derived(digits.join(""));
  const verification = $derived(connectState ? pairingVerificationCode(connectState.tlsCertSha256) : "");
  /* Live replication has replayed every scope, so one that never got a checkpoint had nothing to
     bring. A computer that hosted the pairing reads its library back instead and has no checkpoints. */
  type ScopeState = "ready" | "empty" | "syncing" | "importing" | "background" | "connecting";
  function scopeState(checkpoint: SyncdReplicationScopeCheckpoint | null | undefined): ScopeState {
    if (checkpoint) return "ready";
    if (!libraryRead) return "syncing";
    return hostPeer ? "ready" : "empty";
  }
  /* Synced comics become Suwayomi works through Core's import; the step is ready once the library,
     its categories and assignments are applied. Chapter progress (tens of thousands of rows after
     a first sync), details and chapter lists of imported works keep arriving afterwards, and synced
     tracker logins keep signing in, without holding the step. An older Core reports only the total. */
  /* A phone reports what it still has to send once a sync run sent what it could; until then
     Core's counts can read zero only because nothing has arrived yet. */
  const uploadsDone = $derived(!peerIsPhone || !progress || progress.pendingUploads === undefined || progress.pendingUploads === 0);
  const pendingCatalog = $derived(progress ? (progress.pendingCatalogProjections ?? progress.pendingProjections) : 0);
  const finishing = $derived((progress?.pendingDetails ?? 0) > 0 || (progress?.pendingProjections ?? 0) > 0);
  const applied = $derived(progressChecked && uploadsDone && pendingCatalog === 0);
  function comicsState(): ScopeState {
    const base = scopeState(snapshot?.comicsScopeCheckpoint);
    if (base === "syncing") return base;
    if (!ready && pendingCatalog > 0) return "importing";
    if (!ready && !uploadsDone) return "syncing";
    if (ready && finishing) return "background";
    return base;
  }
  /* Tracker logins sign in against each tracker, which can be slow or offline; the row shows they
     are still connecting while Core keeps retrying them in the background. */
  function trackersState(): ScopeState {
    if (!libraryRead || !progressChecked) return "syncing";
    if ((progress?.pendingTrackerLogins ?? 0) > 0) return "connecting";
    return ready || uploadsDone ? "ready" : "syncing";
  }
  const scopes = $derived([
    { id: "comics", icon: Books, label: $_("firstRun.sync.scopeComics"), state: comicsState() },
    { id: "books", icon: BookOpenText, label: $_("firstRun.sync.scopeBooks"), state: scopeState(snapshot?.booksScopeCheckpoint) },
    { id: "novels", icon: BookOpenText, label: $_("firstRun.sync.scopeNovels"), state: scopeState(snapshot?.novelsScopeCheckpoint) },
    { id: "trackers", icon: Key, label: $_("firstRun.sync.scopeTrackers"), state: trackersState() },
  ]);
  const readinessKey = $derived(firstRunSyncReadinessKey(profileId, snapshot));

  $effect(() => { onReadyChange(ready || otherWaysReady); });

  /* Discovery runs while the user is choosing a computer. */
  $effect(() => {
    if (stage !== "scan") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = async () => {
      try {
        const next = (await syncdListDiscoveryCandidates()) ?? [];
        if (cancelled) return;
        const added = next.filter((candidate) => !candidates.some((known) => known.effectiveOrigin === candidate.effectiveOrigin));
        candidates = next;
        if (added.length) {
          await tick();
          enterElements(added.map((candidate) => findByData(bodyElement, "origin", candidate.effectiveOrigin)).filter((node): node is HTMLElement => Boolean(node)), { baseDelay: 0 });
        }
      } catch {
        if (!cancelled) candidates = [];
      }
      /* Phones do not announce themselves on the network; one that paired here shows up in this
         Core's paired devices, even when Core started after this step opened. */
      if (!cancelled && profileId) {
        try {
          const paired = (await syncdListPairedDevicesIfRunning()) ?? [];
          const peer = paired.find((device) => device.profileId === profileId && !device.inactive);
          if (!cancelled && peer && stage === "scan") adoptHostPeer(peer.deviceName, peer.platform);
        } catch {}
      }
      if (!cancelled) {
        scanned = true;
        timer = setTimeout(scan, SCAN_INTERVAL_MS);
      }
    };
    void scan();
    return () => { cancelled = true; clearTimeout(timer); };
  });

  onMount(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      if (profileId) {
        try {
          const current = await syncdGetReplicationState(profileId);
          if (!disposed && current) applySnapshot(current);
        } catch {}
        try {
          const paired = (await syncdListPairedDevicesIfRunning()) ?? [];
          const peer = paired.find((device) => device.profileId === profileId && !device.inactive);
          if (!disposed && peer) adoptHostPeer(peer.deviceName, peer.platform);
        } catch {}
      }
      try {
        const offPairing = await listenSyncdPairingStatus((payload) => {
          if ("bootstrapBundle" in payload) {
            applyHostStatus(payload);
            return;
          }
          if (!connectState || !("localProfileId" in payload) || payload.sessionId !== connectState.sessionId) return;
          connectState = payload;
          applyConnectStatus(payload);
        });
        unlisteners.push(offPairing);
        const offReplication = await listenSyncdReplicationState((payload) => applySnapshot(payload));
        unlisteners.push(offReplication);
      } catch (error) {
        console.warn("First-run sync could not subscribe to pairing updates.", error);
      }
      if (disposed) unlisteners.splice(0).forEach((unlisten) => unlisten());
    })();
    return () => { disposed = true; unlisteners.forEach((unlisten) => unlisten()); };
  });

  function applySnapshot(next: SyncdReplicationSnapshot) {
    if (!profileId || next.localProfileId !== profileId) return;
    snapshot = next;
    if (next.activeSessionKey && ["connecting", "replaying", "live"].includes(next.replicationStatus) && (stage === "scan" || stage === "approval")) {
      stage = "syncing";
    }
  }

  function applyHostStatus(state: SyncdHostPairingState) {
    if (!profileId || state.profileId !== profileId || state.status !== "approved") return;
    adoptHostPeer(state.claimedDeviceName?.trim() || $_("firstRun.sync.otherComputer"), state.claimedPlatform ?? "unknown");
    if (otherWaysOpen) closeOtherWays();
  }

  function adoptHostPeer(name: string, platform: string) {
    if (connectState) return;
    hostPeer = { name, platform: platform.toLowerCase() };
    if (stage !== "done") stage = "syncing";
  }

  function applyConnectStatus(state: SyncdConnectState) {
    if (state.status === "rejected") stage = "rejected";
    else if (state.status === "approved" || state.status === "connected") stage = "syncing";
    else if (state.status === "expired") {
      digits = Array(PIN_LENGTH).fill("");
      stage = "code";
      pinError = $_("firstRun.sync.errorExpired");
    }
  }

  /* Once replication is live with an attested remote bootstrap, the synced library is read back. */
  $effect(() => {
    const key = readinessKey;
    libraryRetry;
    if (!key || !profileId) return;
    let current = true;
    libraryError = false;
    void refreshFirstRunSyncLibrary(profileId, () => current).then(() => {
      if (current) libraryRead = true;
    }).catch((error) => {
      console.warn("First-run sync could not read the synced library.", error);
      if (current) libraryError = true;
    });
    return () => { current = false; };
  });

  /* Paired with this computer: the library is read back now and again as each scope advances. */
  $effect(() => {
    const key = hostProgressKey;
    libraryRetry;
    if (!key || !profileId) return;
    let current = true;
    libraryError = false;
    void refreshFirstRunSyncLibrary(profileId, () => current).then(() => {
      if (current) libraryRead = true;
    }).catch((error) => {
      console.warn("First-run sync could not read the synced library.", error);
      if (current && !libraryRead) libraryError = true;
    });
    return () => { current = false; };
  });

  /* While syncing, and afterwards until imported works are complete, chapter progress applied and
     tracker logins signed in, Core reports what it has still to apply. */
  $effect(() => {
    if (stage !== "syncing" && stage !== "done") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await syncdGetSyncProgressIfRunning();
        if (cancelled) return;
        progress = next;
      } catch (error) {
        if (cancelled) return;
        console.warn("First-run sync could not read sync progress.", error);
      }
      progressChecked = true;
      if (ready && !finishing && (progress?.pendingTrackerLogins ?? 0) === 0) return;
      timer = setTimeout(poll, PROGRESS_INTERVAL_MS);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  });

  $effect(() => {
    if (ready || !libraryRead || !applied) return;
    ready = true;
    stage = "done";
  });

  $effect(() => {
    if (stage === "done") void tick().then(() => pulse(document.querySelector(".fr-sync-continue")));
  });

  async function chooseComputer(candidate: SyncdDesktopDiscoveryCandidate) {
    target = candidate;
    digits = Array(PIN_LENGTH).fill("");
    pinError = null;
    stage = "code";
    await tick();
    slotsElement?.querySelector<HTMLInputElement>("input")?.focus();
  }

  function focusSlot(index: number) {
    slotsElement?.querySelectorAll<HTMLInputElement>("input")[Math.max(0, Math.min(PIN_LENGTH - 1, index))]?.focus();
  }

  function onSlotInput(index: number, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const value = input.value.replace(/\D/g, "");
    const next = [...digits];
    if (value.length > 1) {
      value.slice(0, PIN_LENGTH - index).split("").forEach((digit, offset) => { next[index + offset] = digit; });
      digits = next;
      focusSlot(index + value.length);
    } else {
      next[index] = value;
      digits = next;
      input.value = value;
      if (value) focusSlot(index + 1);
    }
    pinError = null;
    if (digits.join("").length === PIN_LENGTH) pulse(document.querySelector(".fr-sync-submit"));
  }

  function onSlotKeydown(index: number, event: KeyboardEvent) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      const next = [...digits];
      next[index - 1] = "";
      digits = next;
      focusSlot(index - 1);
    } else if (event.key === "ArrowLeft") focusSlot(index - 1);
    else if (event.key === "ArrowRight") focusSlot(index + 1);
    else if (event.key === "Enter") void submitPin();
  }

  function pinErrorMessage(cause: unknown): string {
    const code = String(cause instanceof Error ? cause.message : cause ?? "");
    if (code.includes("SYNC_PIN_NOT_FOUND") || code.includes("SYNC_PIN_INVALID")) return $_("firstRun.sync.errorPin");
    if (code.includes("SYNC_PIN_LOCKED")) return $_("firstRun.sync.errorLocked");
    if (code.includes("SYNC_PIN_TLS_MISMATCH")) return $_("firstRun.sync.errorIdentity", { name: targetName });
    if (code.includes("SYNC_PIN_UNREACHABLE")) return $_("firstRun.sync.errorUnreachable", { name: targetName });
    return $_("firstRun.sync.errorFailed");
  }

  function shakeSlots() {
    if (!slotsElement || prefersReducedMotion()) return;
    slotsElement.classList.remove("shake");
    void slotsElement.offsetWidth;
    slotsElement.classList.add("shake");
  }

  async function submitPin() {
    if (!target || !profileId || connecting || pin.length !== PIN_LENGTH) return;
    connecting = true;
    pinError = null;
    try {
      const bundle = await syncdResolvePairingPin({
        origin: target.effectiveOrigin,
        tlsCertSha256: target.tlsCertSha256,
        fallbackOrigins: target.fallbackOrigins,
        pin,
      });
      const state = await syncdConnectWithBootstrap({ localProfileId: profileId, bootstrapBundle: bundle, manualOrigin: target.effectiveOrigin });
      connectState = state;
      stage = "approval";
      applyConnectStatus(state);
    } catch (cause) {
      pinError = pinErrorMessage(cause);
      shakeSlots();
    } finally {
      connecting = false;
    }
  }

  function cancelApproval() {
    connectState = null;
    stage = "code";
    void tick().then(() => focusSlot(0));
  }

  function retryAfterRejection() {
    connectState = null;
    digits = Array(PIN_LENGTH).fill("");
    pinError = null;
    stage = "code";
    void tick().then(() => focusSlot(0));
  }

  function closeOtherWays() {
    otherWaysOpen = false;
    otherWaysReturnFocus?.focus();
    otherWaysReturnFocus = null;
  }

  async function openOtherWays() {
    otherWaysReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    otherWaysOpen = true;
    void tick().then(() => otherSheet?.focus());
    if (!OtherWaysPanel) {
      const module = await import("../settings/SyncdConnectionPanel.svelte");
      OtherWaysPanel = module.default as unknown as PanelComponent;
    }
  }

</script>

<FirstRunTitle text={$_("firstRun.sync.title")} />
<p class="fr-lede" data-enter>{$_("firstRun.sync.lede")}</p>

<div class="sync" bind:this={bodyElement} data-enter>
  <div class="sync-art" aria-hidden="true">
    {#if stage === "scan"}
      <div class="radar" in:motionFade={{ duration: 300 }}>
        <span class="wave"></span><span class="wave"></span><span class="wave"></span>
        <span class="radar-core"><WifiHigh size={26} /></span>
        {#each candidates.slice(0, 4) as candidate, index (candidate.effectiveOrigin)}
          <span class="blip" style:left={`${[22, 74, 30, 66][index]}%`} style:top={`${[26, 62, 70, 20][index]}%`} in:arrive></span>
        {/each}
      </div>
    {:else}
      <div class="pair" class:is-active={stage === "approval" || stage === "syncing"} class:is-done={stage === "done"} in:motionFade={{ duration: 300 }}>
        <span class="device"><span><Laptop size={28} /></span>{$_("firstRun.sync.thisComputer")}</span>
        <span class="wire"><i></i></span>
        <span class="device" class:is-ok={stage === "done"}><span>{#if stage === "done"}<Check size={28} weight="bold" />{:else if peerIsPhone}<DeviceMobile size={28} />{:else}<Desktop size={28} />{/if}</span>{targetName}</span>
      </div>
    {/if}
  </div>

  <div class="sync-panel">
    {#key stage}
    <div class="sync-stage" in:arrive>
      {#if stage === "scan"}
        <div class="fr-section-label">{$_("firstRun.sync.networkLabel")}</div>
        <div class="peers" aria-live="polite">
          {#if !scanned}
            <div class="fr-skeleton"></div><div class="fr-skeleton" style:opacity=".6"></div>
          {:else if candidates.length === 0}
            <div class="searching"><span class="fr-dots"><i></i><i></i><i></i></span>{$_("firstRun.sync.searching")}</div>
          {:else}
            {#each candidates as candidate (candidate.effectiveOrigin)}
              <div class="fr-row" data-origin={candidate.effectiveOrigin}>
                <span class="fr-mark"><Desktop size={18} /></span>
                <span class="fr-row-copy"><strong>{candidate.deviceName || candidate.instanceName}</strong><small>{$_("firstRun.sync.sameNetwork")}</small></span>
                <button class="fr-link" type="button" aria-label={$_("firstRun.sync.chooseNamed", { name: candidate.deviceName || candidate.instanceName })} onclick={() => chooseComputer(candidate)}>{$_("firstRun.sync.choose")}</button>
              </div>
            {/each}
          {/if}
        </div>
        <p class="help">{$_("firstRun.sync.help")}</p>
        <button class="fr-link fr-link--quiet other-ways" type="button" onclick={openOtherWays}><CaretRight size={13} />{$_("firstRun.sync.otherWays")}</button>

      {:else if stage === "code"}
        <strong class="stage-title">{$_("firstRun.sync.codeTitle", { name: targetName })}</strong>
        <p class="help">{$_("firstRun.sync.codeHelp")}</p>
        <div class="slots" class:is-invalid={pinError} bind:this={slotsElement} role="group" aria-label={$_("firstRun.sync.codeLabel")}>
          {#each digits as digit, index (index)}
            {#if index === PIN_LENGTH / 2}<span class="slot-gap"></span>{/if}
            <input
              class:is-filled={digit}
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength={index === 0 ? PIN_LENGTH : 1}
              value={digit}
              disabled={connecting}
              aria-label={$_("firstRun.sync.digit", { index: index + 1 })}
              oninput={(event) => onSlotInput(index, event)}
              onkeydown={(event) => onSlotKeydown(index, event)}
            />
          {/each}
        </div>
        <div class="fr-field-error" class:is-visible={pinError} role="alert">{pinError ?? ""}</div>
        <div class="stage-actions">
          <button class="fr-link fr-link--quiet" type="button" disabled={connecting} onclick={() => { connectState = null; stage = "scan"; target = null; }}><ArrowLeft size={13} />{$_("firstRun.sync.pickOther")}</button>
          <span class="fr-spacer"></span>
          <button class="fr-btn fr-btn--primary fr-sync-submit" type="button" disabled={connecting || pin.length !== PIN_LENGTH} onclick={submitPin}>
            {#if connecting}<span class="fr-dots"><i></i><i></i><i></i></span>{$_("firstRun.sync.connecting")}{:else}{$_("firstRun.sync.connect")}<ArrowRight class="fr-arrow-next" size={16} />{/if}
          </button>
        </div>

      {:else if stage === "approval"}
        <strong class="stage-title">{$_("firstRun.sync.approvalTitle", { name: targetName })}</strong>
        <p class="help">{$_("firstRun.sync.approvalHelp")}</p>
        <div class="verification" aria-label={$_("firstRun.sync.verificationNamed", { code: verification })}>
          {#each verification.split("") as digit, index (index)}<span aria-hidden="true" in:motionFly={{ y: 12, delay: index * 70, duration: 500, easing: spring }}>{digit}</span>{/each}
        </div>
        <div class="state-card"><span class="fr-dots"><i></i><i></i><i></i></span><span>{$_("firstRun.sync.waiting")}</span><span class="fr-spacer"></span><button class="fr-link fr-link--quiet" type="button" onclick={cancelApproval}>{$_("firstRun.sync.cancel")}</button></div>

      {:else if stage === "rejected"}
        <strong class="stage-title">{$_("firstRun.sync.rejectedTitle", { name: targetName })}</strong>
        <p class="help">{$_("firstRun.sync.rejectedHelp")}</p>
        <div><button class="fr-btn fr-btn--primary" type="button" onclick={retryAfterRejection}>{$_("firstRun.sync.tryAgain")}<ArrowsClockwise class="fr-arrow-next" size={16} /></button></div>

      {:else}
        <strong class="stage-title">{stage === "done" ? $_("firstRun.sync.doneTitle") : $_("firstRun.sync.syncingTitle", { name: targetName })}</strong>
        <p class="help">{stage === "done" ? $_("firstRun.sync.doneHelp") : $_("firstRun.sync.syncingHelp")}</p>
        <div class="scopes">
          {#each scopes as scope (scope.id)}
            <div class="fr-row scope" class:is-done={scope.state === "ready" || scope.state === "empty"} data-scope={scope.id} data-state={scope.state}>
              <span class="fr-mark"><scope.icon size={18} /></span>
              <span class="fr-row-copy"><strong>{scope.label}</strong></span>
              <span class="scope-state">{#if scope.state === "ready"}<Check size={15} weight="bold" />{$_("firstRun.sync.scopeReady")}{:else if scope.state === "empty"}{$_("firstRun.sync.scopeEmpty")}{:else if scope.state === "importing"}<span class="fr-spinner"></span>{$_("firstRun.sync.scopeImporting")}{:else if scope.state === "background"}<Check size={15} weight="bold" />{$_("firstRun.sync.scopeBackground")}{:else if scope.state === "connecting"}<span class="fr-spinner"></span>{$_("firstRun.sync.scopeConnecting")}{:else}<span class="fr-spinner"></span>{$_("firstRun.sync.scopeSyncing")}{/if}</span>
            </div>
          {/each}
        </div>
        <div class="indeterminate" class:is-done={stage === "done"}><i></i></div>
        {#if libraryError}
          <div class="fr-error" role="alert"><WarningCircle size={18} /><span>{$_("firstRun.sync.libraryError")}</span><button class="fr-link" type="button" onclick={() => (libraryRetry += 1)}>{$_("firstRun.sync.tryAgain")}</button></div>
        {/if}
      {/if}
    </div>
    {/key}
  </div>
</div>

<div class="fr-footer">
  <button class="fr-btn" type="button" disabled={connecting} onclick={onBack}><ArrowLeft class="fr-arrow-back" size={16} />{$_("firstRun.shell.back")}</button>
  <span class="fr-spacer"></span>
  {#if onSkip && !(ready || otherWaysReady)}<button class="fr-btn" type="button" disabled={connecting} onclick={onSkip}>{$_("firstRun.sync.doLater")}</button>{/if}
  <button class="fr-btn fr-btn--primary fr-sync-continue" type="button" disabled={!(ready || otherWaysReady)} onclick={onContinue}>{$_("firstRun.shell.continue")}<ArrowRight class="fr-arrow-next" size={16} /></button>
</div>

{#if otherWaysOpen}
  <button class="fr-scrim" type="button" tabindex="-1" aria-hidden="true" transition:motionFade={{ duration: 250 }} onclick={closeOtherWays}></button>
  <div class="fr-sheet other-sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label={$_("firstRun.sync.otherWays")} bind:this={otherSheet} onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeOtherWays(); } }} transition:motionFly={{ y: 60, duration: 600, easing: spring }}>
    <header class="sheet-head"><strong>{$_("firstRun.sync.otherWays")}</strong><button class="fr-link fr-link--quiet" type="button" onclick={closeOtherWays}><X size={14} />{$_("firstRun.trackers.close")}</button></header>
    <div class="sheet-body">
      {#if OtherWaysPanel}
        <OtherWaysPanel {profileId} scopeLabel={$_("firstRun.shell.scope")} presentation="embedded" onReadyChange={(value: boolean) => (otherWaysReady = value)} />
      {:else}
        <div class="fr-skeleton"></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .sync { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 32px; align-items: center; min-height: 300px; }
  .sync-art { position: relative; min-height: 250px; display: grid; place-items: center; }
  .radar { position: relative; width: 100%; height: 250px; display: grid; place-items: center; }
  .radar-core { position: relative; z-index: 2; width: 62px; height: 62px; display: grid; place-items: center; border-radius: 20px; color: var(--accent-fg); background: var(--accent-muted); }
  .wave { position: absolute; width: 62px; height: 62px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--accent) 40%, transparent); animation: sync-wave 3s var(--fr-out) infinite; }
  .wave:nth-child(2) { animation-delay: 1s; }
  .wave:nth-child(3) { animation-delay: 2s; }
  .blip { position: absolute; z-index: 2; width: 10px; height: 10px; border-radius: 50%; background: var(--color-success); box-shadow: 0 0 12px var(--color-success); }
  .pair { display: flex; align-items: center; justify-content: center; }
  .device { position: relative; z-index: 1; width: 120px; display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--text-secondary); font-size: 11.5px; font-weight: 650; text-align: center; overflow-wrap: anywhere; }
  .device > span { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 20px; color: var(--accent-fg); background: var(--accent-muted); transition: background .4s, color .4s; }
  .device.is-ok > span { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 14%, transparent); }
  .wire { position: relative; flex: 0 0 90px; height: 2px; margin-top: -26px; background: repeating-linear-gradient(90deg, var(--fr-line) 0 6px, transparent 6px 11px); }
  .wire i { position: absolute; top: -3px; left: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); opacity: 0; }
  .pair.is-active .wire i { opacity: 1; animation: sync-travel 1.6s cubic-bezier(.65, 0, .35, 1) infinite; }
  .pair.is-done .wire { background: var(--color-success); }
  .sync-panel { position: relative; min-width: 0; display: grid; }
  .sync-stage { grid-area: 1 / 1; min-width: 0; display: grid; align-content: start; gap: 4px; }
  .stage-title { color: var(--text-primary); font-size: 15px; font-weight: 700; }
  .help { margin: 6px 4px 8px 0; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
  .peers { display: grid; min-height: 110px; }
  .searching { display: flex; align-items: center; gap: 12px; padding: 18px 8px; color: var(--text-muted); font-size: 12.5px; }
  .other-ways { justify-self: start; margin-left: -4px; }
  .slots { display: flex; align-items: center; gap: 10px; margin: 16px 0 4px; }
  .slot-gap { width: 8px; }
  .slots input { width: 46px; height: 58px; padding: 0; border: 0; outline: 0; border-radius: 12px; color: var(--text-primary); background: var(--fr-surface); caret-color: var(--accent); font: inherit; font-size: 26px; font-weight: 800; text-align: center; box-shadow: inset 0 -2px 0 var(--fr-line); transition: background .25s, box-shadow .35s, transform .45s var(--fr-bounce); }
  .slots input:hover { background: var(--fr-surface-strong); }
  .slots input:focus { background: color-mix(in srgb, var(--accent) 7%, var(--fr-surface-strong)); box-shadow: inset 0 -2px 0 var(--accent); }
  .slots input.is-filled { transform: translateY(-2px); }
  .slots.is-invalid input { box-shadow: inset 0 -2px 0 var(--color-danger); }
  .stage-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .verification { display: flex; gap: 8px; margin: 14px 0 8px; }
  .verification span { width: 44px; height: 54px; display: grid; place-items: center; border-radius: 12px; color: var(--accent-fg); background: var(--accent-muted); font-size: 26px; font-weight: 800; }
  .state-card { display: flex; align-items: center; gap: 12px; margin-top: 10px; padding: 12px 14px; border-radius: 14px; color: var(--text-muted); background: var(--fr-surface); font-size: 12.5px; }
  .scopes { display: grid; gap: 2px; margin: 10px 0; }
  .scope-state { display: inline-flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 12px; font-weight: 600; }
  .scope.is-done .scope-state { color: var(--color-success); }
  .indeterminate { position: relative; height: 4px; overflow: hidden; border-radius: 999px; background: var(--fr-surface-strong); }
  .indeterminate i { position: absolute; top: 0; bottom: 0; width: 35%; border-radius: inherit; background: linear-gradient(90deg, transparent, var(--accent), transparent); animation: sync-indeterminate 1.4s cubic-bezier(.65, 0, .35, 1) infinite; }
  .indeterminate.is-done i { left: 0; width: 100%; background: var(--color-success); animation: none; }
  .other-sheet { width: min(760px, calc(100% - 32px)); max-height: calc(100% - 44px); display: flex; flex-direction: column; }
  .sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .sheet-head strong { font-size: 16px; font-weight: 750; }
  .sheet-body { min-height: 0; overflow: auto; }
  @keyframes sync-wave { from { transform: scale(1); opacity: .8; } to { transform: scale(4.2); opacity: 0; } }
  @keyframes sync-travel { 0% { left: 0; opacity: 0; } 15%, 85% { opacity: 1; } 100% { left: calc(100% - 8px); opacity: 0; } }
  @keyframes sync-indeterminate { from { left: -35%; } to { left: 100%; } }
  @media (max-width: 760px) {
    .sync { grid-template-columns: 1fr; gap: 12px; }
    .sync-art { min-height: 150px; }
    .radar { height: 150px; }
  }
  @media (max-width: 420px) {
    .slots { gap: 6px; }
    .slots input { width: 38px; height: 50px; font-size: 22px; }
  }
</style>
