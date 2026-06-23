<script lang="ts">
  import { _ } from "../../lib/i18n/runtime";
  import { Info } from "phosphor-svelte";
  import {
    getNovelSourceClassificationDetailPresentation,
    type PersistedNovelSourceClassificationRecord,
  } from "../../lib/novels/sourceClassificationState";

  let {
    pluginName = "this source",
    record,
    badge,
    onRetryCheck = undefined,
    retryBusy = false,
    contextLabel = "Source status",
  }: {
    pluginName?: string;
    record: PersistedNovelSourceClassificationRecord | null;
    badge: {
      shortLabel: string;
      longLabel: string;
      tone: "success" | "info" | "warning" | "danger" | "muted";
    };
    onRetryCheck?: (() => void) | undefined;
    retryBusy?: boolean;
    contextLabel?: string;
  } = $props();

  const presentation = $derived(getNovelSourceClassificationDetailPresentation(record));
  const canRetry = $derived(Boolean(onRetryCheck) && presentation.canRetryCheck);

  let open = $state(false);
  let shell: HTMLDivElement | null = null;
  const popoverId = `source-status-details-${Math.random().toString(36).slice(2, 10)}`;
  const headingId = `${popoverId}-heading`;

  function closeDetails() {
    open = false;
  }

  function openDetails() {
    open = true;
  }

  function handleFocusOut(event: FocusEvent) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && shell?.contains(nextTarget)) {
      return;
    }
    closeDetails();
  }

  function handleDocumentKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeDetails();
    }
  }
</script>

<svelte:document onkeydown={handleDocumentKeydown} />

<div
  class="source-status-shell"
  role="group"
  bind:this={shell}
  onmouseenter={openDetails}
  onmouseleave={closeDetails}
  onfocusin={openDetails}
  onfocusout={handleFocusOut}
>
  <span class={`statusBadge tone-${badge.tone}`}>{badge.shortLabel}</span>
  <button
    type="button"
    class="source-status-trigger"
    aria-label={`Show status details for ${pluginName}`}
    aria-expanded={open}
    aria-controls={popoverId}
  >
    <span aria-hidden="true" class="source-status-trigger__icon">i</span>
  </button>

  {#if open}
    <div
      id={popoverId}
      class="source-status-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
    >
      <div class="source-status-popover__head">
        <div class="source-status-popover__title-wrap">
          <p class="source-status-popover__eyebrow">{contextLabel}</p>
          <p id={headingId} class="source-status-popover__title">{presentation.longLabel}</p>
        </div>
      </div>

      <div class="source-status-popover__body">
        <div class="source-status-popover__row">
          <span class="source-status-popover__label">{presentation.isTransient ? $_("ui_stillChecking") : "Summary"}</span>
          <p
            class="source-status-popover__summary"
            class:source-status-popover__summary-transient={presentation.isTransient}
          >
            {presentation.summary}
          </p>
        </div>

        {#if presentation.primaryReason}
          <div class="source-status-popover__row">
            <span class="source-status-popover__label">{$_("ui_primaryReason")}</span>
            <p class="source-status-popover__reason">{presentation.primaryReason}</p>
          </div>
        {/if}

        {#if canRetry}
          <div class="source-status-popover__actions">
            <button
              type="button"
              class="source-status-popover__retry"
              onclick={() => onRetryCheck?.()}
              disabled={retryBusy}
            >
              <Info size={12} weight="bold" />
              {retryBusy ? "Checking..." : $_("ui_retryCheck")}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .source-status-shell {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .source-status-trigger,
  .source-status-popover__retry {
    cursor: pointer;
  }

  .source-status-trigger {
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
  }

  .source-status-trigger__icon {
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

  .source-status-trigger:hover,
  .source-status-trigger:focus-visible {
    color: var(--text-secondary);
    border-color: var(--border-strong);
    outline: none;
  }

  .source-status-popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    width: min(286px, 82vw);
    padding: 10px 11px 11px;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background: linear-gradient(180deg, rgba(17, 18, 20, 0.98), rgba(14, 15, 17, 0.98));
    backdrop-filter: blur(14px);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .source-status-popover__head,
  .source-status-popover__actions {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .source-status-popover__head {
    justify-content: flex-start;
  }

  .source-status-popover__title-wrap,
  .source-status-popover__body,
  .source-status-popover__row {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .source-status-popover__eyebrow,
  .source-status-popover__label,
  .source-status-popover__title,
  .source-status-popover__body p,
  .source-status-popover__retry {
    font-family: var(--font-ui);
  }

  .source-status-popover__eyebrow,
  .source-status-popover__label {
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .source-status-popover__title {
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: var(--weight-medium);
    line-height: var(--leading-tight);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .source-status-popover__body p {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.25;
  }

  .source-status-popover__summary-transient {
    color: var(--text-secondary);
  }

  .source-status-popover__summary,
  .source-status-popover__reason {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .source-status-popover__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 23px;
    height: 23px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-dim);
    background: var(--bg-base);
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .source-status-popover__retry {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid var(--accent-dim);
    background: var(--accent-muted);
    color: var(--accent-fg);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    font-weight: var(--weight-medium);
  }

  .source-status-popover__retry:hover,
  .source-status-popover__retry:focus-visible {
    border-color: var(--border-strong);
    outline: none;
  }

  .source-status-popover__retry:disabled {
    opacity: 0.7;
    cursor: default;
  }
</style>

