<script lang="ts">
  import { CheckCircle, CircleNotch, WarningCircle, XCircle } from "phosphor-svelte";

  import {
    getNovelSourceClassificationBadge,
    getNovelSourceClassificationDetailPresentation,
    type PersistedNovelSourceClassificationRecord,
  } from "../../lib/novels/sourceClassificationState";

  export type NovelSourceCheckStage = "idle" | "installing" | "checking" | "completed" | "failed";

  interface Props {
    pluginName: string;
    pluginId: string;
    actionLabel: string;
    stage: NovelSourceCheckStage;
    record?: PersistedNovelSourceClassificationRecord | null;
    errorMessage?: string | null;
    queueCount?: number;
    onClose: () => void;
    onRetryCheck?: (() => void) | undefined;
    retryBusy?: boolean;
  }

  let {
    pluginName,
    pluginId,
    actionLabel,
    stage,
    record = null,
    errorMessage = null,
    queueCount = 0,
    onClose,
    onRetryCheck = undefined,
    retryBusy = false,
  }: Props = $props();

  const badge = $derived(getNovelSourceClassificationBadge(record));
  const detail = $derived(getNovelSourceClassificationDetailPresentation(record));
  const canRetry = $derived(Boolean(onRetryCheck) && (stage === "failed" || detail.canRetryCheck));

  function stepState(target: "installing" | "checking" | "saving"): "pending" | "active" | "done" {
    if (target === "installing") {
      if (actionLabel === "Retry check" || actionLabel === "Already checked") return "done";
      if (stage === "installing") return "active";
      return stage === "idle" ? "pending" : "done";
    }
    if (target === "checking") {
      if (stage === "checking") return "active";
      return stage === "completed" || stage === "failed" ? "done" : "pending";
    }
    if (stage === "completed") return "done";
    return "pending";
  }

  function statusTitle(): string {
    if (actionLabel === "Already checked" && stage === "completed") return "Source already checked";
    if (stage === "installing") return "Installing extension";
    if (stage === "checking") return "Checking source";
    if (stage === "failed") return "Source check failed";
    if (detail.longLabel === "Pending smoke") return "Source check completed";
    return detail.longLabel;
  }

  function statusBody(): string {
    if (actionLabel === "Already checked" && stage === "completed") {
      return "Using the saved result for this exact plugin version on this profile.";
    }
    if (stage === "installing") return `${pluginId} is being stored for this profile.`;
    if (stage === "checking") return "Running a bounded smoke for plugin load, search, details, and chapter.";
    if (stage === "failed") return errorMessage ?? "The automatic source check did not finish cleanly.";
    return detail.summary;
  }
</script>

<button class="backdrop" type="button" aria-label="Close source check dialog" onclick={onClose}></button>

<div class="modal" role="dialog" aria-modal="true" aria-label={statusTitle()}>
  <div class="modal-header">
    <div class="modal-title">
      <span class="modal-title-label">{actionLabel}</span>
      <span class="modal-title-name">{pluginName}</span>
    </div>
    {#if queueCount > 0}
      <span class="modal-queue">{queueCount} queued</span>
    {/if}
  </div>

  <div class="modal-body">
    <div class="modal-steps">
      <div class={`modal-step step-${stepState("installing")}`}>
        <span>Installing extension</span>
        {#if stepState("installing") === "active"}
          <CircleNotch size={14} class="spin" />
        {:else if stepState("installing") === "done"}
          <CheckCircle size={14} />
        {/if}
      </div>
      <div class={`modal-step step-${stepState("checking")}`}>
        <span>Checking source</span>
        {#if stepState("checking") === "active"}
          <CircleNotch size={14} class="spin" />
        {:else if stepState("checking") === "done"}
          <CheckCircle size={14} />
        {/if}
      </div>
      <div class={`modal-step step-${stepState("saving")}`}>
        <span>Saving result</span>
        {#if stepState("saving") === "done"}
          <CheckCircle size={14} />
        {/if}
      </div>
    </div>

    <div class="modal-status">
      <div class="modal-status__header">
        {#if stage === "failed"}
          <XCircle size={16} />
        {:else if stage === "completed" && detail.longLabel === "Working with limits"}
          <WarningCircle size={16} />
        {:else if stage === "completed"}
          <CheckCircle size={16} />
        {:else}
          <CircleNotch size={16} class="spin" />
        {/if}
        <div class="modal-status__copy">
          <span class="modal-status__title">{statusTitle()}</span>
          <span class="modal-status__body">{statusBody()}</span>
        </div>
      </div>

      {#if stage === "completed" && record}
        <div class="modal-result">
          <span class={`statusBadge tone-${badge.tone}`}>{badge.shortLabel}</span>
          {#if detail.primaryReason}
            <span class="modal-result__reason">{detail.primaryReason}</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <div class="modal-actions">
    {#if canRetry}
      <button
        type="button"
        class="modal-btn modal-btn-primary"
        onclick={() => onRetryCheck?.()}
        disabled={retryBusy || stage === "installing" || stage === "checking"}
      >
        {retryBusy ? "Checking..." : "Retry check"}
      </button>
    {/if}
    <button
      type="button"
      class="modal-btn"
      onclick={onClose}
      disabled={stage === "installing" || stage === "checking"}
    >
      Close
    </button>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    border: none;
    background: rgba(0, 0, 0, 0.58);
    z-index: 1198;
    cursor: default;
  }

  .modal {
    position: fixed;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    width: min(460px, calc(100vw - 48px));
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--border-base);
    border-radius: var(--radius-xl);
    background: var(--bg-base);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
    z-index: 1199;
    overflow: hidden;
  }

  .modal-header,
  .modal-actions,
  .modal-status__header,
  .modal-result,
  .modal-step {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .modal-header,
  .modal-actions {
    justify-content: space-between;
    padding: var(--sp-4) var(--sp-5);
    border-bottom: 1px solid var(--border-dim);
  }

  .modal-actions {
    border-top: 1px solid var(--border-dim);
    border-bottom: none;
    justify-content: flex-end;
  }

  .modal-title,
  .modal-body,
  .modal-steps,
  .modal-status,
  .modal-status__copy {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .modal-title-label,
  .modal-queue,
  .modal-step,
  .modal-status__body,
  .modal-result__reason,
  .modal-btn {
    font-family: var(--font-ui);
  }

  .modal-title-label,
  .modal-queue {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: var(--tracking-wider);
    text-transform: uppercase;
  }

  .modal-title-name,
  .modal-status__title {
    font-size: var(--text-base);
    color: var(--text-primary);
    font-weight: var(--weight-medium);
  }

  .modal-body {
    padding: var(--sp-5);
  }

  .modal-step {
    justify-content: space-between;
    min-height: 34px;
    padding: 0 var(--sp-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-muted);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
  }

  .step-active {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }

  .step-done {
    color: var(--text-secondary);
  }

  .modal-status {
    margin-top: var(--sp-2);
    padding: var(--sp-4);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-dim);
    background: color-mix(in srgb, var(--bg-raised) 88%, transparent);
  }

  .modal-status__body,
  .modal-result__reason {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: 1.35;
  }

  .modal-result {
    align-items: flex-start;
    margin-top: var(--sp-2);
  }

  .statusBadge {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid var(--border-dim);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  .tone-success {
    color: var(--accent-fg);
    border-color: var(--accent-dim);
    background: var(--accent-muted);
  }

  .tone-info {
    color: var(--text-secondary);
    background: var(--bg-raised);
  }

  .tone-warning {
    color: color-mix(in srgb, var(--color-warning, #f0b84b) 84%, white 10%);
    border-color: color-mix(in srgb, var(--color-warning, #f0b84b) 48%, transparent);
    background: color-mix(in srgb, var(--color-warning, #f0b84b) 14%, transparent);
  }

  .tone-danger {
    color: var(--color-error);
    border-color: color-mix(in srgb, var(--color-error) 48%, transparent);
    background: color-mix(in srgb, var(--color-error) 12%, transparent);
  }

  .tone-muted {
    color: var(--text-faint);
    background: var(--bg-raised);
  }

  .modal-btn {
    min-height: 34px;
    padding: 0 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-dim);
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    letter-spacing: var(--tracking-wide);
    cursor: pointer;
  }

  .modal-btn-primary {
    border-color: var(--accent-dim);
    background: var(--accent-muted);
    color: var(--accent-fg);
  }

  .modal-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .spin {
    animation: sourceCheckSpin 0.9s linear infinite;
  }

  @keyframes sourceCheckSpin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>
