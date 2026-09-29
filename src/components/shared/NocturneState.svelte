<script lang="ts">
  import { translate } from "../../lib/i18n/runtime";
  import {
    ArrowsClockwise,
    Books,
    CheckCircle,
    FolderOpen,
    Info,
    MagnifyingGlass,
    Plug,
    WarningCircle,
  } from "phosphor-svelte";

  type Tone = "neutral" | "info" | "warning" | "danger" | "success";
  type IconName = "info" | "warning" | "plug" | "retry" | "search" | "books" | "folder" | "check";
  type Layout = "panel" | "compact" | "center";

  let {
    eyebrow = translate("downloads_summary_status"),
    title,
    body = "",
    detail = "",
    tone = "neutral",
    icon = "info",
    layout = "panel",
    actions = [],
  }: {
    eyebrow?: string;
    title: string;
    body?: string;
    detail?: string;
    tone?: Tone;
    icon?: IconName;
    layout?: Layout;
    actions?: Array<{
      label: string;
      kind?: "primary" | "secondary" | "danger";
      disabled?: boolean;
      icon?: IconName;
      onClick: () => void;
    }>;
  } = $props();

  function iconFor(name: IconName) {
    if (name === "warning") return WarningCircle;
    if (name === "plug") return Plug;
    if (name === "retry") return ArrowsClockwise;
    if (name === "search") return MagnifyingGlass;
    if (name === "books") return Books;
    if (name === "folder") return FolderOpen;
    if (name === "check") return CheckCircle;
    return Info;
  }

  const StateIcon = $derived(iconFor(icon));
</script>

<section
  class="n-state n-state--{layout} n-state--{tone}"
  role={tone === "danger" ? "alert" : "status"}
  aria-label={eyebrow || undefined}
>
  <div class="n-state__icon" aria-hidden="true">
    <StateIcon size="1em" weight="regular" />
  </div>

  <div class="n-state__content">
    {#if eyebrow}
      <p class="n-state__eyebrow">{eyebrow}</p>
    {/if}
    <h2 class="n-state__title">{title}</h2>
    {#if body}
      <p class="n-state__body">{body}</p>
    {/if}
    {#if detail}
      <p class="n-state__detail">{detail}</p>
    {/if}
    {#if actions.length > 0}
      <div class="n-state__actions">
        {#each actions as action (action.label)}
          {@const ActionIcon = action.icon ? iconFor(action.icon) : null}
          <button
            type="button"
            class="n-state__action n-state__action--{action.kind ?? 'secondary'}"
            disabled={action.disabled}
            onclick={action.onClick}
          >
            {#if ActionIcon}
              <ActionIcon size="1em" weight="bold" />
            {/if}
            <span>{action.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .n-state {
    --state-accent: var(--component-nocturne-state-neutral-accent);
    --state-glow: var(--component-nocturne-state-neutral-glow);
    --state-panel-bg: var(--component-nocturne-state-neutral-panel-bg);
    --state-compact-bg: var(--component-nocturne-state-neutral-compact-bg);
    --state-rail-bg: var(--component-nocturne-state-neutral-rail-bg);
    --state-icon-bg: var(--component-nocturne-state-neutral-icon-bg);
    --state-icon-border: var(--component-nocturne-state-neutral-icon-border);
    --state-eyebrow-fg: var(--component-nocturne-state-neutral-eyebrow-fg);
    --state-action-hover-border: var(--component-nocturne-state-neutral-action-hover-border);
    --state-action-hover-bg: var(--component-nocturne-state-neutral-action-hover-bg);
    --state-action-primary-fg: var(--component-nocturne-state-neutral-action-primary-fg);
    --state-action-primary-border: var(--component-nocturne-state-neutral-action-primary-border);
    --state-action-primary-bg: var(--component-nocturne-state-neutral-action-primary-bg);

    display: flex;
    gap: var(--component-nocturne-state-gap);
    min-width: 0;
    color: var(--component-nocturne-state-fg);
    text-align: left;
    position: relative;
    overflow: hidden;
  }

  .n-state--panel,
  .n-state--center {
    align-items: center;
    padding: var(--component-nocturne-state-panel-padding);
    border: var(--component-nocturne-state-panel-border);
    border-radius: var(--component-nocturne-state-panel-radius);
    background: var(--state-panel-bg);
    box-shadow: var(--component-nocturne-state-panel-shadow);
  }

  .n-state--compact {
    align-items: center;
    padding: var(--component-nocturne-state-compact-padding);
    border: var(--component-nocturne-state-compact-border);
    border-radius: var(--component-nocturne-state-compact-radius);
    background: var(--state-compact-bg);
  }

  .n-state::before {
    content: "";
    position: absolute;
    inset: var(--component-nocturne-state-rail-inset);
    width: var(--component-nocturne-state-rail-width);
    border-radius: var(--component-nocturne-state-rail-radius);
    background: var(--state-rail-bg);
    opacity: var(--component-nocturne-state-rail-opacity);
  }

  .n-state--center {
    width: var(--component-nocturne-state-center-width);
    margin: auto;
    align-items: flex-start;
  }

  .n-state--info {
    --state-accent: var(--component-nocturne-state-info-accent);
    --state-glow: var(--component-nocturne-state-info-glow);
    --state-panel-bg: var(--component-nocturne-state-info-panel-bg);
    --state-compact-bg: var(--component-nocturne-state-info-compact-bg);
    --state-rail-bg: var(--component-nocturne-state-info-rail-bg);
    --state-icon-bg: var(--component-nocturne-state-info-icon-bg);
    --state-icon-border: var(--component-nocturne-state-info-icon-border);
    --state-eyebrow-fg: var(--component-nocturne-state-info-eyebrow-fg);
    --state-action-hover-border: var(--component-nocturne-state-info-action-hover-border);
    --state-action-hover-bg: var(--component-nocturne-state-info-action-hover-bg);
    --state-action-primary-fg: var(--component-nocturne-state-info-action-primary-fg);
    --state-action-primary-border: var(--component-nocturne-state-info-action-primary-border);
    --state-action-primary-bg: var(--component-nocturne-state-info-action-primary-bg);
  }

  .n-state--warning {
    --state-accent: var(--component-nocturne-state-warning-accent);
    --state-glow: var(--component-nocturne-state-warning-glow);
    --state-panel-bg: var(--component-nocturne-state-warning-panel-bg);
    --state-compact-bg: var(--component-nocturne-state-warning-compact-bg);
    --state-rail-bg: var(--component-nocturne-state-warning-rail-bg);
    --state-icon-bg: var(--component-nocturne-state-warning-icon-bg);
    --state-icon-border: var(--component-nocturne-state-warning-icon-border);
    --state-eyebrow-fg: var(--component-nocturne-state-warning-eyebrow-fg);
    --state-action-hover-border: var(--component-nocturne-state-warning-action-hover-border);
    --state-action-hover-bg: var(--component-nocturne-state-warning-action-hover-bg);
    --state-action-primary-fg: var(--component-nocturne-state-warning-action-primary-fg);
    --state-action-primary-border: var(--component-nocturne-state-warning-action-primary-border);
    --state-action-primary-bg: var(--component-nocturne-state-warning-action-primary-bg);
  }

  .n-state--danger {
    --state-accent: var(--component-nocturne-state-danger-accent);
    --state-glow: var(--component-nocturne-state-danger-glow);
    --state-panel-bg: var(--component-nocturne-state-danger-panel-bg);
    --state-compact-bg: var(--component-nocturne-state-danger-compact-bg);
    --state-rail-bg: var(--component-nocturne-state-danger-rail-bg);
    --state-icon-bg: var(--component-nocturne-state-danger-icon-bg);
    --state-icon-border: var(--component-nocturne-state-danger-icon-border);
    --state-eyebrow-fg: var(--component-nocturne-state-danger-eyebrow-fg);
    --state-action-hover-border: var(--component-nocturne-state-danger-action-hover-border);
    --state-action-hover-bg: var(--component-nocturne-state-danger-action-hover-bg);
    --state-action-primary-fg: var(--component-nocturne-state-danger-action-primary-fg);
    --state-action-primary-border: var(--component-nocturne-state-danger-action-primary-border);
    --state-action-primary-bg: var(--component-nocturne-state-danger-action-primary-bg);
  }

  .n-state--success {
    --state-accent: var(--component-nocturne-state-success-accent);
    --state-glow: var(--component-nocturne-state-success-glow);
    --state-panel-bg: var(--component-nocturne-state-success-panel-bg);
    --state-compact-bg: var(--component-nocturne-state-success-compact-bg);
    --state-rail-bg: var(--component-nocturne-state-success-rail-bg);
    --state-icon-bg: var(--component-nocturne-state-success-icon-bg);
    --state-icon-border: var(--component-nocturne-state-success-icon-border);
    --state-eyebrow-fg: var(--component-nocturne-state-success-eyebrow-fg);
    --state-action-hover-border: var(--component-nocturne-state-success-action-hover-border);
    --state-action-hover-bg: var(--component-nocturne-state-success-action-hover-bg);
    --state-action-primary-fg: var(--component-nocturne-state-success-action-primary-fg);
    --state-action-primary-border: var(--component-nocturne-state-success-action-primary-border);
    --state-action-primary-bg: var(--component-nocturne-state-success-action-primary-bg);
  }

  .n-state__icon {
    flex: 0 0 auto;
    width: var(--component-nocturne-state-icon-size);
    height: var(--component-nocturne-state-icon-size);
    border-radius: var(--component-nocturne-state-icon-radius);
    display: grid;
    place-items: center;
    color: var(--state-accent);
    background: var(--state-icon-bg);
    border: var(--state-icon-border);
    box-shadow: var(--component-nocturne-state-icon-shadow);
    font-size: var(--component-nocturne-state-icon-font-size);
    align-self: flex-start;
    margin-top: calc(var(--sp-1) / 2);
  }

  .n-state--compact .n-state__icon {
    width: var(--component-nocturne-state-compact-icon-size);
    height: var(--component-nocturne-state-compact-icon-size);
    border-radius: var(--component-nocturne-state-compact-icon-radius);
    font-size: var(--component-nocturne-state-compact-icon-font-size);
  }

  .n-state__content {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--component-nocturne-state-content-gap);
  }

  .n-state__eyebrow {
    display: none;
    font-size: var(--component-nocturne-state-eyebrow-font-size);
    line-height: var(--component-nocturne-state-eyebrow-line-height);
    letter-spacing: var(--component-nocturne-state-eyebrow-letter-spacing);
  }

  .n-state__title {
    margin: 0;
    font-size: var(--component-nocturne-state-title-font-size);
    line-height: var(--component-nocturne-state-title-line-height);
    font-weight: var(--component-nocturne-state-title-font-weight);
    color: var(--component-nocturne-state-title-fg);
    letter-spacing: var(--component-nocturne-state-title-letter-spacing);
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }

  .n-state--compact .n-state__title {
    font-size: var(--component-nocturne-state-compact-title-font-size);
  }

  .n-state__body,
  .n-state__detail {
    margin: 0;
    max-width: var(--component-nocturne-state-body-max-width);
    color: var(--component-nocturne-state-body-fg);
    font-size: var(--component-nocturne-state-body-font-size);
    line-height: var(--component-nocturne-state-body-line-height);
  }

  .n-state__detail {
    max-width: var(--component-nocturne-state-detail-max-width);
    color: var(--component-nocturne-state-detail-fg);
    font-family: var(--component-nocturne-state-font-ui);
    font-size: var(--component-nocturne-state-detail-font-size);
    letter-spacing: var(--component-nocturne-state-detail-letter-spacing);
    word-break: break-word;
    white-space: pre-wrap;
  }

  .n-state__actions {
    display: flex;
    gap: var(--component-nocturne-state-actions-gap);
    flex-wrap: wrap;
    margin-top: var(--component-nocturne-state-actions-margin-top);
  }

  .n-state--compact .n-state__content {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--component-nocturne-state-actions-gap);
  }

  .n-state--compact :is(.n-state__title, .n-state__body, .n-state__detail) {
    grid-column: 1;
  }

  .n-state--compact .n-state__actions {
    grid-column: 2;
    grid-row: 1 / span 3;
    align-self: center;
    margin-top: 0;
  }

  .n-state__action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--component-nocturne-state-action-gap);
    min-height: var(--component-nocturne-state-action-min-height);
    padding: var(--component-nocturne-state-action-padding);
    border-radius: var(--component-nocturne-state-action-radius);
    border: var(--component-nocturne-state-action-border);
    background: var(--component-nocturne-state-action-bg);
    color: var(--component-nocturne-state-action-fg);
    font-family: var(--font-sans);
    font-size: var(--component-nocturne-state-action-font-size);
    font-weight: var(--component-nocturne-state-action-font-weight);
    letter-spacing: var(--component-nocturne-state-action-letter-spacing);
    font-synthesis: none;
    text-rendering: optimizeLegibility;
    cursor: pointer;
    transition: var(--component-nocturne-state-action-transition);
  }

  .n-state__action:hover {
    transform: var(--component-nocturne-state-action-hover-transform);
    color: var(--component-nocturne-state-action-hover-fg);
    border-color: var(--state-action-hover-border);
    background: var(--state-action-hover-bg);
  }

  .n-state__action:focus-visible {
    outline: none;
    box-shadow: var(--component-nocturne-state-action-focus-shadow);
  }

  .n-state__action:active {
    transform: var(--component-nocturne-state-action-active-transform);
  }

  .n-state__action:disabled {
    opacity: var(--component-nocturne-state-action-disabled-opacity);
    cursor: default;
    transform: none;
  }

  .n-state__action--primary {
    color: var(--state-action-primary-fg);
    border-color: var(--state-action-primary-border);
    background: var(--state-action-primary-bg);
  }

  .n-state__action--danger {
    color: var(--component-nocturne-state-action-danger-fg);
    border-color: var(--component-nocturne-state-action-danger-border);
    background: var(--component-nocturne-state-action-danger-bg);
  }

  @media (max-width: 560px) {
    .n-state--compact .n-state__content {
      grid-template-columns: minmax(0, 1fr);
    }

    .n-state--compact .n-state__actions {
      grid-column: 1;
      grid-row: auto;
      margin-top: var(--component-nocturne-state-actions-margin-top);
    }
  }
</style>
