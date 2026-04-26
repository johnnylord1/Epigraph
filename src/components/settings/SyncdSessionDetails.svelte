<script lang="ts">
  import { Info, X } from "phosphor-svelte";
  import type { PersistedSyncSessionView } from "../../lib/syncdDesktop";

  let {
    session,
    statusLabel,
    statusTone = "neutral",
    summary,
    lastValidatedLabel,
    replicationLabel = "Idle",
    reconnectError = null,
    isReplicationPaused = false,
    onSetActive = undefined,
    onRevalidate = undefined,
    onPauseResume = undefined,
    onDisconnect = undefined,
    onForget = undefined,
    setActiveBusy = false,
    revalidateBusy = false,
    pauseResumeBusy = false,
    disconnectBusy = false,
    forgetBusy = false,
  }: {
    session: PersistedSyncSessionView;
    statusLabel: string;
    statusTone?: "success" | "info" | "warning" | "danger" | "neutral";
    summary: string;
    lastValidatedLabel: string;
    replicationLabel?: string;
    reconnectError?: string | null;
    isReplicationPaused?: boolean;
    onSetActive?: (() => void | Promise<void>) | undefined;
    onRevalidate?: (() => void | Promise<void>) | undefined;
    onPauseResume?: (() => void | Promise<void>) | undefined;
    onDisconnect?: (() => void | Promise<void>) | undefined;
    onForget?: (() => void | Promise<void>) | undefined;
    setActiveBusy?: boolean;
    revalidateBusy?: boolean;
    pauseResumeBusy?: boolean;
    disconnectBusy?: boolean;
    forgetBusy?: boolean;
  } = $props();

  let open = $state(false);
  let shell: HTMLDivElement | null = null;
  let triggerButton: HTMLButtonElement | null = null;
  let removeDocumentListeners: (() => void) | null = null;
  const popoverId = `syncd-session-details-${Math.random().toString(36).slice(2, 10)}`;
  const headingId = `${popoverId}-heading`;

  function closeDetails({ focusTrigger = false }: { focusTrigger?: boolean } = {}) {
    open = false;
    if (focusTrigger) {
      queueMicrotask(() => triggerButton?.focus());
    }
  }

  function toggleDetails() {
    open = !open;
  }

  $effect(() => {
    if (!open || typeof document === "undefined" || !shell) {
      removeDocumentListeners?.();
      removeDocumentListeners = null;
      return;
    }

    const handleDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!shell?.contains(target)) {
        closeDetails({ focusTrigger: true });
      }
    };

    const handleDocumentKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        closeDetails({ focusTrigger: true });
      }
    };

    document.addEventListener("mousedown", handleDocumentPointerDown, true);
    document.addEventListener("keydown", handleDocumentKeydown, true);
    removeDocumentListeners = () => {
      document.removeEventListener("mousedown", handleDocumentPointerDown, true);
      document.removeEventListener("keydown", handleDocumentKeydown, true);
    };

    return () => {
      removeDocumentListeners?.();
      removeDocumentListeners = null;
    };
  });

  function actionBusy(action: "set-active" | "revalidate" | "pause-resume" | "disconnect" | "forget") {
    switch (action) {
      case "set-active":
        return setActiveBusy;
      case "revalidate":
        return revalidateBusy;
      case "pause-resume":
        return pauseResumeBusy;
      case "disconnect":
        return disconnectBusy;
      case "forget":
        return forgetBusy;
    }
  }
</script>

<div class="syncd-session-shell" bind:this={shell}>
  <div class="syncd-session-copy">
    <div class="syncd-session-copy__head">
      <div class="syncd-session-copy__title-wrap">
        <p class="syncd-list__title" data-testid="syncd-session-title">{session.remoteProfileId} @ {session.canonicalOrigin}</p>
        <p class="syncd-list__hint" data-testid="syncd-session-status">{summary}</p>
        <p class="syncd-list__meta">Validated {lastValidatedLabel}</p>
        {#if reconnectError}
          <p class="syncd-error">{reconnectError}</p>
        {/if}
      </div>

      <div class="syncd-session-copy__status">
        <span class={`syncd-pill syncd-pill--${statusTone}`} data-testid="syncd-session-status-pill">{statusLabel}</span>
        {#if session.isActiveForSync}
          <span class="syncd-pill syncd-pill--success">Active</span>
        {/if}
        <button
          type="button"
          class="syncd-session-trigger"
          bind:this={triggerButton}
          aria-label={`Open session details for ${session.remoteProfileId}`}
          aria-expanded={open}
          aria-controls={popoverId}
          onclick={toggleDetails}
        >
          <span aria-hidden="true" class="syncd-session-trigger__icon">i</span>
        </button>
      </div>
    </div>
  </div>

  {#if open}
    <div
      id={popoverId}
      class="syncd-session-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
    >
      <div class="syncd-session-popover__head">
        <div class="syncd-session-popover__title-wrap">
          <p class="syncd-session-popover__eyebrow">Session details</p>
          <p id={headingId} class="syncd-session-popover__title">{session.remoteProfileId}</p>
        </div>
        <button
          type="button"
          class="syncd-session-popover__close"
          aria-label={`Close session details for ${session.remoteProfileId}`}
          onclick={() => closeDetails({ focusTrigger: true })}
        >
          <X size={12} weight="bold" />
        </button>
      </div>

      <div class="syncd-session-popover__status-strip" aria-label="Session status summary">
        <span class={`syncd-pill syncd-pill--${statusTone}`}>{statusLabel}</span>
        {#if session.isActiveForSync}
          <span class="syncd-pill syncd-pill--success">Active</span>
        {/if}
        {#if session.isActiveForSync && isReplicationPaused}
          <span class="syncd-pill syncd-pill--neutral">Paused</span>
        {/if}
        <span class="syncd-pill syncd-pill--info">{replicationLabel}</span>
      </div>

      <div class="syncd-session-popover__body">
        <div class="syncd-session-popover__row">
          <span class="syncd-session-popover__label">Connection</span>
          <p class="syncd-session-popover__summary">{statusLabel} | {summary}</p>
        </div>
        <div class="syncd-session-popover__meta-grid">
          <div>
            <span class="syncd-session-popover__label">Session key</span>
            <span class="syncd-session-popover__meta">{session.sessionKey}</span>
          </div>
          <div>
            <span class="syncd-session-popover__label">Remote server</span>
            <span class="syncd-session-popover__meta">{session.remoteServerId}</span>
          </div>
          <div>
            <span class="syncd-session-popover__label">Canonical origin</span>
            <span class="syncd-session-popover__meta">{session.canonicalOrigin}</span>
          </div>
          <div>
            <span class="syncd-session-popover__label">Discovery source</span>
            <span class="syncd-session-popover__meta">{session.lastDiscoverySource}</span>
          </div>
          <div>
            <span class="syncd-session-popover__label">Replication</span>
            <span class="syncd-session-popover__meta">{replicationLabel}{session.isActiveForSync && isReplicationPaused ? " · paused" : ""}</span>
          </div>
          <div>
            <span class="syncd-session-popover__label">Fallback origins</span>
            <span class="syncd-session-popover__meta">{session.fallbackOrigins.length}</span>
          </div>
        </div>
      </div>

      <div class="syncd-session-popover__actions">
        {#if onSetActive && !session.isActiveForSync}
          <button
            type="button"
            class="n-btn n-btn--sm n-btn-ghost"
            data-testid="syncd-session-set-active"
            data-session-key={session.sessionKey}
            onclick={() => onSetActive()}
            disabled={!session.actions.canSetActive || setActiveBusy}
          >
            {setActiveBusy ? "Switching..." : "Set active"}
          </button>
        {/if}
        {#if onRevalidate}
          <button
            type="button"
            class="n-btn n-btn--sm n-btn-ghost"
            data-testid="syncd-session-revalidate"
            data-session-key={session.sessionKey}
            onclick={() => onRevalidate()}
            disabled={!session.actions.canRevalidate || revalidateBusy}
          >
            {revalidateBusy ? "Checking..." : "Revalidate"}
          </button>
        {/if}
        {#if session.isActiveForSync && onPauseResume}
          <button
            type="button"
            class="n-btn n-btn--sm n-btn-ghost"
            data-testid="syncd-session-toggle-replication"
            data-session-key={session.sessionKey}
            onclick={() => onPauseResume()}
            disabled={pauseResumeBusy}
          >
            {pauseResumeBusy ? "Updating..." : (isReplicationPaused ? "Resume replication" : "Pause replication")}
          </button>
        {/if}
        {#if onDisconnect}
          <button
            type="button"
            class="n-btn n-btn--sm n-btn-ghost n-btn-danger"
            data-testid="syncd-session-disconnect"
            data-session-key={session.sessionKey}
            onclick={() => onDisconnect()}
            disabled={!session.actions.canDisconnect || disconnectBusy}
          >
            {disconnectBusy ? "Removing..." : "Disconnect"}
          </button>
        {/if}
        {#if onForget}
          <button
            type="button"
            class="n-btn n-btn--sm n-btn-ghost"
            data-testid="syncd-session-forget"
            data-session-key={session.sessionKey}
            onclick={() => onForget()}
            disabled={!session.actions.canForget || forgetBusy}
          >
            {forgetBusy ? "Forgetting..." : "Forget"}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .syncd-session-shell {
    position: relative;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-width: 0;
  }

  .syncd-session-copy {
    min-width: 0;
    flex: 1;
  }

  .syncd-session-copy__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .syncd-session-copy__title-wrap {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .syncd-session-copy__status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .syncd-session-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.015), rgba(255, 255, 255, 0.005));
    color: var(--text-faint);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
  }

  .syncd-session-trigger__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    border-radius: 999px;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 15px;
    font-style: italic;
    font-weight: 700;
    line-height: 1;
    color: var(--text-primary);
    transform: translateY(-1px);
    user-select: none;
  }

  .syncd-session-trigger:hover,
  .syncd-session-trigger:focus-visible,
  .syncd-session-popover__close:hover,
  .syncd-session-popover__close:focus-visible {
    color: var(--text-secondary);
    border-color: var(--border-strong);
    outline: none;
  }

  .syncd-session-popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    width: min(360px, 88vw);
    padding: 10px 11px 11px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: linear-gradient(180deg, rgba(17, 18, 20, 0.98), rgba(14, 15, 17, 0.98));
    backdrop-filter: blur(14px);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .syncd-session-popover__head,
  .syncd-session-popover__actions {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .syncd-session-popover__title-wrap,
  .syncd-session-popover__body,
  .syncd-session-popover__row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .syncd-session-popover__eyebrow,
  .syncd-session-popover__label,
  .syncd-session-popover__title,
  .syncd-session-popover__summary,
  .syncd-session-popover__meta {
    font-family: var(--font-ui);
  }

  .syncd-session-popover__eyebrow,
  .syncd-session-popover__label {
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .syncd-session-popover__title {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: var(--weight-medium);
    line-height: var(--leading-tight);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .syncd-session-popover__summary,
  .syncd-session-popover__meta {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .syncd-session-popover__meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px;
  }

  .syncd-session-popover__meta-grid > div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .syncd-session-popover__actions {
    flex-wrap: wrap;
  }
</style>
