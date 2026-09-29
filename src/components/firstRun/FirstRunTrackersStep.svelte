<script lang="ts">
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { open as openUrl } from "@tauri-apps/plugin-shell";
  import { ArrowClockwise, ArrowLeft, ArrowRight, CaretRight, Check, Key, Link, User, WarningCircle, X } from "phosphor-svelte";
  import { findByData, flash, motionFade, motionFly, spring } from "../../lib/motion/firstRunMotion";
  import FirstRunTitle from "./FirstRunTitle.svelte";

  import { applyServiceIconFallback, resolveServiceIconUrl } from "../../lib/assets/serviceIconResolver";
  import { _ } from "../../lib/i18n/runtime";
  import { operationError } from "../../lib/i18n/operationPresentation";
  import type { FirstRunTrackerProvider, FirstRunTrackerWorkflow } from "../../lib/tracking/firstRunTrackerWorkflow";

  interface Props {
    workflow: FirstRunTrackerWorkflow;
    onBack?: () => void;
    onContinue?: () => void;
  }

  let { workflow, onBack = () => {}, onContinue = () => {} }: Props = $props();
  let providers = $state<readonly FirstRunTrackerProvider[]>([]);
  let active = $state<FirstRunTrackerProvider | null>(null);
  let callback = $state("");
  let username = $state("");
  let password = $state("");
  let token = $state("");
  let loading = $state(true);
  let busy = $state(false);
  let opening = $state(false);
  let autoCapturing = $state(false);
  let authCard: HTMLElement | undefined = $state();
  let sheetReturnFocus: HTMLElement | null = null;
  let mounted = false;
  let authGeneration = 0;
  let nativeSessionId: string | null = null;
  const oauthListeners: UnlistenFn[] = [];
  let error = $state<{ cause: unknown; fallback: string } | null>(null);

  function stopCapture() {
    authGeneration += 1;
    for (const unlisten of oauthListeners.splice(0)) unlisten();
    autoCapturing = false;
    const sessionId = nativeSessionId;
    nativeSessionId = null;
    if (sessionId) void invoke("close_tracker_oauth_window", { sessionId }).catch(() => {});
  }

  async function refresh() {
    if (busy || opening) return;
    loading = true;
    error = null;
    try {
      await workflow.load();
      if (!mounted) return;
      providers = [...workflow.providers];
      error = workflow.loadError ? { cause: workflow.loadError, fallback: "firstRun.trackers.loadError" } : null;
    } catch (cause) {
      error = { cause, fallback: "firstRun.trackers.loadError" };
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    mounted = true;
    void refresh();
    return () => { mounted = false; stopCapture(); };
  });

  async function begin(provider: FirstRunTrackerProvider) {
    if (busy || opening || loading || provider.connected) return;
    stopCapture();
    error = null;
    callback = "";
    username = "";
    password = "";
    token = "";
    sheetReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    active = provider;
    void tick().then(() => { if (mounted) (authCard?.querySelector<HTMLInputElement>("input") ?? authCard)?.focus(); });
    if (provider.authMode === "oauth" && provider.authUrl) {
      const generation = authGeneration;
      const sessionId = crypto.randomUUID();
      nativeSessionId = sessionId;
      const isCurrent = () => mounted && generation === authGeneration && active?.id === provider.id;
      opening = true;
      try {
        const unlistenCallback = await listen<{ url: string; sessionId?: string }>("tracker-oauth-callback", (event) => {
          if (isCurrent() && event.payload?.sessionId === sessionId && !busy && typeof event.payload.url === "string") void submit(event.payload.url);
        });
        if (!isCurrent()) { unlistenCallback(); return; }
        oauthListeners.push(unlistenCallback);
        const unlistenWindow = await listen<boolean>("tracker-oauth-window-state", (event) => {
          if (isCurrent()) autoCapturing = event.payload === true;
        });
        if (!isCurrent()) { unlistenWindow(); return; }
        oauthListeners.push(unlistenWindow);
        autoCapturing = true;
        await invoke("open_tracker_oauth_window", { url: provider.authUrl, sessionId });
        if (!isCurrent()) await invoke("close_tracker_oauth_window", { sessionId });
      } catch {
        if (!isCurrent()) return;
        stopCapture();
        try {
          await openUrl(provider.authUrl);
          if (mounted && active?.id === provider.id) error = { cause: null, fallback: "firstRun.trackers.automaticUnavailable" };
        } catch {
          if (mounted) error = { cause: null, fallback: "firstRun.trackers.loginWindowError" };
        }
      } finally {
        if (mounted) opening = false;
      }
    }
  }

  function close() {
    if (busy || opening) return;
    clearForm();
    sheetReturnFocus?.focus();
    sheetReturnFocus = null;
  }

  function clearForm() {
    stopCapture();
    active = null;
    callback = "";
    username = "";
    password = "";
    token = "";
    error = null;
  }

  async function submit(capturedCallback?: string) {
    if (!mounted || !active || busy) return;
    const provider = active;
    busy = true;
    error = null;
    try {
      if (provider.kind === "hardcover") {
        await workflow.submitHardcover(token);
      } else if (provider.authMode === "oauth") {
        await workflow.submitOAuth(provider.id, capturedCallback ?? callback);
      } else {
        await workflow.submitCredentials(provider.id, username, password);
      }
      if (!mounted) return;
      providers = [...workflow.providers];
      clearForm();
      void tick().then(() => flash(findByData(document, "tracker", provider.id)));
      error = workflow.loadError ? { cause: workflow.loadError, fallback: "firstRun.trackers.loadError" } : null;
    } catch (cause) {
      error = { cause, fallback: "firstRun.trackers.connectionError" };
    } finally {
      busy = false;
    }
  }

  async function disconnect(provider: FirstRunTrackerProvider) {
    if (busy || opening || loading) return;
    busy = true;
    error = null;
    try {
      if (provider.kind === "hardcover") workflow.disconnectHardcover();
      else await workflow.logout(provider.id);
      if (!mounted) return;
      providers = [...workflow.providers];
      error = workflow.loadError ? { cause: workflow.loadError, fallback: "firstRun.trackers.loadError" } : null;
    } catch (cause) {
      error = { cause, fallback: "firstRun.trackers.disconnectError" };
    } finally {
      busy = false;
    }
  }

  function navigate(action: () => void) {
    if (busy || opening) return;
    clearForm();
    action();
  }

  async function openExternal(url: string) {
    try { await openUrl(url); }
    catch { error = { cause: null, fallback: "firstRun.trackers.browserError" }; }
  }
</script>

{#snippet trackerRow(provider: FirstRunTrackerProvider)}
  <div class="fr-row tracker-row" class:is-connected={provider.connected} data-tracker={provider.id}>
    <span class="flip" class:is-on={provider.connected} aria-hidden="true">
      <span class="flip-inner">
        <span class="flip-front"><img src={resolveServiceIconUrl(provider.iconUrl, { kind: "tracker" })} alt="" onerror={(event) => applyServiceIconFallback(event, "tracker")} /></span>
        <span class="flip-back"><Check size={16} weight="bold" /></span>
      </span>
    </span>
    <span class="fr-row-copy"><strong>{provider.name}</strong><small class:is-connected={provider.connected}>{provider.connected ? $_("firstRun.trackers.connected") : provider.kind === "hardcover" ? $_("firstRun.trackers.booksNovels") : $_("firstRun.trackers.mangaProgress")}</small></span>
    {#if provider.connected}
      <button class="fr-link fr-link--quiet fr-link--danger" type="button" disabled={busy || opening} aria-label={$_("firstRun.trackers.disconnectNamed", { name: provider.name })} onclick={() => disconnect(provider)}>{$_("firstRun.trackers.disconnect")}</button>
    {:else}
      <button class="fr-link" type="button" disabled={busy || opening} aria-label={$_("firstRun.trackers.connectNamed", { name: provider.name })} onclick={() => begin(provider)}>{$_("firstRun.trackers.connect")}</button>
    {/if}
  </div>
{/snippet}

<div class="tracker-layout">
<FirstRunTitle text={$_("firstRun.trackers.title")} />
<p class="fr-lede" data-enter>{$_("firstRun.trackers.lede")}</p>

{#if error && !active}
  <div class="fr-error" role="alert" data-enter><WarningCircle size={18} /><span>{operationError(error.cause, error.fallback, $_)}</span><button class="fr-link" type="button" disabled={busy || opening || loading} onclick={refresh}>{$_("firstRun.trackers.retry")}</button></div>
{/if}

{#if loading}
  <div class="tracker-grid" aria-live="polite"><div class="fr-skeleton"></div><div class="fr-skeleton"></div><div class="fr-skeleton"></div></div>
{:else if providers.length === 0}
  <div class="fr-empty">{$_("firstRun.trackers.empty")}</div>
{:else}
  <div aria-live="polite">
    {#if providers.some((provider) => provider.kind !== "hardcover")}
      <div class="fr-section-label" data-enter>{$_("firstRun.trackers.mangaGroup")}</div>
      <div class="tracker-grid">
        {#each providers.filter((provider) => provider.kind !== "hardcover") as provider (provider.id)}<div data-enter>{@render trackerRow(provider)}</div>{/each}
      </div>
    {/if}
    {#if providers.some((provider) => provider.kind === "hardcover")}
      <div class="fr-section-label books-label" data-enter>{$_("firstRun.trackers.booksGroup")}</div>
      <div class="tracker-grid">
        {#each providers.filter((provider) => provider.kind === "hardcover") as provider (provider.id)}<div data-enter>{@render trackerRow(provider)}</div>{/each}
      </div>
    {/if}
  </div>
{/if}

<div class="fr-footer">
  <button class="fr-btn" type="button" disabled={busy || opening} onclick={() => navigate(onBack)}><ArrowLeft class="fr-arrow-back" size={16} /> {$_("firstRun.trackers.back")}</button>
  <span class="fr-spacer"></span>
  <button class="fr-btn fr-btn--primary" type="button" disabled={busy || opening} onclick={() => navigate(onContinue)}>{providers.some((provider) => provider.connected) ? $_("firstRun.trackers.continue") : $_("firstRun.trackers.continueWithout")} <ArrowRight class="fr-arrow-next" size={16} /></button>
</div>
</div>

{#if active}
  <button class="fr-scrim" type="button" tabindex="-1" aria-hidden="true" disabled={busy || opening} transition:motionFade={{ duration: 250 }} onclick={close}></button>
  <div class="fr-sheet auth-sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label={$_("firstRun.trackers.connectionNamed", { name: active.name })} bind:this={authCard} onkeydown={(event) => { if (event.key === "Escape" && !busy && !opening) { event.preventDefault(); close(); } }} transition:motionFly={{ y: 80, duration: 650, easing: spring }}>
    <header>
      <span class="fr-mark"><img src={resolveServiceIconUrl(active.iconUrl, { kind: "tracker" })} alt="" onerror={(event) => applyServiceIconFallback(event, "tracker")} /></span>
      <strong>{active.name}</strong>
      <button class="fr-link fr-link--quiet" type="button" disabled={busy || opening} onclick={close}><X size={14} />{$_("firstRun.trackers.close")}</button>
    </header>
    {#if error}
      <div class="fr-error" role="alert"><WarningCircle size={18} /><span>{operationError(error.cause, error.fallback, $_)}</span></div>
    {/if}
    {#if active.kind === "hardcover"}
      <p>{$_("firstRun.trackers.hardcoverHelp")}</p>
      <label class="fr-field"><Key size={16} /><input type="password" bind:value={token} aria-label={$_("firstRun.trackers.hardcoverToken")} placeholder={$_("firstRun.trackers.apiToken")} onkeydown={(event) => event.key === "Enter" && submit()} /></label>
    {:else if active.authMode === "oauth"}
      <div class="auth-wait" role="status">
        <span class="browser-art" aria-hidden="true"><i></i><i></i><span class="scan"></span></span>
        <span>{autoCapturing ? $_("firstRun.trackers.finishSignin", { name: active.name }) : $_("firstRun.trackers.redirectHelp")}</span>
      </div>
      <details class="redirect" open={!autoCapturing}>
        <summary><CaretRight size={13} />{$_("firstRun.trackers.useRedirect")}</summary>
        <label class="fr-field"><Link size={16} /><input bind:value={callback} aria-label={$_("firstRun.trackers.authCallback")} placeholder={$_("firstRun.trackers.redirectPlaceholder")} onkeydown={(event) => event.key === "Enter" && submit()} /></label>
      </details>
    {:else}
      <p>{$_("firstRun.trackers.credentialsHelp", { name: active.name })}</p>
      <label class="fr-field"><User size={16} /><input bind:value={username} aria-label={$_("firstRun.trackers.username")} placeholder={$_("firstRun.trackers.username")} /></label>
      <label class="fr-field"><Key size={16} /><input type="password" bind:value={password} aria-label={$_("firstRun.trackers.password")} placeholder={$_("firstRun.trackers.password")} onkeydown={(event) => event.key === "Enter" && submit()} /></label>
    {/if}
    <div class="auth-actions">
      {#if active.kind === "hardcover"}
        <button class="fr-link" type="button" onclick={() => openExternal("https://hardcover.app/account/api")}><Key size={15} /> {$_("firstRun.trackers.getApiKey")}</button>
      {:else if active.authMode === "oauth"}
        <button class="fr-link fr-link--quiet" type="button" disabled={busy || opening} onclick={() => active && begin(active)}><ArrowClockwise size={15} /> {$_("firstRun.trackers.openAgain")}</button>
      {/if}
      <span class="fr-spacer"></span>
      <button class="fr-btn fr-btn--primary" type="button" disabled={busy || opening || (active.authMode === "oauth" && !callback.trim())} onclick={() => submit()}>
        {#if busy}<span class="fr-dots"><i></i><i></i><i></i></span>{$_("firstRun.trackers.connecting")}{:else}{$_("firstRun.trackers.connectAccount")}{/if}
      </button>
    </div>
  </div>
{/if}

<style>
  .tracker-layout { min-height: 0; display: flex; flex: 1; flex-direction: column; }
  .tracker-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px 16px; }
  .books-label { margin-top: 16px; }
  .fr-row-copy small.is-connected { color: var(--color-success); }
  .flip { width: 34px; height: 34px; flex: none; perspective: 300px; }
  .flip-inner { position: relative; display: block; width: 100%; height: 100%; transform-style: preserve-3d; transition: transform .9s var(--fr-bounce); }
  .flip.is-on .flip-inner { transform: rotateY(180deg); }
  .flip-front, .flip-back { position: absolute; inset: 0; display: grid; place-items: center; overflow: hidden; border-radius: 10px; backface-visibility: hidden; }
  .flip-front { background: var(--bg-base); }
  .flip-front img { width: 100%; height: 100%; object-fit: contain; }
  .flip-back { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 18%, var(--bg-base)); transform: rotateY(180deg); }
  .auth-sheet { display: grid; gap: 12px; }
  .auth-sheet header { display: flex; align-items: center; gap: 12px; }
  .auth-sheet header strong { flex: 1; color: var(--text-primary); font-size: 16px; font-weight: 750; }
  .auth-sheet p { margin: 0; color: var(--text-muted); font-size: 12.5px; line-height: 1.55; }
  .auth-sheet .fr-error { margin: 0; }
  .auth-wait { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 14px; color: var(--text-secondary); background: var(--fr-surface); font-size: 12.5px; line-height: 1.5; }
  .browser-art { position: relative; width: 56px; height: 42px; flex: none; overflow: hidden; border-radius: 8px; background: var(--fr-surface-strong); }
  .browser-art::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 9px; background: var(--fr-line); }
  .browser-art i { position: absolute; left: 8px; right: 8px; height: 4px; border-radius: 2px; background: var(--fr-line); }
  .browser-art i:nth-child(1) { top: 16px; }
  .browser-art i:nth-child(2) { top: 24px; right: 20px; }
  .scan { position: absolute; left: 0; right: 0; height: 14px; background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--accent) 35%, transparent), transparent); animation: trackers-scan 1.6s ease-in-out infinite; }
  .redirect summary { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 4px; color: var(--accent-fg); font-size: 12px; font-weight: 650; list-style: none; cursor: pointer; }
  .redirect summary::-webkit-details-marker { display: none; }
  .redirect summary :global(svg) { transition: transform .4s var(--fr-spring); }
  .redirect[open] summary :global(svg) { transform: rotate(90deg); }
  .auth-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  @keyframes trackers-scan { from { top: -14px; } to { top: 42px; } }
  @media (max-width: 900px) { .tracker-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 560px) {
    .tracker-grid { grid-template-columns: 1fr; }
    .fr-footer { flex-wrap: wrap; }
  }
</style>
